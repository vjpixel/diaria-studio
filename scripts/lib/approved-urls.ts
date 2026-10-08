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
  // #3920: fontes extras do cluster same-story (bloco "Aprofunde:"). Presentes
  // no próprio entry (buckets simples) ou em .article (highlights/runners_up).
  cluster_sources?: Array<{ url?: string }>;
  article?: { url?: string; cluster_sources?: Array<{ url?: string }> };
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
  // #3920: também coletar URLs das fontes extras do cluster ("Aprofunde:"), pra
  // que contem como "já publicadas" no dedup de edições futuras — senão viram
  // destaque repetido amanhã.
  const addClusterSources = (
    cs: Array<{ url?: string }> | undefined,
  ): void => {
    if (!Array.isArray(cs)) return;
    for (const c of cs) if (c?.url) urls.add(c.url);
  };
  for (const name of SIMPLE_BUCKETS) {
    const bucket = parsed[name];
    if (!Array.isArray(bucket)) continue;
    for (const a of bucket) {
      if (a?.url) urls.add(a.url);
      addClusterSources(a?.cluster_sources);
    }
  }
  for (const list of [parsed.highlights, parsed.runners_up]) {
    if (!Array.isArray(list)) continue;
    for (const h of list) {
      const url = h?.url ?? h?.article?.url;
      if (url) urls.add(url);
      addClusterSources(h?.cluster_sources ?? h?.article?.cluster_sources);
    }
  }
  return [...urls];
}

/**
 * #9867: chave de comparação entre a URL do approved.json e a do markdown
 * final — host minúsculo sem `www.`, sem fragmento, sem `utm_*`, sem barra
 * final. URL que não parseia volta aparada (comparação literal).
 */
export function usedUrlKey(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    const qs = u.searchParams.toString();
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${qs ? `?${qs}` : ""}`;
  } catch {
    return raw.trim().replace(/\/+$/, "");
  }
}

/**
 * #9867: restringe as URLs do `01-approved.json` às que a edição de fato
 * RENDERIZOU (`02-reviewed.md` final).
 *
 * O `01-approved.json` guarda o pool inteiro do gate da Etapa 1 — inclusive
 * candidato de RADAR na posição 26 que nunca chegou ao texto. Listá-lo em
 * "Links usados" do `past-editions.md` fazia o `dedup.ts` e o invariante
 * `no-duplicate-urls-vs-past-editions` (#8993) acusarem repetição de um link
 * que nunca foi publicado (caso 261007 → 261008: `nano-banana-2-1`); no
 * Stage 1 o mesmo erro descarta matéria legítima só por ter sido candidata
 * na véspera.
 *
 * `renderedMd === null` (edição sem `02-reviewed.md` local) ou markdown sem
 * nenhuma URL (arquivo truncado) → devolve `approvedUrls` intacto: na dúvida,
 * bloqueia a mais (comportamento anterior), nunca perde link publicado.
 * Ordem do approved preservada.
 */
export function restrictToRenderedUrls(approvedUrls: string[], renderedMd: string | null): string[] {
  if (renderedMd === null) return approvedUrls;
  const rendered = new Set<string>();
  for (const m of renderedMd.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    rendered.add(usedUrlKey(m[0].replace(/[.,);]+$/, "")));
  }
  if (rendered.size === 0) return approvedUrls;
  return approvedUrls.filter((u) => rendered.has(usedUrlKey(u)));
}
