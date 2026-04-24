/**
 * substitute-image-urls.ts
 *
 * Substitui placeholders {{IMG:filename}} no HTML do newsletter pelas URLs
 * públicas das imagens (hospedadas no Drive via upload-images-public.ts).
 *
 * Usado pelo publish-newsletter agent no fluxo Custom HTML (#74):
 *   1. upload-images-public.ts --mode newsletter → 06-public-images.json
 *   2. render-newsletter-html.ts --format html → HTML com {{IMG:04-d1-2x1.jpg}}
 *   3. substitute-image-urls.ts → HTML final com URLs reais
 *   4. Agent cola em Custom HTML block do Beehiiv.
 *
 * Uso:
 *   npx tsx scripts/substitute-image-urls.ts \
 *     --html <input.html> \
 *     --images <06-public-images.json> \
 *     [--out <output.html>]
 *
 * Output: HTML com placeholders substituídos. Se alguma placeholder
 * não tiver imagem correspondente, loga warning e mantém a placeholder
 * como está (editor precisa resolver manualmente).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface PublicImage {
  file_id: string;
  url: string;
  mime_type?: string;
  filename: string;
}

interface PublicImagesFile {
  images?: Record<string, PublicImage>;
}

/**
 * Constrói mapa filename → url a partir do cache de upload-images-public.
 */
export function buildFilenameMap(
  images: Record<string, PublicImage>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const img of Object.values(images)) {
    if (img.filename && img.url) {
      map.set(img.filename, img.url);
    }
  }
  return map;
}

export interface SubstitutionResult {
  html: string;
  substitutions: number;
  unresolved: string[];
}

/**
 * Substitui {{IMG:filename}} pelo URL correspondente.
 * Placeholder sem match no mapa fica como está + warning em `unresolved`.
 */
export function substituteImagePlaceholders(
  html: string,
  filenameMap: Map<string, string>,
): SubstitutionResult {
  const unresolved: string[] = [];
  let substitutions = 0;

  const result = html.replace(/\{\{IMG:([^}]+)\}\}/g, (match, filename: string) => {
    const url = filenameMap.get(filename.trim());
    if (url) {
      substitutions++;
      return url;
    }
    unresolved.push(filename.trim());
    return match; // mantém placeholder se não resolvido
  });

  return { html: result, substitutions, unresolved: [...new Set(unresolved)] };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const htmlArg = args.html;
  const imagesArg = args.images;
  const outArg = args.out;

  if (!htmlArg || !imagesArg) {
    console.error(
      "Uso: substitute-image-urls.ts --html <input.html> --images <images.json> [--out <output.html>]",
    );
    process.exit(1);
  }

  const htmlPath = resolve(ROOT, htmlArg);
  const imagesPath = resolve(ROOT, imagesArg);

  const html = readFileSync(htmlPath, "utf8");
  const imagesFile = JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesFile;
  const map = buildFilenameMap(imagesFile.images ?? {});

  const result = substituteImagePlaceholders(html, map);

  if (result.unresolved.length > 0) {
    console.error(
      `⚠️  ${result.unresolved.length} placeholder(s) não resolvida(s): ${result.unresolved.join(", ")}`,
    );
    console.error("   Placeholders mantidas no HTML. Editor precisa substituir manualmente.");
  }

  if (outArg) {
    const outPath = resolve(ROOT, outArg);
    writeFileSync(outPath, result.html, "utf8");
    console.log(
      JSON.stringify(
        {
          out_path: outPath,
          substitutions: result.substitutions,
          unresolved: result.unresolved,
        },
        null,
        2,
      ),
    );
  } else {
    process.stdout.write(result.html);
  }

  // Exit 2 se placeholders não resolvidas — sinaliza erro pro caller (orchestrator)
  // sem precisar parsear stdout JSON. Output ainda é escrito (HTML com placeholders
  // intactas) pra editor recuperar o que deu certo.
  if (result.unresolved.length > 0) {
    process.exit(2);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
