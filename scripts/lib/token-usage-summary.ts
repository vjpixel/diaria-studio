/**
 * token-usage-summary.ts (#6445)
 *
 * Agrega consumo de token por DIA e por TIPO de sessão — edição, overnight,
 * develop, continuo e "interativa avulsa" (o resto) — a partir das 3 fontes
 * que já existem hoje, cada uma isolada:
 *
 * 1. **Overnight/develop/continuo** — eventos `subagent_metrics`
 *    (`details.subagent_tokens`), `coordinator_tokens_estimate`
 *    (`details.tokens`) e `review_metrics` (`details.review_tokens`) em
 *    `data/run-log.jsonl`, filtrados por `agent` ("overnight" | "develop" |
 *    "continuo") e `edition` (o AAMMDD do dia — ver #3453/#4815, mesma
 *    convenção usada por `check-overnight-token-instrumentation.ts` e
 *    `continuo-cost-summary.ts`, generalizada aqui pros 3 agents).
 * 2. **Edição** — `tokens_in`/`tokens_out` já agregados por
 *    `capture-stage-usage.ts` em `_internal/stage-status.json` de cada
 *    edição (mesma fonte de `aggregate-costs.ts`).
 * 3. **Interativa avulsa** — não tem instrumentação própria (nenhuma skill
 *    desta categoria loga em `run-log.jsonl`). Estimada por DIFERENÇA: o
 *    total real de tokens de todas as sessões locais do dia (via
 *    `session-transcript.ts`, `usage` real da API — a fonte preferencial
 *    citada na issue) MENOS o que já foi atribuído às 4 categorias acima.
 *    Só calculável quando `~/.claude/projects/` existe (sessão local) —
 *    em sessão cloud a linha some `unavailable`, nunca `0` (mesma
 *    disciplina de `subagentTokensIn: null` em session-transcript.ts).
 *
 * **Limitação conhecida, documentada em vez de escondida:** as categorias 1
 * (run-log) não distinguem tokens_in/tokens_out nem cache_read — são um
 * total combinado estimado pelo harness (`harness_usage`) no momento em que
 * o coordenador/subagente emitiu o evento. Só a categoria "interativa" (via
 * transcript real) carrega o breakdown completo (in/out/cache_read
 * separados) porque só ela lê `usage` bruto da API. Misturar as duas
 * naturezas de número na mesma linha "total" é uma aproximação deliberada
 * — o objetivo desta issue é responder "quem comeu a janela hoje" em ordem
 * de grandeza, não um cost accounting centavo a centavo (mesmo espírito de
 * `aggregate-costs.ts`, que já mistura custo real com custo estimado
 * prefixando com "~").
 *
 * O remainder de "interativa" é clampado em 0 quando a subtração dá
 * negativo (unidades de medida diferentes entre run-log estimate e
 * transcript real podem divergir o suficiente pra isso acontecer em dias de
 * baixo volume) — nunca reportado como número negativo, que não tem
 * leitura sensata neste contexto.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { enumerateEditionDirs } from "./find-current-edition.ts";
import { editionsRoot } from "./edition-paths.ts";
import { parseStageStatusJson } from "../aggregate-costs.ts";
import { resolveRunLogPath } from "./run-log.ts";
import { collectUsageInWindow, resolveTranscriptsDir } from "./session-transcript.ts";
import { datePartsInTz, toAammdd, zonedTimeToUtc, BRT_TIMEZONE } from "./next-edition-date.ts";

export type TokenUsageKind = "edicao" | "overnight" | "develop" | "continuo" | "interativa";

/** Ordem de exibição — do mais instrumentado ao menos (edição tem tokens_in/out reais; interativa é o resto por diferença). */
export const TOKEN_USAGE_KINDS: readonly TokenUsageKind[] = [
  "edicao",
  "overnight",
  "develop",
  "continuo",
  "interativa",
];

/** Os 3 agents de run-log que este módulo sabe somar (categoria 1 do cabeçalho). */
const RUN_LOG_AGENT_KINDS: readonly Extract<TokenUsageKind, "overnight" | "develop" | "continuo">[] = [
  "overnight",
  "develop",
  "continuo",
];

export interface RunLogAgentTotals {
  /** Soma de `subagent_tokens` + `tokens` + `review_tokens` reconhecidos para este agent/dia. */
  tokens: number;
  /** Quantos eventos dos 3 tipos rastreados foram encontrados (independente de terem valor). */
  eventCount: number;
}

interface RunLogEventLine {
  agent?: string;
  edition?: string;
  message?: string;
  details?: {
    tokens?: number | null;
    subagent_tokens?: number | null;
    review_tokens?: number | null;
  };
}

/**
 * Pure: soma os 3 tipos de evento de instrumentação de token (#3453/#4815)
 * de um `agent` específico ("overnight" | "develop" | "continuo") num `day`
 * (AAMMDD) específico, a partir das linhas já lidas de `run-log.jsonl`.
 * Generaliza `sumContinuoTokenEstimates` (continuo-cost-summary.ts) pros 3
 * agents e inclui `review_metrics`, que aquele somador não cobria.
 */
export function sumRunLogAgentTokensForDay(
  lines: string[],
  agent: string,
  day: string,
): RunLogAgentTotals {
  let tokens = 0;
  let eventCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: RunLogEventLine;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.agent !== agent || event.edition !== day) continue;

    if (event.message === "subagent_metrics") {
      eventCount += 1;
      tokens += event.details?.subagent_tokens ?? 0;
    } else if (event.message === "coordinator_tokens_estimate") {
      eventCount += 1;
      tokens += event.details?.tokens ?? 0;
    } else if (event.message === "review_metrics") {
      eventCount += 1;
      tokens += event.details?.review_tokens ?? 0;
    }
  }

  return { tokens, eventCount };
}

export interface EdicaoDayTotals {
  tokensIn: number;
  tokensOut: number;
}

/**
 * Pure-ish (I/O de leitura só): soma `tokens_in`/`tokens_out` de todos os
 * stages de `_internal/stage-status.json` da edição `day`. `null` quando a
 * edição não existe ou não tem `stage-status.json` legível — distinto de
 * `{tokensIn: 0, tokensOut: 0}` (edição existe, mas sem tokens capturados).
 */
export function sumEdicaoTokensForDay(editionsDir: string, day: string): EdicaoDayTotals | null {
  const dirs = enumerateEditionDirs(editionsDir);
  const editionDir = dirs.get(day);
  if (!editionDir) return null;

  const statusPath = resolve(editionDir, "_internal/stage-status.json");
  if (!existsSync(statusPath)) return null;

  let content: string;
  try {
    content = readFileSync(statusPath, "utf8");
  } catch {
    return null;
  }
  const stages = parseStageStatusJson(content);
  if (stages.length === 0) return null;

  let tokensIn = 0;
  let tokensOut = 0;
  for (const s of stages) {
    tokensIn += s.tokensIn;
    tokensOut += s.tokensOut;
  }
  return { tokensIn, tokensOut };
}

export interface DayTranscriptTotals {
  available: boolean;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
}

/**
 * Limites `[00:00:00, 23:59:59.999]` do dia civil `day` (AAMMDD) no fuso
 * `tz` (default BRT — mesmo fuso usado por toda a pipeline pra "dia da
 * edição"), como ISO strings UTC.
 */
export function dayBoundsIso(day: string, tz: string = BRT_TIMEZONE): { startIso: string; endIso: string } {
  const m = day.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) throw new Error(`token-usage-summary: dia inválido (esperado AAMMDD): ${day}`);
  const [, yy, mm, dd] = m;
  const year = 2000 + Number(yy);
  const month = Number(mm);
  const dayOfMonth = Number(dd);
  const start = zonedTimeToUtc(year, month, dayOfMonth, 0, 0, 0, tz);
  const end = zonedTimeToUtc(year, month, dayOfMonth, 23, 59, 59, tz);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/**
 * Soma o `usage` real (via `session-transcript.ts`) de TODAS as sessões
 * locais (`all_sessions` — nenhum `sessionId` passado) cujos turnos caem no
 * dia civil `day`. `available: false` quando `~/.claude/projects/{...}` não
 * existe (sessão cloud/worktree efêmero) — nunca confundir com "0 tokens".
 */
export function sumLocalTranscriptTotalsForDay(
  transcriptsDir: string,
  day: string,
): DayTranscriptTotals {
  if (!existsSync(transcriptsDir)) {
    return { available: false, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 };
  }
  const { startIso, endIso } = dayBoundsIso(day);
  const window = collectUsageInWindow(transcriptsDir, startIso, endIso, {});
  const cacheReadTokens = window.entries.reduce((acc, e) => acc + e.cacheReadInputTokens, 0);
  return {
    available: true,
    tokensIn: window.tokensIn,
    tokensOut: window.tokensOut,
    cacheReadTokens,
  };
}

export interface KindDayTotals {
  kind: TokenUsageKind;
  /** `false` quando esta categoria não tem NENHUM dado pro dia (nunca rodou) — distinto de `total: 0` com dado presente. */
  hasData: boolean;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
  /** Total combinado — sempre computável, é o que soma pro total do dia e decide o alarme. */
  total: number;
}

export interface DayTotals {
  day: string;
  kinds: KindDayTotals[];
  total: number;
  dominantKind: TokenUsageKind | null;
  /** 0..1 — fração do total do dia que o `dominantKind` consumiu. `0` quando `total === 0`. */
  dominantShare: number;
  /** `true` quando `dominantShare > thresholdPct/100`. */
  alarm: boolean;
}

export interface TokenUsageSummaryOptions {
  /** Percentual (0-100) acima do qual um kind dominante dispara alarme no dia. Default 50. */
  thresholdPct?: number;
  /** Override do diretório de edições (teste). */
  editionsDir?: string;
  /** Override do path de run-log.jsonl (teste). */
  runLogPath?: string;
  /** Override do diretório de transcripts locais (teste). */
  transcriptsDir?: string;
}

const DEFAULT_THRESHOLD_PCT = 50;

/**
 * Núcleo puro (I/O só de leitura, injetável): computa `DayTotals` pra um
 * único dia. Separado de `computeTokenUsageSummary` pra ser testável célula
 * a célula sem montar uma janela de N dias inteira.
 */
export function computeDayTotals(
  day: string,
  runLogLines: string[],
  editionsDir: string,
  transcriptsDir: string,
  thresholdPct: number = DEFAULT_THRESHOLD_PCT,
): DayTotals {
  const kinds: KindDayTotals[] = [];

  const edicao = sumEdicaoTokensForDay(editionsDir, day);
  kinds.push({
    kind: "edicao",
    hasData: edicao !== null,
    tokensIn: edicao?.tokensIn ?? null,
    tokensOut: edicao?.tokensOut ?? null,
    cacheReadTokens: null, // não tracked separadamente em stage-status.json — ver docstring do módulo
    total: (edicao?.tokensIn ?? 0) + (edicao?.tokensOut ?? 0),
  });

  const runLogTotals: Record<string, RunLogAgentTotals> = {};
  for (const agent of RUN_LOG_AGENT_KINDS) {
    const totals = sumRunLogAgentTokensForDay(runLogLines, agent, day);
    runLogTotals[agent] = totals;
    kinds.push({
      kind: agent,
      hasData: totals.eventCount > 0,
      tokensIn: null,
      tokensOut: null,
      cacheReadTokens: null,
      total: totals.tokens,
    });
  }

  const transcriptTotals = sumLocalTranscriptTotalsForDay(transcriptsDir, day);
  const attributedTotal =
    kinds.reduce((acc, k) => acc + k.total, 0); // edicao + overnight + develop + continuo já empilhados

  if (transcriptTotals.available) {
    const allSessionsTotal = transcriptTotals.tokensIn + transcriptTotals.tokensOut;
    const remainder = Math.max(0, allSessionsTotal - attributedTotal);
    kinds.push({
      kind: "interativa",
      hasData: true,
      tokensIn: null,
      tokensOut: null,
      cacheReadTokens: transcriptTotals.cacheReadTokens,
      total: remainder,
    });
  } else {
    kinds.push({
      kind: "interativa",
      hasData: false,
      tokensIn: null,
      tokensOut: null,
      cacheReadTokens: null,
      total: 0,
    });
  }

  const total = kinds.reduce((acc, k) => acc + k.total, 0);
  let dominantKind: TokenUsageKind | null = null;
  let dominantTotal = 0;
  for (const k of kinds) {
    if (k.total > dominantTotal) {
      dominantTotal = k.total;
      dominantKind = k.kind;
    }
  }
  const dominantShare = total > 0 ? dominantTotal / total : 0;
  const alarm = total > 0 && dominantShare > thresholdPct / 100;

  return { day, kinds, total, dominantKind, dominantShare, alarm };
}

/**
 * `n` dias civis (BRT) terminando em `now` (inclusive), ordem ascendente.
 * Ex: `lastNDaysAammdd(3, new Date("2026-08-28T12:00:00-03:00"))` →
 * `["260826", "260827", "260828"]`.
 */
export function lastNDaysAammdd(n: number, now: Date = new Date(), tz: string = BRT_TIMEZONE): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    days.push(toAammdd(datePartsInTz(d, tz)));
  }
  return days;
}

export interface TokenUsageSummaryResult {
  days: DayTotals[]; // ascendente
  thresholdPct: number;
  generatedAt: string;
}

/**
 * Orquestração fail-soft: `run-log.jsonl` ausente → linhas vazias (todo
 * kind de run-log sai 0/hasData:false); `data/editions/` ausente → toda
 * edição sai `hasData:false`; `~/.claude/projects/` ausente → "interativa"
 * sai `hasData:false` (`unavailable`, nunca `0`). Nunca lança.
 */
export function computeTokenUsageSummary(
  rootDir: string = process.cwd(),
  days: number = 14,
  opts: TokenUsageSummaryOptions = {},
  now: Date = new Date(),
): TokenUsageSummaryResult {
  const thresholdPct = opts.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const editionsDir = opts.editionsDir ?? resolve(rootDir, editionsRoot());
  const runLogPath = opts.runLogPath ?? resolveRunLogPath(rootDir);
  const transcriptsDir = opts.transcriptsDir ?? resolveTranscriptsDir(rootDir);

  const lines = existsSync(runLogPath) ? readFileSync(runLogPath, "utf8").split("\n") : [];
  const dayList = lastNDaysAammdd(days, now);

  return {
    days: dayList.map((day) => computeDayTotals(day, lines, editionsDir, transcriptsDir, thresholdPct)),
    thresholdPct,
    generatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Formatação markdown (consumida pelo CLI + pelo relatório do Studio)
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<TokenUsageKind, string> = {
  edicao: "Edição",
  overnight: "Overnight",
  develop: "Develop",
  continuo: "Contínuo",
  interativa: "Interativa avulsa",
};

function fmtTokens(n: number): string {
  if (!n) return "-";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtPct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * Texto markdown pronto pra colar num relatório/Studio — tabela por dia +
 * kind, seção de alarmes (kinds que passaram do threshold em algum dia).
 * Dias sem NENHUM dado em nenhum kind (`total === 0` e todo `hasData:
 * false`) ainda aparecem na tabela — omitir dia silenciosamente esconderia
 * "não rodou nada hoje", que é informação, não ruído.
 */
export function formatTokenUsageSummary(result: TokenUsageSummaryResult): string {
  const lines: string[] = [
    `# Monitoramento de tokens por tipo de sessão`,
    ``,
    `Gerado em ${result.generatedAt}. Últimos ${result.days.length} dia(s), alarme em > ${result.thresholdPct}% do total do dia.`,
    ``,
    `| Dia | ${TOKEN_USAGE_KINDS.map((k) => KIND_LABELS[k]).join(" | ")} | Total | Dominante |`,
    `|---|${TOKEN_USAGE_KINDS.map(() => "---:").join("|")}|---:|---|`,
  ];

  for (const day of result.days) {
    const byKind = new Map(day.kinds.map((k) => [k.kind, k]));
    const cells = TOKEN_USAGE_KINDS.map((k) => {
      const cell = byKind.get(k);
      if (!cell) return "-";
      if (!cell.hasData && cell.total === 0) return "-";
      return fmtTokens(cell.total);
    });
    const dominant = day.dominantKind
      ? `${KIND_LABELS[day.dominantKind]} (${fmtPct(day.dominantShare)})${day.alarm ? " ⚠" : ""}`
      : "-";
    lines.push(`| ${day.day} | ${cells.join(" | ")} | ${fmtTokens(day.total)} | ${dominant} |`);
  }

  const interativaRows = result.days
    .map((d) => d.kinds.find((k) => k.kind === "interativa"))
    .filter((k): k is KindDayTotals => k != null && k.cacheReadTokens != null && k.cacheReadTokens > 0);
  if (interativaRows.length > 0) {
    lines.push(``, `## cache_read (fatia dominante, só medida na "Interativa avulsa")`, ``);
    lines.push(`| Dia | cache_read |`, `|---|---:|`);
    for (const day of result.days) {
      const k = day.kinds.find((kk) => kk.kind === "interativa");
      if (!k || k.cacheReadTokens == null) continue;
      lines.push(`| ${day.day} | ${fmtTokens(k.cacheReadTokens)} |`);
    }
  }

  const alarms = result.days.filter((d) => d.alarm);
  lines.push(``, `## Alarmes`, ``);
  if (alarms.length === 0) {
    lines.push(`_Nenhum dia passou de ${result.thresholdPct}% de concentração num único tipo de sessão._`);
  } else {
    for (const d of alarms) {
      lines.push(
        `- AVISO: ${d.day} — **${d.dominantKind ? KIND_LABELS[d.dominantKind] : "?"}** consumiu ${fmtPct(d.dominantShare)} do total do dia (${fmtTokens(d.total)} tokens).`,
      );
    }
  }

  lines.push(
    ``,
    `---`,
    `_"Interativa avulsa" é estimada por diferença (usage real de todas as sessões locais menos o que já foi atribuído a edição/overnight/develop/continuo via run-log) — aproximação, não medição direta; \`unavailable\`/"-" quando não há transcripts locais (sessão cloud). Tokens de overnight/develop/continuo vêm de estimativa do harness registrada em \`data/run-log.jsonl\` (#3453/#4815), sem breakdown in/out/cache_read. cache_read só aparece na linha "Interativa avulsa" — é a única fonte com \`usage\` real granular._`,
  );

  return lines.join("\n");
}
