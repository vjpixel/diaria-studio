/**
 * clarice-novos-state.ts (#4347 Etapa 4, agendamento #4670)
 *
 * Estado da skill `/diaria-clarice-novos` — persistido em
 * `data/clarice-subscribers/novos-state.json` (arquivo dedicado, mesmo
 * padrão de `data/studio-chat-enabled.json`). Sustenta 3 decisões da issue:
 *
 *   - D12: pular `--send-test` quando o SHA-256 do HTML (`cloudflare-preview.html`
 *     do ciclo resolvido) for IDÊNTICO ao da última rodada — o digest mensal
 *     é o mesmo em ~16 de 17 rodadas (~4×/semana vs ~1 mudança de conteúdo/mês).
 *   - Idempotência de `--key` (D11-adjacent): `novos-{AAMMDD}`, com sufixo
 *     `-2`/`-3`… se a skill rodar mais de uma vez no mesmo dia.
 *   - #4670: o `--finalize` original assumia envio SEMPRE imediato
 *     (`--send-now`) — quando o disparo do grupo `novos` é AGENDADO em vez de
 *     imediato (caso real: campanha #120, 70 contatos, agendada pro dia
 *     seguinte junto com uma onda), não havia onde encaixar "campanha criada,
 *     ainda não confirmadamente enviada". `pendingSend` guarda esse estado
 *     intermediário: `lastHtmlSha256` pode ser gravado no AGENDAMENTO (mata o
 *     `--send-test` redundante da próxima rodada, D12 continua valendo), mas
 *     `sentCount` só soma quando o disparo é CONFIRMADO — via `--finalize`
 *     manual (mesmo campaignId do pendingSend) ou via `reconcilePendingSend`
 *     (consulta o status real na Brevo, cliente injetado — nunca chamado ao
 *     vivo pelos testes deste módulo).
 *
 * Fail-soft por design (mesmo padrão de `studio-chat-enabled.ts`/`exec-mode.ts`):
 * leitura tolerante (arquivo ausente/corrompido → estado "1ª rodada", nunca
 * lança) — a skill não pode travar por causa de um estado auxiliar corrompido.
 * Retrocompat (#4670): state antigo, gravado ANTES de `pendingSend` existir,
 * lê sem quebrar — o campo simplesmente degrada pra `null` (mesmo padrão já
 * usado pelos demais campos opcionais desta função).
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "./atomic-write.ts";
import { CLARICE_BASE } from "./clarice-paths.ts";
import { groupKeyFromCampaignName } from "./clarice-wave-plan.ts";

/**
 * Envio agendado ainda NÃO confirmado como disparado (#4670). Existe entre o
 * momento em que a campanha é criada/agendada na Brevo (`--finalize-scheduled`)
 * e o momento em que o disparo é confirmado (`--finalize` com o mesmo
 * `campaignId`, ou `reconcilePendingSend` consultando a Brevo).
 */
export interface NovosPendingSend {
  campaignId: number;
  listId: number;
  /** ISO — horário agendado do disparo na Brevo. */
  scheduledAt: string;
  /** Contagem de contatos do grupo nesta rodada — só entra em `sentCount` quando confirmado. */
  contactCount: number;
}

export interface NovosState {
  lastRunAt: string;
  lastHtmlSha256: string | null;
  lastCycle: string | null;
  lastListId: number | null;
  lastCampaignId: number | null;
  sentCount: number;
  /** #4670 — `null` quando não há envio agendado pendente de confirmação. */
  pendingSend: NovosPendingSend | null;
}

/** Path do state file. `baseDir` opcional — uso interno de teste (mesmo padrão `--data-root` do resto do projeto). */
export function novosStatePath(baseDir: string = CLARICE_BASE): string {
  return resolve(baseDir, "novos-state.json");
}

/**
 * Parseia `pendingSend` de um state file bruto. Shape inesperado (campo
 * ausente — state antigo, pré-#4670 — ou corrompido/parcial) → `null`, nunca
 * lança. Mesma disciplina tolerante do resto de `readNovosState`.
 */
function parsePendingSend(raw: unknown): NovosPendingSend | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<NovosPendingSend>;
  if (
    typeof p.campaignId === "number" &&
    typeof p.listId === "number" &&
    typeof p.scheduledAt === "string" &&
    typeof p.contactCount === "number"
  ) {
    return { campaignId: p.campaignId, listId: p.listId, scheduledAt: p.scheduledAt, contactCount: p.contactCount };
  }
  return null;
}

/** Lê o state file. Tolerante: ausente/corrompido/shape inesperado → `null` (nunca lança) — "1ª rodada". */
export function readNovosState(baseDir: string = CLARICE_BASE): NovosState | null {
  const path = novosStatePath(baseDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NovosState>;
    if (typeof parsed.lastRunAt !== "string") return null;
    return {
      lastRunAt: parsed.lastRunAt,
      lastHtmlSha256: parsed.lastHtmlSha256 ?? null,
      lastCycle: parsed.lastCycle ?? null,
      lastListId: parsed.lastListId ?? null,
      lastCampaignId: parsed.lastCampaignId ?? null,
      sentCount: typeof parsed.sentCount === "number" ? parsed.sentCount : 0,
      pendingSend: parsePendingSend(parsed.pendingSend),
    };
  } catch {
    return null;
  }
}

/** Escreve o state file (escrita atômica — mesmo padrão do resto do projeto). Cria o diretório se faltar. */
export function writeNovosState(state: NovosState, baseDir: string = CLARICE_BASE): void {
  mkdirSync(baseDir, { recursive: true });
  writeFileAtomic(novosStatePath(baseDir), JSON.stringify(state, null, 2) + "\n");
}

/** SHA-256 (hex) de uma string — usado sobre o conteúdo de `cloudflare-preview.html`. */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * D12 — deve mandar `--send-test` nesta rodada? Pura/testável (recebe o SHA
 * já calculado + o state já lido, sem I/O).
 *   - state ausente (1ª rodada) → true (nunca pular o 1º test email).
 *   - `lastHtmlSha256` ausente no state (rodada anterior não gravou, ex:
 *     versão antiga) → true (fail-safe: na dúvida, manda).
 *   - SHA idêntico ao da última rodada → false (pula — D12).
 *   - SHA diferente → true (conteúdo mudou, manda de novo).
 */
export function shouldSendTest(currentHtmlSha256: string, state: NovosState | null): boolean {
  if (!state || !state.lastHtmlSha256) return true;
  return state.lastHtmlSha256 !== currentHtmlSha256;
}

/**
 * Idempotência de `--key` (#4347): `novos-{AAMMDD}` por padrão; se essa key
 * (ou qualquer sufixo `-N`) já existe em `existingKeys` (lido de
 * `group-campaigns.json` do ciclo Clarice, `--group novos`), retorna o
 * PRÓXIMO sufixo livre (`-2`, `-3`…) — nunca reusa uma key já comprometida
 * com uma campanha criada. Pura/testável.
 */
export function resolveNovosKey(existingKeys: readonly string[], aammdd: string): string {
  const base = `novos-${aammdd}`;
  if (!existingKeys.includes(base)) return base;
  let n = 2;
  while (existingKeys.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ---------------------------------------------------------------------------
// #4670 — envio agendado: separa "campanha criada/agendada" (grava SHA, não
// mexe em sentCount) de "disparo confirmado" (soma sentCount, limpa
// pendingSend). Toda função aqui é PURA — sem I/O, sem chamada de rede — o
// caller (CLI) resolve o `now`/o cliente Brevo e injeta.
// ---------------------------------------------------------------------------

export interface FinalizeScheduledOptions {
  htmlSha256: string;
  cycle: string;
  listId: number;
  campaignId: number;
  scheduledAt: string;
  /** Contagem de contatos da rodada — vira `pendingSend.contactCount` (ainda NÃO soma em `sentCount`). */
  contactCount: number;
  now?: string;
}

/**
 * `--finalize-scheduled` (#4670): a campanha foi criada/agendada na Brevo,
 * mas o disparo ainda não foi confirmado. Grava `lastHtmlSha256`/`lastCycle`
 * (mata o `--send-test` redundante da próxima rodada, D12 continua valendo)
 * e registra `pendingSend` — mas **não** soma `sentCount` nem toca
 * `lastListId`/`lastCampaignId` (esses só avançam quando o disparo é
 * confirmado, via `buildFinalizeState`/`reconcilePendingSend`).
 */
export function buildFinalizeScheduledState(prev: NovosState | null, opts: FinalizeScheduledOptions): NovosState {
  return {
    lastRunAt: opts.now ?? new Date().toISOString(),
    lastHtmlSha256: opts.htmlSha256,
    lastCycle: opts.cycle,
    lastListId: prev?.lastListId ?? null,
    lastCampaignId: prev?.lastCampaignId ?? null,
    sentCount: prev?.sentCount ?? 0,
    pendingSend: {
      campaignId: opts.campaignId,
      listId: opts.listId,
      scheduledAt: opts.scheduledAt,
      contactCount: opts.contactCount,
    },
  };
}

export interface FinalizeOptions {
  htmlSha256: string;
  cycle: string;
  listId: number | null;
  campaignId: number | null;
  /** Contagem de contatos DESTA rodada — soma ao `sentCount` acumulado (não substitui). */
  sentCountDelta: number;
  now?: string;
}

/**
 * `--finalize` (disparo CONFIRMADO — o `--send-now` original, ou a
 * confirmação manual de uma campanha antes agendada): soma `sentCountDelta`
 * ao `sentCount` acumulado, como sempre fez. #4670: além disso, limpa
 * `pendingSend` — mas SÓ quando o `campaignId` desta finalização é o MESMO
 * do `pendingSend` pendente (nunca limpa às cegas o rastro de uma campanha
 * agendada DIFERENTE só porque outra rodada finalizou no meio do caminho —
 * cenário real: rodada N agenda #120 e ainda não foi confirmada quando a
 * rodada N+1, imediata, chama `--finalize` pra sua própria campanha).
 */
export function buildFinalizeState(prev: NovosState | null, opts: FinalizeOptions): NovosState {
  const resolvedCampaignId = opts.campaignId ?? prev?.lastCampaignId ?? null;
  const resolvedListId = opts.listId ?? prev?.lastListId ?? null;
  const matchesPending =
    prev?.pendingSend != null && resolvedCampaignId != null && prev.pendingSend.campaignId === resolvedCampaignId;
  return {
    lastRunAt: opts.now ?? new Date().toISOString(),
    lastHtmlSha256: opts.htmlSha256,
    lastCycle: opts.cycle,
    lastListId: resolvedListId,
    lastCampaignId: resolvedCampaignId,
    sentCount: (prev?.sentCount ?? 0) + opts.sentCountDelta,
    pendingSend: matchesPending ? null : (prev?.pendingSend ?? null),
  };
}

// ---------------------------------------------------------------------------
// #4788 — reconciliação de `sentCount` (acumulador local, all-time) contra a
// soma real das campanhas `novos-*` na Brevo. Achado: `sentCount` gravava 350
// enquanto a soma das campanhas realmente enviadas era 440 — 90 envios ficam
// invisíveis pra sempre quando `--finalize-scheduled` nunca vira `--finalize`
// (disparo aconteceu, confirmação nunca rodou; ver docstring de
// `buildFinalizeState`/`buildFinalizeScheduledState` acima). Escopo desta
// unidade é SÓ a reconciliação (opção 1 da issue) — a ambiguidade de
// semântica all-time-vs-por-ciclo (opção 2/3) fica pra depois, deliberadamente
// fora de escopo.
//
// Comparação também é all-time por simetria: `sentCount` nunca reseta por
// ciclo, então o lado "real" soma TODAS as campanhas cujo nome começa com
// `novos-` (mesmo prefixo de `resolveNovosKey` — `novos-{AAMMDD}`,
// `novos-{AAMMDD}-2`…), não só as do ciclo atual. Isso evita reabrir a
// ambiguidade que a issue explicitamente deixou pra decidir depois.
//
// Warn-only por decisão do editor (#4788, comentário 260808b) — mesmo padrão
// de `clarice-import-waves.ts` (#4577/#4602) na FORMA (soma real vs. esperado
// via API), mas diferente no RESULTADO: import-waves ABORTA a invocação numa
// divergência (contagem confirmada é pré-condição pra declarar sucesso);
// aqui a divergência só é reportada — `sentCount` já é um contador auxiliar
// que nenhum consumidor usa pra decidir volume/gate de envio hoje (ver
// "Prioridade" na issue), então travar `--finalize` por causa dele seria
// bloquear o disparo real por um problema no contador que só o descreve.
// ---------------------------------------------------------------------------

/** Uma campanha Brevo já enviada, reduzida ao que a reconciliação precisa. */
export interface NovosCampaignSentCount {
  /**
   * Nome REAL da campanha na Brevo, ex: `"Clarice 2607 grupo:novos-260731"`
   * (gerado por `campaignNameFor` em `clarice-schedule-group.ts`) — NÃO a
   * key isolada (`novos-260731`). `reconcileNovosSentCount` extrai a key via
   * `groupKeyFromCampaignName` antes de comparar contra o prefixo — nenhum
   * nome real de campanha começa literalmente com `"novos-"`.
   */
  readonly name: string;
  /** `statistics.globalStats.sent` da campanha (tentativas de envio — mesmo campo que `clarice-guardrail-alarm.ts` usa como denominador de taxa). */
  readonly sent: number;
}

export interface NovosSentCountReconciliation {
  readonly expected: number;
  readonly actual: number;
  /** Quantas campanhas com KEY `novos-*` (extraída do nome real via `groupKeyFromCampaignName`) entraram na soma — 0 volta a ser um caso de borda genuíno pós-fix (1ª rodada, ou nenhuma campanha `sent` ainda), não mais o resultado permanente do bug original (ver docstring de `reconcileNovosSentCount`). */
  readonly matchedCampaigns: number;
  readonly matches: boolean;
  /** Mensagem legível pra log — inclui o ⚠/✓ e a issue de referência na divergência. */
  readonly detail: string;
}

/**
 * Prefixo usado por TODAS as KEYS do grupo `novos` — mesmo usado por
 * `resolveNovosKey` (`novos-{AAMMDD}[-N]`). **Não** é um prefixo do nome
 * literal da campanha na Brevo — o nome real é `Clarice {yymm} grupo:{key}`
 * (`campaignNameFor` em `clarice-schedule-group.ts`), então nenhuma campanha
 * de verdade começa com `"novos-"`. Comparar contra este prefixo só faz
 * sentido depois de extrair a key do nome via `groupKeyFromCampaignName` —
 * ver `reconcileNovosSentCount` abaixo.
 */
export const NOVOS_CAMPAIGN_NAME_PREFIX = "novos-";

/**
 * Reconcilia `sentCount` (acumulador local) contra a soma real das campanhas
 * do grupo `novos` já enviadas na Brevo (#4788). PURA — recebe a lista de
 * campanhas já buscada (o caller resolve a chamada de rede, mesma separação
 * usada em `reconcilePendingSend` acima).
 *
 * A Brevo não tem um conceito de "grupo" nativo pra filtrar na própria API,
 * então o pertencimento é inferido do NOME real da campanha
 * (`Clarice {yymm} grupo:{key}`, `campaignNameFor` em
 * `clarice-schedule-group.ts`) — nunca comparado como prefixo do nome
 * inteiro. `groupKeyFromCampaignName` (`clarice-wave-plan.ts`, mesmo helper
 * que corrigiu o bug análogo do #4082 em `clarice-reapply-scheduled-html.ts`)
 * extrai a KEY (`novos-{AAMMDD}[-N]`) do nome; só então ela é comparada
 * contra `NOVOS_CAMPAIGN_NAME_PREFIX`. Campanha cujo nome não tem o sufixo
 * `grupo:...` reconhecível (`groupKeyFromCampaignName` retorna `null`) não
 * entra na soma.
 */
export function reconcileNovosSentCount(
  expected: number,
  campaigns: readonly NovosCampaignSentCount[],
): NovosSentCountReconciliation {
  const relevant = campaigns.filter((c) => {
    const key = groupKeyFromCampaignName(c.name);
    return key != null && key.startsWith(NOVOS_CAMPAIGN_NAME_PREFIX);
  });
  const actual = relevant.reduce((sum, c) => sum + c.sent, 0);
  const matches = actual === expected;
  const detail = matches
    ? `✓ sentCount (${expected}) bate com a soma das ${relevant.length} campanhas do grupo "${NOVOS_CAMPAIGN_NAME_PREFIX}*" enviadas na Brevo.`
    : `⚠ sentCount local (${expected}) DIVERGE da soma real das ${relevant.length} campanhas do grupo "${NOVOS_CAMPAIGN_NAME_PREFIX}*" enviadas na Brevo (${actual}) — diferença de ${actual - expected}. Ver #4788.`;
  return { expected, actual, matchedCampaigns: relevant.length, matches, detail };
}

// ---------------------------------------------------------------------------
// Taxonomia de status Brevo (`GET /emailCampaigns/{id}`) — REPLICADA (não
// importada) de `scripts/lib/brevo-client.ts` pra manter esta lib livre de
// dependência de rede/transporte. Os 3 conjuntos abaixo precisam ficar em
// SINCRONIA com as fontes-de-verdade citadas em cada comentário — qualquer
// status novo que a Brevo passe a reportar entra em UM desses conjuntos
// (nunca "cancelled" por omissão, ver `UNKNOWN_SEND_STATUS` mais abaixo).
// ---------------------------------------------------------------------------

/** Confirma disparo — mesma semântica de `isTerminalSendStatus` em `brevo-client.ts`. */
const CONFIRMED_SENT_STATUSES = new Set(["sent", "inProcess"]);
/**
 * Ainda não terminou, mas NÃO é cancelamento — nem confirmado, nem cancelado:
 *   - "queued"/"scheduled": agendada-não-enviada. A Brevo reporta um ou outro
 *     dependendo da versão de API/timing — documentado em
 *     `isSchedulableStatus` (`scripts/clarice-reapply-scheduled-html.ts`) e
 *     `isScheduledStatus` (`scripts/clarice-schedule-sends.ts`).
 *   - "in_review": revisão de compliance/anti-abuso da própria Brevo, status
 *     conhecido e não-terminal — documentado em `describeUncertainSendStatus`
 *     (`scripts/lib/brevo-client.ts`), reproduzido ao vivo em 260731 (#101).
 */
const STILL_PENDING_STATUSES = new Set(["queued", "scheduled", "in_review"]);
/**
 * Cancelamento CONHECIDO — a campanha não vai (ou não vai mais) disparar como
 * agendado. Deliberadamente CURTO: só entram aqui status que este repo já
 * documentou como estado-terminal-de-falha em outro lugar ("suspended" —
 * `scripts/clarice-reapply-scheduled-html.ts`, estado em que uma campanha
 * fica PRESA quando o reschedule falha no meio; "draft" — reversão manual no
 * painel). Um status que NÃO está aqui nem nos outros dois conjuntos cai em
 * `"uncertain"`, nunca em `"cancelled"` por default — ver `reconcilePendingSend`.
 */
const KNOWN_CANCELLED_STATUSES = new Set(["suspended", "draft"]);

export type ReconcileAction = "no-pending" | "finalized" | "still-pending" | "cancelled" | "uncertain";

export interface ReconcileResult {
  action: ReconcileAction;
  state: NovosState;
  /** Mensagem legível pra log/relatório — descreve o que aconteceu e por quê. */
  detail: string;
}

/**
 * Consulta o status ATUAL de uma campanha Brevo (`fetchStatus`, injetado —
 * nunca uma chamada de rede real dentro desta função). Resolve sozinho o
 * `pendingSend`, se houver:
 *
 *   - `pendingSend` ausente → `"no-pending"`, state inalterado (nada a fazer).
 *   - status confirma disparo (`sent`/`inProcess`) → `"finalized"`: soma
 *     `contactCount` ao `sentCount`, promove `lastListId`/`lastCampaignId`
 *     pro par pendente, limpa `pendingSend`.
 *   - status ainda não-terminal mas NÃO-cancelamento (`queued`, `scheduled`,
 *     `in_review`) → `"still-pending"`, state inalterado — nada a fazer
 *     ainda, só informar.
 *   - status CONHECIDO como cancelamento (`suspended`, `draft`) →
 *     `"cancelled"`: a campanha NÃO vai (ou não vai mais) disparar como
 *     agendado — limpa `pendingSend` SEM somar `sentCount` (#4670 critério de
 *     pronto: "campanha cancelada/falha no painel não é contada como
 *     enviada").
 *   - qualquer OUTRO status (desconhecido — novo valor que a Brevo introduza)
 *     → `"uncertain"`, state INALTERADO: nem soma `sentCount` nem limpa
 *     `pendingSend`. "Cancelada" é uma CONCLUSÃO, e não há base pra concluí-la
 *     a partir de um status que este módulo não reconhece — declarar
 *     cancelamento errado aqui tem o mesmo efeito do bug original do #4670
 *     (sentCount subcontado, silenciosamente). Fica pendente pra próxima
 *     reconciliação re-checar.
 *
 * `fetchStatus` pode lançar (erro de rede/API) — propositalmente não
 * capturado aqui: o caller decide o fallback (mesma disciplina de "MCP
 * indisponível = fail-fast" do projeto — nunca engolir erro de rede em
 * silêncio e declarar reconciliação bem-sucedida).
 */
export async function reconcilePendingSend(
  prev: NovosState,
  fetchStatus: (campaignId: number) => Promise<{ status: string }>,
  now: string = new Date().toISOString(),
): Promise<ReconcileResult> {
  const pending = prev.pendingSend;
  if (!pending) {
    return { action: "no-pending", state: prev, detail: "Nenhum envio agendado pendente de confirmação." };
  }

  const { status } = await fetchStatus(pending.campaignId);

  if (CONFIRMED_SENT_STATUSES.has(status)) {
    const state: NovosState = {
      ...prev,
      lastRunAt: now,
      lastListId: pending.listId,
      lastCampaignId: pending.campaignId,
      sentCount: prev.sentCount + pending.contactCount,
      pendingSend: null,
    };
    return {
      action: "finalized",
      state,
      detail: `Campanha #${pending.campaignId} confirmada (status="${status}") — sentCount +${pending.contactCount}.`,
    };
  }

  if (STILL_PENDING_STATUSES.has(status)) {
    return {
      action: "still-pending",
      state: prev,
      detail: `Campanha #${pending.campaignId} ainda agendada (status="${status}", previsto para ${pending.scheduledAt}) — nada a fazer ainda.`,
    };
  }

  if (KNOWN_CANCELLED_STATUSES.has(status)) {
    const state: NovosState = { ...prev, pendingSend: null };
    return {
      action: "cancelled",
      state,
      detail:
        `Campanha #${pending.campaignId} não confirmou disparo (status="${status}") — tratada como cancelada/falha. ` +
        "pendingSend limpo, sentCount NÃO incrementado.",
    };
  }

  return {
    action: "uncertain",
    state: prev,
    detail:
      `Campanha #${pending.campaignId} tem status desconhecido ("${status}") — nem confirmado nem cancelamento ` +
      "reconhecido. pendingSend MANTIDO (não limpo), sentCount NÃO incrementado — precisa de checagem humana. " +
      "Se este for um status legítimo novo da Brevo, adicione-o em STILL_PENDING_STATUSES ou " +
      "KNOWN_CANCELLED_STATUSES em scripts/lib/clarice-novos-state.ts.",
  };
}
