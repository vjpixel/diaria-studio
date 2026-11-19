#!/usr/bin/env node
/**
 * scripts/archive-video-brutos.ts (#12548, resolve #12472)
 *
 * Guarda os brutos do vídeo da diária no HD do `300` e os apaga do Google
 * Drive. **Dry-run é o DEFAULT**: sem `--apply` só lista o que sairia, com
 * tamanho e motivo, sem tocar nada. Política pura (quais pastas, quais
 * arquivos, a conferência) em `scripts/lib/diaria/video-bruto-archive.ts`.
 *
 * Origem (#12789): por default a `diaria-studio-video` da conta diaria.editor
 * (`gdrive-diaria:diaria-studio-video`), que NÃO tem espelho local no `300`.
 * Sem espelho (`VIDEO_ARCHIVE_LOCAL_ROOT` vazio/ausente), as pastas de edição
 * vêm do remote (`rclone lsjson --dirs-only`), todo bruto é baixado para o
 * `.partial` e conferido (tamanho + MD5) antes do `deletefile`, e nenhum bisync
 * é pausado (nenhum cobre a pasta). Os passos abaixo que citam o espelho só
 * valem com `VIDEO_ARCHIVE_LOCAL_ROOT` apontando para um (a pasta antiga da
 * vjpixel, `LEGACY_VIDEO_FOLDER_REL`).
 *
 * Com `--apply` e espelho, primeiro pausa o bisync do Drive inteiro (#12356): para o
 * `diaria-gdrive-bisync.timer` (só se estava ativo) e espera a rodada em curso
 * terminar (`systemctl --user is-active` = `inactive`/`failed`; qualquer outro
 * valor, inclusive vazio, conta como "ainda rodando"). Só depois lista o Drive,
 * para que a listagem (tamanho + MD5) seja a do estado que vai ser apagado. Para
 * cada bruto listado numa pasta de edição elegível:
 *   1. acha a cópia local: a do arquivo (`{archive}/{pasta}/{arquivo}`, rodada
 *      anterior interrompida) se tiver o tamanho e o MD5 do Drive, senão a do
 *      espelho do bisync (`/mnt/hd-sata/GoogleDrive/...`) se tiver o tamanho
 *      do Drive, senão baixa do Drive para um `.partial` ao lado do destino e
 *      renomeia. Uma cópia ruim no arquivo, de tamanho errado ou de mesmo
 *      tamanho com MD5 diferente (#12603), nunca trava o bruto: vai para
 *      `{arquivo}.conflito-{timestamp}` (#12789, nunca sobrescrita) e a cópia
 *      conferida toma o lugar;
 *   2. confere tamanho e MD5 contra o Drive. Divergência, MD5 local que não
 *      pôde ser calculado ou Drive sem MD5 = não apaga, exit 1;
 *   3. move a cópia do espelho para o arquivo (`rename`, mesmo disco);
 *   4. apaga do Drive de vez (`rclone deletefile --drive-use-trash=false`):
 *      arquivo na lixeira continua contando na cota por 30 dias.
 *      Se o `deletefile` falhar, o script RELÊ o arquivo no Drive antes de
 *      decidir: sumiu (o Drive apagou e só a resposta se perdeu) = arquivado;
 *      continua lá = a cópia volta ao espelho quando veio dele (senão o bisync
 *      tentaria apagar no Drive a cada rodada), e o arquivo sai como "não
 *      apagado" (permissão: arquivo de outro dono) ou como falha (exit 1).
 *      No "não apagado" o arquivo guarda também uma cópia própria (#12570):
 *      se a dona apagar do Drive, o bisync apaga o espelho, e sem ela não
 *      sobraria nenhuma. Nas rodadas seguintes o bruto entra pela cópia do
 *      arquivo, com o MD5 conferido gravado ao lado (`{arquivo}.md5.json`,
 *      vale enquanto tamanho, mtime e o MD5 do Drive não mudarem), e só o
 *      `deletefile` se repete;
 *      não deu para reler = a cópia conferida fica no arquivo e é falha.
 *      Devolver ao espelho sem reler podia perder o arquivo: o bisync veria
 *      "apagado no Drive" e apagaria o espelho, sem lixeira em lado nenhum.
 *
 * Uma execução com `--apply` por vez (#12573): trava em
 * `~/.cache/diaria/video-bruto-archive/run.lock` (`O_EXCL`, PID + início;
 * trava de PID morto é retomada). A 2ª execução sai com exit 1 sem tocar no
 * timer do bisync. Dry-run não trava (só lê).
 *
 * Nome repetido na mesma pasta do Drive (o Drive aceita) não é apagado:
 * `deletefile` não diz qual dos dois apaga, e só um foi conferido. Pasta de
 * edição com nome repetido (#12789) é erro da edição: nada baixado nem apagado
 * dela, as demais seguem, a rodada sai com exit 1. Atalhos do Drive não são
 * seguidos (`--drive-skip-shortcuts`) em nenhuma listagem nem no `deletefile`.
 *
 * Bruto que a montagem de outra edição ainda usa fica no Drive (#12602): antes
 * de listar, o script lê o `_internal/video-montagem/source.json` de cada
 * edição de `data/editions` que ainda não sairia (mesma `decideFolder`, só com
 * ela) e segura todo bruto com o mesmo nome de arquivo
 * (`em-uso-por-outra-edicao`, não é falha). `source.json` ilegível de uma
 * edição em uso = erro, e com `--apply` nada sai do Drive (sem saber o que ele
 * usa, qualquer bruto pode ser dele).
 *
 * O timer volta no fim em qualquer caso, inclusive SIGTERM/SIGINT; morte por
 * SIGKILL fica para o alarme de sync parado (#12357). Por isso a rodada é
 * assíncrona (#12603): com `spawnSync`/`Atomics.wait` o handler do sinal só
 * rodaria quando a rodada acabasse, e com um handler instalado o Node deixa de
 * morrer no SIGTERM, ou seja, o sinal ficava ignorado. Agora o sinal marca a
 * parada, mata o filho em curso (rclone/md5sum), nenhum filho novo sobe, o
 * laço para antes do próximo bruto e o `finally` religa o timer.
 *
 * Relatório: stdout (texto ou `--json`) e, com `--apply`,
 * `~/.cache/diaria/video-bruto-archive/last-report.json`, com o espaço livre do
 * Drive antes e depois (`null` quando a rodada não chegou a arquivar ou o
 * `rclone about` falhou; o motivo vai em `warnings`). Falha = exit 1, a unit
 * fica `failed` e o alarme de units falhas acusa.
 *
 * Além dos brutos, a mesma rodada (política em `lib/diaria/video-drive-cleanup.ts`):
 *   - #13630: finais, prévias e editados das pastas cujas edições o
 *     `/diaria-publica` liberou (`_internal/05-video-liberada.json`, gravado
 *     por `scripts/mark-video-liberada.ts`) e sem agendamento pendente no banco
 *     saem com a mesma disciplina (cópia conferida no HD, depois o delete);
 *   - #13632: a pasta de uma edição renomeada (`_origem-brutos.json` da pasta
 *     nova) segue a edição nova, e os brutos dela são movidos para a pasta nova
 *     no Drive (`rclone moveto`) antes do arquivamento;
 *   - #13627: depois do arquivamento, cópias idênticas (md5 + tamanho) entre
 *     pastas vão para a LIXEIRA do Drive, fica a da pasta dona;
 *   - cada arquivo que sai ganha uma linha em
 *     `{arquivo}/{pasta}/_registro-arquivamento.jsonl`.
 * Renomeação e duplicatas usam uma listagem recursiva da pasta de vídeo e só
 * rodam sem espelho (o default).
 *
 * Task agendada: `Diaria-Video-Bruto-Archive` (diária 03:00 BRT desde a #13631, `--apply`), com os defaults (sem espelho).
 * Aviso (#13631): falha = exit 1 (unit `failed`); o "não apagado/movido" por
 * permissão abre uma issue por conjunto de arquivos (`notDeletedFinding`). Final
 * ou prévia com nome repetido no Drive (#13675) entra no mesmo aviso e fica para
 * o próximo ciclo, sem `failed`; bruto com nome repetido segue falha.
 *
 * Uso:
 *   npx tsx scripts/archive-video-brutos.ts                    # dry-run
 *   npx tsx scripts/archive-video-brutos.ts --apply            # arquiva e apaga do Drive
 *   npx tsx scripts/archive-video-brutos.ts --apply --only 261027,261028
 *   npx tsx scripts/archive-video-brutos.ts --json
 *   npx tsx scripts/archive-video-brutos.ts --published-min-days 7   # idade mínima da pasta publicada (default 4)
 *
 * Testável sem tocar produção: VIDEO_ARCHIVE_* (inclusive VIDEO_ARCHIVE_LOCK) e RCLONE_BIN/SYSTEMCTL_BIN/
 * MD5SUM_BIN/VIDEO_ARCHIVE_MOUNTPOINT_CMD sobrescrevíveis por env.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { formatBytes } from "./lib/onedrive-quota.ts";
import { parseRcloneAboutJson } from "./lib/gdrive-quota.ts";
import { editionDirUnder, editionVideoPublished, todayBrt } from "./prune-video-montage-cache.ts";
import {
  DEFAULT_ARCHIVE_PUBLISHED_MIN_DAYS,
  DEFAULT_ARCHIVE_UNPUBLISHED_MAX_DAYS,
  VERIFIED_RECORD_SUFFIX,
  brutoRefKey,
  decideFolder,
  duplicatePaths,
  editionsOfFolder,
  effectiveEditionsOfFolder,
  brutoFilesOf,
  montageSourceRefs,
  parseMd5sumLine,
  parseRcloneLsjson,
  parseRcloneLsjsonDirs,
  parseRunLock,
  parseVerifiedRecord,
  referencingEditions,
  runLockIsStale,
  verifiedRecordTrusted,
  verifyCopy,
  type FolderDecision,
  type RemoteFile,
  type VerifyVerdict,
} from "./lib/diaria/video-bruto-archive.ts";
import {
  ORIGEM_BRUTOS_FILE,
  VIDEO_LIBERADA_FILE,
  buildRenameMap,
  decideFinalsFolder,
  foldersWithRemovalCandidates,
  isFinalOrPreviewFile,
  isRootXml,
  parseVideoLiberada,
  pendingAgendamentosOf,
  planCrossFolderDuplicates,
  referencedNamesOfXmls,
  type FinalsDecision,
  type FolderFile,
} from "./lib/diaria/video-drive-cleanup.ts";
import { loadAgendamentos } from "./lib/diaria/agendamentos.ts";
import type { NotifyEditorFinding } from "./lib/editor-notify.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[archive-video-brutos]";

/**
 * Pasta de vídeo da diária, relativa à raiz do remote (#12789): a
 * `diaria-studio-video` da conta diaria.editor (#12578), no remote
 * `gdrive-diaria:`. Não tem espelho local no `300` (o bisync dedicado da
 * #12478 cobre só a `diaria-studio-data`), então o default é rodar sem espelho.
 */
export const VIDEO_FOLDER_REL = "diaria-studio-video";
export const DEFAULT_VIDEO_REMOTE = "gdrive-diaria:";
/**
 * Pasta antiga, da vjpixel, com espelho no bisync do Drive inteiro. Só para
 * uma rodada manual sobre ela, por env: `VIDEO_ARCHIVE_REMOTE=gdrive:`,
 * `VIDEO_ARCHIVE_REMOTE_ROOT=gdrive:{LEGACY}` e
 * `VIDEO_ARCHIVE_LOCAL_ROOT=/mnt/hd-sata/GoogleDrive/{LEGACY}`. O `／` (largo)
 * é como o rclone grava a `/` do nome "Mentoria Fluxo/VTSD".
 */
export const LEGACY_VIDEO_FOLDER_REL = "Work/Mentoria Fluxo／VTSD/YouTube"; // só histórico/rodada manual (#12578, #12789)
export const DEFAULT_MOUNT = "/mnt/hd-sata";
export const BISYNC_TIMER = "diaria-gdrive-bisync.timer";
export const BISYNC_SERVICE = "diaria-gdrive-bisync.service";

const HOUR_MS = 3_600_000;

/**
 * #12789: atalho do Drive não é seguido nas listagens nem no `deletefile`. Um
 * atalho para a pasta de outra edição (ou de outra conta) dentro da pasta de
 * vídeo faria a rodada listar, conferir e apagar o que não é desta pasta.
 */
export const DRIVE_FLAGS = ["--drive-skip-shortcuts"] as const;

export interface ArchiveConfig {
  mount: string;
  /**
   * Espelho local da pasta de vídeo, mantido por um bisync (#12789: opcional).
   * `null` = sem espelho: as pastas vêm do remote, o bruto é sempre baixado e
   * conferido, e nenhum bisync é pausado (nenhum cobre a pasta).
   */
  localRoot: string | null;
  archiveRoot: string;
  remoteRoot: string;
  remoteName: string;
  dataRoot: string;
  rclone: string;
  systemctl: string;
  md5sum: string;
  mountpointCmd: string[];
  waitMinutes: number;
  pollSeconds: number;
  /** Pausa o `diaria-gdrive-bisync.timer` com `--apply`. Só vale com espelho (`localRoot`): sem ele, nada a pausar. */
  pauseBisync: boolean;
  /** #12573: trava contra duas execuções com `--apply` ao mesmo tempo. */
  lockPath: string;
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name}=${raw} não é um número >= 0`);
  return n;
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): ArchiveConfig {
  const mount = env.VIDEO_ARCHIVE_MOUNT ?? DEFAULT_MOUNT;
  // #12789: vazio conta como ausente (um `VIDEO_ARCHIVE_REMOTE=` no .env não vira remote "").
  const remoteName = env.VIDEO_ARCHIVE_REMOTE || DEFAULT_VIDEO_REMOTE;
  // #12789: espelho e origem andam juntos. Um VIDEO_ARCHIVE_LOCAL_ROOT sobrado (o espelho da pasta antiga) com
  // a origem default listaria as pastas do espelho antigo e conferiria contra a diaria-studio-video. Recusa.
  if (env.VIDEO_ARCHIVE_LOCAL_ROOT && !env.VIDEO_ARCHIVE_REMOTE_ROOT) {
    throw new Error(
      "VIDEO_ARCHIVE_LOCAL_ROOT (espelho) exige VIDEO_ARCHIVE_REMOTE_ROOT apontando para a mesma pasta no Drive (#12789)",
    );
  }
  const remoteRoot = env.VIDEO_ARCHIVE_REMOTE_ROOT || `${remoteName}${VIDEO_FOLDER_REL}`;
  // Sem `:` o rclone lê o valor como pasta LOCAL: listaria o disco e o `deletefile` apagaria nele.
  if (!remoteRoot.includes(":")) {
    throw new Error(`VIDEO_ARCHIVE_REMOTE_ROOT/VIDEO_ARCHIVE_REMOTE=${remoteRoot} não tem "remote:" (#12789)`);
  }
  return {
    mount,
    // #12789: sem espelho por default; vazio também é "sem espelho".
    localRoot: env.VIDEO_ARCHIVE_LOCAL_ROOT || null,
    archiveRoot: env.VIDEO_ARCHIVE_ROOT ?? join(mount, "arquivo-video"),
    remoteRoot,
    remoteName,
    dataRoot: env.VIDEO_ARCHIVE_DATA_ROOT ?? join(ROOT, "data"),
    rclone: env.RCLONE_BIN ?? join(homedir(), ".local", "bin", "rclone"),
    systemctl: env.SYSTEMCTL_BIN ?? "systemctl",
    md5sum: env.MD5SUM_BIN ?? "md5sum",
    mountpointCmd: (env.VIDEO_ARCHIVE_MOUNTPOINT_CMD ?? "mountpoint -q").split(" ").filter(Boolean),
    waitMinutes: positiveNumber(env.VIDEO_ARCHIVE_WAIT_MINUTES, 90, "VIDEO_ARCHIVE_WAIT_MINUTES"),
    pollSeconds: positiveNumber(env.VIDEO_ARCHIVE_POLL_SECONDS, 15, "VIDEO_ARCHIVE_POLL_SECONDS"),
    pauseBisync: env.VIDEO_ARCHIVE_NO_BISYNC_PAUSE !== "1",
    lockPath: env.VIDEO_ARCHIVE_LOCK ?? join(homedir(), ".cache", "diaria", "video-bruto-archive", "run.lock"),
  };
}

export type FileStatus =
  | "arquivado"
  | "sairia"
  | "nao-apagado-sem-permissao"
  | "nome-duplicado-no-drive"
  // #13675: dois finais/prévias com o mesmo nome (re-upload do editor). Fica no Drive e vira aviso, não falha.
  | "final-nome-duplicado-mantido"
  | "em-uso-por-outra-edicao"
  | "falha-conferencia"
  | "falha-download"
  | "falha-mover"
  | "falha-apagar"
  | "falha-guardar-copia"
  // #13632: bruto da pasta de uma edição renomeada, movido para a pasta nova.
  | "moveria-para-edicao-renomeada"
  | "movido-para-edicao-renomeada"
  | "ja-na-edicao-renomeada"
  | "conflito-na-edicao-renomeada"
  | "nao-movido-sem-permissao"
  | "falha-mover-renomeada"
  // #13627: cópia duplicada entre pastas, para a lixeira do Drive.
  | "duplicata-sairia"
  | "duplicata-na-lixeira"
  | "duplicata-nao-apagada-sem-permissao"
  | "falha-apagar-duplicata";

/** Exaustivo de propósito: um status novo não compila sem dizer se é falha. */
export const STATUS_IS_FAILURE: Record<FileStatus, boolean> = {
  arquivado: false,
  sairia: false,
  "nao-apagado-sem-permissao": false,
  "nome-duplicado-no-drive": true,
  "final-nome-duplicado-mantido": false,
  "em-uso-por-outra-edicao": false,
  "falha-conferencia": true,
  "falha-download": true,
  "falha-mover": true,
  "falha-apagar": true,
  "falha-guardar-copia": true,
  "moveria-para-edicao-renomeada": false,
  "movido-para-edicao-renomeada": false,
  "ja-na-edicao-renomeada": false,
  "conflito-na-edicao-renomeada": true,
  "nao-movido-sem-permissao": false,
  "falha-mover-renomeada": true,
  "duplicata-sairia": false,
  "duplicata-na-lixeira": false,
  "duplicata-nao-apagada-sem-permissao": false,
  "falha-apagar-duplicata": true,
};

/**
 * #13631: o que não é falha mas o editor precisa saber (o Drive recusou mexer
 * num arquivo de outro dono; ou, #13675, um final de nome repetido que ficou no
 * Drive). É o único aviso da rodada diária fora das falhas
 * (que deixam a unit `failed`): a rotina roda todo dia e não pode virar ruído.
 */
export const STATUS_NEEDS_NOTICE: ReadonlySet<FileStatus> = new Set<FileStatus>([
  "nao-apagado-sem-permissao",
  "final-nome-duplicado-mantido",
  "nao-movido-sem-permissao",
  "duplicata-nao-apagada-sem-permissao",
]);

export interface FileResult {
  folder: string;
  path: string;
  sizeBytes: number;
  status: FileStatus;
  /** Ausente = bruto. `final` = final/prévia/editado (#13630); `duplicata` = cópia entre pastas (#13627). */
  kind?: "final" | "duplicata";
  source?: "arquivo" | "espelho" | "download";
  verify?: VerifyVerdict;
  detail?: string;
}

export interface ArchiveReport {
  at: string;
  applied: boolean;
  folders: FolderDecision[];
  /** #13630: pastas com finais/prévias/editados liberados (ou o motivo de não). */
  finalsFolders: FinalsDecision[];
  files: FileResult[];
  errors: string[];
  warnings: string[];
  driveFreeBefore: number | null;
  driveFreeAfter: number | null;
  archivedBytes: number;
  /** #13627: duplicatas mandadas para a lixeira do Drive (ainda contam na cota por 30 dias). */
  trashedBytes: number;
}

/**
 * Parada pedida por sinal (#12603). `signal` marca a parada; os filhos em curso
 * morrem na hora e nenhum filho novo sobe (salvo o que religa o timer).
 */
export interface StopController {
  signal: NodeJS.Signals | null;
  children: Set<ChildProcess>;
}

export function createStopController(): StopController {
  return { signal: null, children: new Set() };
}

/** Marca a parada e mata os filhos em curso. Repetido, mata com SIGKILL. */
export function requestStop(stop: StopController, sig: NodeJS.Signals): void {
  const again = stop.signal !== null;
  if (!again) stop.signal = sig;
  for (const c of stop.children) c.kill(again ? "SIGKILL" : "SIGTERM");
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Roda um filho sem bloquear o event loop (o handler do sinal precisa rodar no meio). */
function run(
  stop: StopController,
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; evenIfStopped?: boolean } = {},
): Promise<RunResult> {
  if (stop.signal && !opts.evenIfStopped) {
    return Promise.resolve({ ok: false, stdout: "", stderr: `não executado: ${stop.signal} recebido` });
  }
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ ok: false, stdout: "", stderr: (e as Error).message });
      return;
    }
    stop.children.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let extra = "";
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          extra += ` timeout de ${opts.timeoutMs} ms`;
          child.kill("SIGTERM");
        }, opts.timeoutMs)
      : undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stop.children.delete(child);
      done({ ok: code === 0 && !extra, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") + extra });
    };
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      extra += ` ${e.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

async function driveFree(cfg: ArchiveConfig, stop: StopController, warnings: string[]): Promise<number | null> {
  const r = await run(stop, cfg.rclone, ["about", cfg.remoteName, "--json"], { timeoutMs: 120_000 });
  const free = r.ok ? (parseRcloneAboutJson(r.stdout)?.free ?? null) : null;
  if (free === null) warnings.push(`rclone about falhou ou veio ilegível: ${r.stderr.trim().slice(-200) || r.stdout.trim().slice(0, 200)}`);
  return free;
}

/**
 * Erro do Drive que significa "esta conta não pode apagar" (arquivo de outro
 * dono). Estreito de propósito: rate limit e cota também chegam como
 * `Error 403` e são falha, nunca "sem permissão".
 */
export function isPermissionError(stderr: string): boolean {
  if (/rateLimit|userRateLimit|dailyLimit|quotaExceeded|storageQuota/i.test(stderr)) return false;
  return /insufficientFilePermissions|insufficient permissions|does not have sufficient permissions|canDelete|cannotDeleteFile/i.test(stderr);
}

/** `is-active` que libera seguir: só os estados de unit parada. */
export function bisyncIdle(state: string): boolean {
  return state === "inactive" || state === "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Para o timer do bisync (se estava ativo) e espera a rodada em curso
 * terminar. Devolve se o timer estava ativo (= deve ser religado). Lança se a
 * rodada não terminar no prazo, já com `timerWasActive` preenchido em `state`.
 */
export async function pauseBisync(
  cfg: ArchiveConfig,
  stop: StopController,
  state: { timerWasActive: boolean },
  log: (l: string) => void,
): Promise<void> {
  state.timerWasActive = (await run(stop, cfg.systemctl, ["--user", "is-active", BISYNC_TIMER])).stdout.trim() === "active";
  if (state.timerWasActive) {
    const st = await run(stop, cfg.systemctl, ["--user", "stop", BISYNC_TIMER]);
    if (!st.ok) throw new Error(`não consegui parar ${BISYNC_TIMER}: ${st.stderr.trim()}`);
    log(`${LOG_PREFIX} ${BISYNC_TIMER} parado; esperando a rodada em curso do bisync terminar.`);
  } else {
    log(`${LOG_PREFIX} ${BISYNC_TIMER} já estava parado; fica parado no fim.`);
  }
  const deadline = Date.now() + cfg.waitMinutes * 60_000;
  for (;;) {
    if (stop.signal) throw new Error(`${stop.signal} recebido na espera do bisync; nada arquivado`);
    const st = (await run(stop, cfg.systemctl, ["--user", "is-active", BISYNC_SERVICE])).stdout.trim();
    if (bisyncIdle(st)) return;
    if (Date.now() > deadline) throw new Error(`${BISYNC_SERVICE} seguia "${st}" depois de ${cfg.waitMinutes} min`);
    await sleep(Math.max(cfg.pollSeconds, 0.05) * 1000);
  }
}

/** Religa o timer; roda mesmo depois do sinal (é o que o sinal precisa garantir). */
export async function resumeBisync(cfg: ArchiveConfig, stop: StopController, log: (l: string) => void): Promise<string | null> {
  const r = await run(stop, cfg.systemctl, ["--user", "start", BISYNC_TIMER], { evenIfStopped: true });
  if (!r.ok) return `não consegui religar ${BISYNC_TIMER}: ${r.stderr.trim()}`;
  log(`${LOG_PREFIX} ${BISYNC_TIMER} religado.`);
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = existe, só é de outro usuário: conta como viva.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * #12573: trava por arquivo (`O_EXCL`) para duas execuções com `--apply` não
 * rodarem juntas (a task de sábado e uma rodada manual): a que terminasse
 * primeiro religaria o timer do bisync no meio da outra, e as duas podiam
 * pegar o mesmo bruto. Lock de PID morto é retomado. Devolve a função que
 * solta a trava, ou a mensagem de erro (a 2ª execução sai sem tocar no timer).
 *
 * Premissa declarada: a retomada olha só o PID. Um PID reaproveitado por
 * outro processo depois de um SIGKILL deixa a trava presa (a rodada falha alto
 * com o caminho do lock na mensagem), nunca solta a trava de uma rodada viva.
 */
export function acquireRunLock(lockPath: string, alive: (pid: number) => boolean = pidAlive): { release: () => void } | { error: string } {
  mkdirSync(dirname(lockPath), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { error: `não consegui criar a trava ${lockPath}: ${(e as Error).message}` };
      let text = "";
      try {
        text = readFileSync(lockPath, "utf8");
      } catch {
        // Sumiu entre o open e a leitura: a outra execução acabou de soltar; tenta de novo.
        continue;
      }
      const holder = parseRunLock(text);
      if (!runLockIsStale(holder, alive)) {
        return { error: `outra execução com --apply está em curso (PID ${holder}, trava ${lockPath}); nada feito, timer do bisync intocado` };
      }
      rmSync(lockPath, { force: true });
      continue;
    }
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return {
      release: () => {
        try {
          if (parseRunLock(readFileSync(lockPath, "utf8")) === process.pid) rmSync(lockPath, { force: true });
        } catch {
          // Trava já removida: nada a soltar.
        }
      },
    };
  }
  return { error: `não consegui obter a trava ${lockPath} (disputada por outra execução)` };
}

/**
 * Pastas de edição candidatas: do espelho, quando há um; senão do remote
 * (#12789, `rclone lsjson --dirs-only`, só o 1º nível). Erro do rclone ou
 * listagem ilegível = `{ error }`, e a rodada não faz nada. `duplicates` =
 * nomes de pasta repetidos no Drive (a rodada não toca neles).
 */
async function listFolders(
  cfg: ArchiveConfig,
  stop: StopController,
): Promise<{ names: string[]; duplicates: string[] } | { error: string }> {
  if (cfg.localRoot !== null) {
    const names = readdirSync(cfg.localRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return { names, duplicates: [] }; // um sistema de arquivos não tem dois nomes iguais
  }
  const r = await run(stop, cfg.rclone, ["lsjson", "--dirs-only", ...DRIVE_FLAGS, cfg.remoteRoot], { timeoutMs: 300_000 });
  if (!r.ok) return { error: `pasta de vídeo ${cfg.remoteRoot}: rclone lsjson --dirs-only falhou (${r.stderr.trim().slice(-300)}) — nada feito` };
  try {
    return parseRcloneLsjsonDirs(r.stdout);
  } catch (e) {
    return { error: `pasta de vídeo ${cfg.remoteRoot}: listagem das pastas ilegível (${(e as Error).message}) — nada feito` };
  }
}

/** Publicação de cada edição que a pasta segue (#13632: já com a renomeação). */
function publishedSignals(
  cfg: ArchiveConfig,
  name: string,
  warnings: string[],
  renamedTo?: Readonly<Record<string, string>>,
): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  const haveEditions = existsSync(join(cfg.dataRoot, "editions"));
  for (const e of effectiveEditionsOfFolder(name, renamedTo) ?? []) {
    if (!haveEditions) {
      out[e] = null;
      continue;
    }
    const sig = editionVideoPublished(editionDirUnder(cfg.dataRoot, e), e);
    if (sig.warning) warnings.push(sig.warning);
    out[e] = sig.value;
  }
  return out;
}

/** `source.json` da montagem, relativo à pasta da edição (`stateDir` default de `video-montagem.ts`). */
export const MONTAGE_SOURCE_REL = join("_internal", "video-montagem", "source.json");

export interface InUseRefs {
  /** `brutoRefKey` → edições em uso que o referenciam. */
  byKey: Map<string, string[]>;
  /** `source.json` ilegível de edição em uso: não dá para saber o que ela usa. */
  errors: string[];
}

/**
 * #12602: brutos usados pela montagem de edições que ainda não sairiam da
 * rodada. Varre `data/editions/{AAMM}/{AAMMDD}/` (sem `data/editions`, vazio:
 * aí só o teto de idade tira pastas, e a montagem em curso tem menos de 14
 * dias). Edição que já sairia (publicada há `publishedMinDays`, ou além do
 * teto) não segura nada.
 */
export function inUseMontageRefs(
  cfg: ArchiveConfig,
  today: Date,
  unpublishedMaxDays: number,
  publishedMinDays: number,
  warnings: string[],
): InUseRefs {
  const out: InUseRefs = { byKey: new Map(), errors: [] };
  const root = join(cfg.dataRoot, "editions");
  if (!existsSync(root)) return out;
  const editions: string[] = [];
  for (const aamm of readdirSync(root, { withFileTypes: true })) {
    if (!aamm.isDirectory() || !/^\d{4}$/.test(aamm.name)) continue;
    for (const ed of readdirSync(join(root, aamm.name), { withFileTypes: true })) {
      if (ed.isDirectory() && /^\d{6}$/.test(ed.name) && ed.name.startsWith(aamm.name)) editions.push(ed.name);
    }
  }
  for (const e of editions.sort()) {
    const src = join(editionDirUnder(cfg.dataRoot, e), MONTAGE_SOURCE_REL);
    if (!existsSync(src)) continue;
    const own = decideFolder({ name: e, published: publishedSignals(cfg, e, warnings) }, today, unpublishedMaxDays, publishedMinDays);
    if (own.eligible) continue;
    let refs: string[] | null;
    try {
      refs = montageSourceRefs(JSON.parse(readFileSync(src, "utf8")));
    } catch (err) {
      out.errors.push(`${e}: ${MONTAGE_SOURCE_REL} ilegível (${(err as Error).message}); sem saber que brutos a montagem usa, nenhum sai do Drive`);
      continue;
    }
    if (!refs) {
      out.errors.push(`${e}: ${MONTAGE_SOURCE_REL} sem "path"/"files" legíveis; sem saber que brutos a montagem usa, nenhum sai do Drive`);
      continue;
    }
    for (const r of refs) {
      const key = brutoRefKey(r);
      const list = out.byKey.get(key) ?? [];
      if (!list.includes(e)) list.push(e);
      out.byKey.set(key, list);
    }
  }
  return out;
}

function inUseResult(folder: string, f: RemoteFile, refs: InUseRefs): FileResult | null {
  const users = referencingEditions(f.path, refs.byKey);
  if (users.length === 0) return null;
  return {
    folder,
    path: f.path,
    sizeBytes: f.size,
    status: "em-uso-por-outra-edicao",
    detail: `usado pela montagem de ${users.join(", ")} (source.json), ainda não arquivável`,
  };
}

function fileSize(p: string): number | null {
  try {
    const st = statSync(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

async function listRemote(cfg: ArchiveConfig, stop: StopController, target: string): Promise<{ files: RemoteFile[] } | { error: string }> {
  const r = await run(stop, cfg.rclone, ["lsjson", "-R", "--files-only", "--hash", "--hash-type", "md5", ...DRIVE_FLAGS, target], { timeoutMs: 600_000 });
  if (!r.ok) return { error: `rclone lsjson falhou: ${r.stderr.trim().slice(-300)}` };
  try {
    return { files: parseRcloneLsjson(r.stdout) };
  } catch (e) {
    return { error: `listagem do Drive ilegível: ${(e as Error).message}` };
  }
}

/** O arquivo ainda está no Drive? `null` = não deu para saber. */
async function stillOnDrive(cfg: ArchiveConfig, stop: StopController, folder: string, path: string): Promise<boolean | null> {
  const parent = path.includes("/") ? `/${path.slice(0, path.lastIndexOf("/"))}` : "";
  const name = path.slice(path.lastIndexOf("/") + 1);
  const r = await run(stop, cfg.rclone, ["lsjson", "--files-only", ...DRIVE_FLAGS, `${cfg.remoteRoot}/${folder}${parent}`], { timeoutMs: 300_000 });
  if (!r.ok) return null;
  try {
    return parseRcloneLsjson(r.stdout).some((f) => f.path === name);
  } catch {
    return null;
  }
}

/** Timeout de cópia/MD5 proporcional ao tamanho (30 min + 10 min/GB): um rclone travado vira falha, não unit eterna. */
function sizeTimeoutMs(size: number): number {
  return Math.ceil(0.5 * HOUR_MS + (size / 1e9) * (HOUR_MS / 6)); // spawnSync exige inteiro
}

/** Processa um bruto (com `--apply`). Nunca lança: o erro vira status. */
async function archiveOne(cfg: ArchiveConfig, stop: StopController, folder: string, remote: RemoteFile): Promise<FileResult> {
  const base: FileResult = { folder, path: remote.path, sizeBytes: remote.size, status: "sairia" };
  try {
    return await archiveOneUnsafe(cfg, stop, folder, remote, base);
  } catch (e) {
    return { ...base, status: "falha-mover", detail: `erro inesperado: ${(e as Error).message}` };
  }
}

async function archiveOneUnsafe(
  cfg: ArchiveConfig,
  stop: StopController,
  folder: string,
  remote: RemoteFile,
  base: FileResult,
): Promise<FileResult> {
  const archivePath = join(cfg.archiveRoot, folder, ...remote.path.split("/"));
  // #12789: sem espelho, nunca há cópia do espelho; o bruto vem do arquivo ou de um download.
  const mirrorPath = cfg.localRoot === null ? null : join(cfg.localRoot, folder, ...remote.path.split("/"));
  const remotePath = `${cfg.remoteRoot}/${folder}/${remote.path}`;
  const timeoutMs = sizeTimeoutMs(remote.size);
  const check = async (p: string): Promise<{ verify: VerifyVerdict; md5Stderr: string }> => {
    const md5Run = await run(stop, cfg.md5sum, [p], { timeoutMs });
    const localMd5 = md5Run.ok ? parseMd5sumLine(md5Run.stdout) : null;
    return { verify: verifyCopy(remote, { size: fileSize(p) ?? -1, md5: localMd5 }), md5Stderr: md5Run.stderr };
  };
  const failVerify = (src: NonNullable<FileResult["source"]>, c: { verify: VerifyVerdict; md5Stderr: string }): FileResult => {
    const detail = c.verify === "md5-local-indisponivel" ? c.md5Stderr.trim().slice(-300) : undefined;
    return { ...base, source: src, verify: c.verify, status: "falha-conferencia", ...(detail ? { detail } : {}) };
  };

  const recordPath = `${archivePath}${VERIFIED_RECORD_SUFFIX}`;
  let source: NonNullable<FileResult["source"]> | null = null;
  let localPath = archivePath;
  if (fileSize(archivePath) === remote.size) {
    // #12570: a cópia guardada de um arquivo de outro dono não tem o MD5 recalculado toda rodada.
    const c = recordStillValid(recordPath, archivePath, remote) ? { verify: "ok" as const, md5Stderr: "" } : await check(archivePath);
    if (c.verify === "ok") source = "arquivo";
    // #12603: cópia de mesmo tamanho com outro conteúdo não trava o bruto; o espelho ou um download a substitui.
    else if (c.verify === "md5-diverge") base = { ...base, detail: "a cópia que estava no arquivo tinha MD5 diferente do Drive" };
    else return failVerify("arquivo", c);
  }
  if (source === null) {
    if (mirrorPath !== null && fileSize(mirrorPath) === remote.size) {
      source = "espelho";
      localPath = mirrorPath;
    } else {
      source = "download";
      const partial = `${archivePath}.partial`;
      try {
        mkdirSync(dirname(archivePath), { recursive: true });
      } catch (e) {
        return { ...base, source, status: "falha-download", detail: (e as Error).message };
      }
      const dl = await run(stop, cfg.rclone, ["copyto", remotePath, partial], { timeoutMs });
      if (!dl.ok) {
        rmSync(partial, { force: true });
        return { ...base, source, status: "falha-download", detail: dl.stderr.trim().slice(-500) };
      }
      const aside = setAsideConflict(archivePath);
      if ("error" in aside) {
        rmSync(partial, { force: true });
        return { ...base, source, status: "falha-download", detail: aside.error };
      }
      if (aside.moved) base = { ...base, detail: joinDetail(base.detail, `cópia anterior guardada em ${aside.moved}`) };
      renameSync(partial, archivePath);
    }
    // A cópia do arquivo que conferiu já foi checada acima; espelho e download são checados aqui.
    const c = await check(localPath);
    if (c.verify !== "ok") return failVerify(source, c);
  }
  const verify: VerifyVerdict = "ok";

  if (source === "espelho" && mirrorPath !== null) {
    try {
      mkdirSync(dirname(archivePath), { recursive: true });
      const aside = setAsideConflict(archivePath);
      if ("error" in aside) throw new Error(aside.error);
      if (aside.moved) base = { ...base, detail: joinDetail(base.detail, `cópia anterior guardada em ${aside.moved}`) };
      renameSync(mirrorPath, archivePath);
    } catch (e) {
      return { ...base, source, verify, status: "falha-mover", detail: (e as Error).message };
    }
  }

  const del = await run(stop, cfg.rclone, ["deletefile", "--drive-use-trash=false", ...DRIVE_FLAGS, remotePath], { timeoutMs: 600_000 });
  if (del.ok) {
    rmSync(recordPath, { force: true });
    return { ...base, source, verify, status: "arquivado" };
  }

  // O `deletefile` falhou. Reler antes de qualquer coisa: o Drive pode ter apagado e só a resposta se perdeu.
  const errText = del.stderr.trim().slice(-500);
  const present = await stillOnDrive(cfg, stop, folder, remote.path);
  if (present === false) {
    rmSync(recordPath, { force: true });
    return { ...base, source, verify, status: "arquivado", detail: `deletefile saiu com erro, mas o arquivo já não está no Drive: ${errText}` };
  }
  if (present === null) {
    // Sem saber se o Drive ainda tem o arquivo, a cópia conferida fica no arquivo (nunca volta ao espelho).
    return { ...base, source, verify, status: "falha-apagar", detail: `${errText} (não consegui reler o Drive; a cópia conferida ficou no arquivo)` };
  }
  // Continua no Drive: devolve a cópia ao espelho quando veio dele, senão o bisync tentaria apagar no Drive toda rodada.
  let restoreFailed = false;
  let restoreNote = "";
  if (source === "espelho" && mirrorPath !== null) {
    try {
      renameSync(archivePath, mirrorPath);
      restoreNote = " (cópia devolvida ao espelho)";
    } catch (e) {
      restoreFailed = true;
      restoreNote = ` (NÃO consegui devolver a cópia ao espelho: ${(e as Error).message})`;
    }
  }
  const permission = isPermissionError(del.stderr);
  if (!permission || restoreFailed) return { ...base, source, verify, status: "falha-apagar", detail: errText + restoreNote };

  // #12570: arquivo de outro dono. O espelho fica com a dele (o bisync não tenta apagar no Drive), e o arquivo
  // guarda uma cópia própria: se a dona apagar do Drive, o bisync apaga o espelho, e sem esta cópia não sobraria nada.
  if (source === "espelho" && mirrorPath !== null) {
    rmSync(recordPath, { force: true });
    const kept = await keepArchiveCopy(mirrorPath, archivePath, remote.size);
    if (kept) return { ...base, source, verify, status: "falha-guardar-copia", detail: `${errText}${restoreNote}; ${kept}` };
    restoreNote += "; cópia guardada no arquivo";
  } else {
    // A cópia conferida já está no arquivo (veio dele ou do download): registra o MD5 para a próxima rodada não recalcular.
    writeVerifiedRecord(recordPath, archivePath, remote);
  }
  return { ...base, source, verify, status: "nao-apagado-sem-permissao", detail: errText + restoreNote };
}

/**
 * #12789: antes de pôr a cópia conferida no lugar, a cópia que já estava no
 * arquivo com o mesmo nome (e que não conferiu com o Drive: tamanho ou MD5
 * diferente, chegou aqui por isso) vai para `{arquivo}.conflito-{timestamp}`
 * em vez de ser sobrescrita. Pode ser um bruto homônimo de outra pasta (a
 * antiga, da vjpixel), e o arquivo do HD é a única cópia que sobra dele.
 * `moved` = para onde foi (`null` = não havia cópia).
 */
export function setAsideConflict(archivePath: string, now: Date = new Date()): { moved: string | null } | { error: string } {
  if (!existsSync(archivePath)) return { moved: null };
  const target = `${archivePath}.conflito-${now.toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(archivePath, target);
    // O registro de MD5 era da cópia que saiu: não vale para a nova.
    rmSync(`${archivePath}${VERIFIED_RECORD_SUFFIX}`, { force: true });
    return { moved: target };
  } catch (e) {
    return { error: `não consegui guardar a cópia anterior do arquivo em ${target}: ${(e as Error).message}` };
  }
}

function joinDetail(a: string | undefined, b: string): string {
  return a ? `${a}; ${b}` : b;
}

/** O registro do MD5 conferido vale para a cópia de hoje? Ilegível/ausente = não (recalcula). */
function recordStillValid(recordPath: string, archivePath: string, remote: RemoteFile): boolean {
  try {
    const st = statSync(archivePath);
    const rec = parseVerifiedRecord(JSON.parse(readFileSync(recordPath, "utf8")));
    return verifiedRecordTrusted(rec, { size: st.size, mtimeMs: st.mtimeMs }, remote);
  } catch {
    return false;
  }
}

/** Grava o registro do MD5 conferido. Falhar aqui só custa um recálculo na próxima rodada. */
function writeVerifiedRecord(recordPath: string, archivePath: string, remote: RemoteFile): void {
  if (!remote.md5) return;
  try {
    const st = statSync(archivePath);
    writeFileSync(recordPath, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, md5: remote.md5 }) + "\n");
  } catch {
    // Sem registro, a próxima rodada recalcula o MD5.
  }
}

/**
 * #12570: copia a cópia conferida do espelho para o arquivo (reflink quando o
 * sistema de arquivos permite), via `.partial` + rename, para um corte no meio
 * nunca deixar no arquivo uma cópia truncada com o nome final. Assíncrono para
 * o handler de sinal seguir rodando. Devolve a mensagem de erro, ou `null`.
 * Sem registro de MD5: a cópia nova é conferida de verdade na próxima rodada,
 * que então grava o registro.
 */
async function keepArchiveCopy(mirrorPath: string, archivePath: string, size: number): Promise<string | null> {
  const partial = `${archivePath}.partial`;
  try {
    mkdirSync(dirname(archivePath), { recursive: true });
    await copyFile(mirrorPath, partial, fsConstants.COPYFILE_FICLONE);
    if (fileSize(partial) !== size) throw new Error(`a cópia saiu com ${fileSize(partial)} bytes, esperado ${size}`);
    renameSync(partial, archivePath);
    return null;
  } catch (e) {
    rmSync(partial, { force: true });
    return `NÃO consegui guardar a cópia no arquivo: ${(e as Error).message}`;
  }
}

export async function runArchive(opts: {
  cfg: ArchiveConfig;
  apply: boolean;
  today: Date;
  unpublishedMaxDays: number;
  /** #12602: idade mínima da pasta publicada; default `DEFAULT_ARCHIVE_PUBLISHED_MIN_DAYS`. */
  publishedMinDays?: number;
  only?: Set<string>;
  log?: (l: string) => void;
  /** #12603: parada por sinal; `main` liga SIGTERM/SIGINT nele. */
  stop?: StopController;
}): Promise<ArchiveReport> {
  const { cfg, apply } = opts;
  const stop = opts.stop ?? createStopController();
  const log = opts.log ?? (() => {});
  const report: ArchiveReport = {
    at: new Date().toISOString(),
    applied: apply,
    folders: [],
    finalsFolders: [],
    files: [],
    errors: [],
    warnings: [],
    driveFreeBefore: null,
    driveFreeAfter: null,
    archivedBytes: 0,
    trashedBytes: 0,
  };

  // #12573: com --apply, uma execução por vez. A 2ª sai antes de tocar no timer do bisync.
  let releaseLock: (() => void) | null = null;
  if (apply) {
    const lock = acquireRunLock(cfg.lockPath);
    if ("error" in lock) {
      report.errors.push(lock.error);
      return report;
    }
    releaseLock = lock.release;
  }
  try {
    return await runArchiveLocked(opts, cfg, apply, stop, log, report);
  } finally {
    releaseLock?.();
  }
}

async function runArchiveLocked(
  opts: Parameters<typeof runArchive>[0],
  cfg: ArchiveConfig,
  apply: boolean,
  stop: StopController,
  log: (l: string) => void,
  report: ArchiveReport,
): Promise<ArchiveReport> {
  const [mpBin, ...mpArgs] = cfg.mountpointCmd;
  if (!(await run(stop, mpBin, [...mpArgs, cfg.mount])).ok) {
    report.errors.push(`${cfg.mount} não está montado — nada feito`);
    return report;
  }
  if (cfg.localRoot !== null && !existsSync(cfg.localRoot)) {
    report.errors.push(`pasta de vídeo ${cfg.localRoot} ausente no espelho — nada feito`);
    return report;
  }

  const publishedMinDays = opts.publishedMinDays ?? DEFAULT_ARCHIVE_PUBLISHED_MIN_DAYS;
  const listed = await listFolders(cfg, stop);
  if ("error" in listed) {
    report.errors.push(listed.error);
    return report;
  }
  const wanted = (n: string) => !opts.only || opts.only.has(n);
  // #12789: duas pastas com o mesmo nome no Drive. O lsjson junta o conteúdo das duas e o deletefile resolve por
  // nome: o arquivo conferido numa pode não ser o apagado na outra. Erro da edição, nada baixado nem apagado dela;
  // as demais seguem (mesmo espírito do `nome-duplicado-no-drive` dos arquivos).
  const allDupFolders = new Set(listed.duplicates);
  const dupFolders = new Set(listed.duplicates.filter(wanted));
  for (const name of dupFolders) {
    report.errors.push(`${name}: pasta de edição com nome duplicado no Drive; nada baixado nem apagado dela (junte ou renomeie as pastas)`);
  }
  // Pastas de edição sem nome repetido: as que a renomeação, os finais e as duplicatas enxergam.
  const editionFolders = listed.names.filter((n) => editionsOfFolder(n) !== null && !allDupFolders.has(n));

  // #13632/#13627: uma listagem recursiva da pasta de vídeo inteira (só metadados, o Drive devolve o MD5).
  // Só sem espelho (o default): com espelho (rodada manual da pasta antiga) toda listagem do Drive que decide
  // o que sai tem de vir depois da pausa do bisync, e a renomeação e as duplicatas ficam fora.
  let allFiles: FolderFile[] | null = null;
  if (cfg.localRoot === null) {
    const all = await listAllFolders(cfg, stop, new Set(editionFolders));
    if ("error" in all) report.errors.push(all.error);
    else allFiles = all.files;
  } else {
    report.warnings.push("com espelho (VIDEO_ARCHIVE_LOCAL_ROOT), a renomeação de edição e as duplicatas entre pastas ficam fora da rodada (#13632, #13627)");
  }
  const renamedTo = allFiles ? await readRenames(cfg, stop, allFiles, report.warnings) : {};

  report.folders = listed.names
    .filter((n) => wanted(n) && !dupFolders.has(n))
    .map((name) => {
      const ren = renamesOfFolder(name, renamedTo);
      return decideFolder(
        { name, published: publishedSignals(cfg, name, report.warnings, ren), ...(ren ? { renamedTo: ren } : {}) },
        opts.today,
        opts.unpublishedMaxDays,
        publishedMinDays,
      );
    });
  const eligible = report.folders.filter((f) => f.eligible).map((f) => f.name);
  report.finalsFolders = decideFinals(cfg, report.folders.map((f) => f.name), renamedTo, report.warnings);
  const finalsEligible = new Set(report.finalsFolders.filter((f) => f.eligible).map((f) => f.name));
  // #13632: bruto da pasta antiga de uma edição renomeada vai para a pasta nova.
  const renameMoves = allFiles ? planRenameMoves(report.folders, allFiles, new Set(editionFolders)) : [];
  const needRefs = eligible.length > 0 || renameMoves.length > 0 || allFiles !== null;
  const refs = needRefs ? inUseMontageRefs(cfg, opts.today, opts.unpublishedMaxDays, publishedMinDays, report.warnings) : { byKey: new Map<string, string[]>(), errors: [] };
  report.errors.push(...refs.errors);
  const dedupWarnings = () => {
    report.warnings = [...new Set(report.warnings)];
  };
  /** Pastas a listar: as dos brutos e as dos finais liberados, na ordem do nome. */
  const workFolders = [...new Set([...eligible, ...finalsEligible])].sort();
  const workFilesOf = (folder: string, files: RemoteFile[]): Array<{ f: RemoteFile; kind?: "final" }> => [
    ...(eligible.includes(folder) ? brutoFilesOf(files).map((f) => ({ f })) : []),
    ...(finalsEligible.has(folder) ? files.filter((f) => f.size > 0 && isFinalOrPreviewFile(f.path)).map((f) => ({ f, kind: "final" as const })) : []),
  ];

  if (!apply) {
    // Dry-run: lista sem pausar nada (só leitura).
    const leaving = new Set<string>();
    for (const m of renameMoves) {
      const res = renameMoveVerdict(m, refs, allFiles ?? []);
      report.files.push(res ?? { folder: m.from, path: m.file.path, sizeBytes: m.file.size, status: "moveria-para-edicao-renomeada", detail: `para ${m.to}/${m.file.path} (#13632)` });
      if (!res) leaving.add(`${m.from}/${m.file.path}`);
    }
    for (const name of workFolders) {
      const l = await listRemote(cfg, stop, `${cfg.remoteRoot}/${name}`);
      if ("error" in l) {
        report.errors.push(`${name}: ${l.error}`);
        continue;
      }
      for (const { f, kind } of workFilesOf(name, l.files)) {
        if (leaving.has(`${name}/${f.path}`)) continue;
        const inUse = kind ? null : inUseResult(name, f, refs);
        report.files.push(inUse ?? { folder: name, path: f.path, sizeBytes: f.size, status: "sairia", ...(kind ? { kind } : {}) });
        if (!inUse) leaving.add(`${name}/${f.path}`);
      }
    }
    if (allFiles && refs.errors.length === 0) {
      const rest = allFiles.filter((f) => !leaving.has(`${f.folder}/${f.path}`));
      for (const d of await planDuplicates(cfg, stop, rest, eligible, refs, report)) {
        if (wanted(d.file.folder)) report.files.push(duplicateResult(d, "duplicata-sairia"));
      }
    }
    dedupWarnings();
    return report;
  }
  dedupWarnings();
  const maybeDuplicates = allFiles !== null && foldersWithRemovalCandidates(allFiles, new Set(eligible)).length > 0;
  if (workFolders.length === 0 && renameMoves.length === 0 && !maybeDuplicates) return report;
  // Sem saber que brutos uma montagem em curso usa, nada sai do Drive (#12602).
  if (refs.errors.length > 0) return report;

  // #12789: sem espelho, nenhum bisync cobre a pasta; não há o que pausar.
  const pause = cfg.pauseBisync && cfg.localRoot !== null;
  const bisync = { timerWasActive: false };
  let resumed = false;
  const resume = async () => {
    if (resumed || !pause) return;
    resumed = true;
    if (!bisync.timerWasActive) return;
    const err = await resumeBisync(cfg, stop, log);
    if (err) report.errors.push(err);
  };
  const interrupted = () => {
    if (!stop.signal) return false;
    report.errors.push(`${stop.signal} recebido: rodada interrompida; o que faltou fica para a próxima`);
    return true;
  };
  try {
    if (pause) {
      try {
        await pauseBisync(cfg, stop, bisync, log);
      } catch (e) {
        report.errors.push((e as Error).message);
        return report;
      }
    }
    if (interrupted()) return report;
    report.driveFreeBefore = await driveFree(cfg, stop, report.warnings);

    // #13632: antes de listar as pastas, os brutos da edição renomeada vão para a pasta nova (depois da pausa,
    // para o bisync ver o estado final). Os que foram saem com a edição nova, pela regra normal dela.
    for (const m of renameMoves) {
      if (stop.signal) break;
      const res = renameMoveVerdict(m, refs, allFiles ?? []) ?? (await moveRenamed(cfg, stop, m));
      report.files.push(res);
      log(`${LOG_PREFIX} ${m.from}/${m.file.path} → ${m.to}: ${res.status}${res.detail ? `: ${res.detail}` : ""}`);
    }

    // A listagem vem DEPOIS da pausa: tamanho e MD5 são os do estado que vai ser apagado.
    folders: for (const folder of workFolders) {
      if (stop.signal) break;
      const l = await listRemote(cfg, stop, `${cfg.remoteRoot}/${folder}`);
      if ("error" in l) {
        report.errors.push(`${folder}: ${l.error}`);
        continue;
      }
      const dups = duplicatePaths(l.files);
      for (const { f, kind } of workFilesOf(folder, l.files)) {
        // #12603: o sinal para a rodada entre um arquivo e outro.
        if (stop.signal) break folders;
        const inUse = kind ? null : inUseResult(folder, f, refs);
        if (inUse) {
          report.files.push(inUse);
          continue;
        }
        const k = kind ? { kind } : {};
        if (dups.has(f.path)) {
          // #13675: final/prévia com nome repetido é re-upload do editor; a rotina diária não pode ficar `failed`
          // todo dia por isso. Fica no Drive (nada baixado nem apagado) e entra no aviso; o bruto segue falha.
          report.files.push(
            kind === "final"
              ? { folder, path: f.path, sizeBytes: f.size, status: "final-nome-duplicado-mantido", ...k, detail: "dois arquivos com o mesmo nome no Drive; mantidos para o próximo ciclo (renomear ou apagar um deles)" }
              : { folder, path: f.path, sizeBytes: f.size, status: "nome-duplicado-no-drive", ...k, detail: "dois arquivos com o mesmo nome no Drive; apagar por nome não diz qual sai" },
          );
          continue;
        }
        log(`${LOG_PREFIX} ${folder}/${f.path} (${formatBytes(f.size)})…`);
        const res = { ...(await archiveOne(cfg, stop, folder, f)), ...k };
        report.files.push(res);
        if (res.status === "arquivado") {
          report.archivedBytes += res.sizeBytes;
          appendRegistry(cfg, folder, { kind: kind ?? "bruto", path: f.path, size: f.size, md5: f.md5, destino: join(cfg.archiveRoot, folder, ...f.path.split("/")) }, report);
        }
        log(`${LOG_PREFIX}   ${res.status}${res.detail ? `: ${res.detail}` : ""}`);
      }
    }
    if (interrupted()) return report;

    // #13627: duplicatas entre pastas, sobre a listagem DEPOIS do arquivamento (o que já saiu não conta).
    if (allFiles !== null) {
      const fresh = await listAllFolders(cfg, stop, new Set(editionFolders));
      if ("error" in fresh) report.errors.push(`duplicatas: ${fresh.error}`);
      else {
        for (const d of await planDuplicates(cfg, stop, fresh.files, eligible, refs, report)) {
          if (stop.signal) break;
          if (!wanted(d.file.folder)) continue;
          const res = await trashDuplicate(cfg, stop, d);
          report.files.push(res);
          if (res.status === "duplicata-na-lixeira") {
            report.trashedBytes += res.sizeBytes;
            appendRegistry(cfg, d.file.folder, { kind: "duplicata", path: d.file.path, size: d.file.size, md5: d.file.md5, destino: `lixeira do Drive (cópia de ${d.keptAt})` }, report);
          }
          log(`${LOG_PREFIX} duplicata ${d.file.folder}/${d.file.path}: ${res.status}${res.detail ? `: ${res.detail}` : ""}`);
        }
      }
    }
    if (interrupted()) return report;
    report.driveFreeAfter = await driveFree(cfg, stop, report.warnings);
  } finally {
    await resume();
  }
  dedupWarnings();
  return report;
}

// ── #13632: edição renomeada ────────────────────────────────────────────────

/** Listagem recursiva da pasta de vídeo inteira, só das pastas de edição em `folders`. */
async function listAllFolders(cfg: ArchiveConfig, stop: StopController, folders: ReadonlySet<string>): Promise<{ files: FolderFile[] } | { error: string }> {
  const l = await listRemote(cfg, stop, cfg.remoteRoot);
  if ("error" in l) return { error: `pasta de vídeo ${cfg.remoteRoot}: ${l.error}` };
  const files: FolderFile[] = [];
  for (const f of l.files) {
    const i = f.path.indexOf("/");
    if (i <= 0) continue;
    const folder = f.path.slice(0, i);
    if (folders.has(folder)) files.push({ folder, path: f.path.slice(i + 1), size: f.size, md5: f.md5 });
  }
  return { files };
}

/**
 * Lê o `_origem-brutos.json` de cada pasta que tem um e devolve `de → para`,
 * só para a edição antiga que NÃO tem pasta em `data/editions` (a renomeação
 * só decide pela pasta que ficou sem edição, #13632). Ilegível = aviso.
 */
async function readRenames(cfg: ArchiveConfig, stop: StopController, files: readonly FolderFile[], warnings: string[]): Promise<Record<string, string>> {
  const records: Array<{ folder: string; raw: unknown }> = [];
  for (const f of files) {
    if (f.path !== ORIGEM_BRUTOS_FILE) continue;
    const r = await run(stop, cfg.rclone, ["cat", ...DRIVE_FLAGS, `${cfg.remoteRoot}/${f.folder}/${ORIGEM_BRUTOS_FILE}`], { timeoutMs: 120_000 });
    if (!r.ok) {
      warnings.push(`${f.folder}/${ORIGEM_BRUTOS_FILE}: não consegui ler (${r.stderr.trim().slice(-200)}); renomeação ignorada`);
      continue;
    }
    try {
      records.push({ folder: f.folder, raw: JSON.parse(r.stdout) });
    } catch (e) {
      warnings.push(`${f.folder}/${ORIGEM_BRUTOS_FILE}: ilegível (${(e as Error).message}); renomeação ignorada`);
    }
  }
  const { map, warnings: w } = buildRenameMap(records);
  warnings.push(...w);
  const out: Record<string, string> = {};
  for (const [de, para] of map) {
    if (!existsSync(editionDirUnder(cfg.dataRoot, de))) out[de] = para;
  }
  return out;
}

/** As renomeações que valem para as edições do nome da pasta (`undefined` = nenhuma). */
function renamesOfFolder(name: string, renamedTo: Readonly<Record<string, string>>): Record<string, string> | undefined {
  const own = Object.fromEntries((editionsOfFolder(name) ?? []).filter((e) => renamedTo[e]).map((e) => [e, renamedTo[e]]));
  return Object.keys(own).length > 0 ? own : undefined;
}

interface RenameMove {
  from: string;
  to: string;
  file: FolderFile;
}

/**
 * Brutos a mover: só da pasta de uma edição única (`AAMMDD`) renomeada, e só
 * quando a pasta nova existe no Drive (sem nome repetido).
 */
function planRenameMoves(folders: readonly FolderDecision[], files: readonly FolderFile[], editionFolders: ReadonlySet<string>): RenameMove[] {
  const out: RenameMove[] = [];
  for (const d of folders) {
    const to = d.renamedTo?.[d.name];
    if (!to || !editionFolders.has(to)) continue;
    const own = files.filter((f) => f.folder === d.name);
    for (const f of brutoFilesOf(own)) out.push({ from: d.name, to, file: f });
  }
  return out;
}

/** Bruto que não se move (em uso, ou já há arquivo com o mesmo nome na pasta nova); `null` = mover. */
function renameMoveVerdict(m: RenameMove, refs: InUseRefs, files: readonly FolderFile[]): FileResult | null {
  const base = { folder: m.from, path: m.file.path, sizeBytes: m.file.size };
  const users = referencingEditions(m.file.path, refs.byKey);
  if (users.length > 0) {
    return { ...base, status: "em-uso-por-outra-edicao", detail: `usado pela montagem de ${users.join(", ")} (source.json); não movido para ${m.to}` };
  }
  const there = files.find((f) => f.folder === m.to && f.path === m.file.path);
  if (!there) return null;
  if (there.size === m.file.size && there.md5 !== null && there.md5 === m.file.md5) {
    return { ...base, status: "ja-na-edicao-renomeada", detail: `${m.to}/${m.file.path} já tem o mesmo conteúdo; esta cópia sai como duplicata (#13627)` };
  }
  return { ...base, status: "conflito-na-edicao-renomeada", detail: `${m.to}/${m.file.path} existe com outro conteúdo; nada movido (conferir à mão)` };
}

async function moveRenamed(cfg: ArchiveConfig, stop: StopController, m: RenameMove): Promise<FileResult> {
  const base = { folder: m.from, path: m.file.path, sizeBytes: m.file.size };
  const r = await run(
    stop,
    cfg.rclone,
    ["moveto", ...DRIVE_FLAGS, `${cfg.remoteRoot}/${m.from}/${m.file.path}`, `${cfg.remoteRoot}/${m.to}/${m.file.path}`],
    { timeoutMs: 600_000 },
  );
  if (r.ok) return { ...base, status: "movido-para-edicao-renomeada", detail: `para ${m.to}/${m.file.path}` };
  const err = r.stderr.trim().slice(-500);
  return { ...base, status: isPermissionError(r.stderr) ? "nao-movido-sem-permissao" : "falha-mover-renomeada", detail: err };
}

// ── #13630: finais, prévias e editados ──────────────────────────────────────

/** Decide os finais de cada pasta: edição liberada pelo `/diaria-publica` e sem agendamento pendente no banco. */
function decideFinals(cfg: ArchiveConfig, names: readonly string[], renamedTo: Readonly<Record<string, string>>, warnings: string[]): FinalsDecision[] {
  let itens: ReadonlyArray<{ id: string; edicao: string; estado: string }> | null;
  try {
    itens = loadAgendamentos(join(cfg.dataRoot, "agendamentos", "banco.json")).itens;
  } catch (e) {
    itens = null;
    warnings.push(`banco de agendamentos ilegível (${(e as Error).message}); nenhum final sai do Drive nesta rodada`);
  }
  return names.map((name) => {
    const ren = renamesOfFolder(name, renamedTo);
    const editions = effectiveEditionsOfFolder(name, ren) ?? [];
    const liberada: Record<string, boolean> = {};
    const pending: Record<string, string[]> = {};
    for (const e of editions) {
      liberada[e] = readLiberada(cfg, e);
      if (itens) pending[e] = pendingAgendamentosOf(itens, e);
    }
    return decideFinalsFolder({ name, liberada, pending: itens ? pending : null, ...(ren ? { renamedTo: ren } : {}) });
  });
}

function readLiberada(cfg: ArchiveConfig, edition: string): boolean {
  try {
    return parseVideoLiberada(JSON.parse(readFileSync(join(editionDirUnder(cfg.dataRoot, edition), VIDEO_LIBERADA_FILE), "utf8")), edition);
  } catch {
    return false;
  }
}

// ── #13627: duplicatas entre pastas ─────────────────────────────────────────

interface DuplicateRemoval {
  file: FolderFile;
  keptAt: string;
}

/** Plano das duplicatas: lê os XMLs da raiz só das pastas com candidata a sair; avisos dos retidos vão no relatório. */
async function planDuplicates(
  cfg: ArchiveConfig,
  stop: StopController,
  files: readonly FolderFile[],
  removable: readonly string[],
  refs: InUseRefs,
  report: ArchiveReport,
): Promise<DuplicateRemoval[]> {
  const removableSet = new Set(removable);
  const referencedByFolder = new Map<string, ReadonlySet<string> | null>();
  for (const folder of foldersWithRemovalCandidates(files, removableSet)) {
    const texts: Array<string | null> = [];
    for (const x of files.filter((f) => f.folder === folder && isRootXml(f.path))) {
      const r = await run(stop, cfg.rclone, ["cat", ...DRIVE_FLAGS, `${cfg.remoteRoot}/${folder}/${x.path}`], { timeoutMs: 120_000 });
      texts.push(r.ok ? r.stdout : null);
    }
    const names = referencedNamesOfXmls(texts);
    if (names === null) report.warnings.push(`${folder}: algum XML da raiz não pôde ser lido; nenhuma duplicata sai da pasta (#13627)`);
    referencedByFolder.set(folder, names);
  }
  const groups = planCrossFolderDuplicates(files, { removableFolders: removableSet, referencedByFolder, inUseKeys: new Set(refs.byKey.keys()) });
  const out: DuplicateRemoval[] = [];
  for (const g of groups) {
    const keptAt = `${g.keep[0].folder}/${g.keep[0].path}`;
    for (const f of g.remove) out.push({ file: f, keptAt });
  }
  return out;
}

function duplicateResult(d: DuplicateRemoval, status: FileStatus, extra?: string): FileResult {
  return {
    folder: d.file.folder,
    path: d.file.path,
    sizeBytes: d.file.size,
    status,
    kind: "duplicata",
    detail: `cópia de ${d.keptAt}${extra ? `; ${extra}` : ""}`,
  };
}

/** Manda a cópia para a LIXEIRA do Drive (reversível por 30 dias), nunca delete definitivo. */
async function trashDuplicate(cfg: ArchiveConfig, stop: StopController, d: DuplicateRemoval): Promise<FileResult> {
  const r = await run(
    stop,
    cfg.rclone,
    ["deletefile", "--drive-use-trash=true", ...DRIVE_FLAGS, `${cfg.remoteRoot}/${d.file.folder}/${d.file.path}`],
    { timeoutMs: 600_000 },
  );
  if (r.ok) return duplicateResult(d, "duplicata-na-lixeira");
  const err = r.stderr.trim().slice(-300);
  // #13619: lixeira em arquivo de outro dono dá 403; vira aviso, não falha.
  return duplicateResult(d, isPermissionError(r.stderr) ? "duplicata-nao-apagada-sem-permissao" : "falha-apagar-duplicata", err);
}

// ── registro por edição (#13630 item 5) ─────────────────────────────────────

/** Nome do registro do que saiu do Drive, na pasta da edição no arquivo do HD. */
export const ARCHIVE_REGISTRY_FILE = "_registro-arquivamento.jsonl";

/**
 * Acrescenta uma linha ao registro da edição (`{arquivo}/{pasta}/_registro-arquivamento.jsonl`):
 * o que saiu, de onde e para onde, para o editor recuperar um final. Falhar
 * aqui é falha da rodada: o arquivo já saiu do Drive.
 */
function appendRegistry(
  cfg: ArchiveConfig,
  folder: string,
  entry: { kind: "bruto" | "final" | "duplicata"; path: string; size: number; md5: string | null; destino: string },
  report: ArchiveReport,
): void {
  const file = join(cfg.archiveRoot, folder, ARCHIVE_REGISTRY_FILE);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), drive: `${cfg.remoteRoot}/${folder}/${entry.path}`, ...entry }) + "\n");
  } catch (e) {
    report.errors.push(`${folder}: não consegui gravar ${ARCHIVE_REGISTRY_FILE} (${(e as Error).message}); ${entry.path} já saiu do Drive`);
  }
}

/**
 * #13631: aviso ao editor sobre o que o Drive recusou mexer (arquivo de outro
 * dono). Uma issue por CONJUNTO de arquivos (o fingerprint é a lista): a rotina
 * roda todo dia e o mesmo conjunto não reabre nem reenvia nada. Falhas não
 * entram aqui: deixam a unit `failed` e o alarme de units pega.
 */
export function notDeletedFinding(report: ArchiveReport): NotifyEditorFinding | null {
  const list = report.files.filter((f) => STATUS_NEEDS_NOTICE.has(f.status));
  if (list.length === 0) return null;
  const keys = list.map((f) => `${f.status}:${f.folder}/${f.path}`).sort();
  let h = 0;
  for (const ch of keys.join("\n")) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  const lines = list.map((f) => `- \`${f.folder}/${f.path}\` (${formatBytes(f.sizeBytes)}): ${f.status}${f.detail ? ` — ${f.detail.slice(0, 200)}` : ""}`);
  return {
    check: "video-drive-cleanup-nao-apagado",
    fingerprint: `video-drive-cleanup-nao-apagado:${(h >>> 0).toString(16)}`,
    severity: "acao",
    subject: `Vídeo no Drive: ${list.length} arquivo(s) que a rotina não conseguiu apagar ou mover (outro dono)`,
    body: [
      "A rotina diária do vídeo (`Diaria-Video-Bruto-Archive`, `scripts/archive-video-brutos.ts`) não conseguiu tirar do Drive estes arquivos: o Drive recusou por permissão (arquivo de outro dono, #12570/#13619) ou, em `final-nome-duplicado-mantido`, há dois arquivos com o mesmo nome em `Final/`/`Editado(s)/` (ou duas prévias) e apagar por nome não diz qual sai (#13675). A cópia conferida dos arquivados fica no HD do 300; as duplicatas, os brutos de edição renomeada e os finais de nome repetido continuam no Drive.",
      "",
      ...lines,
      "",
      "Ação: apagar (ou mover) à mão pela conta dona, ou transferir a posse para a diaria.editor. Nos finais de nome repetido, renomear ou apagar um dos dois: a rotina do dia seguinte arquiva o resto.",
    ].join("\n"),
    priority: "P3",
    labels: ["enhancement"],
    legacyResendIntent: "dedupe-new-occurrences-only",
  };
}

export function reportFailed(report: ArchiveReport): boolean {
  return report.errors.length > 0 || report.files.some((f) => STATUS_IS_FAILURE[f.status]);
}

const FOLDER_REASON: Record<FolderDecision["reason"], string> = {
  publicado: "vídeo publicado",
  "teto-sem-publicacao": "sem registro de publicação, passou do teto",
  "nome-fora-do-padrao": "nome fora de AAMMDD ou data inválida",
  "aguardando-publicacao": "vídeo ainda não publicado",
  "publicacao-desconhecida": "publicação desconhecida (sem a pasta da edição em data/editions)",
  "publicado-recente": "horizontal publicado, esperando o Short e os cortes dos dias seguintes",
};

function printText(report: ArchiveReport): void {
  for (const f of report.folders) {
    console.log(`  ${f.eligible ? "entra " : "fica  "} ${f.name}  (${f.ageDays ?? "?"}d, ${FOLDER_REASON[f.reason]})`);
  }
  for (const f of report.finalsFolders) {
    if (f.eligible) console.log(`  finais ${f.name}  (liberada pelo /diaria-publica)`);
    else if (f.reason === "agendamento-pendente") console.log(`  finais ficam ${f.name}  (agendamento pendente: ${f.detail})`);
  }
  for (const f of report.files) {
    const tag = f.kind === "final" ? " [final]" : f.kind === "duplicata" ? " [duplicata]" : "";
    console.log(`  ${f.status.padEnd(26)} ${f.folder}/${f.path}${tag}  ${formatBytes(f.sizeBytes)}${f.detail ? `  — ${f.detail}` : ""}`);
  }
  const leaving = report.files.filter((f) => f.status === "sairia" || f.status === "duplicata-sairia");
  const planned = leaving.reduce((n, f) => n + f.sizeBytes, 0);
  if (report.applied) {
    console.log(`${LOG_PREFIX} arquivado e apagado do Drive: ${formatBytes(report.archivedBytes)}; duplicatas na lixeira: ${formatBytes(report.trashedBytes)}.`);
    const fmt = (v: number | null) => (v === null ? "?" : formatBytes(v));
    console.log(`${LOG_PREFIX} Drive livre: antes ${fmt(report.driveFreeBefore)}, depois ${fmt(report.driveFreeAfter)}.`);
  } else {
    console.log(`${LOG_PREFIX} ${leaving.length} arquivo(s), ${formatBytes(planned)} sairiam do Drive.`);
    console.log(`${LOG_PREFIX} dry-run (default): nada movido nem apagado. Rode com --apply.`);
  }
  for (const w of report.warnings) console.error(`${LOG_PREFIX} aviso: ${w}`);
  for (const e of report.errors) console.error(`${LOG_PREFIX} erro: ${e}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "apply");
  const unpublishedMaxDays = getIntArg(argv, "unpublished-max-days", { min: 0 }) ?? DEFAULT_ARCHIVE_UNPUBLISHED_MAX_DAYS;
  const publishedMinDays = getIntArg(argv, "published-min-days", { min: 0 }) ?? DEFAULT_ARCHIVE_PUBLISHED_MIN_DAYS;
  const onlyRaw = getStringArg(argv, "only", { example: "261027,261028" });
  const only = onlyRaw ? new Set(onlyRaw.split(",").map((s) => s.trim()).filter(Boolean)) : undefined;
  const cfg = defaultConfig();
  // #12603: o sinal só marca a parada; a rodada para entre um bruto e outro e o `finally` religa o timer.
  const stop = createStopController();
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      console.error(`${LOG_PREFIX} ${sig} recebido; parando a rodada e religando o timer do bisync.`);
      requestStop(stop, sig);
    });
  }
  const report = await runArchive({
    cfg,
    apply,
    today: todayBrt(),
    unpublishedMaxDays,
    publishedMinDays,
    only,
    log: (l) => console.error(l),
    stop,
  });
  if (apply) {
    try {
      const dir = join(homedir(), ".cache", "diaria", "video-bruto-archive");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "last-report.json"), JSON.stringify(report, null, 2) + "\n");
    } catch (e) {
      // É o único registro durável do que saiu do Drive sem lixeira: sem ele, a rodada falha.
      console.error(`${LOG_PREFIX} erro: não consegui gravar o relatório: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
  if (hasFlag(argv, "json")) console.log(JSON.stringify(report, null, 2));
  else printText(report);
  if (reportFailed(report)) process.exitCode = 1;
  // #13631: rodada diária. Fora as falhas (unit `failed`), o único aviso é o "não apagado/movido" por permissão
  // e o final de nome repetido (#13675).
  const finding = apply ? notDeletedFinding(report) : null;
  if (finding) {
    try {
      const { notifyEditor } = await import("./lib/editor-notify.ts");
      const res = await notifyEditor(finding, { cwd: ROOT });
      if (res.issue?.action === "failed") console.error(`${LOG_PREFIX} aviso ao editor falhou: ${res.issue.error}`);
    } catch (e) {
      console.error(`${LOG_PREFIX} aviso ao editor falhou: ${(e as Error).message}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro: ${(e as Error).message}`);
    process.exit(1);
  });
}
