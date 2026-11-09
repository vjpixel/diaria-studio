#!/usr/bin/env node
/**
 * scripts/archive-video-brutos.ts (#12548, resolve #12472)
 *
 * Guarda os brutos do vídeo da diária no HD do `300` e os apaga do Google
 * Drive. **Dry-run é o DEFAULT**: sem `--apply` só lista o que sairia, com
 * tamanho e motivo, sem tocar nada. Política pura (quais pastas, quais
 * arquivos, a conferência) em `scripts/lib/diaria/video-bruto-archive.ts`.
 *
 * Para cada pasta de edição elegível da pasta de vídeo, e cada bruto que o
 * DRIVE lista nela (o Drive é a fonte; a listagem traz o MD5):
 *   1. acha a cópia local: a do arquivo (`{archive}/{pasta}/{arquivo}`, rodada
 *      anterior interrompida), senão a do espelho do bisync
 *      (`/mnt/hd-sata/GoogleDrive/...`), senão baixa do Drive direto para o
 *      arquivo (`rclone copyto`);
 *   2. confere tamanho e MD5 da cópia local contra o Drive. Divergência ou
 *      Drive sem MD5 = não apaga, reporta, exit 1;
 *   3. move a cópia do espelho para o arquivo (`rename`, mesmo disco);
 *   4. apaga do Drive de vez (`rclone deletefile --drive-use-trash=false`):
 *      arquivo na lixeira continua contando na cota por 30 dias. Se o Drive
 *      recusar (arquivo de outro dono, `canDelete=false`), a cópia volta para
 *      o espelho — senão o bisync veria "apagado no local" e tentaria apagar
 *      no Drive toda rodada — e o arquivo sai no relatório como não apagado
 *      (não é falha da rodada).
 *
 * Coordenação com o bisync do Drive inteiro (#12356): com `--apply`, para o
 * `diaria-gdrive-bisync.timer`, espera a rodada em curso terminar
 * (`systemctl --user is-active`, nunca `pgrep`) e religa o timer no fim, em
 * qualquer caso. Removido dos dois lados, o bisync não tem o que propagar.
 *
 * Relatório: stdout (texto ou `--json`) e `~/.cache/diaria/video-bruto-archive/last-report.json`,
 * com o espaço livre do Drive antes e depois (`rclone about`). Falha = exit 1,
 * a unit fica `failed` e o alarme de units falhas acusa.
 *
 * Task agendada: `Diaria-Video-Bruto-Archive` (sábado 03:00 BRT, `--apply`).
 *
 * Uso:
 *   npx tsx scripts/archive-video-brutos.ts                    # dry-run
 *   npx tsx scripts/archive-video-brutos.ts --apply            # arquiva e apaga do Drive
 *   npx tsx scripts/archive-video-brutos.ts --apply --only 261027,261028
 *   npx tsx scripts/archive-video-brutos.ts --json
 *
 * Testável sem tocar produção: VIDEO_ARCHIVE_* e RCLONE_BIN/SYSTEMCTL_BIN/
 * MD5SUM_BIN/VIDEO_ARCHIVE_MOUNTPOINT_CMD sobrescrevíveis por env.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { formatBytes } from "./lib/onedrive-quota.ts";
import { parseRcloneAboutJson } from "./lib/gdrive-quota.ts";
import { editionDirUnder, editionVideoPublished, todayBrt } from "./prune-video-montage-cache.ts";
import {
  DEFAULT_ARCHIVE_UNPUBLISHED_MAX_DAYS,
  decideFolder,
  editionsOfFolder,
  isBrutoFile,
  parseMd5sumLine,
  parseRcloneLsjson,
  verifyCopy,
  type FolderDecision,
  type VerifyVerdict,
} from "./lib/diaria/video-bruto-archive.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[archive-video-brutos]";

/** Pasta de vídeo da diária, relativa à raiz do Drive. O `／` (largo) é como o rclone grava a `/` do nome "Mentoria Fluxo/VTSD". */
export const VIDEO_FOLDER_REL = "Work/Mentoria Fluxo／VTSD/YouTube";
export const DEFAULT_MOUNT = "/mnt/hd-sata";
export const BISYNC_TIMER = "diaria-gdrive-bisync.timer";
export const BISYNC_SERVICE = "diaria-gdrive-bisync.service";

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
    waitMinutes: Number(env.VIDEO_ARCHIVE_WAIT_MINUTES ?? 90),
    pollSeconds: Number(env.VIDEO_ARCHIVE_POLL_SECONDS ?? 15),
    pauseBisync: env.VIDEO_ARCHIVE_NO_BISYNC_PAUSE !== "1",
  };
}

export type FileStatus =
  | "arquivado"
  | "sairia"
  | "nao-apagado-sem-permissao"
  | "falha-conferencia"
  | "falha-download"
  | "falha-mover"
  | "falha-apagar";

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
  driveFreeBefore: number | null;
  driveFreeAfter: number | null;
  archivedBytes: number;
}

function run(bin: string, args: string[], opts: { timeoutMs?: number } = {}): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error.message) : ""), code: r.status };
}

function driveFree(cfg: ArchiveConfig): number | null {
  const r = run(cfg.rclone, ["about", cfg.remoteName, "--json"], { timeoutMs: 120_000 });
  if (!r.ok) return null;
  return parseRcloneAboutJson(r.stdout)?.free ?? null;
}

function md5Of(cfg: ArchiveConfig, path: string): string | null {
  const r = run(cfg.md5sum, [path]);
  return r.ok ? parseMd5sumLine(r.stdout) : null;
}

/** Erro do Drive que significa "esta conta não pode apagar" (arquivo de outro dono). */
export function isPermissionError(stderr: string): boolean {
  return /insufficientFilePermissions|insufficient permissions|canDelete|forbidden|Error 403/i.test(stderr);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Para o timer do bisync e espera a rodada em curso terminar. Lança se não terminar no prazo. */
export function pauseBisync(cfg: ArchiveConfig, log: (l: string) => void): void {
  const stop = run(cfg.systemctl, ["--user", "stop", BISYNC_TIMER]);
  if (!stop.ok) throw new Error(`não consegui parar ${BISYNC_TIMER}: ${stop.stderr.trim()}`);
  log(`${LOG_PREFIX} ${BISYNC_TIMER} parado; esperando a rodada em curso do bisync terminar.`);
  const deadline = Date.now() + cfg.waitMinutes * 60_000;
  for (;;) {
    const st = run(cfg.systemctl, ["--user", "is-active", BISYNC_SERVICE]).stdout.trim();
    if (st !== "active" && st !== "activating" && st !== "deactivating" && st !== "reloading") return;
    if (Date.now() > deadline) throw new Error(`${BISYNC_SERVICE} seguia ${st} depois de ${cfg.waitMinutes} min`);
    sleep(cfg.pollSeconds * 1000);
  }
}

export function resumeBisync(cfg: ArchiveConfig, log: (l: string) => void): string | null {
  const r = run(cfg.systemctl, ["--user", "start", BISYNC_TIMER]);
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

function publishedSignals(cfg: ArchiveConfig, name: string): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  const haveEditions = existsSync(join(cfg.dataRoot, "editions"));
  for (const e of editionsOfFolder(name) ?? []) {
    out[e] = haveEditions ? editionVideoPublished(editionDirUnder(cfg.dataRoot, e), e).value : null;
  }
  return out;
}

function fileSize(p: string): number | null {
  try {
    const st = statSync(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Processa um bruto (com `--apply`). Nunca lança: o erro vira status. */
function archiveOne(cfg: ArchiveConfig, folder: string, remote: { path: string; size: number; md5: string | null }): FileResult {
  const base: FileResult = { folder, path: remote.path, sizeBytes: remote.size, status: "sairia" };
  const archivePath = join(cfg.archiveRoot, folder, ...remote.path.split("/"));
  const mirrorPath = join(cfg.localRoot, folder, ...remote.path.split("/"));
  const remotePath = `${cfg.remoteRoot}/${folder}/${remote.path}`;

  let source: FileResult["source"];
  let localPath: string;
  if (fileSize(archivePath) !== null) {
    source = "arquivo";
    localPath = archivePath;
  } else if (fileSize(mirrorPath) === remote.size) {
    source = "espelho";
    localPath = mirrorPath;
  } else {
    source = "download";
    localPath = archivePath;
    mkdirSync(dirname(archivePath), { recursive: true });
    const dl = run(cfg.rclone, ["copyto", remotePath, archivePath]);
    if (!dl.ok) return { ...base, source, status: "falha-download", detail: dl.stderr.trim().slice(-500) };
  }

  const verify = verifyCopy(remote, { size: fileSize(localPath) ?? -1, md5: md5Of(cfg, localPath) });
  if (verify !== "ok") return { ...base, source, verify, status: "falha-conferencia" };

  if (source === "espelho") {
    try {
      mkdirSync(dirname(archivePath), { recursive: true });
      renameSync(mirrorPath, archivePath);
    } catch (e) {
      return { ...base, source, verify, status: "falha-mover", detail: (e as Error).message };
    }
  }

  const del = run(cfg.rclone, ["deletefile", "--drive-use-trash=false", remotePath]);
  if (del.ok) return { ...base, source, verify, status: "arquivado" };
  // O Drive recusou: devolve a cópia ao espelho (senão o bisync tentaria apagar no Drive a cada rodada).
  let restoreNote = "";
  if (source === "espelho") {
    try {
      renameSync(archivePath, mirrorPath);
      restoreNote = " (cópia devolvida ao espelho)";
    } catch (e) {
      restoreNote = ` (NÃO consegui devolver a cópia ao espelho: ${(e as Error).message})`;
    }
  }
  const detail = del.stderr.trim().slice(-500) + restoreNote;
  if (isPermissionError(del.stderr) && !restoreNote.includes("NÃO")) {
    return { ...base, source, verify, status: "nao-apagado-sem-permissao", detail };
  }
  return { ...base, source, verify, status: "falha-apagar", detail };
}

export function runArchive(opts: {
  cfg: ArchiveConfig;
  apply: boolean;
  today: Date;
  unpublishedMaxDays: number;
  only?: Set<string>;
  log?: (l: string) => void;
}): ArchiveReport {
  const { cfg, apply } = opts;
  const log = opts.log ?? (() => {});
  const report: ArchiveReport = {
    at: new Date().toISOString(),
    applied: apply,
    folders: [],
    files: [],
    errors: [],
    driveFreeBefore: null,
    driveFreeAfter: null,
    archivedBytes: 0,
  };

  const [mpBin, ...mpArgs] = cfg.mountpointCmd;
  if (!run(mpBin, [...mpArgs, cfg.mount]).ok) {
    report.errors.push(`${cfg.mount} não está montado — nada feito`);
    return report;
  }
  if (!existsSync(cfg.localRoot)) {
    report.errors.push(`pasta de vídeo ${cfg.localRoot} ausente no espelho — nada feito`);
    return report;
  }

  report.folders = listFolders(cfg)
    .filter((n) => !opts.only || opts.only.has(n))
    .map((name) => decideFolder({ name, published: publishedSignals(cfg, name) }, opts.today, opts.unpublishedMaxDays));
  const eligible = report.folders.filter((f) => f.eligible).map((f) => f.name);

  // Listagem do Drive (com MD5) de cada pasta elegível.
  const listings = new Map<string, Array<{ path: string; size: number; md5: string | null }>>();
  for (const name of eligible) {
    const r = run(cfg.rclone, ["lsjson", "-R", "--files-only", "--hash", "--hash-type", "md5", `${cfg.remoteRoot}/${name}`], {
      timeoutMs: 600_000,
    });
    if (!r.ok) {
      report.errors.push(`${name}: rclone lsjson falhou: ${r.stderr.trim().slice(-300)}`);
      continue;
    }
    try {
      listings.set(name, parseRcloneLsjson(r.stdout).filter((f) => isBrutoFile(f.path)));
    } catch (e) {
      report.errors.push(`${name}: listagem do Drive ilegível: ${(e as Error).message}`);
    }
  }

  const todo = [...listings.values()].reduce((n, l) => n + l.length, 0);
  if (!apply || todo === 0) {
    for (const [folder, files] of listings) {
      for (const f of files) report.files.push({ folder, path: f.path, sizeBytes: f.size, status: "sairia" });
    }
    return report;
  }

  report.driveFreeBefore = driveFree(cfg);
  if (cfg.pauseBisync) {
    try {
      pauseBisync(cfg, log);
    } catch (e) {
      report.errors.push((e as Error).message);
      const err = resumeBisync(cfg, log);
      if (err) report.errors.push(err);
      return report;
    }
  }
  try {
    for (const [folder, files] of listings) {
      for (const f of files) {
        log(`${LOG_PREFIX} ${folder}/${f.path} (${formatBytes(f.size)})…`);
        const res = archiveOne(cfg, folder, f);
        report.files.push(res);
        if (res.status === "arquivado") report.archivedBytes += res.sizeBytes;
        log(`${LOG_PREFIX}   ${res.status}${res.detail ? `: ${res.detail}` : ""}`);
      }
    }
  } finally {
    if (cfg.pauseBisync) {
      const err = resumeBisync(cfg, log);
      if (err) report.errors.push(err);
    }
  }
  report.driveFreeAfter = driveFree(cfg);
  return report;
}

const FAILURE_STATUSES: FileStatus[] = ["falha-conferencia", "falha-download", "falha-mover", "falha-apagar"];

export function reportFailed(report: ArchiveReport): boolean {
  return report.errors.length > 0 || report.files.some((f) => FAILURE_STATUSES.includes(f.status));
}

const FOLDER_REASON: Record<FolderDecision["reason"], string> = {
  publicado: "vídeo publicado",
  "teto-sem-publicacao": "sem registro de publicação, passou do teto",
  "nome-fora-do-padrao": "nome fora de AAMMDD",
  "aguardando-publicacao": "vídeo ainda não publicado",
  "publicacao-desconhecida": "publicação desconhecida (sem a pasta da edição em data/editions)",
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
  for (const e of report.errors) console.error(`${LOG_PREFIX} erro: ${e}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "apply");
  const unpublishedMaxDays = getIntArg(argv, "unpublished-max-days", { min: 0 }) ?? DEFAULT_ARCHIVE_UNPUBLISHED_MAX_DAYS;
  const onlyRaw = getStringArg(argv, "only", { example: "261027,261028" });
  const only = onlyRaw ? new Set(onlyRaw.split(",").map((s) => s.trim()).filter(Boolean)) : undefined;
  const cfg = defaultConfig();
  const report = runArchive({
    cfg,
    apply,
    today: todayBrt(),
    unpublishedMaxDays,
    only,
    log: (l) => console.error(l),
  });
  if (apply) {
    try {
      const dir = join(homedir(), ".cache", "diaria", "video-bruto-archive");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "last-report.json"), JSON.stringify(report, null, 2) + "\n");
    } catch (e) {
      console.error(`${LOG_PREFIX} aviso: não consegui gravar o relatório: ${(e as Error).message}`);
    }
  }
  if (hasFlag(argv, "json")) console.log(JSON.stringify(report, null, 2));
  else printText(report);
  if (reportFailed(report)) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`${LOG_PREFIX} erro: ${(e as Error).message}`);
    process.exit(1);
  }
}
