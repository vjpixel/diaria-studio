/**
 * approved-urls.ts (#1678)
 *
 * Bucket-walk compartilhado pra extrair TODAS as URLs de um `approved.json` JÁ
 * parseado. Centraliza num só lugar a lista de buckets — a duplicação dessa
 * lógica entre `merge-local-pending.ts` e `refresh-past-editions.ts` causou o
 * #1659: o #1629 renomeou os buckets em refresh mas esqueceu merge-local-pending.
 *
 * Os call sites mantêm sua própria resolução de path (file-path vs yymmdd+root)
 * e parse; só o walk vem daqui. Um futuro rename/adição de bucket muda 1 lugar.
 */

export interface ApprovedUrlEntry {
  url?: string;
  article?: { url?: string };
}

export interface ApprovedBuckets {
  // #1629 (atual)
  lancamento?: ApprovedUrlEntry[];
  radar?: ApprovedUrlEntry[];
  use_melhor?: ApprovedUrlEntry[];
  video?: ApprovedUrlEntry[];
  // Legacy (edições históricas pré-#1629)
  pesquisa?: ApprovedUrlEntry[];
  noticias?: ApprovedUrlEntry[];
  tutorial?: ApprovedUrlEntry[];
  // highlights/runners_up: url no top-level OU em .article (precedência abaixo)
  highlights?: ApprovedUrlEntry[];
  runners_up?: ApprovedUrlEntry[];
}

/** Nomes dos buckets simples (1 nível: cada entry tem `.url`). */
const SIMPLE_BUCKETS = [
  "lancamento",
  "radar",
  "use_melhor",
  "video",
  "pesquisa",
  "noticias",
  "tutorial",
] as const;

/**
 * Extrai (dedup'ado, preservando ordem de inserção) todas as URLs de um
 * approved.json parseado. Highlights/runners_up usam precedência
 * `entry.url ?? entry.article?.url`. Tolerante a `null`/shape parcial → [].
 */
export function extractUrlsFromBuckets(
  parsed: ApprovedBuckets | null | undefined,
): string[] {
  if (!parsed || typeof parsed !== "object") return [];
  const urls = new Set<string>();
  for (const name of SIMPLE_BUCKETS) {
    const bucket = parsed[name];
    if (!Array.isArray(bucket)) continue;
    for (const a of bucket) if (a?.url) urls.add(a.url);
  }
  for (const list of [parsed.highlights, parsed.runners_up]) {
    if (!Array.isArray(list)) continue;
    for (const h of list) {
      const url = h?.url ?? h?.article?.url;
      if (url) urls.add(url);
    }
  }
  return [...urls];
}
