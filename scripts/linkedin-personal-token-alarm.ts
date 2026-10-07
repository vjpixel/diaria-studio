#!/usr/bin/env node
/**
 * scripts/linkedin-personal-token-alarm.ts (#9568)
 *
 * Alarme de expiração do token do app LinkedIn PESSOAL (`w_member_social`,
 * 60 dias, sem refresh token). Roda diário como 2º passo da task
 * `Diaria-LinkedIn-Personal`. Lógica pura em
 * `scripts/lib/linkedin-personal.ts::evaluateTokenExpiry`; aqui é só I/O via
 * `scripts/lib/alarm-issues.ts` (mesmo mecanismo dos outros alarmes).
 *
 * Faixas: > 14 dias = nada; ≤ 14 = issue P2; ≤ 3 ou expirado = P1 (comenta
 * na issue aberta ao mudar de faixa). Família `estado`: token renovado no
 * ambiente faz a issue fechar sozinha. Token nunca configurado = sem alarme
 * (o lembrete manual do Stage 6 é o modo legítimo).
 *
 * Uso:
 *   npx tsx scripts/linkedin-personal-token-alarm.ts            # avalia + cria/reusa/fecha issue
 *   npx tsx scripts/linkedin-personal-token-alarm.ts --dry-run  # avalia + imprime, sem gh
 *
 * Estado: `data/linkedin-personal-token-alarm-issues.json`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  planAlarmReconciliation,
  saveAlarmIssuesState,
} from "./lib/alarm-issues.ts";
import { evaluateTokenExpiry } from "./lib/linkedin-personal.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "linkedin-personal-token-alarm-issues.json");
const LOG_PREFIX = "[linkedin-personal-token-alarm]";
/** 1 execução limpa (token renovado) já basta pra fechar: o sinal não oscila. */
const CLOSE_AFTER_RUNS = 1;

function main(): void {
  loadProjectEnv(ROOT);
  const finding = evaluateTokenExpiry(process.env, new Date());
  console.log(`${LOG_PREFIX} ${finding ? finding.title : "token ausente ou com folga — nada a alarmar"}`);
  const findings = finding ? [finding] : [];
  const state = loadAlarmIssuesState(STATE_PATH);
  if (hasFlag(process.argv, "dry-run")) {
    const actions = planAlarmReconciliation(findings, state, CLOSE_AFTER_RUNS);
    console.log(`${LOG_PREFIX} --dry-run: ${actions.map((a) => a.kind).join(", ") || "nenhuma ação"} — gh NÃO foi chamado.`);
    return;
  }
  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, state, { cwd: ROOT, closeAfterRuns: CLOSE_AFTER_RUNS });
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
  if (failed) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main();
}
