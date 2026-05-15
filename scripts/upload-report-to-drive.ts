/**
 * upload-report-to-drive.ts — cria novo Google Doc a partir de markdown local
 *
 * Usa OAuth credentials de data/.credentials.json (mesmo que drive-sync.ts).
 * Faz upload em Work/Startups/diar.ia/relatorios/ (cria pasta se não existir).
 * Converte MD → Google Doc nativo (editor pode comentar/editar).
 *
 * **CREATE-ONLY:** se já existe um arquivo com mesmo nome na pasta, **aborta**
 * (não sobrescreve). Pra atualizar um Doc existente preservando edições do
 * usuário, use scripts/sync-report.ts (3-way merge).
 *
 * Pra forçar overwrite (destrutivo — perde edições do usuário no Doc),
 * passar --force. Use com cautela.
 *
 * Uso:
 *   npx tsx scripts/upload-report-to-drive.ts --file data/reports/foo.md
 *   npx tsx scripts/upload-report-to-drive.ts --file data/reports/foo.md --folder relatorios
 *   npx tsx scripts/upload-report-to-drive.ts --file data/reports/foo.md --force  # sobrescreve (perigoso)
 */
import { readFileSync, existsSync } from "node:fs";
import { basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gFetch } from "./google-auth.ts";
import { GOOGLE_DOC_MIME } from "./drive-sync.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

interface DriveFile { id: string; name: string; mimeType: string; modifiedTime: string; }

function escapeQ(s: string): string { return s.replace(/'/g, "\\'"); }

async function driveList(q: string): Promise<DriveFile[]> {
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType,modifiedTime)", spaces: "drive" });
  const res = await gFetch(`${DRIVE_API}/files?${params}`);
  const data = await res.json() as { files: DriveFile[] };
  return data.files ?? [];
}

async function findFolderInRoot(name: string): Promise<string | null> {
  const q = `name='${escapeQ(name)}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;
  const r = await driveList(q);
  return r[0]?.id ?? null;
}

async function findFolderInParent(name: string, parentId: string): Promise<string | null> {
  const q = `name='${escapeQ(name)}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const r = await driveList(q);
  return r[0]?.id ?? null;
}

async function findFileInParent(name: string, parentId: string): Promise<DriveFile | null> {
  // Excluir folders pra evitar match espúrio se houver pasta com mesmo nome do report
  const q = `name='${escapeQ(name)}' and '${parentId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`;
  const r = await driveList(q);
  return r[0] ?? null;
}

async function createFolder(name: string, parentId: string): Promise<string> {
  const res = await gFetch(`${DRIVE_API}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  const data = await res.json() as { id: string };
  return data.id;
}

async function uploadOrUpdateMarkdownAsDoc(
  localPath: string,
  driveName: string,
  parentId: string,
  existingId: string | null,
): Promise<{ id: string; webViewLink: string }> {
  const content = readFileSync(localPath, "utf8");
  const boundary = "boundary" + Math.random().toString(36).slice(2);
  const metadata: Record<string, unknown> = existingId
    ? { name: driveName }
    : { name: driveName, mimeType: GOOGLE_DOC_MIME, parents: [parentId] };

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/markdown; charset=UTF-8\r\n\r\n` +
    content + `\r\n` +
    `--${boundary}--`;

  const url = existingId
    ? `${DRIVE_UPLOAD}/files/${existingId}?uploadType=multipart&fields=id,webViewLink`
    : `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`;
  const method = existingId ? "PATCH" : "POST";

  const res = await gFetch(url, {
    method,
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text()}`);
  return await res.json() as { id: string; webViewLink: string };
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; }
      else { out[key] = true; }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const localFile = args.file as string;
  if (!localFile) { console.error("usage: --file <path> [--folder relatorios] [--force]"); process.exit(2); }
  const subFolder = (args.folder as string) ?? "relatorios";
  const force = !!args.force;
  const localPath = resolve(ROOT, localFile);
  if (!existsSync(localPath)) throw new Error(`local file not found: ${localPath}`);

  // Resolve folder: Work/Startups/diar.ia/{subFolder}
  console.error(`[1/4] Resolvendo path no Drive: Work/Startups/diar.ia/${subFolder}/`);
  const workId = await findFolderInRoot("Work");
  if (!workId) throw new Error("Work folder not found at My Drive root");
  const startupsId = await findFolderInParent("Startups", workId);
  if (!startupsId) throw new Error("Startups folder not found in Work");
  const diariaId = await findFolderInParent("diar.ia", startupsId);
  if (!diariaId) throw new Error("diar.ia folder not found in Startups");
  let subId = await findFolderInParent(subFolder, diariaId);
  if (!subId) {
    console.error(`[2/4] Pasta ${subFolder} não existe — criando...`);
    subId = await createFolder(subFolder, diariaId);
  } else {
    console.error(`[2/4] Pasta ${subFolder} encontrada: ${subId}`);
  }

  // Determine target name (strip .md extension for Doc title)
  const fileName = basename(localFile).replace(/\.md$/, "");
  console.error(`[3/4] Procurando arquivo existente com nome "${fileName}"...`);
  const existing = await findFileInParent(fileName, subId);
  if (existing && !force) {
    console.error(`\n❌ ABORT: arquivo já existe (id ${existing.id}).`);
    console.error(`Este script é create-only por safety — não sobrescreve pra preservar`);
    console.error(`edições do usuário no Doc.`);
    console.error(`\nPara atualizar o Doc existente preservando edições:`);
    console.error(`  npx tsx scripts/sync-report.ts --file ${localFile} --file-id ${existing.id}`);
    console.error(`\nPara overwrite destrutivo (PERIGOSO — perde edições do usuário):`);
    console.error(`  npx tsx scripts/upload-report-to-drive.ts --file ${localFile} --force`);
    process.exit(4);
  }
  if (existing && force) {
    console.error(`      ⚠️ encontrado (id ${existing.id}), --force ativo → vai sobrescrever (DESTRUTIVO)`);
  } else {
    console.error(`      → não existe, vai criar novo`);
  }

  console.error(`[4/4] Uploading ${localFile} → Drive...`);
  const result = await uploadOrUpdateMarkdownAsDoc(localPath, fileName, subId, existing?.id ?? null);
  console.log(JSON.stringify({
    ok: true,
    action: existing ? "updated" : "created",
    file_id: result.id,
    drive_url: result.webViewLink ?? `https://docs.google.com/document/d/${result.id}/edit`,
    folder_path: `Work/Startups/diar.ia/${subFolder}/`,
  }, null, 2));
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
