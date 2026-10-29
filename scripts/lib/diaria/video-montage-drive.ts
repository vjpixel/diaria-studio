/**
 * video-montage-drive.ts (#11639, #11640, #11641) — a montagem do vídeo fora do
 * Neo: sem o Drive for desktop (`G:`), a pasta da edição
 * (`Mentoria Fluxo VTSD/YouTube/{AAMMDD}/`) é lida e escrita pela API do Drive.
 *
 * - #11639: o bruto (e o áudio separado do `--from-audio`, e o export do
 *   `review-final`) é baixado para um cache em DISCO (`~/.cache/...`, nunca o
 *   `/tmp`, que no 300 é tmpfs), com o teto do download proporcional ao
 *   tamanho (6,9 GB na 261030 não cabem nos 20 min do `drive-download.ts`).
 * - #11640: XML, SRTs e prévias sobem para a pasta da edição (nunca `Final/`),
 *   atualizando pelo id o arquivo de mesmo nome que já esteja lá.
 * - #11641: o XML grava o caminho do bruto no NEO (`G:/Meu Drive/...`), não o
 *   do cache local, para o Premiere abrir com a mídia online.
 *
 * Funções puras (testadas) + IO com `driveFetch` injetável. Auth em produção:
 * `gFetchRetry` (OAuth do projeto, `data/.credentials.json`, scope Drive).
 */

import { existsSync, mkdirSync, readFileSync, statSync, statfsSync } from "node:fs";
import { basename, join } from "node:path";
import { DRIVE_API, DRIVE_UPLOAD } from "../drive-constants.ts";
import { escapeDriveQueryString } from "../drive-helpers.ts";
import { downloadDriveFile, type DriveDownloadDeps } from "../drive-download.ts";
import { isFinalFolderName } from "./drive-video-source.ts";
import { pickRawSource } from "./video-montage.ts";

export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** A pasta YouTube do Drive no Neo (Drive for desktop). Fonte única, reexportada pelo `video-montagem.ts`. */
export const DEFAULT_DRIVE_ROOT = "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube";

export interface MontageDriveDeps {
  driveFetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

/** Registro do bruto baixado (`bruto.drive.json` no state dir). */
export interface BrutoDriveInfo {
  id: string;
  name: string;
  size: number;
  modifiedTime: string | null;
  folderId: string;
  localPath: string;
}

const LIST_FIELDS = "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)";

// ── puro ─────────────────────────────────────────────────────────────────

/**
 * Teto do download proporcional ao tamanho (#11639): nunca menos que 20 min
 * (o default do `drive-download.ts`), e o tempo do arquivo a 2 MB/s. O
 * watchdog de ociosidade (60 s sem bytes) continua pegando conexão travada.
 */
export function downloadBudgetMs(sizeBytes: number, opts: { minMs?: number; floorBytesPerS?: number } = {}): number {
  const minMs = opts.minMs ?? 20 * 60_000;
  const floor = opts.floorBytesPerS ?? 2_000_000;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return minMs;
  return Math.max(minMs, Math.ceil((sizeBytes / floor) * 1000));
}

/** O bruto da pasta da edição pela mesma regra do disco (`pickRawSource`): só arquivos soltos, nunca subpastas. */
export function pickDriveBruto(children: DriveEntry[]): { pick: DriveEntry; candidates: DriveEntry[]; audioOnly?: true } | null {
  const files = children.filter((c) => c.mimeType !== FOLDER_MIME);
  const byName = new Map(files.map((c) => [c.name, c]));
  const raw = pickRawSource(files.map((c) => ({ name: c.name, size: Number(c.size ?? 0) })));
  if (!raw) return null;
  const get = (n: string) => byName.get(n)!;
  return { pick: get(raw.pick.name), candidates: raw.candidates.map((c) => get(c.name)), ...(raw.audioOnly ? { audioOnly: true as const } : {}) };
}

/** Cache local vale quando o arquivo existe com o tamanho do Drive. */
export function cacheIsFresh(localSize: number | null, driveSize: string | undefined): boolean {
  if (localSize === null || localSize <= 0) return false;
  if (driveSize === undefined) return true;
  return Number(driveSize) === localSize;
}

const sameFile = (a: string, b: string) => a.replace(/\\/g, "/") === b.replace(/\\/g, "/");

/**
 * #11641: o caminho do bruto que vai no `pathurl` do XML. O XML é aberto no
 * Neo; com o bruto lido do cache local (modo API), o caminho de leitura não
 * existe lá. Bruto do cache → `{raiz no Neo}/{AAMMDD}/{nome no Drive}`.
 * `xmlMediaRoot` explícito vale também para um bruto local qualquer
 * (`--xml-media-root`). Sem nenhum dos dois: o próprio caminho de leitura
 * (o Neo, que lê de `G:`).
 */
export function xmlMediaPath(sourcePath: string, opts: { edition: string; drive?: Pick<BrutoDriveInfo, "name" | "localPath"> | null; xmlMediaRoot?: string }): string {
  const fromCache = opts.drive && sameFile(sourcePath, opts.drive.localPath);
  if (!fromCache && opts.xmlMediaRoot === undefined) return sourcePath;
  const root = (opts.xmlMediaRoot ?? DEFAULT_DRIVE_ROOT).replace(/\\/g, "/").replace(/\/+$/, "");
  const name = fromCache ? opts.drive!.name : basename(sourcePath.replace(/\\/g, "/"));
  return `${root}/${opts.edition}/${name}`;
}

/** Tipo MIME do upload por extensão (Drive mostra prévia de mp4/jpg; o resto vai como texto/xml). */
export function uploadMimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "xml":
      return "application/xml";
    case "srt":
      return "application/x-subrip";
    case "md":
      return "text/markdown";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

/** content-type aceitável no download de mídia (vídeo ou áudio do bruto, export). */
export function isAcceptableMediaContentType(contentType: string, fileName: string): boolean {
  const t = contentType.split(";")[0].trim().toLowerCase();
  if (t.startsWith("video/") || t.startsWith("audio/")) return true;
  return t === "application/octet-stream" && /\.(mp4|mov|m4a|mp3|wav|aac|ogg|opus|flac)$/i.test(fileName);
}

/**
 * Arquivos do out dir que esta execução gravou: os que não existiam antes ou
 * mudaram de mtime/tamanho. Só esses sobem (#11640).
 */
export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after.entries()].filter(([name, sig]) => before.get(name) !== sig).map(([name]) => name).sort();
}

/** Assinatura `mtime:size` dos arquivos soltos de `dir` (vazio se a pasta não existe). */
export function snapshotDir(dir: string, list: (d: string) => string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of list(dir)) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && !name.endsWith(".part")) out.set(name, `${st.mtimeMs}:${st.size}`);
    } catch {
      // sumiu entre o readdir e o stat
    }
  }
  return out;
}

/** Espaço livre (bytes) no sistema de arquivos de `dir`; null quando não dá para medir. */
export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

// ── Drive ────────────────────────────────────────────────────────────────

async function okJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Lista filhos diretos (não lixeira), paginando. `extraQ` restringe (ex.: nome). */
export async function listChildren(deps: MontageDriveDeps, folderId: string, extraQ?: string): Promise<DriveEntry[]> {
  const out: DriveEntry[] = [];
  let pageToken: string | undefined;
  do {
    const q = `'${escapeDriveQueryString(folderId)}' in parents and trashed = false${extraQ ? ` and ${extraQ}` : ""}`;
    const params = new URLSearchParams({ q, fields: LIST_FIELDS, pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await okJson<{ files?: DriveEntry[]; nextPageToken?: string }>(
      await deps.driveFetch(`${DRIVE_API}/files?${params}`, { signal: AbortSignal.timeout(30_000) }),
      "listagem do Drive",
    );
    out.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

/** A pasta `{AAMMDD}/` dentro da pasta YouTube. Nenhuma ou mais de uma é erro (nunca escolhe sozinho). */
export async function findEditionFolder(deps: MontageDriveDeps, rootFolderId: string, edition: string): Promise<DriveEntry> {
  const found = await listChildren(deps, rootFolderId, `name = '${escapeDriveQueryString(edition)}' and mimeType = '${FOLDER_MIME}'`);
  if (found.length === 0) {
    throw new Error(`pasta ${edition}/ não encontrada no Drive (pasta YouTube ${rootFolderId}): o bruto foi enviado? (#11639)`);
  }
  if (found.length > 1) throw new Error(`${found.length} pastas ${edition}/ no Drive (${found.map((f) => f.id).join(", ")}): junte ou renomeie`);
  return found[0];
}

/**
 * Baixa `file` para `{cacheDir}/{nome}` se o cache não estiver em dia (#11639).
 * Confere o espaço livre antes (tamanho + 10%) e escala o teto do download.
 */
export async function ensureCachedFile(
  deps: MontageDriveDeps,
  file: DriveEntry,
  cacheDir: string,
  log: (line: string) => void,
): Promise<{ localPath: string; downloaded: boolean; bytes: number }> {
  const localPath = join(cacheDir, file.name);
  const localSize = existsSync(localPath) ? statSync(localPath).size : null;
  if (cacheIsFresh(localSize, file.size)) {
    log(`[drive] ${file.name} já no cache (${localPath})`);
    return { localPath, downloaded: false, bytes: localSize ?? 0 };
  }
  const size = Number(file.size ?? 0);
  mkdirSync(cacheDir, { recursive: true });
  const free = freeBytes(cacheDir);
  if (free !== null && size > 0 && free < size * 1.1) {
    throw new Error(`sem espaço para baixar ${file.name} (${(size / 1e9).toFixed(2)} GB) em ${cacheDir}: ${(free / 1e9).toFixed(2)} GB livres`);
  }
  const budget = downloadBudgetMs(size);
  log(`[drive] baixando ${file.name} (${(size / 1e9).toFixed(2)} GB) para ${localPath} (teto ${Math.round(budget / 60_000)} min)…`);
  const t0 = Date.now();
  const dl: DriveDownloadDeps = { driveFetch: (url, init) => deps.driveFetch(url, init) };
  const bytes = await downloadDriveFile(dl, file, localPath, { downloadMs: budget, idleMs: 60_000 }, log, isAcceptableMediaContentType);
  const s = (Date.now() - t0) / 1000;
  log(`[drive] ${file.name}: ${(bytes / 1e9).toFixed(2)} GB em ${s.toFixed(0)} s (${(bytes / 1e6 / Math.max(s, 1)).toFixed(1)} MB/s)`);
  return { localPath, downloaded: true, bytes };
}

/** Um arquivo pelo nome numa pasta (o mais recente quando há vários). */
export async function findByName(deps: MontageDriveDeps, folderId: string, name: string): Promise<{ file: DriveEntry | null; duplicates: number }> {
  const found = (await listChildren(deps, folderId, `name = '${escapeDriveQueryString(name)}'`)).filter((f) => f.mimeType !== FOLDER_MIME);
  found.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));
  return { file: found[0] ?? null, duplicates: Math.max(0, found.length - 1) };
}

/**
 * Sobe `localPath` para a pasta (#11640): atualiza o conteúdo do arquivo de
 * mesmo nome que já esteja lá (sem duplicar) ou cria. Upload resumable em
 * duas chamadas (sessão + conteúdo), que serve para a prévia de centenas de MB
 * e para o XML de poucos KB.
 */
export async function uploadToFolder(
  deps: MontageDriveDeps,
  folderId: string,
  localPath: string,
  log: (line: string) => void = () => {},
): Promise<{ id: string; name: string; webViewLink: string | null; updated: boolean }> {
  const name = basename(localPath);
  const content = readFileSync(localPath);
  const mime = uploadMimeFor(name);
  const { file: existing, duplicates } = await findByName(deps, folderId, name);
  if (duplicates) log(`[aviso] ${duplicates + 1} arquivos "${name}" na pasta do Drive: atualizando o mais recente (${existing!.id})`);
  const fields = "id,name,webViewLink";
  const sessionUrl = existing
    ? `${DRIVE_UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&supportsAllDrives=true&fields=${fields}`
    : `${DRIVE_UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=${fields}`;
  const session = await deps.driveFetch(sessionUrl, {
    method: existing ? "PATCH" : "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mime,
      "X-Upload-Content-Length": String(content.length),
    },
    body: JSON.stringify(existing ? {} : { name, parents: [folderId] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!session.ok) throw new Error(`upload de ${name} para o Drive: sessão recusada (${session.status}): ${(await session.text()).slice(0, 300)}`);
  const location = session.headers.get("location");
  if (!location) throw new Error(`upload de ${name} para o Drive: sessão sem Location`);
  const put = await deps.driveFetch(location, {
    method: "PUT",
    headers: { "Content-Type": mime, "Content-Length": String(content.length) },
    body: content,
    signal: AbortSignal.timeout(Math.max(120_000, downloadBudgetMs(content.length, { minMs: 120_000 }))),
  });
  const meta = await okJson<{ id?: string; name?: string; webViewLink?: string }>(put, `upload de ${name} para o Drive`);
  if (!meta.id) throw new Error(`upload de ${name} para o Drive: resposta sem id`);
  return { id: meta.id, name: meta.name ?? name, webViewLink: meta.webViewLink ?? null, updated: Boolean(existing) };
}

/** Subpastas `Final/` (e variações) da edição: onde fica o export que o `review-final` lê. */
export function finalFolders(children: DriveEntry[]): DriveEntry[] {
  return children.filter((c) => c.mimeType === FOLDER_MIME && isFinalFolderName(c.name));
}

/** `publishing.youtube.drive_folder_id` do `platform.config.json` (a pasta YouTube). */
export function youtubeFolderIdFrom(config: unknown): string | null {
  const id = (config as { publishing?: { youtube?: { drive_folder_id?: unknown } } })?.publishing?.youtube?.drive_folder_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}
