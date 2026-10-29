/**
 * video-montage-drive.ts (#11639, #11640, #11641) — a montagem do vídeo fora do
 * Neo: sem o Drive for desktop (`G:`), a pasta da edição
 * (`Mentoria Fluxo VTSD/YouTube/{AAMMDD}/`) é lida e escrita pela API do Drive.
 *
 * - #11639: o bruto (e o áudio separado do `--from-audio`, e o export do
 *   `review-final`) é baixado para um cache em DISCO (`~/.cache/...`, nunca o
 *   `/tmp`, que no 300 é tmpfs), com o teto do download proporcional ao
 *   tamanho (6,9 GB na 261030 não cabem nos 20 min do `drive-download.ts`).
 *   O cache se confere pelo id, `modifiedTime` e tamanho do Drive (sidecar
 *   `{arquivo}.drive.json`), nunca só pelo nome.
 * - #11640: os arquivos que o comando gravou no out dir sobem para a pasta da
 *   edição (nunca `Final/`), atualizando pelo id o arquivo de mesmo nome.
 * - #11641: o XML grava o caminho do bruto no NEO (`G:/Meu Drive/...`), não o
 *   do cache local, para o Premiere abrir com a mídia online.
 *
 * Funções puras (testadas) + IO com `driveFetch` injetável. Auth em produção:
 * `gFetchRetry`/`gFetch` (`scripts/google-auth.ts`: OAuth do projeto em
 * `data/.credentials.json`, scope Drive).
 */

import { existsSync, mkdirSync, readFileSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DRIVE_API, DRIVE_UPLOAD } from "../drive-constants.ts";
import { escapeDriveQueryString } from "../drive-helpers.ts";
import { downloadDriveFile, type DriveDownloadDeps } from "../drive-download.ts";
import { isFinalFolderName } from "./drive-video-source.ts";
import { pickRawSource } from "./video-montage.ts";

export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** A pasta YouTube do Drive no Neo (Drive for desktop). Fonte única, reexportada pelo `video-montagem.ts`. */
export const DEFAULT_DRIVE_ROOT = "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube";

export interface MontageDriveDeps {
  /** Chamada autenticada COM retry de transientes (`gFetchRetry`): listagem, metadado, download, sessão de upload. */
  driveFetch(url: string, init?: RequestInit): Promise<Response>;
  /**
   * Chamada autenticada SEM retry (`gFetch`), para o PUT do conteúdo do upload
   * resumable: reenviar o corpo inteiro na mesma sessão depois de um 5xx não é o
   * protocolo; `uploadToFolder` abre uma sessão nova a cada tentativa. Ausente =
   * `driveFetch` (testes).
   */
  uploadFetch?(url: string, init?: RequestInit): Promise<Response>;
}

/** Um arquivo/pasta como a listagem do Drive devolve (`size` é string int64 na API). */
export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

/** O mínimo para baixar e conferir o cache. */
export type DriveFileRef = Pick<DriveEntry, "id" | "name" | "size" | "modifiedTime">;

/** Registro do bruto baixado (`bruto.drive.json` no state dir). */
export interface BrutoDriveInfo {
  edition: string;
  id: string;
  name: string;
  size: number | null;
  modifiedTime: string | null;
  folderId: string;
  /** Caminho do cache, com `/` (comparado a `source.path` por `toPosix`). */
  localPath: string;
}

/** Sidecar do cache (`{arquivo}.drive.json`): de qual arquivo do Drive é a cópia local. */
export interface CacheSidecar {
  id: string;
  size: number | null;
  modifiedTime: string | null;
}

const LIST_FIELDS = "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)";

// ── puro ─────────────────────────────────────────────────────────────────

/** `/` sempre: a mesma forma do caminho em `source.json`, `bruto.drive.json` e nas comparações. */
export const toPosix = (p: string) => p.replace(/\\/g, "/");

/** `size` da API (string int64) → bytes; ausente ou ilegível = null (nunca NaN). */
export function parseDriveSize(size: string | undefined): number | null {
  if (size === undefined || size.trim() === "") return null;
  const n = Number(size);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Teto do download proporcional ao tamanho (#11639): nunca menos que 20 min
 * (o default do `drive-download.ts`), e o tempo do arquivo a 2 MB/s. O
 * watchdog de ociosidade (60 s sem bytes) continua pegando conexão travada.
 */
export function downloadBudgetMs(sizeBytes: number | null, opts: { minMs?: number; floorBytesPerS?: number } = {}): number {
  const minMs = opts.minMs ?? 20 * 60_000;
  const floor = opts.floorBytesPerS ?? 2_000_000;
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return minMs;
  return Math.max(minMs, Math.ceil((sizeBytes / floor) * 1000));
}

/**
 * O bruto da pasta da edição pela mesma regra do disco (`pickRawSource`): só
 * arquivos soltos, nunca subpastas. `duplicateNames`: nomes repetidos entre os
 * candidatos (o Drive aceita dois arquivos com o mesmo nome; o id escolhido é o
 * do maior, mas o editor precisa saber).
 */
export function pickDriveBruto(children: DriveEntry[]): { pick: DriveEntry; candidates: DriveEntry[]; audioOnly?: true; duplicateNames: string[] } | null {
  const files = children.filter((c) => c.mimeType !== FOLDER_MIME).map((entry) => ({ name: entry.name, size: parseDriveSize(entry.size) ?? 0, entry }));
  const raw = pickRawSource(files);
  if (!raw) return null;
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const c of raw.candidates) (seen.has(c.name) ? dup : seen).add(c.name);
  return {
    pick: raw.pick.entry,
    candidates: raw.candidates.map((c) => c.entry),
    ...(raw.audioOnly ? { audioOnly: true as const } : {}),
    duplicateNames: [...dup],
  };
}

/**
 * O cache local ainda é a cópia de `file`? (#11639) Sem arquivo local:
 * `missing`. Com o sidecar: o id, o `modifiedTime` e o tamanho têm de bater
 * (bruto trocado no Drive com o mesmo nome e tamanho é `stale`). Sem sidecar
 * (cache de antes dele): só o tamanho, quando o Drive o informa.
 */
export function cacheState(localSize: number | null, sidecar: CacheSidecar | null, file: DriveFileRef): "fresh" | "stale" | "missing" {
  if (localSize === null || localSize <= 0) return "missing";
  const driveSize = parseDriveSize(file.size);
  if (driveSize !== null && driveSize !== localSize) return "stale";
  if (sidecar) {
    if (sidecar.id !== file.id) return "stale";
    if (file.modifiedTime && sidecar.modifiedTime && sidecar.modifiedTime !== file.modifiedTime) return "stale";
  }
  return "fresh";
}

/**
 * Quanto espaço o download pede além do que já está livre: o tamanho + 10%.
 * Sem desconto do arquivo velho: o download escreve num `.part` e só renomeia
 * no fim, então os dois coexistem no pico.
 */
export function spaceShortfall(free: number | null, size: number | null): number | null {
  if (free === null || size === null || size <= 0) return null;
  const need = size * 1.1;
  return free >= need ? 0 : need - free;
}

/**
 * #11641: o caminho do bruto que vai no `pathurl` do XML, aberto no Neo.
 * - bruto do cache do modo API → `{raiz}/{AAMMDD}/{nome no Drive}` (`cache`);
 * - `xmlMediaRoot` explícito (`--xml-media-root`) → `{raiz}/{AAMMDD}/{nome do arquivo}` (`root`);
 * - modo API com um bruto local fora do cache (`--source`) → a raiz do Neo com o
 *   nome do arquivo, como premissa (`api-guess`): o caminho de leitura é desta máquina;
 * - senão (o Neo lendo de `G:`) → o próprio caminho de leitura (`source`).
 */
export function xmlMediaPath(
  sourcePath: string,
  opts: { edition: string; drive?: Pick<BrutoDriveInfo, "name" | "localPath"> | null; xmlMediaRoot?: string; apiMode?: boolean },
): { path: string; how: "cache" | "root" | "api-guess" | "source" } {
  const fromCache = Boolean(opts.drive) && toPosix(sourcePath) === toPosix(opts.drive!.localPath);
  const how = fromCache ? "cache" : opts.xmlMediaRoot !== undefined ? "root" : opts.apiMode ? "api-guess" : "source";
  if (how === "source") return { path: sourcePath, how };
  const root = toPosix(opts.xmlMediaRoot ?? DEFAULT_DRIVE_ROOT).replace(/\/+$/, "");
  const name = fromCache ? opts.drive!.name : basename(toPosix(sourcePath));
  return { path: `${root}/${opts.edition}/${name}`, how };
}

/** Tipo MIME do upload por extensão. */
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

/**
 * Assinatura `mtime:size` dos arquivos soltos de `dir` (vazio se a pasta não
 * existe). Só um arquivo que sumiu entre o readdir e o stat (ENOENT) fica de
 * fora; outro erro de stat sobe, para um arquivo gravado nunca deixar de subir
 * em silêncio.
 */
export function snapshotDir(dir: string, list: (d: string) => string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of list(dir)) {
    if (name.endsWith(".part")) continue;
    let st;
    try {
      st = statSync(join(dir, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    if (st.isFile()) out.set(name, `${st.mtimeMs}:${st.size}`);
  }
  return out;
}

/** Espaço livre (bytes) no sistema de arquivos de `dir` (ou do ancestral mais próximo que existe); null quando não dá para medir. */
export function freeBytes(dir: string): number | null {
  let d = dir;
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  try {
    const s = statfsSync(d);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Como esta execução chega na pasta da edição (#11639): `local` (Drive for
 * desktop, o Neo) ou `api` (o 300). `--from-drive` força a API; `--no-drive-api`
 * a desliga. Sem flag, decide a RAIZ (a pasta YouTube), nunca a pasta da
 * edição: no Neo com `G:` montado e `{AAMMDD}/` ainda não sincronizada o modo
 * continua local (o `transcribe` para dizendo isso), em vez de baixar 7 GB pela
 * API em silêncio. `--drive-root`/`DIARIA_VIDEO_DRIVE_ROOT` explícito também é
 * local (a raiz foi pedida). Só a raiz padrão ausente (esta máquina não tem `G:`)
 * vira api.
 */
export function driveModeFor(o: { driveRootExists: boolean; fromDrive: boolean; noDriveApi: boolean; explicitRoot: boolean }): "local" | "api" {
  if (o.fromDrive && o.noDriveApi) throw new Error("--from-drive e --no-drive-api juntos: escolha um");
  if (o.fromDrive) return "api";
  if (o.noDriveApi || o.driveRootExists || o.explicitRoot) return "local";
  return "api";
}

/** Cache em DISCO do modo API (o `/tmp` do 300 é tmpfs): `--cache-dir`, `DIARIA_VIDEO_CACHE_DIR` ou `~/.cache/diaria-video-montagem`. */
export function driveCacheDir(edition: string, flag: string | undefined, env: string | undefined, home: string): string {
  return resolve(join(flag ?? env ?? join(home, ".cache", "diaria-video-montagem"), edition));
}

/** Work dir (áudio 16 kHz, clipes da prévia): no modo API também em disco, no cache; no Neo o `tmp` de sempre. */
export function workDirDefault(mode: "local" | "api", cacheDir: string, tmp: string, edition: string): string {
  return mode === "api" ? join(cacheDir, "work") : join(tmp, "diaria-video-montagem", edition);
}

// ── Drive ────────────────────────────────────────────────────────────────

async function okJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Filtro da listagem (escapado aqui dentro, nunca texto de query cru vindo de fora). */
export interface ChildrenFilter {
  name?: string;
  foldersOnly?: boolean;
}

/** Lista filhos diretos (não lixeira), paginando. */
export async function listChildren(deps: MontageDriveDeps, folderId: string, filter: ChildrenFilter = {}): Promise<DriveEntry[]> {
  const out: DriveEntry[] = [];
  let pageToken: string | undefined;
  let q = `'${escapeDriveQueryString(folderId)}' in parents and trashed = false`;
  if (filter.name !== undefined) q += ` and name = '${escapeDriveQueryString(filter.name)}'`;
  if (filter.foldersOnly) q += ` and mimeType = '${FOLDER_MIME}'`;
  do {
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

/** Pasta da edição ausente ou duplicada no Drive: erro de conteúdo, não de credencial. */
export class EditionFolderError extends Error {}

/** A pasta `{AAMMDD}/` dentro da pasta YouTube. Nenhuma ou mais de uma é erro (nunca escolhe sozinho). */
export async function findEditionFolder(deps: MontageDriveDeps, rootFolderId: string, edition: string): Promise<DriveEntry> {
  const found = await listChildren(deps, rootFolderId, { name: edition, foldersOnly: true });
  if (found.length === 0) {
    throw new EditionFolderError(`pasta ${edition}/ não encontrada no Drive (pasta YouTube ${rootFolderId}): o bruto foi enviado? (#11639)`);
  }
  if (found.length > 1) throw new EditionFolderError(`${found.length} pastas ${edition}/ no Drive (${found.map((f) => f.id).join(", ")}): junte ou renomeie`);
  return found[0];
}

/** Metadado atual de um arquivo pelo id (para conferir se o bruto mudou no Drive). */
export async function fetchFileMeta(deps: MontageDriveDeps, id: string): Promise<DriveEntry> {
  const params = new URLSearchParams({ fields: "id,name,mimeType,size,modifiedTime,trashed", supportsAllDrives: "true" });
  const meta = await okJson<DriveEntry & { trashed?: boolean }>(
    await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`, { signal: AbortSignal.timeout(30_000) }),
    `metadado do arquivo ${id} no Drive`,
  );
  if (meta.trashed) throw new Error(`o arquivo ${meta.name} (${id}) está na lixeira do Drive`);
  return meta;
}

const sidecarPath = (localPath: string) => `${localPath}.drive.json`;

function writeSidecar(localPath: string, sidecar: CacheSidecar): void {
  writeFileSync(sidecarPath(localPath), JSON.stringify(sidecar, null, 2) + "\n");
}

function readSidecar(localPath: string): CacheSidecar | null {
  const p = sidecarPath(localPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CacheSidecar;
  } catch {
    return null; // sidecar ilegível = cache sem procedência: confere só pelo tamanho
  }
}

/**
 * Baixa `file` para `{cacheDir}/{nome}` se o cache não for a cópia dele
 * (`cacheState`, #11639). Confere o espaço livre antes (tamanho + 10%,
 * descontado o arquivo velho que vai ser substituído) e escala o teto do
 * download. Grava o sidecar com a procedência ao terminar.
 */
export async function ensureCachedFile(
  deps: MontageDriveDeps,
  file: DriveFileRef,
  cacheDir: string,
  log: (line: string) => void,
  opts: { freeBytes?: (dir: string) => number | null } = {},
): Promise<{ localPath: string; downloaded: boolean; bytes: number }> {
  const localPath = join(cacheDir, file.name);
  const localSize = existsSync(localPath) ? statSync(localPath).size : null;
  const state = cacheState(localSize, readSidecar(localPath), file);
  if (state === "fresh") {
    // Cache de antes do sidecar, conferido pelo tamanho: passa a ter procedência.
    if (!existsSync(sidecarPath(localPath))) writeSidecar(localPath, { id: file.id, size: localSize, modifiedTime: file.modifiedTime ?? null });
    log(`[drive] ${file.name} já no cache (${localPath})`);
    return { localPath, downloaded: false, bytes: localSize ?? 0 };
  }
  if (state === "stale") log(`[drive] ${file.name} no cache não é a versão do Drive (id/modifiedTime/tamanho): baixando de novo`);
  const size = parseDriveSize(file.size);
  mkdirSync(cacheDir, { recursive: true });
  const free = (opts.freeBytes ?? freeBytes)(cacheDir);
  if (free === null) log(`[aviso] espaço livre não medido em ${cacheDir}: baixando sem conferir`);
  if (size === null) log(`[aviso] o Drive não informou o tamanho de ${file.name}: baixando sem conferir o espaço nem o tamanho final`);
  const short = spaceShortfall(free, size);
  if (short) {
    throw new Error(`sem espaço para baixar ${file.name} (${((size ?? 0) / 1e9).toFixed(2)} GB) em ${cacheDir}: ${((free ?? 0) / 1e9).toFixed(2)} GB livres, faltam ${(short / 1e9).toFixed(2)} GB`);
  }
  const budget = downloadBudgetMs(size);
  log(`[drive] baixando ${file.name} (${((size ?? 0) / 1e9).toFixed(2)} GB) para ${localPath} (teto ${Math.round(budget / 60_000)} min)…`);
  const t0 = Date.now();
  const dl: DriveDownloadDeps = { driveFetch: (url, init) => deps.driveFetch(url, init) };
  const bytes = await downloadDriveFile(dl, file, localPath, { downloadMs: budget, idleMs: 60_000 }, log, isAcceptableMediaContentType);
  writeSidecar(localPath, { id: file.id, size: size ?? bytes, modifiedTime: file.modifiedTime ?? null });
  const s = (Date.now() - t0) / 1000;
  log(`[drive] ${file.name}: ${(bytes / 1e9).toFixed(2)} GB em ${s.toFixed(0)} s (${(bytes / 1e6 / Math.max(s, 1)).toFixed(1)} MB/s)`);
  return { localPath, downloaded: true, bytes };
}

/** Um arquivo pelo nome numa pasta (o mais recente quando há vários). */
export async function findByName(
  deps: MontageDriveDeps,
  folderId: string,
  name: string,
): Promise<{ file: null; duplicates: 0 } | { file: DriveEntry; duplicates: number }> {
  const found = (await listChildren(deps, folderId, { name })).filter((f) => f.mimeType !== FOLDER_MIME);
  found.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));
  return found.length === 0 ? { file: null, duplicates: 0 } : { file: found[0], duplicates: found.length - 1 };
}

/** Tentativas do upload (cada uma com sessão nova). */
export const UPLOAD_ATTEMPTS = 3;

/**
 * Sobe `localPath` para a pasta (#11640): atualiza o conteúdo do arquivo de
 * mesmo nome que já esteja lá (sem duplicar) ou cria. Upload resumable em duas
 * chamadas (sessão + conteúdo): serve para a prévia de centenas de MB (o
 * arquivo vai inteiro na memória; as prévias de 720x1280 ficam bem abaixo do
 * limite de Buffer) e para o XML de poucos KB. 5xx, 429 ou falha de rede no
 * PUT abre uma sessão NOVA e reenvia (até `UPLOAD_ATTEMPTS`), cada tentativa
 * com o seu próprio timeout, e antes procura de novo o arquivo pelo nome (o PUT
 * pode ter gravado sem a resposta chegar); outro 4xx é erro na hora.
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
  const found = await findByName(deps, folderId, name);
  if (found.file && found.duplicates) log(`[aviso] ${found.duplicates + 1} arquivos "${name}" na pasta do Drive: atualizando o mais recente (${found.file.id})`);
  let existing = found.file;
  const fields = "id,name,webViewLink";
  const put = deps.uploadFetch ?? deps.driveFetch;
  let lastError = "";
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    // Um PUT que o Drive gravou mas cuja resposta se perdeu já criou o arquivo: a nova tentativa atualiza, não duplica.
    if (attempt > 1 && !existing) existing = (await findByName(deps, folderId, name)).file;
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
    let res: Response;
    try {
      res = await put(location, {
        method: "PUT",
        headers: { "Content-Type": mime },
        body: content,
        signal: AbortSignal.timeout(downloadBudgetMs(content.length, { minMs: 120_000 })),
      });
    } catch (e) {
      lastError = (e as Error).message;
      log(`[aviso] upload de ${name}: tentativa ${attempt}/${UPLOAD_ATTEMPTS} falhou na rede (${lastError})`);
      continue;
    }
    if (res.status >= 500 || res.status === 429) {
      lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      log(`[aviso] upload de ${name}: tentativa ${attempt}/${UPLOAD_ATTEMPTS} recebeu ${res.status}; sessão nova`);
      continue;
    }
    const meta = await okJson<{ id?: string; name?: string; webViewLink?: string }>(res, `upload de ${name} para o Drive`);
    if (!meta.id) throw new Error(`upload de ${name} para o Drive: resposta sem id`);
    return { id: meta.id, name: meta.name ?? name, webViewLink: meta.webViewLink ?? null, updated: Boolean(existing) };
  }
  throw new Error(`upload de ${name} para o Drive falhou ${UPLOAD_ATTEMPTS} vezes (${lastError})`);
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
