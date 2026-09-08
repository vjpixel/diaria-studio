#!/usr/bin/env npx tsx
/**
 * upload-annual-images-public.ts (#7587 item 4) — Etapa 3 da `/diaria-anual`.
 *
 * Equivalente de `upload-images-public.ts` (diária) para a edição ANUAL:
 * sobe as N imagens 2:1 de tema (`04-d{N}-2x1.jpg`, N variável 3-7 — nunca
 * fixo em 3, ver `context/templates/newsletter-anual.md`) pro Cloudflare KV
 * do Worker `poll` e grava `_internal/public-images.json` no formato que
 * `scripts/publish-annual-kit.ts` já lê: **URL pública → nome do arquivo
 * local** (mapa achatado, `Record<string, string>` — diferente do
 * `06-public-images.json` da diária, que é `{ images: Record<string,
 * PublicImage> } `; a anual não tem os outros campos por tema que a diária
 * carrega — só a imagem 2:1).
 *
 * Na 1ª rodada real (`2026-aniversario`, 07/09/2026) as 6 imagens subiram
 * por um script descartável ad-hoc com o mesmo `uploadImageToWorkerKV` —
 * este é o equivalente versionado, com N derivado do disco (nunca
 * hardcoded).
 *
 * Uso:
 *   npx tsx scripts/upload-annual-images-public.ts --slug 2026-aniversario
 *   npx tsx scripts/upload-annual-images-public.ts --dir data/annual/2026-aniversario [--no-cache]
 *
 * Cache: reusa upload anterior quando o md5 do arquivo local bate com o
 * cache — mesma disciplina de `shouldReuseCachedUpload` na diária, versão
 * simplificada (a anual não tem drive↔cloudflare, é sempre cloudflare).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { uploadImageToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { md5OfFile } from "./lib/shared/file-md5.ts";
import { annualPaths } from "./lib/anual/annual-paths.ts";
import { themeIndexFromImageFilename } from "./lib/anual/annual-paths.ts";
import { DIARIA_EIA_URL } from "./lib/canonical-urls.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Um tema 2:1 já cacheado (URL pública + md5 dos bytes locais no upload). */
interface CachedAnnualImage {
  url: string;
  filename: string;
  md5: string;
}

/** Padrão do nome do arquivo — mesmo de `themeIndexFromImageFilename`. */
const THEME_IMAGE_RE = /^04-d(\d+)-2x1\.jpg$/;

/** Lista as imagens de tema (`04-d{N}-2x1.jpg`) presentes no diretório da edição, ordenadas por N. */
export function findThemeImages(editionDir: string): { index: number; filename: string }[] {
  if (!existsSync(editionDir)) return [];
  return readdirSync(editionDir)
    .filter((f) => THEME_IMAGE_RE.test(f))
    .map((f) => ({ index: themeIndexFromImageFilename(f)!, filename: f }))
    .sort((a, b) => a.index - b.index);
}

/** Chave KV única por edição anual + arquivo, com sufixo md5 de cache-bust (mesma disciplina do #1584 na diária). */
export function annualKvKey(slug: string, filename: string, md5Hex: string): string {
  const dot = filename.lastIndexOf(".");
  const base = dot < 0 ? filename : filename.slice(0, dot);
  const ext = dot < 0 ? "" : filename.slice(dot);
  return `img-annual-${slug}-${base}-${md5Hex.slice(0, 8)}${ext}`;
}

/** Carrega o cache existente (URL → nome do arquivo) e o índice inverso (arquivo → URL) pra reuse. */
function loadCache(cachePath: string): Record<string, string> {
  if (!existsSync(cachePath)) return {};
  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return {};
  }
}

export interface UploadDeps {
  uploadToCloudflare?: (
    imagePath: string,
    key: string,
    cfg: { kvNamespaceId: string; workerUrl: string },
  ) => Promise<string>;
}

export interface UploadAnnualOptions {
  slug: string;
  editionDir: string;
  cachePath: string;
  skipExisting?: boolean;
  cfConfig?: { kvNamespaceId: string; workerUrl: string };
  uploaders?: UploadDeps;
}

export interface UploadAnnualResult {
  out_path: string;
  images: Record<string, string>;
  themes_found: number;
  uploaded: number;
  reused: number;
}

/**
 * Faz upload de toda imagem de tema encontrada no disco. Pura o suficiente
 * pra testar sem rede via `opts.uploaders` (mesmo seam de `uploadPublicImages`
 * na diária) — só toca disco (leitura local + escrita do cache) e a rede
 * injetável.
 */
export async function uploadAnnualImages(opts: UploadAnnualOptions): Promise<UploadAnnualResult> {
  const skipExisting = opts.skipExisting ?? true;
  const uploadToCloudflare = opts.uploaders?.uploadToCloudflare ?? uploadImageToWorkerKV;

  const themes = findThemeImages(opts.editionDir);
  const existingByFilename = new Map<string, CachedAnnualImage>();
  const existing = loadCache(opts.cachePath);
  // O cache é `url -> filename`; pra decidir reuse por arquivo, precisamos do
  // inverso. O md5 não é gravado no cache achatado (não há campo pra isso no
  // formato que `publish-annual-kit.ts` espera) — reuse aqui é só "a URL já
  // existe pra este filename", sem revalidar bytes. `--no-cache` força
  // re-upload de tudo quando isso não é bom o bastante (arquivo regerado).
  for (const [url, filename] of Object.entries(existing)) {
    existingByFilename.set(filename, { url, filename, md5: "" });
  }

  const images: Record<string, string> = { ...existing };
  let uploaded = 0;
  let reused = 0;

  for (const theme of themes) {
    const imagePath = resolve(opts.editionDir, theme.filename);
    const cached = existingByFilename.get(theme.filename);
    if (skipExisting && cached) {
      images[cached.url] = theme.filename;
      reused++;
      continue;
    }
    const md5 = md5OfFile(imagePath);
    const key = annualKvKey(opts.slug, theme.filename, md5);
    if (!opts.cfConfig && !opts.uploaders?.uploadToCloudflare) {
      throw new Error("cfConfig ausente — passe cfConfig ou opts.uploaders.uploadToCloudflare");
    }
    const url = await uploadToCloudflare(imagePath, key, opts.cfConfig!);
    images[url] = theme.filename;
    uploaded++;
  }

  writeFileSync(opts.cachePath, JSON.stringify(images, null, 2) + "\n", "utf8");

  return { out_path: opts.cachePath, images, themes_found: themes.length, uploaded, reused };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const noCache = argv.includes("--no-cache");
  const args = parseArgsSimple(argv.filter((a) => a !== "--no-cache"));

  let editionDir: string;
  let slug: string;
  if (typeof args.slug === "string") {
    slug = args.slug;
    editionDir = annualPaths(slug, resolve(ROOT, "data/annual")).dir;
  } else if (typeof args.dir === "string") {
    editionDir = resolve(ROOT, args.dir);
    slug = editionDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "annual";
  } else {
    console.error("Uso: upload-annual-images-public.ts --slug 2026-aniversario | --dir <path> [--no-cache]");
    process.exit(1);
    return;
  }

  const paths = annualPaths(slug, resolve(ROOT, "data/annual"));
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const kvNamespaceId = cfg?.poll?.kv_namespace_id;
  const workerUrl = cfg?.poll?.worker_url ?? DIARIA_EIA_URL;
  if (!kvNamespaceId) {
    throw new Error("platform.config.json → poll.kv_namespace_id não configurado");
  }

  const result = await uploadAnnualImages({
    slug,
    editionDir,
    cachePath: paths.publicImages,
    skipExisting: !noCache,
    cfConfig: { kvNamespaceId, workerUrl },
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.themes_found === 0) {
    console.error(
      `⚠️  nenhuma imagem de tema (04-d{N}-2x1.jpg) encontrada em ${editionDir} — rode a Etapa 3 antes.`,
    );
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
