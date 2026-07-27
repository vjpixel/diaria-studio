/**
 * placeholder-title-guard.ts (#4102)
 *
 * Backstop determinístico — nenhum destaque final pode ter um título
 * PLACEHOLDER (sintético, nunca enriquecido com o conteúdo real do artigo).
 * Espelha o padrão de `negative-impact-promotion.ts` (#3916/#3918): o
 * `scorer-select` (LLM) já é instruído a não escolher esses candidatos, mas
 * julgamento de LLM não é garantido (#573) — este helper reproduz a mesma
 * checagem deterministicamente sobre os `finalists` do merge.
 *
 * Caso real (edição 260727, #4102): o item do Y Combinator chegou ao scorer
 * com `title: "(newsletter:\"Lenny's Newsletter\")"` — placeholder deixado por
 * `capture-newsletter-urls.ts`/`inject-inbox-urls.ts` para links extraídos de
 * newsletter capturada (`flag: "newsletter_extracted"`) — e score 119, o mais
 * alto do pool. Sem este guard, o item viraria D1 com título sintético.
 *
 * Diferente do backstop de negative-impact (que PROMOVE um candidato faltante),
 * este DEMOVE: qualquer highlight cujo título case o padrão placeholder é
 * substituído pelo melhor finalista disponível (maior score, não já escolhido,
 * com título não-placeholder). Sem substituto disponível, o highlight
 * ofensor é removido (contagem cai — `finalize-stage1`/1r promovem runners_up
 * pra compensar, mesmo mecanismo que já existe pra highlights insuficientes).
 */

/** Mesmo padrão usado em enrich-inbox-articles.ts (fonte única seria ideal,
 * mas os dois módulos rodam em estágios diferentes do pipeline com tipos
 * de artigo distintos — replicar a regex aqui é mais simples que criar um
 * import cruzado só para 1 regex estável). */
const PLACEHOLDER_HIGHLIGHT_TITLE_RE =
  /^\((?:inbox|no title|sem t[ií]tulo|newsletter:.*)\)$/i;

/** True se o título (trim) é vazio ou casa integralmente um padrão placeholder
 * conhecido — âncoras `^...$` evitam falso-positivo em título real que apenas
 * CONTÉM parênteses (ex: "GPT-5 (versão de pesquisa) chega em outubro"). */
export function isPlaceholderHighlightTitle(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  if (!t) return true;
  return PLACEHOLDER_HIGHLIGHT_TITLE_RE.test(t);
}

/**
 * Shapes deliberadamente soltas (compatíveis com `FinalistLike`/`HighlightLike`
 * de `negative-impact-promotion.ts`, reusadas por `assemble-scored.ts` no
 * mesmo call site) — `article` é `Record<string, unknown>`-like porque cada
 * caller do pipeline anexa campos diferentes ao artigo completo.
 */
export interface PlaceholderFinalistLike {
  url: string;
  score: number;
  bucket?: string;
  article?: Record<string, unknown> | undefined;
}

export interface PlaceholderHighlightLike {
  rank?: number;
  score?: number;
  bucket?: string;
  reason?: string;
  url?: string;
  article?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

export interface PlaceholderDemotion {
  demoted_url: string;
  demoted_title?: string;
  promoted_url?: string;
  reason: string;
}

function urlOf(h: { url?: string; article?: Record<string, unknown> }): string | undefined {
  const artUrl = h.article?.url;
  return h.url ?? (typeof artUrl === "string" ? artUrl : undefined);
}

function titleOf(h: { title?: unknown; article?: Record<string, unknown> }): string | undefined {
  const artTitle = h.article?.title;
  if (typeof artTitle === "string") return artTitle;
  return typeof h.title === "string" ? h.title : undefined;
}

/**
 * Garante que nenhum item de `highlights` tem título placeholder. Puro — não
 * muta os argumentos. Substitui cada ofensor pelo melhor finalista disponível
 * (maior score, não já escolhido, título não-placeholder); sem substituto,
 * remove o ofensor (a contagem final é resolvida por quem chama, igual ao
 * mecanismo existente de "highlights insuficientes" — #104).
 */
export function demotePlaceholderTitleHighlights<H extends PlaceholderHighlightLike>(
  highlights: H[],
  finalists: PlaceholderFinalistLike[],
): { highlights: H[]; demotions: PlaceholderDemotion[] } {
  const offenderIdxs = highlights
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => isPlaceholderHighlightTitle(titleOf(h)));

  if (offenderIdxs.length === 0) return { highlights, demotions: [] };

  const highlightUrls = new Set(
    highlights.map(urlOf).filter((u): u is string => typeof u === "string"),
  );
  const usedReplacementUrls = new Set<string>();

  // Candidatos ordenados por score desc — reusados entre múltiplos ofensores
  // (raro, mas o loop consome candidatos conforme os aloca).
  const candidatesSorted = finalists
    .filter((f) => !isPlaceholderHighlightTitle(titleOf(f)) && !highlightUrls.has(f.url))
    .sort((a, b) => b.score - a.score);

  const offenderIdxSet = new Set(offenderIdxs.map(({ i }) => i));
  const demotions: PlaceholderDemotion[] = [];
  const result: H[] = [];

  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    if (!offenderIdxSet.has(i)) {
      result.push(h);
      continue;
    }

    const demotedUrl = urlOf(h) ?? "(desconhecida)";
    const demotedTitle = titleOf(h);
    const candidate = candidatesSorted.find((c) => !usedReplacementUrls.has(c.url));

    if (!candidate) {
      // Sem substituto: remove o ofensor (não empurra pra `result`).
      demotions.push({
        demoted_url: demotedUrl,
        demoted_title: demotedTitle,
        reason:
          "título placeholder (nunca enriquecido com conteúdo real, #4102) e nenhum finalista " +
          "substituto disponível — highlight removido, não pode virar destaque com título sintético.",
      });
      continue;
    }

    usedReplacementUrls.add(candidate.url);
    const promoted: H = {
      ...h,
      score: candidate.score,
      bucket: candidate.bucket,
      article: candidate.article,
      url: candidate.url,
      reason:
        "Substituído automaticamente (#4102): destaque selecionado tinha título placeholder " +
        "(nunca enriquecido) — backstop determinístico de assemble-scored.ts.",
    };
    delete (promoted as { title?: string }).title;
    result.push(promoted);
    demotions.push({
      demoted_url: demotedUrl,
      demoted_title: demotedTitle,
      promoted_url: candidate.url,
      reason:
        "título placeholder (#4102) — substituído pelo melhor finalista disponível não escolhido.",
    });
  }

  return { highlights: result, demotions };
}
