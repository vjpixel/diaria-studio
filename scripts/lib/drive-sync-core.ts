/**
 * lib/drive-sync-core.ts (#2833)
 *
 * Cliente Drive de baixo nivel (upload/update/download/copy/move/export),
 * cache local (data/drive-cache.json), 3-way merge de conflitos (#963),
 * arquivamento de versoes (.vN, #998) e resolucao de pastas (edicoes/YYMM/
 * YYMMDD). Tudo que scripts/drive-sync.ts precisa ANTES de decidir o que
 * fazer com um arquivo especifico — a orquestracao push/pull fica no
 * arquivo raiz.
 *
 * Extraido de scripts/drive-sync.ts — movimentacao pura, sem mudanca de
 * comportamento (exceto ROOT, que precisou de um ".." a mais por este
 * arquivo agora morar em scripts/lib/ em vez de scripts/). drive-sync.ts
 * re-exporta esses simbolos pra manter compat com importadores existentes.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { classifyRefreshError } from "../google-auth.ts";
import { DRIVE_API, DRIVE_UPLOAD } from "./drive-constants.ts"; // #1308 item 1
import {
  gFetchRetry,
  escapeDriveQueryString,
  driveCreateFolder,
  driveFindFolderInParent,
  driveFindFolderInRoot,
  buildMultipartBody,
} from "./drive-helpers.ts"; // #1308 itens 2, 4
import {
  parseDriveFileMetadata,
  parseDriveFileUploadResponse,
} from "./schemas/drive-api.ts"; // #649
import type { DriveCache, FileEntry, EditionCache } from "./schemas/drive-cache.ts";

// import.meta.dirname aqui é scripts/lib/ — repo root fica 2 níveis acima
// (drive-sync.ts original, em scripts/, usava só 1 "..").
export const ROOT = resolve(import.meta.dirname, "..", "..");

export const CACHE_PATH = resolve(ROOT, "data", "drive-cache.json");

// ---------------------------------------------------------------------------
// OAuth error detection (#2318) — dedup invalid_grant em alerta único
// ---------------------------------------------------------------------------

/**
 * Pure (#2318): detecta se uma mensagem de erro de Drive/OAuth indica um token
 * expirado/revogado — distinto de erros transientes (rede, 5xx) que podem
 * resolver sem re-auth.
 *
 * Delega pra `classifyRefreshError` em `google-auth.ts`, que cobre a amplitude
 * completa de variantes Google: `invalid_grant`, `UNAUTHENTICATED`,
 * `token has been expired or revoked`, `unauthorized`, `invalid_token`
 * (#2318/#1973 — alinhado com inbox-drain.ts::isAuthExpiredError).
 *
 * Nota: o gFetch base já tentou um refresh forçado em caso de 401 antes de
 * propagar — se chegou aqui, o refresh TAMBÉM falhou.
 */
export function classifyOAuthError(msg: string): "invalid_grant" | "other" {
  return classifyRefreshError(msg) === "invalid_grant" ? "invalid_grant" : "other";
}

/**
 * Mensagem de alerta consolidado para invalid_grant (#2318).
 * Emitida UMA VEZ (não por arquivo) quando o token OAuth está morto.
 * Pipeline não bloqueia — Drive sync é non-blocking por design — mas o
 * alerta é unmissable e actionable.
 *
 * Alinhado com renderTokenHealthBanner em google-auth.ts (#2318/#1973):
 * lista todos os sistemas afetados (Drive sync, inbox-drain, imagens sociais)
 * e inclui o comando de recuperação /diaria-inbox.
 */
export const OAUTH_EXPIRED_ALERT =
  "[drive-sync] ⚠  Drive OAuth EXPIRADO/REVOGADO — rode 'npx tsx scripts/oauth-setup.ts' pra re-autenticar. " +
  "Todos os arquivos desta operação foram pulados. " +
  "Afeta de uma vez: Drive sync (push/pull) · inbox-drain (submissões do editor) · upload de imagens sociais. " +
  "Após re-autenticar: rode /diaria-inbox pra recuperar submissões perdidas.";

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
// Retry, helpers de listagem e escape de query agora vivem em
// scripts/lib/drive-helpers.ts (#1308 itens 2 + 4 — compartilhado com
// sync-report.ts e upload-report-to-drive.ts).
// ---------------------------------------------------------------------------

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

export const CONFLICT_TOLERANCE_SECONDS = loadConflictToleranceSeconds(
  resolve(ROOT, "platform.config.json"),
);

export async function driveGetMetadata(fileId: string): Promise<{ id: string; name: string; modifiedTime: string; parents?: string[] }> {
  const res = await gFetchRetry(`${DRIVE_API}/files/${fileId}?fields=id,name,modifiedTime,parents`);
  if (!res.ok) throw new Error(`Drive metadata error (${res.status}): ${await res.text()}`);
  // #649 (#496): valida modifiedTime parseable antes de comparações de timestamp
  return parseDriveFileMetadata(await res.json());
}

export function mimeTypeFor(filename: string): string {
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

export async function getFileBytes(editionDir: string, filename: string): Promise<Buffer> {
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

export async function driveUploadFile(
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
  const metadata: Record<string, unknown> = { name, parents: [parentId] };
  if (convertToDoc) {
    metadata.mimeType = GOOGLE_DOC_MIME;
  }
  const { body, contentType } = buildMultipartBody({ metadata, contentType: mimeType, content });

  const res = await gFetchRetry(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime,mimeType`,
    {
      method: "POST",
      headers: { "Content-Type": contentType },
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
export async function driveUpdateFile(
  fileId: string,
  content: Buffer,
  mimeType: string,
  convertToDoc = false,
): Promise<{ id: string; modifiedTime: string; mimeType: string }> {
  const targetMimeType = convertToDoc ? GOOGLE_DOC_MIME : mimeType;
  const metadata: Record<string, unknown> = {};
  if (convertToDoc) metadata.mimeType = GOOGLE_DOC_MIME;
  const { body, contentType } = buildMultipartBody({ metadata, contentType: mimeType, content });

  const res = await gFetchRetry(
    `${DRIVE_UPLOAD}/files/${fileId}?uploadType=multipart&fields=id,modifiedTime,mimeType`,
    {
      method: "PATCH",
      headers: { "Content-Type": contentType },
      body,
    }
  );
  if (!res.ok) throw new Error(`Drive update error (${res.status}): ${await res.text()}`);
  // #649 (#496): valida shape da response do PATCH
  const parsed = parseDriveFileUploadResponse(await res.json());
  return { ...parsed, mimeType: parsed.mimeType ?? targetMimeType };
}

export async function driveDownloadFile(fileId: string): Promise<Buffer> {
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
export async function cleanupOldArchives(
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
export async function driveExportFile(fileId: string, exportMimeType: string): Promise<Buffer> {
  const url = `${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`;
  const res = await gFetchRetry(url);
  if (!res.ok) throw new Error(`Drive export error (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

export function loadCache(): DriveCache {
  if (!existsSync(CACHE_PATH)) return { editions: {} };
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as DriveCache;
  } catch {
    return { editions: {} };
  }
}

export function saveCache(cache: DriveCache): void {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Folder resolution
// ---------------------------------------------------------------------------
// escapeDriveQueryString, driveFindFolderInParent, driveFindFolderInRoot
// agora vivem em lib/drive-helpers.ts (#1308 item 2).

export async function resolveEdicoesFolder(cache: DriveCache): Promise<string> {
  if (cache.edicoes_folder_id) return cache.edicoes_folder_id;

  const workId = await driveFindFolderInRoot("Work");
  if (!workId) throw new Error("drive_path_missing:Work — pasta 'Work' não encontrada no root do My Drive");

  const startupsId = await driveFindFolderInParent("Startups", workId);
  if (!startupsId) throw new Error("drive_path_missing:Startups — pasta 'Startups' não encontrada em Work");

  const diaria = await driveFindFolderInParent("diar.ia", startupsId);
  if (!diaria) throw new Error("drive_path_missing:diar.ia — pasta 'diar.ia' não encontrada em Startups");

  const edicoes = await driveFindFolderInParent("edicoes", diaria);
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
    let folder = await driveFindFolderInParent(seg, currentParent);
    if (!folder) folder = await driveCreateFolder(seg, currentParent);
    edCache.subfolder_ids[accumulated] = folder;
    currentParent = folder;
  }
  return currentParent;
}

export async function resolveDayFolder(
  cache: DriveCache,
  yymmdd: string,
  edicoesId: string,
  isMonthly = false
): Promise<string> {
  const yymm = yymmdd.slice(0, 4);
  const edCache = (cache.editions[yymmdd] ??= { day_folder_id: "", files: {} });
  if (edCache.day_folder_id) return edCache.day_folder_id;

  // Resolver ou criar pasta YYMM
  let yymmFolder = await driveFindFolderInParent(yymm, edicoesId);
  if (!yymmFolder) yymmFolder = await driveCreateFolder(yymm, edicoesId);

  // Resolver ou criar pasta YYMMDD (ou "mensal" para edições mensais)
  const dayFolderName = isMonthly ? "mensal" : yymmdd;
  let dayFolder = await driveFindFolderInParent(dayFolderName, yymmFolder);
  if (!dayFolder) dayFolder = await driveCreateFolder(dayFolderName, yymmFolder);

  edCache.day_folder_id = dayFolder;
  return dayFolder;
}
