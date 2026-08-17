/**
 * corpus-index-coverage.ts (#5125 "índices por mês e por tema")
 *
 * **Achado que motiva este módulo, não construção de página nova.** O
 * escopo dispatchado pediu 2 índices RASOS do corpus (`data/beehiiv-cache/posts/*.json`,
 * 247 edições confirmadas) — "por mês" e "por tema" — publicados em host
 * nosso, pra encurtar a profundidade de rastreio das edições na Beehiiv
 * (issue #5125, corpo: "as 236 edições estão a profundidade ~48... sem
 * paginação numerada").
 *
 * Investigação (antes de escrever qualquer HTML novo) achou que **as duas
 * superfícies já existem, em produção, cobrindo o corpus inteiro**:
 *
 *   - **Índice por mês**: `arquivo.diar.ia.br` (#4105) — Worker que
 *     server-renderiza `<a href>` reais pra TODAS as edições do sitemap,
 *     agrupadas por `YYYY-MM` (`workers/arquivo/src/render-archive.ts`).
 *     Confirmado ao vivo (17/08/2026): 239 edições, 13 seções de mês
 *     (agosto/2025 a agosto/2026).
 *   - **Índice por tema**: `arquivo.diar.ia.br/temas/` (#4558 Parte A) —
 *     página-índice dos 6 hubs temáticos publicados, cada um linkando as
 *     edições que casam o `HUB_KEYWORD_PATTERNS` do tema
 *     (`scripts/generate-hub-sources.ts`). Os 6 `{slug}-sources.generated.json`
 *     já commitados cobrem 202 das 247 edições confirmadas (~82%) — ver
 *     `computeCorpusIndexCoverage` abaixo pro cálculo exato, sempre
 *     re-derivado do dado real, nunca hardcoded (mesma disciplina do #1172).
 *
 * Construir uma 3ª superfície duplicada em `workers/artigos` violaria o
 * próprio critério que a issue #5125 estabeleceu pra decisão (C): "não
 * espelhar... produzir páginas que NÃO EXISTEM na Beehiiv" — um índice por
 * mês/tema que já existe na Beehiiv... não, que já existe EM HOST NOSSO
 * (`arquivo.diar.ia.br`) é exatamente o espelho que a opção (A) descartou,
 * agora entre dois hosts nossos em vez de nosso-vs-Beehiiv. E o próprio
 * corpo da issue avisa: "mais superfície é mais manutenção, num projeto de
 * editor solo".
 *
 * Este módulo, em vez de gerar HTML novo, dá à alegação "os índices já
 * cobrem o corpus" uma checagem MECÂNICA e re-executável — a mesma
 * disciplina do #573 ("validar afirmações... via TS determinístico antes de
 * relayar pro editor"), generalizada aqui pra "estado do repo" em vez de
 * "estado de plataforma externa" (o mesmo tipo de erro que este issue já
 * documentou 2× em comentários anteriores — "correção de leitura de
 * estado", 15/08 e 16/08/2026). `scripts/corpus-index-coverage-report.ts`
 * é o CLI fino que chama isto contra o dado real e escreve
 * `docs/corpus-index-status-5125.md`.
 *
 * Pure — sem I/O, sem `Date.now()`, testável com fixture pequena
 * (`test/corpus-index-coverage.test.ts`).
 */

/** Uma edição confirmada do corpus — só os 2 campos que a cobertura
 * precisa (slug pra casar contra os hubs; `hasResolvableDate` reflete a
 * condição real que `render-archive.ts`/`generate-arquivo-titles.ts` exigem
 * pra incluir a edição no índice por mês: slug + `publish_date` resolvíveis,
 * ver `RawCachedPost` em `scripts/generate-arquivo-titles.ts`). */
export interface CorpusEditionSummary {
  slug: string;
  hasResolvableDate: boolean;
}

/** Um tema já publicado (hoje: os 6 hubs de `HUB_META`,
 * `workers/arquivo/src/hubs/meta.ts`) e as edições que ele cobre — mesma
 * shape mínima de `HubSourceEntry[]` (`scripts/generate-hub-sources.ts`),
 * reduzida a `editionSlug` porque é só o que a contagem de cobertura usa. */
export interface ThemeCoverageInput {
  slug: string;
  label: string;
  editionSlugs: readonly string[];
}

export interface ThemeCoverageBreakdown {
  slug: string;
  label: string;
  /** Quantas edições do corpus este tema cobre — after dedupe (um
   * `editionSlug` repetido em `editionSlugs` conta 1×; não deveria
   * acontecer no dado real de `collectHubSources`, mas a contagem não
   * assume isso). */
  editionCount: number;
}

export interface CorpusIndexCoverageResult {
  /** Total de edições confirmadas no corpus (input `editions.length`). */
  totalEditions: number;
  /** Edições com slug+data resolvíveis — a condição real pra aparecer no
   * índice por mês de `arquivo.diar.ia.br`. */
  monthIndexCoveredEditions: number;
  /** Edições cobertas por PELO MENOS 1 tema (união, não soma — uma edição
   * que casa 2 hubs conta 1× aqui, mesmo comportamento de
   * `buildTemaNav`/os hubs reais, onde overlap entre hubs é esperado por
   * design — ver `generate-hub-sources.ts::HUB_KEYWORD_PATTERNS`
   * comentário sobre `meta-ai`+`mercado-trabalho`). */
  themeIndexCoveredEditions: number;
  /** `themeIndexCoveredEditions / totalEditions * 100`, arredondado a 1
   * casa decimal. `0` se `totalEditions === 0` (nunca `NaN`). */
  themeCoveragePct: number;
  /** Contagem por tema (não deduplicada entre temas — soma pode exceder
   * `themeIndexCoveredEditions` por causa do overlap legítimo). Ordem =
   * ordem de `themes` no input (curatorial, mesma ordem de `HUB_META`). */
  byTheme: ThemeCoverageBreakdown[];
  /** Slugs de edições confirmadas que não casam NENHUM tema publicado —
   * ordenados alfabeticamente (determinístico, não a ordem de inserção do
   * corpus). Candidatas a um tema futuro, ou legitimamente sem tema
   * transversal (ex: RADAR-only, sem destaque de peso — ver nota
   * "mais superfície é mais manutenção" no docstring do módulo: NÃO é
   * automático que toda edição descoberta aqui precise virar um 7º hub). */
  uncoveredSlugs: readonly string[];
}

/**
 * Pure: cruza o corpus confirmado contra os temas já publicados. Nunca
 * lança — corpus vazio ou tema vazio produzem contagens 0, não erro (mesmo
 * padrão fail-soft de `buildArquivoFaq`/`buildTemaNav`).
 */
export function computeCorpusIndexCoverage(
  editions: readonly CorpusEditionSummary[],
  themes: readonly ThemeCoverageInput[],
): CorpusIndexCoverageResult {
  const totalEditions = editions.length;
  const monthIndexCoveredEditions = editions.filter((e) => e.hasResolvableDate).length;

  const coveredSlugs = new Set<string>();
  const byTheme: ThemeCoverageBreakdown[] = themes.map((theme) => {
    const uniqueForTheme = new Set(theme.editionSlugs);
    for (const slug of uniqueForTheme) coveredSlugs.add(slug);
    return { slug: theme.slug, label: theme.label, editionCount: uniqueForTheme.size };
  });

  const corpusSlugs = new Set(editions.map((e) => e.slug));
  // Só slugs que de fato pertencem ao corpus confirmado entram na
  // cobertura/uncovered — um `editionSlug` órfão num JSON de tema (ex: dado
  // stale de uma regeneração anterior) não deve inflar
  // `themeIndexCoveredEditions` além de `totalEditions`.
  const themeIndexCoveredEditions = [...coveredSlugs].filter((slug) => corpusSlugs.has(slug)).length;

  const uncoveredSlugs = editions
    .map((e) => e.slug)
    .filter((slug) => !coveredSlugs.has(slug))
    .sort((a, b) => a.localeCompare(b));

  const themeCoveragePct =
    totalEditions === 0 ? 0 : Math.round((themeIndexCoveredEditions / totalEditions) * 1000) / 10;

  return {
    totalEditions,
    monthIndexCoveredEditions,
    themeIndexCoveredEditions,
    themeCoveragePct,
    byTheme,
    uncoveredSlugs,
  };
}

/**
 * Renderiza `CorpusIndexCoverageResult` como Markdown — o corpo de
 * `docs/corpus-index-status-5125.md`. Pure (recebe a data de geração como
 * parâmetro, nunca `Date.now()` internamente) pra ser testável sem mockar
 * relógio.
 */
export function renderCorpusIndexStatusMarkdown(
  result: CorpusIndexCoverageResult,
  opts: { generatedAt: string },
): string {
  const themeLines = result.byTheme
    .map((t) => `- **${t.label}** (\`${t.slug}\`): ${t.editionCount} edição(ões)`)
    .join("\n");
  const uncoveredPreview =
    result.uncoveredSlugs.length > 0
      ? result.uncoveredSlugs
          .slice(0, 20)
          .map((s) => `  - \`${s}\``)
          .join("\n") + (result.uncoveredSlugs.length > 20 ? `\n  - … e mais ${result.uncoveredSlugs.length - 20}` : "")
      : "  (nenhuma — todo o corpus confirmado está coberto por pelo menos 1 tema)";

  return `# Cobertura dos índices por mês e por tema (#5125)

Gerado em ${opts.generatedAt} por \`npx tsx scripts/corpus-index-coverage-report.ts\`.
Re-executar para reconfirmar antes de citar estes números (mesma disciplina do #1172 — nunca confiar em número escrito num doc sem re-derivar).

## Resultado

**Índice por mês** (\`https://arquivo.diar.ia.br/\`, #4105): ${result.monthIndexCoveredEditions}/${result.totalEditions} edições confirmadas têm slug+data resolvíveis — a condição que \`render-archive.ts\` exige pra incluir a edição no agrupamento por \`YYYY-MM\`. Página já em produção, server-renderizada por request a partir do sitemap oficial.

**Índice por tema** (\`https://arquivo.diar.ia.br/temas/\`, #4558 Parte A): ${result.themeIndexCoveredEditions}/${result.totalEditions} edições (${result.themeCoveragePct}%) são cobertas por pelo menos 1 dos 6 hubs temáticos já publicados. Por tema:

${themeLines}

Edições confirmadas sem nenhum tema (candidatas a tema futuro, ou legitimamente sem cobertura transversal — ver \`scripts/lib/corpus-index-coverage.ts\` docstring):

${uncoveredPreview}

## Por que nenhuma página nova foi publicada nesta unidade

O escopo trabalhável de #5125 (comentário 17/08/2026) pediu "índice por mês" e "índice por tema" derivados do corpus, publicados em host nosso. As duas superfícies **já existem em produção** cobrindo o corpus inteiro (números acima) — construir uma 3ª cópia em \`workers/artigos\` duplicaria \`arquivo.diar.ia.br\`/\`arquivo.diar.ia.br/temas/\`, contradizendo o próprio critério que a issue estabeleceu pra decisão (C): produzir superfície que NÃO existe, nunca espelhar o que já existe em host nosso. Este relatório fecha o item mecanicamente (checagem re-executável, não afirmação em prosa) em vez de adicionar mais uma página pra manter.
`;
}
