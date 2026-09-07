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
 * HISTÓRICO (#3940 → #7580): por dois meses `--push` nunca foi executado, e o
 * namespace era um literal `REPLACE_ME_...` que o `wrangler.toml` já tinha
 * substituído pelo id real — divergência que só se manifestava ao GRAVAR, num
 * 400 do Cloudflare. Em 07/09/2026 os 5 ciclos com `draft.md` foram
 * publicados; o namespace passou a ser lido do `wrangler.toml` (ver
 * `articleKvNamespaceId` abaixo) e não pode mais divergir.
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
import { buildArticleHtml } from "./lib/mensal/build-article-page.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { DIARIA_ARTIGO_URL } from "./lib/canonical-urls.ts";
import { readArtigoMensalNamespaceId } from "./lib/mensal/artigo-mensal-kv-namespaces.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");

/**
 * Namespace KV do binding `ARTICLES`, lido de
 * `workers/artigo-mensal/wrangler.toml` — a MESMA fonte que o `wrangler deploy`
 * consome.
 *
 * Função, e não `const` de módulo: a leitura acontece só no caminho que grava.
 * Como `const` ela rodava no IMPORT, acoplando qualquer uso deste arquivo
 * (dry-run, teste que importe um helper daqui) à existência e ao formato do
 * `wrangler.toml`, com exceção de carga de módulo antes de qualquer tratamento
 * de erro do `main()`. Mesma disciplina do `loadProjectEnv`, que já é escopado
 * ao push (achado do review da PR #7592).
 */
export function articleKvNamespaceId(): string {
  return readArtigoMensalNamespaceId("ARTICLES");
}

export function articleKvKey(cycle: string): string {
  return `article:${cycle}`;
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

  const page = buildArticleHtml(draftMd, cycle);

  const outPath = getArg(argv, "out");
  if (outPath) {
    writeFileSync(resolve(REPO_ROOT, outPath), page.html, "utf-8");
    console.error(`[build-article-page] gravado em ${outPath} (${page.html.length} bytes)`);
  } else {
    process.stdout.write(page.html);
  }

  if (hasFlag(argv, "push")) {
    // `uploadTextToWorkerKV` lê CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN
    // do ambiente, e nada na cadeia de imports deste script carregava o
    // `.env` (o de allowlist carregava, por outro caminho) — o `--push`
    // morria com "não definidos" mesmo com as chaves no arquivo. Só no
    // caminho de push: o dry-run não precisa de credencial nenhuma.
    loadProjectEnv(REPO_ROOT);
    console.error(
      `[build-article-page] --push: enviando article:${cycle} (${page.html.length} bytes) pro KV ARTICLES...`,
    );
    await uploadTextToWorkerKV(page.html, articleKvKey(cycle), {
      kvNamespaceId: articleKvNamespaceId(),
      contentType: "text/html; charset=utf-8",
    });
    console.error(`[build-article-page] push concluído. URL pública: ${DIARIA_ARTIGO_URL}/${cycle}`);
  } else {
    console.error(
      `[build-article-page] dry-run (default) — HTML gerado (${page.html.length} bytes), NENHUM push ao KV. Use --push para gravar.`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`build-article-page: erro fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
