import { shortsVideoTerminal } from "./lib/diaria/published-video-cleanup.ts";
import { loadShortsConfig } from "./lib/diaria/short-video.ts";
/**
 * fetch-drive-video.ts (#10659, itens 3-4): acha no Drive o vídeo do dia
 * (.mp4 com "final" como palavra no nome) e, para o horizontal, baixa no
 * caminho que o `publish-youtube.ts` já espera.
 *
 * Uso:
 *   npx tsx scripts/fetch-drive-video.ts --edition AAMMDD --orientation horizontal|vertical
 *     [--target youtube|outras-redes|instagram]
 *     [--folder-id ID] [--window-hours N] [--edition-dir DIR]
 *     [--download [--max-mb N]] [--promote] [--dry-run] [--force]
 *
 * **Sem `--download`, só planeja (#11551).** Na 261029 uma checagem por ssh no
 * 300 baixou 312 MB sem pedir. Agora o default lista, resolve o arquivo e
 * imprime o plano (`action: "dry-run"`, com nome, id, tamanho e destino), sem
 * gravar nada; `--dry-run` continua aceito e é o mesmo que omitir `--download`.
 * Com `--download` o log diz tamanho e destino antes de baixar, e acima de
 * `--max-mb` (default `publishing.youtube.drive_max_download_mb` ou 2048) sai
 * exit 1 `phase: "size-limit"` sem baixar; `--force` passa do teto.
 *
 * **Versão mais alta em `Editados/` e promoção para `Final/` (#11556).** Com
 * `_Youtube_V1`…`_V5` em `Editados/` (sem `Final/`), vale o maior `V{n}` e a
 * escolha sai como `[premissa]` (`premise` no JSON). Com `--promote` (ou
 * `--download`), o escolhido é copiado para `Final/` (criada se faltar) pela
 * Drive API, para o timer do 300 ler o mesmo arquivo; a cópia leva
 * `appProperties.diaria_promoted_from` e sai em `promoted`. Sem a flag, nada é
 * escrito no Drive.
 *
 * Pasta `Final/` (#11222): dentro de `{AAMMDD}/`, a subpasta `Final/` é listada
 * e os `.mp4` dela contam como finais pelo LUGAR (o nome não leva "final":
 * `Diaria comentada_Youtube_V3.mp4`, `_Instagram_V3`, `_Outras redes_V3`). O
 * destino escolhe o arquivo: horizontal = `_Youtube_`; vertical =
 * `_Outras redes_` (default) ou `_Instagram_` com `--target instagram`. Regra
 * completa em `scripts/lib/diaria/drive-video-source.ts`. Sem `.mp4` em
 * `Final/` (ou "Finais"/"Versão final"), a subpasta `Editado/` (e variações)
 * é listada com a mesma regra (#11385: a 261028 veio em
 * `Editado/Diaria comentada_Youtube_FINAL.mp4`).
 *
 * #11542: procura também imagens Still JPG/JPEG/PNG em Final/ e Editado(s)/
 * da edição. Sequência YouTube = horizontal; sequência vertical = todos os
 * verticais. 2+ capas por orientação dão needs-editor; nunca desempata por data.
 * O plano inclui `cover`; sem dry-run baixa JPEG real no caminho do publisher.
 * #11636: capa local não vazia é preservada; --force autoriza substituição logada.
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

import sharp from "sharp";
import { existsSync, mkdirSync, readFileSync, statSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  VIDEO_TARGETS,
  defaultVideoTarget,
  driveCoverCandidates,
  isEditedFolderName,
  PROMOTED_FROM_PROPERTY,
  isFinalFolderName,
  isMp4VideoFile,
  isPromotedCopy,
  isVerticalCutCandidate,
  selectDriveVideo,
  targetOrientation,
  type DriveVideoFile,
  type DriveVideoScope,
  type DriveVideoSelection,
  type VideoOrientation,
  type VideoTarget,
} from "./lib/diaria/drive-video-source.ts";
import { youtubeVideoFileName } from "./lib/diaria/youtube-video.ts";
import { shortVideoFileName } from "./lib/diaria/short-video.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./lib/diaria/youtube-upload.ts";
import { SHORT_COVER_SOURCE_FILE, buildShortCoverSource } from "./lib/diaria/short-cover.ts";

/**
 * #11547: grava qual Still virou `04-youtube-short-capa.jpg` (o nome traz o
 * timecode que vira o `thumbnailOffset` da Buffer). Opcional: falha só avisa.
 */
export function writeShortCoverSourceSidecar(editionDir: string, stillName: string, bytes: number, log: (line: string) => void): void {
  const path = join(editionDir, SHORT_COVER_SOURCE_FILE);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(buildShortCoverSource(stillName, bytes))}\n`);
  } catch (e) {
    log(`[aviso] origem da capa não registrada (${(e as Error).message}); o X sai sem thumbnailOffset`);
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FOLDER_MIME = "application/vnd.google-apps.folder";
const LIST_FIELDS =
  "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size,appProperties,videoMediaMetadata(width,height,durationMillis))";

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

export interface DriveFetchInit {
  signal?: AbortSignal;
  /** Default GET. POST só na promoção para `Final/` (#11556). */
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchDriveVideoDeps {
  /** Chamada autenticada na Drive API (default: `gFetchRetry`, com refresh do token). */
  driveFetch(url: string, init?: DriveFetchInit): Promise<Response>;
}

export const defaultFetchDriveVideoDeps: FetchDriveVideoDeps = {
  driveFetch: (url, init) => gFetchRetry(url, init ?? {}),
};

export interface FetchDriveVideoInput {
  aammdd: string;
  orientation: VideoOrientation;
  /** Destino na pasta `Final/` (#11222). Default: `defaultVideoTarget(orientation)`. */
  target?: VideoTarget;
  folderId: string;
  editionDir: string;
  now: Date;
  windowHours: number;
  dryRun: boolean;
  force: boolean;
  /**
   * Arquivo escolhido em `Editados/` é copiado para `Final/` (#11556), para o
   * timer do 300 ler o mesmo arquivo. No CLI: `--promote`, ou implícito em
   * `--download`. Ausente = não escreve nada no Drive.
   */
  promote?: boolean;
  /** Teto do download em bytes (#11551); acima dele, sem `force`, nada é baixado. `null`/ausente = sem teto. */
  maxBytes?: number | null;
  timeouts?: FetchDriveVideoTimeouts;
}

/** Teto default do download do horizontal (#11551), em MB; `publishing.youtube.drive_max_download_mb` sobrepõe. */
export const DEFAULT_MAX_DOWNLOAD_MB = 2048;

// ── Saída (união discriminada por `action`) ────────────────────────────────

export interface DescribedDriveFile {
  id: string;
  name: string;
  size: number | null;
  width: number | null;
  height: number | null;
  createdTime: string | null;
  modifiedTime: string | null;
  scope: DriveVideoScope;
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
  cover?: { source: "drive" | "local" | "automatic"; local_path: string; file?: DescribedDriveFile };
}

/** Cópia do escolhido em `Editados/` para `Final/` (#11556). */
export type DrivePromotion =
  | { status: "copied"; final_folder_id: string; file_id: string; created_folder: boolean }
  | { status: "already"; final_folder_id: string; file_id: string }
  | { status: "error"; error: string };

interface OutputWithFolder extends OutputBase {
  /** `[premissa]` da escolha (versão mais alta em `Editados/`, #11556). */
  premise?: string;
  /** Só quando o escolhido veio de `Editados/` e a promoção foi pedida. */
  promoted?: DrivePromotion;
  edition_folder_id: string | null;
  /** Subpasta(s) `Final/` (ou `Editado/`, #11385) listadas dentro da da edição (#11222); vazio sem elas. */
  final_folder_ids: string[];
  /** Destino usado na escolha dentro de `Final/` (#11222). */
  target: VideoTarget;
}

export type FetchDriveVideoOutput =
  | (OutputBase & { action: "exists"; next_command?: string })
  | (OutputBase & { action: "already-published"; record_path: string; video_url: string | null })
  | (OutputBase & { action: "error"; phase: "folder" | "list"; error: string })
  | (OutputBase & { action: "needs-editor"; selection: "duplicate-edition-folder"; folders: DescribedDriveFolder[] })
  | (OutputWithFolder & {
      action: "needs-editor";
      selection: "ambiguous-cover";
      candidates: DescribedDriveFile[];
      /**
       * #11650: como ficou a escolha do VÍDEO, apurada antes da capa travar.
       * Só `found` permite dizer ao editor que "o vertical já é único".
       */
      video_selection: DriveVideoSelection["kind"];
    })
  | (OutputWithFolder & { action: "error"; phase: "cover-download"; error: string })
  | (OutputWithFolder & { action: "none"; selection: "none"; reason: string })
  | (OutputWithFolder & { action: "needs-editor"; selection: "ambiguous"; candidates: DescribedDriveFile[] })
  | (OutputWithFolder & { action: "needs-editor"; selection: "orientation-unknown"; files: DescribedDriveFile[] })
  | (OutputWithFolder & { action: "print-id"; selection: "found"; file: DescribedDriveFile; next_command: string | null })
  | (OutputWithFolder & { action: "dry-run"; selection: "found"; file: DescribedDriveFile })
  | (OutputWithFolder & { action: "downloaded"; selection: "found"; file: DescribedDriveFile; bytes: number })
  | (OutputWithFolder & { action: "error"; phase: "download"; selection: "found"; file: DescribedDriveFile; error: string })
  | (OutputWithFolder & { action: "error"; phase: "size-limit"; selection: "found"; file: DescribedDriveFile; error: string; max_bytes: number });

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
 * Copia (server-side, `files/{id}/copy`) o arquivo escolhido em `Editados/`
 * para `Final/` (#11556), criando `Final/` dentro da pasta da edição quando ela
 * não existe. Idempotente: nome igual já em `Final/`, ou cópia marcada com
 * `appProperties.diaria_promoted_from` = id do original, é `already`. A cópia
 * leva essa marca, para a regra do Instagram (#11419) não tomar a cópia do
 * horizontal como "Final/ já tem .mp4". Falha volta `error`, nunca lança: a
 * escolha continua valendo sem a cópia.
 */
export async function promoteToFinal(
  deps: FetchDriveVideoDeps,
  opts: { editionFolderId: string; finalFolderIds: string[]; finalFiles: DriveVideoFile[]; file: DriveVideoFile; timeoutMs: number },
): Promise<DrivePromotion> {
  const { file } = opts;
  const existing = opts.finalFiles.find(
    (f) => !f.editedFolder && (f.name === file.name || f.appProperties?.[PROMOTED_FROM_PROPERTY] === file.id),
  );
  if (existing && opts.finalFolderIds.length > 0) {
    return { status: "already", final_folder_id: opts.finalFolderIds[0], file_id: existing.id };
  }
  const post = async (url: string, body: unknown): Promise<{ id: string }> => {
    const res = await deps.driveFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { id?: unknown };
    if (typeof data.id !== "string" || !data.id) throw new Error("Drive: resposta sem id");
    return { id: data.id };
  };
  try {
    let folderId = opts.finalFolderIds[0];
    let created = false;
    if (!folderId) {
      const params = new URLSearchParams({ fields: "id", supportsAllDrives: "true" });
      folderId = (await post(`${DRIVE_API}/files?${params}`, { name: "Final", mimeType: FOLDER_MIME, parents: [opts.editionFolderId] })).id;
      created = true;
    }
    const params = new URLSearchParams({ fields: "id", supportsAllDrives: "true" });
    const copy = await post(`${DRIVE_API}/files/${encodeURIComponent(file.id)}/copy?${params}`, {
      name: file.name,
      parents: [folderId],
      appProperties: { [PROMOTED_FROM_PROPERTY]: file.id },
    });
    return { status: "copied", final_folder_id: folderId, file_id: copy.id, created_folder: created };
  } catch (e) {
    return { status: "error", error: (e as Error).message };
  }
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
  const target = input.target ?? defaultVideoTarget(orientation);
  if (targetOrientation(target) !== orientation) {
    throw new Error(`--target ${target} é ${targetOrientation(target)}, não combina com --orientation ${orientation}`);
  }
  // O corte do Instagram (#11222) só é identificado: o arquivo local e o
  // registro do vertical são do corte "Outras redes", então não encurtam.
  const instagramCut = target === "instagram";
  const timeouts = input.timeouts ?? DEFAULT_FETCH_DRIVE_VIDEO_TIMEOUTS;
  const localPath = join(
    input.editionDir,
    orientation === "horizontal" ? youtubeVideoFileName(aammdd) : shortVideoFileName(aammdd),
  );
  const base: OutputBase = { edition: aammdd, orientation, folder_id: input.folderId, local_path: localPath };

  if (orientation === "vertical" && !input.force && !instagramCut && shortsVideoTerminal(input.editionDir, aammdd,
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

  // Vídeo já em disco: o Drive só serve para a capa, então falha nele (offline,
  // token, timeout) ou capa ambígua nunca derruba o `exists` (review #11545).
  const localReady = !input.force && !instagramCut && existsSync(localPath) && statSync(localPath).size > 0;
  const existsOutcome = (): FetchDriveVideoOutcome => {
    log(`[ok] ${localPath} já existe — nada a baixar (use --force para trocar)`);
    if (orientation === "vertical") {
      const next = `npx tsx scripts/publish-shorts.ts ${aammdd}`;
      return { exitCode: 0, output: { ...base, action: "exists", next_command: next } };
    }
    return { exitCode: 0, output: { ...base, action: "exists" } };
  };

  const failed = (phase: "folder" | "list", e: unknown): FetchDriveVideoOutcome => {
    const message = (e as Error).message;
    if (localReady) {
      log(`[aviso] Drive indisponível (${message}); vídeo local mantido, capa do Drive não consultada`);
      return existsOutcome();
    }
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
  const finalFolderIds: string[] = [];
  const coverFiles: DriveVideoFile[] = [];
  /** Só as `Final/` de verdade (sem `Editados/`) e o que há nelas: destino da promoção (#11556). */
  const finalOnlyIds: string[] = [];
  let finalOnlyFiles: DriveVideoFile[] = [];
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
      // #11222: o vídeo pronto mora em `{AAMMDD}/Final/`. Mais de uma `Final`
      // (raro) entra inteira: a ambiguidade aparece no nível do arquivo.
      const listFinalLike = async (folders: DriveVideoFile[], edited: boolean): Promise<DriveVideoFile[]> => {
        const out: DriveVideoFile[] = [];
        for (const folder of folders) {
          finalFolderIds.push(folder.id);
          if (!edited) finalOnlyIds.push(folder.id);
          const children = await listDriveChildren(deps, folder.id, timeouts.listMs);
          out.push(
            ...children
              .filter((f) => f.mimeType !== FOLDER_MIME)
              .map((f) => ({ ...f, scope: "final-folder" as const, ...(edited ? { editedFolder: true } : {}) })),
          );
        }
        return out;
      };
      const subfolders = inside.filter((f) => f.mimeType === FOLDER_MIME);
      let finalFiles = await listFinalLike(subfolders.filter((f) => isFinalFolderName(f.name)), false);
      finalOnlyFiles = finalFiles;
      // #11385: sem candidato DESTE destino em Final/ (sem .mp4, ou só os
      // verticais quando se pede o horizontal), o vídeo pronto pode estar em
      // Editado/ (261028). Final/ com candidato mantém a precedência.
      const probe = selectDriveVideo([...files, ...finalFiles], {
        orientation,
        now: input.now,
        windowHours: input.windowHours,
        editionFolderPresent: true,
        target,
      });
      // #11419: para o Instagram, "Final/ com .mp4 mas sem `_Instagram_`" é o
      // caso NORMAL (sem corte próprio, vale o genérico) — nunca um sinal de
      // que o vídeo pronto está em Editado/, onde costumam ficar exportações
      // intermediárias (um `_Instagram_V2` antigo viraria Reels público).
      // Instagram só cai em Editado/ quando Final/ não tem .mp4 nenhum.
      // #11556: a cópia que o próprio fetch promoveu de Editados/ (o horizontal,
      // por exemplo) não diz nada sobre o corte do Instagram: não conta aqui.
      // #11428: só um corte VERTICAL do editor em Final/ barra Editado/; o
      // horizontal sozinho lá não diz nada sobre o corte do Instagram.
      const skipEdited = instagramCut && finalFiles.some((f) => isVerticalCutCandidate(f) && !isPromotedCopy(f));
      if (probe.kind === "none" && skipEdited) {
        log(`[premissa] Final/ tem .mp4 e nenhum do destino instagram — sem corte próprio do Instagram; Editado/ não é consultada para vídeos (#11419)`);
      }
      // #11577: a escolha em Final/ é a cópia que o fetch promoveu; uma
      // exportação mais nova em Editados/ (V6 depois do V5) precisa ser vista.
      const promotedPick = probe.kind === "found" && isPromotedCopy(probe.file) ? probe.file : null;
      if ((probe.kind === "none" && !skipEdited) || promotedPick) {
        const edited = subfolders.filter((f) => isEditedFolderName(f.name));
        if (edited.length > 0) {
          const why = promotedPick
            ? `${promotedPick.name} em Final/ é cópia promovida; conferindo exportação mais nova`
            : finalFiles.some(isMp4VideoFile) ? `sem .mp4 do destino ${target} em Final/` : "sem .mp4 em Final/";
          log(`[premissa] ${why} — procurando o vídeo pronto em ${edited.map((f) => `${f.name}/`).join(", ")} (#11385)`);
          finalFiles = [...finalFiles, ...(await listFinalLike(edited, true))];
        }
      }
      // Capa tem busca própria: Editado pode conter o Still mesmo com MP4 em Final.
      coverFiles.push(...finalFiles);
      // Só para o Still (#11542): nunca entra em `final_folder_ids` nem na escolha do vídeo.
      for (const folder of subfolders.filter((f) => isEditedFolderName(f.name) && !finalFolderIds.includes(f.id))) {
        const children = await listDriveChildren(deps, folder.id, timeouts.listMs);
        coverFiles.push(...children.filter((f) => f.mimeType !== FOLDER_MIME).map((f) => ({ ...f, scope: "final-folder" as const, editedFolder: true })));
      }
      files.push(...finalFiles);
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
    target,
  });
  const withFolder: OutputWithFolder = { ...base, edition_folder_id: editionFolderId, final_folder_ids: finalFolderIds, target };

  const coverPath = join(input.editionDir, orientation === "horizontal" ? "04-youtube-thumb.jpg" : "04-youtube-short-capa.jpg");
  const covers = driveCoverCandidates(coverFiles, orientation);
  const localCoverExists = existsSync(coverPath) && statSync(coverPath).size > 0;
  // #11650: a ambiguidade só importa quando a capa do Drive seria usada. Com a
  // capa local presente e sem --force (#11636), o Still do Drive é ignorado de
  // qualquer jeito, então não pode travar o download do vídeo.
  const driveCoverWouldBeUsed = !localCoverExists || input.force;
  if (covers.length > 1 && localReady) {
    log(`[aviso] capas Still ambíguas (${covers.map(describeForLog).join(" | ")}); vídeo local mantido, capa do Drive ignorada — deixe uma só em Final/ e rode de novo`);
    covers.length = 0;
  } else if (covers.length > 1 && !driveCoverWouldBeUsed) {
    log(`[aviso] capas Still ambíguas (${covers.map(describeForLog).join(" | ")}); capa local mantida, Still do Drive ignorado — o vídeo segue (#11650)`);
    covers.length = 0;
  } else if (covers.length > 1) {
    log(`[aviso] capas Still ambíguas: ${covers.map(describeForLog).join(" | ")}`);
    return {
      exitCode: 3,
      output: { ...withFolder, action: "needs-editor", selection: "ambiguous-cover", candidates: covers.map(describeFile), video_selection: sel.kind },
    };
  }
  // #11636: preservar ajustes locais; trocar a capa exige --force.
  const cover = localCoverExists && !input.force ? undefined : covers[0];
  if (localCoverExists && !input.force && covers[0]) {
    log("[ok] capa local mantida — use --force para substituir pelo Still do Drive");
  }
  const coverPlan: NonNullable<OutputBase["cover"]> = {
    source: cover ? "drive" : existsSync(coverPath) && statSync(coverPath).size > 0 ? "local" : "automatic",
    local_path: coverPath,
    ...(cover ? { file: describeFile(cover) } : {}),
  };
  withFolder.cover = coverPlan;
  base.cover = coverPlan;
  if (cover && !input.dryRun) {
    const source = `${coverPath}.drive-source-${process.pid}-${Date.now()}`;
    const converted = `${coverPath}.drive-converted-${process.pid}.jpg`;
    try {
      await downloadDriveFile(deps, cover, source, timeouts, log, (type) => {
        const mime = type.split(";")[0].trim().toLowerCase();
        return ["image/jpeg", "image/png", "application/octet-stream"].includes(mime);
      });
      // Os publishers esperam JPEG real, inclusive quando o Still no Drive é PNG.
      await sharp(source).rotate().jpeg({ quality: 95 }).toFile(converted);
      const replacingLocalCover = existsSync(coverPath) && statSync(coverPath).size > 0;
      renameSync(converted, coverPath);
      if (replacingLocalCover) log("[premissa] capa local substituída pelo Still do Drive");
      log(`[ok] capa do Drive: ${describeForLog(cover)} → ${coverPath}`);
      if (orientation === "vertical") writeShortCoverSourceSidecar(input.editionDir, cover.name, statSync(coverPath).size, log);
    } catch (e) {
      // A capa é opcional: cai na local/automática em vez de barrar o vídeo (review #11545).
      const fallback = existsSync(coverPath) && statSync(coverPath).size > 0 ? "local" : "automatic";
      log(`[aviso] capa do Drive não baixada (${(e as Error).message}); segue com a capa ${fallback}`);
      coverPlan.source = fallback;
      delete coverPlan.file;
    } finally {
      rmSync(source, { force: true });
      rmSync(converted, { force: true });
    }
  }
  if (localReady) return existsOutcome();

  if (sel.kind === "none") {
    log(`[aviso] ${sel.reason} — nada baixado; quando o vídeo subir, rodar /diaria-publica-video ${aammdd}`);
    return { exitCode: 0, output: { ...withFolder, action: "none", selection: "none", reason: sel.reason } };
  }
  if (sel.kind === "ambiguous") {
    log(`[aviso] ${sel.candidates.length} .mp4 ${orientation} finais (destino ${target}) — escolha do editor: ${sel.candidates.map(describeForLog).join(" | ")}`);
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
  if (sel.premise) {
    log(`[premissa] ${sel.premise}`);
    withFolder.premise = sel.premise;
  }
  if (file.editedFolder && input.promote && editionFolderId) {
    const promoted = await promoteToFinal(deps, {
      editionFolderId,
      finalFolderIds: finalOnlyIds,
      finalFiles: finalOnlyFiles,
      file,
      timeoutMs: timeouts.listMs,
    });
    withFolder.promoted = promoted;
    if (promoted.status === "error") log(`[aviso] cópia de ${file.name} para Final/ falhou (${promoted.error}); a escolha vale assim mesmo (#11556)`);
    else if (promoted.status === "already") log(`[ok] ${file.name} já está em Final/ (id ${promoted.file_id})`);
    else log(`[ok] ${file.name} copiado para Final/${promoted.created_folder ? " (pasta criada)" : ""}: id ${promoted.file_id} (#11556)`);
  } else if (file.editedFolder) {
    log(`[premissa] ${file.name} veio de Editados/; não copiado para Final/ (sem --promote/--download)`);
  }
  if (instagramCut) {
    // O publish-shorts.ts usa um vertical só para todos os destinos (o corte
    // "Outras redes"); o do Instagram é identificado para o passo guiado.
    log(`[ok] vertical para o Instagram: ${file.name} (id ${file.id}) — o publish-shorts.ts não o usa sozinho; vale para o Instagram guiado`);
    return { exitCode: 0, output: { ...withFolder, action: "print-id", selection: "found", file: described, next_command: null } };
  }
  if (orientation === "vertical") {
    const next = `npx tsx scripts/publish-shorts.ts ${aammdd} --from-drive ${file.id}`;
    log(`[ok] vertical do dia: ${file.name} — próximo passo: ${next}`);
    return { exitCode: 0, output: { ...withFolder, action: "print-id", selection: "found", file: described, next_command: next } };
  }
  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
  const sizeTxt = described.size !== null ? mb(described.size) : "tamanho desconhecido";
  if (input.dryRun) {
    log(`[plano] baixaria ${file.name} (${sizeTxt}) → ${localPath}; nada gravado (download só com --download, #11551)`);
    return { exitCode: 0, output: { ...withFolder, action: "dry-run", selection: "found", file: described } };
  }
  const maxBytes = input.maxBytes ?? null;
  if (maxBytes !== null && described.size !== null && described.size > maxBytes && !input.force) {
    const error = `${file.name} tem ${sizeTxt}, acima do teto de ${mb(maxBytes)} (--max-mb); nada baixado — conferir o arquivo ou rodar com --force`;
    log(`fetch-drive-video: ${error}`);
    return {
      exitCode: 1,
      output: { ...withFolder, action: "error", phase: "size-limit", selection: "found", file: described, error, max_bytes: maxBytes },
    };
  }
  log(`[download] ${file.name} (${sizeTxt}) → ${localPath}`);
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
  "uso: fetch-drive-video.ts --edition AAMMDD --orientation horizontal|vertical [--target youtube|outras-redes|instagram] [--folder-id ID] [--window-hours N] [--edition-dir DIR] [--download [--max-mb N]] [--promote] [--dry-run] [--force]";

export function readYouTubeDriveConfig(config: unknown): { folderId: string | null; windowHours: number | null; maxDownloadMb?: number | null } {
  const yt = (config as { publishing?: { youtube?: { drive_folder_id?: unknown; drive_window_hours?: unknown; drive_max_download_mb?: unknown } } })
    ?.publishing?.youtube;
  const folderId = typeof yt?.drive_folder_id === "string" && yt.drive_folder_id.trim() ? yt.drive_folder_id.trim() : null;
  const windowHours =
    typeof yt?.drive_window_hours === "number" && yt.drive_window_hours > 0 ? yt.drive_window_hours : null;
  const out: { folderId: string | null; windowHours: number | null; maxDownloadMb?: number | null } = { folderId, windowHours };
  if (typeof yt?.drive_max_download_mb === "number" && yt.drive_max_download_mb > 0) out.maxDownloadMb = yt.drive_max_download_mb;
  return out;
}

export type ParsedFetchDriveVideoArgs =
  | {
      ok: true;
      aammdd: string;
      orientation: VideoOrientation;
      target: VideoTarget;
      folderId: string;
      windowHours: number;
      editionDir: string | null;
      /** Sem `--download` o CLI só planeja (#11551): nenhum byte vai para o disco. */
      dryRun: boolean;
      force: boolean;
      /** `--promote`, ou implícito em `--download` (#11556). */
      promote: boolean;
      /** Teto do download (#11551): `--max-mb`, `drive_max_download_mb` ou `DEFAULT_MAX_DOWNLOAD_MB`. */
      maxBytes: number;
    }
  | { ok: false; error: string };

/** Parse puro do argv (nenhuma rede, nenhum disco): erro = exit 2. */
export function parseFetchDriveVideoArgs(
  argv: string[],
  cfg: ReturnType<typeof readYouTubeDriveConfig>,
): ParsedFetchDriveVideoArgs {
  const { flags, values, positional } = parseArgs(argv);
  // `--dry-run 261025` engoliria a edição como valor da flag; e flag de valor sem valor vira flag solta.
  const misused = ["dry-run", "force", "download", "promote"].filter((f) => values[f] !== undefined);
  const missingValue = ["edition", "orientation", "target", "folder-id", "window-hours", "edition-dir", "max-mb"].filter((f) => flags.has(f));
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
  const rawTarget = values["target"];
  if (rawTarget !== undefined && !(VIDEO_TARGETS as readonly string[]).includes(rawTarget)) {
    return { ok: false, error: `--target deve ser ${VIDEO_TARGETS.join(", ")} (veio ${JSON.stringify(rawTarget)})` };
  }
  const target = (rawTarget as VideoTarget | undefined) ?? defaultVideoTarget(orientation);
  if (targetOrientation(target) !== orientation) {
    return { ok: false, error: `--target ${target} é ${targetOrientation(target)}, não combina com --orientation ${orientation}` };
  }
  const folderId = values["folder-id"]?.trim() || cfg.folderId;
  if (!folderId) return { ok: false, error: "sem pasta — passe --folder-id ou preencha publishing.youtube.drive_folder_id" };
  const windowRaw = values["window-hours"];
  const windowHours = windowRaw !== undefined ? Number(windowRaw) : (cfg.windowHours ?? DRIVE_VIDEO_WINDOW_HOURS);
  if (!Number.isFinite(windowHours) || windowHours <= 0) return { ok: false, error: `--window-hours inválido (${windowRaw})` };
  const download = flags.has("download");
  if (download && flags.has("dry-run")) return { ok: false, error: "--download e --dry-run juntos se contradizem" };
  const maxRaw = values["max-mb"];
  const maxMb = maxRaw !== undefined ? Number(maxRaw) : (cfg.maxDownloadMb ?? DEFAULT_MAX_DOWNLOAD_MB);
  if (!Number.isFinite(maxMb) || maxMb <= 0) return { ok: false, error: `--max-mb inválido (${maxRaw})` };
  return {
    ok: true,
    aammdd,
    orientation,
    target,
    folderId,
    windowHours,
    editionDir: values["edition-dir"] ?? null,
    dryRun: !download,
    force: flags.has("force"),
    promote: download || flags.has("promote"),
    maxBytes: Math.round(maxMb * 1e6),
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
        target: args.target,
        folderId: args.folderId,
        editionDir: resolve(args.editionDir ?? editionDirFor(args.aammdd)),
        now: new Date(),
        windowHours: args.windowHours,
        dryRun: args.dryRun,
        force: args.force,
        promote: args.promote,
        maxBytes: args.maxBytes,
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
