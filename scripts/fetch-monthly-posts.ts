/**
 * fetch-monthly-posts.ts (#403; migrado pra ler de Kit atrás da flag, #6184)
 *
 * Substitui o subagente `collect-monthly-runner` por script determinístico
 * que usa a API REST (Beehiiv ou Kit — `platform.config.json` →
 * `publishing.newsletter.backend`, via `scripts/lib/shared/newsletter-read-source.ts`)
 * diretamente. Elimina dependência de MCP em subagente (MCPs nativos do
 * Claude.ai não são repassados a subagentes).
 *
 * Busca todos os posts publicados no mês e grava o markdown bruto em
 * `data/monthly/{ciclo}/raw-posts/post_{id8}_{AAMMDD}.txt`.
 *
 * Uso (#1962 — novo):
 *   npx tsx scripts/fetch-monthly-posts.ts --cycle 2605-06
 *
 * Compat (legado — ainda aceito com aviso):
 *   npx tsx scripts/fetch-monthly-posts.ts 2604
 *
 * Variáveis de ambiente (dotenv carregado automaticamente):
 *   BEEHIIV_API_KEY (backend "beehiiv") ou KIT_API_KEY (backend "kit") —
 *   obrigatória, conforme `publishing.newsletter.backend`.
 *
 * Nota (#6184): `convertBeehiivHtmlToMarkdown` (nome do arquivo original)
 * roda igual para conteúdo Kit — não foi verificado ao vivo que o parser
 * lida bem com o HTML do Kit (shape pode diferir do Beehiiv); o fallback de
 * gravar HTML bruto (#2794) cobre a lacuna sem falhar silenciosamente.
 *
 * Output (stdout): JSON { yymm, cycle, posts_found, downloaded, skipped_existing,
 *                         posts_with_html_fallback, out_dir, warnings }
 */

import "dotenv/config";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseMonthlyCycleArg,
  cycleToYymm,
  monthlyDir as resolveMonthlyDir,
} from "./lib/mensal/monthly-paths.ts";
import { convertBeehiivHtmlToMarkdown } from "./lib/mensal/monthly-html-convert.ts";
import {
  resolveNewsletterReadConfig,
  listNewsletterPostsInWindow,
  fetchNewsletterPostContent,
  type NormalizedNewsletterPost,
} from "./lib/shared/newsletter-read-source.ts"; // #6184
import { isMainModule } from "./lib/cli-args.ts";

function yyymmToWindow(yymm: string): { start: Date; end: Date } {
  const year = 2000 + parseInt(yymm.slice(0, 2), 10);
  const month = parseInt(yymm.slice(2, 4), 10);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)), // exclusive
  };
}

function id8(postId: string): string {
  return postId.replace(/^post_/, "").slice(0, 8);
}

/** #6184: `NormalizedNewsletterPost.publishedAtIso` é ISO 8601 nos dois
 *  backends (Beehiiv era Unix seconds antes desta migração — a conversão
 *  agora acontece dentro de `newsletter-read-source.ts`, não aqui). */
function toAammddFromIso(iso: string): string {
  const d = new Date(iso);
  return (
    String(d.getUTCFullYear()).slice(2) +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

export async function main() {
  // Aceita --cycle 2605-06 (novo) ou argumento posicional 2604 (legado compat).
  const cycle = parseMonthlyCycleArg(process.argv.slice(2));
  if (!cycle) {
    console.error(
      "Uso: npx tsx scripts/fetch-monthly-posts.ts --cycle YYMM-MM\n" +
      "  Ex: npx tsx scripts/fetch-monthly-posts.ts --cycle 2605-06\n" +
      "Compat (com aviso): npx tsx scripts/fetch-monthly-posts.ts 2604",
    );
    process.exit(2);
  }

  const yymm = cycleToYymm(cycle);

  // #6184: resolve backend (Beehiiv ou Kit) + credenciais correspondentes.
  const readConfigResult = resolveNewsletterReadConfig();
  if (!readConfigResult.ok) {
    console.error(readConfigResult.reason);
    process.exit(1);
  }
  const readConfig = readConfigResult.config;

  const win = yyymmToWindow(yymm);
  // Usar monthlyDir com allowLegacyFallback: false — escrita SEMPRE no formato novo
  const editionDir = resolveMonthlyDir(cycle, { allowLegacyFallback: false });
  const outDir = resolve(editionDir, "raw-posts");
  mkdirSync(outDir, { recursive: true });

  process.stderr.write(
    `[fetch-monthly-posts] ${cycle}: ${win.start.toISOString().slice(0, 10)} → ${win.end.toISOString().slice(0, 10)}\n`,
  );

  const posts: NormalizedNewsletterPost[] = await listNewsletterPostsInWindow(readConfig, {
    startMs: win.start.getTime(),
    endMs: win.end.getTime(),
  });
  process.stderr.write(`[fetch-monthly-posts] ${posts.length} posts no mês\n`);

  const warnings: string[] = [];
  let downloaded = 0;
  let skipped = 0;
  let htmlFallback = 0;

  for (const post of posts) {
    // `publishedAtIso` é `string` NÃO-nulo (#6362 item 5) —
    // `listNewsletterPostsInWindow` só inclui posts com timestamp
    // parseável, e o tipo agora reflete isso (nunca mais um cast/`as string`
    // assumindo o que o tipo já deveria garantir).
    const filename = `post_${id8(post.id)}_${toAammddFromIso(post.publishedAtIso)}.txt`;
    const filepath = resolve(outDir, filename);

    if (existsSync(filepath)) {
      skipped++;
      continue;
    }

    process.stderr.write(`  ↓ ${filename}\n`);
    const content = await fetchNewsletterPostContent(readConfig, post.id);

    let text: string;
    if (content.html) {
      // #2791: sem markdown, converte o HTML pro pseudo-markdown que
      // collect-monthly.ts (parsePost/splitSections) já sabe parsear —
      // em vez de gravar HTML bruto, que o parser não entende (0 destaques).
      htmlFallback++;
      const converted = convertBeehiivHtmlToMarkdown(content.html, filename);
      warnings.push(...converted.warnings);
      if (converted.destaquesFound > 0) {
        text = converted.markdown;
      } else {
        // Conservador (#2794): nunca falha silenciosa — se a conversão não
        // achou nada limpo, grava o HTML bruto mesmo (comportamento antigo)
        // e deixa o warning acima explícito pro editor investigar.
        text = content.html;
        warnings.push(`${filename}: gravado HTML bruto (fallback da conversão) — parser provavelmente zera destaques`);
      }
    } else {
      warnings.push(`${filename}: sem conteúdo — pulado`);
      continue;
    }

    writeFileSync(filepath, text, "utf8");
    downloaded++;
  }

  if (posts.length === 0) {
    warnings.push("Nenhum post encontrado no mês — verificar credenciais/backend (BEEHIIV_API_KEY+publicationId ou KIT_API_KEY).");
  }

  console.log(
    JSON.stringify({
      yymm,
      cycle,
      posts_found: posts.length,
      downloaded,
      skipped_existing: skipped,
      posts_with_html_fallback: htmlFallback,
      out_dir: `data/monthly/${cycle}/raw-posts/`,
      warnings,
    }),
  );
}

// Guard contra import em tests — só rodar main() quando invocado como CLI
// (mesmo padrão de refresh-dedup.ts/refresh-past-editions.ts, #6184).
if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
