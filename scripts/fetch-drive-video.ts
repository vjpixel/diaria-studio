/**
 * fetch-drive-video.ts (#10659, itens 3-4): acha no Drive o vídeo do dia
 * ("final" no nome) e, para o horizontal, baixa no caminho que o
 * `publish-youtube.ts` já espera.
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
 *   criaria dois caminhos de escrita para o mesmo arquivo.
 *
 * Seleção: `scripts/lib/diaria/drive-video-source.ts` (critério do editor de
 * 25/10/2026). Pasta: `--folder-id` ou `platform.config.json` →
 * `publishing.youtube.drive_folder_id` (`Mentoria Fluxo/VTSD/YouTube`); lista a
 * raiz da pasta e a subpasta `{AAMMDD}/`, nunca as subpastas de outras edições.
 *
 * Idempotente: arquivo local já existe → no-op (sem tocar no Drive), salvo
 * `--force`. Auth: OAuth do projeto (`data/.credentials.json`, scope Drive),
 * o mesmo do `drive-sync.ts`; token inválido → renovar com `oauth-setup.ts`.
 *
 * Saída: JSON no stdout; avisos no stderr. Exit codes:
 *   0 — baixado, já existia, dry-run, id impresso (vertical) ou NENHUM
 *       candidato (fail-soft: o editor sobe depois e roda /diaria-youtube);
 *   1 — falha de rede/OAuth/download;
 *   2 — uso/config inválidos;
 *   3 — precisa do editor: 2+ candidatos da mesma orientação, ou "final" sem
 *       proporção no Drive (nada é escolhido nem baixado).
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { DRIVE_API } from "./lib/drive-constants.ts";
import { escapeDriveQueryString, gFetchRetry } from "./lib/drive-helpers.ts";
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FOLDER_MIME = "application/vnd.google-apps.folder";
const LIST_FIELDS =
  "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size,videoMediaMetadata(width,height,durationMillis))";

export interface FetchDriveVideoDeps {
  /** GET autenticado na Drive API (default: `gFetchRetry`, com refresh do token). */
  driveFetch(url: string): Promise<Response>;
}

export const defaultFetchDriveVideoDeps: FetchDriveVideoDeps = {
  driveFetch: (url) => gFetchRetry(url),
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
}

export interface FetchDriveVideoOutcome {
  exitCode: number;
  output: Record<string, unknown>;
}

/** Lista os filhos diretos (não lixeira) de uma pasta, paginando. */
export async function listDriveChildren(deps: FetchDriveVideoDeps, folderId: string): Promise<DriveVideoFile[]> {
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
    const res = await deps.driveFetch(`${DRIVE_API}/files?${params}`);
    if (!res.ok) throw new Error(`listagem do Drive falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { files?: DriveVideoFile[]; nextPageToken?: string };
    out.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

/** Baixa `alt=media` em `{dest}.part` (streaming) e renomeia no fim. Lança em falha. */
export async function downloadDriveFile(
  deps: FetchDriveVideoDeps,
  file: DriveVideoFile,
  dest: string,
): Promise<number> {
  const res = await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`);
  if (!res.ok) throw new Error(`download do Drive falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("video/")) {
    throw new Error(`o arquivo ${file.id} do Drive não é vídeo (content-type "${type}") — nada gravado`);
  }
  if (!res.body) throw new Error(`download do Drive sem corpo (${file.id}) — nada gravado`);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>), createWriteStream(tmp));
    const bytes = statSync(tmp).size;
    const expected = file.size !== undefined ? Number(file.size) : null;
    if (bytes === 0) throw new Error(`download do Drive veio vazio (${file.id}) — nada gravado`);
    if (expected !== null && Number.isFinite(expected) && expected !== bytes) {
      throw new Error(`download incompleto (${bytes} de ${expected} bytes, ${file.id}) — nada gravado`);
    }
    renameSync(tmp, dest);
    return bytes;
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* o .part fica; o próximo download sobrescreve */
    }
    throw e;
  }
}

function describeFile(f: DriveVideoFile): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    size: f.size !== undefined ? Number(f.size) : null,
    width: f.videoMediaMetadata?.width ?? null,
    height: f.videoMediaMetadata?.height ?? null,
    scope: f.scope ?? "root",
  };
}

function selectionOutput(sel: DriveVideoSelection): Record<string, unknown> {
  switch (sel.kind) {
    case "found":
      return { selection: "found", file: describeFile(sel.file) };
    case "none":
      return { selection: "none", reason: sel.reason };
    case "ambiguous":
      return { selection: "ambiguous", candidates: sel.candidates };
    case "orientation-unknown":
      return { selection: "orientation-unknown", files: sel.files };
  }
}

export async function runFetchDriveVideo(
  deps: FetchDriveVideoDeps,
  input: FetchDriveVideoInput,
  log: (line: string) => void,
): Promise<FetchDriveVideoOutcome> {
  const { aammdd, orientation } = input;
  const localPath = join(
    input.editionDir,
    orientation === "horizontal" ? youtubeVideoFileName(aammdd) : shortVideoFileName(aammdd),
  );
  const base = { edition: aammdd, orientation, folder_id: input.folderId, local_path: localPath };

  if (!input.force && existsSync(localPath) && statSync(localPath).size > 0) {
    log(`[ok] ${localPath} já existe — nada a baixar (use --force para trocar)`);
    return { exitCode: 0, output: { ...base, action: "exists" } };
  }

  let files: DriveVideoFile[];
  let editionFolderId: string | null = null;
  try {
    const root = await listDriveChildren(deps, input.folderId);
    const editionFolder = root.find((f) => f.mimeType === FOLDER_MIME && f.name.trim() === aammdd);
    files = root.filter((f) => f.mimeType !== FOLDER_MIME).map((f) => ({ ...f, scope: "root" as const }));
    if (editionFolder) {
      editionFolderId = editionFolder.id;
      const inside = await listDriveChildren(deps, editionFolder.id);
      files.push(
        ...inside.filter((f) => f.mimeType !== FOLDER_MIME).map((f) => ({ ...f, scope: "edition-folder" as const })),
      );
    } else {
      log(`[premissa] sem subpasta ${aammdd}/ na pasta do Drive — só arquivos soltos na raiz, últimas ${input.windowHours}h`);
    }
  } catch (e) {
    log(`fetch-drive-video: ${(e as Error).message}`);
    log("fetch-drive-video: se for token/credencial, renovar com `npx tsx scripts/oauth-setup.ts`");
    return { exitCode: 1, output: { ...base, action: "error", error: (e as Error).message } };
  }

  const sel = selectDriveVideo(files, { orientation, now: input.now, windowHours: input.windowHours });
  const withSel = { ...base, edition_folder_id: editionFolderId, ...selectionOutput(sel) };

  if (sel.kind === "none") {
    log(`[aviso] ${sel.reason} — nada baixado; quando o vídeo subir, rodar /diaria-youtube ${aammdd}`);
    return { exitCode: 0, output: { ...withSel, action: "none" } };
  }
  if (sel.kind === "ambiguous") {
    log(`[aviso] ${sel.candidates.length} vídeos ${orientation} com "final" no nome — escolha do editor: ${sel.candidates.join(" | ")}`);
    return { exitCode: 3, output: { ...withSel, action: "needs-editor" } };
  }
  if (sel.kind === "orientation-unknown") {
    log(`[aviso] vídeo(s) "final" sem proporção no Drive (ainda processando?): ${sel.files.join(" | ")} — nada escolhido`);
    return { exitCode: 3, output: { ...withSel, action: "needs-editor" } };
  }

  const file = sel.file;
  if (orientation === "vertical") {
    const next = `npx tsx scripts/publish-shorts.ts ${aammdd} --from-drive ${file.id}`;
    log(`[ok] vertical do dia: ${file.name} — próximo passo: ${next}`);
    return { exitCode: 0, output: { ...withSel, action: "print-id", next_command: next } };
  }
  if (input.dryRun) {
    log(`[dry-run] baixaria ${file.name} → ${localPath}`);
    return { exitCode: 0, output: { ...withSel, action: "dry-run" } };
  }
  try {
    const bytes = await downloadDriveFile(deps, file, localPath);
    log(`[ok] ${file.name} (${(bytes / 1e6).toFixed(1)} MB) → ${localPath}`);
    return { exitCode: 0, output: { ...withSel, action: "downloaded", bytes } };
  } catch (e) {
    log(`fetch-drive-video: ${(e as Error).message}`);
    return { exitCode: 1, output: { ...withSel, action: "error", error: (e as Error).message } };
  }
}

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

async function main(): Promise<number> {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  // `--dry-run 261025` engoliria a edição como valor da flag; e flag de valor sem valor vira flag solta.
  const misused = ["dry-run", "force"].filter((f) => values[f] !== undefined);
  const missingValue = ["edition", "orientation", "folder-id", "window-hours", "edition-dir"].filter((f) => flags.has(f));
  if (positional.length || misused.length || missingValue.length) {
    console.error(
      `fetch-drive-video: argumentos inválidos (${[...positional, ...misused.map((f) => `--${f} não leva valor`), ...missingValue.map((f) => `--${f} sem valor`)].join(", ")})\n${USAGE}`,
    );
    return 2;
  }
  const aammdd = values["edition"];
  const orientation = values["orientation"];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error(`fetch-drive-video: --edition AAMMDD ausente ou inválido\n${USAGE}`);
    return 2;
  }
  if (orientation !== "horizontal" && orientation !== "vertical") {
    console.error(`fetch-drive-video: --orientation deve ser horizontal ou vertical\n${USAGE}`);
    return 2;
  }
  let cfg: ReturnType<typeof readYouTubeDriveConfig>;
  try {
    cfg = readYouTubeDriveConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")));
  } catch (e) {
    console.error(`fetch-drive-video: platform.config.json ilegível: ${(e as Error).message}`);
    return 2;
  }
  const folderId = values["folder-id"]?.trim() || cfg.folderId;
  if (!folderId) {
    console.error("fetch-drive-video: sem pasta — passe --folder-id ou preencha publishing.youtube.drive_folder_id");
    return 2;
  }
  const windowRaw = values["window-hours"];
  const windowHours = windowRaw !== undefined ? Number(windowRaw) : (cfg.windowHours ?? DRIVE_VIDEO_WINDOW_HOURS);
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    console.error(`fetch-drive-video: --window-hours inválido (${windowRaw})`);
    return 2;
  }
  const outcome = await runFetchDriveVideo(
    defaultFetchDriveVideoDeps,
    {
      aammdd,
      orientation,
      folderId,
      editionDir: resolve(values["edition-dir"] ?? editionDirFor(aammdd)),
      now: new Date(),
      windowHours,
      dryRun: flags.has("dry-run"),
      force: flags.has("force"),
    },
    (line) => console.error(line),
  );
  console.log(JSON.stringify(outcome.output, null, 2));
  return outcome.exitCode;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("fetch-drive-video:", e instanceof Error ? e.message : e) });
}
