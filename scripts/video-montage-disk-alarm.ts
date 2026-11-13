#!/usr/bin/env node
/**
 * scripts/video-montage-disk-alarm.ts (#12931)
 *
 * Alarme agendado (`Diaria-Video-Montage-Disk-Alarm`, diário à tarde): mede o
 * espaço livre no disco do cache do `/diaria-video-montagem` (a mesma raiz
 * que a montagem usa no modo API: `DIARIA_VIDEO_CACHE_DIR` ou
 * `~/.cache/diaria-video-montagem`) e abre uma issue quando fica abaixo do
 * piso que o `check-video-env.ts --montagem` exige (25 GB sem bruto
 * conhecido). Antes disso a falta de disco só aparecia na hora de montar o
 * vídeo (12/11/2026, 15,2 GB livres no `300`). Decisão pura em
 * `scripts/lib/diaria/video-montage-disk-alarm.ts`.
 *
 * Só lê (`statfs`): não limpa nada. O que liberar vem no corpo da issue
 * (`MONTAGE_DISK_FIX`). `DIARIA_VIDEO_CACHE_DIR` apontando para diretório
 * inexistente ou no disco do home (HD desmontado), ou espaço livre ilegível,
 * sai 1 (unit `failed`, o alarme de units pega), nunca "ok".
 *
 * Uso:
 *   npx tsx scripts/video-montage-disk-alarm.ts              # avalia, reconcilia a issue, e-mail se novo
 *   npx tsx scripts/video-montage-disk-alarm.ts --dry-run    # avalia e imprime; não chama gh nem e-mail
 *   npx tsx scripts/video-montage-disk-alarm.ts --cache-dir DIR   # outra raiz (testes)
 */
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { applyCliAction, type CliSpec, getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { freeBytes, videoCacheRoot, VideoCacheRootMissingError } from "./lib/diaria/video-montage-drive.ts";
import { evaluateMontageDisk, montageDiskFindings } from "./lib/diaria/video-montage-disk-alarm.ts";
import { notifyEditorForOutcomes } from "./lib/editor-notify.ts";
import { applyAlarmReconciliation, loadAlarmIssuesState, planAlarmReconciliation, saveAlarmIssuesState } from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "video-montage-disk-alarm", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[video-montage-disk-alarm]";
/** Task diária: 2 rodadas limpas seguidas (~2 dias) fecham a issue, mesmo default do repo. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

export const CLI_SPEC: CliSpec = {
  script: "scripts/video-montage-disk-alarm.ts",
  booleans: ["dry-run"],
  values: ["cache-dir", "to"],
};

async function main(): Promise<void> {
  const cliExit = applyCliAction(process.argv.slice(2), CLI_SPEC);
  if (cliExit !== null) {
    process.exitCode = cliExit;
    return;
  }
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");

  let cacheRoot: string;
  try {
    cacheRoot = videoCacheRoot(getArg(argv, "cache-dir") || undefined, process.env.DIARIA_VIDEO_CACHE_DIR, homedir());
  } catch (e) {
    if (!(e instanceof VideoCacheRootMissingError)) throw e;
    console.error(`${LOG_PREFIX} ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const ev = evaluateMontageDisk(freeBytes(cacheRoot));
  if (ev.unreadable) {
    console.error(`${LOG_PREFIX} espaço livre ilegível em ${cacheRoot} — sem leitura, sem veredito`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `${LOG_PREFIX} cache=${cacheRoot} livre=${((ev.freeBytes ?? 0) / 1e9).toFixed(1)}GB ` +
      `piso=${(ev.requiredBytes / 1e9).toFixed(1)}GB triggered=${ev.triggered}`,
  );

  const findings = montageDiskFindings(ev, cacheRoot, CLOSE_ALARM_ISSUE_AFTER_RUNS);
  const state = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);
  if (isDryRun) {
    const actions = planAlarmReconciliation(findings, state, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(`${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue (${actions.map((a) => a.kind).join(", ") || "nenhuma"}); gh e e-mail não chamados.`);
    return;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, state, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
  for (const o of findingOutcomes) {
    if (o.action === "failed") console.error(`${LOG_PREFIX} issue não criada/reusada: ${o.error}`);
    else console.log(`${LOG_PREFIX} issue #${o.issueNumber} (${o.action}): ${o.url}`);
  }
  if (findingOutcomes.length === 0) return;

  const result = await notifyEditorForOutcomes(
    findingOutcomes,
    "acao",
    () => ({ subject: findings[0]?.title ?? "[diar.ia.br] disco da montagem do vídeo abaixo do piso", body: findings[0]?.body ?? "" }),
    {
      cwd: ROOT,
      platformConfigPath: PLATFORM_CONFIG_PATH,
      emailTo: getArg(argv, "to"),
      legacyResendIntent: "dedupe-new-occurrences-only",
    },
  );
  if (result.qualifying.length === 0) console.log(`${LOG_PREFIX} política '${result.emailPolicy}': nenhum e-mail necessário.`);
  else if (result.emailSent) console.log(`${LOG_PREFIX} e-mail de alarme enviado.`);
  else console.error(`${LOG_PREFIX} falha ao enviar e-mail: ${result.emailError}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
