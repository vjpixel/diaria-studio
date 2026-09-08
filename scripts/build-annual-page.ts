#!/usr/bin/env node
/**
 * scripts/build-annual-page.ts (#7581)
 *
 * CLI: lê `data/annual/{slug}/draft.md`, gera o HTML público da retrospectiva
 * anual (`buildAnnualHtml`/`buildAnnualTeaserHtml`,
 * `scripts/lib/anual/build-annual-page.ts`) e imprime em stdout (ou grava em
 * `--out <path>`). Com `--push` (+ credenciais Cloudflare no env), grava no
 * KV `ARTICLES` do worker `anual` sob a chave `article:{slug}` (completo) e
 * `article:{slug}:teaser` (trecho) — mesmo padrão de
 * `scripts/build-article-page.ts` (#7580).
 *
 * Uso:
 *   npx tsx scripts/build-annual-page.ts --slug 2026-aniversario [--out path.html] [--push]
 *
 * Sem `--out` e sem `--push`: imprime o HTML completo em stdout (dry-run puro).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { annualPaths, themeIndexFromImageFilename } from "./lib/anual/annual-paths.ts";
import { tipoFromSlug } from "./lib/anual/annual-window.ts";
import { AnnualTeaserCutError, buildAnnualHtml, buildAnnualTeaserHtml } from "./lib/anual/build-annual-page.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { DIARIA_ANUAL_URL } from "./lib/canonical-urls.ts";
import { readAnnualNamespaceId } from "./lib/anual/annual-kv-namespaces.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");

/** Namespace KV do binding `ARTICLES` do worker `anual` — lido do
 * `wrangler.toml`, a mesma fonte que `wrangler deploy` consome. Função (não
 * `const`), mesma disciplina de `articleKvNamespaceId` em
 * `build-article-page.ts` — só resolve no caminho que grava. */
export function annualKvNamespaceId(): string {
  return readAnnualNamespaceId("ARTICLES");
}

export function annualKvKey(slug: string): string {
  return `article:${slug}`;
}

export function annualTeaserKvKey(slug: string): string {
  return `${annualKvKey(slug)}:teaser`;
}

export async function main(argv: string[] = process.argv.slice(2), rootDir: string = REPO_ROOT): Promise<void> {
  const args = parseCliArgs(argv);
  const log = (m: string) => process.stderr.write(`[build-annual-page] ${m}\n`);
  const slug = args.values.slug;
  if (!slug) {
    log("uso: --slug 2026-aniversario [--out path.html] [--push]");
    process.exitCode = 1;
    return;
  }

  const paths = annualPaths(slug, resolve(rootDir, "data/annual"));
  let draftMd: string;
  try {
    draftMd = readFileSync(paths.draft, "utf8");
  } catch (e) {
    log(`falha lendo ${paths.draft}: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const tipo = tipoFromSlug(slug);
  const windowLabel = args.values["window-label"] ?? slug;

  const publicImages: Record<string, string> = (() => {
    try {
      return JSON.parse(readFileSync(paths.publicImages, "utf8"));
    } catch {
      return {};
    }
  })();
  const images: Record<number, string> = {};
  for (const [url, filename] of Object.entries(publicImages)) {
    const n = themeIndexFromImageFilename(String(filename));
    if (n !== null) images[n] = url;
  }

  const page = buildAnnualHtml(draftMd, { windowLabel, tipo, images });

  const outPath = args.values.out;
  if (outPath) {
    writeFileSync(resolve(rootDir, outPath), page.html, "utf-8");
    log(`gravado em ${outPath} (${page.html.length} bytes)`);
  } else if (!hasFlag(argv, "push")) {
    process.stdout.write(page.html);
  }

  if (hasFlag(argv, "push")) {
    loadProjectEnv(rootDir);
    log(`--push: enviando ${annualKvKey(slug)} (${page.html.length} bytes) pro KV ARTICLES...`);
    await uploadTextToWorkerKV(page.html, annualKvKey(slug), {
      kvNamespaceId: annualKvNamespaceId(),
      contentType: "text/html; charset=utf-8",
    });
    // O TRECHO é secundário ao completo — falhar em cortá-lo (draft sem TEMA
    // 1 estruturado) não pode impedir a publicação do artigo completo, que é
    // o que quem passa no gate lê. Sem `:teaser` no KV o Worker cai no
    // paywall seco (ver workers/anual/src/render.ts).
    try {
      const trecho = buildAnnualTeaserHtml(draftMd, slug, { windowLabel, tipo, images });
      log(
        `--push: enviando ${annualTeaserKvKey(slug)} (${trecho.html.length} bytes, ` +
          `${Math.round((trecho.html.length / page.html.length) * 100)}% do completo)...`,
      );
      await uploadTextToWorkerKV(trecho.html, annualTeaserKvKey(slug), {
        kvNamespaceId: annualKvNamespaceId(),
        contentType: "text/html; charset=utf-8",
      });
    } catch (e) {
      if (!(e instanceof AnnualTeaserCutError)) throw e;
      log(`AVISO: trecho NÃO publicado — ${e.message}. O completo foi publicado normalmente.`);
    }
    log(`push concluído. URL pública: ${DIARIA_ANUAL_URL}/${slug}`);
  } else if (!outPath) {
    log(`dry-run (default) — HTML gerado (${page.html.length} bytes), NENHUM push ao KV. Use --push para gravar.`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`build-annual-page: erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
