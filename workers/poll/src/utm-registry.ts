/**
 * workers/poll/src/utm-registry.ts (#4041)
 *
 * **Espelho local** dos VALORES de UTM declarados em
 * `scripts/lib/shared/utm-registry.ts` — a fonte da verdade do projeto.
 *
 * Por que uma cópia e não um import direto? O bundle do Worker é construído
 * pelo `wrangler`/esbuild a partir de `workers/poll/src/**` e nunca alcança
 * `scripts/**` — nenhum arquivo deste diretório importa de fora dele hoje. O
 * precedente é `ds-tokens.generated.ts`, que resolve exatamente o mesmo
 * problema (design tokens compartilhados) com uma cópia local. Um import
 * relativo `../../../scripts/lib/shared/...` funcionaria no `tsc --noEmit` mas
 * arrastaria o diretório inteiro pra dentro do grafo do bundle — risco
 * desnecessário num artefato que sobe pra produção.
 *
 * **A sincronia é lint-enforced:** `test/utm-registry-mirror.test.ts` compara
 * este arquivo com o shared e falha se qualquer valor divergir. Editar um dos
 * dois sem o outro quebra o CI — que é o único jeito de a cópia não virar drift.
 *
 * NÃO adicionar lógica aqui. Só literais.
 */

/** @see scripts/lib/shared/utm-registry.ts — EIA_STANDALONE_SOURCE */
export const EIA_STANDALONE_SOURCE = "eia-standalone";

/** @see scripts/lib/shared/utm-registry.ts — EIA_ARCHIVE_UTM */
export const EIA_ARCHIVE_UTM = {
  source: "newsletter",
  medium: "email",
  campaign: "eia-arquivo",
} as const;

/** @see scripts/lib/shared/utm-registry.ts — JOGAR_POSVOTO_UTM */
export const JOGAR_POSVOTO_UTM = {
  source: EIA_STANDALONE_SOURCE,
  medium: "jogar",
  campaign: "eia-jogar-posvoto",
} as const;

/** @see scripts/lib/shared/utm-registry.ts — QUIZ_POSVOTO_UTM */
export const QUIZ_POSVOTO_UTM = {
  source: EIA_STANDALONE_SOURCE,
  medium: "quiz",
  campaign: "eia-quiz-posvoto",
} as const;

/** @see scripts/lib/shared/utm-registry.ts — JOGAR_INLINE_UTM */
export const JOGAR_INLINE_UTM = {
  source: EIA_STANDALONE_SOURCE,
  medium: "jogar-inline",
  campaign: "eia-jogar-inline-signup",
} as const;

/** @see scripts/lib/shared/utm-registry.ts — EMBED_UTM */
export const EMBED_UTM = {
  source: "embed",
  medium: "widget",
  defaultPartner: "generico",
} as const;

/** @see scripts/lib/shared/utm-registry.ts — SHARE_UTM_CAMPAIGN */
export const SHARE_UTM_CAMPAIGN = "eia-share";
/** @see scripts/lib/shared/utm-registry.ts — QUIZ_SHARE_UTM_CAMPAIGN */
export const QUIZ_SHARE_UTM_CAMPAIGN = "eia-quiz-share";

/** @see scripts/lib/shared/utm-registry.ts — LIVROS_INLINE_UTM */
export const LIVROS_INLINE_UTM = {
  source: "livros",
  campaign: "livros-inline-signup",
  hero: { medium: "inline-hero" },
  footer: { medium: "inline-footer" },
} as const;
