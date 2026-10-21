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
 * Lógica pura em `scripts/lib/beehiiv-backup-staleness-alarm.ts` — este
 * arquivo é só I/O (existsSync via `beehiiv-backup-snapshots.ts`, envio de
 * e-mail). **NUNCA chama a API Beehiiv ao vivo** — leitura local apenas
 * (guard de publicação do overnight/develop).
 *
 * Uso:
 *   npx tsx scripts/beehiiv-backup-staleness-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/beehiiv-backup-staleness-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/beehiiv-backup-staleness-alarm.ts --to email@x   # override do destinatário
 *   npx tsx scripts/beehiiv-backup-staleness-alarm.ts --root data/beehiiv-backup --state data/beehiiv-backup/staleness-alarm-state.json
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais) pra ENVIAR o alarme — a checagem em si não
 * precisa de credencial nenhuma. Requer o junction `data/` (OneDrive) pra
 * ler os snapshots e persistir o state.
 *
 * Estado (idempotência): `data/beehiiv-backup/staleness-alarm-state.json` —
 * 1 alarme por (veredito, snapshot mais recente), mesmo padrão de
 * `linkedin-weekly-staleness-alarm.ts` (#5111).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import { latestSnapshotDate, isSubscribersSnapshotUsable, listSnapshotDates } from "./lib/beehiiv-backup-snapshots.ts";
import { exitHistoryDrainStatus } from "./lib/beehiiv-exit-history.ts";
import { snapshotDateToEpochSeconds } from "./lib/acquisition-health.ts";
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
    };
  } catch {
    return emptyBeehiivBackupStalenessAlarmState();
  }
}

export function saveState(state: BeehiivBackupStalenessAlarmState, statePath: string): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadProjectEnv();
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
    const result = await notifyEditor({ check, fingerprint, severity: "acao", subject, body }, { cwd: ROOT, emailTo: toOverride });
    if (result.issue?.action === "failed") {
      throw new Error(`ensureAlarmIssue falhou (${check}): ${result.issue.error}`);
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
  if (missingMonths.length > 0) {
    const fp = computeCoverageFingerprint(missingMonths);
    if (fp !== state.lastCoverageFingerprint) {
      const { subject, body } = buildCoverageAlarmEmail(missingMonths);
      if (await notify("beehiiv-backup-monthly-coverage", fp, subject, body)) {
        state = { ...state, lastCoverageFingerprint: fp };
        saveState(state, statePath);
      }
    }
  }

  // 3) exit-history (#10710/#7248): o drain via MCP precisa ter rodado inteiro.
  const exitManifestPath = resolve(root, "exit-history/manifest.json");
  const exitStatus = exitHistoryDrainStatus(existsSync(exitManifestPath) ? readFileSync(exitManifestPath, "utf8") : null);
  console.log(`${LOG_PREFIX} exit-history: ${exitStatus}`);
  if (exitStatus !== "complete") {
    const fp = computeExitHistoryFingerprint(exitStatus);
    if (fp !== state.lastExitHistoryFingerprint) {
      const { subject, body } = buildExitHistoryAlarmEmail(exitStatus);
      if (await notify("beehiiv-exit-history", fp, subject, body)) {
        state = { ...state, lastExitHistoryFingerprint: fp };
        saveState(state, statePath);
      }
    }
  }

  // O estado é gravado logo após cada alarme registrado (um throw no 2º não
  // faz o 1º reenviar na próxima rodada).
  if (isDryRun) console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
