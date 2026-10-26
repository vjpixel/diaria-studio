#!/usr/bin/env npx tsx
/**
 * subagent-usage-metrics.ts (#10476)
 *
 * Emite os eventos `subagent_metrics`, `review_metrics` e
 * `fleet_review_metrics` a partir dos transcripts LOCAIS dos subagentes da
 * sessão coordenadora — sem depender de o coordenador (LLM) lembrar de rodar
 * `log-event.ts` à mão em cada checkpoint.
 *
 * ## Por que existe
 *
 * Na rodada overnight 261018d, zero `subagent_metrics` e zero
 * `review_metrics` chegaram ao `data/run-log.jsonl` (16 subagentes
 * despachados, 3 reviews consolidados). O `coordinator_tokens_estimate` da
 * mesma rodada saiu nas 3 fases — porque desde o #9874 ele é emitido por
 * script (`coordinator-usage-estimate.ts`), não à mão. Os outros dois tipos
 * continuavam dependendo de prosa do SKILL.md ("emitir via `log-event.ts`
 * com os números do `harness_usage`"), e prosa que exige o coordenador
 * copiar números de um retorno de `Agent` é exatamente a classe que já
 * falhou no #5009 (260811) e de novo aqui. A rodada 261018 (coordenador
 * diferente) emitiu; a 261018d, não — a emissão não era determinística.
 *
 * ## Fonte do número
 *
 * O harness grava o transcript de CADA subagente em
 * `{transcriptsDir}/{sessionId}/subagents/agent-{id}.jsonl`, com um
 * `.meta.json` irmão (`agentType`, `description`) — confirmado ao vivo em
 * 19/10/2026 nos 16 subagentes da 261018d (ver também #7084 em
 * `scripts/lib/session-transcript.ts`). O `agentType` decide o tipo do
 * evento e o `papel` (#9875); o `description` dá os números de issue.
 *
 * `tokens` = soma de `input + cache_creation + cache_read + output` de todos
 * os turnos do subagente, **deduplicando por `message.id`**: o harness grava
 * uma linha por bloco de conteúdo da mesma resposta, todas com o mesmo
 * `usage` (medido: 64 linhas `assistant` para 36 respostas distintas num
 * implementador da 261018d) — somar linha a linha contaria a mesma resposta
 * 1,8× em média. A convenção (soma de todos os turnos, cache incluído) é a
 * mesma do `coordinator_tokens_estimate`, então as categorias Implementação e
 * Coordenador ficam comparáveis entre si; NÃO é o mesmo número que o
 * `subagent_tokens` do bloco `<usage>` do retorno do `Agent` (aproximação do
 * turno final — ver docstring de `session-transcript.ts`). Por isso o evento
 * leva `source: "subagent_transcript"`, nunca `harness_usage`.
 *
 * ## Idempotência
 *
 * Cada evento grava `details.agent_id`; rodar o script de novo não duplica
 * nada (qualquer evento já no run-log com o mesmo `agent_id` é pulado,
 * independente da edição). Eventos emitidos À MÃO (sem `agent_id`) também
 * suprimem o equivalente do script, pra não contar o mesmo subagente duas
 * vezes: `subagent_metrics`/`fleet_review_metrics` por papel + interseção de
 * issues; `review_metrics` pelos N primeiros reviews em ordem cronológica.
 *
 * ## Fail-soft
 *
 * Sem `CLAUDE_CODE_SESSION_ID` ou sem transcript da sessão: imprime o motivo
 * e sai 0 sem gravar. Sessão com transcript mas sem `subagents/` (ou sem
 * revisor consolidado) grava o marcador `token_instrumentation_empty` do
 * tipo vazio, pra checagem da Fase 2 não acusar "coordenador esqueceu os
 * checkpoints" numa rodada que só não despachou ninguém (#10483 finding 5). Subagente cujo transcript não tem usage → evento com
 * `tokens: null`, `source: "unavailable"`, `reason: "no_usage_entries"`
 * (nunca omitido, nunca zero). Nunca lança.
 *
 * ## Quando rodar: UMA vez, sem nada em voo (#10483 finding 1)
 *
 * Fase 2 do overnight/develop; fila drenada no continuo. Com a dedup por
 * `agent_id`, um subagente emitido no meio congelaria os tokens parciais e
 * perderia os turnos posteriores (inclusive os de um `SendMessage` que o
 * retome depois). O script pula quem ainda não deu `end_turn` (ver
 * `TranscriptSummary.finished`), mas isso é rede, não convite a rodar por
 * unidade: um subagente retomado depois de emitido continua perdendo turnos.
 *
 * Uso (comando standalone; idempotente):
 *   npx tsx scripts/subagent-usage-metrics.ts --edition 261018d --agent overnight
 *   npx tsx scripts/subagent-usage-metrics.ts --edition 261019 --agent continuo --since 2026-10-19T03:00:00Z
 *   npx tsx scripts/subagent-usage-metrics.ts ... --dry-run   # imprime, não grava
 *
 * @see scripts/coordinator-usage-estimate.ts (mesmo padrão, lado do coordenador)
 * @see scripts/check-overnight-token-instrumentation.ts (confere a presença)
 * @see scripts/aggregate-session-tokens.ts (consumidor das 3 categorias)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { logEvent, resolveRunLogPath } from "./lib/run-log.ts";
import { currentSessionId } from "./lib/session-transcript.ts";
import { COORDINATOR_KINDS, locateSessionTranscriptsDir, type CoordinatorKind } from "./coordinator-usage-estimate.ts";

export const SUBAGENT_METRICS_MESSAGE = "subagent_metrics";
export const REVIEW_METRICS_MESSAGE = "review_metrics";
export const FLEET_REVIEW_METRICS_MESSAGE = "fleet_review_metrics";
export const SUBAGENT_TRANSCRIPT_SOURCE = "subagent_transcript";

export interface SubagentMeta {
  agentType: string;
  description: string;
}

export type SubagentClassification =
  | { message: typeof SUBAGENT_METRICS_MESSAGE; papel: string }
  | { message: typeof REVIEW_METRICS_MESSAGE }
  | { message: typeof FLEET_REVIEW_METRICS_MESSAGE };

/** Um PR específico no description (`Review PR #10474`, `review PR 10474`) = review por PR. */
const PR_REF_RE = /\bPR\s*#?\d+/i;
/** Fixer despachado pra CI vermelho conta como `ci-retry` (#9875), não `dev-fixer`. */
const CI_RETRY_RE = /\bCI\b|ci-retry/i;

/**
 * Agents dedicados de uso geral que o SKILL.md do overnight/develop usa como
 * 2º fallback de review quando nem o plugin nem o `dev-revisor` resolvem
 * (#10547). Só contam como revisor quando o description declara review — o
 * mesmo agent lê threads no `/diaria-desbloqueia` e despacha texto ad-hoc.
 */
const REVIEW_FALLBACK_TYPES = new Set(["adhoc-opus-medium"]);
/** `Review consolidado pós-rodada`, `Review 1.5b`, `Review PR #N`, `revisão ...`. */
const REVIEW_DESCRIPTION_RE = /\b(?:review|revis[ãa]o|revisor)\b/i;

function isReviewer(meta: SubagentMeta): boolean {
  if (meta.agentType.startsWith("pr-review-toolkit:") || meta.agentType === "dev-revisor") return true;
  return REVIEW_FALLBACK_TYPES.has(meta.agentType) && REVIEW_DESCRIPTION_RE.test(meta.description);
}

/**
 * Pure: decide que evento um subagente vira. Revisor sem PR no description =
 * review consolidado pós-rodada (`review_metrics`, Fase 1.5); revisor com PR
 * = review de fleet pré-merge de uma unidade (`fleet_review_metrics`).
 * Revisor = `pr-review-toolkit:*`, `dev-revisor`, ou o fallback
 * `adhoc-opus-medium` com review no description (#10547).
 * Todo o resto vira `subagent_metrics` com `papel` = `agentType` (ou
 * `ci-retry` para fixer de CI) — papel fora da lista conhecida é contado
 * como veio pelo `check-overnight-token-instrumentation.ts`.
 *
 * `ci-retry` só existe quando o retry é um Agent NOVO (`dev-fixer` com CI no
 * description). Um retry via `SendMessage` escreve no transcript do MESMO
 * agente, então os tokens dele entram no evento do papel original — o
 * script emite um evento por `agent_id`, não por segmento (#10547).
 */
export function classifySubagent(meta: SubagentMeta): SubagentClassification {
  if (isReviewer(meta)) {
    return PR_REF_RE.test(meta.description)
      ? { message: FLEET_REVIEW_METRICS_MESSAGE }
      : { message: REVIEW_METRICS_MESSAGE };
  }
  if (meta.agentType === "dev-fixer" && CI_RETRY_RE.test(meta.description)) {
    return { message: SUBAGENT_METRICS_MESSAGE, papel: "ci-retry" };
  }
  return { message: SUBAGENT_METRICS_MESSAGE, papel: meta.agentType || "desconhecido" };
}

/**
 * Pure: referências citadas no description. `#N` solto é issue
 * (`#10443 + #10442` → issues [10443, 10442]); `PR #N`/`PR N` é PR
 * (`Fixer PR #10445 findings` → prs [10445]) — fixer e review por PR são
 * despachados pelo número do PR, que não é número de issue.
 */
export function extractRefs(description: string): { issues: number[]; prs: number[] } {
  const issues: number[] = [];
  const prs: number[] = [];
  for (const m of description.matchAll(/(\bPR\s*#?|#)(\d{1,7})\b/gi)) {
    const n = Number(m[2]);
    const bucket = /^PR/i.test(m[1]) ? prs : issues;
    if (!bucket.includes(n)) bucket.push(n);
  }
  return { issues, prs };
}

/** Pure: só os números de issue (ver `extractRefs`). */
export function extractIssueNumbers(description: string): number[] {
  return extractRefs(description).issues;
}

export interface TranscriptSummary {
  /** `null` = nenhum turno com usage no transcript. */
  tokens: number | null;
  toolUses: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /**
   * O subagente terminou (#10483 finding 1): o último `stop_reason` não-nulo
   * do transcript é `end_turn` e nenhuma linha `user` (tool_result, ou a
   * mensagem de um `SendMessage` que o retomou) veio depois dele. Medido em
   * 19/10/2026: subagente concluído termina em `end_turn`; um em voo, em
   * `tool_use`. Subagente em voo NÃO é emitido — com a dedup por `agent_id`,
   * emitir no meio congelaria os tokens parciais e perderia os turnos seguintes.
   */
  finished: boolean;
}

interface UsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function usageTotal(u: UsageShape): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.output_tokens ?? 0)
  );
}

/**
 * Pure: resume o conteúdo de um transcript de subagente. Deduplica `usage`
 * por `message.id` (última linha vence — o harness repete o mesmo `usage` em
 * cada bloco da resposta) e `tool_use` por id do bloco. Linha malformada é
 * ignorada.
 */
export function summarizeTranscript(content: string): TranscriptSummary {
  const usageById = new Map<string, number>();
  let anonymousTotal = 0;
  let anonymousCount = 0;
  const toolUseIds = new Set<string>();
  let anonymousToolUses = 0;
  let first: string | null = null;
  let last: string | null = null;
  let lastStopReason: string | null = null;
  let userAfterStop = false;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : null;
    if (ts && Number.isFinite(Date.parse(ts))) {
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
    }
    if (obj.type === "user") userAfterStop = true;
    if (obj.type !== "assistant") continue;
    const message = (obj.message ?? {}) as { id?: unknown; usage?: UsageShape; content?: unknown; stop_reason?: unknown };
    if (typeof message.stop_reason === "string" && message.stop_reason) {
      lastStopReason = message.stop_reason;
      userAfterStop = false;
    }
    if (message.usage && typeof message.usage === "object") {
      const total = usageTotal(message.usage);
      if (typeof message.id === "string" && message.id) usageById.set(message.id, total);
      else {
        anonymousTotal += total;
        anonymousCount += 1;
      }
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block?.type !== "tool_use") continue;
        if (typeof block.id === "string" && block.id) toolUseIds.add(block.id);
        else anonymousToolUses += 1;
      }
    }
  }
  const hasUsage = usageById.size > 0 || anonymousCount > 0;
  let tokens: number | null = null;
  if (hasUsage) {
    tokens = anonymousTotal;
    for (const v of usageById.values()) tokens += v;
  }
  return {
    tokens,
    toolUses: toolUseIds.size + anonymousToolUses,
    firstTimestamp: first,
    lastTimestamp: last,
    finished: lastStopReason === "end_turn" && !userAfterStop,
  };
}

export interface SubagentRecord {
  agentId: string;
  meta: SubagentMeta;
  summary: TranscriptSummary;
}

/**
 * Lê `{transcriptsDir}/{sessionId}/subagents/` — um registro por
 * `agent-{id}.jsonl`. `.meta.json` ausente ou ilegível vira `agentType`
 * vazio (papel `desconhecido`), nunca descarta o subagente: o custo existe
 * mesmo sem o metadado. Diretório ausente → `[]`.
 */
export function readSessionSubagents(transcriptsDir: string, sessionId: string): SubagentRecord[] {
  const dir = join(transcriptsDir, sessionId, "subagents");
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    console.error(
      `[subagent-usage-metrics] readdirSync falhou em ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  const records: SubagentRecord[] = [];
  for (const file of files) {
    const base = file.slice(0, -".jsonl".length);
    const agentId = base.startsWith("agent-") ? base.slice("agent-".length) : base;
    let meta: SubagentMeta = { agentType: "", description: "" };
    try {
      const raw = JSON.parse(readFileSync(join(dir, `${base}.meta.json`), "utf8")) as Record<string, unknown>;
      meta = {
        agentType: typeof raw.agentType === "string" ? raw.agentType : "",
        description: typeof raw.description === "string" ? raw.description : "",
      };
    } catch {
      // meta ausente/ilegível: mantém o default, o subagente ainda conta.
    }
    let content = "";
    try {
      content = readFileSync(join(dir, file), "utf8");
    } catch {
      content = "";
    }
    records.push({ agentId, meta, summary: summarizeTranscript(content) });
  }
  return records.sort((a, b) =>
    (a.summary.firstTimestamp ?? "").localeCompare(b.summary.firstTimestamp ?? "") || a.agentId.localeCompare(b.agentId),
  );
}

/**
 * Marcador de "rodada sem subagente desse tipo" (#10483 finding 5). Sem ele,
 * uma rodada que não despachou nenhum implementador (ou nenhum review
 * consolidado — diff trivial) sai com zero `subagent_metrics`/`review_metrics`
 * e o `check-overnight-token-instrumentation.ts` acusa "coordenador esqueceu
 * os checkpoints", que é falso. `details.tipo` diz qual dos dois está vazio.
 */
export const TOKEN_INSTRUMENTATION_EMPTY_MESSAGE = "token_instrumentation_empty";
export const EMPTY_MARKER_TIPOS = [SUBAGENT_METRICS_MESSAGE, REVIEW_METRICS_MESSAGE] as const;
const EMPTY_MARKER_REASON: Record<(typeof EMPTY_MARKER_TIPOS)[number], string> = {
  [SUBAGENT_METRICS_MESSAGE]: "no_subagents",
  [REVIEW_METRICS_MESSAGE]: "no_reviewers",
};

/**
 * Subagente sem `end_turn` cuja última atividade é mais velha que isto é
 * tratado como morto (abortado, sessão caída) e emitido com
 * `finished: false` — senão nunca entraria no run-log. Uma chamada de
 * ferramenta em foreground tem teto de 10 min; 1h dá folga larga.
 */
export const UNFINISHED_STALE_MS = 60 * 60 * 1000;

export interface PlannedEvent {
  message: SubagentClassification["message"] | typeof TOKEN_INSTRUMENTATION_EMPTY_MESSAGE;
  details: Record<string, unknown>;
}

interface ExistingEventIndex {
  agentIds: Set<string>;
  /** `subagent_metrics` à mão (sem agent_id) da edição: papel + issues. */
  manualSubagent: Array<{ papel: string; issues: number[] }>;
  /** Nº de `review_metrics` à mão (sem agent_id) da edição. */
  manualReviewCount: number;
  /** `fleet_review_metrics` à mão (sem agent_id) da edição: issues. */
  manualFleet: Array<{ issues: number[] }>;
  /** Tipos com ≥1 evento (qualquer origem) ou marcador vazio já gravado nesta edição. */
  presentInEdition: Set<string>;
}

function asIssueList(details: Record<string, unknown>): number[] {
  if (Array.isArray(details.issues)) return details.issues.filter((n): n is number => typeof n === "number");
  if (typeof details.unidade === "string") return extractIssueNumbers(details.unidade);
  return [];
}

/**
 * Pure: indexa o que já está no run-log para não duplicar. Linha malformada é ignorada.
 *
 * `sessionId` (#11164): `presentInEdition` só considera eventos da MESMA
 * sessão — outra rodada na mesma edição (300 + Zenbook no mesmo dia) não pode
 * suprimir o marcador vazio desta, senão o check filtrado por sessão acusa
 * "esqueceu".
 *
 * Evento SEM `details.session_id` (legado, gravado antes do #11164, ou de
 * outra máquina com código defasado) também não suprime o marcador quando há
 * `sessionId` (#11182): é a mesma regra de `eventMatchesSession` em
 * `check-overnight-token-instrumentation.ts`, que com `--plan` descarta esse
 * evento. Tolerar aqui e descartar lá fazia a rodada sem dispatch não gravar
 * o marcador e o check imprimir "coordenador esqueceu". A tolerância a evento
 * sem o campo fica só na dedup por `agentIds` (e nos índices manuais), que
 * evita regravar o MESMO subagente e não decide marcador nenhum.
 */
export function indexExistingEvents(lines: string[], edition: string, sessionId?: string | null): ExistingEventIndex {
  const idx: ExistingEventIndex = {
    agentIds: new Set(),
    manualSubagent: [],
    manualReviewCount: 0,
    manualFleet: [],
    presentInEdition: new Set(),
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof rec !== "object" || rec === null) continue;
    const msg = rec.message;
    const details = (typeof rec.details === "object" && rec.details !== null ? rec.details : {}) as Record<string, unknown>;
    const sameSession = !sessionId || details.session_id === sessionId;
    if (msg === TOKEN_INSTRUMENTATION_EMPTY_MESSAGE) {
      if (rec.edition === edition && sameSession && typeof details.tipo === "string") idx.presentInEdition.add(details.tipo);
      continue;
    }
    if (msg !== SUBAGENT_METRICS_MESSAGE && msg !== REVIEW_METRICS_MESSAGE && msg !== FLEET_REVIEW_METRICS_MESSAGE) continue;
    if (rec.edition === edition && sameSession) idx.presentInEdition.add(msg);
    if (typeof details.agent_id === "string" && details.agent_id) {
      idx.agentIds.add(details.agent_id);
      continue;
    }
    if (rec.edition !== edition) continue;
    if (msg === SUBAGENT_METRICS_MESSAGE) {
      const papel = typeof details.papel === "string" && details.papel.trim() ? details.papel.trim() : "";
      idx.manualSubagent.push({ papel, issues: asIssueList(details) });
    } else if (msg === REVIEW_METRICS_MESSAGE) {
      idx.manualReviewCount += 1;
    } else {
      idx.manualFleet.push({ issues: asIssueList(details) });
    }
  }
  return idx;
}

function overlaps(a: number[], b: number[]): boolean {
  return a.some((n) => b.includes(n));
}

function unidadeOf(issues: number[], prs: number[], description: string): string {
  if (issues.length === 1) return `#${issues[0]}`;
  if (issues.length > 1) return `lote ${issues.map((n) => `#${n}`).join(" + ")}`;
  if (prs.length > 0) return prs.map((n) => `PR #${n}`).join(" + ");
  return description || "sem-issue";
}

function durationMs(summary: TranscriptSummary): number | null {
  if (!summary.firstTimestamp || !summary.lastTimestamp) return null;
  const d = Date.parse(summary.lastTimestamp) - Date.parse(summary.firstTimestamp);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

function sourceFields(summary: TranscriptSummary): Record<string, unknown> {
  return summary.tokens === null
    ? { source: "unavailable", reason: "no_usage_entries" }
    : { source: SUBAGENT_TRANSCRIPT_SOURCE };
}

export interface PlanResult {
  events: PlannedEvent[];
  skipped: number;
  /** Subagentes em voo (sem `end_turn`, atividade recente) — não emitidos, ficam pra próxima execução. */
  inFlight: number;
  /** Marcadores `token_instrumentation_empty` a gravar (#10483 finding 5). */
  markers: PlannedEvent[];
}

/**
 * Pure: decide quais eventos gravar. `sinceIso` restringe aos subagentes que
 * começaram a partir daquele instante (sessão `continuo` atravessa vários
 * dias/edições). `review_metrics.depth` = posição cronológica entre os
 * reviews consolidados da janela (0 = review inicial, 1 = 1.5b, 2 = 1.5c).
 * Subagente em voo (ver `TranscriptSummary.finished`) é pulado e contado em
 * `inFlight`; o sem `end_turn` com atividade mais velha que
 * `UNFINISHED_STALE_MS` é emitido com `finished: false`.
 *
 * `sessionId` (#11164): gravado em `details.session_id` de todo evento e
 * marcador, pra `check-overnight-token-instrumentation.ts --plan` separar esta
 * rodada de outra que grave a mesma edição no mesmo dia.
 */
export function planEvents(
  records: SubagentRecord[],
  existingLines: string[],
  edition: string,
  sinceIso?: string,
  nowMs: number = Date.now(),
  sessionId?: string | null,
): PlanResult {
  const idx = indexExistingEvents(existingLines, edition, sessionId);
  const sessionField = sessionId ? { session_id: sessionId } : {};
  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
  const inWindow = records.filter((r) => {
    if (!Number.isFinite(sinceMs)) return true;
    const start = r.summary.firstTimestamp ? Date.parse(r.summary.firstTimestamp) : NaN;
    return Number.isFinite(start) && start >= sinceMs;
  });
  const events: PlannedEvent[] = [];
  let skipped = 0;
  let inFlight = 0;
  let reviewDepth = 0;
  const classesInWindow = new Set<string>();
  let manualReviewsToAbsorb = idx.manualReviewCount;
  const manualSubagent = [...idx.manualSubagent];
  const manualFleet = [...idx.manualFleet];

  for (const r of inWindow) {
    const cls = classifySubagent(r.meta);
    const { issues, prs } = extractRefs(r.meta.description);
    classesInWindow.add(cls.message);
    const depth = cls.message === REVIEW_METRICS_MESSAGE ? reviewDepth++ : null;
    if (idx.agentIds.has(r.agentId)) {
      skipped++;
      continue;
    }
    if (!r.summary.finished) {
      const lastMs = r.summary.lastTimestamp ? Date.parse(r.summary.lastTimestamp) : NaN;
      if (!Number.isFinite(lastMs) || nowMs - lastMs < UNFINISHED_STALE_MS) {
        inFlight++;
        continue;
      }
    }
    const tokens = r.summary.tokens;
    const common = {
      agent_id: r.agentId,
      agent_type: r.meta.agentType,
      description: r.meta.description,
      tool_uses: r.summary.toolUses,
      duration_ms: durationMs(r.summary),
      ...sourceFields(r.summary),
      ...(r.summary.finished ? {} : { finished: false }),
      ...sessionField,
    };
    if (cls.message === SUBAGENT_METRICS_MESSAGE) {
      const manualIdx = manualSubagent.findIndex((m) => m.papel === cls.papel && overlaps(m.issues, issues));
      if (manualIdx >= 0) {
        manualSubagent.splice(manualIdx, 1);
        skipped++;
        continue;
      }
      events.push({
        message: cls.message,
        details: { unidade: unidadeOf(issues, prs, r.meta.description), issues, prs, papel: cls.papel, subagent_tokens: tokens, ...common },
      });
    } else if (cls.message === REVIEW_METRICS_MESSAGE) {
      if (manualReviewsToAbsorb > 0) {
        manualReviewsToAbsorb--;
        skipped++;
        continue;
      }
      events.push({ message: cls.message, details: { depth, review_tokens: tokens, ...common } });
    } else {
      const manualIdx = manualFleet.findIndex((m) => overlaps(m.issues, issues));
      if (manualIdx >= 0) {
        manualFleet.splice(manualIdx, 1);
        skipped++;
        continue;
      }
      events.push({
        message: cls.message,
        details: { unidade: unidadeOf(issues, prs, r.meta.description), issues, prs, fleet_tokens: tokens, ...common },
      });
    }
  }
  const markers: PlannedEvent[] = [];
  for (const tipo of EMPTY_MARKER_TIPOS) {
    if (classesInWindow.has(tipo) || idx.presentInEdition.has(tipo)) continue;
    markers.push({ message: TOKEN_INSTRUMENTATION_EMPTY_MESSAGE, details: { tipo, reason: EMPTY_MARKER_REASON[tipo], ...sessionField } });
  }
  return { events, skipped, inFlight, markers };
}

export type CollectOutcome =
  | { status: "ok"; events: PlannedEvent[]; skipped: number; inFlight: number; markers: PlannedEvent[]; subagents: number }
  | { status: "unavailable"; reason: "no_session_id" | "session_transcript_not_found" };

/** Orquestração com I/O (transcripts + run-log). Injetável pra teste. */
export function collectSubagentMetrics(opts: {
  edition: string;
  sinceIso?: string;
  sessionId?: string | null;
  rootDir?: string;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): CollectOutcome {
  const rootDir = opts.rootDir ?? process.cwd();
  const sessionId = opts.sessionId !== undefined ? opts.sessionId : currentSessionId(opts.env ?? process.env);
  if (!sessionId) return { status: "unavailable", reason: "no_session_id" };
  const transcriptsDir = locateSessionTranscriptsDir(sessionId, opts.cwd ?? rootDir, opts.homeDir);
  // Sem transcript da sessão não dá pra afirmar nada. Com ele e sem
  // `subagents/`, a sessão genuinamente não despachou ninguém (#10483
  // finding 5): segue com zero registros e grava os marcadores vazios.
  if (!existsSync(join(transcriptsDir, `${sessionId}.jsonl`)) && !existsSync(join(transcriptsDir, sessionId, "subagents"))) {
    return { status: "unavailable", reason: "session_transcript_not_found" };
  }
  const records = readSessionSubagents(transcriptsDir, sessionId);
  const logPath = resolveRunLogPath(rootDir);
  let lines: string[] = [];
  try {
    lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [];
  } catch {
    lines = [];
  }
  const { events, skipped, inFlight, markers } = planEvents(records, lines, opts.edition, opts.sinceIso, opts.nowMs, sessionId);
  return { status: "ok", events, skipped, inFlight, markers, subagents: records.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const edition = values.edition;
  const agent = values.agent as CoordinatorKind;
  if (!edition || !agent || !(COORDINATOR_KINDS as readonly string[]).includes(agent)) {
    console.error(
      `[subagent-usage-metrics] uso: --edition {AAMMDD} --agent {${COORDINATOR_KINDS.join("|")}} [--since ISO] [--session-id UUID] [--dry-run]`,
    );
    process.exit(2);
  }
  const outcome = collectSubagentMetrics({
    edition,
    sinceIso: values.since,
    sessionId: values["session-id"] ?? undefined,
  });
  if (outcome.status === "unavailable") {
    console.log(`[subagent-usage-metrics] nada gravado: ${outcome.reason} (sem subagente conhecido nesta sessão).`);
    process.exit(0);
  }
  if (flags.has("dry-run")) {
    console.log(JSON.stringify({ edition, agent, ...outcome }, null, 2));
    return;
  }
  const toWrite = [...outcome.events, ...outcome.markers];
  let written = 0;
  for (const ev of toWrite) {
    if (logEvent({ edition, stage: null, agent, level: "info", message: ev.message, details: ev.details })) written++;
  }
  const byType = toWrite.reduce<Record<string, number>>((acc, ev) => {
    acc[ev.message] = (acc[ev.message] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(", ") || "nenhum evento novo";
  console.log(
    `✓ subagent-usage-metrics: ${written}/${toWrite.length} gravado(s) (${summary}); ` +
      `${outcome.skipped} já emitido(s); ${outcome.inFlight} em voo (não emitido(s), rodar de novo quando terminarem); ` +
      `${outcome.subagents} subagente(s) na sessão.`,
  );
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}
