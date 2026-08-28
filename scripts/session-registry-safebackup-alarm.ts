#!/usr/bin/env node
/**
 * scripts/session-registry-safebackup-alarm.ts (#6130)
 *
 * Task periódica — detecta e alarma a presença de qualquer cópia de
 * conflito do OneDrive (`*-safeBackup-*`) em `data/sessions/` (ver
 * "Defeito 2" da issue #6130: o sync pode bifurcar o arquivo de claims de
 * uma sessão, e a presença de um backup é o sinal observável disso, mesmo
 * que `is-claimed` já mitigue o risco lendo a UNIÃO dos claims — ver
 * `scripts/lib/session-registry.ts`).
 *
 * Lógica pura em `scripts/lib/session-registry-safebackup-alarm.ts`
 * (`buildSafeBackupFindings`) — este arquivo é só I/O: lista os arquivos
 * (`listSafeBackupFiles`), cria/reusa/fecha issue via
 * `scripts/lib/alarm-issues.ts` (mesmo padrão de
 * `scripts/onedrive-sync-alarm.ts`). Sem canário/e-mail — a issue automática
 * já é o alarme; adicionar e-mail é trivial de acrescentar depois se o
 * editor pedir mais visibilidade.
 *
 * Uso:
 *   npx tsx scripts/session-registry-safebackup-alarm.ts              # avalia + cria/reusa/fecha issue
 *   npx tsx scripts/session-registry-safebackup-alarm.ts --dry-run     # avalia + imprime, NÃO chama gh
 *
 * Guard de máquina sem `data/` (sessão cloud, clone fresco): pulado
 * inteiramente, sem I/O em diretório inexistente — mesmo padrão dos demais
 * alarmes locais do repo.
 *
 * Estado: `data/.session-registry-safebackup-alarm-issues.json` (tracking de
 * issue por achado, `alarm-issues.ts`).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { listSafeBackupFiles } from "./lib/session-registry.ts";
import {
  resolveSafeBackupFindings,
  SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD,
} from "./lib/session-registry-safebackup-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const ALARM_ISSUES_STATE_PATH = join(DATA_DIR, ".session-registry-safebackup-alarm-issues.json");
const LOG_PREFIX = "[session-registry-safebackup-alarm]";
/** Mesma ordem de grandeza dos demais alarmes diários do repo
 * (`onedrive-sync-alarm.ts`, `beehiiv-home-meta-check.ts`). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

function loadAlarmIssuesState(): AlarmIssuesState {
  if (!existsSync(ALARM_ISSUES_STATE_PATH)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(ALARM_ISSUES_STATE_PATH, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch (e) {
    console.error(
      `${LOG_PREFIX} estado de alarm-issues corrompido/ilegível em ${ALARM_ISSUES_STATE_PATH} — resetando pra vazio: ${(e as Error).message}`,
    );
    return emptyAlarmIssuesState();
  }
}

function saveAlarmIssuesState(state: AlarmIssuesState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(ALARM_ISSUES_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");

  const dataDirExists = existsSync(DATA_DIR);
  if (!dataDirExists) {
    console.log(`${LOG_PREFIX} data/ ausente nesta máquina (sessão cloud/clone fresco) — nada a checar.`);
    return;
  }

  const backupFiles = listSafeBackupFiles(ROOT);
  console.log(
    `${LOG_PREFIX} data/sessions/ backups de conflito encontrados: ${backupFiles.length}` +
      (backupFiles.length ? ` (${backupFiles.join(", ")})` : ""),
  );

  const state = loadAlarmIssuesState();
  const stateIsEmpty = Object.keys(state).length === 0;
  const findings = resolveSafeBackupFindings(backupFiles, stateIsEmpty);
  if (stateIsEmpty && backupFiles.length > SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD) {
    console.log(
      `${LOG_PREFIX} modo de estreia (#6562): ${backupFiles.length} backups agregados numa única issue ` +
        `(state local vazio + acima do teto de ${SAFE_BACKUP_ESTREIA_AGGREGATE_THRESHOLD}).`,
    );
  }

  if (isDryRun) {
    const actions = planAlarmReconciliation(findings, state, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, estado NÃO gravado.`,
    );
    return;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, state, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState);
  for (const outcome of findingOutcomes) {
    if (outcome.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada pra ${outcome.fingerprint}: ${outcome.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}) pra ${outcome.fingerprint}: ${outcome.url}`);
    }
  }
  if (findings.length === 0) {
    console.log(`${LOG_PREFIX} nenhum backup de conflito presente — nada a fazer.`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
