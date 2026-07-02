/**
 * categorized-json.ts (#2834 — EPIC #2808, enxugar scripts/lib/)
 *
 * `CategorizedJson`/`Highlight` — versão LOOSE (duck-typed, não-validante) do
 * shape de `01-categorized.json`, usada por scripts que só *leem* campos
 * pontuais (extração de título/URL de destaque, checagem de temas repetidos,
 * dedup evergreen) sem precisar (nem poder, dado formatos históricos
 * variados) validar o documento inteiro.
 *
 * Antes deste módulo, este mesmo shape solto estava re-declarado quase
 * palavra-por-palavra em `check-highlight-themes.ts`, `check-secondary-
 * themes.ts`, `render-categorized-md.ts` e `dedup-evergreen-buckets.ts`.
 *
 * NÃO confundir com `CategorizedJson`/`Highlight` de
 * `scripts/lib/schemas/edition-state.ts` — aquele é o schema Zod ESTRITO
 * (fonte de verdade pra validação de `01-categorized.json`/`01-approved.json`
 * via `parseCategorizedJson`/`parseApprovedJson`). Ali `Highlight` é uma union
 * discriminada (flat vs nested #229) sem index signature — ótimo pra validar,
 * ruim pra ler ad-hoc (acessar `.article` num union sem type-guard quebra o
 * compilador quando um dos membros não declara o campo). Os scripts aqui
 * precisam ler tanto o formato flat (`{ url }`) quanto o nested
 * (`{ article: { url } }`, pós-#229) no MESMO trecho de código sem guard —
 * daí o index signature propositalmente permissivo. Ver #2834 (self-review)
 * pra essa distinção; não é duplicação a se resolver, é uma dupla de tipos
 * com propósitos diferentes (validar vs. ler solto).
 */

import type { Article } from "./article.ts";

/** Item de `highlights[]`/`runners_up[]` — flat (pré-#229) ou nested (pós-#229). */
export interface Highlight {
  /** URL flat (formato legado pré-#229). */
  url?: string;
  title?: string;
  rank?: number;
  score?: number;
  /** Article com URL/título nested (formato spec-compliant pós-#229). */
  article?: { url?: string; title?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface CategorizedJson {
  highlights?: Highlight[];
  runners_up?: Highlight[];
  lancamento?: Article[];
  // #1629: buckets renomeados pra refletir seções da newsletter.
  radar?: Article[];
  use_melhor?: Article[];
  video?: Article[];
  /** Número total de artigos considerados antes da filtragem do scorer. */
  total_considered?: number;
  [key: string]: unknown;
}
