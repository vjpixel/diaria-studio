/**
 * analyze-scorer-impact.ts (#1567)
 *
 * Mede empiricamente o impacto do #1565 (filtro Aprofunde + decay 90d no
 * audience-profile) no CTR real dos destaques. Compara uma janela BASELINE
 * (pré-#1565) com uma janela TREATMENT (pós-#1565), computando H1-H4 da issue.
 *
 * Como identifica destaques: cruza o `base_url` de cada linha do CTR table com
 * as URLs dos `highlights[]` de `data/editions/{AAMMDD}/_internal/01-approved.json`
 * (join por URL canonicalizada). O CTR table sozinho não marca quais linhas são
 * os 3 destaques da edição — a fonte da verdade é o approved.json.
 *
 * Parsing do CSV: ancorado no FIM (origin=-1, category=-2, ctr=-3, ...,
 * base_url=-8) porque title/section_title podem ter vírgulas — mesma técnica do
 * update-audience.ts. `date` é o 1º campo (sempre seguro). NÃO usa decay aqui:
 * o decay era pra ponderar o profile; aqui queremos CTR observado cru por janela.
 *
 * ⚠️ A janela TREATMENT (#1565 mergeado 2026-05-28) só tem dados maduros a
 * partir de ~2026-06-11 (Beehiiv leva ~7d/edição). Rodar antes disso reporta
 * `editions_found: 0` no treatment — é esperado, não bug.
 *
 * Uso:
 *   npx tsx scripts/analyze-scorer-impact.ts \
 *     --baseline-from 2026-05-20 --baseline-to 2026-05-28 \
 *     --treatment-from 2026-05-30 --treatment-to 2026-06-12 \
 *     [--ctr data/link-ctr-table.csv] [--editions-dir data/editions] [--out report.md]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { canonicalize } from "./lib/url-utils.ts";

const ROOT = resolve(import.meta.dirname, "..");

// Categorias-alvo da H1 (subiram no ranking pós-#1565).
const H1_CATEGORIES = ["Aplicação", "Segurança"];

export interface CtrRow {
  date: string; // YYYY-MM-DD (publish date = edição)
  base_url: string;
  unique_opens: number;
  unique_verified_clicks: number;
  ctr_pct: number;
  category: string;
  origin: string; // BR | INT | (outro)
}

/**
 * Parseia uma linha do CTR table ancorando no FIM (campos seguros, sem vírgula).
 * Colunas: date,post_title,section_title,anchor,base_url,domain,unique_opens,
 *          verified_clicks,unique_verified_clicks,ctr_pct,category,origin
 * Retorna null se a linha não tiver campos suficientes ou date inválida.
 */
export function parseCtrRow(line: string): CtrRow | null {
  const parts = line.split(",");
  if (parts.length < 12) return null;
  const date = parts[0].trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const n = parts.length;
  const num = (s: string): number => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : 0;
  };
  return {
    date: date.slice(0, 10),
    base_url: (parts[n - 8] ?? "").trim(),
    unique_opens: num(parts[n - 6]),
    unique_verified_clicks: num(parts[n - 4]),
    ctr_pct: num(parts[n - 3]),
    category: (parts[n - 2] ?? "").trim(),
    origin: (parts[n - 1] ?? "").trim(),
  };
}

/** Converte YYYY-MM-DD → código de edição AAMMDD (260520). */
export function dateToEdition(date: string): string {
  const m = date.match(/^(\d{2})(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${m[2]}${m[3]}${m[4]}`;
}

/** date string está dentro de [from, to] inclusive (comparação lexical YYYY-MM-DD). */
export function inWindow(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

export interface EditionHighlights {
  edition: string;
  highlightUrls: Set<string>; // canonicalizadas
}

/** Carrega os URLs dos 3 destaques de uma edição (canonicalizados). */
export function loadEditionHighlights(
  editionsDir: string,
  edition: string,
): Set<string> {
  const p = resolve(ROOT, editionsDir, edition, "_internal", "01-approved.json");
  const urls = new Set<string>();
  if (!existsSync(p)) return urls;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    for (const h of data.highlights ?? []) {
      const url = h.article?.url ?? h.url;
      if (typeof url === "string" && url) urls.add(canonicalize(url));
    }
  } catch {
    /* edição sem approved.json válido — ignora */
  }
  return urls;
}

export interface WindowMetrics {
  from: string;
  to: string;
  editions_found: number;
  destaque_rows: number;
  // H2
  destaque_ctr_mean: number | null;
  secondary_ctr_mean: number | null;
  // H1: % de edições com >=1 destaque em cada categoria-alvo
  h1_editions_with_category: Record<string, number>;
  editions_with_destaques: number;
  // H3: distribuição BR/INT dos destaques
  destaque_origin: Record<string, number>;
  destaque_br_pct: number | null;
  // categoria dos destaques (contagem)
  destaque_category: Record<string, number>;
}

/** CTR observado de uma linha (unique clicks / unique opens), em %. */
function rowCtr(r: CtrRow): number | null {
  if (r.unique_opens <= 0) return null;
  return (r.unique_verified_clicks / r.unique_opens) * 100;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * Computa as métricas de uma janela. `rows` = todas as linhas do CTR table;
 * a função filtra pela janela e marca destaques via `highlightsByEdition`.
 */
export function computeWindowMetrics(
  rows: CtrRow[],
  from: string,
  to: string,
  highlightsByEdition: Map<string, Set<string>>,
): WindowMetrics {
  const windowRows = rows.filter((r) => inWindow(r.date, from, to));
  const editionsInWindow = new Set(windowRows.map((r) => dateToEdition(r.date)));
  const editionsFound = [...editionsInWindow].filter(
    (e) => (highlightsByEdition.get(e)?.size ?? 0) > 0,
  ).length;

  const destaqueCtrs: number[] = [];
  const secondaryCtrs: number[] = [];
  const destaqueOrigin: Record<string, number> = {};
  const destaqueCategory: Record<string, number> = {};
  // por edição → set de categorias dos seus destaques
  const catsByEdition = new Map<string, Set<string>>();
  let destaqueRows = 0;

  for (const r of windowRows) {
    const ed = dateToEdition(r.date);
    const hl = highlightsByEdition.get(ed);
    const isDestaque = hl ? hl.has(canonicalize(r.base_url)) : false;
    const ctr = rowCtr(r);

    if (isDestaque) {
      destaqueRows++;
      if (ctr !== null) destaqueCtrs.push(ctr);
      destaqueOrigin[r.origin] = (destaqueOrigin[r.origin] ?? 0) + 1;
      destaqueCategory[r.category] = (destaqueCategory[r.category] ?? 0) + 1;
      if (!catsByEdition.has(ed)) catsByEdition.set(ed, new Set());
      catsByEdition.get(ed)!.add(r.category);
    } else if (ctr !== null) {
      secondaryCtrs.push(ctr);
    }
  }

  // H1: quantas edições têm >=1 destaque em cada categoria-alvo
  const h1: Record<string, number> = {};
  for (const cat of H1_CATEGORIES) {
    h1[cat] = [...catsByEdition.values()].filter((s) => s.has(cat)).length;
  }

  const br = destaqueOrigin["BR"] ?? 0;
  const intl = destaqueOrigin["INT"] ?? 0;
  const brPct = br + intl > 0 ? (br / (br + intl)) * 100 : null;

  return {
    from,
    to,
    editions_found: editionsFound,
    destaque_rows: destaqueRows,
    destaque_ctr_mean: mean(destaqueCtrs),
    secondary_ctr_mean: mean(secondaryCtrs),
    h1_editions_with_category: h1,
    editions_with_destaques: catsByEdition.size,
    destaque_origin: destaqueOrigin,
    destaque_br_pct: brPct,
    destaque_category: destaqueCategory,
  };
}

function fmt(n: number | null, digits = 2): string {
  return n === null ? "—" : n.toFixed(digits);
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

/** Renderiza o relatório markdown comparando baseline vs treatment. */
export function renderReport(baseline: WindowMetrics, treatment: WindowMetrics): string {
  const L: string[] = [];
  L.push("# Impacto do scorer pós-#1565 (Aprofunde + decay 90d) — análise #1567", "");
  L.push(
    `Baseline: ${baseline.from} a ${baseline.to} (${baseline.editions_with_destaques} edições c/ destaques) · ` +
      `Treatment: ${treatment.from} a ${treatment.to} (${treatment.editions_with_destaques} edições c/ destaques)`,
    "",
  );

  if (treatment.editions_with_destaques === 0) {
    L.push(
      "> ⚠️ **Treatment sem edições com destaques maduros.** Provavelmente a janela " +
        "ainda não chegou (Beehiiv leva ~7d/edição). Rode a partir de ~2026-06-11.",
      "",
    );
  }

  L.push("## H2 — CTR médio dos destaques", "");
  L.push("| Janela | CTR destaques | CTR secundárias | nº linhas destaque |");
  L.push("|---|---|---|---|");
  L.push(`| Baseline | ${fmt(baseline.destaque_ctr_mean)}% | ${fmt(baseline.secondary_ctr_mean)}% | ${baseline.destaque_rows} |`);
  L.push(`| Treatment | ${fmt(treatment.destaque_ctr_mean)}% | ${fmt(treatment.secondary_ctr_mean)}% | ${treatment.destaque_rows} |`);
  if (baseline.destaque_ctr_mean !== null && treatment.destaque_ctr_mean !== null) {
    const delta = treatment.destaque_ctr_mean - baseline.destaque_ctr_mean;
    const rel = baseline.destaque_ctr_mean > 0 ? (delta / baseline.destaque_ctr_mean) * 100 : 0;
    L.push("", `**Δ CTR destaques:** ${delta >= 0 ? "+" : ""}${fmt(delta)}pp (${rel >= 0 ? "+" : ""}${fmt(rel, 1)}%) — H2 ${delta > 0 ? "✅ confirmada" : "❌ não confirmada"} (cuidado: efeito esperado pequeno, mascarado por audience drift).`);
  }
  L.push("");

  L.push("## H1 — frequência de destaques Aplicação/Segurança", "");
  L.push("| Categoria | Baseline (edições c/ ≥1) | Treatment (edições c/ ≥1) |");
  L.push("|---|---|---|");
  for (const cat of H1_CATEGORIES) {
    const b = baseline.h1_editions_with_category[cat] ?? 0;
    const t = treatment.h1_editions_with_category[cat] ?? 0;
    L.push(`| ${cat} | ${b} (${pct(b, baseline.editions_with_destaques)}) | ${t} (${pct(t, treatment.editions_with_destaques)}) |`);
  }
  L.push("");

  L.push("## H3 — distribuição BR/INT dos destaques", "");
  L.push("| Janela | BR | INT | % BR |");
  L.push("|---|---|---|---|");
  L.push(`| Baseline | ${baseline.destaque_origin["BR"] ?? 0} | ${baseline.destaque_origin["INT"] ?? 0} | ${fmt(baseline.destaque_br_pct, 0)}% |`);
  L.push(`| Treatment | ${treatment.destaque_origin["BR"] ?? 0} | ${treatment.destaque_origin["INT"] ?? 0} | ${fmt(treatment.destaque_br_pct, 0)}% |`);
  L.push("", "Esperado por H3: BR cai de ~60% pra ~50% (annotation removeu prêmio automático BR).", "");

  L.push("## Distribuição de categorias dos destaques", "");
  const cats = [...new Set([...Object.keys(baseline.destaque_category), ...Object.keys(treatment.destaque_category)])].sort();
  L.push("| Categoria | Baseline | Treatment |");
  L.push("|---|---|---|");
  for (const c of cats) {
    L.push(`| ${c || "(vazio)"} | ${baseline.destaque_category[c] ?? 0} | ${treatment.destaque_category[c] ?? 0} |`);
  }
  L.push("");

  L.push("## Confounders (não controlados)", "");
  L.push("- Audience drift: base ainda crescendo → CTR pode cair mesmo com scorer melhor.");
  L.push("- #1560/#1562 (Brave) mergearam junto → efeito combinado, atribuir conservadoramente.");
  L.push("- Pool menor (P0/P1/P2) → menos diversidade de seleção.");
  L.push("- H4 (top-6 scorer vs observado) não computado aqui — requer ranking por edição; ver issue.");
  L.push("");

  return L.join("\n");
}

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

export function loadCtrRows(ctrPath: string): CtrRow[] {
  const lines = readFileSync(resolve(ROOT, ctrPath), "utf8").trim().split("\n").slice(1);
  return lines.map(parseCtrRow).filter((r): r is CtrRow => r !== null);
}

/** Coleta os destaques de todas as edições que aparecem nas janelas dadas. */
export function highlightsForWindows(
  rows: CtrRow[],
  editionsDir: string,
  windows: Array<{ from: string; to: string }>,
): Map<string, Set<string>> {
  const editions = new Set<string>();
  for (const r of rows) {
    for (const w of windows) {
      if (inWindow(r.date, w.from, w.to)) editions.add(dateToEdition(r.date));
    }
  }
  const map = new Map<string, Set<string>>();
  for (const ed of editions) map.set(ed, loadEditionHighlights(editionsDir, ed));
  return map;
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const required = ["baseline-from", "baseline-to", "treatment-from", "treatment-to"];
  for (const k of required) {
    if (!args[k]) {
      console.error(
        "Uso: analyze-scorer-impact.ts --baseline-from YYYY-MM-DD --baseline-to YYYY-MM-DD " +
          "--treatment-from YYYY-MM-DD --treatment-to YYYY-MM-DD [--ctr <csv>] [--editions-dir <dir>] [--out <md>]",
      );
      process.exit(1);
    }
  }
  const ctrPath = args.ctr ?? "data/link-ctr-table.csv";
  const editionsDir = args["editions-dir"] ?? "data/editions";

  const rows = loadCtrRows(ctrPath);
  const windows = [
    { from: args["baseline-from"], to: args["baseline-to"] },
    { from: args["treatment-from"], to: args["treatment-to"] },
  ];
  const highlights = highlightsForWindows(rows, editionsDir, windows);

  const baseline = computeWindowMetrics(rows, windows[0].from, windows[0].to, highlights);
  const treatment = computeWindowMetrics(rows, windows[1].from, windows[1].to, highlights);

  const report = renderReport(baseline, treatment);
  if (args.out) {
    writeFileSync(resolve(ROOT, args.out), report, "utf8");
    process.stderr.write(`[analyze-scorer-impact] relatório em ${args.out}\n`);
  } else {
    process.stdout.write(report + "\n");
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const _importMeta = import.meta.url;
if (
  _importMeta === `file://${_argv1}` ||
  _importMeta === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
