#!/usr/bin/env node
/**
 * scripts/gdrive-sync-alarm.ts (#12357, épica #12353)
 *
 * Task `Diaria-GDrive-Sync-Alarm` (de hora em hora): alarme do `rclone
 * bisync` do Google Drive no `300` (#12356) — o equivalente, pro backend
 * novo, do `scripts/onedrive-sync-alarm.ts` (#5548), que segue rodando
 * igual enquanto `data/` estiver no OneDrive (cutover na #12359). Cinco
 * sinais, cada um com achado próprio:
 *
 *   1. Sync (`check: "gdrive-sync"`): lê os carimbos que o
 *      `scripts/systemd/gdrive-bisync.sh` grava a cada rodada
 *      (`last-run.json`/`last-success.json` no state dir) e decide entre
 *      trava persistente (exit 75), falha persistente (outro exit) e sync
 *      sem sucesso há tempo demais. Lógica pura em `lib/gdrive-sync-alarm.ts`.
 *   2. Cota (`check: "gdrive-quota"`): `rclone about gdrive: --json`, só
 *      leitura. Lógica pura em `lib/gdrive-quota.ts`.
 *   3. Sync de `data/` (`check: "gdrive-data-sync"`, #12478): os mesmos
 *      carimbos, do bisync DEDICADO de `data/` (`diaria-gdrive-data-bisync`,
 *      1 min depois do fim da rodada anterior, state dir
 *      `~/.cache/diaria/gdrive-data-bisync`), com as tolerâncias curtas de
 *      `DATA_GDRIVE_SYNC_TOLERANCES`. State dir, remote, pasta e mount saem
 *      do mesmo `~/.config/diaria/gdrive-data-bisync.env` que o wrapper lê,
 *      com as mesmas regras (reimplementadas em
 *      `lib/gdrive-data-bisync-config.ts`; mudou uma, mude a outra). Sem
 *      carimbo o sinal é `not-installed`, silencioso — EXCETO quando o
 *      `data/` desta máquina já mora dentro da pasta local do bisync de
 *      `data/` (pós-cutover): aí é achado `alarm-data-bisync-missing`.
 *      Exit 78 do wrapper (configuração inválida/sobreposição) sai com texto
 *      próprio. O sinal 1 não muda.
 *   4. Configuração do bisync de `data/` (`check: "gdrive-data-config"`):
 *      arquivo de env malformado, caminho relativo, remote igual ao do bisync
 *      grande, pasta sobreposta ao espelho do Drive inteiro — os mesmos casos
 *      em que o wrapper sai 78.
 *   5. Cota da conta de `data/` (`check: "gdrive-data-quota"`): `rclone
 *      about {remote de data/}: --json`, mesmos limiares do 2, só quando o
 *      bisync de `data/` tem carimbo (instalado nesta máquina).
 *
 * Latência: o alarme roda de hora em hora, então um achado chega até ~1h
 * depois de vencer a tolerância (até ~90 min para o sinal 3).
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
 *   npx tsx scripts/gdrive-sync-alarm.ts --data-state-dir DIR  # carimbos do bisync de data/ (default: GDRIVE_DATA_STATE_DIR do ambiente, depois do ~/.config/diaria/gdrive-data-bisync.env, depois ~/.cache/diaria/gdrive-data-bisync)
 *   npx tsx scripts/gdrive-sync-alarm.ts --data-dir DIR        # data/ desta máquina (default {repo}/data), para o sinal 3
 *
 * Env: `RCLONE_BIN` (default `~/.local/bin/rclone`), `GDRIVE_STATE_DIR`,
 * `GDRIVE_DATA_STATE_DIR`, `GDRIVE_DATA_ENV_FILE`. Os limiares `--stale-hours`/`--blocked-minutes`/
 * `--failed-minutes` valem só pro sinal 1; o de `data/` usa os seus.
 * Estado das issues: `{state dir}/.gdrive-sync-alarm-issues.json`, SEMPRE fora
 * de `data/` (review da #12357: com o estado em `data/` e fallback pro state
 * dir quando `data/` some, um HD desmontado depois do cutover dividia o
 * estado em dois arquivos e o alarme reabria issue já aberta). Também evita
 * o arquivo de UMA máquina viajar pelo sync pras outras.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { applyCliAction, type CliSpec, hasFlag, getArg, getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import {
  bisyncStampReadFromText,
  evaluateGdriveSync,
  isAlarmingGdriveSyncVerdict,
  describeGdriveSyncVerdict,
  DEFAULT_GDRIVE_SYNC_TOLERANCES,
  DATA_GDRIVE_SYNC_TOLERANCES,
  FULL_DRIVE_BISYNC_TARGET,
  DATA_BISYNC_TARGET,
  dataBisyncTarget,
  type BisyncTarget,
  type BisyncStampRead,
  type GdriveSyncEvaluation,
} from "./lib/gdrive-sync-alarm.ts";
import { resolveDataBisyncConfig, type DataBisyncConfig } from "./lib/gdrive-data-bisync-config.ts";
import type { GdriveQuotaEvaluation as QuotaEval } from "./lib/gdrive-quota.ts";
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
export const DATA_SYNC_CHECK = "gdrive-data-sync";
export const DATA_CONFIG_CHECK = "gdrive-data-config";
export const DATA_QUOTA_CHECK = "gdrive-data-quota";
/** Fingerprint do sinal 3 quando o `data/` depende do bisync de `data/` e ele
 * não tem carimbo nenhum. */
export const DATA_BISYNC_MISSING = "alarm-data-bisync-missing";
export const DATA_CONFIG_INVALID = "alarm-data-config-invalid";

export function defaultGdriveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GDRIVE_STATE_DIR && env.GDRIVE_STATE_DIR.length > 0
    ? env.GDRIVE_STATE_DIR
    : join(homedir(), ".cache", "diaria", "gdrive-bisync");
}

/** State dir do bisync dedicado de `data/` (#12478): ambiente, depois o
 * arquivo `~/.config/diaria/gdrive-data-bisync.env` que o wrapper lê (mesmas
 * regras, só leitura), depois o default — a mesma precedência do wrapper. */
export function defaultGdriveDataStateDir(
  env: NodeJS.ProcessEnv = process.env,
  readText?: (path: string) => string | null,
): string {
  return resolveDataBisyncConfig(env, readText).stateDir;
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

/** Instância de bisync de um achado de sync: check, título e texto. */
interface SyncFindingKind {
  check: string;
  titlePrefix: string;
  origin: string;
  target: BisyncTarget;
}

const FULL_DRIVE_SYNC_KIND: SyncFindingKind = {
  check: SYNC_CHECK,
  titlePrefix: "[diar.ia.br] Google Drive sync",
  origin: "Achado automático do alarme `Diaria-GDrive-Sync-Alarm` (`scripts/gdrive-sync-alarm.ts`, #12357).",
  target: FULL_DRIVE_BISYNC_TARGET,
};

function dataSyncKind(target: BisyncTarget): SyncFindingKind {
  return { ...DATA_SYNC_KIND, target };
}

const DATA_SYNC_KIND: SyncFindingKind = {
  check: DATA_SYNC_CHECK,
  titlePrefix: "[diar.ia.br] Google Drive data/ sync",
  origin:
    "Achado automático do alarme `Diaria-GDrive-Sync-Alarm` (`scripts/gdrive-sync-alarm.ts`, sinal do bisync dedicado de `data/`, #12478).",
  target: DATA_BISYNC_TARGET,
};

export function toSyncAlarmFinding(ev: GdriveSyncEvaluation, backend: DataSyncBackend): AlarmFinding {
  return syncAlarmFinding(ev, backend, FULL_DRIVE_SYNC_KIND);
}

/** Achado do bisync dedicado de `data/` (#12478): mesmas regras de label e
 * prioridade do sinal do Drive inteiro, check e texto próprios. */
export function toDataSyncAlarmFinding(
  ev: GdriveSyncEvaluation,
  backend: DataSyncBackend,
  target: BisyncTarget = DATA_BISYNC_TARGET,
): AlarmFinding {
  return syncAlarmFinding(ev, backend, dataSyncKind(target));
}

function syncAlarmFinding(ev: GdriveSyncEvaluation, backend: DataSyncBackend, kind: SyncFindingKind): AlarmFinding {
  return {
    check: kind.check,
    fingerprint: ev.verdict,
    title: `${kind.titlePrefix}: ${ev.verdict}`,
    body: [
      kind.origin,
      "",
      describeGdriveSyncVerdict(ev, kind.target),
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

/** Texto da causa do achado de cota, inclusive o `quota-unmeasured`.
 * `dataRemote` (#12478) troca o texto para a conta do bisync de `data/`;
 * sem ele, é o texto de sempre da conta do Drive inteiro. */
export function quotaFindingCauseText(
  ev: GdriveQuotaEvaluation,
  unmeasuredReason: string | null = null,
  dataRemote: string | null = null,
): string {
  if (ev.verdict !== "unmeasured") {
    const base = buildGdriveQuotaCauseText(ev);
    return dataRemote === null ? base : `Conta do bisync de \`data/\` (remote \`${dataRemote}\`).\n${base}`;
  }
  if (dataRemote !== null) {
    return (
      `O \`rclone about\` não mediu a cota da conta do bisync de \`data/\` (remote \`${dataRemote}\`) nesta máquina, ` +
      `que roda esse bisync (${unmeasuredReason ?? "motivo não capturado"}). Token do remote expirado, rede ou ` +
      `remote renomeado costumam derrubar o sync junto. Conferir \`~/.local/bin/rclone about ${dataRemote} --json\`. ` +
      "As issues de cota cheia/quase cheia dessa conta ficam congeladas enquanto não houver medida."
    );
  }
  return (
    "O `rclone about` não mediu a cota do Google Drive nesta máquina, que roda o bisync " +
    `(${unmeasuredReason ?? "motivo não capturado"}). O mesmo rclone sincroniza o Drive: token do remote ` +
    "expirado, rede ou remote renomeado costumam derrubar os dois. Conferir `~/.local/bin/rclone about gdrive: --json`. " +
    "As issues de cota cheia/quase cheia ficam congeladas enquanto não houver medida."
  );
}

export function toQuotaAlarmFinding(
  ev: GdriveQuotaEvaluation,
  unmeasuredReason: string | null = null,
  dataRemote: string | null = null,
): AlarmFinding {
  const verdict = ev.verdict === "unmeasured" ? "quota-unmeasured" : ev.verdict;
  const isData = dataRemote !== null;
  return {
    check: isData ? DATA_QUOTA_CHECK : QUOTA_CHECK,
    fingerprint: verdict,
    title: isData ? `[diar.ia.br] Google Drive data/ cota (${dataRemote}): ${verdict}` : `[diar.ia.br] Google Drive cota: ${verdict}`,
    body: [
      isData
        ? "Achado automático do alarme `Diaria-GDrive-Sync-Alarm` (`scripts/gdrive-sync-alarm.ts`, cota da conta do bisync de `data/`, #12478)."
        : "Achado automático do alarme `Diaria-GDrive-Sync-Alarm` (`scripts/gdrive-sync-alarm.ts`, sinal de cota, #12357).",
      "",
      quotaFindingCauseText(ev, unmeasuredReason, dataRemote),
      "",
      "Esta issue é criada automaticamente pelo alarme e será comentada/fechada sozinha quando o achado deixar de",
      `reproduzir por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: verdict === "quota-unmeasured" ? ["bug"] : ["bug", ALARM_ACTION_LABEL],
    priority: verdict === "quota-full" ? "P1" : verdict === "quota-near" ? "P2" : "P3",
    family: "estado",
  };
}

/** `true` quando o `data/` desta máquina (já resolvido por `realpath`) é a
 * pasta local do bisync de `data/` ou está dentro dela (pós-cutover). */
export function dataDirDependsOnDataBisync(dataDirReal: string | null, dataLocal: string): boolean {
  if (dataDirReal === null || !dataLocal.startsWith("/")) return false;
  let local = dataLocal;
  try {
    local = realpathSync(dataLocal);
  } catch {
    // pasta local ausente: compara o caminho configurado
  }
  const a = resolve(dataDirReal);
  const b = resolve(local);
  return a === b || a.startsWith(`${b}/`);
}

/** Sinal 3 sem carimbo, com o `data/` dependendo dele (#12478). */
export function toDataBisyncMissingFinding(dataDirReal: string, target: BisyncTarget = DATA_BISYNC_TARGET): AlarmFinding {
  return {
    check: DATA_SYNC_CHECK,
    fingerprint: DATA_BISYNC_MISSING,
    title: `[diar.ia.br] Google Drive data/ sync: ${DATA_BISYNC_MISSING}`,
    body: [
      DATA_SYNC_KIND.origin,
      "",
      `O \`data/\` desta máquina (\`${dataDirReal}\`) mora dentro da pasta local do bisync dedicado de \`data/\`, ` +
        `mas não há carimbo nenhum em \`${target.stateDirHint}\`: o \`${target.unit}\` não está instalado (ou o ` +
        "state dir sumiu), e o `data/` não sincroniza entre as máquinas. Instalar ou religar o timer " +
        `(\`systemctl --user enable --now ${target.unit}.timer\`; passos em \`docs/scheduled-tasks-registry.md\`, ` +
        `\`${target.unit}\`).`,
      "",
      "Esta issue é criada automaticamente pelo alarme e será comentada/fechada sozinha quando o achado deixar de",
      `reproduzir por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug", ALARM_ACTION_LABEL],
    priority: "P1",
    family: "estado",
  };
}

/** Sinal 4: configuração do bisync de `data/` inválida (#12478). */
export function toDataConfigAlarmFinding(cfg: Pick<DataBisyncConfig, "errors" | "envFile">, backend: DataSyncBackend): AlarmFinding {
  return {
    check: DATA_CONFIG_CHECK,
    fingerprint: DATA_CONFIG_INVALID,
    title: `[diar.ia.br] Google Drive data/ configuração: ${DATA_CONFIG_INVALID}`,
    body: [
      "Achado automático do alarme `Diaria-GDrive-Sync-Alarm` (`scripts/gdrive-sync-alarm.ts`, configuração do bisync de `data/`, #12478).",
      "",
      `A configuração do bisync de \`data/\` é inválida; o wrapper \`scripts/systemd/gdrive-data-bisync.sh\` sai 78 ` +
        `(EX_CONFIG) sem sincronizar. Ver as \`GDRIVE_DATA_*\` e o arquivo \`${cfg.envFile}\`:`,
      ...cfg.errors.map((e) => `- ${e}`),
      "",
      "Esta issue é criada automaticamente pelo alarme e será comentada/fechada sozinha quando o achado deixar de",
      `reproduzir por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug", ALARM_ACTION_LABEL],
    priority: isDataOnGdrive(backend) ? "P1" : "P2",
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

/** Vereditos que `absenceUnmeasured` precisa (todos obrigatórios: esquecer
 * o de `data/` deixava as issues dele fechando sem medida). `dataQuota`
 * `null` = cota de `data/` não medida nesta execução (bisync de `data/` sem
 * carimbo). */
export interface AbsenceVerdicts {
  sync: GdriveSyncEvaluation["verdict"];
  quota: GdriveQuotaEvaluation["verdict"];
  dataSync: GdriveSyncEvaluation["verdict"];
  dataQuota: GdriveQuotaEvaluation["verdict"] | null;
}

/** Chaves cujas issues ficam congeladas nesta execução: sync sem bisync
 * instalado e cota sem medida não provam que o problema sumiu (#10520). */
export function absenceUnmeasured(v: AbsenceVerdicts): (key: string) => boolean {
  const keys = new Set<string>();
  addSyncAbsenceKeys(keys, SYNC_CHECK, v.sync);
  // Bisync de data/ (#12478): mesmas regras, chaves próprias.
  addSyncAbsenceKeys(keys, DATA_SYNC_CHECK, v.dataSync);
  if (v.quota === "unmeasured") {
    for (const f of ["quota-full", "quota-near"]) keys.add(alarmIssueStateKey(QUOTA_CHECK, f));
    // Sem bisync o `quota-unmeasured` nem é emitido — isso não prova que o
    // rclone voltou a medir.
    if (v.sync === "not-installed") keys.add(alarmIssueStateKey(QUOTA_CHECK, "quota-unmeasured"));
  }
  if (v.dataQuota === null || v.dataQuota === "unmeasured") {
    for (const f of ["quota-full", "quota-near"]) keys.add(alarmIssueStateKey(DATA_QUOTA_CHECK, f));
    if (v.dataQuota === null) keys.add(alarmIssueStateKey(DATA_QUOTA_CHECK, "quota-unmeasured"));
  }
  return (key) => keys.has(key);
}

function addSyncAbsenceKeys(keys: Set<string>, check: string, verdict: GdriveSyncEvaluation["verdict"]): void {
  // Sem bisync, ou com carimbo ilegível: nenhum dos dois mede o sync.
  if (verdict === "not-installed" || verdict === "alarm-stamp-unreadable") {
    for (const f of ["alarm-bisync-blocked", "alarm-bisync-failed", "alarm-sync-stale"]) keys.add(alarmIssueStateKey(check, f));
  }
  // Sem bisync também não prova que o carimbo ilegível sarou.
  if (verdict === "not-installed") keys.add(alarmIssueStateKey(check, "alarm-stamp-unreadable"));
}

function issueLineFor(outcome: AlarmFindingOutcome): string {
  return outcome.action === "failed"
    ? `\n\nIssue: falha ao criar/reusar (${outcome.error})`
    : `\n\nIssue: #${outcome.issueNumber} (${outcome.url})`;
}

/** Contexto do bisync de `data/` para o e-mail (#12478). */
export interface DataAlarmEmailContext {
  sync: GdriveSyncEvaluation;
  target: BisyncTarget;
  /** Texto do achado `alarm-data-bisync-missing`, quando houver. */
  missingText: string | null;
  configErrors: readonly string[];
  envFile: string;
  quota: GdriveQuotaEvaluation | null;
  quotaUnmeasuredReason: string | null;
  remoteName: string;
}

export function buildGdriveAlarmEmail(
  qualifying: readonly AlarmFindingOutcome[],
  sync: GdriveSyncEvaluation,
  quota: GdriveQuotaEvaluation,
  quotaUnmeasuredReason: string | null = null,
  data: DataAlarmEmailContext | null = null,
): { subject: string; body: string } {
  const parts: string[] = [];
  const subjects: string[] = [];
  const s = qualifying.find((o) => o.check === SYNC_CHECK);
  const q = qualifying.find((o) => o.check === QUOTA_CHECK);
  const d = data ? qualifying.find((o) => o.check === DATA_SYNC_CHECK) : undefined;
  const c = data ? qualifying.find((o) => o.check === DATA_CONFIG_CHECK) : undefined;
  const dq = data ? qualifying.find((o) => o.check === DATA_QUOTA_CHECK) : undefined;
  if (s) {
    parts.push(`${describeGdriveSyncVerdict(sync)}${issueLineFor(s)}`);
    subjects.push(sync.verdict);
  }
  if (d && data) {
    const text =
      d.fingerprint === DATA_BISYNC_MISSING && data.missingText !== null
        ? data.missingText
        : describeGdriveSyncVerdict(data.sync, data.target);
    parts.push(`${text}${issueLineFor(d)}`);
    subjects.push(`data/ ${d.fingerprint}`);
  }
  if (c && data) {
    parts.push(
      `Configuração do bisync de \`data/\` inválida (o wrapper sai 78; ver as \`GDRIVE_DATA_*\` e \`${data.envFile}\`): ` +
        `${data.configErrors.join("; ")}${issueLineFor(c)}`,
    );
    subjects.push("data/ configuração inválida");
  }
  if (q) {
    parts.push(`${quotaFindingCauseText(quota, quotaUnmeasuredReason)}${issueLineFor(q)}`);
    subjects.push(`cota ${q.fingerprint}`);
  }
  if (dq && data && data.quota) {
    parts.push(`${quotaFindingCauseText(data.quota, data.quotaUnmeasuredReason, data.remoteName)}${issueLineFor(dq)}`);
    subjects.push(`data/ cota ${dq.fingerprint}`);
  }
  return {
    subject: `⚠️ Google Drive: ${subjects.join(" + ")}`,
    body: parts.join("\n\n---\n\n") + "\n\nAchado automático de `Diaria-GDrive-Sync-Alarm` (#12357).",
  };
}

/** Flags aceitas; o resto sai 1 antes de qualquer I/O, `--help` sai 0 (#12503). */
export const CLI_SPEC: CliSpec = {
  script: "scripts/gdrive-sync-alarm.ts",
  booleans: ["dry-run"],
  values: ["to", "state-dir", "data-state-dir", "data-dir", "stale-hours", "blocked-minutes", "failed-minutes", "quota-warn-pct", "remote"],
};

/** Entradas já medidas de uma execução (o `main()` lê disco/rclone e passa
 * aqui; o teste passa direto). */
export interface GdriveAlarmInputs {
  sync: GdriveSyncEvaluation;
  quota: GdriveQuotaEvaluation;
  quotaError: string | null;
  backend: DataSyncBackend;
  dataCfg: Pick<DataBisyncConfig, "errors" | "envFile" | "local" | "remoteName">;
  dataSync: GdriveSyncEvaluation;
  dataTarget: BisyncTarget;
  /** `realpath` do `data/` desta máquina; `null` = não resolve. */
  dataDirReal: string | null;
  /** Cota da conta de `data/`; `null` = não medida (sem carimbo de data/). */
  dataQuota: GdriveQuotaEvaluation | null;
  dataQuotaError: string | null;
}

/** Achados + regra de congelamento de uma execução. Pura: é a fiação do
 * `main()`, testada direto (#12478). */
export function collectGdriveAlarmFindings(i: GdriveAlarmInputs): {
  findings: AlarmFinding[];
  isAbsenceUnmeasured: (key: string) => boolean;
  dataMissing: boolean;
} {
  const findings: AlarmFinding[] = [];
  if (isAlarmingGdriveSyncVerdict(i.sync.verdict)) findings.push(toSyncAlarmFinding(i.sync, i.backend));
  if (quotaFindingVerdict(i.quota, i.sync.verdict) !== null) findings.push(toQuotaAlarmFinding(i.quota, i.quotaError));
  if (isAlarmingGdriveSyncVerdict(i.dataSync.verdict)) findings.push(toDataSyncAlarmFinding(i.dataSync, i.backend, i.dataTarget));
  const dataMissing = i.dataSync.verdict === "not-installed" && dataDirDependsOnDataBisync(i.dataDirReal, i.dataCfg.local);
  if (dataMissing && i.dataDirReal !== null) findings.push(toDataBisyncMissingFinding(i.dataDirReal, i.dataTarget));
  if (i.dataCfg.errors.length > 0) findings.push(toDataConfigAlarmFinding(i.dataCfg, i.backend));
  if (i.dataQuota !== null && quotaFindingVerdict(i.dataQuota, i.dataSync.verdict) !== null) {
    findings.push(toQuotaAlarmFinding(i.dataQuota, i.dataQuotaError, i.dataCfg.remoteName));
  }
  const isAbsenceUnmeasured = absenceUnmeasured({
    sync: i.sync.verdict,
    quota: i.quota.verdict,
    dataSync: i.dataSync.verdict,
    dataQuota: i.dataQuota === null ? null : i.dataQuota.verdict,
  });
  return { findings, isAbsenceUnmeasured, dataMissing };
}

async function main(): Promise<void> {
  const cliExit = applyCliAction(process.argv.slice(2), CLI_SPEC);
  if (cliExit !== null) {
    process.exitCode = cliExit;
    return;
  }
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const stateDir = getStringArg(argv, "state-dir", { example: "~/.cache/diaria/gdrive-bisync" }) ?? defaultGdriveStateDir();
  // Config do bisync de data/ como o wrapper a vê (#12478): ambiente >
  // ~/.config/diaria/gdrive-data-bisync.env > defaults.
  const dataCfg = resolveDataBisyncConfig(process.env);
  for (const e of dataCfg.errors) console.error(`${LOG_PREFIX} configuração de data/ inválida: ${e}`);
  const dataStateDir =
    getStringArg(argv, "data-state-dir", { example: "~/.cache/diaria/gdrive-data-bisync" }) ?? dataCfg.stateDir;
  const dataTarget = dataBisyncTarget({
    remote: dataCfg.remote,
    local: dataCfg.local,
    stateDir: dataStateDir,
    mount: dataCfg.mount,
    envFile: dataCfg.envFile,
  });
  const dataDir = getStringArg(argv, "data-dir", { example: "/caminho/do/data" }) ?? join(ROOT, "data");
  let dataDirReal: string | null = null;
  try {
    dataDirReal = realpathSync(dataDir);
  } catch {
    dataDirReal = null;
  }
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

  // State dir relativo é erro de configuração (sinal 4); não lê carimbo dele.
  const dataStampsUsable = dataStateDir.startsWith("/");
  const dataSync = evaluateGdriveSync(
    dataStampsUsable ? readBisyncStamp(join(dataStateDir, "last-run.json")) : { kind: "absent" },
    dataStampsUsable ? readBisyncStamp(join(dataStateDir, "last-success.json")) : { kind: "absent" },
    now,
    DATA_GDRIVE_SYNC_TOLERANCES,
  );
  console.log(
    `${LOG_PREFIX} sync data/: verdict=${dataSync.verdict} ` +
      `lastRun=${dataSync.lastRun ? `${dataSync.lastRun.at}/exit ${dataSync.lastRun.exit}` : "nenhuma"} ` +
      `lastSuccess=${dataSync.lastSuccess?.at ?? "nenhum"} stateDir=${dataStateDir}`,
  );

  const about = readRcloneAboutDetailed(resolveRcloneBin(), remote);
  const quota = evaluateGdriveQuota(about.about, warnPct);
  console.log(
    `${LOG_PREFIX} cota: verdict=${quota.verdict} usedPct=${quota.usedPct === null ? "n/a" : quota.usedPct.toFixed(1)} warn=${warnPct}%` +
      (about.error ? ` erro=${about.error}` : ""),
  );

  // Cota da conta de data/: só com o bisync de data/ instalado (há carimbo).
  let dataQuota: QuotaEval | null = null;
  let dataQuotaError: string | null = null;
  if (dataSync.verdict !== "not-installed" && dataCfg.remoteName.length > 1) {
    const dataAbout = readRcloneAboutDetailed(resolveRcloneBin(), dataCfg.remoteName);
    dataQuota = evaluateGdriveQuota(dataAbout.about, warnPct);
    dataQuotaError = dataAbout.error;
    console.log(
      `${LOG_PREFIX} cota data/ (${dataCfg.remoteName}): verdict=${dataQuota.verdict} ` +
        `usedPct=${dataQuota.usedPct === null ? "n/a" : dataQuota.usedPct.toFixed(1)}` +
        (dataAbout.error ? ` erro=${dataAbout.error}` : ""),
    );
  }

  const { findings, isAbsenceUnmeasured, dataMissing } = collectGdriveAlarmFindings({
    sync,
    quota,
    quotaError: about.error,
    backend,
    dataCfg,
    dataSync,
    dataTarget,
    dataDirReal,
    dataQuota,
    dataQuotaError,
  });
  if (dataMissing) console.log(`${LOG_PREFIX} data/ (${dataDirReal}) depende do bisync de data/, sem carimbo: ${DATA_BISYNC_MISSING}`);

  const statePath = gdriveAlarmIssuesStatePath(stateDir);
  const alarmState = loadAlarmIssuesState(statePath);

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
    (qualifying) =>
      buildGdriveAlarmEmail(qualifying, sync, quota, about.error, {
        sync: dataSync,
        target: dataTarget,
        missingText: dataMissing && dataDirReal !== null ? (toDataBisyncMissingFinding(dataDirReal, dataTarget).body.split("\n")[2] ?? null) : null,
        configErrors: dataCfg.errors,
        envFile: dataCfg.envFile,
        quota: dataQuota,
        quotaUnmeasuredReason: dataQuotaError,
        remoteName: dataCfg.remoteName,
      }),
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
