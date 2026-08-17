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
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { latestSnapshotDate, isSubscribersSnapshotUsable } from "./lib/beehiiv-backup-snapshots.ts";
import { snapshotDateToEpochSeconds } from "./lib/acquisition-health.ts";
import {
  evaluateBeehiivBackupStalenessAlarm,
  shouldSendBeehiivBackupStalenessAlarm,
  markBeehiivBackupStalenessAlarmed,
  emptyBeehiivBackupStalenessAlarmState,
  buildBeehiivBackupStalenessAlarmEmail,
  type BeehiivBackupStalenessAlarmState,
} from "./lib/beehiiv-backup-staleness-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
const DEFAULT_STATE_PATH = resolve(ROOT, "data/beehiiv-backup/staleness-alarm-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const MAX_AGE_DAYS = 7;
const LOG_PREFIX = "[beehiiv-backup-staleness-alarm]";

export function loadState(statePath: string): BeehiivBackupStalenessAlarmState {
  if (!existsSync(statePath)) return emptyBeehiivBackupStalenessAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<BeehiivBackupStalenessAlarmState>;
    return {
      lastAlarmedFingerprint: typeof raw.lastAlarmedFingerprint === "string" ? raw.lastAlarmedFingerprint : null,
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

  const state = loadState(statePath);
  if (!shouldSendBeehiivBackupStalenessAlarm(evaluation, state)) {
    console.log(
      evaluation.verdict === "ok" || evaluation.verdict === "ok-too-early"
        ? `${LOG_PREFIX} nada a alarmar (${evaluation.verdict}).`
        : `${LOG_PREFIX} já alarmado pra este estado (${evaluation.verdict}, ${latest ?? "nenhum"}) — não reenvia.`,
    );
    return;
  }

  const { subject, body } = buildBeehiivBackupStalenessAlarmEmail(evaluation, MAX_AGE_DAYS);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markBeehiivBackupStalenessAlarmed(evaluation), statePath);
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (verdict=${evaluation.verdict}).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
