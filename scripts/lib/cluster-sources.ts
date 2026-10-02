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

import { unionNewsletterMentions } from "./newsletter-mention-bonus.ts"; // #9365

/** Uma fonte do cluster, preservada no artigo vencedor. */
export interface ClusterSource {
  url: string;
  title?: string;
  source?: string;
  /** Data de publicação (ISO, tipicamente só data — pesquisadores não capturam hora). */
  published_at?: string;
  /**
   * #4228: proveniência de submissão do editor, propagada do artigo de
   * origem (`ClusterArticle.flag`/`.editor_submitted_url`) quando presente.
   * Sem isso, um artigo `editor_submitted` que vira `cluster_source` (seja
   * via `foldCluster` aqui, seja via `attachClusterSource` em
   * `dedup-intra-edition.ts`, #4185) perde o sinal de prioridade — a URL
   * sobrevive no "Aprofunde:", mas "isto veio do editor" desaparece.
   */
  flag?: string;
  editor_submitted_url?: string;
  /**
   * #9365: newsletters (remetentes) que citaram este membro do cluster —
   * preservado pra o bônus de menção em newsletter do vencedor
   * (`newsletter-mention-bonus.ts`) não se perder quando outra cobertura da
   * mesma história vence o cluster.
   */
  newsletter_mentions?: string[];
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
  /** Origem do artigo — `"editor_submitted"` quando veio de submissão do editor. */
  flag?: string;
  /** #4193: URL original do editor quando o canônico herdou a proveniência
   *  de um membro perdedor do cluster (ver `foldCluster`). */
  editor_submitted_url?: string;
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
    (typeof a.source === "string" && a.source.trim()) ||
    (typeof a.source_name === "string" && a.source_name.trim()) ||
    veiculoFromUrl(a.url);
  if (source) cs.source = source;
  const pub = a.published_at ?? a.date;
  if (typeof pub === "string" && pub.trim()) cs.published_at = pub;
  // #4228: propaga o marcador de proveniência do editor pro cluster_source
  // individual — mesmo espírito da herança que `foldCluster` já fazia no
  // NÍVEL DO CANÔNICO (linhas abaixo), só que aqui no nível de cada entrada
  // de `cluster_sources[]`, que é o que `attachClusterSource`
  // (dedup-intra-edition.ts, #4185) consome diretamente.
  if (typeof a.flag === "string" && a.flag.trim()) cs.flag = a.flag;
  if (typeof a.editor_submitted_url === "string" && a.editor_submitted_url.trim()) {
    cs.editor_submitted_url = a.editor_submitted_url;
  }
  // #9365: menções em newsletter do perdedor seguem pro vencedor do cluster.
  const mentions = unionNewsletterMentions(a.newsletter_mentions);
  if (mentions.length > 0) cs.newsletter_mentions = mentions;
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
 *
 * #4193: quando o canônico escolhido por completude NÃO é a cópia do editor
 * mas outro membro do cluster É (`flag: "editor_submitted"`), o canônico
 * herda essa proveniência — senão o interesse explícito do editor
 * desaparece do sistema sempre que uma cobertura mais completa (summary
 * maior, por exemplo) vence o cluster mas cobre a MESMA história que ele
 * mandou.
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

  if (canonical.flag !== "editor_submitted") {
    const editorSource = others.find((o) => o.flag === "editor_submitted");
    if (editorSource) {
      canonical.flag = "editor_submitted";
      canonical.editor_submitted_url = editorSource.url;
    }
  }

  return { canonical, others };
}

/**
 * #9384: chave de comparação de título pra detectar ESPELHO do mesmo anúncio
 * (ex: blog.google ↔ deepmind.google com o mesmo título). Minúsculas, sem
 * acento, sem pontuação, espaços colapsados.
 *
 * @pure
 */
export function mirrorTitleKey(title: string | undefined): string {
  if (!title) return "";
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * #9384: remove de `cluster_sources` as entradas que são ESPELHO do mesmo
 * anúncio — título (normalizado) igual ao do artigo canônico ou ao de outra
 * entrada já mantida. Cobertura independente (outro veículo, outro título)
 * permanece. Quando nada sobra, o campo é REMOVIDO: sem `cluster_sources` o
 * `writer-destaque` não emite o bloco "Aprofunde:" (o editor apagava o bloco
 * à mão nesses casos: 260903 D1, 260925 D2).
 *
 * Muta `article` in-place e devolve as entradas removidas.
 */
export function dropMirrorClusterSources(article: {
  title?: string;
  cluster_sources?: ClusterSource[];
}): ClusterSource[] {
  const sources = article.cluster_sources;
  if (!Array.isArray(sources) || sources.length === 0) return [];
  const seen = new Set<string>();
  const canonicalKey = mirrorTitleKey(article.title);
  if (canonicalKey) seen.add(canonicalKey);
  const kept: ClusterSource[] = [];
  const removed: ClusterSource[] = [];
  for (const s of sources) {
    const key = mirrorTitleKey(s.title);
    if (key && seen.has(key)) {
      removed.push(s);
      continue;
    }
    if (key) seen.add(key);
    kept.push(s);
  }
  if (removed.length === 0) return [];
  if (kept.length === 0) delete article.cluster_sources;
  else article.cluster_sources = kept;
  return removed;
}
