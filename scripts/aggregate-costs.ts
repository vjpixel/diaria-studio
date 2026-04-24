/**
 * aggregate-costs.ts
 *
 * Agrega cost.md de todas as edições em `data/editions/*\/_internal/cost.md`
 * e gera relatório consolidado em `data/cost-summary.md`.
 *
 * Formato esperado de cada cost.md (do orchestrator):
 *   | Stage | Início | Fim | Chamadas | Haiku | Sonnet | [Opus] |
 *
 * Colunas adicionais (ex: Opus) são detectadas automaticamente via parser
 * de tabela markdown. Ausência de colunas vira zero.
 *
 * Uso:
 *   npx tsx scripts/aggregate-costs.ts [--since AAMMDD] [--until AAMMDD] [--out <path>]
 *
 * Output (stdout ou --out):
 *   data/cost-summary.md com tabelas por mês, stage, modelo.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface StageCost {
  stage: string;
  calls: number;
  haiku: number;
  sonnet: number;
  opus: number;
}

export interface EditionCost {
  edition: string;
  month: string; // AAMM
  stages: StageCost[];
  totals: { calls: number; haiku: number; sonnet: number; opus: number };
}

/**
 * Parseia tabela markdown do cost.md e retorna entries por stage.
 * Aceita variação de colunas (ordem + presença de Opus).
 */
export function parseCostMd(content: string): StageCost[] {
  const lines = content.split("\n");
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\|\s*Stage\s*\|/i.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const headerCells = lines[headerIdx]
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const colIdx: Record<string, number> = {};
  headerCells.forEach((h, i) => {
    colIdx[h] = i;
  });

  const stageCol = colIdx["stage"] ?? 0;
  const callsCol = colIdx["chamadas"];
  const haikuCol = colIdx["haiku"];
  const sonnetCol = colIdx["sonnet"];
  const opusCol = colIdx["opus"];

  const stages: StageCost[] = [];
  // Data rows start after separator line (|----|----)
  let dataStart = headerIdx + 2;
  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) break;
    if (/^\|\s*-+/.test(line)) continue;

    const cells = line.split("|").map((s) => s.trim());
    // Remove leading/trailing empty from pipe-wrapped
    if (cells[0] === "") cells.shift();
    if (cells[cells.length - 1] === "") cells.pop();
    if (cells.length === 0) continue;

    const stage = cells[stageCol] ?? "?";
    if (!stage || stage === "-") continue;

    const callsStr = callsCol != null ? cells[callsCol] ?? "" : "";
    const calls = parseCallsCount(callsStr);

    stages.push({
      stage,
      calls,
      haiku: parseNumber(haikuCol != null ? cells[haikuCol] : "0"),
      sonnet: parseNumber(sonnetCol != null ? cells[sonnetCol] : "0"),
      opus: parseNumber(opusCol != null ? cells[opusCol] : "0"),
    });
  }
  return stages;
}

/**
 * "writer:1, clarice:3, source:5" → 9
 * Tolera formato "N" puro.
 */
function parseCallsCount(raw: string): number {
  if (!raw || raw === "-") return 0;
  const nums = raw.match(/\d+/g);
  if (!nums) return 0;
  // Se tiver só um número, é o total direto
  if (nums.length === 1 && !raw.includes(":")) return Number(nums[0]);
  // Se tiver formato "agent:N, agent:N", somar os N
  return nums.reduce((sum, n) => sum + Number(n), 0);
}

function parseNumber(raw: string | undefined): number {
  if (!raw || raw === "-") return 0;
  const n = Number(raw.trim());
  return isNaN(n) ? 0 : n;
}

function totalsFromStages(stages: StageCost[]) {
  return stages.reduce(
    (acc, s) => ({
      calls: acc.calls + s.calls,
      haiku: acc.haiku + s.haiku,
      sonnet: acc.sonnet + s.sonnet,
      opus: acc.opus + s.opus,
    }),
    { calls: 0, haiku: 0, sonnet: 0, opus: 0 },
  );
}

export interface AggregateOptions {
  editionsDir: string;
  since?: string; // AAMMDD
  until?: string; // AAMMDD
}

export function aggregateCosts(opts: AggregateOptions): EditionCost[] {
  const { editionsDir } = opts;
  if (!existsSync(editionsDir)) return [];

  const editions: EditionCost[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(editionsDir).filter((d) => /^\d{6}$/.test(d));
  } catch {
    return [];
  }

  for (const edition of dirs) {
    if (opts.since && edition < opts.since) continue;
    if (opts.until && edition > opts.until) continue;
    const costPath = resolve(editionsDir, edition, "_internal/cost.md");
    if (!existsSync(costPath)) continue;
    const content = readFileSync(costPath, "utf8");
    const stages = parseCostMd(content);
    if (stages.length === 0) continue;
    editions.push({
      edition,
      month: edition.slice(0, 4), // AAMM
      stages,
      totals: totalsFromStages(stages),
    });
  }
  editions.sort((a, b) => a.edition.localeCompare(b.edition));
  return editions;
}

function groupByMonth(
  editions: EditionCost[],
): Record<string, { count: number; totals: { calls: number; haiku: number; sonnet: number; opus: number } }> {
  const by: Record<string, { count: number; totals: { calls: number; haiku: number; sonnet: number; opus: number } }> = {};
  for (const ed of editions) {
    if (!by[ed.month]) {
      by[ed.month] = { count: 0, totals: { calls: 0, haiku: 0, sonnet: 0, opus: 0 } };
    }
    by[ed.month].count += 1;
    by[ed.month].totals.calls += ed.totals.calls;
    by[ed.month].totals.haiku += ed.totals.haiku;
    by[ed.month].totals.sonnet += ed.totals.sonnet;
    by[ed.month].totals.opus += ed.totals.opus;
  }
  return by;
}

function groupByStage(
  editions: EditionCost[],
): Record<string, { editions: number; totals: { calls: number; haiku: number; sonnet: number; opus: number } }> {
  const by: Record<string, { editions: number; totals: { calls: number; haiku: number; sonnet: number; opus: number } }> = {};
  for (const ed of editions) {
    for (const s of ed.stages) {
      if (!by[s.stage]) {
        by[s.stage] = { editions: 0, totals: { calls: 0, haiku: 0, sonnet: 0, opus: 0 } };
      }
      by[s.stage].editions += 1;
      by[s.stage].totals.calls += s.calls;
      by[s.stage].totals.haiku += s.haiku;
      by[s.stage].totals.sonnet += s.sonnet;
      by[s.stage].totals.opus += s.opus;
    }
  }
  return by;
}

function formatMonthTable(
  byMonth: Record<string, { count: number; totals: { calls: number; haiku: number; sonnet: number; opus: number } }>,
): string {
  const months = Object.keys(byMonth).sort();
  if (months.length === 0) return "_Sem dados por mês._";
  const lines: string[] = [
    "| Mês | Edições | Chamadas | Haiku | Sonnet | Opus |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const m of months) {
    const b = byMonth[m];
    lines.push(
      `| ${m} | ${b.count} | ${b.totals.calls} | ${b.totals.haiku} | ${b.totals.sonnet} | ${b.totals.opus} |`,
    );
  }
  return lines.join("\n");
}

function formatStageTable(
  byStage: Record<string, { editions: number; totals: { calls: number; haiku: number; sonnet: number; opus: number } }>,
): string {
  const stages = Object.keys(byStage).sort();
  if (stages.length === 0) return "_Sem dados por stage._";
  const lines: string[] = [
    "| Stage | Edições | Chamadas | Haiku | Sonnet | Opus |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const s of stages) {
    const b = byStage[s];
    lines.push(
      `| ${s} | ${b.editions} | ${b.totals.calls} | ${b.totals.haiku} | ${b.totals.sonnet} | ${b.totals.opus} |`,
    );
  }
  return lines.join("\n");
}

export function formatSummary(editions: EditionCost[], generatedAt: Date = new Date()): string {
  const byMonth = groupByMonth(editions);
  const byStage = groupByStage(editions);

  const total = editions.reduce(
    (acc, e) => ({
      calls: acc.calls + e.totals.calls,
      haiku: acc.haiku + e.totals.haiku,
      sonnet: acc.sonnet + e.totals.sonnet,
      opus: acc.opus + e.totals.opus,
    }),
    { calls: 0, haiku: 0, sonnet: 0, opus: 0 },
  );

  const topExpensive = [...editions]
    .sort((a, b) => b.totals.calls - a.totals.calls)
    .slice(0, 5);

  return `# Cost Summary — Diar.ia

Gerado em ${generatedAt.toISOString()}
Edições agregadas: ${editions.length}

## Totais gerais

- **Chamadas**: ${total.calls}
- **Haiku**: ${total.haiku}
- **Sonnet**: ${total.sonnet}
- **Opus**: ${total.opus}

## Por mês

${formatMonthTable(byMonth)}

## Por stage (agregado todas as edições)

${formatStageTable(byStage)}

## Top 5 edições mais caras (por chamadas totais)

${topExpensive.length === 0 ? "_Nenhuma edição._" : topExpensive
  .map((e, i) => `${i + 1}. ${e.edition} — ${e.totals.calls} chamadas (H=${e.totals.haiku} S=${e.totals.sonnet} O=${e.totals.opus})`)
  .join("\n")}

---
_Nota: o cost.md atual registra contagens de chamada por modelo, não tokens nem $._
_Estimativa monetária requer incluir token counts em cost.md (follow-up)._
`;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const editionsDir = resolve(ROOT, "data/editions");
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

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
