#!/usr/bin/env node
/**
 * scripts/neo-readiness-alarm.ts (#12983)
 *
 * Alarme diário no `300` (task `Diaria-Neo-Readiness-Alarm`): lê o último
 * check de prontidão do Neo no KV `diaria-ops-state` (`infra:neo-readiness`,
 * gravado por `scripts/failover/neo-readiness.ts --record` no Passo 0 de
 * `/diaria-edicao` quando a sessão é no Neo) e abre/fecha issue via
 * `scripts/lib/alarm-issues.ts` quando o check tem mais de 7 dias, nunca foi
 * gravado, não veio do Neo, está vermelho ou traz o mesmo item "não
 * verificado" há vários checks. Lógica pura: `scripts/lib/failover/neo-readiness-alarm.ts`.
 *
 * Falha ao LER o KV (rede, credencial, config): sai 1 sem mexer em nada (nem
 * abre, nem fecha issue, nem conta streak), e o alarme de units `failed` do
 * `300` pega. Registro corrompido conta como ausente e abre a issue `stale`.
 *
 * Uso:
 *   npx tsx scripts/neo-readiness-alarm.ts            # avalia + cria/reusa/fecha issue
 *   npx tsx scripts/neo-readiness-alarm.ts --dry-run  # avalia + imprime, sem gh e sem gravar estado
 *
 * Estado: `data/failover/neo-readiness-alarm-issues.json` (issues) e
 * `data/failover/neo-readiness-unverified-streak.json` (checks seguidos com
 * item não verificado).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  planAlarmReconciliation,
  saveAlarmIssuesState,
  saveState,
  type AlarmIssuesState,
  type ApplyAlarmReconciliationResult,
  type AlarmFinding,
} from "./lib/alarm-issues.ts";
import { applyCliAction, hasFlag, isMainModule, type CliSpec } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { createKvRestOps } from "./lib/cloudflare-kv-rest.ts";
import { resolveOpsStateKvConfig } from "./lib/diaria/short-related-kv.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { EMPTY_UNVERIFIED_STREAK, evaluateNeoReadinessAlarm, updateUnverifiedStreak, type UnverifiedStreakState } from "./lib/failover/neo-readiness-alarm.ts";
import { NEO_READINESS_KV_KEY, parseReadinessRecord, type ReadinessRecordRead } from "./lib/failover/neo-readiness.ts";
import { readPlatformConfigFile } from "./lib/failover/task-gate.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "failover", "neo-readiness-alarm-issues.json");
const STREAK_PATH = resolve(ROOT, "data", "failover", "neo-readiness-unverified-streak.json");
const LOG_PREFIX = "[neo-readiness-alarm]";
/** O sinal não oscila: 1 execução verde e recente já fecha. */
export const CLOSE_AFTER_RUNS = 1;

export const CLI_SPEC: CliSpec = {
  script: "scripts/neo-readiness-alarm.ts",
  booleans: ["dry-run"],
};

export interface AlarmDeps {
  now: () => Date;
  loadEnv: () => void;
  readRecord: (now: Date) => Promise<ReadinessRecordRead>;
  loadIssues: () => AlarmIssuesState;
  saveIssues: (s: AlarmIssuesState) => void;
  loadStreak: () => UnverifiedStreakState;
  saveStreak: (s: UnverifiedStreakState) => void;
  apply: (findings: readonly AlarmFinding[], state: AlarmIssuesState) => ApplyAlarmReconciliationResult;
  log: (m: string) => void;
  err: (m: string) => void;
}

async function defaultReadRecord(now: Date): Promise<ReadinessRecordRead> {
  const pc = readPlatformConfigFile(ROOT);
  if (pc.kind !== "ok") return { kind: "error", error: pc.kind === "absent" ? "platform.config.json ausente" : `platform.config.json ilegível (${pc.error})` };
  const cfg = resolveOpsStateKvConfig(pc.value, process.env);
  if (!cfg.ok) return { kind: "error", error: `configuração do KV ausente: ${cfg.missing.join(", ")}` };
  try {
    return parseReadinessRecord(await createKvRestOps(cfg.config).get(NEO_READINESS_KV_KEY), now);
  } catch (e) {
    return { kind: "error", error: (e as Error).message };
  }
}

/** Estado de streak ilegível recomeça do zero (o pior caso é atrasar o achado). */
export function loadStreakFile(path: string): UnverifiedStreakState {
  if (!existsSync(path)) return EMPTY_UNVERIFIED_STREAK;
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as Partial<UnverifiedStreakState> | null;
    if (!o || typeof o !== "object" || !o.streaks || typeof o.streaks !== "object") return EMPTY_UNVERIFIED_STREAK;
    return { lastCheckedAt: typeof o.lastCheckedAt === "string" ? o.lastCheckedAt : null, streaks: o.streaks };
  } catch {
    return EMPTY_UNVERIFIED_STREAK;
  }
}

function defaultDeps(): AlarmDeps {
  return {
    now: () => new Date(),
    loadEnv: () => loadProjectEnv(ROOT),
    readRecord: defaultReadRecord,
    loadIssues: () => loadAlarmIssuesState(STATE_PATH),
    saveIssues: (s) => saveAlarmIssuesState(s, STATE_PATH),
    loadStreak: () => loadStreakFile(STREAK_PATH),
    saveStreak: (s) => saveState(s, STREAK_PATH),
    apply: (findings, state) => applyAlarmReconciliation(findings, state, { cwd: ROOT, closeAfterRuns: CLOSE_AFTER_RUNS }),
    log: (m) => console.log(m),
    err: (m) => console.error(m),
  };
}

export async function main(argv: string[] = process.argv.slice(2), deps: Partial<AlarmDeps> = {}): Promise<number> {
  const d: AlarmDeps = { ...defaultDeps(), ...deps };
  const cliExit = applyCliAction(argv, CLI_SPEC);
  if (cliExit !== null) return cliExit;
  d.loadEnv();
  const now = d.now();
  const read = await d.readRecord(now);
  if (read.kind === "error") {
    d.err(`${LOG_PREFIX} KV ilegível (${read.error}): estado das issues e do streak mantido`);
    return 1;
  }
  const prevStreak = d.loadStreak();
  // Só registro válido do Neo conta para o streak; ausente/corrompido/de outra máquina já vira `stale`.
  const streak = read.kind === "ok" ? updateUnverifiedStreak(prevStreak, read.report) : prevStreak;
  const verdict = evaluateNeoReadinessAlarm(read, now, undefined, streak);
  if (verdict.kind === "unmeasured") {
    d.err(`${LOG_PREFIX} KV ilegível (${verdict.reason}): estado das issues e do streak mantido`);
    return 1;
  }
  d.log(`${LOG_PREFIX} ${verdict.summary}`);
  const state = d.loadIssues();
  if (hasFlag(argv, "dry-run")) {
    const actions = planAlarmReconciliation(verdict.findings, state, CLOSE_AFTER_RUNS);
    d.log(`${LOG_PREFIX} --dry-run: ${actions.map((a) => a.kind).join(", ") || "nenhuma ação"} — gh NÃO foi chamado, estado não gravado.`);
    return 0;
  }
  const { nextState, findingOutcomes } = d.apply(verdict.findings, state);
  d.saveIssues(nextState);
  if (streak !== prevStreak) d.saveStreak(streak);
  let failed = false;
  for (const o of findingOutcomes) {
    if (o.action === "failed") {
      failed = true;
      d.err(`${LOG_PREFIX} issue não criada/reusada (${o.fingerprint}): ${o.error}`);
    } else {
      d.log(`${LOG_PREFIX} issue #${o.issueNumber} (${o.action}): ${o.url}`);
    }
  }
  return failed ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), { onError: (e) => console.error(`${LOG_PREFIX} erro: ${(e as Error).message}`) });
}
