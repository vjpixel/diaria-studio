/**
 * fetch-sitemap.ts (#761)
 *
 * CLI wrapper para `scripts/lib/fetch-sitemap.ts`. Mirror do `fetch-rss.ts`
 * em interface — orchestrator stage-1 dispatcha quando a URL na coluna RSS
 * de `seed/sources.csv` termina em `sitemap.xml`.
 *
 * Uso:
 *   npx tsx scripts/fetch-sitemap.ts --url https://research.perplexity.ai/sitemap.xml --source "Perplexity Research" [--days 4]
 *
 * Output: JSON com shape compatível com `source-researcher`/`fetch-rss`:
 *   { source, method: "sitemap", sitemap_url, articles: [{url, title, published_at, summary}], error? }
 *
 * Exit codes: 0 sucesso, 2 se `error` populado, 1 erro de uso.
 */

import { fetchSitemapEntries } from "./lib/fetch-sitemap.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const url = getArg(argv, "url") || undefined;
  const sourceName = getArg(argv, "source") || "unknown";
  const daysArg = getArg(argv, "days") || undefined;
  const days = daysArg ? Number(daysArg) : 4;

  if (!url) {
    console.error(
      "Uso: tsx fetch-sitemap.ts --url <sitemap_url> --source <name> [--days 4]",
    );
    process.exit(1);
  }

  const result = await fetchSitemapEntries({ url, sourceName, days });
  console.log(JSON.stringify(result, null, 2));
  if (result.error) process.exit(2);
}

const invokedDirectly = isMainModule(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
