/**
 * embed-images-base64.ts
 *
 * Substitui URLs remotas de imagem (poll.diaria.workers.dev) por data: URIs
 * base64 num HTML já renderizado. Usado exclusivamente para o preview de
 * revisão do Stage 4 publicado via Claude Artifacts (#3214): Artifacts rodam
 * sob CSP estrita que bloqueia carregamento de imagem remota, então
 * newsletter-final.html/social-preview.html (com URLs reais) nunca renderizam
 * imagem dentro do preview — regressão silenciosa desde a migração #3214.
 *
 * NÃO usar para o HTML de produção (o que o Stage 5 sobe pro Beehiiv/Worker):
 * esse precisa manter URLs reais — e-mail com imagem embutida em base64 fica
 * gigante e a maioria dos clientes de e-mail não renderiza data: URI de
 * qualquer forma. Este script gera um arquivo SEPARADO, só para o preview.
 *
 * Uso:
 *   npx tsx scripts/embed-images-base64.ts \
 *     --html <input.html> \
 *     --images <06-public-images.json> \
 *     --edition-dir <data/editions/AAMMDD/> \
 *     --out <output.html>
 *
 * Resolve cada `img.url` de 06-public-images.json pelo `img.filename`
 * correspondente no disco (raiz da edição), lê os bytes localmente — não
 * depende da URL remota estar acessível.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";

interface PublicImage {
  url: string;
  mime_type?: string;
  filename: string;
}

interface PublicImagesFile {
  images?: Record<string, PublicImage>;
}

const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function mimeFor(filename: string, declared: string | undefined): string {
  if (declared) return declared;
  return EXT_MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export interface EmbedResult {
  html: string;
  embedded: string[];
  missing: string[];
}

/**
 * Pure: substitui cada `img.url` presente no HTML por um data: URI lendo o
 * arquivo local `editionDir/img.filename`. Imagem sem arquivo local vira
 * `missing` e a URL remota é mantida (fail-open — melhor preview parcial que
 * abortar tudo).
 */
export function embedImagesAsDataUri(
  html: string,
  images: Record<string, PublicImage>,
  editionDir: string,
): EmbedResult {
  const embedded: string[] = [];
  const missing: string[] = [];
  let result = html;

  for (const img of Object.values(images)) {
    if (!img.url || !img.filename) continue;
    if (!result.includes(img.url)) continue; // essa imagem não aparece neste HTML

    const localPath = join(editionDir, img.filename);
    if (!existsSync(localPath)) {
      missing.push(img.filename);
      continue;
    }

    const bytes = readFileSync(localPath);
    const dataUri = `data:${mimeFor(img.filename, img.mime_type)};base64,${bytes.toString("base64")}`;
    result = result.split(img.url).join(dataUri);
    embedded.push(img.filename);
  }

  return { html: result, embedded, missing };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const htmlArg = args.html;
  const imagesArg = args.images;
  const editionDirArg = args["edition-dir"];
  const outArg = args.out;

  if (!htmlArg || !imagesArg || !editionDirArg || !outArg) {
    console.error(
      "Uso: embed-images-base64.ts --html <input.html> --images <06-public-images.json> " +
        "--edition-dir <data/editions/AAMMDD/> --out <output.html>",
    );
    process.exit(1);
  }

  const htmlPath = resolve(ROOT, htmlArg);
  const imagesPath = resolve(ROOT, imagesArg);
  const editionDir = resolve(ROOT, editionDirArg);
  const outPath = resolve(ROOT, outArg);

  const html = readFileSync(htmlPath, "utf8");
  const imagesFile = JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesFile;

  const result = embedImagesAsDataUri(html, imagesFile.images ?? {}, editionDir);

  writeFileSync(outPath, result.html, "utf8");

  console.log(
    JSON.stringify(
      {
        out_path: outPath,
        embedded: result.embedded,
        missing: result.missing,
      },
      null,
      2,
    ),
  );

  if (result.missing.length > 0) {
    console.error(
      `⚠️  ${result.missing.length} imagem(ns) sem arquivo local: ${result.missing.join(", ")}`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
