/**
 * scripts/lib/mensal/monthly-apoiadores-state.ts (#4521)
 *
 * Idempotência/dedup do envio extra Beehiiv pra apoiadores Mantenedor/Patrono
 * (#4482, render em `scripts/render-monthly-beehiiv.ts`) — ponto explicitamente
 * deixado em aberto pelo #4482 ("Escopo atual: só o primeiro envio, semi-manual")
 * e cobrado pela questão 3 do #4521: "registrar em algum estado... que a
 * edição X já foi enviada pros apoiadores, pra a skill não reenviar a mesma
 * edição 2x se rodada de novo."
 *
 * ## Por que não existe um estado "sent" automático
 *
 * `send-monthly-apoiadores.ts` (a skill que consome este módulo) NUNCA chama
 * a API de escrita da Beehiiv (guard de publicação, #4521 "Restrições
 * invioláveis" + regra 1 de `context/overnight-dispatch-rules.md`) — o envio
 * real continua manual (Custom HTML paste + Audience tab + Schedule, mesmo
 * fluxo do #4482). Por isso o ciclo de vida tem 2 estados, não 1:
 *
 *   1. `draft_prepared` — HTML renderizado localmente (`renderMonthlyBeehiivEmail`),
 *      NADA foi enviado ainda. Rodar de novo nesse estado é seguro/idempotente
 *      (só regenera o HTML — reflete qualquer edição do `draft.md` desde a
 *      última preparação).
 *   2. `sent` — o EDITOR confirmou manualmente, via `--mark-sent`, que de fato
 *      enviou pela UI da Beehiiv. Este módulo não tem como observar isso
 *      sozinho (não há webhook/poll da campanha real aqui) — é uma decisão
 *      humana registrada, não inferida.
 *
 * O dedup real (#4521 questão 3) age na transição `sent → prepare de novo`:
 * bloqueada por padrão (`decidePrepareAction`), destravável com `--force`
 * pra cobrir o caso legítimo "preciso reenviar uma correção".
 *
 * Fail-soft por design (mesmo padrão de `clarice-novos-state.ts`/
 * `studio-chat-enabled.ts`): leitura tolerante — arquivo ausente/corrompido/
 * shape inesperado vira `null` ("nunca preparado"), nunca lança.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";

export type ApoiadoresSendStatus = "draft_prepared" | "sent";

export interface ApoiadoresState {
  cycle: string;
  status: ApoiadoresSendStatus;
  /** ISO timestamp da última vez que o HTML foi (re)gerado. */
  preparedAt: string;
  /** ISO timestamp de quando o editor confirmou o envio real (`--mark-sent`). `null` enquanto `status !== "sent"`. */
  sentAt: string | null;
  /** Path absoluto do HTML gerado (`_internal/beehiiv-preview.html`). */
  htmlPath: string;
  subject: string;
  /** Nomes dos segmentos Beehiiv usados como audiência (auditoria — não reconstrói do zero em cada leitura). */
  segments: string[];
  /**
   * Id da campanha Brevo real criada por `scripts/publish-monthly-apoiadores-brevo.ts`
   * (Passo 2, #4572/#4593) — `null` enquanto nenhuma campanha Brevo foi criada
   * pra este ciclo (inclui todo state legado do fluxo Beehiiv, que nunca setava
   * este campo). Guard de idempotência do Passo 2 (`decidePublishBrevoAction`):
   * uma vez não-null, uma nova invocação sem `--force` é bloqueada — fecha o
   * "Gap conhecido" do SKILL.md (rodar o Passo 2 2x criava DOIS rascunhos
   * duplicados na Brevo, sem essa trava).
   */
  brevoCampaignId: number | null;
}

/** Nome do arquivo de estado, sob `_internal/` do ciclo — mesma convenção de `05-published.json`/`06-social-published.json`. */
const STATE_FILENAME = "beehiiv-apoiadores-state.json";

/** Path do state file para um `monthlyDir` já resolvido (`monthlyDir(cycle)` de `monthly-paths.ts`). */
export function apoiadoresStatePath(monthlyDir: string): string {
  return resolve(monthlyDir, "_internal", STATE_FILENAME);
}

/** Lê o state file. Tolerante: ausente/corrompido/shape inesperado → `null` (nunca lança) — "nunca preparado". */
export function readApoiadoresState(monthlyDir: string): ApoiadoresState | null {
  const path = apoiadoresStatePath(monthlyDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ApoiadoresState>;
    if (typeof parsed.cycle !== "string" || typeof parsed.preparedAt !== "string") return null;
    if (parsed.status !== "draft_prepared" && parsed.status !== "sent") return null;
    return {
      cycle: parsed.cycle,
      status: parsed.status,
      preparedAt: parsed.preparedAt,
      sentAt: typeof parsed.sentAt === "string" ? parsed.sentAt : null,
      htmlPath: typeof parsed.htmlPath === "string" ? parsed.htmlPath : "",
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      segments: Array.isArray(parsed.segments) ? parsed.segments.filter((s): s is string => typeof s === "string") : [],
      brevoCampaignId: typeof parsed.brevoCampaignId === "number" ? parsed.brevoCampaignId : null,
    };
  } catch {
    return null;
  }
}

/** Escreve o state file (escrita atômica, mesmo padrão do resto do projeto). Cria `_internal/` se faltar. */
export function writeApoiadoresState(monthlyDir: string, state: ApoiadoresState): void {
  mkdirSync(resolve(monthlyDir, "_internal"), { recursive: true });
  writeFileAtomic(apoiadoresStatePath(monthlyDir), JSON.stringify(state, null, 2) + "\n");
}

export type PrepareDecision = { action: "prepare" } | { action: "blocked"; reason: string };

/**
 * Pura/testável: decide se `send-monthly-apoiadores.ts` (sem `--mark-sent`)
 * pode prosseguir a preparar/regenerar o HTML.
 *
 *   - Sem estado prévio, ou `status === "draft_prepared"` → sempre permitido
 *     (idempotente/inofensivo — só regenera o HTML a partir do `draft.md`
 *     atual, nunca envia nada).
 *   - `status === "sent"` sem `--force` → BLOQUEADO (dedup real, #4521
 *     questão 3): evita reprocessar/reabrir o fluxo de uma edição já
 *     confirmada como enviada por engano.
 *   - `status === "sent"` com `--force` → permitido (caso legítimo: reenviar
 *     uma correção).
 */
export function decidePrepareAction(state: ApoiadoresState | null, force: boolean): PrepareDecision {
  if (state?.status === "sent" && !force) {
    return {
      action: "blocked",
      reason:
        `Ciclo ${state.cycle} já foi marcado como ENVIADO pros apoiadores em ${state.sentAt}. ` +
        "Rodar de novo sem --force é bloqueado pra não reabrir por engano o fluxo de uma edição já confirmada " +
        "como enviada. Use --force se realmente precisa gerar o HTML de novo (ex: reenviar uma correção).",
    };
  }
  return { action: "prepare" };
}

/**
 * Pura/testável: monta o `ApoiadoresState` gravado após um `prepare`
 * bem-sucedido (`renderMonthlyBeehiivEmail` já rodou). Deliberadamente NÃO
 * recebe o state ANTERIOR — `sentAt` é sempre `null` aqui, nunca herdado.
 *
 * #4521 self-review: a 1ª versão deste script fazia `sentAt: state?.sentAt
 * ?? null` (herdava o `sentAt` do state anterior), o que violava o próprio
 * contrato de `ApiadoresState.sentAt` ("null enquanto status !== 'sent'")
 * no caso `--force` sobre um ciclo já `sent`: o registro virava um
 * `draft_prepared` com uma data de envio antiga carimbada — contraditório, e
 * perigoso pra qualquer consumidor futuro que checasse `sentAt` em vez de
 * `status` pra decidir "já foi enviado" (leria "sim" mesmo depois do
 * `--force` reabrir o ciclo pra uma correção). Extraído como função pura
 * pra travar esse contrato com teste, em vez de confiar em revisão visual da
 * linha inline no `main()`.
 *
 * `previousBrevoCampaignId` (#4572/#4593) é a ÚNICA exceção deliberada ao
 * "não recebe o state anterior": Passo 1 (este `prepare`, fluxo Beehiiv
 * legado) e Passo 2 (`publish-monthly-apoiadores-brevo.ts`, cria a campanha
 * Brevo real) escrevem no MESMO state file — sem repassar esse campo, rodar
 * o Passo 1 depois do Passo 2 apagaria o registro de que já existe uma
 * campanha Brevo criada pro ciclo, reabrindo a janela do "Gap conhecido" do
 * SKILL.md (2 rascunhos duplicados na Brevo). Diferente de `sentAt`, este
 * campo não carrega o bug documentado acima — não há transição que o torne
 * inconsistente, só registra um fato ("essa campanha Brevo já existe") que
 * continua verdadeiro independente do que o Passo 1 faz.
 */
export function buildPreparedState(
  cycle: string,
  preparedAt: string,
  htmlPath: string,
  subject: string,
  segments: readonly string[],
  previousBrevoCampaignId: number | null = null,
): ApoiadoresState {
  return {
    cycle,
    status: "draft_prepared",
    preparedAt,
    sentAt: null,
    htmlPath,
    subject,
    segments: [...segments],
    brevoCampaignId: previousBrevoCampaignId,
  };
}

export type MarkSentDecision =
  // `state` vai junto no branch "mark" (#4521 self-review) — o caller
  // (`send-monthly-apoiadores.ts`) precisava de um `state as ApoiadoresState`
  // pra montar o update, mesmo já tendo checado `decision.action === "mark"`;
  // TS não correlaciona automaticamente o discriminante de `MarkSentDecision`
  // com a nulidade do `state` passado como argumento separado. Devolver o
  // state (não-null, garantido pelo próprio branch) no resultado elimina o
  // cast no call site.
  | { action: "mark"; state: ApoiadoresState }
  | { action: "noop"; reason: string }
  | { action: "error"; reason: string };

/**
 * Pura/testável: decide o efeito de `--mark-sent` (confirmação manual do
 * editor de que o envio real já aconteceu pela UI da Beehiiv).
 *
 *   - Sem estado (`prepare` nunca rodou) → erro: não há o que marcar como
 *     enviado, e marcar sem um `htmlPath`/`subject` reais deixaria o estado
 *     inconsistente.
 *   - `status === "sent"` → noop (idempotente — já estava marcado; não é erro
 *     rodar `--mark-sent` 2x por engano).
 *   - `status === "draft_prepared"` → `mark` (transição válida).
 */
export function decideMarkSentAction(state: ApoiadoresState | null): MarkSentDecision {
  if (!state) {
    return {
      action: "error",
      reason:
        "Nenhum draft preparado ainda pra este ciclo. Rode sem --mark-sent primeiro " +
        "(gera o HTML e grava o estado 'draft_prepared'), depois de enviar de verdade pela UI da Beehiiv, " +
        "rode de novo com --mark-sent.",
    };
  }
  if (state.status === "sent") {
    return { action: "noop", reason: `Ciclo ${state.cycle} já estava marcado como enviado em ${state.sentAt} — nada a fazer.` };
  }
  return { action: "mark", state };
}

// ─────────────────────────────────────────────────────────────────────────
// #4572/#4593 — guard de idempotência Passo 1 ↔ Passo 2 (fecha o "Gap
// conhecido" do SKILL.md: `publish-monthly-apoiadores-brevo.ts` criava uma
// campanha Brevo real sem consultar nem gravar este state file, então rodar
// o Passo 2 2x pro mesmo ciclo criava DOIS rascunhos duplicados na Brevo).
// ─────────────────────────────────────────────────────────────────────────

export type PublishBrevoDecision = { action: "create" } | { action: "blocked"; reason: string };

/**
 * Pura/testável: decide se `publish-monthly-apoiadores-brevo.ts` (Passo 2)
 * pode criar uma campanha Brevo nova pra este ciclo. Dois motivos de bloqueio
 * independentes, cada um com `--force` como escape hatch explícito (mesma
 * disciplina de `decidePrepareAction`):
 *
 *   1. `status === "sent"` — ciclo já confirmado como enviado (`--mark-sent`,
 *      Passo 3). Criar outra campanha pra um ciclo já enviado é bloqueado por
 *      padrão (mesmo racional do dedup do Passo 1).
 *   2. `brevoCampaignId != null` — já existe uma campanha Brevo criada pra
 *      este ciclo (Passo 2 já rodou com sucesso antes), rascunho ou não. Sem
 *      este guard, rodar o Passo 2 de novo cria um 2º rascunho duplicado na
 *      Brevo (ruído no painel, não um blast radius alto — ambos exigem ação
 *      manual do editor pra sair de rascunho — mas é exatamente o gap que o
 *      SKILL.md documentava como aceito/não resolvido).
 *
 * `force: true` ignora os dois — mesmo `--force` que a skill já expõe
 * (SKILL.md `--force`), não introduz uma 2ª flag.
 */
export function decidePublishBrevoAction(state: ApoiadoresState | null, force: boolean): PublishBrevoDecision {
  if (force) return { action: "create" };
  if (state?.status === "sent") {
    return {
      action: "blocked",
      reason:
        `Ciclo ${state.cycle} já foi marcado como ENVIADO pros apoiadores em ${state.sentAt}. ` +
        "Criar uma nova campanha Brevo pra um ciclo já confirmado como enviado é bloqueado por padrão " +
        "(mesmo dedup do Passo 1). Use --force se realmente precisa (ex: reenviar uma correção).",
    };
  }
  if (state?.brevoCampaignId != null) {
    return {
      action: "blocked",
      reason:
        `Já existe uma campanha Brevo criada pro ciclo ${state.cycle} (id ${state.brevoCampaignId}, criada em ` +
        `${state.preparedAt}) — rodar de novo sem --force criaria um 2º rascunho duplicado na Brevo. Confira o ` +
        "painel Brevo (Campaigns → Drafts); use --force se realmente precisa criar outro.",
    };
  }
  return { action: "create" };
}

/**
 * Pura/testável: monta o `ApoiadoresState` gravado após o Passo 2 criar a
 * campanha Brevo com sucesso. Sempre `status: "draft_prepared"`/`sentAt:
 * null` — mesma filosofia de `buildPreparedState` (nunca herdar `sentAt`):
 * mesmo que `previous?.status === "sent"` (só alcançável aqui via `--force`,
 * ver `decidePublishBrevoAction`), a campanha recém-criada é NOVA e ainda não
 * foi enviada, então o estado correto é "preparado, não enviado" — não a data
 * de envio antiga carimbada por cima de um rascunho diferente.
 */
export function buildApoiadoresBrevoPublishedState(
  previous: ApoiadoresState | null,
  cycle: string,
  preparedAt: string,
  htmlPath: string,
  subject: string,
  brevoCampaignId: number,
): ApoiadoresState {
  return {
    cycle,
    status: "draft_prepared",
    preparedAt,
    sentAt: null,
    htmlPath,
    subject,
    segments: previous?.segments ?? [],
    brevoCampaignId,
  };
}
