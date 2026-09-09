/**
 * onboarding-state.ts (#5908)
 *
 * Lógica PURA de decisão do onboarding por Brevo transacional — quem recebe
 * o quê e quando. Sem I/O: tudo recebe valores e devolve valores, pra testes
 * unitários cobrirem as regras sem mockar rede.
 *
 * Regras (decisão do editor 22/08/2026, #5908):
 *   - E-mail 1 transacional imediato na detecção (só se status Beehiiv for
 *     `active` — `pending` aguarda confirmação do double opt-in; nunca
 *     e-mail para quem ainda não confirmou assinatura).
 *   - E-mail 2 transacional em D+3 (idade desde `created_at`).
 *   - E-mail 3 em D+10, CONDICIONAL a zero aberturas E zero cliques (mesma
 *     condição da automação descartada da #5808: "Days Without Opens And
 *     Clicks >= 10"). É marketing → campanha Brevo, NUNCA transacional, e o
 *     script cria SEMPRE rascunho (envio é ação humana/futura explícita).
 *
 * GUARD DURO DE CONTEÚDO: os corpos definitivos vivem na automação Beehiiv
 * em Draft (#5808) e precisam ser exportados pra
 * `data/snippets/onboarding-{1,2,3}.md`. Enquanto o snippet carregar o
 * marcador `ONBOARDING-CORPO-PENDENTE`, a ação correspondente NÃO entra no
 * plano de execução (`buildRunPlan` vira skip com motivo `corpo_pendente`) —
 * copy não-definitiva jamais sai por engano, mesmo com `--send`.
 */

import type { OnboardingEntry } from "./onboarding-store.ts";

// ---------------------------------------------------------------------------
// Snippets (data/snippets/onboarding-{1,2,3}.md)
// ---------------------------------------------------------------------------

export const PENDING_BODY_MARKER = "ONBOARDING-CORPO-PENDENTE";

export interface OnboardingSnippet {
  /** 1 | 2 | 3 — qual e-mail da sequência. */
  numero: number;
  assunto: string | null;
  previewText: string | null;
  /** Corpo após o cabeçalho — esperado HTML definitivo exportado da automação. */
  body: string;
  hasPendingMarker: boolean;
}

/**
 * Parse do snippet: cabeçalho é comentário HTML com metadados
 * (`assunto:` / `preview_text:`), corpo vem depois do comentário.
 * Tolerante a arquivo ausente (caller decide o que fazer com `null`).
 */
export function parseOnboardingSnippet(raw: string | null, numero: number): OnboardingSnippet | null {
  if (raw == null) return null;
  const hasPendingMarker = raw.includes(PENDING_BODY_MARKER);
  const assuntoMatch = raw.match(/assunto:\s*"([^"]*)"/);
  const previewMatch = raw.match(/preview_text:\s*"([^"]*)"/);
  // Corpo = tudo depois do FECHAMENTO do primeiro comentário HTML do arquivo.
  const endComment = raw.indexOf("-->");
  const body = endComment >= 0 ? raw.slice(endComment + 3).trim() : raw.trim();
  return {
    numero,
    assunto: assuntoMatch ? assuntoMatch[1] : null,
    previewText: previewMatch ? previewMatch[1] : null,
    body,
    hasPendingMarker,
  };
}

/**
 * Guard duro: lança se o snippet não pode sair (marcador pendente, assunto
 * ausente ou corpo vazio). Chamado por `buildRunPlan` — um throw aqui NUNCA
 * derruba o run inteiro, vira skip `corpo_pendente`/`snippet_invalido`.
 */
export function assertSnippetSendable(snippet: OnboardingSnippet): void {
  if (snippet.hasPendingMarker) {
    throw new Error(
      `corpo pendente: data/snippets/onboarding-${snippet.numero}.md contém ${PENDING_BODY_MARKER} — ` +
      `exportar o conteúdo definitivo da automação Beehiiv 'Onboarding — Boas-vindas' ` +
      `(aut_48bcae89-e812-4711-a6ea-1f0729e7e6d8, #5808) antes de enviar.`,
    );
  }
  if (!snippet.assunto) {
    throw new Error(`snippet onboarding-${snippet.numero}.md sem 'assunto:' no cabeçalho`);
  }
  if (!snippet.body) {
    throw new Error(`snippet onboarding-${snippet.numero}.md sem corpo`);
  }
}

// ---------------------------------------------------------------------------
// Detecção de novos assinantes
// ---------------------------------------------------------------------------

/** Subcampos da subscription Beehiiv que a detecção consome. */
export interface DetectedSubscription {
  id: string;
  email: string;
  status: string;
  /** Epoch segundos (campo `created`). */
  created: number | null;
}

/**
 * Separa assinantes novos dos já conhecidos (dedupe por id contra o store).
 * Entrada duplicada dentro do MESMO lote também colapsa (id repetido entre
 * páginas por paginação concorrente não pode gerar 2 entradas).
 */
export function classifyNewSubscribers(
  subs: DetectedSubscription[],
  knownIds: Set<string>,
): { novos: DetectedSubscription[]; conhecidos: number } {
  const novos: DetectedSubscription[] = [];
  let conhecidos = 0;
  const seenInBatch = new Set<string>();
  for (const s of subs) {
    if (knownIds.has(s.id)) {
      conhecidos++;
      continue;
    }
    if (seenInBatch.has(s.id)) {
      conhecidos++;
      continue;
    }
    seenInBatch.add(s.id);
    novos.push(s);
  }
  return { novos, conhecidos };
}

// ---------------------------------------------------------------------------
// Vencimentos D+3 / D+10
// ---------------------------------------------------------------------------

const DAY_S = 86_400;

/** `true` quando o e-mail 2 venceu (idade ≥ D+3 e ainda não enviado). Não exige email1 — falha de um toque não trava a escada (premissa registrada na #5908). */
export function dueForEmail2(entry: OnboardingEntry, nowSec: number, days = 3): boolean {
  if (entry.email2_sent_at != null) return false;
  if (entry.created_at == null) return false;
  return nowSec >= entry.created_at + days * DAY_S;
}

/** Idade em dias completos desde `created_at` (null → null). */
export function ageDays(entry: OnboardingEntry, nowSec: number): number | null {
  if (entry.created_at == null) return null;
  return Math.floor((nowSec - entry.created_at) / DAY_S);
}

/** Stats por assinante que a decisão D+10 consome (expand[]=stats). */
export interface OpenStats {
  total_unique_opened?: number | null;
  total_clicked?: number | null;
}

export type Email3Decision =
  | { eligible: true }
  | { eligible: false; reason: "ja_decidido" | "sem_created_at" | "age<min" | "sem_abertura" | "stats_ausentes" };

/**
 * Decisão do e-mail 3 — condição INVERTIDA em #7599 (08/09/2026, decisão do
 * editor registrada na issue): o corpo trocou pela copy de apoio (ex-Kit),
 * e o pedido de apoio só faz sentido pra quem JÁ leu ao menos uma edição —
 * o oposto da condição anterior (reengajamento: zero aberturas+cliques).
 *
 * Elegível só se pendente, idade ≥ D+10, stats presentes e PELO MENOS UMA
 * abertura registrada (`total_unique_opened > 0`). Cliques deixaram de
 * fazer parte do critério — abertura é o sinal mínimo de "leu ao menos
 * uma edição" que a decisão do editor pede; exigir clique também seria mais
 * restritivo que o critério registrado. Stats ausentes → não elegível
 * (fail-safe: sem dado não há como checar a condição; após a janela de
 * tolerância o caller marca `skipped_sem_dados`). Zero aberturas em D+10 →
 * `sem_abertura`, que o caller trata como TERMINAL (`skipped_no_open`,
 * nunca reavaliado) — decisão explícita do editor: "quem tem zero
 * aberturas em D+10 simplesmente não recebe e-mail 3 nenhum por ora".
 */
export function email3Eligibility(
  entry: OnboardingEntry,
  stats: OpenStats | null | undefined,
  nowSec: number,
  days = 10,
): Email3Decision {
  if (entry.email3_state !== "pending") return { eligible: false, reason: "ja_decidido" };
  if (entry.created_at == null) return { eligible: false, reason: "sem_created_at" };
  const idade = nowSec - entry.created_at;
  if (idade < days * DAY_S) return { eligible: false, reason: "age<min" };
  if (stats == null || stats.total_unique_opened == null) {
    return { eligible: false, reason: "stats_ausentes" };
  }
  if (stats.total_unique_opened <= 0) {
    return { eligible: false, reason: "sem_abertura" };
  }
  return { eligible: true };
}

/** Só envia e-mail pra quem confirmou assinatura na Beehiiv. */
export function shouldAttemptSend(beehiivStatus: string): boolean {
  return beehiivStatus === "active";
}

// ---------------------------------------------------------------------------
// Plano de execução (puro — o executor do script só performa ações)
// ---------------------------------------------------------------------------

export type RunAction =
  | { kind: "email1"; entry: OnboardingEntry }
  | { kind: "email2"; entry: OnboardingEntry }
  /**
   * UM campanha-rascunho Brevo pro cohort inteiro do dia (contatos são
   * criados/adicionados à lista D+10 pelo executor antes da campanha).
   */
  | { kind: "email3_campaign"; entries: OnboardingEntry[] };

export interface RunSkip {
  entry: OnboardingEntry;
  /** Onde parou: email1 | email2 | email3. */
  etapa: "email1" | "email2" | "email3";
  motivo:
    | "status_nao_active"
    | "corpo_pendente"
    | "snippet_invalido"
    | "snippet_ausente"
    | "age<min"
    | "sem_abertura"
    | "stats_ausentes"
    | "sem_created_at";
  detalhe?: string;
}

export interface RunPlanResult {
  actions: RunAction[];
  skips: RunSkip[];
  /** Novos assinantes adicionados ao store nesta rodada (já como entries). */
  detectedEntries: OnboardingEntry[];
}

interface PlanSnippets {
  1: OnboardingSnippet | null;
  2: OnboardingSnippet | null;
  3: OnboardingSnippet | null;
}

function skipFor(
  entry: OnboardingEntry,
  etapa: RunSkip["etapa"],
  snippets: PlanSnippets,
  numero: 1 | 2 | 3,
): RunSkip | null {
  const snip = snippets[numero];
  if (snip == null) return { entry, etapa, motivo: "snippet_ausente", detalhe: `data/snippets/onboarding-${numero}.md não existe` };
  try {
    assertSnippetSendable(snip);
  } catch (e) {
    return {
      entry,
      etapa,
      motivo: snip.hasPendingMarker ? "corpo_pendente" : "snippet_invalido",
      detalhe: (e as Error).message,
    };
  }
  return null;
}

/**
 * Monta o plano da rodada a partir do estado JÁ ATUALIZADO das entries
 * (o executor refresha status/stats da Beehiiv antes de chamar isto).
 * Pureza garantida: nenhuma decisão de envio depende de I/O aqui —
 * exatamente o que os testes de segurança cobrem (plano com `--send`
 * implícito NUNCA contém ação cujo snippet esteja pendente).
 */
export function buildRunPlan(opts: {
  entries: OnboardingEntry[];
  /** Stats frescas por subscription_id (refreshadas da Beehiiv pelo executor antes do plano). */
  statsById: Record<string, OpenStats | null>;
  nowSec: number;
  email2Days: number;
  email3Days: number;
  email3GraceDays: number;
  snippets: PlanSnippets;
}): RunPlanResult {
  const { entries, statsById, nowSec, email2Days, email3Days, email3GraceDays, snippets } = opts;
  const actions: RunAction[] = [];
  const skips: RunSkip[] = [];
  const detectedEntries: OnboardingEntry[] = [];

  // Cohort D+10 elegível acumula pra UMA campanha única no fim da rodada.
  const cohort3: OnboardingEntry[] = [];

  for (const entry of entries) {
    const isNovo = entry.email1_sent_at == null && entry.email2_sent_at == null && entry.email3_state === "pending";

    // --- E-mail 1: imediato na detecção ---
    if (isNovo && entry.status_detectado === "active") {
      // status ATUAL já foi refreshado pelo executor antes do plano; o campo
      // `status_detectado` carrega o valor fresco neste fluxo.
      const bloqueio = skipFor(entry, "email1", snippets, 1);
      if (bloqueio) skips.push(bloqueio);
      else actions.push({ kind: "email1", entry });
    } else if (isNovo && entry.status_detectado !== "active") {
      skips.push({ entry, etapa: "email1", motivo: "status_nao_active", detalhe: `status=${entry.status_detectado}` });
    }

    // --- E-mail 2: D+3 ---
    if (dueForEmail2(entry, nowSec, email2Days) && !isNovo) {
      if (!shouldAttemptSend(entry.status_detectado)) {
        skips.push({ entry, etapa: "email2", motivo: "status_nao_active", detalhe: `status=${entry.status_detectado}` });
      } else {
        const bloqueio = skipFor(entry, "email2", snippets, 2);
        if (bloqueio) skips.push(bloqueio);
        else actions.push({ kind: "email2", entry });
      }
    }

    // --- E-mail 3: D+10 condicional ---
    if (entry.email3_state === "pending" && entry.created_at != null && nowSec >= entry.created_at + email3Days * DAY_S) {
      const dec = email3Eligibility(entry, statsById[entry.subscription_id] ?? null, nowSec, email3Days);
      if (dec.eligible) {
        cohort3.push(entry);
      } else if (dec.reason === "sem_abertura") {
        // #7599: condição invertida — zero aberturas em D+10 é TERMINAL
        // (nunca reavaliado), não mais o gatilho de envio.
        entry.email3_state = "skipped_no_open";
        entry.email3_decided_at = new Date(nowSec * 1000).toISOString();
      } else if (
        dec.reason === "stats_ausentes" &&
        nowSec >= entry.created_at + (email3Days + email3GraceDays) * DAY_S
      ) {
        entry.email3_state = "skipped_sem_dados";
        entry.email3_decided_at = new Date(nowSec * 1000).toISOString();
      }
      // "age<min" não deveria ocorrer (guard acima), "ja_decidido" idem;
      // "stats_ausentes" dentro da tolerância fica pendente pra próxima rodada.
    }

    if (isNovo) detectedEntries.push(entry);
  }

  if (cohort3.length > 0) {
    const bloqueio = skipFor(cohort3[0], "email3", snippets, 3);
    if (bloqueio) {
      // Um skip pro cohort inteiro (mesmo snippet) + registro individual leve.
      skips.push(bloqueio);
    } else {
      actions.push({ kind: "email3_campaign", entries: cohort3 });
    }
  }

  return { actions, skips, detectedEntries };
}

// ---------------------------------------------------------------------------
// #7599: troca de backend de detecção (Beehiiv → Kit) — cursor precisa
// re-bootstrapar, nunca reusar valor calculado sob a fonte antiga
// ---------------------------------------------------------------------------

/**
 * `true` quando o cursor persistido NÃO tem procedência CONHECIDA e SEGURA
 * contra o backend atual — Beehiiv usa `created` (epoch segundos da API
 * pública v2), Kit usa `created_at` (ISO, convertido) — e reusar o cursor
 * antigo sob a fonte nova é exatamente a classe de erro silencioso que
 * causou o #6043 (585 e-mails retroativos por um filtro que não fazia o
 * que parecia fazer). A #7599 é justamente essa migração acontecendo de
 * novo (Beehiiv → Kit em 04/09/2026, #7388) — inclusive com o mesmo risco
 * concreto de assinantes MIGRADOS em bloco carregarem `created_at` do
 * MOMENTO DA IMPORTAÇÃO em vez da data real de cadastro (mesma armadilha
 * documentada em CLAUDE.md pra `displayed_date`/`publish_date` da Beehiiv).
 *
 * `storedBackend == null` — store criado ANTES deste campo existir — é
 * exatamente o estado do store de PRODUÇÃO real na hora em que este guard
 * foi escrito (rodava há semanas sob Beehiiv sem nunca ter gravado
 * `last_detection_backend`). Tratar isso como "não é uma troca" (ausência
 * de sinal ≠ ausência de risco) deixaria o 1º `--send` pós-merge deste PR
 * comparar o cursor Beehiiv-era direto contra `created_at` do Kit sem
 * NENHUM re-bootstrap — reabrindo o #6043 pela porta dos fundos. Por isso
 * `null`/`undefined` conta como DESCONHECIDO, não como "mesmo backend": só
 * `storedBackend === currentBackend` (ambos conhecidos e iguais) evita o
 * reset. O custo de um falso positivo (bootstrap desnecessário quando o
 * backend nunca mudou de fato, só o campo nunca foi gravado) é 1 rodada
 * sem detectar ninguém — o de um falso negativo é reenvio em massa.
 *
 * @pure testável sem I/O
 */
export function shouldResetCursorForBackendSwitch(
  storedBackend: "beehiiv" | "kit" | null | undefined,
  currentBackend: "beehiiv" | "kit",
): boolean {
  return storedBackend !== currentBackend;
}

/**
 * Sentinela de "não deu pra contar a coorte órfã" — o fetch da janela entre
 * o cursor antigo e o bootstrap falhou (rede, auth, backend fora do ar).
 * NUNCA confundir com `0`, que é a afirmação positiva "contei, e não havia
 * ninguém na janela": a decisão do editor sobre reinscrever depende de saber
 * qual dos dois é (#7665).
 */
export const BOOTSTRAP_GAP_COUNT_UNKNOWN = -1;

/**
 * Monta a nota de bootstrap de troca de backend de detecção (#7599) com o
 * relato da coorte órfã (#7665 residual).
 *
 * **O que a nota NÃO promete, de propósito.** A decisão do editor no #7665
 * foi *reportar*, nunca reinscrever: quem caiu na janela entre o cursor
 * antigo e o bootstrap não recebe boas-vindas automaticamente — reinscrever
 * é ação externa, tomada por quem lê o aviso. Por isso o texto diz
 * "reinscrever só sob decisão do editor" e o teste de regressão trava a
 * AUSÊNCIA de qualquer promessa de ação automática, não só a presença do
 * número.
 *
 * @pure testável sem I/O
 */
export function buildBackendSwitchNote(
  backendAnterior: "beehiiv" | "kit" | null | undefined,
  backend: "beehiiv" | "kit",
  gapCount: number,
  /** `false` quando o re-bootstrap veio de campo AUSENTE (backend nunca
   *  registrado, #7599), não de uma troca real. Aí não existe janela a
   *  reportar — e afirmar "0 cadastros" seria pior que omitir, porque diz
   *  ao editor que se mediu e não havia ninguém, quando não se mediu nada. */
  houveTrocaReal = true,
): string {
  const gapReport = !houveTrocaReal
    ? "; sem janela de coorte órfã (backend anterior desconhecido — nada a comparar)"
    : gapCount >= 0
      ? `; janela entre cursor antigo e bootstrap: ${gapCount} cadastros ` +
        `(coorte órfã — reinscrever só sob decisão do editor, #7665)`
      : "; não foi possível contar coorte órfã";
  return (
    `bootstrap (troca de backend de detecção ${backendAnterior} → ${backend}): cursor remarcado em now; ` +
    `nenhuma entrada retroativa adicionada (#7599)${gapReport}`
  );
}

// ---------------------------------------------------------------------------
// #7599: alarme de detecção zerada — item 4 da issue
// ---------------------------------------------------------------------------

/** Rodadas `--send` consecutivas com `detected_new === 0` que disparam o alarme. */
export const ZERO_DETECTION_ALARM_THRESHOLD_RUNS = 3;

/**
 * Atualiza o contador de rodadas consecutivas sem detecção — zera a
 * qualquer `detectedNew > 0`, incrementa caso contrário.
 *
 * @pure testável sem I/O
 */
export function updateZeroDetectionStreak(previousStreak: number, detectedNew: number): number {
  return detectedNew > 0 ? 0 : previousStreak + 1;
}

/**
 * Mensagem de alarme quando o streak cruza o limiar — `null` abaixo dele.
 * A rodada de origem do #7599 é exatamente o cenário que este alarme
 * existe pra pegar: a detecção lendo da fonte errada saía "verde"
 * (`detected_new: 0`, exit 0) indefinidamente, sem nenhum sinal.
 *
 * @pure testável sem I/O
 */
export function zeroDetectionAlarm(
  streak: number,
  threshold: number = ZERO_DETECTION_ALARM_THRESHOLD_RUNS,
): string | null {
  if (streak < threshold) return null;
  return (
    `ALARME: ${streak} rodadas --send consecutivas com 0 novos assinantes detectados ` +
    `(limiar ${threshold}) — possível quebra silenciosa na detecção (fonte errada, filtro no-op, etc). ` +
    `Ver #7599.`
  );
}
