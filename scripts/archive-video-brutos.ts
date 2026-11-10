#!/usr/bin/env node
/**
 * scripts/archive-video-brutos.ts (#12548, resolve #12472)
 *
 * Guarda os brutos do vídeo da diária no HD do `300` e os apaga do Google
 * Drive. **Dry-run é o DEFAULT**: sem `--apply` só lista o que sairia, com
 * tamanho e motivo, sem tocar nada. Política pura (quais pastas, quais
 * arquivos, a conferência) em `scripts/lib/diaria/video-bruto-archive.ts`.
 *
 * Com `--apply`, primeiro pausa o bisync do Drive inteiro (#12356): para o
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
 *      tamanho com MD5 diferente (#12603), é sobrescrita, nunca trava o bruto;
 *   2. confere tamanho e MD5 contra o Drive. Divergência, MD5 local que não
 *      pôde ser calculado ou Drive sem MD5 = não apaga, exit 1;
 *   3. move a cópia do espelho para o arquivo (`rename`, mesmo disco);
 *   4. apaga do Drive de vez (`rclone deletefile --drive-use-trash=false`):
 *      arquivo na lixeira continua contando na cota por 30 dias.
 *      Se o `deletefile` falhar, o script RELÊ o arquivo no Drive antes de
 *      decidir: sumiu (o Drive apagou e só a resposta se perdeu) = arquivado;
 *      continua lá = a cópia volta ao espelho quando veio dele (senão o bisync
 *      tentaria apagar no Drive a cada rodada), e o arquivo sai como "não
 *      apagado" (permissão: arquivo de outro dono) ou como falha (exit 1);
 *      não deu para reler = a cópia conferida fica no arquivo e é falha.
 *      Devolver ao espelho sem reler podia perder o arquivo: o bisync veria
 *      "apagado no Drive" e apagaria o espelho, sem lixeira em lado nenhum.
 *
 * Nome repetido na mesma pasta do Drive (o Drive aceita) não é apagado:
 * `deletefile` não diz qual dos dois apaga, e só um foi conferido.
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
 * Task agendada: `Diaria-Video-Bruto-Archive` (sábado 03:00 BRT, `--apply`).
 *
 * Uso:
 *   npx tsx scripts/archive-video-brutos.ts                    # dry-run
 *   npx tsx scripts/archive-video-brutos.ts --apply            # arquiva e apaga do Drive
 *   npx tsx scripts/archive-video-brutos.ts --apply --only 261027,261028
 *   npx tsx scripts/archive-video-brutos.ts --json
 *   npx tsx scripts/archive-video-brutos.ts --published-min-days 7   # idade mínima da pasta publicada (default 4)
 *
 * Testável sem tocar produção: VIDEO_ARCHIVE_* e RCLONE_BIN/SYSTEMCTL_BIN/
 * MD5SUM_BIN/VIDEO_ARCHIVE_MOUNTPOINT_CMD sobrescrevíveis por env.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  brutoRefKey,
  decideFolder,
  duplicatePaths,
  editionsOfFolder,
  isBrutoFile,
  montageSourceRefs,
  parseMd5sumLine,
  parseRcloneLsjson,
  referencingEditions,
  verifyCopy,
  type FolderDecision,
  type RemoteFile,
  type VerifyVerdict,
} from "./lib/diaria/video-bruto-archive.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[archive-video-brutos]";

/** Pasta de vídeo da diária, relativa à raiz do Drive. O `／` (largo) é como o rclone grava a `/` do nome "Mentoria Fluxo/VTSD". */
export const VIDEO_FOLDER_REL = "Work/Mentoria Fluxo／VTSD/YouTube";
export const DEFAULT_MOUNT = "/mnt/hd-sata";
export const BISYNC_TIMER = "diaria-gdrive-bisync.timer";
export const BISYNC_SERVICE = "diaria-gdrive-bisync.service";

const HOUR_MS = 3_600_000;

export interface ArchiveConfig {
  mount: string;
  localRoot: string;
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
  pauseBisync: boolean;
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name}=${raw} não é um número >= 0`);
  return n;
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): ArchiveConfig {
  const mount = env.VIDEO_ARCHIVE_MOUNT ?? DEFAULT_MOUNT;
  const remoteName = env.VIDEO_ARCHIVE_REMOTE ?? "gdrive:";
  return {
    mount,
    localRoot: env.VIDEO_ARCHIVE_LOCAL_ROOT ?? join(mount, "GoogleDrive", VIDEO_FOLDER_REL),
    archiveRoot: env.VIDEO_ARCHIVE_ROOT ?? join(mount, "arquivo-video"),
    remoteRoot: env.VIDEO_ARCHIVE_REMOTE_ROOT ?? `${remoteName}${VIDEO_FOLDER_REL}`,
    remoteName,
    dataRoot: env.VIDEO_ARCHIVE_DATA_ROOT ?? join(ROOT, "data"),
    rclone: env.RCLONE_BIN ?? join(homedir(), ".local", "bin", "rclone"),
    systemctl: env.SYSTEMCTL_BIN ?? "systemctl",
    md5sum: env.MD5SUM_BIN ?? "md5sum",
    mountpointCmd: (env.VIDEO_ARCHIVE_MOUNTPOINT_CMD ?? "mountpoint -q").split(" ").filter(Boolean),
    waitMinutes: positiveNumber(env.VIDEO_ARCHIVE_WAIT_MINUTES, 90, "VIDEO_ARCHIVE_WAIT_MINUTES"),
    pollSeconds: positiveNumber(env.VIDEO_ARCHIVE_POLL_SECONDS, 15, "VIDEO_ARCHIVE_POLL_SECONDS"),
    pauseBisync: env.VIDEO_ARCHIVE_NO_BISYNC_PAUSE !== "1",
  };
}

export type FileStatus =
  | "arquivado"
  | "sairia"
  | "nao-apagado-sem-permissao"
  | "nome-duplicado-no-drive"
  | "em-uso-por-outra-edicao"
  | "falha-conferencia"
  | "falha-download"
  | "falha-mover"
  | "falha-apagar";

/** Exaustivo de propósito: um status novo não compila sem dizer se é falha. */
export const STATUS_IS_FAILURE: Record<FileStatus, boolean> = {
  arquivado: false,
  sairia: false,
  "nao-apagado-sem-permissao": false,
  "nome-duplicado-no-drive": true,
  "em-uso-por-outra-edicao": false,
  "falha-conferencia": true,
  "falha-download": true,
  "falha-mover": true,
  "falha-apagar": true,
};

export interface FileResult {
  folder: string;
  path: string;
  sizeBytes: number;
  status: FileStatus;
  source?: "arquivo" | "espelho" | "download";
  verify?: VerifyVerdict;
  detail?: string;
}

export interface ArchiveReport {
  at: string;
  applied: boolean;
  folders: FolderDecision[];
  files: FileResult[];
  errors: string[];
  warnings: string[];
  driveFreeBefore: number | null;
  driveFreeAfter: number | null;
  archivedBytes: number;
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

function listFolders(cfg: ArchiveConfig): string[] {
  return readdirSync(cfg.localRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function publishedSignals(cfg: ArchiveConfig, name: string, warnings: string[]): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  const haveEditions = existsSync(join(cfg.dataRoot, "editions"));
  for (const e of editionsOfFolder(name) ?? []) {
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
  const r = await run(stop, cfg.rclone, ["lsjson", "-R", "--files-only", "--hash", "--hash-type", "md5", target], { timeoutMs: 600_000 });
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
  const r = await run(stop, cfg.rclone, ["lsjson", "--files-only", `${cfg.remoteRoot}/${folder}${parent}`], { timeoutMs: 300_000 });
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
  const mirrorPath = join(cfg.localRoot, folder, ...remote.path.split("/"));
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

  let source: NonNullable<FileResult["source"]> | null = null;
  let localPath = archivePath;
  if (fileSize(archivePath) === remote.size) {
    const c = await check(archivePath);
    if (c.verify === "ok") source = "arquivo";
    // #12603: cópia de mesmo tamanho com outro conteúdo não trava o bruto; o espelho ou um download a substitui.
    else if (c.verify === "md5-diverge") base = { ...base, detail: "a cópia que estava no arquivo tinha MD5 diferente do Drive" };
    else return failVerify("arquivo", c);
  }
  if (source === null) {
    if (fileSize(mirrorPath) === remote.size) {
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
      renameSync(partial, archivePath);
    }
    // A cópia do arquivo que conferiu já foi checada acima; espelho e download são checados aqui.
    const c = await check(localPath);
    if (c.verify !== "ok") return failVerify(source, c);
  }
  const verify: VerifyVerdict = "ok";

  if (source === "espelho") {
    try {
      mkdirSync(dirname(archivePath), { recursive: true });
      renameSync(mirrorPath, archivePath);
    } catch (e) {
      return { ...base, source, verify, status: "falha-mover", detail: (e as Error).message };
    }
  }

  const del = await run(stop, cfg.rclone, ["deletefile", "--drive-use-trash=false", remotePath], { timeoutMs: 600_000 });
  if (del.ok) return { ...base, source, verify, status: "arquivado" };

  // O `deletefile` falhou. Reler antes de qualquer coisa: o Drive pode ter apagado e só a resposta se perdeu.
  const errText = del.stderr.trim().slice(-500);
  const present = await stillOnDrive(cfg, stop, folder, remote.path);
  if (present === false) {
    return { ...base, source, verify, status: "arquivado", detail: `deletefile saiu com erro, mas o arquivo já não está no Drive: ${errText}` };
  }
  if (present === null) {
    // Sem saber se o Drive ainda tem o arquivo, a cópia conferida fica no arquivo (nunca volta ao espelho).
    return { ...base, source, verify, status: "falha-apagar", detail: `${errText} (não consegui reler o Drive; a cópia conferida ficou no arquivo)` };
  }
  // Continua no Drive: devolve a cópia ao espelho quando veio dele, senão o bisync tentaria apagar no Drive toda rodada.
  let restoreFailed = false;
  let restoreNote = "";
  if (source === "espelho") {
    try {
      renameSync(archivePath, mirrorPath);
      restoreNote = " (cópia devolvida ao espelho)";
    } catch (e) {
      restoreFailed = true;
      restoreNote = ` (NÃO consegui devolver a cópia ao espelho: ${(e as Error).message})`;
    }
  }
  const status: FileStatus = isPermissionError(del.stderr) && !restoreFailed ? "nao-apagado-sem-permissao" : "falha-apagar";
  return { ...base, source, verify, status, detail: errText + restoreNote };
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
    files: [],
    errors: [],
    warnings: [],
    driveFreeBefore: null,
    driveFreeAfter: null,
    archivedBytes: 0,
  };

  const [mpBin, ...mpArgs] = cfg.mountpointCmd;
  if (!(await run(stop, mpBin, [...mpArgs, cfg.mount])).ok) {
    report.errors.push(`${cfg.mount} não está montado — nada feito`);
    return report;
  }
  if (!existsSync(cfg.localRoot)) {
    report.errors.push(`pasta de vídeo ${cfg.localRoot} ausente no espelho — nada feito`);
    return report;
  }

  const publishedMinDays = opts.publishedMinDays ?? DEFAULT_ARCHIVE_PUBLISHED_MIN_DAYS;
  report.folders = listFolders(cfg)
    .filter((n) => !opts.only || opts.only.has(n))
    .map((name) =>
      decideFolder({ name, published: publishedSignals(cfg, name, report.warnings) }, opts.today, opts.unpublishedMaxDays, publishedMinDays),
    );
  const eligible = report.folders.filter((f) => f.eligible).map((f) => f.name);
  const refs = eligible.length > 0 ? inUseMontageRefs(cfg, opts.today, opts.unpublishedMaxDays, publishedMinDays, report.warnings) : { byKey: new Map<string, string[]>(), errors: [] };
  report.errors.push(...refs.errors);
  const dedupWarnings = () => {
    report.warnings = [...new Set(report.warnings)];
  };

  if (!apply) {
    // Dry-run: lista sem pausar nada (só leitura).
    for (const name of eligible) {
      const l = await listRemote(cfg, stop, `${cfg.remoteRoot}/${name}`);
      if ("error" in l) report.errors.push(`${name}: ${l.error}`);
      else
        for (const f of l.files.filter((f) => isBrutoFile(f.path))) {
          report.files.push(inUseResult(name, f, refs) ?? { folder: name, path: f.path, sizeBytes: f.size, status: "sairia" });
        }
    }
    dedupWarnings();
    return report;
  }
  dedupWarnings();
  if (eligible.length === 0) return report;
  // Sem saber que brutos uma montagem em curso usa, nada sai do Drive (#12602).
  if (refs.errors.length > 0) return report;

  const bisync = { timerWasActive: false };
  let resumed = false;
  const resume = async () => {
    if (resumed || !cfg.pauseBisync) return;
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
    if (cfg.pauseBisync) {
      try {
        await pauseBisync(cfg, stop, bisync, log);
      } catch (e) {
        report.errors.push((e as Error).message);
        return report;
      }
    }
    if (interrupted()) return report;
    report.driveFreeBefore = await driveFree(cfg, stop, report.warnings);
    // A listagem vem DEPOIS da pausa: tamanho e MD5 são os do estado que vai ser apagado.
    folders: for (const folder of eligible) {
      if (stop.signal) break;
      const l = await listRemote(cfg, stop, `${cfg.remoteRoot}/${folder}`);
      if ("error" in l) {
        report.errors.push(`${folder}: ${l.error}`);
        continue;
      }
      const dups = duplicatePaths(l.files);
      for (const f of l.files.filter((f) => isBrutoFile(f.path))) {
        // #12603: o sinal para a rodada entre um bruto e outro.
        if (stop.signal) break folders;
        const inUse = inUseResult(folder, f, refs);
        if (inUse) {
          report.files.push(inUse);
          continue;
        }
        if (dups.has(f.path)) {
          report.files.push({ folder, path: f.path, sizeBytes: f.size, status: "nome-duplicado-no-drive", detail: "dois arquivos com o mesmo nome no Drive; apagar por nome não diz qual sai" });
          continue;
        }
        log(`${LOG_PREFIX} ${folder}/${f.path} (${formatBytes(f.size)})…`);
        const res = await archiveOne(cfg, stop, folder, f);
        report.files.push(res);
        if (res.status === "arquivado") report.archivedBytes += res.sizeBytes;
        log(`${LOG_PREFIX}   ${res.status}${res.detail ? `: ${res.detail}` : ""}`);
      }
    }
    if (interrupted()) return report;
    report.driveFreeAfter = await driveFree(cfg, stop, report.warnings);
  } finally {
    await resume();
  }
  return report;
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
  for (const f of report.files) {
    console.log(`  ${f.status.padEnd(26)} ${f.folder}/${f.path}  ${formatBytes(f.sizeBytes)}${f.detail ? `  — ${f.detail}` : ""}`);
  }
  const planned = report.files.reduce((n, f) => n + f.sizeBytes, 0);
  if (report.applied) {
    console.log(`${LOG_PREFIX} arquivado e apagado do Drive: ${formatBytes(report.archivedBytes)}.`);
    const fmt = (v: number | null) => (v === null ? "?" : formatBytes(v));
    console.log(`${LOG_PREFIX} Drive livre: antes ${fmt(report.driveFreeBefore)}, depois ${fmt(report.driveFreeAfter)}.`);
  } else {
    console.log(`${LOG_PREFIX} ${report.files.length} bruto(s), ${formatBytes(planned)} sairiam do Drive.`);
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
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro: ${(e as Error).message}`);
    process.exit(1);
  });
}
