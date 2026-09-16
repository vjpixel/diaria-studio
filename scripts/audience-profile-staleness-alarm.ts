#!/usr/bin/env node
/**
 * scripts/audience-profile-staleness-alarm.ts (#8148 item 1)
 *
 * Task diária: lê `data/run-log.jsonl`, detecta ocorrências do guard de
 * arquivamento duplicado do #4366 (`scripts/update-audience.ts`) e garante
 * 1 issue GitHub por ocorrência (`family: "evento"` — nunca auto-fecha,
 * cada disparo é um fato histórico sobre um dia específico) via
 * `scripts/lib/alarm-issues.ts` — mesmo mecanismo já usado por
 * `clarice-guardrail-alarm.ts`/`edicao-diaria-staleness-alarm.ts`.
 *
 * Por que isto existe: o guard do #4366 SEMPRE funcionou (acertou as 5
 * ocorrências medidas em #8148) — o problema era o canal (`console.warn` +
 * linha em `data/run-log.jsonl`, que ninguém lê rotineiramente). Esta task
 * fecha esse loop sem mudar o guard em si.
 *
 * Lógica pura em `scripts/lib/audience-profile-staleness-alarm.ts` — este
 * arquivo é só I/O (leitura do run-log, dedup/criação de issue via
 * `alarm-issues.ts`).
 *
 * Uso:
 *   npx tsx scripts/audience-profile-staleness-alarm.ts               # avalia + cria/reusa issue por ocorrência
 *   npx tsx scripts/audience-profile-staleness-alarm.ts --dry-run      # avalia + imprime, NÃO chama gh nem persiste
 *
 * Estado: `data/audience-profile-staleness-alarm-issues.json` (tracking de
 * issue por ocorrência, via `alarm-issues.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveRunLogPath } from "./lib/run-log.ts";
import {
  findDuplicateArchiveEntries,
  buildAlarmFindings,
} from "./lib/audience-profile-staleness-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "audience-profile-staleness-alarm-issues.json");
const LOG_PREFIX = "[audience-profile-staleness-alarm]";
/** `family: "evento"` nunca fecha de fato via este caminho (ver docstring
 * da lib) — o valor só satisfaz a assinatura de `applyAlarmReconciliation`,
 * mesmo padrão dos outros alarmes "evento" do repo (ex:
 * `clarice-guardrail-alarm.ts`). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

function main(): void {
  const dryRun = hasFlag(process.argv, "dry-run");
  const logPath = resolveRunLogPath(ROOT);

  if (!existsSync(logPath)) {
    console.log(`${LOG_PREFIX} ${logPath} ausente — nada a avaliar.`);
    return;
  }

  const lines = readFileSync(logPath, "utf8").split("\n");
  const entries = findDuplicateArchiveEntries(lines);

  if (entries.length === 0) {
    console.log(`${LOG_PREFIX} nenhuma ocorrência do guard #4366 encontrada em ${logPath}.`);
    return;
  }

  const findings = buildAlarmFindings(entries);
  console.log(`${LOG_PREFIX} ${entries.length} ocorrência(s) do guard #4366 encontrada(s).`);

  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);

  if (dryRun) {
    const actions = planAlarmReconciliation(findings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
    return;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, alarmState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);

  for (const o of findingOutcomes) {
    if (o.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada (${o.fingerprint}): ${o.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${o.issueNumber} (${o.action}): ${o.url}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
