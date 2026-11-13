#!/usr/bin/env node
/**
 * scripts/neo-readiness-alarm.ts (#12983)
 *
 * Alarme diário no `300` (task `Diaria-Neo-Readiness-Alarm`): lê o último
 * check de prontidão do Neo no KV `diaria-ops-state` (`infra:neo-readiness`,
 * gravado por `scripts/failover/neo-readiness.ts --record` no Passo 0 de
 * `/diaria-edicao` quando a sessão é no Neo) e abre/fecha issue via
 * `scripts/lib/alarm-issues.ts` quando o check tem mais de 7 dias, nunca foi
 * gravado ou está vermelho. Lógica pura: `scripts/lib/failover/neo-readiness-alarm.ts`.
 *
 * KV ilegível (rede, credencial): sai 1 sem tocar o estado das issues (nem
 * abre, nem fecha), e o alarme de units `failed` do `300` pega.
 *
 * Uso:
 *   npx tsx scripts/neo-readiness-alarm.ts            # avalia + cria/reusa/fecha issue
 *   npx tsx scripts/neo-readiness-alarm.ts --dry-run  # avalia + imprime, sem gh
 *
 * Estado: `data/failover/neo-readiness-alarm-issues.json`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAlarmReconciliation, loadAlarmIssuesState, planAlarmReconciliation, saveAlarmIssuesState } from "./lib/alarm-issues.ts";
import { applyCliAction, hasFlag, isMainModule, type CliSpec } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { createKvRestOps } from "./lib/cloudflare-kv-rest.ts";
import { resolveOpsStateKvConfig } from "./lib/diaria/short-related-kv.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { evaluateNeoReadinessAlarm } from "./lib/failover/neo-readiness-alarm.ts";
import { NEO_READINESS_KV_KEY, parseReadinessRecord, type ReadinessRecordRead } from "./lib/failover/neo-readiness.ts";
import { readPlatformConfigFile } from "./lib/failover/task-gate.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "failover", "neo-readiness-alarm-issues.json");
const LOG_PREFIX = "[neo-readiness-alarm]";
/** O sinal não oscila: 1 execução verde e recente já fecha. */
export const CLOSE_AFTER_RUNS = 1;

export const CLI_SPEC: CliSpec = {
  script: "scripts/neo-readiness-alarm.ts",
  booleans: ["dry-run"],
};

async function readRecord(): Promise<ReadinessRecordRead> {
  const pc = readPlatformConfigFile(ROOT);
  if (pc.kind !== "ok") return { kind: "error", error: pc.kind === "absent" ? "platform.config.json ausente" : `platform.config.json ilegível (${pc.error})` };
  const cfg = resolveOpsStateKvConfig(pc.value, process.env);
  if (!cfg.ok) return { kind: "error", error: `configuração do KV ausente: ${cfg.missing.join(", ")}` };
  try {
    return parseReadinessRecord(await createKvRestOps(cfg.config).get(NEO_READINESS_KV_KEY));
  } catch (e) {
    return { kind: "error", error: (e as Error).message };
  }
}

async function main(): Promise<number> {
  const cliExit = applyCliAction(process.argv.slice(2), CLI_SPEC);
  if (cliExit !== null) return cliExit;
  loadProjectEnv(ROOT);
  const verdict = evaluateNeoReadinessAlarm(await readRecord(), new Date());
  if (verdict.kind === "unmeasured") {
    console.error(`${LOG_PREFIX} KV ilegível (${verdict.reason}): estado das issues mantido`);
    return 1;
  }
  console.log(`${LOG_PREFIX} ${verdict.summary}`);
  const state = loadAlarmIssuesState(STATE_PATH);
  if (hasFlag(process.argv, "dry-run")) {
    const actions = planAlarmReconciliation(verdict.findings, state, CLOSE_AFTER_RUNS);
    console.log(`${LOG_PREFIX} --dry-run: ${actions.map((a) => a.kind).join(", ") || "nenhuma ação"} — gh NÃO foi chamado.`);
    return 0;
  }
  const { nextState, findingOutcomes } = applyAlarmReconciliation(verdict.findings, state, { cwd: ROOT, closeAfterRuns: CLOSE_AFTER_RUNS });
  saveAlarmIssuesState(nextState, STATE_PATH);
  let failed = false;
  for (const o of findingOutcomes) {
    if (o.action === "failed") {
      failed = true;
      console.error(`${LOG_PREFIX} issue não criada/reusada (${o.fingerprint}): ${o.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${o.issueNumber} (${o.action}): ${o.url}`);
    }
  }
  return failed ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error(`${LOG_PREFIX} erro: ${(e as Error).message}`) });
}
