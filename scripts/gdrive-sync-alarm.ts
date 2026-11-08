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
 * antes da instalação): sem carimbo nenhum o sinal de sync é
 * `not-installed`, silencioso; a cota sem rclone/remote é `unmeasured`. Nos
 * dois casos as issues já abertas ficam congeladas (não fecham por falta de
 * medida, #10520). Carimbo que EXISTE mas não abre/não parseia é outra coisa:
 * `alarm-stamp-unreadable`, que alarma (review da #12357).
 *
 * **Cota sem medida numa máquina COM bisync** (o rclone falhou no `about`:
 * token expirado, rede, remote renomeado) vira achado `quota-unmeasured`
 * (P3), em vez de silêncio: o mesmo rclone que não mede a cota é o que
 * sincroniza. Máquina sem bisync segue silenciosa.
 *
 * Prioridade: a regra por backend vale SÓ pro achado de sync — P1 quando o
 * `data/` desta máquina já mora no Google Drive, alcançável ou não
 * (`detectDataSyncBackend`/`isDataOnGdrive`; depois do cutover o merge lock e
 * o `session-registry` param de atravessar máquinas), P2 antes disso (só a
 * cópia do Drive no HD fica para trás). Cota: P1 `quota-full`, P2
 * `quota-near`, P3 `quota-unmeasured`, em qualquer backend.
 *
 * Exit code: 1 quando havia achado e NENHUM canal o entregou (issue falhou em
 * todos e nenhum e-mail saiu) — a task do systemd fica `failed` e o
 * `Diaria-Systemd-Failed-Units-Alarm` cobre o buraco. 0 nos demais casos.
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
 * Estado das issues: `{state dir}/.gdrive-sync-alarm-issues.json`, SEMPRE fora
 * de `data/` (review da #12357: com o estado em `data/` e fallback pro state
 * dir quando `data/` some, um HD desmontado depois do cutover dividia o
 * estado em dois arquivos e o alarme reabria issue já aberta). Também evita
 * o arquivo de UMA máquina viajar pelo sync pras outras.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import {
  bisyncStampReadFromText,
  evaluateGdriveSync,
  isAlarmingGdriveSyncVerdict,
  describeGdriveSyncVerdict,
  DEFAULT_GDRIVE_SYNC_TOLERANCES,
  type BisyncStampRead,
  type GdriveSyncEvaluation,
} from "./lib/gdrive-sync-alarm.ts";
import {
  readRcloneAboutDetailed,
  resolveRcloneBin,
  evaluateGdriveQuota,
  buildGdriveQuotaCauseText,
  DEFAULT_GDRIVE_QUOTA_WARN_PCT,
  DEFAULT_GDRIVE_REMOTE,
  type GdriveQuotaEvaluation,
} from "./lib/gdrive-quota.ts";
import { detectDataSyncBackend, isDataOnGdrive, type DataSyncBackend } from "./lib/exec-mode.ts";
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

/** Arquivo de estado das issues do alarme: sempre no state dir, nunca em
 * `data/` (ver docstring do topo). */
export function gdriveAlarmIssuesStatePath(stateDir: string): string {
  return join(stateDir, ".gdrive-sync-alarm-issues.json");
}

/** Lê um carimbo do state dir. Só ENOENT é `absent`; qualquer outro erro de
 * leitura (EACCES, EISDIR) ou conteúdo inválido é `unreadable`, que alarma —
 * nunca conta como ausente (silêncio) nem como sucesso. */
export function readBisyncStamp(path: string): BisyncStampRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { kind: "absent" };
    console.error(`${LOG_PREFIX} carimbo ilegível em ${path}: ${err.message}`);
    return { kind: "unreadable", reason: `não abre (${err.code ?? err.message})` };
  }
  const read = bisyncStampReadFromText(text);
  if (read.kind === "unreadable") console.error(`${LOG_PREFIX} carimbo inválido em ${path}: ${read.reason}`);
  return read;
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
      backendImpactLine(backend),
      "",
      "Esta issue é criada automaticamente pelo alarme e será comentada/fechada sozinha quando o achado deixar de",
      `reproduzir por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    // Trava e falha persistentes só normalizam por AÇÃO (montar o HD,
    // recriar a sentinela, `--force`/`--resync`) — mesmo raciocínio do
    // #7701. O sync sem sucesso há tempo é ambíguo (pode se resolver
    // sozinho), fica `alarm` puro.
    labels: ev.verdict === "alarm-sync-stale" ? ["bug"] : ["bug", ALARM_ACTION_LABEL],
    priority: isDataOnGdrive(backend) ? "P1" : "P2",
    family: "estado",
  };
}

/** Linha do achado de sync sobre o impacto no `data/` desta máquina. */
export function backendImpactLine(backend: DataSyncBackend): string {
  if (backend === "gdrive") {
    return "O `data/` desta máquina já mora no Google Drive: com o sync parado, merge lock e `session-registry` param de atravessar máquinas.";
  }
  if (backend === "gdrive-unreachable") {
    return (
      "O `data/` desta máquina aponta para o Google Drive, mas o alvo NÃO resolve (HD `/mnt/hd-sata` desmontado ou " +
      "pasta apagada): o `data/` está fora do ar nesta máquina, além do sync parado. Conferir `mountpoint /mnt/hd-sata`."
    );
  }
  return `O \`data/\` desta máquina ainda não está no Google Drive (backend: ${backend}); fica para trás só a cópia do Drive no HD.`;
}

/** Texto da causa do achado de cota, inclusive o `quota-unmeasured`. */
export function quotaFindingCauseText(ev: GdriveQuotaEvaluation, unmeasuredReason: string | null = null): string {
  if (ev.verdict !== "unmeasured") return buildGdriveQuotaCauseText(ev);
  return (
    "O `rclone about` não mediu a cota do Google Drive nesta máquina, que roda o bisync " +
    `(${unmeasuredReason ?? "motivo não capturado"}). O mesmo rclone sincroniza o Drive: token do remote ` +
    "expirado, rede ou remote renomeado costumam derrubar os dois. Conferir `~/.local/bin/rclone about gdrive: --json`. " +
    "As issues de cota cheia/quase cheia ficam congeladas enquanto não houver medida."
  );
}

export function toQuotaAlarmFinding(ev: GdriveQuotaEvaluation, unmeasuredReason: string | null = null): AlarmFinding {
  const verdict = ev.verdict === "unmeasured" ? "quota-unmeasured" : ev.verdict;
  return {
    check: QUOTA_CHECK,
    fingerprint: verdict,
    title: `[diar.ia.br] Google Drive cota: ${verdict}`,
    body: [
      "Achado automático do alarme `Diaria-GDrive-Sync-Alarm` (`scripts/gdrive-sync-alarm.ts`, sinal de cota, #12357).",
      "",
      quotaFindingCauseText(ev, unmeasuredReason),
      "",
      "Esta issue é criada automaticamente pelo alarme e será comentada/fechada sozinha quando o achado deixar de",
      `reproduzir por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: verdict === "quota-unmeasured" ? ["bug"] : ["bug", ALARM_ACTION_LABEL],
    priority: verdict === "quota-full" ? "P1" : verdict === "quota-near" ? "P2" : "P3",
    family: "estado",
  };
}

/** Veredito de cota que vira achado, ou `null`. `unmeasured` só alarma (como
 * `quota-unmeasured`) quando esta máquina roda o bisync — sem bisync, o
 * rclone pode nem existir e o silêncio é o correto. */
export function quotaFindingVerdict(
  quota: GdriveQuotaEvaluation,
  syncVerdict: GdriveSyncEvaluation["verdict"],
): "quota-full" | "quota-near" | "quota-unmeasured" | null {
  if (quota.verdict === "quota-full" || quota.verdict === "quota-near") return quota.verdict;
  if (quota.verdict === "unmeasured" && syncVerdict !== "not-installed") return "quota-unmeasured";
  return null;
}

/** `true` quando ao menos um canal entregou: alguma issue tratada sem falha,
 * ou o e-mail saiu. Sem achado nenhum também é `true` (nada a entregar). */
export function gdriveAlarmDelivered(
  outcomes: readonly AlarmFindingOutcome[],
  email: { emailSent: boolean },
): boolean {
  if (outcomes.length === 0) return true;
  return outcomes.some((o) => o.action !== "failed") || email.emailSent;
}

/** Chaves cujas issues ficam congeladas nesta execução: sync sem bisync
 * instalado e cota sem medida não provam que o problema sumiu (#10520). */
export function absenceUnmeasured(
  syncVerdict: GdriveSyncEvaluation["verdict"],
  quotaVerdict: GdriveQuotaEvaluation["verdict"],
): (key: string) => boolean {
  const keys = new Set<string>();
  // Sem bisync, ou com carimbo ilegível: nenhum dos dois mede o sync.
  if (syncVerdict === "not-installed" || syncVerdict === "alarm-stamp-unreadable") {
    for (const f of ["alarm-bisync-blocked", "alarm-bisync-failed", "alarm-sync-stale"]) keys.add(alarmIssueStateKey(SYNC_CHECK, f));
  }
  // Sem bisync também não prova que o carimbo ilegível sarou.
  if (syncVerdict === "not-installed") keys.add(alarmIssueStateKey(SYNC_CHECK, "alarm-stamp-unreadable"));
  if (quotaVerdict === "unmeasured") {
    for (const f of ["quota-full", "quota-near"]) keys.add(alarmIssueStateKey(QUOTA_CHECK, f));
    // Sem bisync o `quota-unmeasured` nem é emitido — isso não prova que o
    // rclone voltou a medir.
    if (syncVerdict === "not-installed") keys.add(alarmIssueStateKey(QUOTA_CHECK, "quota-unmeasured"));
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
  quotaUnmeasuredReason: string | null = null,
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
    parts.push(`${quotaFindingCauseText(quota, quotaUnmeasuredReason)}${issueLineFor(q)}`);
    subjects.push(`cota ${q.fingerprint}`);
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
  const sync = evaluateGdriveSync(
    readBisyncStamp(join(stateDir, "last-run.json")),
    readBisyncStamp(join(stateDir, "last-success.json")),
    now,
    tol,
  );
  const { lastRun, lastSuccess } = sync;
  const backend = detectDataSyncBackend({ projectRoot: ROOT });
  console.log(
    `${LOG_PREFIX} sync: verdict=${sync.verdict} lastRun=${lastRun ? `${lastRun.at}/exit ${lastRun.exit}` : "nenhuma"} ` +
      `lastSuccess=${lastSuccess?.at ?? "nenhum"} stateDir=${stateDir} data=${backend}`,
  );

  const about = readRcloneAboutDetailed(resolveRcloneBin(), remote);
  const quota = evaluateGdriveQuota(about.about, warnPct);
  console.log(
    `${LOG_PREFIX} cota: verdict=${quota.verdict} usedPct=${quota.usedPct === null ? "n/a" : quota.usedPct.toFixed(1)} warn=${warnPct}%` +
      (about.error ? ` erro=${about.error}` : ""),
  );

  const findings: AlarmFinding[] = [];
  if (isAlarmingGdriveSyncVerdict(sync.verdict)) findings.push(toSyncAlarmFinding(sync, backend));
  if (quotaFindingVerdict(quota, sync.verdict) !== null) findings.push(toQuotaAlarmFinding(quota, about.error));

  const statePath = gdriveAlarmIssuesStatePath(stateDir);
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
    (qualifying) => buildGdriveAlarmEmail(qualifying, sync, quota, about.error),
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
  if (!gdriveAlarmDelivered(findingOutcomes, result)) {
    console.error(`${LOG_PREFIX} ${findingOutcomes.length} achado(s) e NENHUM canal entregou (issue e e-mail falharam) — exit 1.`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
