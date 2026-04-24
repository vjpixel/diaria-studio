/**
 * upload-images-public.ts
 *
 * Faz upload das imagens de destaque (D1 square, D2, D3) pro Google Drive
 * como arquivos publicamente acessíveis, retornando URLs shareable.
 *
 * Usado pelo Stage 6 social (LinkedIn / Facebook) quando file_upload
 * local não funciona via Claude in Chrome (#48 — Drive + OG preview).
 * `publish-social` cola a URL no post, LinkedIn renderiza preview.
 *
 * Uso:
 *   npx tsx scripts/upload-images-public.ts --edition-dir data/editions/260424/
 *
 * Output (stdout JSON):
 *   {
 *     "out_path": "data/editions/260424/06-public-images.json",
 *     "images": {
 *       "d1": { "file_id": "...", "url": "https://drive.google.com/uc?id=...&export=view" },
 *       "d2": { ... },
 *       "d3": { ... }
 *     }
 *   }
 *
 * Cache: escreve em `{edition_dir}/06-public-images.json`. Re-execuções
 * reusam file_ids existentes (skip re-upload).
 *
 * Credenciais: data/.credentials.json (via google-auth.ts).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gFetch } from "./google-auth.ts";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export interface PublicImage {
  file_id: string;
  url: string;
  mime_type: string;
  filename: string;
}

export interface PublicImagesOutput {
  out_path: string;
  images: Record<string, PublicImage>;
}

/**
 * URL shareable pra preview de imagem em LinkedIn/Facebook.
 * Formato `uc?id=X&export=view` serve bytes da imagem diretamente com
 * content-type correto — crawlers de preview detectam como imagem.
 *
 * Alternativa `file/d/{id}/view` serve HTML wrapper — útil pra OG preview,
 * mas preview de imagem direto é melhor visualmente.
 */
export function publicImageUrl(fileId: string): string {
  return `https://drive.google.com/uc?id=${fileId}&export=view`;
}

/**
 * URL alternativa formato "view" (HTML wrapper com og:image meta).
 * Pode funcionar melhor em alguns clients.
 */
export function publicFileViewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
}

/** Detecta mime type básico por extensão. */
export function mimeTypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

/**
 * Escolhe o arquivo fonte pra cada destaque.
 * D1 usa variante 1x1 (social square); D2/D3 usam padrão.
 */
export function sourceImageFor(destaque: "d1" | "d2" | "d3"): string {
  return destaque === "d1" ? "04-d1-1x1.jpg" : `04-${destaque}.jpg`;
}

async function driveUploadFile(
  name: string,
  content: Buffer,
  mimeType: string,
): Promise<{ id: string }> {
  const boundary = "diaria_public_" + Date.now();
  const metadataPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name }) +
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
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(`Drive upload error (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<{ id: string }>;
}

async function makeFilePublic(fileId: string): Promise<void> {
  const res = await gFetch(`${DRIVE_API}/files/${fileId}/permissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!res.ok) {
    throw new Error(`Drive permission error (${res.status}): ${await res.text()}`);
  }
}

function loadCache(cachePath: string): Record<string, PublicImage> {
  if (!existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    return (parsed.images ?? {}) as Record<string, PublicImage>;
  } catch {
    return {};
  }
}

export interface UploadOptions {
  editionDir: string;
  destaques?: Array<"d1" | "d2" | "d3">;
  skipExisting?: boolean;
}

export async function uploadPublicImages(
  opts: UploadOptions,
): Promise<PublicImagesOutput> {
  const { editionDir } = opts;
  const destaques = opts.destaques ?? ["d1", "d2", "d3"];
  const skipExisting = opts.skipExisting ?? true;

  const cachePath = resolve(editionDir, "06-public-images.json");
  const cache = skipExisting ? loadCache(cachePath) : {};
  const images: Record<string, PublicImage> = { ...cache };

  for (const d of destaques) {
    if (skipExisting && cache[d]?.file_id) {
      continue; // já uploaded em execução anterior
    }
    const filename = sourceImageFor(d);
    const imagePath = resolve(editionDir, filename);
    if (!existsSync(imagePath)) {
      throw new Error(`Imagem não encontrada: ${imagePath}`);
    }
    const content = readFileSync(imagePath);
    const mime = mimeTypeFor(filename);
    const driveName = `diaria-${d}-${Date.now()}-${filename}`;

    const { id: fileId } = await driveUploadFile(driveName, content, mime);
    await makeFilePublic(fileId);

    images[d] = {
      file_id: fileId,
      url: publicImageUrl(fileId),
      mime_type: mime,
      filename,
    };
  }

  writeFileSync(
    cachePath,
    JSON.stringify({ images }, null, 2) + "\n",
    "utf8",
  );

  return { out_path: cachePath, images };
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--no-cache") {
      out["no-cache"] = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const editionDirArg = args["edition-dir"];
  if (typeof editionDirArg !== "string") {
    console.error("Uso: upload-images-public.ts --edition-dir <path> [--no-cache]");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const skipExisting = !args["no-cache"];

  const result = await uploadPublicImages({ editionDir, skipExisting });
  console.log(JSON.stringify(result, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
