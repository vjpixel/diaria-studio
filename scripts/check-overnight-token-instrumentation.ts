#!/usr/bin/env npx tsx
/**
 * check-overnight-token-instrumentation.ts (#5009)
 *
 * Checagem DETERMINÍSTICA (não-LLM) de que o coordenador de uma rodada
 * `/diaria-overnight`/`/diaria-develop` de fato emitiu a instrumentação de
 * token mandatada pelo `SKILL.md` (#3453 Rec 1, #4815) — os eventos
 * `subagent_metrics` e `review_metrics` (emitidos uma vez na Fase 2 por
 * `subagent-usage-metrics.ts`, #10476/#10483) e `coordinator_tokens_estimate`
 * (fim de cada fase, #3453 Rec 1). Tipo com zero eventos e com o marcador
 * `token_instrumentation_empty` = rodada sem subagente daquele tipo, não
 * esquecimento (#10483 finding 5).
 *
 * **Por que existe:** a rodada 260811 terminou com 0 eventos
 * `subagent_metrics`/`coordinator_tokens_estimate` e só 1 `review_metrics` —
 * o coordenador simplesmente esqueceu de rodar os `Bash` calls de
 * `log-event.ts` nos checkpoints previstos. O relatório final escreveu
 * `unavailable` na seção "Custo em tokens" (Fase 2, mandatória desde #4815),
 * que é EXATAMENTE o mesmo texto que apareceria se o harness não expusesse
 * `usage`/token count programaticamente — as duas causas são indistinguíveis
 * pra quem lê o relatório depois. Este script fecha essa ambiguidade: conta
 * os eventos de fato gravados em `data/run-log.jsonl` pra edição/rodada
 * dada e devolve um veredito (`ok`/`warning`) que o coordenador cola
 * verbatim na seção "Custo em tokens" do relatório (Fase 2) — nunca mais
 * silenciosamente "esquecido".
 *
 * **Não é gate.** Roda em foreground na Fase 2 (compilação do relatório),
 * sempre imprime uma seção — não bloqueia merge nem falha a rodada; é
 * puramente informativo (advisory), exit 0 sempre que a leitura do
 * `run-log.jsonl` for bem-sucedida (mesmo com `warning`).
 *
 * Uso:
 *   npx tsx scripts/check-overnight-token-instrumentation.ts --edition 260811
 *   npx tsx scripts/check-overnight-token-instrumentation.ts --run-dir data/overnight/260811
 *   npx tsx scripts/check-overnight-token-instrumentation.ts --edition 261025 --plan data/overnight/261025b/plan.json
 *   npx tsx scripts/check-overnight-token-instrumentation.ts --edition 261025 --session-id {uuid}
 *
 * **Filtro de sessão (#11164).** Só `--edition` conta os eventos de TODAS as
 * sessões que gravaram aquela edição — e duas rodadas no mesmo dia (300 +
 * Zenbook, 261025) gravam a mesma. Foi assim que o check disse "OK" para uma
 * sessão que não emitira nada. Com `--plan` (lê o `session_id` da raiz do
 * `plan.json`) ou `--session-id`, só contam os eventos com
 * `details.session_id` daquela sessão, gravado pelos emissores
 * (`subagent-usage-metrics.ts`, `coordinator-usage-estimate.ts`).
 *
 * `--run-dir` é um atalho: a edição é derivada do basename do path (ex:
 * `data/overnight/260811/` → edição `260811`) — útil quando o coordenador já
 * tem o path da rodada em mãos e não quer repetir o AAMMDD.
 *
 * @see .claude/skills/diaria-overnight/SKILL.md (Fase 2 — "Custo em tokens")
 * @see scripts/log-event.ts (emissor dos 3 tipos de evento checados aqui)
 * @see scripts/lib/run-log.ts (resolveRunLogPath — mesma resolução de path)
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveRunLogPath } from "./lib/run-log.ts";

/** Os 3 tipos de evento mandatados pelo SKILL.md (#3453 Rec 1, #4815). */
export const TRACKED_TOKEN_INSTRUMENTATION_MESSAGES = [
  "subagent_metrics",
  "coordinator_tokens_estimate",
  "review_metrics",
] as const;

export type TrackedTokenInstrumentationMessage = (typeof TRACKED_TOKEN_INSTRUMENTATION_MESSAGES)[number];

export type TokenInstrumentationCounts = Record<TrackedTokenInstrumentationMessage, number>;

/**
 * `empty` = tipos com zero eventos mas com o marcador
 * `token_instrumentation_empty` gravado por `subagent-usage-metrics.ts`
 * (#10483 finding 5): a rodada não despachou nenhum subagente daquele tipo.
 * Não conta como "coordenador esqueceu". Ausente/vazio quando não se aplica.
 */
export type TokenInstrumentationVerdict =
  | { status: "ok"; empty?: TrackedTokenInstrumentationMessage[] }
  | { status: "warning"; missing: TrackedTokenInstrumentationMessage[]; empty?: TrackedTokenInstrumentationMessage[] };

/** Mesmo literal de `TOKEN_INSTRUMENTATION_EMPTY_MESSAGE` em `subagent-usage-metrics.ts` (travado por teste). */
export const TOKEN_INSTRUMENTATION_EMPTY_MESSAGE = "token_instrumentation_empty";

/**
 * Papéis conhecidos de `subagent_metrics.details.papel` (#9875). Um evento por
 * invocação de `Agent` da unidade — sem o campo, o custo do implementador fica
 * somado ao de fixer e retry de CI e não dá pra medir a troca de modelo de um
 * papel só. Valor fora desta lista é contado como veio (não descartado); evento
 * sem o campo (ou com valor não-string/vazio) cai em `SEM_PAPEL`.
 */
export const SUBAGENT_METRICS_PAPEIS = ["dev-implementador", "dev-fixer", "ci-retry"] as const;

export const SEM_PAPEL = "sem-papel";

export interface PapelBreakdownEntry {
  /** Nº de eventos `subagent_metrics` com este papel. */
  events: number;
  /** Soma de `subagent_tokens` numéricos (eventos com `null` não somam). */
  tokens: number;
}

/** Quebra de `subagent_metrics` por `details.papel` (#9875). */
export type PapelBreakdown = Record<string, PapelBreakdownEntry>;

/**
 * Escopo da contagem (#11164). `sessionId` restringe aos eventos gravados por
 * aquela sessão (`details.session_id`); sem ele a contagem é só por edição.
 * `unscopedReason` explica no texto por que não houve filtro (ex.: `plan.json`
 * legado sem `session_id`), pra a ressalva aparecer no relatório.
 */
export interface TokenInstrumentationScope {
  sessionId?: string | null;
  unscopedReason?: string;
}

export interface TokenInstrumentationResult {
  edition: string;
  /** Sessão usada como filtro (#11164); `null` = contagem só por edição. */
  sessionId: string | null;
  counts: TokenInstrumentationCounts;
  /** Quebra dos eventos `subagent_metrics` por papel (#9875). */
  papelBreakdown: PapelBreakdown;
  verdict: TokenInstrumentationVerdict;
  /** Texto markdown pronto pra colar na seção "Custo em tokens" do relatório (Fase 2). */
  section: string;
}

function zeroCounts(): TokenInstrumentationCounts {
  return {
    subagent_metrics: 0,
    coordinator_tokens_estimate: 0,
    review_metrics: 0,
  };
}

function isTrackedMessage(msg: unknown): msg is TrackedTokenInstrumentationMessage {
  return (
    typeof msg === "string" &&
    (TRACKED_TOKEN_INSTRUMENTATION_MESSAGES as readonly string[]).includes(msg)
  );
}

/**
 * Pure (#11164): o evento pertence à sessão pedida? Sem filtro (`sessionId`
 * nulo/vazio) todo evento passa — comportamento legado, só por edição. Com
 * filtro, só passa o evento cujo `details.session_id` é exatamente a sessão:
 * evento sem o campo (emitido antes do #11164, ou à mão) NÃO conta, porque
 * não há como provar que é desta rodada — duas rodadas no mesmo dia (300 +
 * Zenbook, 261025) gravam a MESMA `edition`, e contar o evento alheio faz o
 * check dizer "OK" para uma sessão que não emitiu nada.
 */
export function eventMatchesSession(rec: Record<string, unknown>, sessionId: string | null | undefined): boolean {
  if (!sessionId) return true;
  const details = typeof rec.details === "object" && rec.details !== null ? (rec.details as Record<string, unknown>) : {};
  return details.session_id === sessionId;
}

/** Pure: linhas JSON válidas (objeto) da edição e da sessão pedidas. Malformada é ignorada, nunca lança. */
function recordsFor(lines: string[], edition: string, sessionId?: string | null): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    if (rec.edition !== edition) continue;
    if (!eventMatchesSession(rec, sessionId)) continue;
    out.push(rec);
  }
  return out;
}

/**
 * Pure: conta, por tipo, quantos eventos `run-log.jsonl` (já lido como array
 * de linhas) batem `edition === edition` entre os 3 tipos rastreados — e, com
 * `sessionId`, só os gravados por aquela sessão (#11164). Linhas
 * malformadas (JSON inválido, ou sem os campos esperados) são ignoradas —
 * nunca lança; o objetivo é contar o que É reconhecível, não validar o
 * formato inteiro do log.
 */
export function countTokenInstrumentationEvents(
  lines: string[],
  edition: string,
  sessionId?: string | null,
): TokenInstrumentationCounts {
  const counts = zeroCounts();
  for (const rec of recordsFor(lines, edition, sessionId)) {
    if (isTrackedMessage(rec.message)) {
      counts[rec.message] += 1;
    }
  }
  return counts;
}

/**
 * Pure (#10483 finding 5): tipos rastreados que têm o marcador
 * `token_instrumentation_empty` (`details.tipo`) gravado nesta edição.
 * Linha malformada é ignorada, nunca lança.
 */
export function countEmptyMarkers(
  lines: string[],
  edition: string,
  sessionId?: string | null,
): Set<TrackedTokenInstrumentationMessage> {
  const marked = new Set<TrackedTokenInstrumentationMessage>();
  for (const rec of recordsFor(lines, edition, sessionId)) {
    if (rec.message !== TOKEN_INSTRUMENTATION_EMPTY_MESSAGE) continue;
    const details = typeof rec.details === "object" && rec.details !== null ? (rec.details as Record<string, unknown>) : {};
    if (isTrackedMessage(details.tipo)) marked.add(details.tipo);
  }
  return marked;
}

/**
 * Pure (#9875): agrupa os eventos `subagent_metrics` da edição por
 * `details.papel`, contando eventos e somando `subagent_tokens` numéricos.
 * Mesma tolerância de `countTokenInstrumentationEvents`: linha malformada é
 * ignorada, nunca lança.
 */
export function countSubagentMetricsByPapel(
  lines: string[],
  edition: string,
  sessionId?: string | null,
): PapelBreakdown {
  const breakdown: PapelBreakdown = {};
  for (const rec of recordsFor(lines, edition, sessionId)) {
    if (rec.message !== "subagent_metrics") continue;
    const details =
      typeof rec.details === "object" && rec.details !== null ? (rec.details as Record<string, unknown>) : {};
    const rawPapel = details.papel;
    const papel = typeof rawPapel === "string" && rawPapel.trim() ? rawPapel.trim() : SEM_PAPEL;
    const entry = (breakdown[papel] ??= { events: 0, tokens: 0 });
    entry.events += 1;
    const tokens = details.subagent_tokens;
    if (typeof tokens === "number" && Number.isFinite(tokens)) entry.tokens += tokens;
  }
  return breakdown;
}

/**
 * Pure (#9875): linha legível da quebra por papel — papéis conhecidos na
 * ordem de `SUBAGENT_METRICS_PAPEIS`, depois os desconhecidos em ordem
 * alfabética, `sem-papel` por último. String vazia se não há evento.
 */
export function formatPapelBreakdown(breakdown: PapelBreakdown): string {
  const known = SUBAGENT_METRICS_PAPEIS.filter((p) => breakdown[p]);
  const unknown = Object.keys(breakdown)
    .filter((p) => p !== SEM_PAPEL && !(SUBAGENT_METRICS_PAPEIS as readonly string[]).includes(p))
    .sort();
  const order = [...known, ...unknown, ...(breakdown[SEM_PAPEL] ? [SEM_PAPEL] : [])];
  if (order.length === 0) return "";
  const parts = order.map((p) => `${p}: ${breakdown[p].events} evento(s) / ${breakdown[p].tokens} tokens`);
  return `subagent_metrics por papel: ${parts.join("; ")}.`;
}

/**
 * Pure: veredito a partir das contagens. `ok` só quando os 3 tipos têm pelo
 * menos 1 evento; caso contrário `warning` nomeando exatamente os tipos
 * ausentes (nunca "tudo ou nada" — uma rodada pode ter emitido 2 dos 3).
 */
export function resolveTokenInstrumentationVerdict(
  counts: TokenInstrumentationCounts,
  emptyMarked: ReadonlySet<TrackedTokenInstrumentationMessage> = new Set(),
): TokenInstrumentationVerdict {
  const zero = TRACKED_TOKEN_INSTRUMENTATION_MESSAGES.filter((m) => counts[m] === 0);
  const empty = zero.filter((m) => emptyMarked.has(m));
  const missing = zero.filter((m) => !emptyMarked.has(m));
  const emptyField = empty.length > 0 ? { empty } : {};
  if (missing.length === 0) return { status: "ok", ...emptyField };
  return { status: "warning", missing, ...emptyField };
}

/**
 * Pure: seção markdown pronta pra colar na seção "Custo em tokens" do
 * relatório final (Fase 2). Em `warning`, usa a frase explícita mandatada
 * pela issue #5009 — nunca o `unavailable` ambíguo que motivou a issue.
 */
export function buildTokenInstrumentationSection(
  edition: string,
  counts: TokenInstrumentationCounts,
  verdict: TokenInstrumentationVerdict,
  scope: TokenInstrumentationScope = {},
): string {
  const scopeLabel = scope.sessionId ? `edição ${edition}, sessão ${scope.sessionId}` : `edição ${edition}`;
  const scopeNote = scope.sessionId
    ? ""
    : scope.unscopedReason
      ? ` Sem filtro de sessão (${scope.unscopedReason}): a contagem pode incluir eventos de outra rodada da mesma edição.`
      : "";
  const countsSummary = TRACKED_TOKEN_INSTRUMENTATION_MESSAGES.map((m) => `${m}: ${counts[m]}`).join(", ");
  const emptyNote =
    verdict.empty && verdict.empty.length > 0
      ? ` Sem subagente despachado (marcador do script, não esquecimento): ${verdict.empty.join(", ")}.`
      : "";
  if (verdict.status === "ok") {
    return (
      `Instrumentação de token (checagem automática, ${scopeLabel}): OK — ` +
      `${countsSummary}.${emptyNote}${scopeNote}`
    );
  }
  const missingList = verdict.missing.join(", ");
  return (
    `Instrumentação de token (checagem automática, ${scopeLabel}): ` +
    `instrumentação de token não foi emitida nesta rodada (coordenador esqueceu os checkpoints) — ` +
    `tipo(s) ausente(s): ${missingList} (${countsSummary}).${emptyNote}${scopeNote}`
  );
}

/**
 * Deriva a edição/rodada (`AAMMDD`) a partir dos args CLI: `--edition` tem
 * prioridade; `--run-dir` é um atalho que usa o basename do path (tolera
 * barra final). Retorna `null` se nenhum dos dois foi passado.
 */
export function resolveEditionFromArgs(values: Record<string, string>): string | null {
  if (values.edition) return values.edition;
  if (values["run-dir"]) {
    const cleaned = values["run-dir"].replace(/[\\/]+$/, "");
    const base = basename(cleaned);
    return base || null;
  }
  return null;
}

/**
 * Orquestração fail-soft: `run-log.jsonl` ausente é tratado como "0 eventos"
 * (nunca lança) — uma rodada que nunca gravou nada no log é o caso mais
 * extremo de "instrumentação não emitida", coberto pelo mesmo `warning`.
 */
export function checkOvernightTokenInstrumentation(
  edition: string,
  rootDir: string = process.cwd(),
  scope: TokenInstrumentationScope = {},
): TokenInstrumentationResult {
  const logPath = resolveRunLogPath(rootDir);
  const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [];
  const sessionId = scope.sessionId || null;
  const counts = countTokenInstrumentationEvents(lines, edition, sessionId);
  const papelBreakdown = countSubagentMetricsByPapel(lines, edition, sessionId);
  const verdict = resolveTokenInstrumentationVerdict(counts, countEmptyMarkers(lines, edition, sessionId));
  const papelLine = formatPapelBreakdown(papelBreakdown);
  const baseSection = buildTokenInstrumentationSection(edition, counts, verdict, scope);
  const section = papelLine ? `${baseSection}\n${papelLine}` : baseSection;
  return { edition, sessionId, counts, papelBreakdown, verdict, section };
}

/**
 * Resolve o filtro de sessão dos args CLI (#11164): `--session-id` explícito
 * vence; senão o `session_id` da raiz do `plan.json` de `--plan` (gravado pelo
 * overnight desde #6328 e pelo develop desde #6265). `plan.json` ausente,
 * ilegível ou sem `session_id` (legado) → sem filtro, com o motivo no texto.
 * Sem nenhum dos dois → sem filtro e sem ressalva (uso legado por edição).
 */
export function resolveSessionScopeFromArgs(
  values: Record<string, string>,
  readPlan: (path: string) => string = (p) => readFileSync(p, "utf8"),
): TokenInstrumentationScope {
  const explicit = values["session-id"]?.trim();
  if (explicit) return { sessionId: explicit };
  const planPath = values.plan;
  if (!planPath) return {};
  let plan: unknown;
  try {
    plan = JSON.parse(readPlan(planPath));
  } catch {
    return { unscopedReason: `plan.json ilegível em ${planPath}` };
  }
  const sid =
    typeof plan === "object" && plan !== null ? (plan as Record<string, unknown>).session_id : undefined;
  if (typeof sid === "string" && sid.trim()) return { sessionId: sid.trim() };
  return { unscopedReason: `plan.json sem session_id em ${planPath}` };
}

// ---------------------------------------------------------------------------
// CLI guard: só executa como main module, importável sem efeito colateral.
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const edition = resolveEditionFromArgs(values);
  if (!edition) {
    console.error(
      "[check-overnight-token-instrumentation] uso: --edition {AAMMDD} ou --run-dir {path} [--plan {plan.json} | --session-id {uuid}]",
    );
    process.exit(2);
  }
  const result = checkOvernightTokenInstrumentation(
    edition,
    resolve(process.cwd()),
    resolveSessionScopeFromArgs(values),
  );
  console.log(result.section);
  // Advisory — nunca falha a rodada; o veredito vai pro relatório, não pro exit code.
  process.exit(0);
}
