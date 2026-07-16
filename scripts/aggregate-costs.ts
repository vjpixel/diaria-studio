/**
 * aggregate-costs.ts
 *
 * Agrega `stage-status.json` de todas as edições em
 * `data/editions/*\/_internal/stage-status.json` e gera relatório consolidado
 * em `data/cost-summary.md`.
 *
 * #3439: `_internal/cost.md` foi removido em #1217 (redundante com
 * stage-status, nunca foi preenchido na prática — ver orchestrator.md §
 * "Cost + timing tracking"). Este script lia um arquivo que não existe mais
 * desde então; `cost-summary.md` sempre saía vazio. `stage-status.json` é o
 * single source of truth atual (timing + custo + tokens + modelos por stage,
 * `scripts/update-stage-status.ts`) — este script lê de lá.
 *
 * `cost_usd`/`tokens_in`/`tokens_out`/`models` em `stage-status.json` são
 * populados por `scripts/capture-stage-usage.ts` (#3441), rodado pelo
 * orchestrator logo após cada `--status done` nos 7 playbooks
 * `orchestrator-stage-*.md` — lê o `usage` real das chamadas do coordenador a
 * partir do transcript local da sessão (`scripts/lib/session-transcript.ts`),
 * fail-soft (sem transcript local, ex: sessão cloud, sai sem escrever nada).
 * Este script agrega o que existir e estima $ a partir de tokens quando os
 * campos estão presentes; edições sem esses campos (pré-#3441, ou stages
 * capturados sem transcript local) contam para timing mas ficam com custo "-".
 *
 * Uso:
 *   npx tsx scripts/aggregate-costs.ts [--since AAMMDD] [--until AAMMDD] [--out <path>]
 *
 * Output (stdout ou --out):
 *   data/cost-summary.md com tabelas por mês, stage, modelo.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { editionDateMs, estimateAggregateCostUsd } from "./lib/pricing.ts";

export interface StageCost {
  stage: number;
  label: string;
  status: string;
  durationMs: number;
  costUsd: number | undefined;
  tokensIn: number;
  tokensOut: number;
  models: string[];
}

export interface EditionTotals {
  durationMs: number;
  costUsd: number;
  costEstimated: boolean;
  tokensIn: number;
  tokensOut: number;
}

export interface EditionCost {
  edition: string;
  month: string; // AAMM
  stages: StageCost[];
  totals: EditionTotals;
}

interface RawStageRow {
  stage: number;
  status?: string;
  duration_ms?: number;
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  models?: string[];
}

interface RawStageStatusDoc {
  edition?: string;
  rows?: RawStageRow[];
}

const STAGE_LABELS: Record<number, string> = {
  0: "Setup + dedup",
  1: "Pesquisa",
  2: "Escrita",
  3: "Imagens",
  4: "Revisão",
  5: "Publicação",
  6: "Agendamento",
};

/**
 * Parseia `stage-status.json` (schema de `scripts/lib/update-stage-status.ts`
 * — StageStatusDoc). Tolera docs sem os campos opcionais de custo/tokens
 * (legado, ou stage ainda não instrumentado).
 */
export function parseStageStatusJson(content: string): StageCost[] {
  let doc: RawStageStatusDoc;
  try {
    doc = JSON.parse(content);
  } catch {
    return [];
  }
  if (!doc || !Array.isArray(doc.rows)) return [];

  return doc.rows
    .filter((r) => r && typeof r.stage === "number")
    .map((r) => ({
      stage: r.stage,
      label: STAGE_LABELS[r.stage] ?? `Stage ${r.stage}`,
      status: r.status ?? "pending",
      durationMs: r.duration_ms ?? 0,
      costUsd: r.cost_usd,
      tokensIn: r.tokens_in ?? 0,
      tokensOut: r.tokens_out ?? 0,
      models: Array.isArray(r.models) ? r.models : [],
    }));
}

// ---------------------------------------------------------------------------
// Pricing (#3437 context — auditoria de model mix; ver skill claude-api)
// ---------------------------------------------------------------------------
// #3441: tabela de pricing + resolução por model string movida pra
// `scripts/lib/pricing.ts` (single source of truth compartilhada com
// `scripts/capture-stage-usage.ts`, que precisa da MESMA tabela pra não
// divergir preço entre o agregador mensal e a captura por-stage).

/**
 * Estima custo de um stage a partir de tokens_in/tokens_out quando `models`
 * lista exatamente 1 tier Claude (não dá pra atribuir tokens por modelo
 * quando o stage mistura tiers — ex: Stage 1 roda Haiku researchers +
 * Sonnet scorer sob o mesmo total). Retorna `undefined` quando não é
 * possível estimar (0 ou 2+ modelos, ou modelo não-Claude).
 */
function estimateStageCostUsd(stage: StageCost, editionMs: number | null): number | undefined {
  return estimateAggregateCostUsd(stage.tokensIn, stage.tokensOut, stage.models, editionMs);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface AggregateOptions {
  editionsDir: string;
  since?: string; // AAMMDD
  until?: string; // AAMMDD
}

function totalsFromStages(stages: StageCost[], editionMs: number | null): EditionTotals {
  let costUsd = 0;
  let costEstimated = false;
  let durationMs = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const s of stages) {
    durationMs += s.durationMs;
    tokensIn += s.tokensIn;
    tokensOut += s.tokensOut;
    if (s.costUsd != null) {
      costUsd += s.costUsd;
    } else {
      const estimated = estimateStageCostUsd(s, editionMs);
      if (estimated != null) {
        costUsd += estimated;
        costEstimated = true;
      }
    }
  }

  return { durationMs, costUsd, costEstimated, tokensIn, tokensOut };
}

export function aggregateCosts(opts: AggregateOptions): EditionCost[] {
  const { editionsDir } = opts;
  if (!existsSync(editionsDir)) return [];

  const editions: EditionCost[] = [];
  // #2463: enumera ambos os layouts (flat legado + nested novo).
  const editionDirsByAammdd = enumerateEditionDirs(editionsDir);
  const dirs = [...editionDirsByAammdd.keys()];

  for (const edition of dirs) {
    if (opts.since && edition < opts.since) continue;
    if (opts.until && edition > opts.until) continue;
    const statusPath = resolve(editionDirsByAammdd.get(edition)!, "_internal/stage-status.json");
    if (!existsSync(statusPath)) continue;
    const content = readFileSync(statusPath, "utf8");
    const stages = parseStageStatusJson(content);
    if (stages.length === 0) continue;
    const editionMs = editionDateMs(edition);
    editions.push({
      edition,
      month: edition.slice(0, 4), // AAMM
      stages,
      totals: totalsFromStages(stages, editionMs),
    });
  }
  editions.sort((a, b) => a.edition.localeCompare(b.edition));
  return editions;
}

// ---------------------------------------------------------------------------
// Grouping + formatting
// ---------------------------------------------------------------------------

interface GroupTotals {
  durationMs: number;
  costUsd: number;
  costEstimated: boolean;
  tokensIn: number;
  tokensOut: number;
}

function emptyGroupTotals(): GroupTotals {
  return { durationMs: 0, costUsd: 0, costEstimated: false, tokensIn: 0, tokensOut: 0 };
}

function addTotals(acc: GroupTotals, t: EditionTotals): void {
  acc.durationMs += t.durationMs;
  acc.costUsd += t.costUsd;
  acc.costEstimated = acc.costEstimated || t.costEstimated;
  acc.tokensIn += t.tokensIn;
  acc.tokensOut += t.tokensOut;
}

function groupByMonth(editions: EditionCost[]): Record<string, { count: number; totals: GroupTotals }> {
  const by: Record<string, { count: number; totals: GroupTotals }> = {};
  for (const ed of editions) {
    if (!by[ed.month]) by[ed.month] = { count: 0, totals: emptyGroupTotals() };
    by[ed.month].count += 1;
    addTotals(by[ed.month].totals, ed.totals);
  }
  return by;
}

function groupByStage(
  editions: EditionCost[],
): Record<string, { label: string; editions: number; totals: GroupTotals }> {
  const by: Record<string, { label: string; editions: number; totals: GroupTotals }> = {};
  for (const ed of editions) {
    for (const s of ed.stages) {
      const key = String(s.stage);
      if (!by[key]) by[key] = { label: s.label, editions: 0, totals: emptyGroupTotals() };
      by[key].editions += 1;
      by[key].totals.durationMs += s.durationMs;
      by[key].totals.tokensIn += s.tokensIn;
      by[key].totals.tokensOut += s.tokensOut;
      if (s.costUsd != null) {
        by[key].totals.costUsd += s.costUsd;
      } else {
        const estimated = estimateStageCostUsd(s, editionDateMs(ed.edition));
        if (estimated != null) {
          by[key].totals.costUsd += estimated;
          by[key].totals.costEstimated = true;
        }
      }
    }
  }
  return by;
}

function fmtDuration(ms: number): string {
  if (!ms) return "-";
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m.toString().padStart(2, "0")}m` : `${m}m`;
}

function fmtCost(usd: number, estimated: boolean): string {
  if (!usd) return "-";
  const val = usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
  return estimated ? `~$${val}` : `$${val}`;
}

function fmtTokens(n: number): string {
  if (!n) return "-";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatMonthTable(byMonth: Record<string, { count: number; totals: GroupTotals }>): string {
  const months = Object.keys(byMonth).sort();
  if (months.length === 0) return "_Sem dados por mês._";
  const lines: string[] = [
    "| Mês | Edições | Duração | Custo | Tokens (in/out) |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const m of months) {
    const b = byMonth[m];
    lines.push(
      `| ${m} | ${b.count} | ${fmtDuration(b.totals.durationMs)} | ${fmtCost(b.totals.costUsd, b.totals.costEstimated)} | ${fmtTokens(b.totals.tokensIn)}/${fmtTokens(b.totals.tokensOut)} |`,
    );
  }
  return lines.join("\n");
}

function formatStageTable(
  byStage: Record<string, { label: string; editions: number; totals: GroupTotals }>,
): string {
  const stages = Object.keys(byStage).sort((a, b) => Number(a) - Number(b));
  if (stages.length === 0) return "_Sem dados por stage._";
  const lines: string[] = [
    "| Stage | Edições | Duração | Custo | Tokens (in/out) |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const s of stages) {
    const b = byStage[s];
    lines.push(
      `| ${s} — ${b.label} | ${b.editions} | ${fmtDuration(b.totals.durationMs)} | ${fmtCost(b.totals.costUsd, b.totals.costEstimated)} | ${fmtTokens(b.totals.tokensIn)}/${fmtTokens(b.totals.tokensOut)} |`,
    );
  }
  return lines.join("\n");
}

export function formatSummary(editions: EditionCost[], generatedAt: Date = new Date()): string {
  const byMonth = groupByMonth(editions);
  const byStage = groupByStage(editions);

  const total = editions.reduce((acc, e) => {
    addTotals(acc, e.totals);
    return acc;
  }, emptyGroupTotals());

  const topExpensive = [...editions]
    .filter((e) => e.totals.costUsd > 0)
    .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
    .slice(0, 5);

  return `# Cost Summary — Diar.ia

Gerado em ${generatedAt.toISOString()}
Edições agregadas: ${editions.length}

## Totais gerais

- **Duração**: ${fmtDuration(total.durationMs)}
- **Custo**: ${fmtCost(total.costUsd, total.costEstimated)}
- **Tokens**: ${fmtTokens(total.tokensIn)} in / ${fmtTokens(total.tokensOut)} out

## Por mês

${formatMonthTable(byMonth)}

## Por stage (agregado todas as edições)

${formatStageTable(byStage)}

## Top 5 edições mais caras (por custo)

${topExpensive.length === 0 ? "_Nenhuma edição com custo registrado ou estimável._" : topExpensive
  .map((e, i) => `${i + 1}. ${e.edition} — ${fmtCost(e.totals.costUsd, e.totals.costEstimated)} (${fmtTokens(e.totals.tokensIn)}/${fmtTokens(e.totals.tokensOut)} tokens)`)
  .join("\n")}

---
_Fonte: \`_internal/stage-status.json\` por edição (#3439 — \`_internal/cost.md\` foi removido em #1217 e nunca chegou a ser reintroduzido; este relatório lê o schema atual)._
_Custo prefixado com "~" é estimado a partir de tokens_in/tokens_out via tabela de pricing (só quando o stage roda 1 único tier Claude); sem "~" veio direto de \`cost_usd\` gravado pelo orchestrator._
_\`cost_usd\`/\`tokens_in\`/\`tokens_out\`/\`models\` são capturados automaticamente por \`scripts/capture-stage-usage.ts\` (#3441) ao fim de cada stage, a partir do transcript local da sessão; edições sem esses campos (pré-#3441, ou capturadas sem transcript local — ex: sessão cloud) contam pra duração mas ficam com custo "-"._
`;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const editionsDir = resolve(ROOT, editionsRoot());
  const since = args.since;
  const until = args.until;

  const editions = aggregateCosts({ editionsDir, since, until });
  const summary = formatSummary(editions);

  if (args.out) {
    const outPath = resolve(ROOT, args.out);
    writeFileSync(outPath, summary, "utf8");
    console.log(`✓ cost summary gravado em ${outPath}`);
    console.log(`  ${editions.length} edições agregadas`);
  } else {
    process.stdout.write(summary);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
