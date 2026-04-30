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
 * Escolhe o arquivo fonte pra cada destaque (modo social — LinkedIn/IG).
 * D1 usa variante 1x1 (social square); D2/D3 usam 1x1 (proporção forçada em #372).
 */
export function sourceImageFor(destaque: "d1" | "d2" | "d3"): string {
  return destaque === "d1" ? "04-d1-1x1.jpg" : `04-${destaque}-1x1.jpg`;
}

/**
 * Mapeamento de imagens por modo:
 * - social: D1 1x1 (square), D2, D3 — pra LinkedIn/Instagram.
 * - newsletter: cover 2x1 (= D1 inline), D2, D3, É IA? real + IA —
 *   pra Custom HTML block do Beehiiv (#74).
 * - all: union dos dois.
 *
 * Chaves usadas como `images[key].url` downstream.
 */
export type UploadMode = "social" | "newsletter" | "all";

export interface ImageSpec {
  key: string;
  filename: string;
}

/**
 * Especifica quais imagens fazer upload por modo. Quando `editionDir` é
 * passado e o modo inclui newsletter, detecta o naming É IA? em disco:
 * novas edições usam `01-eai-A.jpg`/`01-eai-B.jpg` (#192, random); edições
 * antigas usam `01-eai-real.jpg`/`01-eai-ia.jpg`. Sem `editionDir`, default
 * pra naming novo (A/B).
 */
export function imageSpecsFor(mode: UploadMode, editionDir?: string): ImageSpec[] {
  const social: ImageSpec[] = [
    { key: "d1", filename: "04-d1-1x1.jpg" },
    { key: "d2", filename: "04-d2-1x1.jpg" },
    { key: "d3", filename: "04-d3-1x1.jpg" },
  ];

  const eaiSpecs = (() => {
    const newA = editionDir ? resolve(editionDir, "01-eai-A.jpg") : null;
    const newB = editionDir ? resolve(editionDir, "01-eai-B.jpg") : null;
    if (newA && newB && existsSync(newA) && existsSync(newB)) {
      return [
        { key: "eai_a", filename: "01-eai-A.jpg" },
        { key: "eai_b", filename: "01-eai-B.jpg" },
      ];
    }
    if (editionDir) {
      const oldReal = resolve(editionDir, "01-eai-real.jpg");
      if (existsSync(oldReal)) {
        return [
          { key: "eai_real", filename: "01-eai-real.jpg" },
          { key: "eai_ia", filename: "01-eai-ia.jpg" },
        ];
      }
    }
    // Default sem disco: assume novo naming (caso de teste / dry-run).
    return [
      { key: "eai_a", filename: "01-eai-A.jpg" },
      { key: "eai_b", filename: "01-eai-B.jpg" },
    ];
  })();

  const newsletter: ImageSpec[] = [
    { key: "cover", filename: "04-d1-2x1.jpg" },
    { key: "d2", filename: "04-d2-1x1.jpg" },
    { key: "d3", filename: "04-d3-1x1.jpg" },
    ...eaiSpecs,
  ];
  if (mode === "social") return social;
  if (mode === "newsletter") return newsletter;
  // all — dedup por key (d2/d3 repeat between social e newsletter)
  const seen = new Set<string>();
  const out: ImageSpec[] = [];
  for (const s of [...social, ...newsletter]) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s);
  }
  return out;
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
  /** Lista explícita de chaves a upload. Sobrescreve `mode` se ambos passados. */
  destaques?: Array<"d1" | "d2" | "d3">;
  /** Modo de seleção de imagens (social | newsletter | all). Default: social. */
  mode?: UploadMode;
  skipExisting?: boolean;
}

export async function uploadPublicImages(
  opts: UploadOptions,
): Promise<PublicImagesOutput> {
  const { editionDir } = opts;
  const skipExisting = opts.skipExisting ?? true;

  // Determinar lista de imagens a upload
  let specs: ImageSpec[];
  if (opts.destaques) {
    // Retrocompat: destaques explícitos
    specs = opts.destaques.map((d) => ({ key: d, filename: sourceImageFor(d) }));
  } else {
    specs = imageSpecsFor(opts.mode ?? "social", editionDir);
  }

  const cachePath = resolve(editionDir, "06-public-images.json");
  const cache = skipExisting ? loadCache(cachePath) : {};
  const images: Record<string, PublicImage> = { ...cache };

  for (const spec of specs) {
    if (skipExisting && cache[spec.key]?.file_id) {
      continue; // já uploaded em execução anterior
    }
    const imagePath = resolve(editionDir, spec.filename);
    if (!existsSync(imagePath)) {
      throw new Error(`Imagem não encontrada: ${imagePath}`);
    }
    const content = readFileSync(imagePath);
    const mime = mimeTypeFor(spec.filename);
    const driveName = `diaria-${spec.key}-${Date.now()}-${spec.filename}`;

    const { id: fileId } = await driveUploadFile(driveName, content, mime);
    await makeFilePublic(fileId);

    images[spec.key] = {
      file_id: fileId,
      url: publicImageUrl(fileId),
      mime_type: mime,
      filename: spec.filename,
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
    console.error(
      "Uso: upload-images-public.ts --edition-dir <path> [--mode social|newsletter|all] [--no-cache]",
    );
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const skipExisting = !args["no-cache"];
  const modeArg = args.mode;
  const mode: UploadMode =
    modeArg === "newsletter" || modeArg === "all" || modeArg === "social"
      ? modeArg
      : "social";

  const result = await uploadPublicImages({ editionDir, mode, skipExisting });
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
