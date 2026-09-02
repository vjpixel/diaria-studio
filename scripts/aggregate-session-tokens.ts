#!/usr/bin/env npx tsx
/**
 * aggregate-session-tokens.ts (#6445)
 *
 * Visão consolidada de consumo de token/custo por TIPO DE SESSÃO
 * (edicao/overnight/develop/continuo), que hoje exige abrir 3 fontes
 * separadas com 3 formatos diferentes:
 *
 * 1. **Edição** — `scripts/aggregate-costs.ts` lê `_internal/stage-status.json`
 *    de cada `data/editions/{AAMMDD}/` (tokens REAIS via transcript local,
 *    #3441). É a única fonte com split `tokens_in`/`tokens_out` e `$` por
 *    modelo.
 * 2. **Overnight/develop** — eventos `subagent_metrics` (implementação),
 *    `coordinator_tokens_estimate` (coordenador) e `review_metrics`/
 *    `fleet_review_metrics` (review pós-rodada/pré-merge) em
 *    `data/run-log.jsonl`, `agent: "overnight" | "develop"` (#3453/#4815).
 *    Só total de tokens: o harness reporta um total por invocação de
 *    `Agent()`, sem split in/out.
 * 3. **Continuo** — os MESMOS 2 eventos que overnight/develop (coordenador +
 *    implementação; sem review — `/diaria-continuo` não tem Fase 1.5 própria),
 *    `agent: "continuo"`, um dia por rotação (`data/continuo/{AAMMDD}/`).
 *
 * A "edição" do campo `edition` em eventos overnight/develop/continuo é o
 * **dia da rodada** (`data/overnight/{AAMMDD}/`, não necessariamente a
 * edição editorial publicada nesse dia) — mesma convenção que
 * `continuo-cost-summary.ts` já assume; este script segue o padrão em vez
 * de reabrir a distinção.
 *
 * **A coluna "Dia" é um DIA DE CALENDÁRIO, não um id de rodada (#6638).**
 * Várias rodadas do mesmo dia recebem sufixo de rotação (`260814`, `260814b`,
 * `260814c` — até `260828g` observado ao vivo), e até o #6638 cada sufixo
 * virava uma LINHA própria da tabela: o painel dizia "dia" e mostrava
 * rodada. `roundDayFromEdition` normaliza o sufixo antes de agregar, de modo
 * que 1 linha = 1 (kind, dia civil), com a contagem de rodadas preservada em
 * `rounds`. Isso também conserta a janela `--since/--until`, que comparava
 * strings: `"260814c" > "260814"` fazia `--until 260814` DESCARTAR as rodadas
 * b e c daquele mesmo dia.
 *
 * `source: "unavailable"` (harness não expôs tokens por invocação, ou
 * coordenador esqueceu o checkpoint) NUNCA é somado como zero — os eventos
 * caem em `unavailableCount` por kind/categoria, sempre reportado ao lado
 * do total, para nunca confundir "consumiu 0" com "não foi possível medir".
 *
 * Uso:
 *   npx tsx scripts/aggregate-session-tokens.ts
 *   npx tsx scripts/aggregate-session-tokens.ts --since 260801 --until 260828
 *   npx tsx scripts/aggregate-session-tokens.ts --json
 *   npx tsx scripts/aggregate-session-tokens.ts --out data/session-tokens-summary.md
 *   npx tsx scripts/aggregate-session-tokens.ts --alarm-pct 40
 *
 * `--alarm-pct N` (default 50): se um kind consumir mais de N% do total do
 * dia, o relatório imprime uma linha de warning para aquele dia (#6445 item
 * 3 — "sem bloquear nada", puramente informativo).
 *
 * @see scripts/aggregate-costs.ts (fonte "edicao")
 * @see scripts/continuo-cost-summary.ts (mesma extração de evento pro kind continuo isolado)
 * @see scripts/check-overnight-token-instrumentation.ts (presença, não soma)
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveRunLogPath } from "./lib/run-log.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { aggregateCosts } from "./aggregate-costs.ts";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type SessionKind = "edicao" | "overnight" | "develop" | "continuo";

export const SESSION_LOG_KINDS: readonly Exclude<SessionKind, "edicao">[] = [
  "overnight",
  "develop",
  "continuo",
] as const;

/** Categorias de gasto dentro de uma rodada overnight/develop/continuo (#4815). */
export type TokenCategory = "coordinator" | "implementation" | "review";

interface RunLogLine {
  agent?: string;
  edition?: string;
  message?: string;
  details?: {
    tokens?: number | null;
    subagent_tokens?: number | null;
    review_tokens?: number | null;
    fleet_tokens?: number | null;
    source?: string;
  };
}

/** Mapa mensagem de run-log → categoria + qual campo de `details` carrega o valor. */
const MESSAGE_TO_CATEGORY: Record<string, { category: TokenCategory; field: keyof NonNullable<RunLogLine["details"]> }> = {
  coordinator_tokens_estimate: { category: "coordinator", field: "tokens" },
  subagent_metrics: { category: "implementation", field: "subagent_tokens" },
  review_metrics: { category: "review", field: "review_tokens" },
  fleet_review_metrics: { category: "review", field: "fleet_tokens" },
};

export interface CategoryTotals {
  tokens: number;
  eventCount: number;
  unavailableCount: number;
}

function emptyCategoryTotals(): CategoryTotals {
  return { tokens: 0, eventCount: 0, unavailableCount: 0 };
}

export interface KindDayTotals {
  kind: SessionKind;
  /** Dia CIVIL `AAMMDD` — sufixo de rodada já normalizado (#6638). */
  day: string;
  /**
   * Ids de origem que caíram neste dia, ordenados (`["260814", "260814b"]`).
   * A normalização do dia funde rodadas; sem isto a informação "foram 3
   * rodadas de overnight nesse dia" sumiria da tabela. 1 elemento é o caso
   * normal (inclusive toda linha de `edicao`).
   *
   * **São as rodadas que CONTRIBUÍRAM dado, não as que rodaram**: rodada que
   * não emitiu nenhum dos 4 eventos de custo não aparece aqui (é justamente
   * o buraco do #6634 — instrumentação que depende do coordenador lembrar).
   * Ler `×3` como "3 rodadas naquele dia" subestima quando alguma ficou muda.
   */
  rounds: string[];
  /**
   * Rodadas que deixaram diretório em `data/{kind}/{AAMMDD}/` (ou
   * `data/continuo/{AAMMDD}/`) mas NÃO emitiram nenhum evento de custo no
   * run-log — o "invisible rounds" do #6634. Descobertas via filesystem scan
   * em `discoverSessionRounds` (#6634 Direction 2), então só populado para
   * `kind ∈ {overnight, develop, continuo}` (edições usam stage-status.json,
   * não run-log).
   *
   * Só aparece na saída do dashboard quando não-vazio; não afeta o total de
   * tokens (não há dado pra somar) mas revela o vazio invisível.
   */
  uninstrumentedRounds?: string[];
  totalTokens: number;
  /** Split in/out — só populado para `kind: "edicao"` (única fonte com dado real). */
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  costEstimated?: boolean;
  /** Categorias coordinator/implementation/review — vazio para `kind: "edicao"`. */
  categories: Partial<Record<TokenCategory, CategoryTotals>>;
}

export interface SessionTokensSummary {
  generatedAt: string;
  since: string | null;
  until: string | null;
  alarmPct: number;
  /** Uma entrada por (kind, day) que teve QUALQUER dado. */
  rows: KindDayTotals[];
  /** Dias com pelo menos 1 kind excedendo `alarmPct` do total do dia. */
  alarms: { day: string; kind: SessionKind; pct: number }[];
}

// ---------------------------------------------------------------------------
// Dia civil vs id de rodada (#6638)
// ---------------------------------------------------------------------------

/** `AAMMDD` seguido do sufixo de rotação da N-ésima rodada do dia (`b`, `c`, ...). */
const ROUND_ID_RE = /^(\d{6})[a-z]+$/;

/**
 * Pura: dia civil `AAMMDD` de um id de rodada/edição.
 *
 * `"260814c"` → `"260814"`; `"260814"` → `"260814"`.
 *
 * **Devolve a entrada intacta quando ela não casa com o formato** — vale para
 * ids que não são rodadas (`"replay-scorer-a"`, `"2604"` e outros diretórios
 * que convivem em `data/editions/`), que devem continuar sendo sua própria
 * linha em vez de colapsar em algo que não são. Silenciosamente inventar um
 * dia para eles seria pior que mostrá-los como estão.
 */
export function roundDayFromEdition(edition: string): string {
  const m = ROUND_ID_RE.exec(edition);
  return m ? m[1] : edition;
}

// ---------------------------------------------------------------------------
// Extração de run-log.jsonl (overnight/develop/continuo)
// ---------------------------------------------------------------------------

/**
 * Pure: agrega as linhas já lidas de `run-log.jsonl` em `KindDayTotals[]`,
 * uma entrada por (kind, dia civil) — rodadas do mesmo dia somam na mesma
 * entrada (#6638). Linhas malformadas ou de agent/message fora do escopo são
 * ignoradas silenciosamente (mesmo padrão de
 * `countTokenInstrumentationEvents`/`sumContinuoTokenEstimates`).
 */
export function aggregateRunLogByKindAndDay(
  lines: string[],
  opts: { since?: string; until?: string } = {},
): KindDayTotals[] {
  const byKey = new Map<string, KindDayTotals>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: RunLogLine;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const kind = event.agent as SessionKind | undefined;
    if (!kind || !(SESSION_LOG_KINDS as readonly string[]).includes(kind)) continue;
    const roundId = event.edition;
    if (!roundId) continue;
    // Filtra pelo dia CIVIL, nunca pelo id bruto: com `260814c` a comparação
    // de string excluía a rodada de um `--until 260814` (#6638).
    const day = roundDayFromEdition(roundId);
    if (opts.since && day < opts.since) continue;
    if (opts.until && day > opts.until) continue;
    const mapping = event.message ? MESSAGE_TO_CATEGORY[event.message] : undefined;
    if (!mapping) continue;

    const key = `${kind}|${day}`;
    let row = byKey.get(key);
    if (!row) {
      row = { kind, day, rounds: [], totalTokens: 0, categories: {} };
      byKey.set(key, row);
    }
    if (!row.rounds.includes(roundId)) {
      row.rounds.push(roundId);
      row.rounds.sort();
    }
    let cat = row.categories[mapping.category];
    if (!cat) {
      cat = emptyCategoryTotals();
      row.categories[mapping.category] = cat;
    }
    cat.eventCount += 1;

    const raw = event.details?.[mapping.field];
    if (raw === null || raw === undefined) {
      cat.unavailableCount += 1;
      continue;
    }
    const tokens = Number(raw);
    if (!Number.isFinite(tokens)) {
      cat.unavailableCount += 1;
      continue;
    }
    cat.tokens += tokens;
    row.totalTokens += tokens;
  }

  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Descoberta de rodadas via filesystem (#6634 Direction 2 — "invisible rounds")
// ---------------------------------------------------------------------------

/** Regex para nomes de diretório de rodada — AAMMDD + sufixo opcional de
 * letra única (b, c, ... até g observado ao vivo, 260828g). NÃO `backup`
 * (1 letra só; evita matching de dirs como `260814backup` ou `260814replica`). */
const ROUND_DIR_RE = /^\d{6}[a-z]?$/;

/**
 * Pure: lista ids de rodada de um kind a partir das ENTRADAS DO FILESYSTEM já
 * lidas (não toca disco). Filtera nomes que casam com `^\d{6}[a-z]*$` e
 * têm `plan.json`. Retorna ordenado cronologicamente (lexicográfico = cronológico
 * em AAMMDD).
 *
 * Separado da filesystem I/O (`discoverSessionRounds`) pra ser testável sem tmpdir.
 */
export function filterRoundDirs(
  entries: { name: string; hasPlan: boolean }[],
): string[] {
  return entries
    .filter((e) => ROUND_DIR_RE.test(e.name) && e.hasPlan)
    .map((e) => e.name)
    .sort();
}

/**
 * Lista todos os ids de rodada (AAMMDD ou AAMMDD+suffix) descobertos via
 * filesystem scan de `data/{kind}/` — para `overnight` e `develop` — e
 * `data/continuo/` — para `continuo`. Só inclui diretórios com `plan.json`
 * (confirma que foi de fato uma rodada, não um tempdir).
 *
 * Fail-soft: se `data/{kind}/` não existe ou não é legível, retorna `[]`.
 */
export function discoverSessionRounds(
  rootDir: string,
  kind: Exclude<SessionKind, "edicao">,
): string[] {
  const kindDir =
    kind === "continuo"
      ? join(rootDir, "data", "continuo")
      : join(rootDir, "data", kind);

  if (!existsSync(kindDir)) return [];

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = readdirSync(kindDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const roundEntries = entries
    .filter((e) => e.isDirectory() && ROUND_DIR_RE.test(e.name))
    .map((e) => ({
      name: e.name,
      hasPlan: existsSync(join(kindDir, e.name, "plan.json")),
    }));

  return filterRoundDirs(roundEntries);
}

/**
 * Pura: dadas as rodadas descobertas no filesystem e as que CONTRIBUÍRAM evento
 * no run-log, retorna apenas as que não emitiram nada (invisíveis).
 *
 * Compara no nível de `day` (dia civil): uma rodada como `260814b` cujo dia
 * `260814` já tem eventos de `260814`/`260814c` no run-log é tratada como
 * instrumentada (o dia recebeu dado). Só são "uninstrumented" as rodadas cujo
 * DIA não aparece em NENHUM evento do run-log — é o que realmente ficou mudo.
 */
export function findUninstrumentedRounds(
  discoveredRoundIds: string[],
  instrumentedDays: string[],
): string[] {
  const instrumentedDaySet = new Set(instrumentedDays);
  return discoveredRoundIds.filter((roundId) => {
    const day = roundDayFromEdition(roundId);
    return !instrumentedDaySet.has(day);
  });
}

// ---------------------------------------------------------------------------
// Fonte "edicao" (aggregate-costs.ts)
// ---------------------------------------------------------------------------

/**
 * Converte `EditionCost[]` (schema de `aggregate-costs.ts`) em `KindDayTotals[]`
 * do kind `"edicao"` — 1 linha por edição, somando todos os stages.
 */
export function editionCostsToKindDayTotals(
  editions: { edition: string; totals: { durationMs: number; costUsd: number; costEstimated: boolean; tokensIn: number; tokensOut: number } }[],
): KindDayTotals[] {
  return editions.map((e) => ({
    kind: "edicao" as const,
    day: roundDayFromEdition(e.edition),
    rounds: [e.edition],
    totalTokens: e.totals.tokensIn + e.totals.tokensOut,
    tokensIn: e.totals.tokensIn,
    tokensOut: e.totals.tokensOut,
    costUsd: e.totals.costUsd,
    costEstimated: e.totals.costEstimated,
    categories: {},
  }));
}

// ---------------------------------------------------------------------------
// Fusão por (kind, dia civil) (#6638)
// ---------------------------------------------------------------------------

/**
 * Pura: garante o invariante "1 linha = 1 (kind, dia civil)" sobre a UNIÃO das
 * duas fontes, somando o que colidir.
 *
 * `aggregateRunLogByKindAndDay` já funde dentro do run-log pela chave do seu
 * `Map`; esta função existe para que o invariante valha por construção sobre
 * o conjunto final — hoje só alcança edições (nenhum diretório
 * `data/editions/` usa sufixo de rodada, então na prática é no-op ali), e
 * passa a valer sozinha no dia em que uma passar a usar.
 */
export function mergeKindDayTotals(rows: KindDayTotals[]): KindDayTotals[] {
  const byKey = new Map<string, KindDayTotals>();
  for (const row of rows) {
    const key = `${row.kind}|${row.day}`;
    const acc = byKey.get(key);
    if (!acc) {
      // Cópia PROFUNDA das categorias: `{ ...row.categories }` copiaria só o
      // objeto externo, deixando cada `CategoryTotals` compartilhado com a
      // entrada — e o `+=` do ramo de fusão abaixo mutaria a linha original.
      const categories: KindDayTotals["categories"] = {};
      for (const [name, cat] of Object.entries(row.categories) as [TokenCategory, CategoryTotals][]) {
        categories[name] = { ...cat };
      }
      byKey.set(key, { ...row, rounds: [...row.rounds], categories });
      continue;
    }
    acc.totalTokens += row.totalTokens;
    for (const id of row.rounds) if (!acc.rounds.includes(id)) acc.rounds.push(id);
    acc.rounds.sort();
    if (row.tokensIn !== undefined) acc.tokensIn = (acc.tokensIn ?? 0) + row.tokensIn;
    if (row.tokensOut !== undefined) acc.tokensOut = (acc.tokensOut ?? 0) + row.tokensOut;
    if (row.costUsd !== undefined) acc.costUsd = (acc.costUsd ?? 0) + row.costUsd;
    // Custo do dia é estimado se QUALQUER parcela dele for — nunca apresentar
    // como medido um total que carrega estimativa dentro.
    if (row.costEstimated) acc.costEstimated = true;
    for (const [name, cat] of Object.entries(row.categories) as [TokenCategory, CategoryTotals][]) {
      const target = acc.categories[name] ?? (acc.categories[name] = emptyCategoryTotals());
      target.tokens += cat.tokens;
      target.eventCount += cat.eventCount;
      target.unavailableCount += cat.unavailableCount;
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Alarmes (#6445 item 3)
// ---------------------------------------------------------------------------

/**
 * Pure: para cada dia com ≥2 kinds e total > 0, sinaliza os kinds cuja
 * fatia excede `alarmPct` do total do dia. Nunca bloqueia nada — puramente
 * informativo, consumido pelo relatório e (opcionalmente) pelo Studio.
 */
export function computeAlarms(rows: KindDayTotals[], alarmPct: number): { day: string; kind: SessionKind; pct: number }[] {
  const byDay = new Map<string, KindDayTotals[]>();
  for (const row of rows) {
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    byDay.get(row.day)!.push(row);
  }

  const alarms: { day: string; kind: SessionKind; pct: number }[] = [];
  for (const [day, dayRows] of byDay) {
    // Um único kind no dia sempre "consome" 100% por definição — não há
    // nada pra comparar, então não é sinal de desequilíbrio (ver docstring).
    if (dayRows.length < 2) continue;
    const dayTotal = dayRows.reduce((acc, r) => acc + r.totalTokens, 0);
    if (dayTotal <= 0) continue;
    for (const row of dayRows) {
      const pct = (row.totalTokens / dayTotal) * 100;
      if (pct > alarmPct) alarms.push({ day, kind: row.kind, pct });
    }
  }
  alarms.sort((a, b) => a.day.localeCompare(b.day) || b.pct - a.pct);
  return alarms;
}

// ---------------------------------------------------------------------------
// Janela default (#6445 item 2 — "últimos 14 dias" no painel do Studio)
// ---------------------------------------------------------------------------

/**
 * Pura: `AAMMDD` de `days` dias atrás de `now`, no calendário civil UTC (não
 * BRT — a mesma imprecisão de fuso de ±3h que já existe em todo o resto
 * deste script, que agrega por `edition`/`day` como string, nunca timestamp
 * exato; irrelevante para uma janela de 14 dias). Usada como default do
 * `since` do painel `/painel/tokens` do Studio (#6445) quando nenhum
 * `--since` explícito é passado — o CLI standalone (`main()` abaixo)
 * continua sem limitar por padrão, comportamento inalterado.
 */
export function defaultSinceAammdd(now: Date, days: number): string {
  const past = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const yy = String(past.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(past.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(past.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

export interface BuildSummaryOptions {
  rootDir: string;
  since?: string;
  until?: string;
  alarmPct?: number;
}

export function buildSessionTokensSummary(opts: BuildSummaryOptions, now: Date = new Date()): SessionTokensSummary {
  const { rootDir, since, until, alarmPct = 50 } = opts;

  const logPath = resolveRunLogPath(rootDir);
  const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [];
  const logRows = aggregateRunLogByKindAndDay(lines, { since, until });

  const editionsDir = resolve(rootDir, editionsRoot());
  const editions = aggregateCosts({ editionsDir, since, until });
  const editionRows = editionCostsToKindDayTotals(editions);

  const rows = mergeKindDayTotals([...editionRows, ...logRows]).sort(
    (a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind),
  );

  // #6634 Direction 2: filesystem scan pra detectar rodadas que deixaram
  // diretório mas não emitiram eventos no run-log (invisible rounds).
  // Só para kinds de sessão autônoma (overnight/develop/continuo) —
  // edições usam stage-status.json, não run-log.
  //
  // Dois casos:
  //  (a) Dia INSTRUMENTADO (tem eventos no run-log) — marca rodadas que deixaram
  //      dir mas não emitiram (ex: 260814b quando 260814/260814c emitiram).
  //  (b) Dia NÃO instrumentado (nenhum evento) — cria linha placeholder com
  //      todas as rodadas do dia marcadas como uninstrumented.
  const instrumentedDaysByKind = new Map<SessionKind, Set<string>>();
  for (const row of logRows) {
    if (row.kind === "edicao") continue;
    if (!instrumentedDaysByKind.has(row.kind)) {
      instrumentedDaysByKind.set(row.kind, new Set());
    }
    for (const roundId of row.rounds) {
      instrumentedDaysByKind.get(row.kind)!.add(roundDayFromEdition(roundId));
    }
  }

  for (const kind of SESSION_LOG_KINDS) {
    const instrumentedDays = instrumentedDaysByKind.get(kind);
    const discovered = discoverSessionRounds(rootDir, kind);
    // Agrupa discovered por dia CIVIL → 1 pass pra inserir + 1 pass pra anotar
    const daysSet = new Set<string>();
    for (const roundId of discovered) {
      const day = roundDayFromEdition(roundId);
      if (opts.since && day < opts.since) continue;
      if (opts.until && day > opts.until) continue;
      daysSet.add(day);
    }

    for (const day of [...daysSet].sort()) {
      const dayRounds = discovered.filter((r) => roundDayFromEdition(r) === day);
      const existingRow = rows.find((r) => r.kind === kind && r.day === day);

      if (!existingRow) {
        // (b) Dia não instrumentado — cria linha placeholder
        rows.push({
          kind,
          day,
          rounds: [],
          uninstrumentedRounds: [...dayRounds],
          totalTokens: 0,
          categories: {},
        });
      } else {
        // (a) Dia instrumentado — marca rodadas descobertas que não emitiram
        // evento (round IDs não em existingRow.rounds)
        const eventRoundSet = new Set(existingRow.rounds);
        const uninstrumented = dayRounds.filter((r) => !eventRoundSet.has(r));
        if (uninstrumented.length > 0) {
          existingRow.uninstrumentedRounds = uninstrumented;
        }
      }
    }
  }

  // Re-ordena após inserir novas linhas
  rows.sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind));

  const alarms = computeAlarms(rows, alarmPct);

  return {
    generatedAt: now.toISOString(),
    since: since ?? null,
    until: until ?? null,
    alarmPct,
    rows,
    alarms,
  };
}

// ---------------------------------------------------------------------------
// Formatação (markdown)
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (!n) return "-";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(usd: number | undefined, estimated: boolean | undefined): string {
  if (!usd) return "-";
  const val = usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
  return estimated ? `~$${val}` : `$${val}`;
}

const KIND_LABEL: Record<SessionKind, string> = {
  edicao: "Edição",
  overnight: "Overnight",
  develop: "Develop",
  continuo: "Contínuo",
};

function formatByDayTable(rows: KindDayTotals[]): string {
  if (rows.length === 0) return "_Sem dados._";
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const lines = [
    "| Dia | Kind | Tokens (total) | Custo | Coord. | Impl. | Review |",
    "|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const day of days) {
    for (const row of rows.filter((r) => r.day === day).sort((a, b) => a.kind.localeCompare(b.kind))) {
      const coord = row.categories.coordinator;
      const impl = row.categories.implementation;
      const review = row.categories.review;
      const coordStr = coord ? `${fmtTokens(coord.tokens)}${coord.unavailableCount ? ` (${coord.unavailableCount} n/d)` : ""}` : "-";
      const implStr = impl ? `${fmtTokens(impl.tokens)}${impl.unavailableCount ? ` (${impl.unavailableCount} n/d)` : ""}` : "-";
      const reviewStr = review ? `${fmtTokens(review.tokens)}${review.unavailableCount ? ` (${review.unavailableCount} n/d)` : ""}` : "-";
      // `×N` = N rodadas do mesmo dia somadas nesta linha (#6638). Sem isso a
      // fusão apagaria a diferença entre um dia de 1 rodada e um de 7.
      const baseKindStr = row.rounds.length > 1 ? `${KIND_LABEL[row.kind]} ×${row.rounds.length}` : KIND_LABEL[row.kind];
      // #6634: rodadas com diretório mas sem eventos no run-log (invisible rounds).
      // Aparecem como nota ao lado do kind — não altera a contagem de ×N, só
      // sinaliza o vazio que não foi instrumentado.
      const kindStr = row.uninstrumentedRounds && row.uninstrumentedRounds.length > 0
        ? `${baseKindStr} ⚠ ${row.uninstrumentedRounds.length} rodada(s) sem evento`
        : baseKindStr;
      lines.push(
        `| ${day} | ${kindStr} | ${fmtTokens(row.totalTokens)} | ${fmtCost(row.costUsd, row.costEstimated)} | ${coordStr} | ${implStr} | ${reviewStr} |`,
      );
    }
  }
  return lines.join("\n");
}

function formatByKindTotals(rows: KindDayTotals[]): string {
  const byKind = new Map<SessionKind, number>();
  for (const row of rows) {
    byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + row.totalTokens);
  }
  if (byKind.size === 0) return "_Sem dados._";
  const grandTotal = [...byKind.values()].reduce((a, b) => a + b, 0);
  const lines = ["| Kind | Tokens (total) | % do total |", "|---|---:|---:|"];
  const kindOrder: SessionKind[] = ["edicao", ...SESSION_LOG_KINDS];
  for (const kind of kindOrder) {
    const tokens = byKind.get(kind);
    if (tokens === undefined) continue;
    const pct = grandTotal > 0 ? ((tokens / grandTotal) * 100).toFixed(1) : "0.0";
    lines.push(`| ${KIND_LABEL[kind]} | ${fmtTokens(tokens)} | ${pct}% |`);
  }
  return lines.join("\n");
}

function formatAlarms(alarms: SessionTokensSummary["alarms"], alarmPct: number): string {
  if (alarms.length === 0) return `_Nenhum kind excedeu ${alarmPct}% do total de um dia no período._`;
  return alarms
    .map((a) => `- **${a.day}**: ${KIND_LABEL[a.kind]} consumiu ${a.pct.toFixed(1)}% do total do dia (limiar: ${alarmPct}%).`)
    .join("\n");
}

export function formatSessionTokensSummary(summary: SessionTokensSummary): string {
  return `# Token Usage Summary — sessões diar.ia.br (#6445)

Gerado em ${summary.generatedAt}
Período: ${summary.since ?? "início"} a ${summary.until ?? "hoje"}

## Totais por tipo de sessão

${formatByKindTotals(summary.rows)}

## Alarmes (kind > ${summary.alarmPct}% do total do dia)

${formatAlarms(summary.alarms, summary.alarmPct)}

## Detalhe por dia e kind

${formatByDayTable(summary.rows)}

---
_Fontes: \`_internal/stage-status.json\` por edição (kind "Edição", via \`aggregate-costs.ts\`) + \`data/run-log.jsonl\` eventos \`subagent_metrics\`/\`coordinator_tokens_estimate\`/\`review_metrics\`/\`fleet_review_metrics\` filtrados por \`agent ∈ {overnight, develop, continuo}\` (#3453/#4815)._
_"n/d" ao lado de uma categoria = eventos com \`source: "unavailable"\` (harness não expôs tokens, ou coordenador esqueceu o checkpoint) — NUNCA contados como zero, só reportados à parte para não subestimar o consumo em silêncio._
_"Dia" é dia CIVIL: rodadas do mesmo dia (\`260814\`, \`260814b\`, \`260814c\`) somam numa linha só, e \`×N\` ao lado do kind diz quantas foram (#6638)._
_"⚠ N rodada(s) sem evento" ao lado do kind = rodadas que deixaram diretório em \`data/{kind}/\` mas não emitiram nenhum evento de custo no run-log (#6634 Direction 2 — invisible rounds)._
_"Edição" tem split real \`tokens_in\`/\`tokens_out\` e \`$\` por modelo (via transcript local); overnight/develop/continuo só têm o total por invocação, sem split in/out._
_**Não compare os percentuais entre kinds:** as duas fontes medem bases diferentes — "Edição" soma \`input + cache_creation + cache_read\` do transcript e NÃO inclui subagentes (#5413), overnight/develop/continuo somam o total por subagente e não incluem o coordenador (#6634). Ver #6633._
`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values, flags } = parseArgs(process.argv.slice(2));
  const alarmPct = values["alarm-pct"] ? Number(values["alarm-pct"]) : 50;

  const summary = buildSessionTokensSummary({
    rootDir: ROOT,
    since: values.since,
    until: values.until,
    alarmPct: Number.isFinite(alarmPct) ? alarmPct : 50,
  });

  if (flags.has("json")) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  const md = formatSessionTokensSummary(summary);
  if (values.out) {
    const outPath = resolve(ROOT, values.out);
    writeFileSync(outPath, md, "utf8");
    console.log(`✓ session tokens summary gravado em ${outPath}`);
  } else {
    process.stdout.write(md);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
