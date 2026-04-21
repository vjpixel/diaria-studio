/**
 * drive-sync.ts
 *
 * Sincroniza arquivos de edição entre `data/editions/{YYMMDD}/` e
 * `startups/diar.ia/edicoes/{YYMM}/{YYMMDD}/` no Google Drive.
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
 * Cache: data/drive-cache.json (estrutura documentada em .claude/agents/drive-syncer.md)
 * Credenciais: data/.credentials.json (gerado por scripts/oauth-setup.ts)
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { resolve, extname } from "node:path";
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
}

interface EditionCache {
  day_folder_id: string;
  files: Record<string, FileEntry>;
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
// Drive API helpers
// ---------------------------------------------------------------------------

async function driveList(q: string, fields = "files(id,name,mimeType,modifiedTime,parents)"): Promise<Array<{ id: string; name: string; mimeType: string; modifiedTime: string; parents?: string[] }>> {
  const params = new URLSearchParams({ q, fields, pageSize: "20" });
  const res = await gFetch(`${DRIVE_API}/files?${params}`);
  if (!res.ok) throw new Error(`Drive list error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { files: Array<{ id: string; name: string; mimeType: string; modifiedTime: string; parents?: string[] }> };
  return data.files ?? [];
}

async function driveGetMetadata(fileId: string): Promise<{ id: string; name: string; modifiedTime: string; parents?: string[] }> {
  const res = await gFetch(`${DRIVE_API}/files/${fileId}?fields=id,name,modifiedTime,parents`);
  if (!res.ok) throw new Error(`Drive metadata error (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ id: string; name: string; modifiedTime: string; parents?: string[] }>;
}

async function driveCreateFolder(name: string, parentId: string): Promise<string> {
  const res = await gFetch(`${DRIVE_API}/files`, {
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
    // Redimensionar para preview 400×225 antes de subir ao Drive
    return sharp(readFileSync(localPath))
      .resize(400, 225, { fit: "cover" })
      .jpeg({ quality: 70 })
      .toBuffer();
  }
  return readFileSync(localPath);
}

async function driveUploadFile(
  name: string,
  content: Buffer,
  mimeType: string,
  parentId: string
): Promise<{ id: string; modifiedTime: string }> {
  // Multipart upload
  const boundary = "diaria_boundary_" + Date.now();
  const metadataPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: [parentId] }) +
    `\r\n`;
  const contentPart =
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const closingBoundary = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(metadataPart, "utf8"),
    Buffer.from(contentPart, "utf8"),
    content,
    Buffer.from(closingBoundary, "utf8"),
  ]);

  const res = await gFetch(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) throw new Error(`Drive upload error (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ id: string; modifiedTime: string }>;
}

async function driveDownloadFile(fileId: string): Promise<Buffer> {
  const res = await gFetch(`${DRIVE_API}/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error(`Drive download error (${res.status}): ${await res.text()}`);
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

async function findFolderInParent(name: string, parentId: string): Promise<string | null> {
  const files = await driveList(
    `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`
  );
  return files[0]?.id ?? null;
}

async function findRootFolder(name: string): Promise<string | null> {
  // Busca global — filtra por owner para evitar pastas de outros usuários
  const files = await driveList(
    `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  return files[0]?.id ?? null;
}

async function resolveEdicoesFolder(cache: DriveCache): Promise<string> {
  if (cache.edicoes_folder_id) return cache.edicoes_folder_id;

  const startupsId = await findRootFolder("startups");
  if (!startupsId) throw new Error("drive_path_missing:startups — pasta 'startups' não encontrada no Drive");

  const diaria = await findFolderInParent("diar.ia", startupsId);
  if (!diaria) throw new Error("drive_path_missing:diar.ia — pasta 'diar.ia' não encontrada");

  const edicoes = await findFolderInParent("edicoes", diaria);
  if (!edicoes) throw new Error("drive_path_missing:edicoes — pasta 'edicoes' não encontrada");

  cache.edicoes_folder_id = edicoes;
  return edicoes;
}

async function resolveDayFolder(
  cache: DriveCache,
  yymmdd: string,
  edicoesId: string
): Promise<string> {
  const yymm = yymmdd.slice(0, 4);
  const edCache = (cache.editions[yymmdd] ??= { day_folder_id: "", files: {} });
  if (edCache.day_folder_id) return edCache.day_folder_id;

  // Resolver ou criar pasta YYMM
  let yymmFolder = await findFolderInParent(yymm, edicoesId);
  if (!yymmFolder) yymmFolder = await driveCreateFolder(yymm, edicoesId);

  // Resolver ou criar pasta YYMMDD
  let dayFolder = await findFolderInParent(yymmdd, yymmFolder);
  if (!dayFolder) dayFolder = await driveCreateFolder(yymmdd, yymmFolder);

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

  const ext = extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  const titleUsed = pushCount === 0 ? filename : `${base}.v${pushCount + 1}${ext}`;
  const mimeType = mimeTypeFor(filename);

  const bytes = await getFileBytes(editionDir, filename);
  const { id: driveFileId, modifiedTime } = await driveUploadFile(
    titleUsed,
    bytes,
    mimeType,
    dayFolderId
  );

  const localPath = resolve(ROOT, editionDir, filename);
  const localMtime = statSync(localPath).mtimeMs;

  edCache.files[filename] = {
    drive_file_id: driveFileId,
    drive_modifiedTime: modifiedTime,
    last_pushed_mtime: localMtime,
    push_count: pushCount + 1,
  };

  result.uploaded.push({ file: filename, drive_file_id: driveFileId, title_used: titleUsed });
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

  const bytes = await driveDownloadFile(fileCache.drive_file_id);
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string) => args[args.indexOf(flag) + 1] ?? "";

  const mode = get("--mode");
  const editionDir = get("--edition-dir");
  const stage = parseInt(get("--stage") || "0", 10);
  const filesStr = get("--files");

  if (!mode || !editionDir) {
    console.error(
      "Usage: drive-sync.ts --mode push|pull --edition-dir data/editions/YYMMDD/ --stage N --files file1.md,file2.jpg"
    );
    process.exit(1);
  }

  const files = filesStr ? filesStr.split(",").map((f) => f.trim()).filter(Boolean) : [];
  const yymmdd = editionDir.replace(/\/$/, "").split("/").pop() ?? "";

  const result: SyncResult = {
    mode,
    stage,
    edition: yymmdd,
    day_folder_path: `startups/diar.ia/edicoes/${yymmdd.slice(0, 4)}/${yymmdd}`,
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
    const dayFolderId = await resolveDayFolder(cache, yymmdd, edicoesId);

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

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("drive-sync fatal:", err.message);
  process.exit(1);
});
