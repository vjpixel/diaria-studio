/**
 * social-post-text.ts (#10441)
 *
 * PONTO ÚNICO que transforma o texto de um bloco `## dN` (ou `## um`) de
 * `03-social.md` no texto "de post" — o que de fato vai no payload de
 * LinkedIn (página e pessoal), Facebook, Instagram, Threads e X — e no
 * preview social do gate (`render-social-html.ts`).
 *
 * ## A convenção (#6086 item c, #6862, #10441)
 *
 *   03-social.md ──┬──▶ texto do post (todo canal + preview)  → SEM negrito
 *                  │      via `toSocialPostText` (este arquivo)
 *                  └──▶ cards do carrossel (gen-carousel-cards.ts) → COM negrito
 *                         lê o `## dN` cru, `**...**` vira <tspan bold>
 *
 * Nenhuma plataforma onde publicamos renderiza negrito no texto do post
 * (pedido do editor no gate 4 da 261019) — o `**` existe na fonte só pros
 * cards. Por isso a remoção acontece aqui, nunca na fonte nem no
 * `social-writer`, e nunca dentro de `extractDestaqueBlock` (que o carrossel
 * também usa).
 *
 * Todo publicador social chama `toSocialPostText` no texto final (depois de
 * injetar CTA/URL), em vez de importar `stripMarkdownEmphasis` direto — o
 * guard `test/social-post-text-no-bold-10441.test.ts` trava isso, pra que um
 * publicador novo não dependa de "lembrar" da regra.
 */
import { stripMarkdownEmphasis } from "./strip-markdown-emphasis.ts";

/**
 * Pure: texto do post sem marcação de ênfase markdown. Além do
 * `stripMarkdownEmphasis` (pares `**`/`__`/`*`/`_`), remove qualquer `**`
 * residual — um par desbalanceado (`**trecho` sem fechar, editado à mão no
 * gate) não é ênfase pra `stripMarkdownEmphasis`, mas sairia literal no post;
 * `**` nunca é conteúdo legítimo num post social. Idempotente.
 */
export function toSocialPostText(text: string): string {
  return stripMarkdownEmphasis(text).replace(/\*\*/g, "");
}
