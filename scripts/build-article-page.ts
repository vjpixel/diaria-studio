#!/usr/bin/env node
/**
 * scripts/build-article-page.ts (#3940)
 *
 * CLI: lê `data/monthly/{cycle}/draft.md`, gera o HTML público do artigo
 * mensal (`buildArticleHtml`, `scripts/lib/mensal/build-article-page.ts`) e
 * imprime em stdout (ou grava em `--out <path>`). Com `--push` (+
 * credenciais Cloudflare no env), grava no KV `ARTICLES` do worker
 * `artigo-mensal` sob a chave `article:{cycle}` — mesmo padrão de
 * `scripts/clarice-db-summary.ts` (`uploadTextToWorkerKV`).
 *
 * IMPORTANTE (#3940 — escopo desta unidade): `--push` NUNCA foi executado
 * nesta sessão. `ARTICLE_KV_NAMESPACE_ID` ainda é placeholder em
 * `workers/artigo-mensal/wrangler.toml` até o 1º
 * `wrangler kv namespace create` (próximo passo manual do editor, ver
 * `workers/artigo-mensal/README.md`).
 *
 * Uso:
 *   npx tsx scripts/build-article-page.ts --cycle 2607-08 [--out path.html] [--push]
 *
 * Sem `--out` e sem `--push`: imprime o HTML em stdout (dry-run puro).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { requireMonthlyCycleArg, monthlyDir } from "./lib/mensal/monthly-paths.ts";
import { buildArticleHtml, buildArticleTeaser } from "./lib/mensal/build-article-page.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { DIARIA_ARTIGO_URL } from "./lib/canonical-urls.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");

/**
 * KV namespace ID do binding `ARTICLES` em `workers/artigo-mensal/wrangler.toml`.
 * Placeholder até o editor rodar `wrangler kv namespace create ARTICLES --remote`
 * (deploy real fora do escopo desta unidade, #3940).
 */
export const ARTICLE_KV_NAMESPACE_ID = "REPLACE_ME_APOS_CRIAR_NAMESPACE_ARTICLES";

export function articleKvKey(cycle: string): string {
  return `article:${cycle}`;
}

/** #7580: key do TREASER (capa do artigo servida aos não-apoiadores). */
export function articleTeaserKvKey(cycle: string): string {
  return `article:${cycle}:teaser`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cycle = requireMonthlyCycleArg(argv);
  const draftPath = resolve(monthlyDir(cycle), "draft.md");

  let draftMd: string;
  try {
    draftMd = readFileSync(draftPath, "utf-8");
  } catch (e) {
    console.error(`build-article-page: falha lendo ${draftPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  // #7580: `--teaser` gera o trecho do não-apoiador (capa + shell web com
  // og:* + canonical + CTA de apoio). Sem a flag, comportamento inalterado:
  // artigo completo. `--push` e `--push-teaser` são mutuamente exclusivos
  // com `--out` só no sentido de que o --out escreve o HTML gerado; o push
  // grava no KV e NUNCA é executado nesta sessão (nenhuma ação de
  // publicação/deploy — ver PR body).
  const teaser = hasFlag(argv, "teaser");
  const page = teaser ? buildArticleTeaser(draftMd, cycle) : buildArticleHtml(draftMd, cycle);

  const outPath = getArg(argv, "out");
  if (outPath) {
    writeFileSync(resolve(REPO_ROOT, outPath), page.html, "utf-8");
    console.error(`[build-article-page] gravado em ${outPath} (${page.html.length} bytes)`);
  } else {
    process.stdout.write(page.html);
  }

  if (hasFlag(argv, "push")) {
    if (teaser) {
      console.error(
        "[build-article-page] --teaser + --push: enviando article:{cycle}:teaser pro KV ARTICLES...",
      );
    }
    const key = teaser ? articleTeaserKvKey(cycle) : articleKvKey(cycle);
    console.error(`[build-article-page] --push: enviando ${key} (${page.html.length} bytes) pro KV ARTICLES...`);
    await uploadTextToWorkerKV(page.html, key, {
      kvNamespaceId: ARTICLE_KV_NAMESPACE_ID,
      contentType: "text/html; charset=utf-8",
    });
    console.error(`[build-article-page] push concluído. URL pública: ${DIARIA_ARTIGO_URL}/${cycle}`);
  } else {
    console.error(
      `[build-article-page] dry-run (default) — HTML gerado (${page.html.length} bytes), NENHUM push ao KV. Use --push (artigo completo) ou --push-teaser (trecho) para gravar.`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`build-article-page: erro fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
