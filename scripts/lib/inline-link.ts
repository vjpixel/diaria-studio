/**
 * inline-link.ts (#599)
 *
 * Helper compartilhado pra extrair `[título](URL)` (markdown link) de uma
 * linha. Usado pelos parsers de destaque/seção do `02-reviewed.md` durante
 * a transição de "URL em linha separada" pra "URL inline no título" (#599).
 *
 * Parsers aceitam ambos os formatos durante a transição — quando o caller
 * recebe `null`, deve usar o fallback legacy (linha solo de URL).
 */

export interface InlineLink {
  title: string;
  url: string;
}

export interface InlineLinkWithTrailing extends InlineLink {
  trailing: string;
}

/**
 * Conta ocorrências NÃO sobrepostas de `**` numa string (avança 2 posições a
 * cada match). Espelha `countDoubleAsterisk` de `newsletter-render-html.ts`
 * (#3300) — duplicado aqui (não importado) porque `inline-link.ts` é a
 * camada de PARSE de baixo nível, consumida por `newsletter-parse.ts`/
 * `normalize-newsletter.ts`/`extract-destaques.ts`/lint-checks, e não deveria
 * ganhar uma dependência da camada de RENDER (`newsletter-render-html.ts`).
 */
function countDoubleAsterisk(str: string): number {
  let count = 0;
  let idx = str.indexOf("**");
  while (idx !== -1) {
    count++;
    idx = str.indexOf("**", idx + 2);
  }
  return count;
}

/**
 * O `**` candidato é um marcador genuinamente desemparelhado em `adjacentText`
 * — livre pra fechar o bold-wrap — ou já auto-pareado ali (não deve fechar
 * nada)? Contagem PAR = tudo já pareado, candidato livre; ÍMPAR = sobra um
 * marcador anterior sem par que consome o candidato. Mesma heurística de
 * `isUnpairedBoldMarker` em `newsletter-render-html.ts` (#3280/#3300).
 */
function isUnpairedBoldMarker(adjacentText: string): boolean {
  return countDoubleAsterisk(adjacentText) % 2 === 0;
}

/**
 * #1662: parseia um markdown link `[título](URL http(s))` que COMEÇA a linha
 * (após whitespace + `**` opcional), escaneando o destino com **balanceamento
 * de parênteses** — `(` aprofunda, `)` em depth 0 fecha — exatamente como
 * `processInlineLinks` (#1634). Sem isso, URLs com parênteses literais (ex.:
 * `.../GPT_(modelo)`, `.../file%20(1).pdf`) eram cortadas no primeiro `)`: o
 * regex antigo (`[^\s)]+`) parava cedo, e a linha caía no fallback (link
 * morto + título cru no email).
 *
 * Retorna `{ rawTitle, url, rest }`:
 *  - `rawTitle`: texto entre `[...]` (sem strip de `**`).
 *  - `url`: destino http(s) com parênteses balanceados.
 *  - `rest`: o que sobra após o `)` de fechamento, com um `**` de fechamento
 *    opcional já consumido.
 * `null` se a linha não começa com um link http(s) bem-formado.
 */
function parseLinkAtLineStart(
  line: string,
): { rawTitle: string; url: string; rest: string } | null {
  // `**` de abertura é opcional e independente do de fechamento (#590).
  // Capturado em grupo próprio (`hasOpenBold` abaixo) — precisa saber se
  // REALMENTE houve abertura antes de tratar um `**` colado ao fechamento
  // como o par dela (#3300).
  const head = line.match(/^\s*(\*\*)?\[([^\]]+)\]\(/);
  if (!head) return null;
  const hasOpenBold = head[1] === "**";
  const rawTitle = head[2];
  const destStart = head[0].length;
  // Destino precisa ser http(s) — rejeita `[t](example.com)` e `[t]()`.
  if (!/^https?:\/\//.test(line.slice(destStart))) return null;
  // Scan balanceando parênteses até o `)` de fechamento do markdown link.
  // Whitespace no destino encerra o scan SEM fechar → URL inválida (preserva o
  // gate `[^\s)]` do regex antigo: destino com espaço cru cai no fallback, não
  // vira href quebrado).
  let depth = 0;
  let j = destStart;
  let closed = false;
  for (; j < line.length; j++) {
    const ch = line[j];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) {
        closed = true;
        break;
      }
      depth--;
    } else if (/\s/.test(ch)) {
      break; // espaço no destino → não fechou com `)` → inválido
    }
  }
  if (!closed) return null; // sem `)` de fechamento (ou whitespace no meio)
  const url = line.slice(destStart, j);
  if (!url) return null;
  let rest = line.slice(j + 1);
  if (rest.startsWith("**")) {
    const closeAdjacent = rest.slice(2);
    // #3300: `**` colado logo após o link SÓ é consumido como fechamento do
    // wrap de negrito quando (a) HOUVE abertura `**` antes do `[`
    // (`hasOpenBold`) E (b) o candidato está genuinamente desemparelhado no
    // restante da linha (paridade par/ímpar de `**`, mesma heurística de
    // `isUnpairedBoldMarker`). Antes, `rest.startsWith("**")` disparava o
    // strip incondicionalmente — mesmo SEM abertura — corrompendo texto
    // colado ao link que é na verdade um bold INDEPENDENTE (ex:
    // `[Título](url)**Atualização:** resto`, onde o `**` abre essa frase,
    // não fecha um wrap do link que nunca existiu).
    if (hasOpenBold) {
      if (isUnpairedBoldMarker(closeAdjacent)) rest = closeAdjacent;
    } else if (closeAdjacent.trim() === "") {
      // #3351: `**` de fechamento SOLO (sem abertura correspondente) é
      // tolerado quando é o ÚNICO conteúdo restante da linha (nada, ou só
      // whitespace, depois dele) — perda do marcador de ABERTURA por edição
      // manual no Drive ou um passe do humanizador que corta só um lado.
      // Espelha o comportamento pré-#3300 (incondicional) mas SÓ nesse caso
      // estrito — não reabre o bug do #3300: quando sobra conteúdo real após
      // o `**` (ex: `**Atualização:** resto`), isso é bold independente
      // colado, não fechamento solo, e o `**` permanece intocado (cai no
      // branch acima, condição falsa, `rest` inalterado).
      rest = closeAdjacent;
    }
  }
  return { rawTitle, url, rest };
}

/**
 * Strip de `**...**` externo balanceado no título (#1051) — o source
 * `02-reviewed.md` usa `[**Título**](url)` como convenção de h1, mas no HTML
 * o `font-weight:bold` vem do CSS; sem o strip os asteriscos vazariam. Só
 * strippa quando ABRE e FECHA com `**` (não toca em unbalanced ou nested).
 * Retorna "" se o título ficar vazio após o strip.
 */
function normalizeTitle(rawTitle: string): string {
  let title = rawTitle.trim();
  if (title.length >= 4 && title.startsWith("**") && title.endsWith("**")) {
    title = title.slice(2, -2).trim();
  }
  return title;
}

/**
 * Tenta parsear linha como `[título](URL)` (link puro — nada depois do link).
 * Retorna `null` se não bater o pattern (caller decide fallback).
 *
 * Aceita wrapping em **negrito** (#590) — `**[Título](URL)**` é equivalente
 * a `[Título](URL)` — e strippa `**...**` interno balanceado no título (#1051).
 */
export function parseInlineLink(line: string): InlineLink | null {
  const m = parseLinkAtLineStart(line);
  if (!m) return null;
  if (m.rest.trim() !== "") return null; // texto após o link → não é link puro
  const title = normalizeTitle(m.rawTitle);
  const url = m.url.trim();
  if (!title || !url) return null;
  return { title, url };
}

/**
 * Retorna `true` se a linha é um inline link puro (título + URL na mesma
 * linha, sem texto depois). Útil pros parsers que só precisam classificar.
 */
export function isInlineLinkLine(line: string): boolean {
  return parseInlineLink(line) !== null;
}

/**
 * #1581: extrai inline link + trailing text quando a linha tem ambos.
 * Caso real: Drive pull (#1582) reformata `**[Title](url)**  \nsummary`
 * pra `[**Title**](url) summary` (link wraps bold, summary inline) —
 * `parseInlineLink` rejeita porque tem texto após o link.
 *
 * Retorna `null` se a linha não tem link ou se o link consome a linha toda
 * (caller usa `parseInlineLink` nesse caso).
 */
export function parseInlineLinkWithTrailing(
  line: string,
): InlineLinkWithTrailing | null {
  const m = parseLinkAtLineStart(line);
  if (!m) return null;
  // #1581: o trailing precisa ser separado por whitespace (preserva o `\s+` do
  // regex antigo) — `[T](url).` colado em pontuação NÃO é "link + summary".
  if (!/^\s/.test(m.rest)) return null;
  const trailing = m.rest.trim();
  if (trailing === "") return null; // sem trailing → caller usa parseInlineLink
  const title = normalizeTitle(m.rawTitle);
  const url = m.url.trim();
  if (!title || !url) return null;
  return { title, url, trailing };
}
