/**
 * categorized-buckets.ts (#1670/#1671)
 *
 * Normaliza um objeto `categorized` (pré OU pós-#1629) para os 4 buckets
 * canônicos `{ lancamento, radar, use_melhor, video }`, sempre arrays.
 *
 * Por que: #1629 renomeou os buckets (pesquisa+noticias → radar; tutorial →
 * use_melhor). Readers que iteram só os nomes novos, ao receberem um
 * `categorized.json` LEGACY (resume de edição cujo step pré-#1629 completou, ou
 * fixture antiga), ou (a) crashavam ao ler `input.radar` undefined sem `?? []`
 * (topic-cluster #1671), ou (b) dropavam silenciosamente os artigos legacy
 * (finalize-stage1 #1670 — mesma classe do silent-loss do #1642). Este helper
 * centraliza o remap + o default `[]` num só lugar (os readers irmãos dedup.ts /
 * filter-date-window.ts / refresh-past-editions.ts já guardavam isolados).
 *
 * Genérico no tipo do artigo pra não acoplar a lib ao tipo Article de nenhum
 * script específico.
 */

export interface NormalizedBuckets<T = unknown> {
  lancamento: T[];
  radar: T[];
  use_melhor: T[];
  video: T[];
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Mapeia qualquer shape de categorized pros 4 buckets canônicos:
 * - `lancamento`/`video`: passthrough (com default []).
 * - `radar`: une `radar` + legacy `pesquisa` + legacy `noticias`.
 * - `use_melhor`: une `use_melhor` + legacy `tutorial`.
 * Nunca lança — buckets ausentes viram [].
 */
export function normalizeCategorizedBuckets<T = unknown>(
  c: Record<string, unknown> | null | undefined,
): NormalizedBuckets<T> {
  const src = (c ?? {}) as Record<string, unknown>;
  return {
    lancamento: asArray<T>(src.lancamento),
    radar: [
      ...asArray<T>(src.radar),
      ...asArray<T>(src.pesquisa),
      ...asArray<T>(src.noticias),
    ],
    use_melhor: [...asArray<T>(src.use_melhor), ...asArray<T>(src.tutorial)],
    video: asArray<T>(src.video),
  };
}
