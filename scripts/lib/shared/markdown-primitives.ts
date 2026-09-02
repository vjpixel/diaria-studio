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
