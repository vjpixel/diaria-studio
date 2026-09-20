#!/usr/bin/env npx tsx
/**
 * report-overnight-waves.ts (#8496)
 *
 * CLI agregador do leitor de `plan.waves[]` (`scripts/lib/overnight-waves-report.ts`).
 * Varre `data/overnight/{AAMMDD*}/plan.json` (todas as rondas por padrão, ou
 * um subconjunto via `--since AAMMDD`) e imprime a distribuição de
 * `unit_count`, a fração de ondas com `cap_hit`, e o `pr→merge` p90
 * segmentado por `cap_hit` — os 3 números que decidem o A/B do teto 3→6
 * (#8486): critério já escrito na SKILL — `cap_hit` quase sempre `false` =
 * teto nunca foi o limite; `pr→merge` p90 > ~30min (ou `draft-ci-vermelho`
 * subindo) nas ondas com `cap_hit: true` = voltar a 3.
 *
 * Corte natural pra 1ª leitura (ver #8496): rondas a partir de 260920
 * (primeiras com `waves`) — `--since 260920`.
 *
 * Uso:
 *   npx tsx scripts/report-overnight-waves.ts [--dir data/overnight] [--since AAMMDD] [--json]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { normalizeIssues } from "./lib/plan-issues-normalize.ts";
import { aggregateWaveRounds, renderWavesReportMarkdown } from "./lib/overnight-waves-report.ts";
import type { OvernightWaveRecord } from "./lib/overnight-waves.ts";
import type { PlanIssue } from "./render-overnight-timeline.ts";

/** Casa `AAMMDD` ou `AAMMDDx` (sufixo de rodada suplementar, ex: 260920b). */
const OVERNIGHT_DIR_RE = /^\d{6}[a-z]?$/;

export interface ScannedRound {
  dir: string;
  waves?: OvernightWaveRecord[];
  issues: PlanIssue[];
}

/**
 * Pure-ish (só leitura de disco, sem side effect): lista os dirs de rodada
 * sob `overnightDataDir` que casam `OVERNIGHT_DIR_RE`, opcionalmente
 * filtrados por `since` (AAMMDD, comparação lexicográfica no prefixo de 6
 * dígitos — cobre sufixo de letra igual a `readTodayPlan`), e devolve o
 * plan.json parseado de cada um. Plan ilegível/ausente é PULADO (fail-soft,
 * nunca lança) — é observabilidade, não um gate que possa travar a rodada.
 */
export function scanOvernightRounds(overnightDataDir: string, since?: string): ScannedRound[] {
  if (!existsSync(overnightDataDir)) return [];
  const dirs = readdirSync(overnightDataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && OVERNIGHT_DIR_RE.test(e.name))
    .map((e) => e.name)
    .filter((name) => !since || name.slice(0, 6) >= since)
    .sort();

  const rounds: ScannedRound[] = [];
  for (const dir of dirs) {
    const planPath = join(overnightDataDir, dir, "plan.json");
    if (!existsSync(planPath)) continue;
    try {
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      if (plan === null || typeof plan !== "object") continue;
      rounds.push({
        dir,
        waves: Array.isArray(plan.waves) ? plan.waves : undefined,
        issues: normalizeIssues(plan),
      });
    } catch {
      continue; // plan.json corrompido — pula, não trava o agregador
    }
  }
  return rounds;
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const dir = values.dir ?? "data/overnight";
  const since = values.since;
  if (since && !/^\d{6}$/.test(since)) {
    console.error(`[report-overnight-waves] --since exige AAMMDD (recebido: ${JSON.stringify(since)})`);
    process.exit(2);
  }

  const rounds = scanOvernightRounds(dir, since);
  const report = aggregateWaveRounds(rounds);

  if (flags.has("json")) {
    console.log(JSON.stringify({ rounds_dirs: rounds.map((r) => r.dir), ...report }, null, 2));
  } else {
    console.log(renderWavesReportMarkdown(report));
  }
}
