import { shortsVideoTerminal } from "./lib/diaria/published-video-cleanup.ts";
import { loadShortsConfig } from "./lib/diaria/short-video.ts";
/**
 * fetch-drive-video.ts (#10659, itens 3-4): acha no Drive o vídeo do dia
 * (.mp4 com "final" como palavra no nome) e, para o horizontal, baixa no
 * caminho que o `publish-youtube.ts` já espera.
 *
 * Uso:
 *   npx tsx scripts/fetch-drive-video.ts --edition AAMMDD --orientation horizontal|vertical
 *     [--folder-id ID] [--window-hours N] [--edition-dir DIR] [--dry-run] [--force]
 *
 * - horizontal: baixa para `{editionDir}/diaria-comentada-{AAMMDD}.mp4`
 *   (`youtubeVideoFileName`), o default do `publish-youtube.ts`.
 * - vertical: só IMPRIME o file id e o comando pronto
 *   `publish-shorts.ts {AAMMDD} --from-drive {ID}` — o download do vertical
 *   já existe lá e grava `diaria-comentada-{AAMMDD}-short.mp4`; duplicar aqui
 *   criaria dois caminhos de escrita para o mesmo arquivo. Com o short já no
 *   disco, o `next_command` é o plano do `publish-shorts.ts` sobre ele.
 *
 * Seleção: `scripts/lib/diaria/drive-video-source.ts` (critério do editor de
 * 25/10/2026). Pasta: `--folder-id` ou `platform.config.json` →
 * `publishing.youtube.drive_folder_id` (`Mentoria Fluxo/VTSD/YouTube`). A
 * pasta é conferida antes (`GET files/{id}`): inacessível pela conta OAuth do
 * projeto, ou não-pasta, é exit 1, nunca `none`. Lista a raiz e a subpasta
 * `{AAMMDD}/`, nunca as subpastas de outras edições. Subpasta presente → só ela
 * conta; ausente → arquivos soltos na raiz nas últimas `--window-hours` (36).
 *
 * Idempotente, sem tocar no Drive: horizontal com o vídeo já registrado em
 * `_internal/05-youtube-published.json` (`already-published`), ou arquivo
 * local já presente (`exists`). `--force` pula as duas checagens e troca o
 * ARQUIVO local; nunca reenvia o vídeo (isso é do `publish-youtube.ts --force`).
 * Auth: OAuth do projeto (`data/.credentials.json`, scope Drive), o mesmo do
 * `drive-sync.ts`; token inválido → renovar com `oauth-setup.ts`.
 *
 * Timeouts: 30s por página da listagem; download com teto total (20 min) e
 * watchdog de ociosidade (60s sem bytes → aborta). Falha não deixa `.part`.
 *
 * Saída: JSON no stdout (sempre, inclusive em exceção inesperada:
 * `{action:"error"}`); avisos no stderr. Exit codes:
 *   0 — baixado, já existia, já publicado, dry-run, id impresso (vertical) ou
 *       NENHUM candidato (fail-soft: o editor sobe depois e roda /diaria-youtube);
 *   1 — falha de rede/OAuth/pasta inacessível/download;
 *   2 — uso/config inválidos;
 *   3 — precisa do editor (`action: "needs-editor"`, nada escolhido nem
 *       baixado): (a) 2+ ".mp4 final" da mesma orientação (`ambiguous`), ou
 *       um "final" sem proporção no Drive (`orientation-unknown`), com
 *       id/nome/data/escopo de cada arquivo; (b) 2+ subpastas com o nome da
 *       edição (`duplicate-edition-folder`), com os ids.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { DRIVE_API } from "./lib/drive-constants.ts";
import { escapeDriveQueryString, gFetchRetry } from "./lib/drive-helpers.ts";
import { downloadDriveFile } from "./lib/drive-download.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import {
  DRIVE_VIDEO_WINDOW_HOURS,
  selectDriveVideo,
  type DriveVideoFile,
  type DriveVideoSelection,
  type VideoOrientation,
} from "./lib/diaria/drive-video-source.ts";
import { youtubeVideoFileName } from "./lib/diaria/youtube-video.ts";
import { shortVideoFileName } from "./lib/diaria/short-video.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./lib/diaria/youtube-upload.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FOLDER_MIME = "application/vnd.google-apps.folder";
const LIST_FIELDS =
  "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size,videoMediaMetadata(width,height,durationMillis))";

export interface FetchDriveVideoTimeouts {
  /** Cada chamada de metadado/listagem. */
  listMs: number;
  /** Teto do download inteiro. */
  downloadMs: number;
  /** Sem nenhum byte por este tempo → aborta o download. */
  idleMs: number;
}

export const DEFAULT_FETCH_DRIVE_VIDEO_TIMEOUTS: FetchDriveVideoTimeouts = {
  listMs: 30_000,
  downloadMs: 20 * 60_000,
  idleMs: 60_000,
};

export interface FetchDriveVideoDeps {
  /** GET autenticado na Drive API (default: `gFetchRetry`, com refresh do token). */
  driveFetch(url: string, init?: { signal?: AbortSignal }): Promise<Response>;
}

export const defaultFetchDriveVideoDeps: FetchDriveVideoDeps = {
  driveFetch: (url, init) => gFetchRetry(url, init ?? {}),
};

export interface FetchDriveVideoInput {
  aammdd: string;
  orientation: VideoOrientation;
  folderId: string;
  editionDir: string;
  now: Date;
  windowHours: number;
  dryRun: boolean;
  force: boolean;
  timeouts?: FetchDriveVideoTimeouts;
}

// ── Saída (união discriminada por `action`) ────────────────────────────────

export interface DescribedDriveFile {
  id: string;
  name: string;
  size: number | null;
  width: number | null;
  height: number | null;
  createdTime: string | null;
  modifiedTime: string | null;
  scope: "edition-folder" | "root";
}

export interface DescribedDriveFolder {
  id: string;
  name: string;
  modifiedTime: string | null;
}

interface OutputBase {
  edition: string;
  orientation: VideoOrientation;
  folder_id: string;
  local_path: string;
}

interface OutputWithFolder extends OutputBase {
  edition_folder_id: string | null;
}

export type FetchDriveVideoOutput =
  | (OutputBase & { action: "exists"; next_command?: string })
  | (OutputBase & { action: "already-published"; record_path: string; video_url: string | null })
  | (OutputBase & { action: "error"; phase: "folder" | "list"; error: string })
  | (OutputBase & { action: "needs-editor"; selection: "duplicate-edition-folder"; folders: DescribedDriveFolder[] })
  | (OutputWithFolder & { action: "none"; selection: "none"; reason: string })
  | (OutputWithFolder & { action: "needs-editor"; selection: "ambiguous"; candidates: DescribedDriveFile[] })
  | (OutputWithFolder & { action: "needs-editor"; selection: "orientation-unknown"; files: DescribedDriveFile[] })
  | (OutputWithFolder & { action: "print-id"; selection: "found"; file: DescribedDriveFile; next_command: string })
  | (OutputWithFolder & { action: "dry-run"; selection: "found"; file: DescribedDriveFile })
  | (OutputWithFolder & { action: "downloaded"; selection: "found"; file: DescribedDriveFile; bytes: number })
  | (OutputWithFolder & { action: "error"; phase: "download"; selection: "found"; file: DescribedDriveFile; error: string });

/** Exceção que nem o `runFetchDriveVideo` previu: o `main` ainda imprime JSON. */
export interface FetchDriveVideoUnexpectedError {
  action: "error";
  phase: "unexpected";
  error: string;
}

export interface FetchDriveVideoOutcome {
  exitCode: number;
  output: FetchDriveVideoOutput;
}

// ── Drive ─────────────────────────────────────────────────────────────────

export class DriveFolderInaccessibleError extends Error {}

/**
 * Confere que `folderId` é uma pasta visível pela conta OAuth do projeto.
 * 403/404 ou não-pasta → `DriveFolderInaccessibleError` (o chamador sai exit
 * 1). Sem isso, uma pasta sem permissão listaria vazio e viraria `none`.
 */
export async function assertDriveFolderAccessible(
  deps: FetchDriveVideoDeps,
  folderId: string,
  timeoutMs: number,
): Promise<void> {
  const params = new URLSearchParams({ fields: "id,mimeType", supportsAllDrives: "true" });
  const res = await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(folderId)}?${params}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const inaccessible = `pasta ${folderId} inacessível pela conta OAuth do projeto (data/.credentials.json)`;
  if (res.status === 403 || res.status === 404) {
    throw new DriveFolderInaccessibleError(`${inaccessible}: HTTP ${res.status} — compartilhe a pasta com essa conta ou corrija o id`);
  }
  if (!res.ok) throw new Error(`metadado da pasta do Drive falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const meta = (await res.json()) as { mimeType?: string };
  if (meta.mimeType !== FOLDER_MIME) {
    throw new DriveFolderInaccessibleError(`${inaccessible}: o id não é de uma pasta (mimeType ${JSON.stringify(meta.mimeType ?? null)})`);
  }
}

/** Lista os filhos diretos (não lixeira) de uma pasta, paginando. */
export async function listDriveChildren(
  deps: FetchDriveVideoDeps,
  folderId: string,
  timeoutMs: number = DEFAULT_FETCH_DRIVE_VIDEO_TIMEOUTS.listMs,
): Promise<DriveVideoFile[]> {
  const out: DriveVideoFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${escapeDriveQueryString(folderId)}' in parents and trashed = false`,
      fields: LIST_FIELDS,
      pageSize: "100",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await deps.driveFetch(`${DRIVE_API}/files?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`listagem do Drive falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { files?: DriveVideoFile[]; nextPageToken?: string };
    out.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Download protegido (`.part`, teto total, watchdog de ociosidade, tamanho,
 * content-type) — mora em `lib/drive-download.ts` desde o #11082, compartilhado
 * com o `publish-shorts.ts --from-drive`. Re-exportado aqui pelos chamadores
 * e testes que já o importavam deste módulo.
 */
export { downloadDriveFile };

function describeFile(f: DriveVideoFile): DescribedDriveFile {
  return {
    id: f.id,
    name: f.name,
    size: f.size !== undefined ? Number(f.size) : null,
    width: f.videoMediaMetadata?.width ?? null,
    height: f.videoMediaMetadata?.height ?? null,
    createdTime: f.createdTime ?? null,
    modifiedTime: f.modifiedTime ?? null,
    scope: f.scope ?? "root",
  };
}

function describeForLog(f: DriveVideoFile): string {
  return `${f.name} [id ${f.id}, ${f.scope ?? "root"}, modificado ${f.modifiedTime ?? "?"}]`;
}

/** Lê o registro do upload; `done` só com `videoId` desta edição (mesmo critério do `publish-youtube.ts`). */
function readUploadRecord(path: string, aammdd: string): { done: true; url: string | null } | { done: false } {
  if (!existsSync(path)) return { done: false };
  try {
    const rec = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    if (rec && typeof rec === "object" && rec.aammdd === aammdd && typeof rec.videoId === "string" && rec.videoId) {
      return { done: true, url: typeof rec.url === "string" ? rec.url : null };
    }
  } catch {
    // Ilegível: segue o fluxo; o publish-youtube.ts recusa e explica.
  }
  return { done: false };
}

export async function runFetchDriveVideo(
  deps: FetchDriveVideoDeps,
  input: FetchDriveVideoInput,
  log: (line: string) => void,
): Promise<FetchDriveVideoOutcome> {
  const { aammdd, orientation } = input;
  const timeouts = input.timeouts ?? DEFAULT_FETCH_DRIVE_VIDEO_TIMEOUTS;
  const localPath = join(
    input.editionDir,
    orientation === "horizontal" ? youtubeVideoFileName(aammdd) : shortVideoFileName(aammdd),
  );
  const base: OutputBase = { edition: aammdd, orientation, folder_id: input.folderId, local_path: localPath };

  if (orientation === "vertical" && !input.force && shortsVideoTerminal(input.editionDir, aammdd,
    loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))))) {
    log("[ok] destinos do vertical já concluídos — nada a baixar");
    return { exitCode: 0, output: { ...base, action: "already-published", record_path: join(input.editionDir, "_internal", "06-shorts-published.json"), video_url: null } };
  }

  if (orientation === "horizontal" && !input.force) {
    const recordPath = join(input.editionDir, YOUTUBE_PUBLISHED_FILE);
    const rec = readUploadRecord(recordPath, aammdd);
    if (rec.done) {
      log(`[ok] vídeo da edição já enviado ao YouTube (${rec.url ?? "sem url"}, ${recordPath}) — nada a baixar`);
      return { exitCode: 0, output: { ...base, action: "already-published", record_path: recordPath, video_url: rec.url } };
    }
  }

  if (!input.force && existsSync(localPath) && statSync(localPath).size > 0) {
    log(`[ok] ${localPath} já existe — nada a baixar (use --force para trocar)`);
    if (orientation === "vertical") {
      const next = `npx tsx scripts/publish-shorts.ts ${aammdd}`;
      return { exitCode: 0, output: { ...base, action: "exists", next_command: next } };
    }
    return { exitCode: 0, output: { ...base, action: "exists" } };
  }

  const failed = (phase: "folder" | "list", e: unknown): FetchDriveVideoOutcome => {
    const message = (e as Error).message;
    log(`fetch-drive-video: ${message}`);
    if (!(e instanceof DriveFolderInaccessibleError)) {
      log("fetch-drive-video: se for token/credencial, renovar com `npx tsx scripts/oauth-setup.ts`");
    }
    return { exitCode: 1, output: { ...base, action: "error", phase, error: message } };
  };

  try {
    await assertDriveFolderAccessible(deps, input.folderId, timeouts.listMs);
  } catch (e) {
    return failed("folder", e);
  }

  let files: DriveVideoFile[];
  let editionFolderId: string | null = null;
  try {
    const root = await listDriveChildren(deps, input.folderId, timeouts.listMs);
    const editionFolders = root.filter((f) => f.mimeType === FOLDER_MIME && f.name.trim() === aammdd);
    if (editionFolders.length > 1) {
      const folders = editionFolders.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime ?? null }));
      log(`[aviso] ${folders.length} subpastas "${aammdd}" na pasta do Drive (${folders.map((f) => f.id).join(", ")}) — junte ou renomeie; nada escolhido`);
      return { exitCode: 3, output: { ...base, action: "needs-editor", selection: "duplicate-edition-folder", folders } };
    }
    files = root.filter((f) => f.mimeType !== FOLDER_MIME).map((f) => ({ ...f, scope: "root" as const }));
    if (editionFolders.length === 1) {
      editionFolderId = editionFolders[0].id;
      const inside = await listDriveChildren(deps, editionFolderId, timeouts.listMs);
      files.push(
        ...inside.filter((f) => f.mimeType !== FOLDER_MIME).map((f) => ({ ...f, scope: "edition-folder" as const })),
      );
    } else {
      log(`[premissa] sem subpasta ${aammdd}/ na pasta do Drive — só arquivos soltos na raiz, últimas ${input.windowHours}h`);
    }
  } catch (e) {
    return failed("list", e);
  }

  const sel: DriveVideoSelection = selectDriveVideo(files, {
    orientation,
    now: input.now,
    windowHours: input.windowHours,
    editionFolderPresent: editionFolderId !== null,
  });
  const withFolder: OutputWithFolder = { ...base, edition_folder_id: editionFolderId };

  if (sel.kind === "none") {
    log(`[aviso] ${sel.reason} — nada baixado; quando o vídeo subir, rodar /diaria-youtube ${aammdd}`);
    return { exitCode: 0, output: { ...withFolder, action: "none", selection: "none", reason: sel.reason } };
  }
  if (sel.kind === "ambiguous") {
    log(`[aviso] ${sel.candidates.length} .mp4 ${orientation} com "final" no nome — escolha do editor: ${sel.candidates.map(describeForLog).join(" | ")}`);
    return {
      exitCode: 3,
      output: { ...withFolder, action: "needs-editor", selection: "ambiguous", candidates: sel.candidates.map(describeFile) },
    };
  }
  if (sel.kind === "orientation-unknown") {
    log(`[aviso] .mp4 "final" sem proporção no Drive (ainda processando?): ${sel.files.map(describeForLog).join(" | ")} — nada escolhido`);
    return {
      exitCode: 3,
      output: { ...withFolder, action: "needs-editor", selection: "orientation-unknown", files: sel.files.map(describeFile) },
    };
  }

  const file = sel.file;
  const described = describeFile(file);
  if (orientation === "vertical") {
    const next = `npx tsx scripts/publish-shorts.ts ${aammdd} --from-drive ${file.id}`;
    log(`[ok] vertical do dia: ${file.name} — próximo passo: ${next}`);
    return { exitCode: 0, output: { ...withFolder, action: "print-id", selection: "found", file: described, next_command: next } };
  }
  if (input.dryRun) {
    log(`[dry-run] baixaria ${file.name} → ${localPath}`);
    return { exitCode: 0, output: { ...withFolder, action: "dry-run", selection: "found", file: described } };
  }
  try {
    const bytes = await downloadDriveFile(deps, file, localPath, timeouts, log);
    log(`[ok] ${file.name} (${(bytes / 1e6).toFixed(1)} MB) → ${localPath}`);
    return { exitCode: 0, output: { ...withFolder, action: "downloaded", selection: "found", file: described, bytes } };
  } catch (e) {
    const message = (e as Error).message;
    log(`fetch-drive-video: ${message}`);
    return {
      exitCode: 1,
      output: { ...withFolder, action: "error", phase: "download", selection: "found", file: described, error: message },
    };
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

const USAGE =
  "uso: fetch-drive-video.ts --edition AAMMDD --orientation horizontal|vertical [--folder-id ID] [--window-hours N] [--edition-dir DIR] [--dry-run] [--force]";

export function readYouTubeDriveConfig(config: unknown): { folderId: string | null; windowHours: number | null } {
  const yt = (config as { publishing?: { youtube?: { drive_folder_id?: unknown; drive_window_hours?: unknown } } })
    ?.publishing?.youtube;
  const folderId = typeof yt?.drive_folder_id === "string" && yt.drive_folder_id.trim() ? yt.drive_folder_id.trim() : null;
  const windowHours =
    typeof yt?.drive_window_hours === "number" && yt.drive_window_hours > 0 ? yt.drive_window_hours : null;
  return { folderId, windowHours };
}

export type ParsedFetchDriveVideoArgs =
  | {
      ok: true;
      aammdd: string;
      orientation: VideoOrientation;
      folderId: string;
      windowHours: number;
      editionDir: string | null;
      dryRun: boolean;
      force: boolean;
    }
  | { ok: false; error: string };

/** Parse puro do argv (nenhuma rede, nenhum disco): erro = exit 2. */
export function parseFetchDriveVideoArgs(
  argv: string[],
  cfg: ReturnType<typeof readYouTubeDriveConfig>,
): ParsedFetchDriveVideoArgs {
  const { flags, values, positional } = parseArgs(argv);
  // `--dry-run 261025` engoliria a edição como valor da flag; e flag de valor sem valor vira flag solta.
  const misused = ["dry-run", "force"].filter((f) => values[f] !== undefined);
  const missingValue = ["edition", "orientation", "folder-id", "window-hours", "edition-dir"].filter((f) => flags.has(f));
  if (positional.length || misused.length || missingValue.length) {
    const what = [...positional, ...misused.map((f) => `--${f} não leva valor`), ...missingValue.map((f) => `--${f} sem valor`)];
    return { ok: false, error: `argumentos inválidos (${what.join(", ")})` };
  }
  const aammdd = values["edition"];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) return { ok: false, error: "--edition AAMMDD ausente ou inválido" };
  const orientation = values["orientation"];
  if (orientation !== "horizontal" && orientation !== "vertical") {
    return { ok: false, error: "--orientation deve ser horizontal ou vertical" };
  }
  const folderId = values["folder-id"]?.trim() || cfg.folderId;
  if (!folderId) return { ok: false, error: "sem pasta — passe --folder-id ou preencha publishing.youtube.drive_folder_id" };
  const windowRaw = values["window-hours"];
  const windowHours = windowRaw !== undefined ? Number(windowRaw) : (cfg.windowHours ?? DRIVE_VIDEO_WINDOW_HOURS);
  if (!Number.isFinite(windowHours) || windowHours <= 0) return { ok: false, error: `--window-hours inválido (${windowRaw})` };
  return {
    ok: true,
    aammdd,
    orientation,
    folderId,
    windowHours,
    editionDir: values["edition-dir"] ?? null,
    dryRun: flags.has("dry-run"),
    force: flags.has("force"),
  };
}

async function main(): Promise<number> {
  try {
    let cfg: ReturnType<typeof readYouTubeDriveConfig>;
    try {
      cfg = readYouTubeDriveConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")));
    } catch (e) {
      console.error(`fetch-drive-video: platform.config.json ilegível: ${(e as Error).message}`);
      return 2;
    }
    const args = parseFetchDriveVideoArgs(process.argv.slice(2), cfg);
    if (!args.ok) {
      console.error(`fetch-drive-video: ${args.error}\n${USAGE}`);
      return 2;
    }
    const outcome = await runFetchDriveVideo(
      defaultFetchDriveVideoDeps,
      {
        aammdd: args.aammdd,
        orientation: args.orientation,
        folderId: args.folderId,
        editionDir: resolve(args.editionDir ?? editionDirFor(args.aammdd)),
        now: new Date(),
        windowHours: args.windowHours,
        dryRun: args.dryRun,
        force: args.force,
      },
      (line) => console.error(line),
    );
    console.log(JSON.stringify(outcome.output, null, 2));
    return outcome.exitCode;
  } catch (e) {
    const unexpected: FetchDriveVideoUnexpectedError = {
      action: "error",
      phase: "unexpected",
      error: e instanceof Error ? e.message : String(e),
    };
    console.error(`fetch-drive-video: erro inesperado: ${unexpected.error}`);
    console.log(JSON.stringify(unexpected, null, 2));
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("fetch-drive-video:", e instanceof Error ? e.message : e) });
}
