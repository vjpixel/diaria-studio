#!/usr/bin/env npx tsx
/**
 * report-overnight-waves.ts (#8496)
 *
 * CLI agregador do leitor de `plan.waves[]` (`scripts/lib/overnight-waves-report.ts`).
 * Varre `data/overnight/{AAMMDD*}/plan.json` (todas as rondas por padrão, ou
 * um subconjunto via `--since AAMMDD`) e imprime a distribuição de
 * `unit_count`, a fração de ondas com `cap_hit`, e o `pr→merge` p90
 * segmentado por `cap_hit` — os 3 números que decidem o A/B do teto (3→6 no
 * #8486, 6→10 no #10821): critério já escrito na SKILL — `cap_hit` quase
 * sempre `false` = teto nunca foi o limite; `pr→merge` p90 > ~30min (ou
 * `draft-ci-vermelho` subindo) nas ondas com `cap_hit: true` = voltar a 6.
 *
 * Corte natural pra 1ª leitura (ver #8496): rondas a partir de 260920
 * (primeiras com `waves`) — `--since 260920`. Para julgar o teto 10 sozinho
 * (#10821): `--since 261023` — a 261022 gravou 2 ondas com `cap: 6` antes da
 * troca e `--since` só compara o AAMMDD, então 261022b (já toda no 10) cai junto.
 *
 * **Resumo de UMA rodada: `--plan` (#11164).** `--since AAMMDD` é corte
 * inferior, não igualdade — pega toda rodada daquele dia em diante, inclusive
 * a de outra máquina no mesmo dia (300 `261025` + Zenbook `261025b` saíram
 * somadas, "Rondas: 4"). O relatório da Fase 2 lê só o `plan.json` da própria
 * sessão via `--plan`; `--since` fica para a leitura agregada de N rodadas.
 *
 * Uso:
 *   npx tsx scripts/report-overnight-waves.ts --plan data/overnight/{AAMMDD}/plan.json [--json]
 *   npx tsx scripts/report-overnight-waves.ts [--dir data/overnight] [--since AAMMDD] [--json]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
    const round = readRoundPlan(join(overnightDataDir, dir, "plan.json"), dir);
    if (round) rounds.push(round);
  }
  return rounds;
}

/**
 * Lê UM `plan.json` como rodada. Ausente, ilegível ou não-objeto → `null`
 * (fail-soft, mesma regra do scan). `dir` default = nome do diretório do plano.
 */
export function readRoundPlan(planPath: string, dir: string = basename(dirname(planPath))): ScannedRound | null {
  if (!existsSync(planPath)) return null;
  try {
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    if (plan === null || typeof plan !== "object") return null;
    return {
      dir,
      waves: Array.isArray(plan.waves) ? plan.waves : undefined,
      issues: normalizeIssues(plan),
    };
  } catch {
    return null; // plan.json corrompido — pula, não trava o agregador
  }
}

/**
 * Rodadas a agregar a partir dos args (#11164): `--plan` = só aquela rodada
 * (plano ausente/ilegível → lista vazia, o render já imprime a nota de
 * "nenhuma onda"); senão o scan de `--dir` com `--since` opcional.
 */
export function selectRounds(values: Record<string, string>): ScannedRound[] {
  if (values.plan) {
    const round = readRoundPlan(values.plan);
    return round ? [round] : [];
  }
  return scanOvernightRounds(values.dir ?? "data/overnight", values.since);
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const since = values.since;
  if (since && !/^\d{6}$/.test(since)) {
    console.error(`[report-overnight-waves] --since exige AAMMDD (recebido: ${JSON.stringify(since)})`);
    process.exit(2);
  }
  if (values.plan && (since || values.dir)) {
    console.error("[report-overnight-waves] --plan resume UMA rodada; não combina com --dir/--since");
    process.exit(2);
  }
  if (values.plan && !existsSync(values.plan)) {
    console.error(`[report-overnight-waves] aviso: plan.json não encontrado em ${values.plan}`);
  }

  const rounds = selectRounds(values);
  const report = aggregateWaveRounds(rounds);

  if (flags.has("json")) {
    console.log(JSON.stringify({ rounds_dirs: rounds.map((r) => r.dir), ...report }, null, 2));
  } else {
    console.log(renderWavesReportMarkdown(report));
  }
}
