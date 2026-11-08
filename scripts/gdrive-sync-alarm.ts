#!/usr/bin/env node
/**
 * scripts/gdrive-sync-alarm.ts (#12357, épica #12353)
 *
 * Task `Diaria-GDrive-Sync-Alarm` (de hora em hora): alarme do `rclone
 * bisync` do Google Drive no `300` (#12356) — o equivalente, pro backend
 * novo, do `scripts/onedrive-sync-alarm.ts` (#5548), que segue rodando
 * igual enquanto `data/` estiver no OneDrive (cutover na #12359). Dois
 * sinais, cada um com achado próprio:
 *
 *   1. Sync (`check: "gdrive-sync"`): lê os carimbos que o
 *      `scripts/systemd/gdrive-bisync.sh` grava a cada rodada
 *      (`last-run.json`/`last-success.json` no state dir) e decide entre
 *      trava persistente (exit 75), falha persistente (outro exit) e sync
 *      sem sucesso há tempo demais. Lógica pura em `lib/gdrive-sync-alarm.ts`.
 *   2. Cota (`check: "gdrive-quota"`): `rclone about gdrive: --json`, só
 *      leitura. Lógica pura em `lib/gdrive-quota.ts`.
 *
 * Canal de alerta: o mesmo do alarme do OneDrive — issue por achado
 * (`alarm-issues.ts`, fecha sozinha depois de 2 execuções limpas) e e-mail
 * pelo portão `notifyEditorForOutcomes` (severidade `acao`).
 *
 * **GUARD (invariável):** só leitura. Nunca roda o bisync, nunca chama
 * `systemctl start/stop/restart/enable`, nunca escreve no Drive nem no HD.
 *
 * **Máquina sem bisync** (toda máquina menos o `300`, e o próprio `300`
 * antes da instalação): sem `last-run.json` o sinal de sync é
 * `not-installed`, silencioso; a cota sem rclone/remote é `unmeasured`. Nos
 * dois casos as issues já abertas ficam congeladas (não fecham por falta de
 * medida, #10520).
 *
 * Prioridade: o sync parado é P1 quando o `data/` desta máquina já mora no
 * Google Drive (`detectDataSyncBackend`, depois do cutover o merge lock e o
 * `session-registry` param de atravessar máquinas) e P2 antes disso (só a
 * cópia do Drive no HD fica para trás).
 *
 * Uso:
 *   npx tsx scripts/gdrive-sync-alarm.ts                       # avalia + alarma
 *   npx tsx scripts/gdrive-sync-alarm.ts --dry-run             # avalia + imprime, NÃO cria issue nem envia
 *   npx tsx scripts/gdrive-sync-alarm.ts --to email@x          # destinatário do e-mail
 *   npx tsx scripts/gdrive-sync-alarm.ts --state-dir DIR       # carimbos (default $GDRIVE_STATE_DIR ou ~/.cache/diaria/gdrive-bisync)
 *   npx tsx scripts/gdrive-sync-alarm.ts --stale-hours 6       # tolerância do sync sem sucesso (default 6)
 *   npx tsx scripts/gdrive-sync-alarm.ts --blocked-minutes 60  # tolerância da trava (exit 75, default 60)
 *   npx tsx scripts/gdrive-sync-alarm.ts --failed-minutes 30   # tolerância da falha (outro exit, default 30)
 *   npx tsx scripts/gdrive-sync-alarm.ts --quota-warn-pct 90   # aviso de cota (default 90)
 *   npx tsx scripts/gdrive-sync-alarm.ts --remote gdrive:      # remote do rclone (default gdrive:)
 *
 * Env: `RCLONE_BIN` (default `~/.local/bin/rclone`), `GDRIVE_STATE_DIR`.
 * Estado das issues: `data/.gdrive-sync-alarm-issues.json` (sem `data/`, no
 * state dir).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import {
  parseBisyncStamp,
  evaluateGdriveSync,
  isAlarmingGdriveSyncVerdict,
  describeGdriveSyncVerdict,
  DEFAULT_GDRIVE_SYNC_TOLERANCES,
  type BisyncStamp,
  type GdriveSyncEvaluation,
} from "./lib/gdrive-sync-alarm.ts";
import {
  readRcloneAbout,
  resolveRcloneBin,
  evaluateGdriveQuota,
  isAlarmingGdriveQuotaVerdict,
  buildGdriveQuotaCauseText,
  DEFAULT_GDRIVE_QUOTA_WARN_PCT,
  DEFAULT_GDRIVE_REMOTE,
  type GdriveQuotaEvaluation,
} from "./lib/gdrive-quota.ts";
import { detectDataSyncBackend, type DataSyncBackend } from "./lib/exec-mode.ts";
import { notifyEditorForOutcomes } from "./lib/editor-notify.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  alarmIssueStateKey,
  ALARM_ACTION_LABEL,
  type AlarmFinding,
  type AlarmFindingOutcome,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[gdrive-sync-alarm]";
/** De hora em hora, 2 execuções limpas = ~2h sem o achado (mesmo número do
 * alarme do OneDrive). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

export const SYNC_CHECK = "gdrive-sync";
export const QUOTA_CHECK = "gdrive-quota";

export function defaultGdriveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GDRIVE_STATE_DIR && env.GDRIVE_STATE_DIR.length > 0
    ? env.GDRIVE_STATE_DIR
    : join(homedir(), ".cache", "diaria", "gdrive-bisync");
}

/** Lê um carimbo do state dir. Ausente → `null`; ilegível → `null` com aviso
 * (um carimbo corrompido conta como ausente, nunca como sucesso). */
export function readBisyncStamp(path: string): BisyncStamp | null {
  if (!existsSync(path)) return null;
  try {
    const stamp = parseBisyncStamp(JSON.parse(readFileSync(path, "utf8")));
    if (!stamp) console.error(`${LOG_PREFIX} carimbo inválido em ${path} — tratando como ausente.`);
    return stamp;
  } catch (e) {
    console.error(`${LOG_PREFIX} carimbo ilegível em ${path} — tratando como ausente: ${(e as Error).message}`);
    return null;
  }
}

export function toSyncAlarmFinding(ev: GdriveSyncEvaluation, backend: DataSyncBackend): AlarmFinding {
  return {
    check: SYNC_CHECK,
    fingerprint: ev.verdict,
    title: `[diar.ia.br] Google Drive sync: ${ev.verdict}`,
    body: [
      "Achado automático do alarme `Diaria-GDrive-Sync-Alarm` (`scripts/gdrive-sync-alarm.ts`, #12357).",
      "",
      describeGdriveSyncVerdict(ev),
      "",
      backend === "gdrive"
        ? "O `data/` desta máquina já mora no Google Drive: com o sync parado, merge lock e `session-registry` param de atravessar máquinas."
        : `O \`data/\` desta máquina ainda não está no Google Drive (backend: ${backend}); fica para trás só a cópia do Drive no HD.`,
      "",
      "Esta issue é criada automaticamente pelo alarme e será comentada/fechada sozinha quando o achado deixar de",
      `reproduzir por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    // Trava e falha persistentes só normalizam por AÇÃO (montar o HD,
    // recriar a sentinela, `--force`/`--resync`) — mesmo raciocínio do
    // #7701. O sync sem sucesso há tempo é ambíguo (pode se resolver
    // sozinho), fica `alarm` puro.
    labels: ev.verdict === "alarm-sync-stale" ? ["bug"] : ["bug", ALARM_ACTION_LABEL],
    priority: backend === "gdrive" ? "P1" : "P2",
    family: "estado",
  };
}

export function toQuotaAlarmFinding(ev: GdriveQuotaEvaluation): AlarmFinding {
  return {
    check: QUOTA_CHECK,
    fingerprint: ev.verdict,
    title: `[diar.ia.br] Google Drive cota: ${ev.verdict}`,
    body: [
      "Achado automático do alarme `Diaria-GDrive-Sync-Alarm` (`scripts/gdrive-sync-alarm.ts`, sinal de cota, #12357).",
      "",
      buildGdriveQuotaCauseText(ev),
      "",
      "Esta issue é criada automaticamente pelo alarme e será comentada/fechada sozinha quando o achado deixar de",
      `reproduzir por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug", ALARM_ACTION_LABEL],
    priority: ev.verdict === "quota-full" ? "P1" : "P2",
    family: "estado",
  };
}

/** Chaves cujas issues ficam congeladas nesta execução: sync sem bisync
 * instalado e cota sem medida não provam que o problema sumiu (#10520). */
export function absenceUnmeasured(
  syncVerdict: GdriveSyncEvaluation["verdict"],
  quotaVerdict: GdriveQuotaEvaluation["verdict"],
): (key: string) => boolean {
  const keys = new Set<string>();
  if (syncVerdict === "not-installed") {
    for (const f of ["alarm-bisync-blocked", "alarm-bisync-failed", "alarm-sync-stale"]) keys.add(alarmIssueStateKey(SYNC_CHECK, f));
  }
  if (quotaVerdict === "unmeasured") {
    for (const f of ["quota-full", "quota-near"]) keys.add(alarmIssueStateKey(QUOTA_CHECK, f));
  }
  return (key) => keys.has(key);
}

function issueLineFor(outcome: AlarmFindingOutcome): string {
  return outcome.action === "failed"
    ? `\n\nIssue: falha ao criar/reusar (${outcome.error})`
    : `\n\nIssue: #${outcome.issueNumber} (${outcome.url})`;
}

export function buildGdriveAlarmEmail(
  qualifying: readonly AlarmFindingOutcome[],
  sync: GdriveSyncEvaluation,
  quota: GdriveQuotaEvaluation,
): { subject: string; body: string } {
  const parts: string[] = [];
  const subjects: string[] = [];
  const s = qualifying.find((o) => o.check === SYNC_CHECK);
  const q = qualifying.find((o) => o.check === QUOTA_CHECK);
  if (s) {
    parts.push(`${describeGdriveSyncVerdict(sync)}${issueLineFor(s)}`);
    subjects.push(sync.verdict);
  }
  if (q) {
    parts.push(`${buildGdriveQuotaCauseText(quota)}${issueLineFor(q)}`);
    subjects.push(`cota ${quota.verdict}`);
  }
  return {
    subject: `⚠️ Google Drive: ${subjects.join(" + ")}`,
    body: parts.join("\n\n---\n\n") + "\n\nAchado automático de `Diaria-GDrive-Sync-Alarm` (#12357).",
  };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const stateDir = getStringArg(argv, "state-dir", { example: "~/.cache/diaria/gdrive-bisync" }) ?? defaultGdriveStateDir();
  const staleHours = getIntArg(argv, "stale-hours", { min: 1 });
  const blockedMinutes = getIntArg(argv, "blocked-minutes", { min: 1 });
  const failedMinutes = getIntArg(argv, "failed-minutes", { min: 1 });
  const warnPct = getIntArg(argv, "quota-warn-pct", { min: 1, max: 100 }) ?? DEFAULT_GDRIVE_QUOTA_WARN_PCT;
  const remote = getStringArg(argv, "remote", { example: "gdrive:" }) ?? DEFAULT_GDRIVE_REMOTE;
  const tol = {
    staleMs: staleHours !== undefined ? staleHours * 3_600_000 : DEFAULT_GDRIVE_SYNC_TOLERANCES.staleMs,
    blockedMs: blockedMinutes !== undefined ? blockedMinutes * 60_000 : DEFAULT_GDRIVE_SYNC_TOLERANCES.blockedMs,
    failedMs: failedMinutes !== undefined ? failedMinutes * 60_000 : DEFAULT_GDRIVE_SYNC_TOLERANCES.failedMs,
  };

  const now = new Date();
  const lastRun = readBisyncStamp(join(stateDir, "last-run.json"));
  const lastSuccess = readBisyncStamp(join(stateDir, "last-success.json"));
  const sync = evaluateGdriveSync(lastRun, lastSuccess, now, tol);
  const backend = detectDataSyncBackend({ projectRoot: ROOT });
  console.log(
    `${LOG_PREFIX} sync: verdict=${sync.verdict} lastRun=${lastRun ? `${lastRun.at}/exit ${lastRun.exit}` : "nenhuma"} ` +
      `lastSuccess=${lastSuccess?.at ?? "nenhum"} stateDir=${stateDir} data=${backend}`,
  );

  const quota = evaluateGdriveQuota(readRcloneAbout(resolveRcloneBin(), remote), warnPct);
  console.log(
    `${LOG_PREFIX} cota: verdict=${quota.verdict} usedPct=${quota.usedPct === null ? "n/a" : quota.usedPct.toFixed(1)} warn=${warnPct}%`,
  );

  const findings: AlarmFinding[] = [];
  if (isAlarmingGdriveSyncVerdict(sync.verdict)) findings.push(toSyncAlarmFinding(sync, backend));
  if (isAlarmingGdriveQuotaVerdict(quota.verdict)) findings.push(toQuotaAlarmFinding(quota));

  const statePath = join(existsSync(DATA_DIR) ? DATA_DIR : stateDir, ".gdrive-sync-alarm-issues.json");
  const alarmState = loadAlarmIssuesState(statePath);
  const isAbsenceUnmeasured = absenceUnmeasured(sync.verdict, quota.verdict);

  if (isDryRun) {
    const actions = planAlarmReconciliation(findings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS, [], isAbsenceUnmeasured);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, e-mail NÃO avaliado.`,
    );
    return;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, alarmState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    isAbsenceUnmeasured,
  });
  saveAlarmIssuesState(nextState, statePath);
  for (const o of findingOutcomes) {
    if (o.action === "failed") console.error(`${LOG_PREFIX} issue não criada/reusada: ${o.error}`);
    else console.log(`${LOG_PREFIX} issue #${o.issueNumber} (${o.action}): ${o.url}`);
  }
  if (findingOutcomes.length === 0) {
    console.log(`${LOG_PREFIX} nenhum achado — nenhum alarme necessário.`);
    return;
  }

  const result = await notifyEditorForOutcomes(
    findingOutcomes,
    "acao",
    (qualifying) => buildGdriveAlarmEmail(qualifying, sync, quota),
    {
      cwd: ROOT,
      platformConfigPath: PLATFORM_CONFIG_PATH,
      emailTo: toOverride,
      // Fingerprint É o verdict: o mesmo achado reusa a issue e não reenvia
      // sob `email_policy: "legacy"`; verdict novo gera issue e e-mail novos
      // (mesma escolha do alarme do OneDrive, #8271).
      legacyResendIntent: "dedupe-new-occurrences-only",
    },
  );
  if (result.qualifying.length === 0) {
    console.log(`${LOG_PREFIX} política '${result.emailPolicy}': nenhum e-mail necessário pra este outcome.`);
  } else if (result.emailSent) {
    console.log(`${LOG_PREFIX} e-mail de alarme enviado.`);
  } else {
    console.error(`${LOG_PREFIX} falha ao enviar e-mail: ${result.emailError}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
