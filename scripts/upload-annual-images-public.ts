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
 * cache — mesma disciplina de `shouldReuseCachedUpload` na diária (#7618
 * fecha o gap: até então o reuse era só por PRESENÇA do filename, o md5
 * nunca era comparado — imagem regenerada com o MESMO nome ficava stale em
 * silêncio). O `public-images.json` que `publish-annual-kit.ts` lê continua
 * achatado (`url -> filename`, formato público inalterado); o md5 real vive
 * num sidecar `_internal/public-images-md5.json` (`filename -> md5`),
 * interno a este script — mesma separação "cache de reuse" vs "arquivo que
 * outro consumidor lê" que a diária resolve guardando `md5` dentro de
 * `PublicImage` (aqui o formato público não tem campos extras, daí o
 * sidecar em vez de inline).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
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

/**
 * Caminho do sidecar de md5 (#7618) — mesmo diretório do `cachePath` público,
 * nome derivado dele (`public-images.json` → `public-images-md5.json`).
 * Nunca lido por `publish-annual-kit.ts`; só este script consome.
 */
export function md5CachePathFor(cachePath: string): string {
  const dir = dirname(cachePath);
  const base = basename(cachePath).replace(/\.json$/, "");
  return join(dir, `${base}-md5.json`);
}

/** Carrega o sidecar de md5 (`filename -> md5`). Ausente/corrompido → `{}` (nunca lança, mesma falha-aberta de `loadCache`). */
function loadMd5Cache(md5CachePath: string): Record<string, string> {
  if (!existsSync(md5CachePath)) return {};
  try {
    return JSON.parse(readFileSync(md5CachePath, "utf8"));
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
  const existing = loadCache(opts.cachePath);
  // O cache público é `url -> filename`; pra decidir reuse por arquivo,
  // precisamos do inverso.
  const existingByFilename = new Map<string, CachedAnnualImage>();
  const md5CachePath = md5CachePathFor(opts.cachePath);
  const md5Cache = loadMd5Cache(md5CachePath);
  for (const [url, filename] of Object.entries(existing)) {
    existingByFilename.set(filename, { url, filename, md5: md5Cache[filename] ?? "" });
  }

  const images: Record<string, string> = { ...existing };
  const md5s: Record<string, string> = { ...md5Cache };
  let uploaded = 0;
  let reused = 0;

  for (const theme of themes) {
    const imagePath = resolve(opts.editionDir, theme.filename);
    const cached = existingByFilename.get(theme.filename);
    const localMd5 = md5OfFile(imagePath);
    // #7618: reuse exige filename já cacheado E md5 real batendo — md5
    // ausente no sidecar (entry pré-#7618, ou sidecar perdido) conta como
    // drift, mesma disciplina fail-closed de `shouldReuseCachedUpload` na
    // diária (ausência de md5 = assume drift, re-upload).
    if (skipExisting && cached?.md5 && cached.md5 === localMd5) {
      images[cached.url] = theme.filename;
      md5s[theme.filename] = cached.md5;
      reused++;
      continue;
    }
    const key = annualKvKey(opts.slug, theme.filename, localMd5);
    if (!opts.cfConfig && !opts.uploaders?.uploadToCloudflare) {
      throw new Error("cfConfig ausente — passe cfConfig ou opts.uploaders.uploadToCloudflare");
    }
    const url = await uploadToCloudflare(imagePath, key, opts.cfConfig!);
    // `images` é keyed por URL, não por filename — um re-upload (md5 mudou)
    // gera uma URL nova (o key KV leva o md5 no sufixo). Sem podar a entry
    // antiga primeiro, a URL velha (apontando pro blob KV stale) ficava pra
    // trás em `images`, e `public-images.json` acumulava 1 URL morta por
    // regeneração — a mesma classe de staleness silenciosa do #7618, um
    // nível acima (URL morta em vez de md5 nunca comparado). Achado do
    // self-review do #7619.
    for (const oldUrl of Object.keys(images)) {
      if (images[oldUrl] === theme.filename) delete images[oldUrl];
    }
    images[url] = theme.filename;
    md5s[theme.filename] = localMd5;
    uploaded++;
  }

  writeFileSync(opts.cachePath, JSON.stringify(images, null, 2) + "\n", "utf8");
  writeFileSync(md5CachePath, JSON.stringify(md5s, null, 2) + "\n", "utf8");

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
