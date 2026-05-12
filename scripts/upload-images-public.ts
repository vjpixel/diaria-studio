/**
 * upload-images-public.ts
 *
 * Faz upload das imagens de destaque (D1 square, D2, D3) pro Google Drive
 * como arquivos publicamente acessíveis, retornando URLs shareable.
 *
 * Usado pelo Stage 4 social (LinkedIn / Facebook) — `publish-linkedin.ts`
 * passa a URL no payload Make.com pra `image_url`; LinkedIn renderiza preview.
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
import { uploadImageToWorkerKV } from "./lib/cloudflare-kv-upload.ts"; // #1119

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export interface PublicImage {
  /** Drive file_id (target=drive) ou Cloudflare KV key (target=cloudflare). #1119 */
  file_id: string;
  url: string;
  mime_type: string;
  filename: string;
  /** Target onde a imagem está hospedada. Default drive (compat com edições antigas). #1119 */
  target?: "drive" | "cloudflare";
}

/** Target de hospedagem das imagens. #1119 */
export type UploadTarget = "drive" | "cloudflare";

/**
 * Default de target por modo (#1119):
 * - `newsletter` → cloudflare (email-stable URLs, Cache-Control imutável)
 * - `social` → drive (LinkedIn/Facebook OG preview funciona com Drive URLs)
 * - `all` → cloudflare (newsletter manda)
 *
 * Editor pode override via flag `--target drive`/`--target cloudflare`.
 */
export function defaultTargetFor(mode: UploadMode): UploadTarget {
  return mode === "social" ? "drive" : "cloudflare";
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
 * novas edições usam `01-eia-A.jpg`/`01-eia-B.jpg` (#192, random); edições
 * antigas usam `01-eia-real.jpg`/`01-eia-ia.jpg`. Sem `editionDir`, default
 * pra naming novo (A/B).
 */
export function imageSpecsFor(mode: UploadMode, editionDir?: string): ImageSpec[] {
  const social: ImageSpec[] = [
    { key: "d1", filename: "04-d1-1x1.jpg" },
    { key: "d2", filename: "04-d2-1x1.jpg" },
    { key: "d3", filename: "04-d3-1x1.jpg" },
  ];

  const eaiSpecs = (() => {
    const newA = editionDir ? resolve(editionDir, "01-eia-A.jpg") : null;
    const newB = editionDir ? resolve(editionDir, "01-eia-B.jpg") : null;
    if (newA && newB && existsSync(newA) && existsSync(newB)) {
      return [
        { key: "eia_a", filename: "01-eia-A.jpg" },
        { key: "eia_b", filename: "01-eia-B.jpg" },
      ];
    }
    if (editionDir) {
      const oldReal = resolve(editionDir, "01-eia-real.jpg");
      if (existsSync(oldReal)) {
        return [
          { key: "eia_real", filename: "01-eia-real.jpg" },
          { key: "eia_ia", filename: "01-eia-ia.jpg" },
        ];
      }
    }
    // Default sem disco: assume novo naming (caso de teste / dry-run).
    return [
      { key: "eia_a", filename: "01-eia-A.jpg" },
      { key: "eia_b", filename: "01-eia-B.jpg" },
    ];
  })();

  // #1121: newsletter mode upload-a só o que o renderer de fato substitui via
  // `{{IMG:...}}`: cover D1 + È IA? A/B. D2/D3 não têm imagem inline na
  // newsletter (memory `feedback_newsletter_only_d1_image.md`). Histórico:
  // antes da #1121, d2/d3 estavam aqui por histórico de quando newsletter
  // tinha imagem em todos os destaques — não atualizado quando regra mudou.
  // Mantê-los causava (a) upload desnecessário e (b) churn entre target=drive
  // (social) ↔ target=cloudflare (newsletter), criando file_ids órfãos no
  // Drive a cada flip.
  const newsletter: ImageSpec[] = [
    { key: "cover", filename: "04-d1-2x1.jpg" },
    ...eaiSpecs,
  ];
  if (mode === "social") return social;
  if (mode === "newsletter") return newsletter;
  // all — dedup por key (eaiSpecs em newsletter, d1/d2/d3 em social)
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
  /** Target de hospedagem (#1119). Default deriva do mode via `defaultTargetFor`. */
  target?: UploadTarget;
}

/**
 * Constrói KV key única por edição + filename. Convenção #1119: `img-{AAMMDD}-{filename}`.
 * Extrai AAMMDD do path da edição (ex: `data/editions/260512/` → `260512`).
 */
export function cloudflareKvKey(editionDir: string, filename: string): string {
  const match = editionDir.replace(/[\\/]+$/, "").match(/(\d{6})$/);
  const aammdd = match?.[1] ?? "unknown";
  return `img-${aammdd}-${filename}`;
}

export async function uploadPublicImages(
  opts: UploadOptions,
): Promise<PublicImagesOutput> {
  const { editionDir } = opts;
  const skipExisting = opts.skipExisting ?? true;
  const mode = opts.mode ?? "social";
  const target = opts.target ?? defaultTargetFor(mode);

  // Determinar lista de imagens a upload
  let specs: ImageSpec[];
  if (opts.destaques) {
    // Retrocompat: destaques explícitos
    specs = opts.destaques.map((d) => ({ key: d, filename: sourceImageFor(d) }));
  } else {
    specs = imageSpecsFor(mode, editionDir);
  }

  const cachePath = resolve(editionDir, "06-public-images.json");
  const cache = skipExisting ? loadCache(cachePath) : {};
  const images: Record<string, PublicImage> = { ...cache };

  // Cloudflare config (lazy — só carrega se target=cloudflare).
  let cfConfig: { kvNamespaceId: string; workerUrl: string } | null = null;
  if (target === "cloudflare") {
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const kvNamespaceId = cfg?.poll?.kv_namespace_id;
    const workerUrl = cfg?.poll?.worker_url ?? "https://diar-ia-poll.diaria.workers.dev";
    if (!kvNamespaceId) {
      throw new Error("platform.config.json → poll.kv_namespace_id não configurado (target=cloudflare)");
    }
    cfConfig = { kvNamespaceId, workerUrl };
  }

  for (const spec of specs) {
    // Cache hit: respeitar quando o entry bate com o target solicitado.
    // Se mudou de drive↔cloudflare, re-uploadar.
    const cached = cache[spec.key];
    if (skipExisting && cached?.file_id && (cached.target ?? "drive") === target) {
      continue;
    }
    const imagePath = resolve(editionDir, spec.filename);
    if (!existsSync(imagePath)) {
      throw new Error(`Imagem não encontrada: ${imagePath}`);
    }
    const mime = mimeTypeFor(spec.filename);

    if (target === "cloudflare") {
      const key = cloudflareKvKey(editionDir, spec.filename);
      const url = await uploadImageToWorkerKV(imagePath, key, cfConfig!);
      images[spec.key] = {
        file_id: key,
        url,
        mime_type: mime,
        filename: spec.filename,
        target: "cloudflare",
      };
    } else {
      const content = readFileSync(imagePath);
      const driveName = `diaria-${spec.key}-${Date.now()}-${spec.filename}`;
      const { id: fileId } = await driveUploadFile(driveName, content, mime);
      await makeFilePublic(fileId);
      images[spec.key] = {
        file_id: fileId,
        url: publicImageUrl(fileId),
        mime_type: mime,
        filename: spec.filename,
        target: "drive",
      };
    }
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
      "Uso: upload-images-public.ts --edition-dir <path> [--mode social|newsletter|all] [--target drive|cloudflare] [--no-cache]\n" +
        "\n" +
        "Default target: 'cloudflare' pra mode=newsletter|all (#1119), 'drive' pra mode=social.",
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

  const targetArg = args.target;
  const target: UploadTarget | undefined =
    targetArg === "drive" || targetArg === "cloudflare" ? targetArg : undefined;

  const result = await uploadPublicImages({ editionDir, mode, skipExisting, target });
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
