/**
 * cac-report.ts (#5236 Parte 2)
 *
 * Relatório de custo por leitor por canal — a peça que fecha a camada de
 * dados de aquisição (#5235 definiu `leitor-v1` + mapa de origem
 * recuperada; este script cruza os dois com `data/aquisicao/spend.csv` e
 * ranqueia).
 *
 * **Só leitura local — nunca chama a API Beehiiv/Google Ads/LinkedIn ao
 * vivo** (guard de publicação do overnight/develop). Toda a computação real
 * mora em `scripts/lib/cac.ts` (puro, testável sem I/O); este arquivo só
 * carrega os 3 insumos do disco, chama `buildCacReport`, formata e registra.
 *
 * ## Insumos
 *
 * 1. Snapshot mais recente de `data/beehiiv-backup/{YYYY-MM-DD}/subscribers.jsonl`
 *    (task `Diaria-Beehiiv-Backup`, #5229) — `--snapshot` pra outra data.
 * 2. `data/aquisicao/origem-original.json` (opcional — `scripts/build-origem-map.ts`,
 *    #5235). Sem ele, o relatório roda com o `utm_source` CRU do snapshot
 *    (aviso explícito no output, nunca silencioso) — cadastros reativados
 *    via `brevo-diaria` (#4530) vão aparecer como esse canal em vez da
 *    origem original.
 * 3. `data/aquisicao/spend.csv` (#5236 Parte 1) — `--spend` pra outro path;
 *    `npx tsx scripts/seed-spend-csv.ts` cria o seed inicial se ausente.
 *
 * ## Uso
 *
 *   npx tsx scripts/cac-report.ts
 *   npx tsx scripts/cac-report.ts --json
 *   npx tsx scripts/cac-report.ts --snapshot 2026-08-14 --no-register
 *
 * Exit codes: 0 = sucesso; 1 = insumo obrigatório ausente/ilegível (spend.csv
 * ou snapshot).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, hasFlag, getStringArg } from "./lib/cli-args.ts";
import {
  latestSnapshotDate,
  listSnapshotDates,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "./lib/beehiiv-backup-snapshots.ts";
import { readSpendCsv, type SpendRow, type SpendRowError } from "./lib/aquisicao-spend.ts";
import {
  buildCacReport,
  filterInternalAndTestSubscribers,
  applyOrigemOverride,
  buildNormalizedOrigemIndex,
  computeMonthBudgetUsage,
  MONTHLY_BUDGET_FLOOR_BRL,
  type CacReport,
  type CacRow,
  type OrigemEntryFields,
} from "./lib/cac.ts";
import { registerReport, reportId } from "./studio-ui/studio-reports.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data", "beehiiv-backup");
export const DEFAULT_SPEND_CSV_PATH = resolve(ROOT, "data", "aquisicao", "spend.csv");
export const DEFAULT_ORIGEM_MAP_PATH = resolve(ROOT, "data", "aquisicao", "origem-original.json");

// ---------------------------------------------------------------------------
// Carregamento de insumos (I/O — não testado como pure, ver cac.test.ts pro
// núcleo puro e studio-ads.test.ts pra fixture-based end-to-end)
// ---------------------------------------------------------------------------

interface OrigemMapFile {
  origem?: Record<string, OrigemEntryFields>;
}

export function loadOrigemIndex(path: string): { index: Map<string, OrigemEntryFields>; applied: boolean } {
  if (!existsSync(path)) {
    console.error(
      `[cac-report] aviso: mapa de origem ausente (${path}) — usando utm_source cru do snapshot. ` +
        `Rode "npx tsx scripts/build-origem-map.ts" pra reconstruir a origem recuperada (#5235).`,
    );
    return { index: new Map(), applied: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as OrigemMapFile;
    return { index: buildNormalizedOrigemIndex(parsed.origem ?? {}), applied: true };
  } catch (e) {
    console.error(`[cac-report] aviso: falha ao ler mapa de origem (${path}): ${(e as Error).message} — usando utm_source cru.`);
    return { index: new Map(), applied: false };
  }
}

export function loadPreparedSubscribers(
  root: string,
  date: string,
  origemIndex: Map<string, OrigemEntryFields>,
): { subs: BeehiivBackupSubscriber[]; internalFiltered: number } {
  const raw = readSnapshotSubscribers(root, date);
  const overridden = applyOrigemOverride(raw, origemIndex);
  const { kept, removedCount } = filterInternalAndTestSubscribers(overridden);
  return { subs: kept, internalFiltered: removedCount };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CacReportCliArgs {
  backupRoot: string;
  spendPath: string;
  origemPath: string;
  snapshotDate: string | null;
  json: boolean;
  register: boolean;
}

export function parseCacReportArgs(argv: string[]): CacReportCliArgs {
  return {
    backupRoot: getStringArg(argv, "root") ?? DEFAULT_BACKUP_ROOT,
    spendPath: getStringArg(argv, "spend") ?? DEFAULT_SPEND_CSV_PATH,
    origemPath: getStringArg(argv, "origem") ?? DEFAULT_ORIGEM_MAP_PATH,
    snapshotDate: getStringArg(argv, "snapshot") ?? null,
    json: hasFlag(argv, "json"),
    register: !hasFlag(argv, "no-register"),
  };
}

function fmtPct(frac: number | null): string {
  if (frac == null) return "—";
  return `${(frac * 100).toFixed(1)}%`;
}

function fmtBrl(n: number | null): string {
  if (n == null) return "—";
  return `R$ ${n.toFixed(2).replace(".", ",")}`;
}

function amostraQualifier(row: Extract<CacRow, { kind: "measured" }>): string {
  if (row.amostraVazia) return "⚠ vazia";
  if (row.amostraPequena) return "⚠ pequena";
  if (row.amostraInstavel) return "⚠ instável";
  return "";
}

/** @pure */
export function formatCacReportMarkdown(report: CacReport, budget: ReturnType<typeof computeMonthBudgetUsage>): string {
  const lines: string[] = [];
  lines.push(`# Custo por leitor por canal`, "");
  lines.push(`Base (todos os ativos, todos os canais): abertura agregada ${fmtPct(report.base.aberturaAgregada)} (n=${report.base.amostraConsiderada}).`);
  lines.push(`Orçamento do mês ${budget.monthKey}: ${fmtBrl(budget.spentBrl)} de ${fmtBrl(budget.budgetFloorBrl)} (${fmtPct(budget.fractionUsed)}).`);
  if (report.internalFiltered > 0) {
    lines.push(`${report.internalFiltered} conta(s) interna(s)/teste excluída(s) antes de agrupar.`);
  }
  if (!report.originApplied) {
    lines.push(`⚠ mapa de origem recuperada NÃO aplicado — canais reativados via brevo-diaria podem estar mal atribuídos.`);
  }
  if (report.unmappedChannels.length > 0) {
    lines.push(`⚠ canal(is) desconhecido(s) em spend.csv (confira o nome exato): ${report.unmappedChannels.join(", ")}.`);
  }
  lines.push("");
  lines.push(
    "| Canal | Custo/leitor | Leitores | Ativos | Cadastros | Abertura (canal) | vs. base | n | Amostra | Gasto | Mês | Fonte |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");

  for (const row of report.rows) {
    if (row.kind === "measured") {
      const versusBase =
        row.aberturaAgregada != null && report.base.aberturaAgregada != null
          ? `${row.aberturaAgregada >= report.base.aberturaAgregada ? "▲" : "▼"} ${fmtPct(Math.abs(row.aberturaAgregada - report.base.aberturaAgregada) as number)}`
          : "—";
      const degradedFlag = row.degradado === true ? " ⚠ degradou" : "";
      lines.push(
        `| ${row.canal} | ${fmtBrl(row.custoPorLeitor)} | ${row.leitores} | ${row.ativos} | ${row.cadastros} | ${fmtPct(row.aberturaAgregada)}${degradedFlag} | ${versusBase} | ${row.amostraConsiderada} | ${amostraQualifier(row) || "—"} | ${fmtBrl(row.spend.valor)} | ${row.spend.mes} | ${row.spend.fonte} |`,
      );
    } else {
      lines.push(
        `| ${row.canal} | ${fmtBrl(row.range.custoPorLeitorMin)}–${fmtBrl(row.range.custoPorLeitorMax)} | ${row.range.leitoresMin}–${row.range.leitoresMax} | ${row.range.ativosMin}–${row.range.ativosMax} | — | — | — | — | estimado (não medido) | ${fmtBrl(row.spend.valor)} | ${row.spend.mes} | ${row.spend.fonte} |`,
      );
    }
  }

  lines.push("");
  lines.push(`Total medido (exclui estimativas): ${fmtBrl(report.totalGastoMedido)}.`);
  const boostRow = report.rows.find((r): r is Extract<CacRow, { kind: "boost-estimate" }> => r.kind === "boost-estimate");
  if (boostRow) lines.push(`${boostRow.canal}: ${boostRow.note}`);

  return lines.join("\n") + "\n";
}

function reportSpendErrorsToLines(errors: SpendRowError[]): string[] {
  return errors.map((e) => `[cac-report] spend.csv linha ${e.line}: ${e.reason}`);
}

/**
 * `rootDir` é onde `data/aquisicao/cac-reports/{id}.md` é escrito e onde o
 * relatório é registrado (`registerReport`) — SEPARADO de `args.backupRoot`
 * (que é só a leitura de snapshots, pode apontar pra qualquer lugar via
 * `--root`). Default `ROOT` (raiz real do projeto); testes injetam um
 * tmpdir aqui pra nunca escrever/registrar contra `data/reports/index.jsonl`
 * de verdade.
 */
export function main(argv: string[] = process.argv.slice(2), rootDir: string = ROOT): void {
  const args = parseCacReportArgs(argv);

  let spendResult: { rows: SpendRow[]; errors: SpendRowError[] };
  try {
    spendResult = readSpendCsv(args.spendPath);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  for (const line of reportSpendErrorsToLines(spendResult.errors)) console.error(line);
  if (spendResult.rows.length === 0) {
    console.error(`[cac-report] spend.csv não tem nenhuma linha válida — nada para reportar.`);
    process.exitCode = 1;
    return;
  }

  const dates = listSnapshotDates(args.backupRoot);
  const snapshotDate = args.snapshotDate ?? latestSnapshotDate(args.backupRoot);
  if (!snapshotDate) {
    console.error(`[cac-report] nenhum snapshot encontrado em ${args.backupRoot}.`);
    process.exitCode = 1;
    return;
  }

  const { index: origemIndex, applied: originApplied } = loadOrigemIndex(args.origemPath);
  const { subs, internalFiltered } = loadPreparedSubscribers(args.backupRoot, snapshotDate, origemIndex);
  if (subs.length === 0) {
    console.error(`[cac-report] snapshot ${snapshotDate} não tem subscribers legíveis em ${args.backupRoot}.`);
    process.exitCode = 1;
    return;
  }

  // Snapshot anterior (pro sinal de degradação) — o segundo mais recente
  // ANTES de `snapshotDate` na lista ordenada ascendente, quando existir.
  const idx = dates.indexOf(snapshotDate);
  const previousDate = idx > 0 ? dates[idx - 1] : null;
  const previousSubs = previousDate
    ? loadPreparedSubscribers(args.backupRoot, previousDate, origemIndex).subs
    : undefined;

  const report = buildCacReport(spendResult.rows, subs, { previousSubs, originApplied, internalFiltered });
  const monthKey = snapshotDate.slice(0, 7); // "YYYY-MM-DD" -> "YYYY-MM"
  const budget = computeMonthBudgetUsage(spendResult.rows, monthKey, MONTHLY_BUDGET_FLOOR_BRL);

  if (args.json) {
    console.log(JSON.stringify({ snapshotDate, previousDate, report, budget }, null, 2));
  } else {
    console.log(formatCacReportMarkdown(report, budget));
  }

  if (args.register) {
    const markdown = formatCacReportMarkdown(report, budget);
    const dir = resolve(rootDir, "data", "aquisicao", "cac-reports");
    mkdirSync(dir, { recursive: true });
    const id = snapshotDate;
    const relPath = `data/aquisicao/cac-reports/${id}.md`;
    writeFileSync(resolve(rootDir, relPath), markdown, "utf8");
    const result = registerReport(rootDir, {
      kind: "cac",
      sessionId: id,
      title: `Custo por leitor por canal — snapshot ${snapshotDate}`,
      htmlPath: relPath,
    });
    if (!result.ok) {
      console.error(`[cac-report] aviso: registro do relatório falhou (fail-soft, #3714): ${result.error}`);
    } else {
      console.error(`[cac-report] registrado: ${reportId("cac", id)} → /relatorios/${reportId("cac", id)}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
