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
import { TeaserCutError, buildArticleHtml, buildArticleTeaserHtml } from "./lib/mensal/build-article-page.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { DIARIA_RETROSPECTIVA_URL } from "./lib/canonical-urls.ts";
import { readRetrospectivaNamespaceId } from "./lib/shared/retrospectiva-kv-namespaces.ts";
import { mensalPathFromCycle } from "./lib/shared/retrospectiva-path.ts";

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
  return readRetrospectivaNamespaceId("ARTICLES");
}

/**
 * Chave do KV a partir do CICLO do repo (`YYMM-MM`).
 *
 * #7658: a chave passou a ser derivada do PATH público (`mensalPathFromCycle`,
 * `article:2607`), não mais o ciclo cru (`article:2607-08`). É a mesma função
 * que o Worker usa pra classificar a URL — se as duas divergirem, o publisher
 * grava numa chave que o Worker nunca lê, e o sintoma é 404 com o conteúdo
 * publicado do lado.
 *
 * Lança em ciclo malformado: gravar sob uma chave inventada seria pior que
 * falhar aqui, porque só apareceria como página faltando semanas depois.
 */
export function articleKvKey(cycle: string): string {
  const path = mensalPathFromCycle(cycle);
  if (!path) {
    throw new Error(
      `ciclo "${cycle}" não vira path de retrospectiva (esperado YYMM-MM, ex: 2607-08) — ` +
        "recusando gravar sob uma chave que o Worker não leria.",
    );
  }
  return `article:${path}`;
}

/**
 * Chave do TRECHO público no KV (#7580).
 *
 * Sufixo `:teaser` na mesma chave do artigo — o Worker escolhe qual ler pelo
 * resultado do gate, sem precisar de um segundo namespace nem de convenção de
 * nome paralela.
 */
export function articleTeaserKvKey(cycle: string): string {
  return `${articleKvKey(cycle)}:teaser`;
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
      `[build-article-page] --push: enviando ${articleKvKey(cycle)} (${page.html.length} bytes) pro KV ARTICLES...`,
    );
    await uploadTextToWorkerKV(page.html, articleKvKey(cycle), {
      kvNamespaceId: articleKvNamespaceId(),
      contentType: "text/html; charset=utf-8",
    });
    // O TRECHO é secundário ao artigo: falhar em cortá-lo não pode impedir a
    // publicação do artigo completo, que é o que o apoiador paga para ler. Sem
    // `:teaser` no KV o Worker cai no paywall seco — fail-closed, o
    // não-apoiador simplesmente não vê conteúdo, que é o comportamento de
    // antes desta issue. O ciclo 2604-05 cai aqui de propósito: é anterior à
    // convenção `**DESTAQUE N | TEMA**` e não tem onde cortar.
    try {
      const trecho = buildArticleTeaserHtml(draftMd, cycle);
      console.error(
        `[build-article-page] --push: enviando ${articleTeaserKvKey(cycle)} (${trecho.html.length} bytes, ` +
          `${Math.round((trecho.html.length / page.html.length) * 100)}% do artigo)...`,
      );
      await uploadTextToWorkerKV(trecho.html, articleTeaserKvKey(cycle), {
        kvNamespaceId: articleKvNamespaceId(),
        contentType: "text/html; charset=utf-8",
      });
    } catch (e) {
      if (!(e instanceof TeaserCutError)) throw e;
      console.error(
        `[build-article-page] AVISO: trecho NÃO publicado — ${e.message}. ` +
          `O artigo completo foi publicado normalmente; o não-apoiador verá o paywall sem trecho.`,
      );
    }
    console.error(
      `[build-article-page] push concluído. URL pública: ${DIARIA_RETROSPECTIVA_URL}/${mensalPathFromCycle(cycle)}`,
    );
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
