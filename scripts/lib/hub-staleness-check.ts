/**
 * scripts/lib/hub-staleness-check.ts (#4924)
 *
 * "Alternativa mais barata" da issue #4924 (item 5) — detecta quando o
 * dataset commitado de um hub (`scripts/lib/hubs/{slug}-sources.generated.json`,
 * gerado por `scripts/generate-hub-sources.ts`) ficou defasado em relação ao
 * cache Beehiiv sincronizado (`data/beehiiv-cache/posts/*.json`, atualizado
 * a cada edição no Stage 0, `beehiiv-sync.ts`): uma edição CONFIRMADA cujo
 * título/subtítulo casa `HUB_KEYWORD_PATTERNS` de algum hub, mas cujo
 * `editionSlug` não aparece no `.generated.json` daquele hub.
 *
 * **Não confundir com `scripts/lib/hub-match.ts` (#4907)** — aquele decide,
 * na hora da ESCRITA de uma edição nova, se as manchetes do dia casam
 * exatamente 1 hub (pra injetar um link contextual no corpo do destaque).
 * Este módulo audita o HISTÓRICO inteiro do cache contra os datasets já
 * commitados — pergunta diferente ("o que já foi publicado e nunca entrou
 * no dataset?"), reusando a mesma fonte de matching (`HUB_KEYWORD_PATTERNS`
 * + `stripAccents`, ambos de `generate-hub-sources.ts` — nunca duplicados
 * aqui) mas comparando contra dado JÁ commitado, não contra um draft em
 * memória.
 *
 * **Cenário histórico que motivou a issue (04/08 → 10/08/2026):**
 * `anthropic-claude-sources.generated.json` parou em 2026-08-03 e ficou
 * parado até 2026-08-10, enquanto saía a edição de 06/08 ("Modelo da
 * Anthropic finge ser humano em teste") que casava o pattern — 4 dias de
 * drift silencioso, só corrigido porque outro trabalho tropeçou nele. Esta
 * função reproduz exatamente essa janela em teste (fixture sintética, não
 * o dataset real — a edição real já entrou no dataset em 10/08 e um teste
 * ancorado nela testaria zero desde então).
 *
 * **Só detecta — nunca regenera nem commita.** A decisão de política de
 * commit (issue #4924, item 2) ficou pra quando a task systemd (item 1-4,
 * fora do escopo desta unidade) rodar. Aqui o output é só uma lista pra o
 * playbook do Stage 6 imprimir no resumo do gate.
 */
import { HUB_KEYWORD_PATTERNS, collectHubSources, type HubSourceEntry } from "../generate-hub-sources.ts";
import type { RawCachedPost } from "../generate-arquivo-titles.ts";
import type { PublishDateOverridesResult } from "./beehiiv-publish-date.ts";

/** Uma edição confirmada que casa o pattern de um hub mas não está no
 * dataset commitado daquele hub. */
export interface StaleHubEdition {
  /** Slug do hub — chave de `HUB_KEYWORD_PATTERNS`. */
  hubSlug: string;
  /** `YYYY-MM-DD`, mesma resolução de `HubSourceEntry.date`. */
  date: string;
  editionSlug: string;
  editionTitle?: string;
  matchedHeadlines: string[];
}

export interface FindStaleHubEditionsResult {
  stale: StaleHubEdition[];
  /** Warnings propagados de `collectHubSources` por hub (post casado mas
   * sem slug/publish_date resolvível) — nunca descartados em silêncio,
   * mesmo racional do módulo que este reusa. Prefixados com `[{hubSlug}]`. */
  warnings: string[];
}

/**
 * Pure: para cada hub em `HUB_KEYWORD_PATTERNS`, roda `collectHubSources`
 * sobre `posts` e devolve as linhas cujo `editionSlug` NÃO aparece no
 * dataset commitado correspondente (`datasetsBySlug[hubSlug]`). Hub sem
 * entrada em `datasetsBySlug` é tratado como dataset vazio (tudo que casar
 * o pattern conta como stale) — nunca lança.
 *
 * @param posts            Cache Beehiiv (mesmo formato de `loadPosts()`,
 *   `generate-hub-sources.ts`) — só posts `status === "confirmed"` contam
 *   (delegado a `collectHubSources`).
 * @param datasetsBySlug    hub slug -> linhas já commitadas daquele hub
 *   (`{slug}-sources.generated.json` parseado). Injetável pra teste puro;
 *   `loadHubDatasets()` lê os arquivos reais.
 * @param overridesResult   Repassado a `collectHubSources` — injetável pra
 *   teste determinístico (default: lê `beehiiv-publish-date-overrides.json`
 *   commitado, mesmo default de `collectHubSources`).
 * @pure (com override explícito; sem ele, lê 1 arquivo commitado via
 *   `collectHubSources`'s próprio default)
 */
export function findStaleHubEditions(
  posts: RawCachedPost[],
  datasetsBySlug: Readonly<Record<string, readonly HubSourceEntry[]>>,
  overridesResult?: PublishDateOverridesResult,
): FindStaleHubEditionsResult {
  const stale: StaleHubEdition[] = [];
  const warnings: string[] = [];

  for (const [hubSlug, pattern] of Object.entries(HUB_KEYWORD_PATTERNS)) {
    const { rows, warnings: hubWarnings } =
      overridesResult !== undefined
        ? collectHubSources(posts, pattern, overridesResult)
        : collectHubSources(posts, pattern);
    for (const w of hubWarnings) warnings.push(`[${hubSlug}] ${w}`);

    const known = new Set((datasetsBySlug[hubSlug] ?? []).map((row) => row.editionSlug));
    for (const row of rows) {
      if (!known.has(row.editionSlug)) {
        stale.push({
          hubSlug,
          date: row.date,
          editionSlug: row.editionSlug,
          editionTitle: row.editionTitle,
          matchedHeadlines: row.matchedHeadlines,
        });
      }
    }
  }

  stale.sort((a, b) => a.date.localeCompare(b.date) || a.hubSlug.localeCompare(b.hubSlug));
  return { stale, warnings };
}

/**
 * Comandos de regen sugeridos pra um conjunto de hubs defasados — mesma
 * sequência que a docstring de `generate-hub-sources.ts` e o item 6 da
 * issue #4924 recomendam (regen por hub, depois `build-hub-page.ts --all`
 * uma vez só pra todos).
 *
 * @pure
 */
export function buildRegenCommands(staleHubSlugs: readonly string[]): string[] {
  const uniqueSorted = [...new Set(staleHubSlugs)].sort();
  if (uniqueSorted.length === 0) return [];
  return [
    ...uniqueSorted.map((slug) => `npx tsx scripts/generate-hub-sources.ts --hub ${slug}`),
    "npx tsx scripts/build-hub-page.ts --all",
  ];
}

/**
 * Formata `stale` num bloco de texto pronto pra imprimir no resumo do gate
 * do Stage 6 — ou string vazia se `stale` estiver vazio (nada a reportar,
 * caller decide se omite a seção inteira).
 *
 * @pure
 */
export function formatStaleHubReport(stale: readonly StaleHubEdition[]): string {
  if (stale.length === 0) return "";

  const byHub = new Map<string, StaleHubEdition[]>();
  for (const entry of stale) {
    const list = byHub.get(entry.hubSlug) ?? [];
    list.push(entry);
    byHub.set(entry.hubSlug, list);
  }

  const lines: string[] = [
    `⚠ HUBS DEFASADOS — ${stale.length} edição(ões) casam HUB_KEYWORD_PATTERNS mas não estão no dataset commitado:`,
    "",
  ];
  for (const [hubSlug, entries] of [...byHub.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${hubSlug}:`);
    for (const entry of entries) {
      const label = entry.editionTitle ?? entry.matchedHeadlines[0] ?? entry.editionSlug;
      lines.push(`  - ${entry.date} ${entry.editionSlug} ("${label}")`);
    }
    lines.push("");
  }
  lines.push("Regenerar:");
  for (const cmd of buildRegenCommands([...byHub.keys()])) lines.push(`  ${cmd}`);

  return lines.join("\n");
}
