/**
 * calibration-allowlist-growth-report.ts (#7982, item 1 — auditoria TRIMESTRAL)
 *
 * Relatório de crescimento cumulativo das allowlists de domínio/calibração
 * (`git log` dos arquivos de allowlist no período) + latência dos PRs de
 * calibração registrados em `data/reports/index.jsonl`. Apresenta o diff
 * agregado pro editor RE-RATIFICAR — nunca reverte nada.
 *
 * DRY-RUN por padrão: só imprime o markdown. Com `--write`, grava
 * `data/calibration-audit/allowlist-{YYYY-Qn}.md` e registra na superfície de
 * Relatórios do Studio (kind `calibration-audit`, sem e-mail).
 *
 * Uso:
 *   npx tsx scripts/calibration-allowlist-growth-report.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--write] [--quarter-only]
 * `--quarter-only`: sai 0 sem fazer nada fora de jan/abr/jul/out (task mensal do registro).
 * Default: o trimestre civil anterior completo.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  countDomainLiterals,
  parseGitNumstatLog,
  renderAllowlistGrowthMarkdown,
  renderLatencyMarkdown,
  summarizeAllowlistGrowth,
  summarizeCalibrationPrLatency,
  type CalibrationReportEntry,
} from "./lib/calibration-audit.ts";
import { registerReport } from "./studio-ui/studio-reports.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Arquivos de allowlist auditados. Adicionar aqui pra entrar no relatório. */
export const AUDITED_ALLOWLIST_FILES = [
  "scripts/lib/official-domains.ts",
  "scripts/lib/calibration-file-allowlist.ts",
  "scripts/lib/agent-eval-trigger-allowlist.ts",
] as const;

/** Trimestre civil anterior a `now` (UTC), como datas YYYY-MM-DD [since, until). */
export function previousQuarter(now: Date): { since: string; until: string; label: string } {
  const q = Math.floor(now.getUTCMonth() / 3); // 0..3 do trimestre ATUAL
  let year = now.getUTCFullYear();
  let pq = q - 1;
  if (pq < 0) {
    pq = 3;
    year -= 1;
  }
  const startMonth = pq * 3;
  const fmt = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const endYear = pq === 3 ? year + 1 : year;
  const endMonth = pq === 3 ? 0 : startMonth + 3;
  return { since: fmt(year, startMonth), until: fmt(endYear, endMonth), label: `${year}-Q${pq + 1}` };
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
}

function sizeAt(rev: string, file: string): number | null {
  try {
    return countDomainLiterals(git(["show", `${rev}:${file}`]));
  } catch {
    return null; // arquivo não existia nesse rev
  }
}

function revBefore(date: string): string | null {
  const out = git(["rev-list", "-1", `--before=${date}`, "HEAD"]).trim();
  return out || null;
}

function readCalibrationEntries(): CalibrationReportEntry[] {
  const p = resolve(ROOT, "data/reports/index.jsonl");
  if (!existsSync(p)) return [];
  const out: CalibrationReportEntry[] = [];
  for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CalibrationReportEntry);
    } catch {
      /* linha corrompida: ignora (leitura best-effort) */
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("quarter-only") && new Date().getUTCMonth() % 3 !== 0) {
    process.stdout.write("[quarter-only] fora de jan/abr/jul/out — nada a fazer.\n");
    return;
  }
  const dq = previousQuarter(new Date());
  const since = values["since"] ?? dq.since;
  const until = values["until"] ?? dq.until;
  const label = values["since"] || values["until"] ? `${since}_${until}` : dq.label;

  const log = git([
    "log",
    `--since=${since}`,
    `--until=${until}`,
    "--format=@@%H|%aI|%s",
    "--numstat",
    "--",
    ...AUDITED_ALLOWLIST_FILES,
  ]);
  const commits = parseGitNumstatLog(log);
  const revStart = revBefore(since);
  const revEnd = revBefore(until);
  const sizes: Record<string, { start: number | null; end: number | null }> = {};
  for (const f of AUDITED_ALLOWLIST_FILES) {
    sizes[f] = { start: revStart ? sizeAt(revStart, f) : null, end: revEnd ? sizeAt(revEnd, f) : null };
  }
  const growth = summarizeAllowlistGrowth(commits, AUDITED_ALLOWLIST_FILES, sizes);
  const md =
    renderAllowlistGrowthMarkdown(growth, { since, until }) +
    "\n" +
    renderLatencyMarkdown(summarizeCalibrationPrLatency(readCalibrationEntries(), { since, until }));

  if (!flags.has("write")) {
    process.stdout.write(md + "\n[dry-run] nada gravado nem registrado (use --write).\n");
    return;
  }
  const rel = `data/calibration-audit/allowlist-${label}.md`;
  mkdirSync(resolve(ROOT, "data/calibration-audit"), { recursive: true });
  writeFileSync(resolve(ROOT, rel), md, "utf-8");
  const r = registerReport(ROOT, {
    kind: "calibration-audit",
    sessionId: `allowlist-${label}`,
    title: `Auditoria de allowlists ${label} — ${growth.totalCommits} commits`,
    htmlPath: rel,
  });
  process.stdout.write(`${r.ok ? "registrado" : "falha ao registrar"}: ${rel}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[calibration-allowlist-growth-report] erro: ${(e as Error).message}`);
    process.exit(1);
  });
}
