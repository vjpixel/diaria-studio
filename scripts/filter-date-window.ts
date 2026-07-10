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
 * Input:  objeto JSON com chaves { lancamento, radar, use_melhor, video },
 *         cada uma contendo array de artigos com campo `date` (YYYY-MM-DD ou null).
 *
 * Output: { kept: { lancamento, radar, use_melhor, video }, removed: [...], cutoff, anchor }
 *         `removed` inclui motivo e detalhes para log.
 *
 * Artigos com date=null são mantidos (benefício da dúvida) mas marcados
 * com `date_unverified: true`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isMainModule } from "./lib/cli-args.ts";

interface Article {
  url: string;
  title?: string;
  /**
   * Data canônica (YYYY-MM-DD) extraída por `verify-dates.ts` lendo o HTML
   * da página. `null` quando fetch falhou (`fetch_failed`) e a verificação
   * não rolou.
   */
  date: string | null;
  /**
   * Data crua do RSS feed (formato ISO ou YYYY-MM-DD). Fallback usado quando
   * `date` é null mas o RSS já trouxe data confiável (#1322). Preferimos
   * `date` (verificado) sobre `published_at` (não-verificado) quando os dois
   * existem.
   */
  published_at?: string | null;
  /**
   * #1631: data extraída da página por `verify-accessibility` (og:article:
   * published_time, JSON-LD, etc — 7 estratégias do extract-date.ts). Costuma
   * ser reconciliada em `date` pelo research-review-dates, mas quando um bucket
   * pula essa etapa (caso histórico do `tutorial`/`use_melhor`, #1628) o campo
   * chegava aqui ignorado → tutorial datado parecia sem data. effectiveDate
   * agora honra esse campo como fallback não-verificado.
   */
  published_date?: string | null;
  date_unverified?: boolean;
  /**
   * #1992: artigo de fonte low-cadence — os N mais recentes bypassam a janela
   * de data para que fontes que postam ~1×/mês não sejam sempre descartadas.
   */
  bypass_date_window?: boolean;
  [key: string]: unknown;
}

/**
 * Resolve effective date: prefer verified `date`, fallback to `published_at`
 * from RSS. Returns YYYY-MM-DD slice or null if both are missing/invalid
 * (#1322).
 */
export function effectiveDate(article: {
  date?: string | null;
  published_at?: string | null;
  published_date?: string | null;
}): { value: string | null; source: "date" | "published_date" | "published_at" | null } {
  if (article.date) return { value: article.date.slice(0, 10), source: "date" };
  // #1631: published_date (extraído da página por verify-accessibility) é um
  // fallback não-verificado — preferido sobre published_at (RSS pubDate) por
  // vir de metadata estruturada (JSON-LD/og). Ambos marcam date_unverified.
  if (article.published_date) {
    return { value: article.published_date.slice(0, 10), source: "published_date" };
  }
  if (article.published_at) {
    return { value: article.published_at.slice(0, 10), source: "published_at" };
  }
  return { value: null, source: null };
}

interface CategorizedInput {
  lancamento: Article[];
  radar: Article[];
  use_melhor: Article[];
  video?: Article[];
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
  /**
   * Qual campo a decisão usou — `date` (verificado por verify-dates) ou
   * `published_at` (fallback do RSS, #1322). Vai pro log pra editor saber
   * por que um artigo caiu.
   */
  source_field: "date" | "published_date" | "published_at";
  detail: string;
}

export function todayUtcIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * #1155: janela adaptativa por bucket. Cada tipo de conteúdo tem ciclo de vida
 * editorial diferente:
 *   - Lançamentos: notícias frescas, perdem relevância rápido (até 7 dias)
 *   - Pesquisas: papers/posts duram mais (até 5 dias)
 *   - Notícias: notícias gerais, prazo médio (3-4 dias = default windowDays)
 *   - Tutorial (#2312): evergreen — janela expandida para 60 dias (isolada do
 *     bucket use_melhor e dos demais buckets). Cookbooks e how-tos de qualidade
 *     não seguem o ciclo de notícias; 30d era curto demais para capturar bons
 *     tutoriais publicados há 1-2 meses. O valor 60 é parametrizado aqui —
 *     não toca janelas de LANÇAMENTO/RADAR/VÍDEO.
 *
 * Tradeoff: lançamentos com janela maior aumenta recall (não perdemos product
 * launches que demoram 1-2 dias pra aparecer no RSS). Notícias mais curta
 * aumenta precisão (só o que é REALMENTE recente vai pra leitor).
 */

/** Janela de use_melhor/tutorial em dias (#2312). Isolada — não afeta outros buckets. */
export const TUTORIAL_WINDOW_DAYS = 60;

export function bucketWindowDays(bucket: string, defaultDays: number): number {
  // #1629: a função recebe a `category` do artigo (não o bucket). Antes
  // bucket e category eram nomes idênticos; após o rename, bucket `radar`
  // agrupa articles de category `pesquisa` (5d) e `noticias` (3-4d) — então
  // a janela tem que ser per-article via category.
  switch (bucket) {
    case "lancamento":
      return Math.max(defaultDays, 7);
    case "pesquisa":
      return Math.max(defaultDays, 5);
    case "tutorial":
    case "use_melhor":
      // #2312: tutoriais são evergreen — janela de 60 dias, isolada dos
      // demais buckets. Math.max garante que window-days grande do caller
      // (ex: --window-days 90 pra backfill) não seja truncado.
      // #2336: "use_melhor" adicionado como alias defensivo — artigos no bucket
      // use_melhor com category não definida caem no fallback
      // `articleCategory = bucket` que retorna "use_melhor", não "tutorial".
      // Isso ocorre em: (a) legacy inputs sem campo category, (b) qualquer
      // caminho que bypassa categorize.ts. Todos os itens use_melhor devem ter
      // janela 60d; o alias garante isso.
      return Math.max(defaultDays, TUTORIAL_WINDOW_DAYS);
    case "noticias":
    case "video":
    default:
      return defaultDays;
  }
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
  // Cutoff "global" calculado a partir do windowDays default (usado como
  // fallback no return + logging). Cada bucket tem cutoff próprio via
  // bucketWindowDays (#1155).
  const anDateGlobal = new Date(anchorDate + "T00:00:00Z");
  anDateGlobal.setUTCDate(anDateGlobal.getUTCDate() - windowDays);
  const cutoff = anDateGlobal.toISOString().split("T")[0];

  const removed: RemovedEntry[] = [];
  // Passthrough de campos extras (#247): `clusters[]` do topic-cluster, ou
  // qualquer metadata adicional do input. Os 4 buckets são reinicializados
  // logo abaixo — não tem como o spread lá em cima sobrescrever.
  const { lancamento, radar, use_melhor, video, ...rest } = input;
  void lancamento; void radar; void use_melhor; void video; // descartar — substituídos abaixo
  const kept: Required<CategorizedInput> = {
    ...rest,
    lancamento: [],
    radar: [],
    use_melhor: [],
    video: [],
  };

  for (const bucket of ["lancamento", "radar", "use_melhor", "video"] as const) {
    for (const article of input[bucket] || []) {
      // #1629: a janela é por-category do artigo, não por-bucket. Bucket
      // `radar` mistura `pesquisa` (5d) e `noticias` (3-4d) — cada artigo
      // usa sua category individual.
      const articleCategory = (article.category as string | undefined) ?? bucket;
      const bucketDays = bucketWindowDays(articleCategory, windowDays);
      const bucketAnchor = new Date(anchorDate + "T00:00:00Z");
      bucketAnchor.setUTCDate(bucketAnchor.getUTCDate() - bucketDays);
      const bucketCutoff = bucketAnchor.toISOString().split("T")[0];
      const bucketDetailSuffix = editionDate
        ? ` (anchor ${anchorDate} - ${bucketDays}d; edition ${editionDate}; bucket-window=${bucketDays}d)`
        : ` (anchor ${anchorDate} - ${bucketDays}d; bucket-window=${bucketDays}d)`;

      // #1992: low-cadence sources marcam seus N artigos mais recentes com
      // bypass_date_window=true — mantém sem verificar data (eles já saíram do
      // window, mas são o output mais recente da fonte).
      if (article.bypass_date_window) {
        kept[bucket].push(article);
        continue;
      }

      const eff = effectiveDate(article);
      // Sem date nem published_at = mantém com benefício da dúvida (#1322
      // preserva regra antiga). Editor-submitted normalmente cai aqui e está
      // OK — fluxo manual já tem outro tratamento.
      if (eff.value == null) {
        kept[bucket].push({ ...article, date_unverified: true });
        continue;
      }
      const normDate = eff.value;
      if (normDate < bucketCutoff) {
        removed.push({
          url: article.url,
          title: article.title,
          date: article.date,
          bucket,
          reason: "date_window",
          source_field: eff.source!,
          detail: `${eff.source} ${normDate} < cutoff ${bucketCutoff}${bucketDetailSuffix}`,
        });
      } else if (eff.source !== "date") {
        // Caiu num fallback não-verificado (published_date extraído #1631, ou
        // published_at do RSS #1322) — date verificado nunca rolou; marcar como
        // unverified pra editor reconsiderar no gate.
        kept[bucket].push({ ...article, date_unverified: true });
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
    (input.radar?.length || 0) +
    (input.use_melhor?.length || 0) +
    (input.video?.length || 0);

  const totalKept =
    kept.lancamento.length + kept.radar.length + kept.use_melhor.length + kept.video.length;

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

if (isMainModule(import.meta.url)) {
  main();
}
