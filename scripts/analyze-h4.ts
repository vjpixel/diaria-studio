/**
 * analyze-h4.ts (#1619)
 *
 * H4 — ranking scorer vs CTR observado por edição.
 *
 * Por edição: lê os highlights do scorer (de `_internal/01-approved.json`) e o CTR
 * observado (`data/link-ctr-table.csv`), e computa:
 *   - Spearman rho entre ordem do scorer e ordem por CTR observado
 *   - Acerto top-1 (o #1 do scorer foi o mais clicado?)
 *   - Overlap top-3 (|scorer_top3 ∩ ctr_top3|)
 *
 * Mesma lógica de join canonicalizado e filtro Aprofunde da metodologia validada
 * em 2026-06-11 (#1619/#1567). Guard de n mínimo: edição com <4 matches NÃO entra
 * no agregado (lição do outlier 260601 — com n=3, um único destaque mal-ranqueado
 * produz rho=-1, distorcendo a média).
 *
 * Histórico append-only: `data/scorer-ctr-history.jsonl` — 1 linha por edição madura
 * (≥7d de cliques), idempotente (não recomputa edição já gravada).
 *
 * Uso:
 *   npx tsx scripts/analyze-h4.ts \
 *     --ctr data/link-ctr-table.csv \
 *     --editions-dir data/editions \
 *     [--history data/scorer-ctr-history.jsonl] \
 *     [--maturity-days 7]
 *
 * Importável pra re-análise #1567 e surfacing em update-audience.ts.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { canonicalize } from "./lib/url-utils.ts";
import { dateToEdition, inWindow, type CtrRow, recordToCtrRow } from "./analyze-scorer-impact.ts";
import { isAprofundeAnchor } from "./update-audience.ts";

const ROOT = resolve(import.meta.dirname, "..");

// Mínimo de matches entre scorer e CTR table pra incluir edição no agregado.
// Abaixo disso, n pequeno → Spearman instável (outlier 260601: n=3 → rho=-1).
export const MIN_MATCHES_FOR_AGGREGATE = 4;

// ─── Tipos públicos ─────────────────────────────────────────────────────────

export interface ScoredHighlight {
  url: string;
  score: number; // score do scorer (0-100)
}

/** Entrada de uma edição no histórico. */
export interface H4HistoryEntry {
  edition: string; // AAMMDD
  rho: number; // Spearman rho entre ranking-scorer e ranking-CTR
  top1_hit: boolean; // #1 do scorer foi o mais clicado?
  top3_overlap: number; // |scorer_top3 ∩ ctr_top3| (0-3)
  n_matches: number; // quantos destaques casaram no join
  computed_at: string; // ISO timestamp
}

/** Resultado do surfacing semanal (últimas 4 semanas). */
export interface H4Trend {
  entries: H4HistoryEntry[]; // as 4 semanas (pode ser menos se não houver)
  rho_mean: number | null; // rho médio das entradas
  top1_hit_rate: number | null; // taxa de acerto top-1 (0-1)
  alert_low_rho: boolean; // true se rho médio < 0.4 por 2 semanas consecutivas
}

// ─── Spearman rho ───────────────────────────────────────────────────────────

/**
 * Spearman rho para dois rankings numéricos de mesmo comprimento n≥2.
 * Inputs: arrays de valores (maiores = melhor). A função converte para ranks
 * (rank 1 = maior valor) e aplica a fórmula ρ = 1 − 6Σd²/n(n²-1).
 *
 * Retorna null se n < 2 (rho indefinido).
 *
 * Exemplo verificável à mão (n=3, concordância perfeita):
 *   scorer  = [80, 60, 40] → ranks [1, 2, 3]
 *   ctr     = [5,  3,  1]  → ranks [1, 2, 3]
 *   d²      = [0, 0, 0], Σd² = 0
 *   rho     = 1 − 0 / (3×8) = 1.000
 *
 * Exemplo (inversão total, n=3):
 *   scorer  = [80, 60, 40] → ranks [1, 2, 3]
 *   ctr     = [1,  3,  5]  → ranks [3, 2, 1]
 *   d²      = [4, 0, 4], Σd² = 8
 *   rho     = 1 − 6×8 / (3×8) = 1 − 2 = -1.000
 */
export function spearmanRho(scorerValues: number[], ctrValues: number[]): number | null {
  const n = scorerValues.length;
  if (n !== ctrValues.length || n < 2) return null;

  // Converte valores para ranks (rank 1 = maior)
  const toRanks = (vals: number[]): number[] => {
    // índices ordenados do maior pro menor
    const sorted = vals
      .map((v, i) => ({ v, i }))
      .sort((a, b) => b.v - a.v)
      .map((x) => x.i);
    const ranks = new Array<number>(n);
    for (let r = 0; r < n; r++) {
      ranks[sorted[r]] = r + 1;
    }
    return ranks;
  };

  const rS = toRanks(scorerValues);
  const rC = toRanks(ctrValues);

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rS[i] - rC[i];
    sumD2 += d * d;
  }

  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

// ─── Carrega highlights do scorer por edição ─────────────────────────────────

/**
 * Lê `_internal/01-approved.json` e extrai os highlights com url+score.
 * Usa `highlights[]` (sempre presente) — ignora runners_up (vazio em edições
 * recentes conforme nota #1619).
 * Retorna null se o arquivo não existe ou é inválido.
 */
export function loadScorerHighlights(
  editionsDir: string,
  edition: string,
): ScoredHighlight[] | null {
  const p = resolve(ROOT, editionsDir, edition, "_internal", "01-approved.json");
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    const highlights: ScoredHighlight[] = [];
    for (const h of data.highlights ?? []) {
      const url = h.article?.url ?? h.url;
      const score = typeof h.score === "number" ? h.score : null;
      if (typeof url === "string" && url && score !== null) {
        highlights.push({ url: canonicalize(url), score });
      }
    }
    // Ordena por score desc (maior = mais bem ranqueado pelo scorer)
    highlights.sort((a, b) => b.score - a.score);
    return highlights.length > 0 ? highlights : null;
  } catch {
    return null;
  }
}

// ─── Carrega CTR table ──────────────────────────────────────────────────────

/**
 * Lê e parseia o CTR CSV. Filtra rows Aprofunde (regime pré-mar/2026) — mesma
 * lógica de update-audience.ts (#1564). O filtro é aplicado ANTES da conversão
 * para CtrRow (lendo o campo `anchor` do record bruto do papaparse), pois CtrRow
 * não expõe `anchor`. Retorna lista de CtrRow ou [] se arquivo ausente.
 * Defensivo: se o CSV não existe, retorna [] com log de aviso (não crasha).
 */
export function loadCtrRowsH4(ctrPath: string): CtrRow[] {
  const abs = resolve(ROOT, ctrPath);
  if (!existsSync(abs)) {
    process.stderr.write(
      `[analyze-h4] AVISO: CTR CSV ausente em ${abs} — H4 não pode ser computado.\n`,
    );
    return [];
  }
  const csv = readFileSync(abs, "utf8");
  const { data } = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  return data
    .filter((rec) => !isAprofundeAnchor(rec.anchor ?? "")) // filtra regime pré-mar/2026
    .map(recordToCtrRow)
    .filter((r): r is CtrRow => r !== null);
}

// ─── Computa H4 por edição ──────────────────────────────────────────────────

/**
 * Computa as métricas H4 de uma única edição.
 *
 * @param scorerHighlights - highlights do scorer, ordenados por score desc
 * @param ctrRows - todas as linhas do CTR table (filtradas de Aprofunde)
 * @param editionDate - data da edição em YYYY-MM-DD
 * @returns objeto com rho/top1/top3/n_matches, ou null se n_matches < MIN_MATCHES_FOR_AGGREGATE
 */
export function computeEditionH4(
  scorerHighlights: ScoredHighlight[],
  ctrRows: CtrRow[],
  editionDate: string,
): Omit<H4HistoryEntry, "edition" | "computed_at"> | null {
  // Filtra linhas do CTR da edição
  const editionCtrRows = ctrRows.filter((r) => r.date === editionDate);
  if (editionCtrRows.length === 0) return null;

  // Monta mapa url_canônica → CTR observado (unique_clicks / unique_opens)
  const ctrByUrl = new Map<string, number>();
  for (const r of editionCtrRows) {
    const key = canonicalize(r.base_url);
    const ctr = r.unique_opens > 0 ? (r.unique_verified_clicks / r.unique_opens) * 100 : 0;
    // Se duplicata, soma os clicks/opens (não sobrescreve com o primeiro)
    if (!ctrByUrl.has(key)) {
      ctrByUrl.set(key, ctr);
    }
  }

  // Join scorer ↔ CTR pela URL canônica
  const matched: Array<{ scorerScore: number; ctr: number }> = [];
  for (const h of scorerHighlights) {
    const ctr = ctrByUrl.get(h.url);
    if (ctr !== undefined) {
      matched.push({ scorerScore: h.score, ctr });
    }
  }

  const n = matched.length;
  if (n < MIN_MATCHES_FOR_AGGREGATE) return null;

  const scorerValues = matched.map((m) => m.scorerScore);
  const ctrValues = matched.map((m) => m.ctr);

  const rho = spearmanRho(scorerValues, ctrValues) ?? 0;

  // Top-1: o destaque com maior score do scorer foi o mais clicado?
  // Índice 0 = maior score (já ordenado por score desc no loadScorerHighlights)
  const topScorerUrl = scorerHighlights[0]?.url;
  const topCtrUrl = [...ctrByUrl.entries()]
    .filter(([url]) => scorerHighlights.some((h) => h.url === url))
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  const top1Hit = !!(topScorerUrl && topCtrUrl && topScorerUrl === topCtrUrl);

  // Overlap top-3: interseção dos top-3 do scorer vs top-3 por CTR observado
  const scorerTop3 = new Set(scorerHighlights.slice(0, 3).map((h) => h.url));
  const ctrTop3 = new Set(
    [...ctrByUrl.entries()]
      .filter(([url]) => scorerHighlights.some((h) => h.url === url))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([url]) => url),
  );
  const top3Overlap = [...scorerTop3].filter((u) => ctrTop3.has(u)).length;

  return { rho, top1_hit: top1Hit, top3_overlap: top3Overlap, n_matches: n };
}

// ─── Histórico append-only ──────────────────────────────────────────────────

/**
 * Carrega as edições já gravadas no histórico JSONL.
 * Retorna Set de edition strings (AAMMDD). Defensivo: arquivo ausente → Set vazio.
 */
export function loadHistoryEditions(historyPath: string): Set<string> {
  const abs = resolve(ROOT, historyPath);
  if (!existsSync(abs)) return new Set();
  const lines = readFileSync(abs, "utf8").split("\n").filter(Boolean);
  const editions = new Set<string>();
  for (const line of lines) {
    try {
      const entry: H4HistoryEntry = JSON.parse(line);
      if (entry.edition) editions.add(entry.edition);
    } catch {
      /* linha malformada — ignora */
    }
  }
  return editions;
}

/**
 * Carrega todas as entradas do histórico JSONL.
 * Retorna array de H4HistoryEntry. Defensivo: arquivo ausente → [].
 */
export function loadHistory(historyPath: string): H4HistoryEntry[] {
  const abs = resolve(ROOT, historyPath);
  if (!existsSync(abs)) return [];
  const lines = readFileSync(abs, "utf8").split("\n").filter(Boolean);
  const entries: H4HistoryEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as H4HistoryEntry);
    } catch {
      /* linha malformada — ignora */
    }
  }
  return entries;
}

/**
 * Append idempotente: só grava entradas de edições ainda não presentes no jsonl.
 * Não recomputa edições já gravadas.
 */
export function appendHistory(historyPath: string, entries: H4HistoryEntry[]): void {
  if (entries.length === 0) return;
  const abs = resolve(ROOT, historyPath);
  for (const e of entries) {
    appendFileSync(abs, JSON.stringify(e) + "\n", "utf8");
  }
}

// ─── Computa edições recém-maduras (incremental) ─────────────────────────────

/**
 * Descobre edições maduras (≥maturityDays de cliques desde a data da edição) que
 * ainda não estão no histórico, e computa H4 para cada uma.
 *
 * @param ctrRows - rows do CTR (já filtradas de Aprofunde)
 * @param editionsDir - diretório base das edições (ex: "data/editions")
 * @param alreadyComputed - set de edições já no histório (para idempotência)
 * @param maturityDays - mínimo de dias após a data da edição (default 7)
 * @param now - data de referência (default hoje)
 * @returns novas entradas computadas (pode ser [])
 */
export function computeNewH4Entries(
  ctrRows: CtrRow[],
  editionsDir: string,
  alreadyComputed: Set<string>,
  maturityDays = 7,
  now: Date = new Date(),
): H4HistoryEntry[] {
  // Descobre edições distintas no CTR table
  const editionDates = new Map<string, string>(); // edition → date YYYY-MM-DD
  for (const r of ctrRows) {
    const ed = dateToEdition(r.date);
    if (ed && !editionDates.has(ed)) {
      editionDates.set(ed, r.date);
    }
  }

  const newEntries: H4HistoryEntry[] = [];
  const computedAt = now.toISOString();

  for (const [edition, edDate] of editionDates) {
    // Já computado → skip (idempotência)
    if (alreadyComputed.has(edition)) continue;

    // Maturidade: ≥maturityDays desde a data da edição
    const edDateObj = new Date(edDate);
    const daysSince = (now.getTime() - edDateObj.getTime()) / 86400000;
    if (daysSince < maturityDays) continue;

    // Carrega highlights do scorer
    const scorerHighlights = loadScorerHighlights(editionsDir, edition);
    if (!scorerHighlights) continue;

    // Computa H4
    const result = computeEditionH4(scorerHighlights, ctrRows, edDate);
    if (!result) continue; // n < MIN_MATCHES ou sem CTR

    newEntries.push({ edition, ...result, computed_at: computedAt });
  }

  return newEntries;
}

// ─── Surfacing: trend das últimas 4 semanas ──────────────────────────────────

/**
 * Computa o trend H4 das últimas 4 entradas do histórico.
 * Alerta se o rho médio móvel cair abaixo de 0.4 por 2 semanas consecutivas.
 */
export const H4_RHO_ALERT_THRESHOLD = 0.4;

export function computeH4Trend(entries: H4HistoryEntry[], windowSize = 4): H4Trend {
  // Ordena por edition (AAMMDD lexicalmente) e pega as últimas windowSize
  const sorted = [...entries].sort((a, b) => a.edition.localeCompare(b.edition));
  const recent = sorted.slice(-windowSize);

  const rhoMean =
    recent.length > 0 ? recent.reduce((s, e) => s + e.rho, 0) / recent.length : null;

  const top1HitRate =
    recent.length > 0
      ? recent.filter((e) => e.top1_hit).length / recent.length
      : null;

  // Alerta: rho < threshold por 2 semanas consecutivas (janela das últimas 2)
  const last2 = sorted.slice(-2);
  const alertLowRho =
    last2.length === 2 &&
    last2.every((e) => e.rho < H4_RHO_ALERT_THRESHOLD);

  return { entries: recent, rho_mean: rhoMean, top1_hit_rate: top1HitRate, alert_low_rho: alertLowRho };
}

/**
 * Formata o surfacing H4 pra impressão no terminal (update-audience.ts).
 * Retorna string markdown-lite pronta pro console.log.
 */
export function formatH4Trend(trend: H4Trend): string {
  const lines: string[] = ["", "## H4 — Scorer × CTR (trend semanal)"];

  if (trend.entries.length === 0) {
    lines.push("  Sem histórico H4 disponível (aguardando edições maduras ≥7d).");
    return lines.join("\n");
  }

  lines.push(
    `  Últimas ${trend.entries.length} edições no histórico:`,
    "",
  );
  for (const e of trend.entries) {
    const hitStr = e.top1_hit ? "✓" : "✗";
    lines.push(
      `  ${e.edition}  rho=${e.rho.toFixed(3)}  top1=${hitStr}  top3_overlap=${e.top3_overlap}  n=${e.n_matches}`,
    );
  }

  lines.push("", `  Rho médio (${trend.entries.length} edições): ${trend.rho_mean?.toFixed(3) ?? "—"}`);
  lines.push(`  Top-1 hit rate: ${trend.top1_hit_rate !== null ? `${(trend.top1_hit_rate * 100).toFixed(0)}%` : "—"}`);

  if (trend.alert_low_rho) {
    lines.push(
      "",
      "  ⚠️  ALERTA H4: rho médio < 0.4 por 2 semanas consecutivas — scorer pode estar pesando sinal editorial demais em relação ao CTR observado. Considerar re-análise dos pesos.",
    );
  }

  return lines.join("\n");
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const ctrPath = args.ctr ?? "data/link-ctr-table.csv";
  const editionsDir = args["editions-dir"] ?? "data/editions";
  const historyPath = args.history ?? "data/scorer-ctr-history.jsonl";
  const maturityDays = parseInt(args["maturity-days"] ?? "7", 10);

  const ctrRows = loadCtrRowsH4(ctrPath);
  if (ctrRows.length === 0) {
    process.stderr.write("[analyze-h4] Nenhuma row de CTR carregada — abortando.\n");
    process.exit(1);
  }

  const alreadyComputed = loadHistoryEditions(historyPath);
  process.stderr.write(
    `[analyze-h4] ${alreadyComputed.size} edições já no histórico; verificando novas (maturidade ≥${maturityDays}d)...\n`,
  );

  const newEntries = computeNewH4Entries(
    ctrRows,
    editionsDir,
    alreadyComputed,
    maturityDays,
  );

  if (newEntries.length > 0) {
    appendHistory(historyPath, newEntries);
    process.stderr.write(`[analyze-h4] +${newEntries.length} entradas novas gravadas em ${historyPath}\n`);
  } else {
    process.stderr.write("[analyze-h4] Nenhuma edição nova madura encontrada.\n");
  }

  // Surfacing
  const allEntries = loadHistory(historyPath);
  const trend = computeH4Trend(allEntries);
  process.stdout.write(formatH4Trend(trend) + "\n");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const _importMeta = import.meta.url;
if (
  _importMeta === `file://${_argv1}` ||
  _importMeta === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
