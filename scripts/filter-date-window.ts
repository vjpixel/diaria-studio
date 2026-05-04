/**
 * filter-date-window.ts
 *
 * Filtra artigos pela janela de publicação, removendo os que estão
 * mais antigos que o cutoff (anchor − window_days).
 *
 * Anchor: por default `today` (UTC) — a janela cobre os últimos N dias do
 * ponto de vista de quem está rodando o pipeline (#560). Edições agendadas
 * pra publicar dias à frente (test_mode, /diaria-edicao com data futura) já
 * não filtram conteúdo da semana corrente, que é o que importa pra pesquisa.
 *
 * Override explícito via `--anchor-date YYYY-MM-DD` quando se quer
 * reproduzir a janela de uma run histórica ou simular publicação atrasada.
 *
 * `--edition-date` continua sendo aceito como metadata (vai pro log/cabeçalho
 * do removed[]), mas não influencia mais o cutoff.
 *
 * Uso:
 *   npx tsx scripts/filter-date-window.ts \
 *     --articles <verified.json> \
 *     --window-days 3 \
 *     [--anchor-date YYYY-MM-DD] \
 *     [--edition-date YYYY-MM-DD] \
 *     [--out <out.json>]
 *
 * Input:  objeto JSON com chaves { lancamento, pesquisa, noticias },
 *         cada uma contendo array de artigos com campo `date` (YYYY-MM-DD ou null).
 *
 * Output: { kept: { lancamento, pesquisa, noticias }, removed: [...], cutoff, anchor }
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
  tutorial?: Article[];
  /**
   * Campos extras (ex: `clusters[]` produzido por `topic-cluster.ts`, ou
   * metadata de stages futuros) são passados through inalterados pelo
   * `filterDateWindow` (#247). Sem isso, qualquer transformação intermediária
   * que produza campo novo precisa ser re-injetada manualmente pelo caller.
   */
  [key: string]: unknown;
}

interface RemovedEntry {
  url: string;
  title?: string;
  date: string | null;
  bucket: string;
  reason: "date_window";
  detail: string;
}

export function todayUtcIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function filterDateWindow(
  input: CategorizedInput,
  anchorDate: string,
  windowDays: number,
  editionDate?: string,
): {
  kept: Required<CategorizedInput>;
  removed: RemovedEntry[];
  cutoff: string;
  anchor: string;
} {
  const anDate = new Date(anchorDate + "T00:00:00Z");
  anDate.setUTCDate(anDate.getUTCDate() - windowDays);
  const cutoff = anDate.toISOString().split("T")[0];

  const removed: RemovedEntry[] = [];
  // Passthrough de campos extras (#247): `clusters[]` do topic-cluster, ou
  // qualquer metadata adicional do input. Os 4 buckets são reinicializados
  // logo abaixo — não tem como o spread lá em cima sobrescrever.
  const { lancamento, pesquisa, noticias, tutorial, ...rest } = input;
  void lancamento; void pesquisa; void noticias; void tutorial; // descartar — substituídos abaixo
  const kept: Required<CategorizedInput> = {
    ...rest,
    lancamento: [],
    pesquisa: [],
    noticias: [],
    tutorial: [],
  };

  const detailSuffix = editionDate
    ? ` (anchor ${anchorDate} - ${windowDays}d; edition ${editionDate})`
    : ` (anchor ${anchorDate} - ${windowDays}d)`;

  for (const bucket of ["lancamento", "pesquisa", "noticias", "tutorial"] as const) {
    for (const article of input[bucket] || []) {
      if (article.date == null) {
        kept[bucket].push({ ...article, date_unverified: true });
        continue;
      }
      const normDate = article.date.slice(0, 10);
      if (normDate < cutoff) {
        removed.push({
          url: article.url,
          title: article.title,
          date: article.date,
          bucket,
          reason: "date_window",
          detail: `date ${normDate} < cutoff ${cutoff}${detailSuffix}`,
        });
      } else {
        kept[bucket].push(article);
      }
    }
  }

  return { kept, removed, cutoff, anchor: anchorDate };
}

function parseArgs(argv: string[]) {
  let articles = "";
  let editionDate = "";
  let anchorDate = "";
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
      case "--anchor-date":
        anchorDate = argv[++i];
        break;
      case "--window-days":
        windowDays = parseInt(argv[++i], 10);
        break;
      case "--out":
        out = argv[++i];
        break;
    }
  }

  if (!articles || isNaN(windowDays) || windowDays < 1) {
    console.error(
      "Uso: filter-date-window.ts --articles <file> --window-days N [--anchor-date YYYY-MM-DD] [--edition-date YYYY-MM-DD] [--out <file>]"
    );
    process.exit(1);
  }

  return { articles, editionDate, anchorDate, windowDays, out };
}

function main() {
  const {
    articles: articlesPath,
    editionDate,
    anchorDate: anchorArg,
    windowDays,
    out,
  } = parseArgs(process.argv);

  const anchorDate = anchorArg || todayUtcIso();
  const input: CategorizedInput = JSON.parse(readFileSync(articlesPath, "utf8"));

  const { kept, removed, cutoff, anchor } = filterDateWindow(
    input,
    anchorDate,
    windowDays,
    editionDate || undefined,
  );

  const editionTag = editionDate ? `, edition=${editionDate}` : "";
  console.error(
    `filter-date-window: anchor=${anchor}${editionTag}, window=${windowDays}d, cutoff=${cutoff}`,
  );

  const totalInput =
    (input.lancamento?.length || 0) +
    (input.pesquisa?.length || 0) +
    (input.noticias?.length || 0) +
    (input.tutorial?.length || 0);

  const totalKept =
    kept.lancamento.length + kept.pesquisa.length + kept.noticias.length + kept.tutorial.length;

  console.error(
    `filter-date-window: ${totalInput} input → ${totalKept} kept, ${removed.length} removed`
  );

  if (removed.length > 0) {
    console.error("Removed:");
    for (const r of removed) {
      console.error(`  [${r.bucket}] ${r.title || r.url} — ${r.detail}`);
    }
  }

  const result = { kept, removed, cutoff, anchor };

  if (out) {
    writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
    console.error(`Wrote to ${out}`);
  } else {
    process.stdout.write(JSON.stringify(result, null, 2));
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
