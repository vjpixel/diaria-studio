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

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, extname, dirname, basename as pathBasename } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { gFetch } from "./google-auth.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts"; // #535
import {
  parseDriveFileMetadata,
  parseDriveFileUploadResponse,
} from "./lib/schemas/drive-api.ts"; // #649
import { logEvent } from "./lib/run-log.ts"; // #612
import type { DriveCache, FileEntry, EditionCache } from "./lib/schemas/drive-cache.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CACHE_PATH = resolve(ROOT, "data", "drive-cache.json");
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

// ---------------------------------------------------------------------------
// Tipos locais (não existem em drive-cache.ts)
// ---------------------------------------------------------------------------

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

export interface SyncResult {
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

// Re-export types imported from schema so test imports remain unchanged
export type { DriveCache, FileEntry, EditionCache };

/**
 * Whitelist de arquivos MD que viram Google Docs nativos no push (#89).
 * Editor edita no Docs (UI rica, colaborativa), pull converte de volta pra MD.
 *
 * Demais arquivos MD continuam como texto plano no Drive (MD download = MD).
 */
export const CONVERT_TO_DOC = new Set<string>([
  "01-categorized.md",
  "02-reviewed.md",
  "03-social.md",
  "01-eia.md",
  "prioritized.md",
  "draft.md",
]);

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

// ---------------------------------------------------------------------------
// Retry com backoff exponencial — Drive API sob carga rejeita com 429/5xx
// silenciosamente. gFetch base já trata 401 (refresh token). Aqui adicionamos
// retry pra erros transientes que de outra forma bagunçam o sync (#121).
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;

/**
 * Tolerância em segundos pra ignorar conflicts falso-positivos causados pela
 * auto-conversão Google Doc após push (#605). Auto-conversion bumpa o
 * `modifiedTime` ~1-2s mesmo sem edit humano — sem tolerância, todo push
 * subsequente vira CONFLICT falso.
 *
 * Override via platform.config.json `drive_sync_conflict_tolerance_seconds`.
 * Default 10s — pega auto-conversion (~1-2s) com folga, ainda detecta edits
 * reais do editor (segundos a minutos depois).
 *
 * Exportado pra tests (#629) — recebe configPath pra permitir override em testes.
 */
export function loadConflictToleranceSeconds(configPath: string): number {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const val = cfg.drive_sync_conflict_tolerance_seconds;
    if (typeof val === "number" && val >= 0) return val;
  } catch {
    /* fallthrough to default */
  }
  return 10;
}

const CONFLICT_TOLERANCE_SECONDS = loadConflictToleranceSeconds(
  resolve(ROOT, "platform.config.json"),
);

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
  // #649 (#496): valida modifiedTime parseable antes de comparações de timestamp
  return parseDriveFileMetadata(await res.json());
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
  // #649 (#496): valida shape da response — id+modifiedTime parseable
  const parsed = parseDriveFileUploadResponse(await res.json());
  return { ...parsed, mimeType: parsed.mimeType ?? targetMimeType };
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
  // #649 (#496): valida shape da response do PATCH
  const parsed = parseDriveFileUploadResponse(await res.json());
  return { ...parsed, mimeType: parsed.mimeType ?? targetMimeType };
}

async function driveDownloadFile(fileId: string): Promise<Buffer> {
  const res = await gFetchRetry(`${DRIVE_API}/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error(`Drive download error (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// 3-way merge helpers (#963)
// ---------------------------------------------------------------------------

/**
 * #963: Path do snapshot pre-push pra um arquivo. Snapshot é copy do conteúdo
 * que foi pushed por último (base do 3-way merge se conflito for detectado).
 *
 * Convenção: `_internal/.drive-snapshots/{filename}`. Subpath gitignorado por
 * `_internal/`. Snapshot só faz sentido pra arquivos texto (md); binários
 * usam force-overwrite-on-conflict (não mergeáveis line-by-line).
 */
export function snapshotPath(editionDir: string, filename: string): string {
  return resolve(editionDir, "_internal", ".drive-snapshots", filename);
}

/**
 * #963: Tenta 3-way merge via `git merge-file --diff3 -p` (git existe na CI
 * e em qualquer dev env do projeto). Returns merged content + flag de conflito.
 *
 * Args:
 *   localContent: o que o pipeline tem agora (será o "ours")
 *   baseContent:  o último push bem-sucedido (base do 3-way)
 *   remoteContent: conteúdo atual do Drive (será o "theirs")
 *
 * Estratégia: cria 3 arquivos tmp, roda git merge-file, lê output.
 * Exit 0 = clean merge; Exit > 0 = N conflitos (cada um marker `<<<<<<<`).
 *
 * Pure quanto possível — testes mockam via input strings, não Drive.
 */
export function attemptThreeWayMerge(
  localContent: string,
  baseContent: string,
  remoteContent: string,
): { merged: string; hasConflicts: boolean; conflictCount: number } {
  const tmp = tmpdir();
  const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const localTmp = resolve(tmp, `merge-local-${stamp}`);
  const baseTmp = resolve(tmp, `merge-base-${stamp}`);
  const remoteTmp = resolve(tmp, `merge-remote-${stamp}`);
  try {
    writeFileSync(localTmp, localContent, "utf8");
    writeFileSync(baseTmp, baseContent, "utf8");
    writeFileSync(remoteTmp, remoteContent, "utf8");
    // -p envia output pra stdout; --diff3 inclui base nos conflict markers.
    // Labels deixam claro qual era qual no marker (--- BASE / +++ DRIVE etc).
    const r = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        "--diff3",
        "-L", "local",
        "-L", "base",
        "-L", "drive",
        localTmp,
        baseTmp,
        remoteTmp,
      ],
      { encoding: "utf8" },
    );
    // git merge-file: exit 0 = clean, exit N (N>0) = N conflitos. Exit < 0 = error.
    const status = r.status ?? -1;
    const merged = r.stdout ?? "";
    return {
      merged,
      hasConflicts: status !== 0,
      conflictCount: status > 0 ? status : 0,
    };
  } finally {
    for (const p of [localTmp, baseTmp, remoteTmp]) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * #963: Salva snapshot do conteúdo recém-pushed. Usado como base do 3-way
 * merge na próxima detecção de conflito. Best-effort — falha de IO loga
 * warning mas não bloqueia push.
 */
export function savePrePushSnapshot(
  editionDir: string,
  filename: string,
  content: string | Buffer,
): void {
  // Snapshot só pra texto. Binário (jpg, png) não mergeia bem.
  if (Buffer.isBuffer(content)) {
    const ext = extname(filename).toLowerCase();
    if (ext !== ".md" && ext !== ".txt" && ext !== ".json") return;
  }
  const path = snapshotPath(editionDir, filename);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const text = typeof content === "string" ? content : content.toString("utf8");
    writeFileSync(path, text, "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * #963: Carrega snapshot pre-push se existir. Retorna null quando ausente
 * (caso primeiro push após implementação — sem base 3-way disponível).
 */
export function loadPrePushSnapshot(
  editionDir: string,
  filename: string,
): string | null {
  const path = snapshotPath(editionDir, filename);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
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
 * #998: Máximo de versões `.vN` mantidas por arquivo. Após cada archive,
 * cleanup deleta as versões mais antigas (lowest N) acima desse limite. 3
 * é compromisso entre histórico útil (editor pode revert algumas vezes) e
 * pasta limpa (não acumula 50+ versões em edição com muitos pushes).
 */
export const MAX_ARCHIVES_PER_FILE = 3;

/**
 * #998: Lista arquivos Drive matching `${base}.v*${ext}` no parent indicado e
 * retorna ordenados por número da versão (asc). Usado pelo cleanup pra detectar
 * versões mais antigas e deletar excedente.
 *
 * Pure-ish — depende de `gFetchRetry` mas não muta state. Exported pra testes.
 */
export async function listVersionArchives(
  base: string,
  ext: string,
  convertToDoc: boolean,
  parentId: string,
): Promise<Array<{ id: string; name: string; version: number }>> {
  // Match `{base}.vN{ext}` (ex: 02-reviewed.v1.md) ou `{base}.vN` (Doc native).
  // Drive query não suporta regex — listamos todos com prefix `{base}.v` e
  // parseamos cliente-side.
  const escapedBase = escapeDriveQueryString(`${base}.v`);
  const q = `name contains '${escapedBase}' and '${parentId}' in parents and trashed=false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=100`;
  const res = await gFetchRetry(url);
  if (!res.ok) throw new Error(`Drive list error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { files?: Array<{ id: string; name: string }> };
  const files = data.files ?? [];
  const expected = convertToDoc
    ? new RegExp(`^${escapeRegex(base)}\\.v(\\d+)$`)
    : new RegExp(`^${escapeRegex(base)}\\.v(\\d+)${escapeRegex(ext)}$`);
  const archives: Array<{ id: string; name: string; version: number }> = [];
  for (const f of files) {
    const m = f.name.match(expected);
    if (!m) continue;
    archives.push({ id: f.id, name: f.name, version: parseInt(m[1], 10) });
  }
  archives.sort((a, b) => a.version - b.version);
  return archives;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * #998: Deleta arquivos `.vN` excedentes (mantém últimas MAX_ARCHIVES_PER_FILE).
 * Best-effort: falhas em deletes individuais são logadas mas não bloqueiam.
 */
async function cleanupOldArchives(
  base: string,
  ext: string,
  convertToDoc: boolean,
  parentId: string,
  result: SyncResult,
  filename: string,
): Promise<void> {
  const archives = await listVersionArchives(base, ext, convertToDoc, parentId);
  if (archives.length <= MAX_ARCHIVES_PER_FILE) return;
  const toDelete = archives.slice(0, archives.length - MAX_ARCHIVES_PER_FILE);
  for (const a of toDelete) {
    try {
      const r = await gFetchRetry(`${DRIVE_API}/files/${a.id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) {
        throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      }
      console.error(`[drive-sync] cleanup: deleted old archive ${a.name} (${a.id})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push({
        file: filename,
        error_message: `archive_cleanup_delete_failed (#998): ${a.name} (${msg})`,
      });
    }
  }
}

/**
 * #998: Copia um arquivo Drive pra outro nome no mesmo parent. Usado pra
 * arquivar versão anterior antes de update in-place (strategy #37). Retorna
 * o ID do novo arquivo (clone).
 */
export async function driveCopyFile(
  fileId: string,
  newName: string,
  parentId: string,
): Promise<{ id: string; modifiedTime: string }> {
  const res = await gFetchRetry(
    `${DRIVE_API}/files/${fileId}/copy?fields=id,modifiedTime`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, parents: [parentId] }),
    },
  );
  if (!res.ok) {
    throw new Error(`Drive copy error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { id?: string; modifiedTime?: string };
  if (!data.id) throw new Error("Drive copy: response sem id");
  return { id: data.id, modifiedTime: data.modifiedTime ?? new Date().toISOString() };
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

export type ConflictMode = "warn" | "pull-merge" | "force";

export interface PushFileOpts {
  /** #963: comportamento em caso de CONFLICT (Drive modified após último push).
   * - "warn" (default): aborta com warning (compat com behavior original)
   * - "pull-merge": tenta 3-way merge via git merge-file --diff3
   * - "force": sobrescreve sem checagem (perigoso)
   */
  onConflict?: ConflictMode;
}

export async function pushFile(
  editionDir: string,
  filename: string,
  yymmdd: string,
  dayFolderId: string,
  cache: DriveCache,
  result: SyncResult,
  opts: PushFileOpts = {},
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

  // #496: verificar se Drive foi modificado externamente após último push
  // #605: tolerância pra auto-conversão Google Doc (bumpa modifiedTime ~1-2s
  //       sem edit humano). Default 10s; override em platform.config.json
  //       (drive_sync_conflict_tolerance_seconds).
  // #963: quando opts.onConflict === "pull-merge", tenta 3-way merge antes de abortar.
  if (fileCache?.drive_file_id && fileCache?.drive_modifiedTime) {
    const meta = await driveGetMetadata(fileCache.drive_file_id);
    const cachedMs = new Date(fileCache.drive_modifiedTime).getTime();
    const driveMs = new Date(meta.modifiedTime).getTime();
    const diffSec = (driveMs - cachedMs) / 1000;
    const toleranceSec = CONFLICT_TOLERANCE_SECONDS;
    if (diffSec > toleranceSec) {
      // Conflito detectado — comportamento varia por --on-conflict:
      //   - "pull-merge" (#963): tenta 3-way merge via git merge-file --diff3
      //   - "warn" (default, compat): aborta push com warning (comportamento original)
      //   - "force": pula check, sobrescreve Drive sem 3-way (perigoso)
      const ext = extname(filename).toLowerCase();
      const isMergeable = ext === ".md" || ext === ".txt" || ext === ".json";
      if (opts.onConflict === "pull-merge" && isMergeable) {
        const baseSnapshot = loadPrePushSnapshot(editionDir, filename);
        if (!baseSnapshot) {
          result.warnings.push({
            file: filename,
            error_message: `CONFLICT: ${filename} foi modificado no Drive mas não há snapshot pre-push pra 3-way merge. Push abortado — fazer pull manual primeiro. (Próximo push terá snapshot disponível.)`,
          });
          return;
        }
        // Pull current Drive content + read local content
        let driveContent: string;
        try {
          const driveBuf = await driveDownloadFile(fileCache.drive_file_id);
          driveContent = driveBuf.toString("utf8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.warnings.push({
            file: filename,
            error_message: `CONFLICT: ${filename} pull pra 3-way merge falhou (${msg}). Push abortado.`,
          });
          return;
        }
        const localPath = resolve(ROOT, editionDir, filename);
        const localContent = readFileSync(localPath, "utf8");
        const merge = attemptThreeWayMerge(localContent, baseSnapshot, driveContent);
        if (merge.hasConflicts) {
          // Conflito de mesma região — escreve resultado com markers no local +
          // halt. Editor resolve manualmente, depois re-roda pipeline.
          writeFileSync(localPath, merge.merged, "utf8");
          result.warnings.push({
            file: filename,
            error_message: `CONFLICT: ${filename} 3-way merge tem ${merge.conflictCount} conflito(s) na mesma região. Markers <<<<<<< escritos em ${localPath}. Editor: resolver conflitos manualmente e re-rodar drive-sync (push).`,
          });
          return;
        }
        // Clean merge: substituir local pelo merged + atualizar mtime + seguir push.
        writeFileSync(localPath, merge.merged, "utf8");
        // Snapshot atualizado já reflete o merged na próxima iteração — saved no fim do push.
      } else if (opts.onConflict === "force") {
        // Sobrescreve sem 3-way. Documenta no warning pra trail editorial saber que aconteceu.
        result.warnings.push({
          file: filename,
          error_message: `FORCE_OVERWRITE: ${filename} Drive modificado externamente (${meta.modifiedTime}) mas --on-conflict=force passou — sobrescrevendo.`,
        });
      } else {
        result.warnings.push({
          file: filename,
          error_message: `CONFLICT: ${filename} foi modificado no Drive (${meta.modifiedTime}) após o último push (${fileCache.drive_modifiedTime}). Push abortado — fazer pull primeiro para não sobrescrever edições do editor.`,
        });
        return; // não sobrescrever
      }
    }
    if (diffSec > 0 && diffSec <= toleranceSec) {
      // Dentro da tolerância — auto-conversion noise. Atualiza cache silenciosamente.
      fileCache.drive_modifiedTime = meta.modifiedTime;
    }
  }

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
  // #998: ANTES do PATCH, copiar versão atual pra `.vN` (strategy #37 — versionamento).
  // Editor pode comparar histórico no Drive sem perder edições anteriores.
  if (pushCount > 0 && fileCache?.drive_file_id) {
    // #998: archive current → .vN antes de overwrite. Best-effort: falha não bloqueia.
    try {
      const archiveResult = await driveCopyFile(
        fileCache.drive_file_id,
        archiveTitle,
        targetParentId,
      );
      console.error(
        `[drive-sync] archived previous version: ${canonicalTitle} → ${archiveTitle} (${archiveResult.id})`,
      );
    } catch (archiveErr) {
      const msg = archiveErr instanceof Error ? archiveErr.message : String(archiveErr);
      result.warnings.push({
        file: filename,
        error_message: `archive_failed (#998): ${msg} — continuando com PATCH in-place (sem versão histórica)`,
      });
    }
    // #998: cleanup arquivos antigos (manter últimas MAX_ARCHIVES versões).
    try {
      await cleanupOldArchives(base, ext, convertToDoc, targetParentId, result, filename);
    } catch (cleanupErr) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      result.warnings.push({
        file: filename,
        error_message: `archive_cleanup_failed (#998): ${msg}`,
      });
    }
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
      // #963: snapshot pre-push pra próxima detecção de conflito usar como base 3-way.
      savePrePushSnapshot(editionDir, filename, bytes);
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
  // #963: snapshot pre-push pra próxima detecção de conflito usar como base 3-way.
  savePrePushSnapshot(editionDir, filename, bytes);
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export async function pullFile(
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
  const { flags, values } = parseCliArgs(args); // #535: fix indexOf+1 bug

  // Health check mode — independent of edition/files (#121).
  if (flags.has("health-check")) {
    await healthCheck();
    return;
  }

  const mode = values["mode"] ?? "";
  const editionDir = values["edition-dir"] ?? "";
  const stage = parseInt(values["stage"] ?? "0", 10);
  const filesStr = values["files"] ?? "";
  // #963: --on-conflict pull-merge|warn|force. Default mantém compat ("warn").
  const onConflictRaw = values["on-conflict"] ?? "warn";
  const onConflict: ConflictMode = (
    ["warn", "pull-merge", "force"].includes(onConflictRaw) ? onConflictRaw : "warn"
  ) as ConflictMode;

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
          await pushFile(editionDir, filename, yymmdd, dayFolderId, cache, result, { onConflict });
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

  // #977: opt-in fail-on-warning. Default mantém exit 0 mesmo com warnings
  // (compatibilidade com chamadas existentes). Quando flag ligada:
  //   --fail-on-warning           exit 2 se há QUALQUER warning
  //   --fail-on-conflict          exit 2 só se há warning de CONFLICT
  // Conflito do editor (#496/#605/#963) é categoria especial: indica que
  // o Drive tem edições do editor que o pipeline não pegou — orchestrator
  // precisa pular pra modo halt em vez de seguir achando que push deu certo.
  if (result.warnings.length > 0) {
    const failOnWarning = flags.has("fail-on-warning");
    const failOnConflict = flags.has("fail-on-conflict");
    const hasConflict = result.warnings.some((w) =>
      w.error_message.startsWith("CONFLICT:"),
    );
    if (failOnWarning || (failOnConflict && hasConflict)) {
      process.exit(2);
    }
  }
}

function logSyncWarnings(result: SyncResult): void {
  // #612: delega pra scripts/lib/run-log.ts. logEvent já encapsula resolve do
  // path (config + fallback) e swallow de exceções.
  logEvent({
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
  }, ROOT);
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
