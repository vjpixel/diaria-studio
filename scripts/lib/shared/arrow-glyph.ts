/**
 * arrow-glyph.ts (#9721): regra "nunca a seta `→` em botão, link, CTA ou
 * copy que chega ao leitor".
 *
 * Pedido do editor (06/10/2026, a partir do botão "Garanta seu ingresso →"
 * da página do evento): tirar a seta de todos os lugares e impedir que
 * volte. Este módulo é a parte pura e sem dependências (importável pelo
 * render da newsletter e pelo carregador de caixas):
 *
 *  - `stripCtaArrows`: remoção MECÂNICA da seta nas posições de CTA (fim de
 *    rótulo de link/botão, `<span aria-hidden>→</span>`, prefixo de
 *    parágrafo `→ [label](url)`, lead-in `texto → <a>`). Usada em runtime
 *    pelo carregador de caixas (`data/snippets/` é gitignored: o repo não
 *    edita o conteúdo, mas o render nunca deixa a seta passar) e pelo
 *    `renderHTML` da newsletter. Foi também a regra aplicada uma vez aos
 *    HTML já versionados do site.
 *  - `findArrowGlyphs`: detecção usada pelo check de CI
 *    `scripts/check-no-arrow-glyph.ts` (a varredura AST dos geradores fica em
 *    `scripts/lib/no-arrow-glyph-scan.ts`, que depende de `typescript`).
 */

export const ARROW_GLYPH = "→";

/**
 * Remove a seta das posições de CTA, preservando o resto do texto. Idempotente.
 * Setas fora de posição de CTA (ex.: "87% → 68%" no corpo de uma edição
 * antiga) ficam intactas; quem decide sobre elas é o check, não esta função.
 */
export function stripCtaArrows(text: string): string {
  if (!text.includes(ARROW_GLYPH)) return text;
  return (
    text
      // `Ver curso <span aria-hidden="true">→</span>` vira `Ver curso`
      .replace(/[ \t]*<span aria-hidden="true">→<\/span>/g, "")
      // seta no fim do rótulo: `Ver →</a>`, `Próxima →</button>`, `[Ver →](url)`
      .replace(/[ \t]*→[ \t]*(?=<\/a>|<\/button>|\]\()/g, "")
      // prefixo de linha: `→ [label](url)` (sintaxe legada de CTA)
      .replace(/^([ \t]*)→[ \t]*/gm, "$1")
      // prefixo logo após abrir a tag: `<p style="…">→ <a href…>`
      .replace(/>[ \t]*→[ \t]*(?=<a[\s>]|\[)/g, ">")
      // lead-in antes do link: `Veja o ranking → <a>`, `apoiar → [apoia.se](…)`
      .replace(/[ \t]+→[ \t]+(?=<a[\s>]|\[)/g, ": ")
  );
}

/**
 * Backstop TOTAL das páginas do site (`/p/{slug}`, review do PR #9724): a
 * página de uma edição nova sai por PR automático (`publish-edition-site-page.ts`,
 * auto-merge #8158) e o check `check-no-arrow-glyph` reprova qualquer `→` em
 * `workers/site/public/**`. Uma seta EDITORIAL no corpo de um destaque
 * (`5,4% → 18%`) passaria intacta por `stripCtaArrows` e travaria o PR,
 * deixando `/p/{slug}` em 404. Aqui nenhuma seta sobra, em 3 passes:
 *
 *  1. Transição numérica (número dos dois lados, tags inline permitidas no
 *     meio): `5,4% → 18%`, `5,4% → <b>18%</b>`, `5,4% → <a …>18%</a>` viram
 *     `… para …` ("de 5,4% para 18%" é como o português lê a notação). Roda
 *     ANTES do passe de CTA de propósito: senão o lead-in `texto → <a>`
 *     transformaria `5,4% → <a>18%</a>` em `5,4%: 18%`, trocando o sentido.
 *  2. `stripCtaArrows` (posições de CTA, mesmo critério da newsletter).
 *  3. Qualquer seta restante (encadeamento editorial, `A → B → C`): a
 *     cercada de espaço vira ` – ` (meia-risca, a notação de sequência mais
 *     neutra), a solta vira `–`. Perde a direção visual da seta, mas a
 *     sequência continua legível, e a alternativa (PR travado, página fora
 *     do ar) é pior.
 *
 * Idempotente. Puro.
 */
export function normalizeArrowsForSite(text: string): string {
  if (!text.includes(ARROW_GLYPH)) return text;
  const numeric = text.replace(
    /(\d%?(?:<\/[a-z][^>]*>)*)[ \t]*→[ \t]*(?=(?:<[a-z][^>]*>)*[ \t]*(?:R\$|US\$|\$|[-+−])?[ \t]*\d)/gi,
    "$1 para ",
  );
  return stripCtaArrows(numeric)
    .replace(/[ \t]+→[ \t]+/g, " – ")
    .replaceAll(ARROW_GLYPH, "–");
}

export interface ArrowHit {
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
  /** Trecho em volta da seta (até ~40 chars de cada lado), pra mensagem. */
  context: string;
}

export function arrowHitAt(text: string, index: number): ArrowHit {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const col = index - before.lastIndexOf("\n");
  const context = text
    .slice(Math.max(0, index - 40), index + 41)
    .replace(/\s+/g, " ")
    .trim();
  return { line, col, context };
}

/**
 * Todas as ocorrências de `→` em `text`. `allowedFragments` são trechos
 * EXATOS (cada um contendo a seta) liberados: cada ocorrência de um fragmento
 * liberado é mascarada antes da busca, então uma seta NOVA no mesmo arquivo
 * continua sendo pega.
 */
export function findArrowGlyphs(text: string, allowedFragments: readonly string[] = []): ArrowHit[] {
  let masked = text;
  for (const frag of allowedFragments) {
    if (!frag.includes(ARROW_GLYPH)) continue;
    masked = masked.split(frag).join(frag.replaceAll(ARROW_GLYPH, "\u0000"));
  }
  const hits: ArrowHit[] = [];
  let i = masked.indexOf(ARROW_GLYPH);
  while (i !== -1) {
    hits.push(arrowHitAt(text, i));
    i = masked.indexOf(ARROW_GLYPH, i + 1);
  }
  return hits;
}
