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

/**
 * #10843: `<title>` de página-stub de redirect HTTP ("301 Moved Permanently",
 * "302 Found", "Document moved", "Object moved", "Redirecting...") — o que
 * sobra quando um fetcher parseia a resposta 3xx em vez de seguir o
 * `Location`. Medido em 261019–261022: 39 artigos `newsletter_extracted` com
 * esses títulos, 8 chegaram ao `01-approved` e um virou destaque ("Document
 * moved", Voxtral 3, 261022). Fonte ÚNICA do padrão: `isPlaceholderHighlightTitle`
 * (e por tabela topic-cluster, assemble-scored, dedup e o invariante
 * `no-placeholder-title-highlights`) e `enrich-inbox-articles.ts` leem daqui.
 * Âncoras `^...$`: só o título INTEIRO de stub casa — "Found: o modelo que..."
 * ou "Redirecting the AI race" continuam títulos reais.
 *
 * #10881 item 4: as palavras soltas "Found", "Moved" e "Redirect" (sem o
 * código HTTP antes) podiam ser título real de artigo ou produto — elas só
 * casam com o código ("302 Found", "301 Moved", "302 Redirect"). E entram as
 * variantes em português de servidor/CMS configurado em pt-BR ("Documento
 * movido", "Movido permanentemente", "Redirecionando...").
 */
const REDIRECT_STUB_SEM_CODIGO =
  "document moved|object moved|moved permanently|moved temporarily|see other|temporary redirect|permanent redirect|" +
  "redirecting(?:\\s+to\\s+\\S+)?|" +
  "documento movido|objeto movido|movido permanentemente|movido temporariamente|redirecionamento tempor[áa]rio|" +
  "redirecionamento permanente|redirecionando(?:\\s+para\\s+\\S+)?";
/** Palavra solta que só é stub com o código HTTP antes (#10881 item 4). */
const REDIRECT_STUB_SO_COM_CODIGO = "moved|found|redirect|movido|encontrado|redirecionamento";
const REDIRECT_STUB_TITLE_RE = new RegExp(
  `^(?:(?:\\d{3}\\s*[-:]?\\s*)?(?:${REDIRECT_STUB_SEM_CODIGO})|\\d{3}\\s*[-:]?\\s*(?:${REDIRECT_STUB_SO_COM_CODIGO}))\\s*(?:\\.{1,3}|…)?$`,
  "i",
);

/** True se o título (trim) é o `<title>` de uma página-stub de redirect (#10843). */
export function isRedirectStubTitle(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  if (!t) return false;
  return REDIRECT_STUB_TITLE_RE.test(t);
}

/**
 * #10796 (review do PR #10890): a palavra solta e AMBÍGUA, sem código de status
 * nem reticências ("Found", "Moved", "Redirect"). Desde o #10881 item 4 ela
 * fica FORA de `REDIRECT_STUB_TITLE_RE` (lá só casa com o código antes), então
 * `isRedirectStubTitle("Found")` é false e esta função é a única que a
 * reconhece. Também é título possível de matéria real; quem DESCARTA artigo
 * com base no título (categorize) precisa de contexto de redirect extra antes
 * de tratar isso como stub. "302 Found", "Moved Permanently", "Redirecting..."
 * continuam inequívocos.
 */
const AMBIGUOUS_REDIRECT_STUB_TITLE_RE = /^(?:found|moved|redirect)$/i;

/** True se o título (trim) é stub de redirect, mas só a palavra solta e ambígua (#10796). */
export function isAmbiguousRedirectStubTitle(title: string | null | undefined): boolean {
  return AMBIGUOUS_REDIRECT_STUB_TITLE_RE.test((title ?? "").trim());
}

/** True se o título (trim) é vazio ou casa integralmente um padrão placeholder
 * conhecido — âncoras `^...$` evitam falso-positivo em título real que apenas
 * CONTÉM parênteses (ex: "GPT-5 (versão de pesquisa) chega em outubro").
 * Inclui título de stub de redirect (#10843). */
export function isPlaceholderHighlightTitle(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  if (!t) return true;
  return PLACEHOLDER_HIGHLIGHT_TITLE_RE.test(t) || isRedirectStubTitle(t);
}

/**
 * #10908: versão de `isPlaceholderHighlightTitle` que também lê o marcador
 * `title_unresolved` gravado pelo `categorize` (#10796) na submissão do editor
 * que ficou no pool com título de stub de redirect. A palavra solta ("Found",
 * "Moved", "Redirect") não casa `isPlaceholderHighlightTitle` desde o #10881
 * item 4 — sem ler o marcador, o item podia virar D1 intitulado "Found".
 *
 * O marcador só conta enquanto o título AINDA é a palavra ambígua: se o editor
 * corrigiu o título no gate do Stage 1, o `title_unresolved` herdado fica
 * velho e não pode demover/bloquear um título real.
 */
export function isPlaceholderHighlightTitleOrUnresolved(
  title: string | null | undefined,
  titleUnresolved: unknown,
): boolean {
  if (isPlaceholderHighlightTitle(title)) return true;
  return Boolean(titleUnresolved) && isAmbiguousRedirectStubTitle(title);
}

/** Lê título e `title_unresolved` de um highlight/finalista (top-level ou `article`). */
export function isPlaceholderHighlightItem(h: { title?: unknown; article?: Record<string, unknown> }): boolean {
  const marker = h.article?.title_unresolved ?? (h as Record<string, unknown>).title_unresolved;
  return isPlaceholderHighlightTitleOrUnresolved(titleOf(h), marker);
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
  // #10908: o `article` do highlight vem da seleção do `scorer-select` (LLM),
  // que pode não copiar `title_unresolved`. O finalista da mesma URL vem do
  // merge determinístico e carrega o marcador — vale como fonte de reserva.
  const unresolvedFinalistUrls = new Set(
    finalists
      .filter((f) => Boolean(f.article?.title_unresolved))
      .map((f) => f.url),
  );
  const offenderIdxs = highlights
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => {
      if (isPlaceholderHighlightItem(h)) return true;
      const u = urlOf(h);
      return u !== undefined && unresolvedFinalistUrls.has(u) &&
        isPlaceholderHighlightTitleOrUnresolved(titleOf(h), true);
    });

  if (offenderIdxs.length === 0) return { highlights, demotions: [] };

  const highlightUrls = new Set(
    highlights.map(urlOf).filter((u): u is string => typeof u === "string"),
  );
  const usedReplacementUrls = new Set<string>();

  // Candidatos ordenados por score desc — reusados entre múltiplos ofensores
  // (raro, mas o loop consome candidatos conforme os aloca).
  const candidatesSorted = finalists
    .filter((f) => !isPlaceholderHighlightItem(f) && !highlightUrls.has(f.url))
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

  // Finding 5 do self-review (#4102): quando ≥1 ofensor é REMOVIDO sem
  // substituto (não apenas trocado), `result` fica mais curto que
  // `highlights` e o campo `rank` dos itens remanescentes pode ficar com
  // buraco (ex: 1, 2, 4 — o rank 3 nunca existiu no array final). Reindexa
  // 1..N por POSIÇÃO (preserva a ordem editorial já decidida) sempre que
  // houve remoção — preserva a mesma referência de objeto quando o rank já
  // bate com a posição (não force-cria objeto novo sem necessidade, mantendo
  // o comportamento de "preserva highlights não-ofensores intactos").
  const hadRemoval = result.length < highlights.length;
  const reindexed = hadRemoval
    ? result.map((h, i) => {
        const expectedRank = i + 1;
        if ("rank" in h && h.rank !== expectedRank) {
          return { ...h, rank: expectedRank };
        }
        return h;
      })
    : result;

  return { highlights: reindexed, demotions };
}
