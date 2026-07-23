/**
 * cluster-sources.ts (#3920)
 *
 * Quando várias fontes cobrem a MESMA história dentro de uma edição, o dedup
 * (sub-pass 2b de `scripts/dedup.ts`) agrupa esses artigos num cluster. Em vez
 * de DESCARTAR os perdedores (comportamento pré-#3920), preserva-os como
 * `cluster_sources[]` no artigo vencedor. Esses metadados alimentam:
 *   - o bloco "Aprofunde:" do destaque (writer + render),
 *   - o bônus de score por cobertura ampla (`coverage-bonus.ts`),
 *   - o dedup de edições futuras (URLs contam como "já publicadas"),
 *   - o fact-checker (fontes extras de graça).
 *
 * O artigo VENCEDOR (canônico = link do título do destaque) é o **mais
 * completo** do cluster, decidido deterministicamente (decisão do editor
 * 260722): ranquear por `len(summary) desc → fonte cadastrada (não-discovered)
 * → len(title) desc → mantém o vencedor atual do dedup` (desempate final =
 * ordem de entrada, que preserva o vencedor pré-existente).
 *
 * O link oficial de lançamento (#160) NÃO é tratado aqui: a substituição pela
 * fonte primária oficial roda DEPOIS do dedup (passo 1m-ter do Stage 1), então
 * a seleção de canônico aqui é bucket-agnóstica.
 */

/** Uma fonte do cluster, preservada no artigo vencedor. */
export interface ClusterSource {
  url: string;
  title?: string;
  source?: string;
  /** Data de publicação (ISO, tipicamente só data — pesquisadores não capturam hora). */
  published_at?: string;
}

/** Shape mínimo de artigo que os helpers de cluster consomem. */
export interface ClusterArticle {
  url: string;
  title?: string;
  summary?: string;
  source?: string;
  /** discovery-searcher usa `source_name` (source-researcher não tem per-article). */
  source_name?: string;
  discovered_source?: boolean;
  published_at?: string;
  date?: string;
  cluster_sources?: ClusterSource[];
  [key: string]: unknown;
}

/** Deriva um nome de veículo legível do hostname da URL (fallback). */
function veiculoFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Comprimento (trim) do summary de um artigo — proxy de completude. */
function summaryLength(a: ClusterArticle): number {
  const s = a.summary;
  return typeof s === "string" ? s.trim().length : 0;
}

/**
 * Extrai a `ClusterSource` de um artigo (só os campos que o bloco Aprofunde /
 * dedup futuro / fact-checker precisam). `published_at` cai em `date` quando
 * ausente.
 */
export function toClusterSource(a: ClusterArticle): ClusterSource {
  const cs: ClusterSource = { url: a.url };
  if (typeof a.title === "string" && a.title.trim()) cs.title = a.title;
  // Veículo: source (source-researcher stamp) → source_name (discovery) →
  // hostname da URL (fallback). Garante que o "- Fonte" do Aprofunde raramente
  // fique vazio; o writer (LLM) ainda pode refinar "theverge.com" → "The Verge".
  const source =
    (typeof a.source === "string" && a.source.trim() && a.source) ||
    (typeof a.source_name === "string" && a.source_name.trim() && a.source_name) ||
    veiculoFromUrl(a.url);
  if (source) cs.source = source;
  const pub = a.published_at ?? a.date;
  if (typeof pub === "string" && pub.trim()) cs.published_at = pub;
  return cs;
}

/**
 * Comparador de completude. Retorna < 0 quando `a` é MAIS completo que `b`
 * (ordena antes). Ordem: maior summary → fonte cadastrada (não-discovered) →
 * maior título → empate (0, resolvido pela ordem de entrada no `pickCanonical`,
 * que preserva o vencedor atual do dedup).
 */
export function compareCompleteness(a: ClusterArticle, b: ClusterArticle): number {
  const sa = summaryLength(a);
  const sb = summaryLength(b);
  if (sa !== sb) return sb - sa; // maior summary primeiro

  const da = a.discovered_source ? 1 : 0;
  const db = b.discovered_source ? 1 : 0;
  if (da !== db) return da - db; // fonte cadastrada (0) antes de discovered (1)

  const ta = a.title?.length ?? 0;
  const tb = b.title?.length ?? 0;
  if (ta !== tb) return tb - ta; // maior título primeiro

  return 0;
}

/**
 * Escolhe o artigo canônico (mais completo) de um cluster e retorna o resto
 * como `others` (perdedores). Sort ESTÁVEL: empates preservam a ordem de
 * entrada, então `members[0]` deve ser o vencedor atual do dedup pra que o
 * desempate final o mantenha.
 */
export function pickCanonical(members: ClusterArticle[]): {
  canonical: ClusterArticle;
  others: ClusterArticle[];
} {
  if (members.length === 0) {
    throw new Error("pickCanonical: cluster vazio");
  }
  const indexed = members.map((m, i) => ({ m, i }));
  indexed.sort((x, y) => {
    const c = compareCompleteness(x.m, y.m);
    return c !== 0 ? c : x.i - y.i; // tie → ordem de entrada (vencedor atual)
  });
  return {
    canonical: indexed[0].m,
    others: indexed.slice(1).map((e) => e.m),
  };
}

/**
 * Materializa um cluster: escolhe o canônico e anexa os perdedores como
 * `cluster_sources[]` (merge idempotente com qualquer cluster_sources
 * pré-existente). Muta e retorna o próprio objeto canônico.
 */
export function foldCluster(members: ClusterArticle[]): {
  canonical: ClusterArticle;
  others: ClusterArticle[];
} {
  const { canonical, others } = pickCanonical(members);
  if (others.length === 0) return { canonical, others };
  const existing = Array.isArray(canonical.cluster_sources)
    ? canonical.cluster_sources
    : [];
  const seen = new Set(existing.map((c) => c.url));
  const added: ClusterSource[] = [];
  for (const o of others) {
    if (seen.has(o.url)) continue;
    seen.add(o.url);
    added.push(toClusterSource(o));
  }
  canonical.cluster_sources = [...existing, ...added];
  return { canonical, others };
}
