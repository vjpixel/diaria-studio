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
 *    edita o conteúdo, mas o render nunca deixa a seta passar) e pelos
 *    blocos de CTA da newsletter (callouts e caixas). Foi também a regra
 *    aplicada uma vez aos HTML já versionados do site.
 *  - `stripUnambiguousCtaArrows`: só as posições que NUNCA são texto
 *    editorial (fim de rótulo, span decorativo, prefixo). Sem o lead-in, que
 *    é ambíguo: `A Meta → <a>Llama</a>` no corpo de um destaque é notação
 *    editorial e virar `A Meta: Llama` troca o sentido (#9727). É o que o
 *    `renderHTML` aplica no HTML INTEIRO da newsletter.
 *  - `normalizeNumericArrows`: transição numérica (`5,4% → 18%`) vira
 *    `5,4% para 18%`. Compartilhado pelo `renderHTML` e pelo
 *    `normalizeArrowsForSite` (#9727: antes só o segundo tinha, e a página
 *    `/p/` é construída do HTML que o primeiro já tinha estragado).
 *  - `findArrowGlyphs`: detecção usada pelo check de CI
 *    `scripts/check-no-arrow-glyph.ts` (a varredura AST dos geradores fica em
 *    `scripts/lib/no-arrow-glyph-scan.ts`, que depende de `typescript`).
 *    Pega também as formas escapadas (#9727 resíduo a).
 *
 * #9723 (decisão do editor, 05/10/2026): a regra vale também para a seta
 * para a esquerda `←` (links de volta/anterior). Detecção, decodificação de
 * entidade, remoção no início de rótulo de link e o backstop do site cobrem
 * as duas setas; a normalização numérica e o lead-in de CTA continuam só
 * para `→`, que é a única com esses usos.
 *
 * #9743 (decisão do editor, 06/10/2026): exceção estreita e contextual, só
 * no site, pra seta de direção na nav entre edições e na paginação do acervo
 * (`← Anterior: …` / `Próxima: … →`). Ver `maskSiteNavArrows`.
 */

export const ARROW_GLYPH = "→";

/**
 * Seta para a esquerda (#9723): a regra do #9721 foi estendida a ela por
 * decisão do editor (05/10/2026). Era o glifo dos links de volta/anterior do
 * site (`← diar.ia.br`, `← anterior`, `← {edição anterior}`); sem a `→` do
 * "próximo", a nav tinha ficado assimétrica.
 */
export const LEFT_ARROW_GLYPH = "←";

/**
 * Formas escapadas das setas que viram `→`/`←` no navegador ou no runtime
 * JS: entidade nomeada/decimal/hex do HTML e escape `\u2192` / `\u{2192}`
 * em literal de JS/TS (#9727 resíduo a; `←` = `&larr;`/`&#8592;`/`&#x2190;`/
 * `\u2190`, #9723). Case-insensitive.
 */
const ARROW_ESCAPE_SOURCE =
  String.raw`&rarr;|&#0*8594;|&#x0*2192;|\\u2192|\\u\{0*2192\}` +
  String.raw`|&larr;|&#0*8592;|&#x0*2190;|\\u2190|\\u\{0*2190\}`;

/** `→`, `←` e as formas escapadas. Global; sempre usar com `matchAll`/`replace`. */
export function arrowFormsRegex(): RegExp {
  return new RegExp(`${ARROW_GLYPH}|${LEFT_ARROW_GLYPH}|${ARROW_ESCAPE_SOURCE}`, "gi");
}

/** `true` se o texto tem uma das setas em qualquer forma (literal ou escapada). */
export function hasArrowForm(text: string): boolean {
  return arrowFormsRegex().test(text);
}

/**
 * Entidades HTML da seta (`&rarr;`, `&#8594;`, `&#x2192;`) viram o glifo,
 * pra os normalizadores tratarem uma forma só. Renderização idêntica no
 * navegador. O escape `→` de código-fonte NÃO é decodificado aqui:
 * estes normalizadores rodam sobre HTML/markdown, não sobre fonte JS.
 */
export function decodeArrowEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text
    .replace(/&rarr;|&#0*8594;|&#x0*2192;/gi, ARROW_GLYPH)
    .replace(/&larr;|&#0*8592;|&#x0*2190;/gi, LEFT_ARROW_GLYPH);
}

/** `true` se o texto (já com entidades decodificadas) tem `→` ou `←`. */
function hasGlyph(text: string): boolean {
  return text.includes(ARROW_GLYPH) || text.includes(LEFT_ARROW_GLYPH);
}

/**
 * Transição numérica (número dos dois lados, tags inline permitidas no
 * meio): `5,4% → 18%`, `5,4% → <b>18%</b>`, `5,4% → <a …>18%</a>`,
 * `US$ 20 → <a>US$ 10</a>` e o markdown `5,4% → [18%](u)` (#9731) viram `… para …` ("de 5,4% para 18%" é como o
 * português lê a notação). Roda ANTES de qualquer passe de lead-in de CTA:
 * senão `5,4% → <a>18%</a>` viraria `5,4%: 18%`, trocando o sentido
 * (#9721 review, #9727). Idempotente. Puro.
 */
export function normalizeNumericArrows(text: string): string {
  const t = decodeArrowEntities(text);
  if (!t.includes(ARROW_GLYPH)) return t;
  return t.replace(
    /(\d%?(?:<\/[a-z][^>]*>)*)[ \t]*→[ \t]*(?=(?:<[a-z][^>]*>|\[)*[ \t]*(?:R\$|US\$|\$|[-+−])?[ \t]*\d)/gi,
    "$1 para ",
  );
}

/**
 * Só as posições de CTA que nunca são texto editorial: fim de rótulo de
 * link/botão, span decorativo, prefixo de linha e prefixo logo após abrir a
 * tag. Não mexe em `texto → <a>` (ver `stripCtaArrows`). Idempotente.
 */
export function stripUnambiguousCtaArrows(text: string): string {
  const t = decodeArrowEntities(text);
  if (!hasGlyph(t)) return t;
  return (
    t
      // #9723, seta para a esquerda no INÍCIO do rótulo (links de volta/anterior):
      // `<a href="/">← Voltar</a>`, `<a rel="prev">← anterior</a>`, `[← Voltar](u)`
      .replace(/(<a\b[^>]*>|<button\b[^>]*>|\[)[ \t]*←[ \t]*/g, "$1")
      .replace(/<span aria-hidden="true">←<\/span>[ \t]*/g, "")
      .replace(/^([ \t]*)←[ \t]*/gm, "$1")
      // `Ver curso <span aria-hidden="true">→</span>` vira `Ver curso`
      .replace(/[ \t]*<span aria-hidden="true">→<\/span>/g, "")
      // seta no fim do rótulo: `Ver →</a>`, `Próxima →</button>`, `[Ver →](url)`
      .replace(/[ \t]*→[ \t]*(?=<\/a>|<\/button>|\]\()/g, "")
      // prefixo de linha: `→ [label](url)` (sintaxe legada de CTA)
      .replace(/^([ \t]*)→[ \t]*/gm, "$1")
      // prefixo logo após ABRIR a tag: `<p style="…">→ <a href…>`. Só tag de
      // abertura (#9749): `</strong> → <a>` e `</a> → <a>` são notação
      // editorial (`**Meta** → [Llama](u)`) e tirar a seta ali colava as
      // palavras ("MetaLlama") no e-mail e no site.
      .replace(/(<[a-z][^>]*>)[ \t]*→[ \t]*(?=<a[\s>]|\[)/gi, "$1")
  );
}

/** Placeholders de uso privado do Unicode: nunca aparecem no HTML das edições. */
const SITE_NAV_PREV_MASK = "\uE000";
const SITE_NAV_NEXT_MASK = "\uE001";

/**
 * Exceção da nav do site (#9743, decisão do editor de 06/10/2026): a seta
 * volta como indicador de direção SÓ nos links de navegação do site, e só na
 * posição que aponta pro lado certo:
 *
 *  - `←` no INÍCIO do rótulo de um `<a … rel="prev">` (`← Anterior: {título}`,
 *    `← anterior`);
 *  - `→` no FIM do rótulo de um `<a … rel="next">` (`Próxima: {título} →`,
 *    `próxima →`).
 *
 * Contextual, não allowlist por arquivo: `→` no link anterior, `←` no
 * próximo, seta no meio do rótulo ou fora desses links continuam reprovando
 * no check e sendo removidas pelo `normalizeArrowsForSite`. O rótulo não pode
 * ter tag (o builder emite só texto escapado). Quem emite a seta é
 * `navPrevLinkText`/`navNextLinkText`, pra nenhum gerador precisar de literal
 * com seta (os literais dos geradores seguem proibidos pelo check).
 */
const SITE_NAV_PREV_ARROW_RE = /(<a\b[^>]*\brel="prev"[^>]*>)←(?= [^<]*<\/a>)/g;
const SITE_NAV_NEXT_ARROW_RE = /(<a\b[^>]*\brel="next"[^>]*>[^<]* )→(?=<\/a>)/g;

/** Rótulo do link `rel="prev"` da nav do site, com a seta da exceção #9743. */
export function navPrevLinkText(label: string): string {
  return `${LEFT_ARROW_GLYPH} ${label}`;
}

/** Rótulo do link `rel="next"` da nav do site, com a seta da exceção #9743. */
export function navNextLinkText(label: string): string {
  return `${label} ${ARROW_GLYPH}`;
}

/**
 * Troca as setas permitidas da nav do site (#9743) por `mask` (mesmo
 * comprimento: 1 caractere por seta), pra os normalizadores e o check não as
 * enxergarem. `unmaskSiteNavArrows` desfaz. Puro.
 */
export function maskSiteNavArrows(text: string, prevMask = SITE_NAV_PREV_MASK, nextMask = SITE_NAV_NEXT_MASK): string {
  if (!hasGlyph(text)) return text;
  return text.replace(SITE_NAV_PREV_ARROW_RE, `$1${prevMask}`).replace(SITE_NAV_NEXT_ARROW_RE, `$1${nextMask}`);
}

function unmaskSiteNavArrows(text: string): string {
  return text.replaceAll(SITE_NAV_PREV_MASK, LEFT_ARROW_GLYPH).replaceAll(SITE_NAV_NEXT_MASK, ARROW_GLYPH);
}

/** Lookbehind: posição NÃO precedida de número (`18`, `5,4%`, `18%</b>`). */
const NOT_AFTER_NUMBER = String.raw`(?<![\d%](?:<\/[a-z][^>]*>)*)`;
/**
 * Alvo de link numérico logo após a seta: `<a …>18%</a>`, `<a><b>US$ 10`,
 * `[18%](u)`, `[R$ 5](u)`, `[-3](u)` (#9731).
 */
const NUMERIC_LINK_TARGET = String.raw`(?:<[a-z][^>]*>|\[)+[ \t]*(?:R\$|US\$|\$|[-+−])?[ \t]*\d`;

/**
 * Remove a seta das posições de CTA, preservando o resto do texto. Idempotente.
 * Setas fora de posição de CTA (ex.: "87% → 68%" no corpo de uma edição
 * antiga) ficam intactas; quem decide sobre elas é o check, não esta função.
 *
 * Inclui o lead-in `texto → <a>` (vira `texto: <a>`), que é AMBÍGUO fora de
 * um bloco de CTA (#9727). Por isso só roda onde o texto é sabidamente CTA:
 * caixas (`readSnippetFile`) e callouts/caixas da newsletter
 * (`renderIntroCallout`/`renderMidCallout`). O HTML inteiro da newsletter
 * usa `stripUnambiguousCtaArrows`.
 *
 * Duas exceções no lead-in: transição numérica (`5,4% → [18%](u)`, número
 * dos DOIS lados, #9731) não é lead-in, fica para `normalizeNumericArrows`; e seta logo depois de um
 * separador de lista de links (`[A](u) · → [B](u)`) só some, sem virar
 * `·:` (#9727 resíduo c, que fazia `isCtaOnlyParagraph` deixar de
 * reconhecer o parágrafo como só-CTA).
 */
export function stripCtaArrows(text: string): string {
  const t = stripUnambiguousCtaArrows(text);
  if (!t.includes(ARROW_GLYPH)) return t; // o lead-in só existe pra `→`
  return (
    t
      // separador antes da seta: `[A](u) · → [B](u)` vira `[A](u) · [B](u)`
      .replace(/([·•|])[ \t]*→[ \t]+(?=<a[\s>]|\[)/g, "$1 ")
      // lead-in antes do link: `Veja o ranking → <a>`, `apoiar → [apoia.se](…)`,
      // `cupom NEWS50 → [Assine](u)`. Só NÃO converte a transição numérica de
      // verdade, número dos DOIS lados (`5,4% → [18%](u)`, ver
      // normalizeNumericArrows). #9731: antes bastava o texto anterior terminar
      // em dígito (`Leia as 3 → [dicas](u)`) pra seta passar crua ao leitor.
      .replace(new RegExp(`(?:${NOT_AFTER_NUMBER}|(?![ \\t]+→[ \\t]+${NUMERIC_LINK_TARGET}))[ \\t]+→[ \\t]+(?=<a[\\s>]|\\[)`, "gi"), ": ")
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
 *  1. `normalizeNumericArrows` (transição numérica vira `para`).
 *  2. `stripUnambiguousCtaArrows` (fim de rótulo, span, prefixo). O lead-in
 *     `texto → <a>` NÃO vira `texto: <a>` aqui (#9727): a página é feita do
 *     `newsletter-final.html`, cujos blocos de CTA o `renderHTML` já limpou,
 *     então uma seta antes de link que sobrou é do corpo editorial
 *     (`A Meta → <a>Llama</a>`) e cai no passe 3.
 *  3. Qualquer seta restante (`→` ou `←`, #9723; encadeamento editorial, `A → B → C`): a
 *     cercada de espaço vira ` – ` (meia-risca, a notação de sequência mais
 *     neutra), a solta vira `–`. Perde a direção visual da seta, mas a
 *     sequência continua legível, e a alternativa (PR travado, página fora
 *     do ar) é pior.
 *
 * Exceção (#9743): as setas da nav do site na posição de direção
 * (`maskSiteNavArrows`) passam intactas pelos 3 passes.
 *
 * Idempotente. Puro.
 */
export function normalizeArrowsForSite(text: string): string {
  const t = decodeArrowEntities(text);
  if (!hasGlyph(t)) return t;
  // #9743: as setas da nav (`← Anterior`, `Próxima →`) ficam; o resto some.
  const masked = maskSiteNavArrows(t);
  return unmaskSiteNavArrows(
    stripUnambiguousCtaArrows(normalizeNumericArrows(masked))
      .replace(/[ \t]+[→←][ \t]+/g, " – ")
      .replaceAll(ARROW_GLYPH, "–")
      .replaceAll(LEFT_ARROW_GLYPH, "–"),
  );
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
 * Todas as ocorrências da seta em `text`, literal (`→`) ou escapada
 * (`&rarr;`, `&#8594;`, `&#x2192;`, `→`, `\u{2192}` — #9727 resíduo a).
 * `allowedFragments` são trechos EXATOS (cada um contendo a seta em alguma
 * forma) liberados: cada ocorrência de um fragmento liberado é mascarada
 * antes da busca, então uma seta NOVA no mesmo arquivo continua sendo pega.
 * `allowSiteNavArrows` aplica a exceção contextual da nav do site (#9743,
 * `maskSiteNavArrows`).
 */
export function findArrowGlyphs(
  text: string,
  allowedFragments: readonly string[] = [],
  opts: { allowSiteNavArrows?: boolean } = {},
): ArrowHit[] {
  // #9743: só pras páginas do site; a seta na posição de direção da nav passa.
  let masked = opts.allowSiteNavArrows ? maskSiteNavArrows(text, "\u0000", "\u0000") : text;
  for (const frag of allowedFragments) {
    if (!hasArrowForm(frag)) continue;
    // máscara de MESMO comprimento, pra os índices continuarem batendo com `text`
    masked = masked.split(frag).join(frag.replace(arrowFormsRegex(), (m) => "\u0000".repeat(m.length)));
  }
  return [...masked.matchAll(arrowFormsRegex())].map((m) => arrowHitAt(text, m.index));
}
