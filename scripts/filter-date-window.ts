/**
 * filter-date-window.ts
 *
 * Filtra artigos pela janela de publicação, removendo os que estão
 * fora do intervalo [cutoff, edition_date].
 *
 * Uso:
 *   npx tsx scripts/filter-date-window.ts \
 *     --articles <verified.json> \
 *     --edition-date YYYY-MM-DD \
 *     --window-days 3 \
 *     [--out <out.json>]
 *
 * Input:  objeto JSON com chaves { lancamento, pesquisa, noticias },
 *         cada uma contendo array de artigos com campo `date` (YYYY-MM-DD ou null).
 *
 * Output: { kept: { lancamento, pesquisa, noticias }, removed: [...] }
 *         `removed` inclui motivo e detalhes para log.
 *
 * Artigos com date=null são mantidos (benefício da dúvida) mas marcados
 * com `date_unverified: true`.
 */

import { readFileSync, writeFileSync } from "node:fs";

interface Article {
  url: string;
  title?: string;
  date: string | null;
  date_unverified?: boolean;
  [key: string]: unknown;
}

interface CategorizedInput {
  lancamento: Article[];
  pesquisa: Article[];
  noticias: Article[];
}

interface RemovedEntry {
  url: string;
  title?: string;
  date: string | null;
  bucket: string;
  reason: "date_window";
  detail: string;
}

function parseArgs(argv: string[]) {
  let articles = "";
  let editionDate = "";
  let windowDays = 3;
  let out = "";

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--articles":
        articles = argv[++i];
        break;
      case "--edition-date":
        editionDate = argv[++i];
        break;
      case "--window-days":
        windowDays = parseInt(argv[++i], 10);
        break;
      case "--out":
        out = argv[++i];
        break;
    }
  }

  if (!articles || !editionDate || isNaN(windowDays) || windowDays < 1) {
    console.error(
      "Uso: filter-date-window.ts --articles <file> --edition-date YYYY-MM-DD --window-days N [--out <file>]"
    );
    process.exit(1);
  }

  return { articles, editionDate, windowDays, out };
}

function main() {
  const { articles: articlesPath, editionDate, windowDays, out } = parseArgs(process.argv);

  const input: CategorizedInput = JSON.parse(readFileSync(articlesPath, "utf8"));

  // Calculate cutoff: edition_date - window_days
  const edDate = new Date(editionDate + "T00:00:00Z");
  edDate.setUTCDate(edDate.getUTCDate() - windowDays);
  const cutoff = edDate.toISOString().split("T")[0]; // YYYY-MM-DD

  console.error(`filter-date-window: edition=${editionDate}, window=${windowDays}d, cutoff=${cutoff}`);

  const removed: RemovedEntry[] = [];
  const kept: CategorizedInput = { lancamento: [], pesquisa: [], noticias: [] };

  for (const bucket of ["lancamento", "pesquisa", "noticias"] as const) {
    for (const article of input[bucket] || []) {
      if (article.date == null) {
        // No date — keep with warning
        kept[bucket].push({ ...article, date_unverified: true });
        continue;
      }

      // Normalize date to YYYY-MM-DD for comparison
      const normDate = article.date.slice(0, 10); // handles ISO strings

      if (normDate < cutoff) {
        removed.push({
          url: article.url,
          title: article.title,
          date: article.date,
          bucket,
          reason: "date_window",
          detail: `date ${normDate} < cutoff ${cutoff} (edition ${editionDate} - ${windowDays}d)`,
        });
      } else {
        kept[bucket].push(article);
      }
    }
  }

  const totalInput =
    (input.lancamento?.length || 0) +
    (input.pesquisa?.length || 0) +
    (input.noticias?.length || 0);

  const totalKept =
    kept.lancamento.length + kept.pesquisa.length + kept.noticias.length;

  console.error(
    `filter-date-window: ${totalInput} input → ${totalKept} kept, ${removed.length} removed`
  );

  if (removed.length > 0) {
    console.error("Removed:");
    for (const r of removed) {
      console.error(`  [${r.bucket}] ${r.title || r.url} — ${r.detail}`);
    }
  }

  const result = { kept, removed };

  if (out) {
    writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
    console.error(`Wrote to ${out}`);
  } else {
    process.stdout.write(JSON.stringify(result, null, 2));
  }
}

main();
