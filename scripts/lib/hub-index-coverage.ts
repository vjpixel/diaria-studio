/**
 * scripts/lib/hub-index-coverage.ts (#4903)
 *
 * Cruza os dois datasets que o projeto já tem: a lista de edições que um hub
 * temático cita (`scripts/lib/hubs/{slug}-sources.generated.json`, #4558
 * Parte A) e o relatório de cobertura de indexação do Google
 * (`data/seo/index-status-{data}.json`, `scripts/seo-index-check.ts`, #4105).
 *
 * Achado que motivou a issue (10/08/2026, hub `anthropic-claude`): das 76
 * URLs citadas pelo hub, 49 (64,5%) NÃO indexadas — bem pior que a
 * intuição "página nova de curadoria, conteúdo é edição já publicada", e o
 * número precisa condicionar a leitura do checkpoint de ~07/out (#4558).
 * Antes desta função, o cruzamento era manual (contagem à mão numa sessão) —
 * o item 1 da issue pede que vire script, porque a #4894 já mostrou que
 * prosa escrita à mão sobre um dataset que regenera (`generate-hub-sources.ts`)
 * envelhece na primeira regeneração seguinte.
 *
 * **Pure** — recebe os dois datasets já parseados (arrays), nunca lê disco.
 * `scripts/hub-index-coverage.ts` é o CLI fino que resolve os paths e chama
 * esta função.
 */

/** 1 entrada de `{slug}-sources.generated.json` — shape emitido por
 * `scripts/generate-hub-sources.ts`. Só os campos que este módulo usa
 * (`url` pro cruzamento, `date` pro guard de defasagem de relatório). */
export interface HubSourceEntry {
  /** `YYYY-MM-DD` — data de publicação da edição citada pelo hub. */
  date: string;
  editionSlug: string;
  url: string;
  matchedHeadlines: readonly string[];
  editionTitle?: string;
}

/** 1 linha de `rows[]` em `index-status-{data}.json` — shape de
 * `IndexStatus` (`scripts/seo-index-check.ts`), repetido aqui em vez de
 * importado pra manter este módulo livre de qualquer dependência de rede/
 * Google Search Console (`seo-index-check.ts` importa `google-auth.ts`,
 * que faz OAuth — este módulo é puro e não deve arrastar isso). */
export interface HubIndexStatusRow {
  url: string;
  /** "PASS" = indexada (sinal autoritativo — nunca comparar `coverageState`
   * por string, ver a mesma disciplina #573 em `seo-index-check.ts::summarize`). */
  verdict?: string;
  /** Texto localizado do Google, ex: "Detectada, mas não indexada no momento". */
  coverageState?: string;
  lastCrawlTime?: string;
  /** Vazio/ausente = órfã (só o sitemap aponta pra ela, sem link interno). */
  referringUrls?: readonly string[];
  error?: string;
}

export interface HubIndexCoverageResult {
  /** Total de entradas do hub (`hubEntries.length`). */
  hubTotal: number;
  /** URLs do hub encontradas no relatório (`matched + missing + tooRecent === hubTotal`). */
  matchedCount: number;
  /** URLs do hub NÃO encontradas no relatório e com `date <= reportDate` —
   * problema real: o relatório já deveria conhecê-las e não conhece. */
  missingUrls: string[];
  /** URLs do hub NÃO encontradas no relatório mas com `date > reportDate` —
   * informativo, não falha: a edição é mais recente que a última rodada do
   * relatório semanal (#seo-index-check.ts roda 1x/semana), então a
   * ausência é esperada, não um sintoma. */
  tooRecentUrls: string[];
  /** Contagem por `coverageState` — só sobre URLs `matched` (uma URL
   * ausente do relatório não tem `coverageState` a contar). Chave
   * `"(sem coverageState)"` agrupa `matched` sem esse campo. */
  byCoverageState: Record<string, number>;
  /** Entre as `matched`, quantas não têm `lastCrawlTime` — nunca foram
   * rastreadas (achado #4903: "49 não indexadas, 42 dessas nunca
   * rastreadas"). */
  noLastCrawlTimeCount: number;
  /** Entre as `matched`, quantas têm `referringUrls` vazio/ausente — órfãs
   * (só o sitemap aponta pra elas). */
  noReferringUrlsCount: number;
  /** `matched` com `verdict === "PASS"`. */
  indexedCount: number;
  /** `matchedCount - indexedCount`. */
  notIndexedCount: number;
}

/**
 * Cruza `hubEntries` (do hub) contra `indexRows` (do relatório de
 * indexação), reportando por-hub: contagem por `coverageState`, quantas sem
 * `lastCrawlTime`, quantas sem `referringUrls` — mais a separação
 * missing/tooRecent (ver docstring de `tooRecentUrls`).
 *
 * `reportDate` é a `date` do relatório (`index-status-{date}.json` →
 * `.date`, formato `YYYY-MM-DD`) — usada só pra classificar uma URL AUSENTE
 * do relatório como "problema real" (`missingUrls`) vs. "relatório ainda não
 * rodou depois desta edição" (`tooRecentUrls`). Comparação lexicográfica
 * funciona porque ambas as datas são `YYYY-MM-DD`.
 *
 * @pure
 */
export function crossReferenceHubIndexCoverage(
  hubEntries: readonly HubSourceEntry[],
  indexRows: readonly HubIndexStatusRow[],
  reportDate: string,
): HubIndexCoverageResult {
  const rowByUrl = new Map<string, HubIndexStatusRow>();
  for (const row of indexRows) {
    // Em caso de URL duplicada no relatório (não deveria acontecer, mas o
    // dataset é externo — Google), a última linha vence. Sem impacto
    // conhecido: seo-index-check.ts nunca produziu duplicata observada.
    rowByUrl.set(row.url, row);
  }

  const missingUrls: string[] = [];
  const tooRecentUrls: string[] = [];
  const byCoverageState: Record<string, number> = {};
  let noLastCrawlTimeCount = 0;
  let noReferringUrlsCount = 0;
  let indexedCount = 0;
  let matchedCount = 0;

  for (const entry of hubEntries) {
    const row = rowByUrl.get(entry.url);
    if (!row) {
      if (entry.date > reportDate) {
        tooRecentUrls.push(entry.url);
      } else {
        missingUrls.push(entry.url);
      }
      continue;
    }
    matchedCount++;
    const state = row.coverageState ?? "(sem coverageState)";
    byCoverageState[state] = (byCoverageState[state] ?? 0) + 1;
    if (!row.lastCrawlTime) noLastCrawlTimeCount++;
    if (!row.referringUrls || row.referringUrls.length === 0) noReferringUrlsCount++;
    if (row.verdict === "PASS") indexedCount++;
  }

  return {
    hubTotal: hubEntries.length,
    matchedCount,
    missingUrls,
    tooRecentUrls,
    byCoverageState,
    noLastCrawlTimeCount,
    noReferringUrlsCount,
    indexedCount,
    notIndexedCount: matchedCount - indexedCount,
  };
}

/** Formata `HubIndexCoverageResult` como texto de 1 bloco — usado pelo CLI
 * e reusável por quem quiser embutir o resumo em outro relatório (ex: um
 * comentário de issue). Pure. */
export function renderHubIndexCoverageSummary(hubSlug: string, result: HubIndexCoverageResult): string {
  const lines = [
    `# Cobertura de indexação do hub "${hubSlug}"`,
    "",
    `${result.indexedCount}/${result.matchedCount} indexadas (${result.hubTotal} URL(s) no hub, ${result.matchedCount} presentes no relatório).`,
  ];
  if (result.missingUrls.length > 0) {
    lines.push(`${result.missingUrls.length} URL(s) do hub AUSENTE(S) do relatório (não é rodada recente — problema real):`);
    for (const u of result.missingUrls) lines.push(`  - ${u}`);
  }
  if (result.tooRecentUrls.length > 0) {
    lines.push(`${result.tooRecentUrls.length} URL(s) do hub mais recente(s) que o relatório (esperado, não é falha):`);
    for (const u of result.tooRecentUrls) lines.push(`  - ${u}`);
  }
  lines.push("", "Por coverageState (só URLs presentes no relatório):");
  for (const [state, n] of Object.entries(result.byCoverageState).sort((a, b) => b[1] - a[1])) {
    lines.push(`  - ${n}× ${state}`);
  }
  lines.push(
    "",
    `${result.noLastCrawlTimeCount}/${result.matchedCount} nunca foram rastreadas (sem lastCrawlTime).`,
    `${result.noReferringUrlsCount}/${result.matchedCount} órfãs (sem referringUrls).`,
  );
  return lines.join("\n") + "\n";
}
