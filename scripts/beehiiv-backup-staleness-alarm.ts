#!/usr/bin/env node
/**
 * scripts/beehiiv-backup-staleness-alarm.ts (#5494)
 *
 * Task semanal (domingo 04:00 BRT, ver `scripts/lib/scheduled-tasks.ts`):
 * checa se o snapshot mais recente de `data/beehiiv-backup/` (task
 * `Diaria-Beehiiv-Backup`, domingo 03:00) é recente E utilizável — e alarma
 * o editor por e-mail se não for. Fecha o buraco de observabilidade da issue
 * #5494 item 3: sem isso, um domingo pulado é indistinguível de "já avaliado
 * nesta semana" no journal de `check-acquisition-health.ts` (domingo 03:30),
 * que roda logo depois e nunca dispara e-mail sozinho pra esse caso.
 *
 * Desde #10710 faz mais 2 checks independentes, cada um com fingerprint
 * próprio: cobertura mensal (mês fechado sem nenhum snapshot = snapshots
 * apagados depois de gravados) e exit-history (`exit-history/manifest.json`
 * ausente ou incompleto = o drain via MCP do #7248 não rodou inteiro).
 *
 * Desde #11413 confere também a cópia off-site no bucket R2 privado
 * `diaria-backup` (`scripts/backup-offsite.ts`): lista `beehiiv/` e
 * `eia-votes/` pela API S3 ASSINADA (ListObjectsV2, credencial
 * `R2_ACCOUNT_ID` + `R2_BACKUP_ACCESS_KEY_ID`/`R2_BACKUP_SECRET_ACCESS_KEY`)
 * e exige que a data da chave do objeto mais recente de cada prefixo tenha
 * até 7 dias (+1 de folga). Sem essas vars o check gera alarme
 * (`remote:no-credentials`), nunca "ok". Esta é a única chamada de rede do
 * script — o `--dry-run` também lista (só leitura).
 *
 * Lógica pura em `scripts/lib/beehiiv-backup-staleness-alarm.ts` — este
 * arquivo é só I/O (existsSync via `beehiiv-backup-snapshots.ts`, LIST no
 * R2, envio de e-mail). **NUNCA chama a API Beehiiv ao vivo** — leitura
 * local dos snapshots (guard de publicação do overnight/develop).
 *
 * Os 4 checks rodam sempre; falha ao registrar um alarme (`ensureAlarmIssue`)
 * é acumulada e o script lança só no fim, depois dos 4.
 *
 * Uso:
 *   npx tsx scripts/beehiiv-backup-staleness-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/beehiiv-backup-staleness-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/beehiiv-backup-staleness-alarm.ts --to email@x   # override do destinatário
 *   npx tsx scripts/beehiiv-backup-staleness-alarm.ts --root data/beehiiv-backup --state data/beehiiv-backup/staleness-alarm-state.json
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais) pra ENVIAR o alarme; `R2_ACCOUNT_ID` +
 * `R2_BACKUP_*` pro check remoto (no `.env` do 300, que a task systemd lê).
 * Requer o junction `data/` (OneDrive) pra ler os snapshots e persistir o
 * state.
 *
 * Estado (idempotência): `data/beehiiv-backup/staleness-alarm-state.json`,
 * com 4 fingerprints independentes — `lastAlarmedFingerprint` (veredito +
 * snapshot mais recente, mesmo padrão de `linkedin-weekly-staleness-alarm.ts`,
 * #5111), `lastCoverageFingerprint` e `lastExitHistoryFingerprint` (#10710)
 * e `lastRemoteFingerprint` (#11413). Os 3 últimos voltam a `null` quando o
 * check fica ok (#10780).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { notifyEditor, type NotifyEditorFinding, type NotifyEditorResult } from "./lib/editor-notify.ts";
import { latestSnapshotDate, isSubscribersSnapshotUsable, listSnapshotDates } from "./lib/beehiiv-backup-snapshots.ts";
import { exitHistoryDrainStatus } from "./lib/beehiiv-exit-history.ts";
import { snapshotDateToEpochSeconds } from "./lib/acquisition-health.ts";
import { checkRemoteOffsiteBackup, describeRemotePrefix, type RemoteOffsiteEvaluation } from "./lib/backup-offsite.ts";
import {
  evaluateBeehiivBackupStalenessAlarm,
  shouldSendBeehiivBackupStalenessAlarm,
  markBeehiivBackupStalenessAlarmed,
  emptyBeehiivBackupStalenessAlarmState,
  buildBeehiivBackupStalenessAlarmEmail,
  computeBeehiivBackupStalenessFingerprint,
  findMonthsWithoutSnapshot,
  computeCoverageFingerprint,
  buildCoverageAlarmEmail,
  computeExitHistoryFingerprint,
  buildExitHistoryAlarmEmail,
  buildRemoteOffsiteAlarmEmail,
  planFingerprintedAlarm,
  type BeehiivBackupStalenessAlarmState,
} from "./lib/beehiiv-backup-staleness-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
const DEFAULT_STATE_PATH = resolve(ROOT, "data/beehiiv-backup/staleness-alarm-state.json");
const MAX_AGE_DAYS = 7;
const LOG_PREFIX = "[beehiiv-backup-staleness-alarm]";

export function loadState(statePath: string): BeehiivBackupStalenessAlarmState {
  if (!existsSync(statePath)) return emptyBeehiivBackupStalenessAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<BeehiivBackupStalenessAlarmState>;
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    return {
      lastAlarmedFingerprint: str(raw.lastAlarmedFingerprint),
      lastCoverageFingerprint: str(raw.lastCoverageFingerprint),
      lastExitHistoryFingerprint: str(raw.lastExitHistoryFingerprint),
      lastRemoteFingerprint: str(raw.lastRemoteFingerprint),
    };
  } catch {
    return emptyBeehiivBackupStalenessAlarmState();
  }
}

export function saveState(state: BeehiivBackupStalenessAlarmState, statePath: string): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Dependências injetáveis (#11413): teste nenhum pode alcançar o R2 real nem
 * o `gh`. Default: LIST real no bucket com `fetch` global e `process.env`, e
 * `notifyEditor` real.
 */
export interface AlarmMainDeps {
  checkRemote?: (maxAgeDays: number) => Promise<RemoteOffsiteEvaluation>;
  notify?: (finding: NotifyEditorFinding, opts: { cwd: string; emailTo?: string }) => Promise<NotifyEditorResult>;
  /** Não carrega o `.env` (teste). Default `false`. */
  skipEnvLoad?: boolean;
}

const defaultCheckRemote = (maxAgeDays: number) =>
  checkRemoteOffsiteBackup({ fetch: (u, i) => fetch(u, i), now: () => new Date() }, process.env, maxAgeDays);

export async function main(argv: string[] = process.argv.slice(2), deps: AlarmMainDeps = {}): Promise<void> {
  if (!deps.skipEnvLoad) loadProjectEnv();
  const notifyFn = deps.notify ?? ((f, o) => notifyEditor(f, o));
  const notifyFailures: string[] = [];
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const root = getArg(argv, "root") || DEFAULT_BACKUP_ROOT;
  const statePath = getArg(argv, "state") || DEFAULT_STATE_PATH;

  const latest = latestSnapshotDate(root);
  const latestEpoch = latest ? snapshotDateToEpochSeconds(latest) : null;
  const usable = latest ? isSubscribersSnapshotUsable(root, latest).usable : false;

  const evaluation = evaluateBeehiivBackupStalenessAlarm(Date.now() / 1000, latest, latestEpoch, usable, MAX_AGE_DAYS);
  console.log(
    `${LOG_PREFIX} latest=${latest ?? "nenhum"} ageDays=${evaluation.ageDays ?? "n/d"} verdict=${evaluation.verdict}`,
  );

  let state = loadState(statePath);
  const notify = async (check: string, fingerprint: string, subject: string, body: string): Promise<boolean> => {
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: registraria alarme (${check}):\n--- subject ---\n${subject}\n--- body ---\n${body}`);
      return false;
    }
    // #7960: portão notifyEditor — severidade "acao" (sem envio/dinheiro em
    // risco), issue sem e-mail sob `email_policy: "urgent_only"`.
    // #11413: falha num check não impede os seguintes; acumula e lança no fim.
    let result: NotifyEditorResult;
    try {
      result = await notifyFn({ check, fingerprint, severity: "acao", subject, body }, { cwd: ROOT, emailTo: toOverride });
    } catch (e) {
      notifyFailures.push(`${check}: ${(e as Error).message}`);
      return false;
    }
    if (result.issue?.action === "failed") {
      notifyFailures.push(`ensureAlarmIssue falhou (${check}): ${result.issue.error}`);
      return false;
    }
    console.log(`${LOG_PREFIX} alarme registrado (${check}, issue #${result.issue?.issueNumber ?? "?"}).`);
    return true;
  };

  // 1) snapshot mais recente: ausente/vencido/inutilizável (#5494).
  if (!shouldSendBeehiivBackupStalenessAlarm(evaluation, state)) {
    console.log(
      evaluation.verdict === "ok" || evaluation.verdict === "ok-too-early"
        ? `${LOG_PREFIX} nada a alarmar (${evaluation.verdict}).`
        : `${LOG_PREFIX} já alarmado pra este estado (${evaluation.verdict}, ${latest ?? "nenhum"}) — não reenvia.`,
    );
  } else {
    const { subject, body } = buildBeehiivBackupStalenessAlarmEmail(evaluation, MAX_AGE_DAYS);
    // Fingerprint pelo par (veredito, snapshot mais recente) — não só o
    // veredito (#7969).
    if (await notify("beehiiv-backup-staleness-alarm", computeBeehiivBackupStalenessFingerprint(evaluation), subject, body)) {
      state = { ...state, ...markBeehiivBackupStalenessAlarmed(evaluation) };
      saveState(state, statePath);
    }
  }

  // 2) cobertura mensal (#10710): mês fechado sem nenhum snapshot = snapshots
  //    apagados depois de gravados. Só olha o disco local.
  const todayIso = new Date().toISOString().slice(0, 10);
  const missingMonths = findMonthsWithoutSnapshot(listSnapshotDates(root), todayIso);
  console.log(`${LOG_PREFIX} cobertura mensal: ${missingMonths.length === 0 ? "ok" : `faltando ${missingMonths.join(", ")}`}`);
  const coverageFp = missingMonths.length > 0 ? computeCoverageFingerprint(missingMonths) : null;
  const coverageAction = planFingerprintedAlarm(coverageFp, state.lastCoverageFingerprint);
  if (coverageAction === "send" && coverageFp) {
    const { subject, body } = buildCoverageAlarmEmail(missingMonths);
    if (await notify("beehiiv-backup-monthly-coverage", coverageFp, subject, body)) {
      state = { ...state, lastCoverageFingerprint: coverageFp };
      saveState(state, statePath);
    }
  } else if (coverageAction === "reset") {
    // #10780: voltou ao ok — zera, senão o mesmo conjunto sumindo de novo não alarma.
    state = { ...state, lastCoverageFingerprint: null };
    if (!isDryRun) saveState(state, statePath);
  }

  // 3) exit-history (#10710/#7248): o drain via MCP precisa ter rodado inteiro.
  const exitManifestPath = resolve(root, "exit-history/manifest.json");
  const exitStatus = exitHistoryDrainStatus(existsSync(exitManifestPath) ? readFileSync(exitManifestPath, "utf8") : null);
  console.log(`${LOG_PREFIX} exit-history: ${exitStatus}`);
  const exitFp = exitStatus !== "complete" ? computeExitHistoryFingerprint(exitStatus) : null;
  const exitAction = planFingerprintedAlarm(exitFp, state.lastExitHistoryFingerprint);
  if (exitAction === "send" && exitFp) {
    const { subject, body } = buildExitHistoryAlarmEmail(exitStatus);
    if (await notify("beehiiv-exit-history", exitFp, subject, body)) {
      state = { ...state, lastExitHistoryFingerprint: exitFp };
      saveState(state, statePath);
    }
  } else if (exitAction === "reset") {
    // #10780: manifest voltou a `complete` — zera, senão incompleto → completo → incompleto passa calado.
    state = { ...state, lastExitHistoryFingerprint: null };
    if (!isDryRun) saveState(state, statePath);
  }

  // 4) cópia off-site no R2 (#11413): o objeto mais recente de beehiiv/ e de
  //    eia-votes/ no bucket privado diaria-backup tem até MAX_AGE_DAYS (pela
  //    data da chave, +1 de folga). Credencial ausente é achado, nunca "ok".
  const remote = await (deps.checkRemote ?? defaultCheckRemote)(MAX_AGE_DAYS);
  const remoteLines = remote.configured ? remote.prefixes.map(describeRemotePrefix) : [];
  console.log(
    `${LOG_PREFIX} cópia off-site: ${remote.configured ? (remote.ok ? "ok" : "PROBLEMA") : `credencial ausente (${remote.missing.join(", ")})`}` +
      (remoteLines.length ? `\n  ${remoteLines.join("\n  ")}` : ""),
  );
  const remoteAction = planFingerprintedAlarm(remote.ok ? null : remote.fingerprint, state.lastRemoteFingerprint);
  if (remoteAction === "send" && remote.fingerprint) {
    const { subject, body } = buildRemoteOffsiteAlarmEmail({
      missingCredentials: remote.configured ? null : remote.missing,
      lines: remoteLines,
      maxAgeDays: MAX_AGE_DAYS,
    });
    if (await notify("backup-offsite-remote", remote.fingerprint, subject, body)) {
      state = { ...state, lastRemoteFingerprint: remote.fingerprint };
      saveState(state, statePath);
    }
  } else if (remoteAction === "reset") {
    state = { ...state, lastRemoteFingerprint: null };
    if (!isDryRun) saveState(state, statePath);
  }

  // O estado é gravado logo após cada alarme registrado ou fingerprint zerado
  // (um throw no 2º não faz o 1º reenviar na próxima rodada).
  if (isDryRun) console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
  if (notifyFailures.length) throw new Error(`${notifyFailures.length} alarme(s) não registrado(s): ${notifyFailures.join(" | ")}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
