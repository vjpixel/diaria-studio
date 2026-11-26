/**
 * markdown-primitives.ts (#7126, item 6 do plano do #3269)
 *
 * Primitivas PURAS de parsing de markdown compartilhadas pelos renderers da
 * diária (`scripts/lib/newsletter-render-html.ts`) e do mensal
 * (`scripts/lib/mensal/monthly-render.ts`) — mais alguns consumidores de
 * parse de baixo nível (`inline-link.ts`, `lint-checks/callout-placement.ts`).
 * Extraído porque as duas eram cópias byte-idênticas: `countDoubleAsterisk`
 * tinha 4 cópias (diária, mensal, `inline-link.ts`, `callout-placement.ts`) e
 * `isUnpairedBoldMarker` 3 (as mesmas 3 primeiras). Zero I/O, zero
 * dependência de domínio — seguro de importar em qualquer bundle (Worker
 * incluso), mesmo padrão de `shared/brand-wordmark.ts`/`shared/email-components.ts`
 * (#4797/#3269).
 *
 * Cada caller mantinha a duplicata por razões de camada (`inline-link.ts` é
 * PARSE de baixo nível, não deveria depender de RENDER;
 * `callout-placement.ts` é lint, não render; `monthly-render.ts` mantinha o
 * parser self-contained por não ter, até aqui, um lar genuíno em `shared/`)
 * — nenhuma dessas razões se aplica a IMPORTAR de `shared/`, que é
 * exatamente a camada mais baixa que todas já podem depender.
 */

/**
 * Conta ocorrências NÃO sobrepostas de `**` numa string (avança 2 posições a
 * cada match — "****" conta como 2, não 3). Usado pelos tokenizadores inline
 * de ambos os renderers pra checar paridade (par = tudo já pareado; ímpar =
 * sobra um `**` desemparelhado) ao decidir se um `**` colado a um link é uma
 * abertura/fechamento legítima de bold-wrap ou já está auto-pareado no texto
 * adjacente.
 */
export function countDoubleAsterisk(str: string): number {
  let count = 0;
  let idx = str.indexOf("**");
  while (idx !== -1) {
    count++;
    idx = str.indexOf("**", idx + 2);
  }
  return count;
}

/**
 * O `**` candidato (adjacente a um link, já removido de `adjacentText` pelo
 * caller) é um marcador genuinamente desemparelhado — livre pra abrir/fechar
 * o bold-wrap do link — ou já está auto-pareado dentro de `adjacentText`
 * (não deve fundir com o link)? Contagem ÍMPAR de `**` em `adjacentText` = há
 * um marcador anterior sem par, que consome o candidato (já auto-pareado,
 * não funde). Contagem PAR (0, 2, 4...) = todos os marcadores anteriores já
 * se pareiam entre si, o candidato está de fato livre pra fundir com o link.
 * Mesma heurística usada nos dois lados (abertura/fechamento) por ambos os
 * renderers — divergir os dois lados foi um bug real no passado (#3280).
 */
export function isUnpairedBoldMarker(adjacentText: string): boolean {
  return countDoubleAsterisk(adjacentText) % 2 === 0;
}

/**
 * Varre `s` a partir de `from` (posição logo após o `(` de abertura de um
 * destino de link markdown `[label](...`), balanceando parênteses — `(`
 * aprofunda, `)` em profundidade 0 fecha. Retorna o índice do `)` de
 * fechamento, ou `s.length` se não houver fechamento (destino inválido/sem
 * `)`).
 *
 * Scanner de baixo nível por trás de `findMarkdownLinks`
 * (`newsletter-render-html.ts`) e do loop equivalente em
 * `renderInline`/`nextLinkStartIndex` (`monthly-render.ts`) — sem isso, um
 * destino com parênteses literais (ex: `.../arquivo%20(1).pdf`) truncava no
 * primeiro `)` e o resto do texto vazava cru no HTML (#1634/#1917).
 */
export function scanBalancedParenClose(s: string, from: number): number {
  let depth = 0;
  let j = from;
  for (; j < s.length; j++) {
    const ch = s[j];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  return j;
}

/**
 * Índice do próximo `[label](url)` VÁLIDO (parênteses balanceados, URL
 * não-vazia) em `str` a partir de `from`, ou `str.length` se não houver mais
 * nenhum (#14056 — antes duplicado como `nextLinkStartIndex` na diária e na
 * mensal). Delimita o texto conector entre 2 links ao decidir a paridade de
 * `**` (#3280/#3284/#3316).
 *
 * `trimUrl`: a cópia da diária reusava `findMarkdownLinks`, que faz `trim()`
 * da URL, então um destino só de espaços (`[b]( )`) NÃO contava como
 * boundary ali; a da mensal não fazia `trim()` e contava. Divergência
 * acidental, preservada pelo parâmetro para a extração não mudar o HTML de
 * nenhum dos lados (critério de aceite do #14056).
 */
export function nextValidLinkStart(str: string, from: number, trimUrl = false): number {
  const rest = str.slice(from);
  const linkStart = /\[([^\]]+)\]\(/g;
  let m: RegExpExecArray | null;
  while ((m = linkStart.exec(rest)) !== null) {
    const destStart = m.index + m[0].length;
    const j = scanBalancedParenClose(rest, destStart);
    if (j >= rest.length) continue; // sem `)` de fechamento — não é link válido
    const url = rest.slice(destStart, j);
    if ((trimUrl ? url.trim() : url).length > 0) return from + m.index;
    linkStart.lastIndex = j + 1;
  }
  return str.length;
}

/** Resultado de {@link decideBoldLinkFusion}. */
export interface BoldLinkFusion {
  /** O `**` colado dos dois lados do link é o bold-wrap dele (sai `<strong>`). */
  fuse: boolean;
  /** Texto entre o fim do token anterior e o `[` do link, já sem o `**` de abertura quando `fuse`. */
  textBefore: string;
  /** Onde o tokenizador retoma: logo após o `)` do link, ou após o `**` de fechamento quando `fuse`. */
  resumeAt: number;
}

/**
 * Decide se `**[label](url)**` funde em negrito-do-link (#3220/#3280/#3284/
 * #3316; porte na mensal, #3299). Antes duplicado dentro de `tokenizeInline`
 * (`newsletter-render-html.ts`) e de `renderInline` (`mensal/monthly-render.ts`);
 * unificado no #14056. Pura: cada renderer mantém o próprio HTML de saída.
 *
 * - `segmentStart`: fim do token anterior (início do texto ainda não emitido);
 * - `linkStart`: índice do `[` do link;
 * - `closeParen`: índice do `)` que fecha o destino do link.
 *
 * Só funde quando os DOIS lados têm um `**` colado ao link e genuinamente
 * desemparelhado no texto adjacente (`isUnpairedBoldMarker`): um `**` que já
 * fecha/abre um bold independente e só encosta no link não conta (#3280). Do
 * lado de depois, o texto adjacente vai até o próximo link válido; se esse
 * conector termina em `**` e tem contagem ÍMPAR, o `**` final é a abertura do
 * wrap do link seguinte e sai da conta (#3284); contagem PAR significa que o
 * conector já fecha sozinho e fica como está (#3316). `trimUrl` repassa a
 * semântica de cada renderer para {@link nextValidLinkStart}.
 */
export function decideBoldLinkFusion(
  input: string,
  segmentStart: number,
  linkStart: number,
  closeParen: number,
  trimUrl = false,
): BoldLinkFusion {
  const textBefore = input.substring(segmentStart, linkStart);
  const hasOpenBold = textBefore.endsWith("**") && isUnpairedBoldMarker(textBefore.slice(0, -2));
  let hasCloseBold = false;
  // Lazy: o scan do próximo link só roda quando a abertura existe e há `**`
  // colado ao `)` (a fusão exige os dois lados).
  if (hasOpenBold && input.startsWith("**", closeParen + 1)) {
    const closeBoundary = nextValidLinkStart(input, closeParen + 3, trimUrl);
    let closeAdjacent = input.substring(closeParen + 3, closeBoundary);
    if (closeBoundary < input.length && closeAdjacent.endsWith("**") && !isUnpairedBoldMarker(closeAdjacent)) {
      closeAdjacent = closeAdjacent.slice(0, -2);
    }
    hasCloseBold = isUnpairedBoldMarker(closeAdjacent);
  }
  const fuse = hasOpenBold && hasCloseBold;
  return {
    fuse,
    textBefore: fuse ? textBefore.slice(0, -2) : textBefore,
    resumeAt: fuse ? closeParen + 3 : closeParen + 1,
  };
}
