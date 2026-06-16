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
 *     [--out <output.html>] \
 *     [--reviewed-md <02-reviewed.md>]
 *
 * Output: HTML com placeholders substituídos. Se alguma placeholder
 * não tiver imagem correspondente, loga warning e mantém a placeholder
 * como está (editor precisa resolver manualmente).
 *
 * #2316: fail-loud guard — se o HTML de input for mais antigo que
 * 02-reviewed.md (render não rodou após a última edição), aborta com
 * exit code 3 em vez de substituir placeholders num HTML stale.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mtimeMs } from "./lib/mtime.ts"; // #2316 fail-loud stale guard

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
 * #2316: Verifica se o HTML de input (newsletter-draft.html) existe e está
 * atualizado (mais novo que 02-reviewed.md). Retorna mensagem de erro quando:
 *   - HTML ausente (render não produziu o arquivo)
 *   - HTML mais antigo que reviewed.md (render rodou antes da última edição)
 * Retorna `null` quando ok ou quando reviewed.md não existe (fail-open: sem
 * reviewed.md = fora de pipeline normal = sem guard).
 *
 * Pure — não lança exceção, não tem side-effects. Caller decide o que fazer.
 *
 * @param htmlInputPath  Path do HTML de entrada do substitute (newsletter-draft.html).
 * @param reviewedMdPath Path do 02-reviewed.md da edição.
 */
export function checkInputHtmlFreshness(
  htmlInputPath: string,
  reviewedMdPath: string,
): string | null {
  const mdMtime = mtimeMs(reviewedMdPath);
  if (mdMtime === null) return null; // 02-reviewed.md ausente — sem guard.

  const htmlMtime = mtimeMs(htmlInputPath);
  // #2316 fail-loud: HTML ausente = render não rodou (ou falhou). Erro acionável
  // antes de chegar no readFileSync que daria ENOENT opaco.
  if (htmlMtime === null) {
    return (
      `[substitute-image-urls] ERRO: HTML de input não encontrado — ` +
      `${htmlInputPath} não existe. ` +
      `O render-newsletter-html.ts não produziu o arquivo (falhou silenciosamente?). ` +
      `Re-rode o render antes de substituir as imagens: ` +
      `npx tsx scripts/render-newsletter-html.ts <edition-dir> --format html --out ${htmlInputPath}`
    );
  }

  if (htmlMtime < mdMtime) {
    return (
      `[substitute-image-urls] ERRO: HTML de input está desatualizado — ` +
      `mtime(${htmlInputPath})=${new Date(htmlMtime).toISOString()} < ` +
      `mtime(${reviewedMdPath})=${new Date(mdMtime).toISOString()}. ` +
      `O render-newsletter-html.ts não rodou (ou falhou) após a última edição de 02-reviewed.md. ` +
      `Re-rode o render antes de substituir as imagens: ` +
      `npx tsx scripts/render-newsletter-html.ts <edition-dir> --format html --out ${htmlInputPath}`
    );
  }

  return null;
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
  // #2316: --reviewed-md pode ser explícito ou auto-deduzido a partir do path
  // do HTML de entrada (newsletter-draft.html → ../../02-reviewed.md).
  const reviewedMdArg = args["reviewed-md"];

  if (!htmlArg || !imagesArg) {
    console.error(
      "Uso: substitute-image-urls.ts --html <input.html> --images <images.json> " +
        "[--out <output.html>] [--reviewed-md <02-reviewed.md>]",
    );
    process.exit(1);
  }

  const htmlPath = resolve(ROOT, htmlArg);
  const imagesPath = resolve(ROOT, imagesArg);

  // #2316: fail-loud guard — abortar se HTML de input é mais antigo que
  // 02-reviewed.md (render falhou ou não rodou). Auto-detecta o reviewed-md
  // a partir do path padrão da pipeline (_internal/newsletter-draft.html →
  // ../../02-reviewed.md). Flag --reviewed-md permite override explícito.
  // Sem reviewed-md (nem explícito nem deduzível): sem guard (compatibilidade).
  {
    let resolvedReviewedMd: string | null = null;
    if (reviewedMdArg) {
      resolvedReviewedMd = resolve(ROOT, reviewedMdArg);
    } else {
      // Auto-detect: _internal/newsletter-draft.html → editionDir/02-reviewed.md
      // Path canônico da pipeline: data/editions/AAMMDD/_internal/newsletter-draft.html
      const htmlDir = dirname(htmlPath);
      const htmlDirName = htmlDir.split(/[/\\]/).pop() ?? "";
      if (htmlDirName === "_internal") {
        resolvedReviewedMd = resolve(htmlDir, "..", "02-reviewed.md");
      }
    }
    if (resolvedReviewedMd) {
      const stalenessError = checkInputHtmlFreshness(htmlPath, resolvedReviewedMd);
      if (stalenessError) {
        process.stderr.write(stalenessError + "\n");
        process.exit(3); // Exit 3 = HTML stale (distinto de outros erros: 1=args, 2=unresolved)
      }
    }
  }

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
