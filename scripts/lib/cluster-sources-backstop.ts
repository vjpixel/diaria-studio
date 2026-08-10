/**
 * cluster-sources-backstop.ts (#4838)
 *
 * Backstop determinístico — o `cluster_sources[]` de um highlight final NUNCA
 * pode divergir do que o dedup atribuiu ao mesmo artigo em `finalists`.
 * Espelha o padrão de `negative-impact-promotion.ts` (#3916/#3918) e
 * `placeholder-title-guard.ts` (#4102): `scorer-select` (LLM, Opus,
 * `effort: low`) é instruído a "copiar o article EXATAMENTE como veio no
 * finalista", mas `cluster_sources[]` nunca é mencionado no próprio prompt do
 * agent — é um campo aninhado, pouco saliente, fácil de um LLM "esquecer" ao
 * retranscrever um objeto JSON grande. Julgamento/transcrição de LLM não é
 * garantido (#573): este helper reproduz deterministicamente, a partir de
 * `finalists` (fonte determinística, `merge-scored-chunks.ts`), o
 * `cluster_sources[]` que o `article` do highlight selecionado DEVERIA ter.
 *
 * Por que importa (#4838): o bônus de cobertura (`coverage-bonus.ts`, #3920)
 * já foi somado ao `score` do artigo ANTES do scorer-select rodar (em
 * `merge-scored-chunks.ts`) — sobrevive ao passo do LLM não importa o que
 * aconteça com `cluster_sources[]`. Mas o bloco "Aprofunde:" (writer + render)
 * só existe se `cluster_sources[]` chegar intacto no `article` que o
 * `writer-destaque` recebe. Sem este backstop, um highlight pode carregar o
 * bônus de score de uma cobertura ampla que o leitor nunca vê — exatamente o
 * sintoma que a issue #4838 descreve ("bônus ativo, entrega que não existe").
 *
 * Diferente dos 2 backstops irmãos (que PROMOVEM/DEMOVEM um highlight
 * inteiro), este apenas COMPLETA um campo do `article` já escolhido — nunca
 * troca qual highlight foi selecionado.
 */

export interface ClusterSourcesFinalistLike {
  url: string;
  article?: (Record<string, unknown> & { cluster_sources?: unknown[] }) | undefined;
}

export interface ClusterSourcesHighlightLike {
  url?: string;
  article?: (Record<string, unknown> & { cluster_sources?: unknown[] }) | undefined;
  [key: string]: unknown;
}

export interface ClusterSourcesRestoration {
  url: string;
  restored_count: number;
  reason: string;
}

export interface ClusterSourcesReconcileResult<H extends ClusterSourcesHighlightLike = ClusterSourcesHighlightLike> {
  highlights: H[];
  restorations: ClusterSourcesRestoration[];
}

function urlOf(h: { url?: string; article?: Record<string, unknown> | undefined }): string | undefined {
  if (typeof h.url === "string") return h.url;
  const artUrl = h.article?.url;
  return typeof artUrl === "string" ? artUrl : undefined;
}

/**
 * Reconcilia `article.cluster_sources[]` de cada highlight contra o
 * `finalists` correspondente (join por URL). Pura — não muta os argumentos.
 *
 * No-op para um highlight quando: (a) não há finalist correspondente
 * (não deveria acontecer — highlight sempre vem de um finalist — mas falha
 * seguro em vez de lançar), ou (b) o finalist não tem `cluster_sources[]`
 * (destaque de fonte única, nada a restaurar), ou (c) o highlight já carrega
 * exatamente o mesmo `cluster_sources[]` do finalist (agent preservou
 * corretamente — caso comum, backstop não deveria intervir na maioria das
 * edições).
 *
 * Restaura (sobrescreve `article.cluster_sources` com a versão do finalist)
 * quando o finalist tem `cluster_sources[]` não-vazio e o highlight não tem
 * exatamente o mesmo array — cobre tanto "campo ausente" quanto "presente mas
 * divergente" (ex: agent reproduziu só parte das fontes do cluster).
 */
export function reconcileClusterSources<H extends ClusterSourcesHighlightLike>(
  highlights: H[],
  finalists: ClusterSourcesFinalistLike[],
): ClusterSourcesReconcileResult<H> {
  const finalistByUrl = new Map<string, ClusterSourcesFinalistLike>();
  for (const f of finalists) {
    if (f.url) finalistByUrl.set(f.url, f);
  }

  const restorations: ClusterSourcesRestoration[] = [];
  const result = highlights.map((h) => {
    const url = urlOf(h);
    if (!url) return h;

    const finalist = finalistByUrl.get(url);
    const finalistClusters = finalist?.article?.cluster_sources;
    if (!Array.isArray(finalistClusters) || finalistClusters.length === 0) return h;

    const highlightClusters = h.article?.cluster_sources;
    const alreadyIntact =
      Array.isArray(highlightClusters) &&
      JSON.stringify(highlightClusters) === JSON.stringify(finalistClusters);
    if (alreadyIntact) return h;

    restorations.push({
      url,
      restored_count: finalistClusters.length,
      reason:
        !Array.isArray(highlightClusters) || highlightClusters.length === 0
          ? "cluster_sources ausente no highlight selecionado — restaurado do finalist " +
            "(scorer-select não preservou o campo ao copiar o article, #4838)"
          : `cluster_sources divergente do finalist (${highlightClusters.length} vs ` +
            `${finalistClusters.length} fontes) — restaurado do finalist (#4838)`,
    });

    return {
      ...h,
      article: {
        ...(h.article ?? {}),
        cluster_sources: finalistClusters,
      },
    };
  });

  // No-op preserva a MESMA referência de array (mesmo padrão de
  // `demotePlaceholderTitleHighlights`) — a maioria das edições não tem
  // nenhum cluster pra reconciliar, então o caso comum não deveria alocar.
  return restorations.length === 0 ? { highlights, restorations } : { highlights: result, restorations };
}
