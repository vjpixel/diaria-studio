#!/usr/bin/env node
/**
 * scripts/subscriber-confirmation-report.ts (#8552, residual)
 *
 * CLI READ-ONLY sobre os snapshots locais de `subscriber-state-snapshot.ts`:
 * taxa de confirmação DOI por coorte de cadastro e por canal (1h/24h/7d/30d)
 * + distribuição do tempo até confirmar, separado por `confirmou_via` (Kit vs
 * Brevo, #8438). Sem rede, sem escrita — só lê `data/subscriber-state-snapshots/kit/`.
 * Limites de resolução (granularidade diária, 1h irresolvível, ambíguos):
 * docstring de `scripts/lib/subscriber-confirmation-report.ts`.
 *
 * Uso:
 *   npx tsx scripts/subscriber-confirmation-report.ts [--root <path>] [--since AAAA-MM-DD] [--until AAAA-MM-DD] [--recent-root <path>] [--format text|json]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import {
  loadAllSubscriberStateSnapshots,
  snapshotRootDefault,
  parseSubscriberStateJsonl,
} from "./lib/subscriber-state-snapshot.ts";
import {
  buildHourlyConfirmationReport,
  renderHourlyConfirmationText,
  parseHourlyObservationFileName,
  type HourlyObservation,
} from "./lib/subscriber-hourly-confirmation.ts";
import { buildConfirmationReport, renderConfirmationReportText } from "./lib/subscriber-confirmation-report.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Carrega as observacoes horarias (kit-recent/*.jsonl); dir ausente = []. */
export function loadHourlyObservations(recentRoot: string): HourlyObservation[] {
  if (!existsSync(recentRoot)) return [];
  const out: HourlyObservation[] = [];
  for (const name of readdirSync(recentRoot)) {
    const at = parseHourlyObservationFileName(name);
    if (!at) continue;
    out.push({ at, records: parseSubscriberStateJsonl(readFileSync(resolve(recentRoot, name), "utf8")) });
  }
  return out;
}

/** Monta a saida completa (diario + horario). Exportado pra teste. */
export function buildReportOutput(
  root: string,
  recentRoot: string,
  opts: { since?: string; until?: string; format: "text" | "json" },
): string {
  const report = buildConfirmationReport(loadAllSubscriberStateSnapshots(root), { since: opts.since, until: opts.until });
  const hourly = buildHourlyConfirmationReport(loadHourlyObservations(recentRoot));
  return opts.format === "json"
    ? JSON.stringify({ ...report, horario: hourly }, null, 2) + "\n"
    : renderConfirmationReportText(report) + "\n" + renderHourlyConfirmationText(hourly);
}

function main(): void {
  const argv = process.argv.slice(2);
  const root = getArg(argv, "root") || snapshotRootDefault(resolve(ROOT, "data"));
  const since = getArg(argv, "since");
  const until = getArg(argv, "until");
  const format = getArg(argv, "format") || "text";
  for (const [name, v] of [["since", since], ["until", until]] as const) {
    if (v && !DATE_RE.test(v)) {
      console.error(`--${name} deve ser AAAA-MM-DD (recebido "${v}")`);
      process.exitCode = 2;
      return;
    }
  }
  if (format !== "text" && format !== "json") {
    console.error(`--format deve ser text|json (recebido "${format}")`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(root)) {
    console.error(`--root não existe: ${root}`);
    process.exitCode = 2;
    return;
  }
  const recentRoot = getArg(argv, "recent-root") || resolve(root, "..", "kit-recent");
  process.stdout.write(buildReportOutput(root, recentRoot, { since, until, format }));
}

if (isMainModule(import.meta.url)) main();
