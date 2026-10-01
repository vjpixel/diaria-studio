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
 * Fontes (#9232): além de `data/run-log.jsonl`, lê as cópias de conflito
 * `data/run-log-*.jsonl` e — independente de qualquer log — compara os
 * snapshots adjacentes de `docs/audience-history/`. O evento de 14/09/2026
 * sumiu de todos os run-logs e, lendo só o canônico, o alarme ficava cego
 * reportando `alarm=0`. As fontes são unidas por `today_file` (mesmo
 * fingerprint de issue), então nenhuma ocorrência vira 2 issues.
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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveRunLogPath } from "./lib/run-log.ts";
import {
  findDuplicateArchiveEntries,
  findDuplicateSnapshotEntries,
  selectRunLogFiles,
  mergeStalenessEntries,
  buildAlarmFindings,
  SNAPSHOT_SCAN_SINCE,
  type AudienceStalenessLogEntry,
  type SnapshotFile,
} from "./lib/audience-profile-staleness-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_DIR = resolve(ROOT, "docs", "audience-history");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "audience-profile-staleness-alarm-issues.json");
const LOG_PREFIX = "[audience-profile-staleness-alarm]";
/** `family: "evento"` nunca fecha de fato via este caminho (ver docstring
 * da lib) — o valor só satisfaz a assinatura de `applyAlarmReconciliation`,
 * mesmo padrão dos outros alarmes "evento" do repo (ex:
 * `clarice-guardrail-alarm.ts`). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** I/O: entradas do guard #4366 em `data/run-log.jsonl` + copias de conflito `run-log-*.jsonl` (#9232). */
function readRunLogEntries(logPath: string): { entries: AudienceStalenessLogEntry[]; filesRead: number } {
  const dir = dirname(logPath);
  if (!existsSync(dir)) return { entries: [], filesRead: 0 };
  const files = selectRunLogFiles(readdirSync(dir), basename(logPath));
  const perFile = files.map((f) => {
    try {
      return findDuplicateArchiveEntries(readFileSync(resolve(dir, f), "utf8").split("\n"));
    } catch (err) {
      console.warn(`${LOG_PREFIX} falha lendo ${f}: ${(err as Error).message}`);
      return [];
    }
  });
  return { entries: mergeStalenessEntries(...perFile), filesRead: files.length };
}

/** I/O: snapshots arquivados em `docs/audience-history/` (versionados, nao dependem do run-log ter sobrevivido — #9232). */
function readSnapshotFiles(historyDir: string): SnapshotFile[] {
  if (!existsSync(historyDir)) return [];
  return readdirSync(historyDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map((name) => ({ name, content: readFileSync(resolve(historyDir, name), "utf8") }));
}

function main(): void {
  const dryRun = hasFlag(process.argv, "dry-run");
  const logPath = resolveRunLogPath(ROOT);

  const { entries: logEntries, filesRead } = readRunLogEntries(logPath);
  const snapshots = readSnapshotFiles(HISTORY_DIR);
  const snapshotEntries = findDuplicateSnapshotEntries(snapshots);
  console.log(
    `${LOG_PREFIX} fontes: ${filesRead} run-log(s) em ${dirname(logPath)} (${logEntries.length} ocorrência(s)), ` +
      `${snapshots.length} snapshot(s) em ${HISTORY_DIR} (${snapshotEntries.length} par(es) idêntico(s) desde ${SNAPSHOT_SCAN_SINCE}).`,
  );
  if (snapshots.length === 0) {
    // Sem snapshots, a fonte independente do log está ausente — avisar em vez de
    // reportar "nenhuma ocorrência" como se o alarme estivesse enxergando (#9232).
    console.warn(`${LOG_PREFIX} AVISO: nenhum snapshot em ${HISTORY_DIR} — alarme depende só do run-log.`);
  }

  // run-log primeiro: quando o evento sobreviveu, preserva o timestamp real do disparo.
  const entries = mergeStalenessEntries(logEntries, snapshotEntries);

  if (entries.length === 0) {
    console.log(`${LOG_PREFIX} nenhuma ocorrência do guard #4366 encontrada (run-log + snapshots).`);
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
