/**
 * drive-sync.ts
 *
 * Sincroniza arquivos de edição entre `data/editions/{YYMMDD}/` e
 * `Work/Startups/diar.ia/edicoes/{YYMM}/{YYMMDD}/` no Google Drive.
 *
 * Substitui o subagente `drive-syncer` (Haiku via Task).
 *
 * Uso:
 *   npx tsx scripts/drive-sync.ts \
 *     --mode push|pull \
 *     --edition-dir data/editions/260418/ \
 *     --stage 1 \
 *     --files 01-categorized.md,02-reviewed.md
 *
 * Output (stdout): JSON com { mode, stage, edition, uploaded[], pulled[], warnings[] }
 * Se `--files` for vazio ou não passado, sai com { skipped: true }.
 *
 * Health check (#121):
 *   npx tsx scripts/drive-sync.ts --health-check
 *
 * Roda 1 chamada de listagem mínima pra validar OAuth. Output:
 *   { ok: true, latency_ms: N }       # exit 0
 *   { ok: false, error: ..., ... }    # exit 2 (token expirado/auth falha)
 *
 * Cache: data/drive-cache.json (estrutura documentada em .claude/agents/drive-syncer.md)
 * Credenciais: data/.credentials.json (gerado por scripts/oauth-setup.ts)
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import sharp from "sharp";
import { gFetch } from "./google-auth.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CACHE_PATH = resolve(ROOT, "data", "drive-cache.json");
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface FileEntry {
  drive_file_id: string;
  drive_modifiedTime: string;
  last_pushed_mtime: number;
  push_count: number;
  /** mimeType do arquivo no Drive (#89). Se 'application/vnd.google-apps.document',
   * o arquivo foi convertido pra Doc nativo no push — pull precisa usar /export
   * com mimeType 'text/markdown' pra recuperar. */
  drive_mimeType?: string;
}

/**
 * Whitelist de arquivos MD que viram Google Docs nativos no push (#89).
 * Editor edita no Docs (UI rica, colaborativa), pull converte de volta pra MD.
 *
 * Demais arquivos MD continuam como texto plano no Drive (MD download = MD).
 */
const CONVERT_TO_DOC = new Set<string>([
  "01-categorized.md",
  "02-reviewed.md",
  "03-social.md",
  "01-eia.md",
  "prioritized.md",
  "draft.md",
]);

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

interface EditionCache {
  day_folder_id: string;
  files: Record<string, FileEntry>;
  /** Cache de subpastas dentro do dia (#253). Map subpath → Drive folder ID.
   * Ex: `{"_internal": "abc123..."}`. Permite que arquivos com `/` no
   * filename (ex: `_internal/02-clarice-diff.md`) sejam organizados em
   * subpastas reais no Drive em vez de virarem parte do nome do arquivo. */
  subfolder_ids?: Record<string, string>;
}

interface DriveCache {
  edicoes_folder_id?: string;
  editions: Record<string, EditionCache>;
}

interface UploadedEntry {
  file: string;
  drive_file_id: string;
  title_used: string;
}

interface PulledEntry {
  file: string;
  drive_file_id: string;
  drive_modifiedTime: string;
  overwrote_local: boolean;
}

interface SyncResult {
  mode: string;
  stage: number;
  edition: string;
  day_folder_path: string;
  uploaded: UploadedEntry[];
  pulled: PulledEntry[];
  warnings: Array<{ file: string; error_message: string }>;
  skipped?: boolean;
  skip_reason?: string;
}

// ---------------------------------------------------------------------------
// Retry com backoff exponencial — Drive API sob carga rejeita com 429/5xx
// silenciosamente. gFetch base já trata 401 (refresh token). Aqui adicionamos
// retry pra erros transientes que de outra forma bagunçam o sync (#121).
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;

/** Pure: decide se um status code merece retry. Exportado pra tests. */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Pure: backoff em ms baseado na tentativa (0-indexed). 1s, 2s, 4s + jitter. */
export function backoffMs(attempt: number, randomSource: () => number = Math.random): number {
  const base = 1000 * Math.pow(2, attempt);
  const jitter = randomSource() * 250;
  return base + jitter;
}

async function gFetchRetry(
  url: string,
  options: RequestInit = {},
  attempts = MAX_RETRIES,
): Promise<Response> {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await gFetch(url, options);
      if (!isRetryableStatus(res.status)) return res;
      lastError = new Error(`Drive transient ${res.status}: ${await res.text().catch(() => "(body unread)")}`);
    } catch (err) {
      // Network failures: ECONNRESET, ETIMEDOUT, etc.
      lastError = err;
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, backoffMs(i)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// Drive API helpers
// ---------------------------------------------------------------------------

async function driveList(q: string, fields = "files(id,name,mimeType,modifiedTime,parents)"): Promise<Array<{ id: string; name: string; mimeType: string; modifiedTime: string; parents?: string[] }>> {
  const params = new URLSearchParams({ q, fields, pageSize: "20" });
  const res = await gFetchRetry(`${DRIVE_API}/files?${params}`);
  if (!res.ok) throw new Error(`Drive list error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { files: Array<{ id: string; name: string; mimeType: string; modifiedTime: string; parents?: string[] }> };
  return data.files ?? [];
}

async function driveGetMetadata(fileId: string): Promise<{ id: string; name: string; modifiedTime: string; parents?: string[] }> {
  const res = await gFetchRetry(`${DRIVE_API}/files/${fileId}?fields=id,name,modifiedTime,parents`);
  if (!res.ok) throw new Error(`Drive metadata error (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ id: string; name: string; modifiedTime: string; parents?: string[] }>;
}

async function driveCreateFolder(name: string, parentId: string): Promise<string> {
  const res = await gFetchRetry(`${DRIVE_API}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!res.ok) throw new Error(`Drive createFolder error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { id: string };
  return data.id;
}

function mimeTypeFor(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".md": "text/markdown",
    ".json": "application/json",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
  };
  return map[ext] ?? "application/octet-stream";
}

async function getFileBytes(editionDir: string, filename: string): Promise<Buffer> {
  const localPath = resolve(ROOT, editionDir, filename);
  const ext = extname(filename).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png"].includes(ext);

  if (isImage) {
    // Upload full-size image, just re-encode as JPEG quality 85
    return sharp(readFileSync(localPath))
      .jpeg({ quality: 85 })
      .toBuffer();
  }
  return readFileSync(localPath);
}

async function driveUploadFile(
  name: string,
  content: Buffer,
  mimeType: string,
  parentId: string,
  convertToDoc = false
): Promise<{ id: string; modifiedTime: string; mimeType: string }> {
  // Multipart upload
  //
  // Se convertToDoc=true (#89), setamos o target mimeType no metadata como
  // application/vnd.google-apps.document — Drive trata o upload como markdown
  // (Content-Type do body) e converte pra Doc nativo automaticamente.
  // O mimeType final do arquivo vira Doc, não markdown.
  const targetMimeType = convertToDoc ? GOOGLE_DOC_MIME : mimeType;
  const bodyMimeType = mimeType; // sempre o original (text/markdown) no body
  const metadata: Record<string, unknown> = { name, parents: [parentId] };
  if (convertToDoc) {
    metadata.mimeType = GOOGLE_DOC_MIME;
  }
  const boundary = "diaria_boundary_" + Date.now();
  const metadataPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n`;
  const contentPart =
    `--${boundary}\r\n` +
    `Content-Type: ${bodyMimeType}\r\n\r\n`;
  const closingBoundary = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(metadataPart, "utf8"),
    Buffer.from(contentPart, "utf8"),
    content,
    Buffer.from(closingBoundary, "utf8"),
  ]);

  const res = await gFetchRetry(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime,mimeType`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) throw new Error(`Drive upload error (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { id: string; modifiedTime: string; mimeType?: string };
  return { ...json, mimeType: json.mimeType ?? targetMimeType };
}

/**
 * Atualiza o conteúdo de um arquivo Drive existente in-place (#333).
 * Usa multipart PATCH — mesmo boundary format do upload mas com PATCH method.
 * Para Docs (convertToDoc=true), mantém a conversão MD→Doc passando mimeType
 * no metadata.
 */
async function driveUpdateFile(
  fileId: string,
  content: Buffer,
  mimeType: string,
  convertToDoc = false,
): Promise<{ id: string; modifiedTime: string; mimeType: string }> {
  const targetMimeType = convertToDoc ? GOOGLE_DOC_MIME : mimeType;
  const bodyMimeType = mimeType;
  const metadata: Record<string, unknown> = {};
  if (convertToDoc) metadata.mimeType = GOOGLE_DOC_MIME;

  const boundary = "diaria_update_" + Date.now();
  const metadataPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n`;
  const contentPart =
    `--${boundary}\r\n` +
    `Content-Type: ${bodyMimeType}\r\n\r\n`;
  const closingBoundary = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(metadataPart, "utf8"),
    Buffer.from(contentPart, "utf8"),
    content,
    Buffer.from(closingBoundary, "utf8"),
  ]);

  const res = await gFetchRetry(
    `${DRIVE_UPLOAD}/files/${fileId}?uploadType=multipart&fields=id,modifiedTime,mimeType`,
    {
      method: "PATCH",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) throw new Error(`Drive update error (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { id: string; modifiedTime: string; mimeType?: string };
  return { ...json, mimeType: json.mimeType ?? targetMimeType };
}

async function driveDownloadFile(fileId: string): Promise<Buffer> {
  const res = await gFetchRetry(`${DRIVE_API}/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error(`Drive download error (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Renomeia um arquivo no Drive via PATCH. Usado pelo push pra arquivar a
 * versão anterior antes de subir nova como nome canônico (#37).
 */
async function driveRenameFile(fileId: string, newName: string): Promise<void> {
  const res = await gFetchRetry(`${DRIVE_API}/files/${fileId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) {
    throw new Error(`Drive rename error (${res.status}): ${await res.text()}`);
  }
}

/**
 * Move (e opcionalmente renomeia) um arquivo Drive pra um novo parent folder (#260).
 * Usa query params addParents/removeParents conforme Drive API v3 spec.
 */
async function driveMoveFile(fileId: string, newName: string, newParentId: string, oldParentId: string): Promise<void> {
  const url = `${DRIVE_API}/files/${fileId}?addParents=${encodeURIComponent(newParentId)}&removeParents=${encodeURIComponent(oldParentId)}&fields=id,parents`;
  const res = await gFetchRetry(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) {
    throw new Error(`Drive move error (${res.status}): ${await res.text()}`);
  }
}

/**
 * Exporta um Google Doc nativo como arquivo em outro mimeType (#89).
 * Docs não suportam `?alt=media` — precisam de /export com mimeType target.
 */
async function driveExportFile(fileId: string, exportMimeType: string): Promise<Buffer> {
  const url = `${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`;
  const res = await gFetchRetry(url);
  if (!res.ok) throw new Error(`Drive export error (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function loadCache(): DriveCache {
  if (!existsSync(CACHE_PATH)) return { editions: {} };
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as DriveCache;
  } catch {
    return { editions: {} };
  }
}

function saveCache(cache: DriveCache): void {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Folder resolution
// ---------------------------------------------------------------------------

// Escapa aspas simples em nomes de arquivo/pasta pra uso em queries Drive API (#282).
// Drive API usa SQL-like syntax: aspas simples são escapadas como \\'
export function escapeDriveQueryString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findFolderInParent(name: string, parentId: string): Promise<string | null> {
  const safeName = escapeDriveQueryString(name);
  const files = await driveList(
    `name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`
  );
  return files[0]?.id ?? null;
}

async function findFolderInMyDriveRoot(name: string): Promise<string | null> {
  // Ancora no My Drive do usuário — evita matches em Shared Drives ou compartilhamentos homônimos
  const safeName = escapeDriveQueryString(name);
  const files = await driveList(
    `name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`
  );
  return files[0]?.id ?? null;
}

async function resolveEdicoesFolder(cache: DriveCache): Promise<string> {
  if (cache.edicoes_folder_id) return cache.edicoes_folder_id;

  const workId = await findFolderInMyDriveRoot("Work");
  if (!workId) throw new Error("drive_path_missing:Work — pasta 'Work' não encontrada no root do My Drive");

  const startupsId = await findFolderInParent("Startups", workId);
  if (!startupsId) throw new Error("drive_path_missing:Startups — pasta 'Startups' não encontrada em Work");

  const diaria = await findFolderInParent("diar.ia", startupsId);
  if (!diaria) throw new Error("drive_path_missing:diar.ia — pasta 'diar.ia' não encontrada em Startups");

  const edicoes = await findFolderInParent("edicoes", diaria);
  if (!edicoes) throw new Error("drive_path_missing:edicoes — pasta 'edicoes' não encontrada em diar.ia");

  cache.edicoes_folder_id = edicoes;
  return edicoes;
}

/**
 * Pure: separa um filename relativo em `{ subpath, basename }`. Suporta
 * múltiplos níveis (`a/b/c.md` → subpath=`a/b`, basename=`c.md`). Sem `/`
 * no filename retorna subpath vazio. Exportado pra testes (#253).
 */
export function splitFilePath(filename: string): { subpath: string; basename: string } {
  const norm = filename.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx === -1) return { subpath: "", basename: norm };
  return { subpath: norm.slice(0, idx), basename: norm.slice(idx + 1) };
}

export async function resolveSubfolder(
  cache: DriveCache,
  yymmdd: string,
  dayFolderId: string,
  subpath: string
): Promise<string> {
  const edCache = cache.editions[yymmdd];
  if (!edCache) throw new Error(`edition cache missing for ${yymmdd}`);
  edCache.subfolder_ids ??= {};
  if (edCache.subfolder_ids[subpath]) return edCache.subfolder_ids[subpath];

  // Cria recursivamente cada segmento (`a/b/c` → cria `a`, depois `b` em `a`, etc.)
  // Cache também os parents intermediários pra reuso entre arquivos da mesma edição.
  const segments = subpath.split("/").filter(Boolean);
  let currentParent = dayFolderId;
  let accumulated = "";
  for (const seg of segments) {
    accumulated = accumulated ? `${accumulated}/${seg}` : seg;
    const cached = edCache.subfolder_ids[accumulated];
    if (cached) {
      currentParent = cached;
      continue;
    }
    let folder = await findFolderInParent(seg, currentParent);
    if (!folder) folder = await driveCreateFolder(seg, currentParent);
    edCache.subfolder_ids[accumulated] = folder;
    currentParent = folder;
  }
  return currentParent;
}

async function resolveDayFolder(
  cache: DriveCache,
  yymmdd: string,
  edicoesId: string,
  isMonthly = false
): Promise<string> {
  const yymm = yymmdd.slice(0, 4);
  const edCache = (cache.editions[yymmdd] ??= { day_folder_id: "", files: {} });
  if (edCache.day_folder_id) return edCache.day_folder_id;

  // Resolver ou criar pasta YYMM
  let yymmFolder = await findFolderInParent(yymm, edicoesId);
  if (!yymmFolder) yymmFolder = await driveCreateFolder(yymm, edicoesId);

  // Resolver ou criar pasta YYMMDD (ou "mensal" para edições mensais)
  const dayFolderName = isMonthly ? "mensal" : yymmdd;
  let dayFolder = await findFolderInParent(dayFolderName, yymmFolder);
  if (!dayFolder) dayFolder = await driveCreateFolder(dayFolderName, yymmFolder);

  edCache.day_folder_id = dayFolder;
  return dayFolder;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

async function pushFile(
  editionDir: string,
  filename: string,
  yymmdd: string,
  dayFolderId: string,
  cache: DriveCache,
  result: SyncResult
): Promise<void> {
  const edCache = cache.editions[yymmdd];
  const fileCache = edCache.files[filename];
  const pushCount = fileCache?.push_count ?? 0;

  // #253: filename pode incluir subpath (ex: `_internal/02-clauce-diff.md`).
  // Antes ia direto como nome do arquivo no dayFolder com `/` literal — Drive
  // aceita mas vira poluição visual na pasta do dia. Agora resolve subpath em
  // subpasta real, e usa só o basename como nome do arquivo no Drive.
  const { subpath, basename } = splitFilePath(filename);

  // #280: detectar migração de legacy slash-literal → subpasta real.
  // Se cache tem drive_file_id (arquivo antigo com nome literal `_internal/foo.md`)
  // E agora há subpath (nova convenção de subpasta), o archive do arquivo antigo
  // vai pra posição errada — logar warn pra editor limpar o órfão no Drive.
  if (subpath && pushCount > 0 && fileCache?.drive_file_id) {
    const edCache = cache.editions[yymmdd];
    const hasSubfolderEntry = edCache?.subfolder_ids?.[subpath];
    if (!hasSubfolderEntry) {
      result.warnings.push({
        file: filename,
        error_message: `migração legacy: arquivo '${filename}' tinha drive_file_id no cache mas sem subpasta '${subpath}' registrada — arquivo antigo com '/' literal no nome pode existir na pasta do dia. Limpar manualmente no Drive se necessário.`,
      });
    }
  }

  const targetParentId = subpath
    ? await resolveSubfolder(cache, yymmdd, dayFolderId, subpath)
    : dayFolderId;

  const ext = extname(basename);
  const base = basename.slice(0, basename.length - ext.length);
  // CONVERT_TO_DOC contém só basenames (top-level files do dia). Subpasta
  // raramente vai conter MD que vira Doc, mas a lookup por basename é
  // consistente com o modelo "Doc é editorial, Tools/_internal é raw".
  const convertToDoc = CONVERT_TO_DOC.has(basename);
  // Docs nativos não precisam de extensão — Drive trata extension como cosmético.
  // Pra arquivos convertidos, tiramos `.md` do título pra ficar consistente com
  // o modelo "arquivo sem extensão = Doc".
  //
  // Estratégia (#37): o nome canônico (sem `.vN`) sempre aponta para a versão
  // mais recente. Versões anteriores ficam arquivadas como `.vN`. Editor abre o
  // arquivo canônico no Drive sem ter que procurar o maior N.
  const canonicalTitle = convertToDoc ? base : basename;
  const archiveTitle = convertToDoc
    ? `${base}.v${pushCount}`
    : `${base}.v${pushCount}${ext}`;
  const mimeType = mimeTypeFor(basename);

  const bytes = await getFileBytes(editionDir, filename);

  // Se arquivo já existe no Drive (cache tem drive_file_id válido), atualizar
  // in-place (#333) em vez de criar novo. Evita .vN orphans na pasta do editor.
  if (pushCount > 0 && fileCache?.drive_file_id) {
    try {
      const { id: driveFileId, modifiedTime, mimeType: driveMimeType } = await driveUpdateFile(
        fileCache.drive_file_id,
        bytes,
        mimeType,
        convertToDoc,
      );
      const localPath = resolve(ROOT, editionDir, filename);
      const localMtime = statSync(localPath).mtimeMs;
      edCache.files[filename] = {
        drive_file_id: driveFileId,
        drive_modifiedTime: modifiedTime,
        last_pushed_mtime: localMtime,
        push_count: pushCount + 1,
        drive_mimeType: driveMimeType,
      };
      result.uploaded.push({ file: filename, drive_file_id: driveFileId, title_used: canonicalTitle + " (updated in-place)" });
      return;
    } catch (updateErr) {
      // Fallback: arquivo pode ter sido deletado no Drive — criar novo normalmente
      const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      result.warnings.push({
        file: filename,
        error_message: `update_in_place_failed: ${canonicalTitle} (${msg}) — criando novo arquivo`,
      });
    }
  }

  // Antes de criar novo arquivo, buscar por nome na pasta destino para evitar
  // duplicatas (#362 #370). Isso acontece quando o cache está divergente (ID
  // inválido, arquivo movido, cache corrompido) e o update in-place falhou.
  const searchQ = `name='${escapeDriveQueryString(canonicalTitle)}' and '${targetParentId}' in parents and trashed=false`;
  const searchRes = await gFetchRetry(
    `${DRIVE_API}/files?q=${encodeURIComponent(searchQ)}&fields=files(id,name,modifiedTime)`,
    { headers: { "Content-Type": "application/json" } }
  );
  const searchData = (await searchRes.json()) as { files?: Array<{ id: string; name: string; modifiedTime: string }> };
  const existingFiles = searchData.files ?? [];
  if (existingFiles.length > 0) {
    console.error(
      `[drive-sync] WARN: encontrou ${existingFiles.length} arquivo(s) com mesmo nome '${canonicalTitle}' — apagou antes de criar novo (cache divergente).`
    );
    for (const existing of existingFiles) {
      console.error(`[drive-sync] Apagando duplicata anterior: ${existing.name} (${existing.id})`);
      await gFetchRetry(`${DRIVE_API}/files/${existing.id}`, { method: "DELETE" });
    }
  }

  const { id: driveFileId, modifiedTime, mimeType: driveMimeType } = await driveUploadFile(
    canonicalTitle,
    bytes,
    mimeType,
    targetParentId,
    convertToDoc
  );

  const localPath = resolve(ROOT, editionDir, filename);
  const localMtime = statSync(localPath).mtimeMs;

  edCache.files[filename] = {
    drive_file_id: driveFileId,
    drive_modifiedTime: modifiedTime,
    last_pushed_mtime: localMtime,
    push_count: pushCount + 1,
    drive_mimeType: driveMimeType,
  };

  result.uploaded.push({ file: filename, drive_file_id: driveFileId, title_used: canonicalTitle });
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

async function pullFile(
  editionDir: string,
  filename: string,
  yymmdd: string,
  cache: DriveCache,
  result: SyncResult
): Promise<void> {
  const fileCache = cache.editions[yymmdd]?.files?.[filename];
  if (!fileCache?.drive_file_id) return; // nunca foi subido → pular sem erro

  const meta = await driveGetMetadata(fileCache.drive_file_id);
  const driveModified = meta.modifiedTime;

  // No-op se não mudou no Drive
  if (driveModified <= fileCache.drive_modifiedTime) return;

  // #89: se arquivo foi convertido pra Doc nativo no push, pull faz export
  // pra text/markdown em vez de download binário (alt=media retorna 403 pra Docs).
  const isGoogleDoc = fileCache.drive_mimeType === GOOGLE_DOC_MIME;
  const bytes = isGoogleDoc
    ? await driveExportFile(fileCache.drive_file_id, "text/markdown")
    : await driveDownloadFile(fileCache.drive_file_id);

  const localPath = resolve(ROOT, editionDir, filename);
  const dir = resolve(ROOT, editionDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(localPath, bytes);

  const newMtime = statSync(localPath).mtimeMs;
  cache.editions[yymmdd].files[filename] = {
    ...fileCache,
    drive_modifiedTime: driveModified,
    last_pushed_mtime: newMtime,
  };

  result.pulled.push({
    file: filename,
    drive_file_id: fileCache.drive_file_id,
    drive_modifiedTime: driveModified,
    overwrote_local: true,
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Health check — chamada Drive API mínima pra validar OAuth (#121).
 * Lista 1 arquivo qualquer no root. Sucesso = token válido. Falha
 * com 401/403 = re-autenticar.
 */
async function healthCheck(): Promise<void> {
  const t0 = Date.now();
  try {
    await driveList("'root' in parents and trashed = false", "files(id,name)");
    const dt = Date.now() - t0;
    console.log(JSON.stringify({ ok: true, latency_ms: dt }, null, 2));
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: msg,
          remediation: "Token OAuth pode estar expirado. Rode: npx tsx scripts/oauth-setup.ts",
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string) => args[args.indexOf(flag) + 1] ?? "";

  // Health check mode — independent of edition/files (#121).
  if (args.includes("--health-check")) {
    await healthCheck();
    return;
  }

  const mode = get("--mode");
  const editionDir = get("--edition-dir");
  const stage = parseInt(get("--stage") || "0", 10);
  const filesStr = get("--files");

  if (!mode || !editionDir) {
    console.error(
      "Usage: drive-sync.ts --mode push|pull --edition-dir data/editions/YYMMDD/ --stage N --files file1.md,file2.jpg\n" +
        "Or: drive-sync.ts --health-check"
    );
    process.exit(1);
  }

  const files = filesStr ? filesStr.split(",").map((f) => f.trim()).filter(Boolean) : [];
  const yymmdd = editionDir.replace(/\/$/, "").split("/").pop() ?? "";

  const result: SyncResult = {
    mode,
    stage,
    edition: yymmdd,
    day_folder_path: `Work/Startups/diar.ia/edicoes/${yymmdd.slice(0, 4)}/${editionDir.includes("/monthly/") ? "mensal" : yymmdd}`,
    uploaded: [],
    pulled: [],
    warnings: [],
  };

  if (files.length === 0) {
    result.skipped = true;
    result.skip_reason = "no_files";
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const cache = loadCache();

  try {
    const edicoesId = await resolveEdicoesFolder(cache);
    const isMonthly = editionDir.includes("/monthly/");
    const dayFolderId = await resolveDayFolder(cache, yymmdd, edicoesId, isMonthly);

    for (const filename of files) {
      try {
        const localPath = resolve(ROOT, editionDir, filename);
        if (!existsSync(localPath) && mode === "push") {
          result.warnings.push({ file: filename, error_message: "arquivo local não encontrado" });
          continue;
        }

        if (mode === "push") {
          await pushFile(editionDir, filename, yymmdd, dayFolderId, cache, result);
        } else {
          await pullFile(editionDir, filename, yymmdd, cache, result);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.warnings.push({ file: filename, error_message: msg });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.warnings.push({ file: "(global)", error_message: msg });
  } finally {
    saveCache(cache);
  }

  // Observabilidade: quando há warnings, gravar evento estruturado em
  // run-log.jsonl. O orchestrator não trava o pipeline (warnings nunca
  // bloqueiam — princípio existente), mas /diaria-log mostra a falha
  // pro editor reagir. Endereça #121: silent push failures viravam
  // invisíveis sem essa trilha.
  if (result.warnings.length > 0) {
    logSyncWarnings(result);
  }

  console.log(JSON.stringify(result, null, 2));
}

function logSyncWarnings(result: SyncResult): void {
  try {
    const cfgPath = resolve(ROOT, "platform.config.json");
    let logPath = resolve(ROOT, "data/run-log.jsonl");
    if (existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { logging?: { path?: string } };
        if (cfg?.logging?.path) logPath = resolve(ROOT, cfg.logging.path);
      } catch {
        // ignore — fallback ao default
      }
    }
    mkdirSync(dirname(logPath), { recursive: true });
    const event = {
      timestamp: new Date().toISOString(),
      edition: result.edition,
      stage: result.stage,
      agent: "drive-sync",
      level: "warn",
      message: `${result.warnings.length} sync warning(s) em ${result.mode} (Stage ${result.stage})`,
      details: {
        mode: result.mode,
        warnings: result.warnings,
        uploaded_count: result.uploaded.length,
        pulled_count: result.pulled.length,
      },
    };
    appendFileSync(logPath, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // logging nunca pode mascarar o erro original
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((err) => {
    console.error("drive-sync fatal:", err.message);
    process.exit(1);
  });
}
