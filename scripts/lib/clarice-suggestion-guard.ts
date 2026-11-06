/**
 * clarice-suggestion-guard.ts (#11798)
 *
 * Filtro de RUÍDO sobre as sugestões da Clarice antes de qualquer apply
 * mecânico. Na edição 261103, uma chamada de `mcp__clarice__correct_text` com
 * o texto editorial inteiro (~25 parágrafos) devolveu 21 "correções" e
 * nenhuma era de conteúdo:
 *
 *   - 20 eram só `\n\n` inserido antes da 1ª palavra de cada parágrafo
 *     (`from: "Palavra"`, `to: "\n\nPalavra"`), algumas sem regra/explicação;
 *   - 1 trocava `.` por `."}]}]);\n}` ("ponto final dentro das aspas") —
 *     resto de serialização vazando do servidor pro campo `to`.
 *
 * O defeito é do servidor MCP externo (fora deste repo). Aqui a mitigação é
 * recusar, no apply, as duas formas que nunca são correção legítima de texto
 * editorial:
 *
 *   1. `whitespace_only` — `from` e `to` só diferem em espaço, e a diferença é
 *      estrutural: muda a quantidade de quebras de linha ou fica só na borda
 *      das linhas (começo/fim do trecho, indentação). Isso muda o markdown
 *      (parágrafos, listas, hard break), nunca a língua. Espaço no MEIO da
 *      linha não é ruído (#11867): `afim de`→`a fim de`, `Porque`→`Por que`,
 *      `texto,outro`→`texto, outro` são correções reais e passam. Continua
 *      ruído quando a quebra muda de lugar (#11876) ou quando o espaço cai
 *      dentro de URL/domínio/markup markdown (#11875: `openai. com`,
 *      `** negrito**`, `-item`, `##Título`).
 *   2. `structural_injection` — `to` introduz quebra de linha nova ou um
 *      caractere de código (`{ } [ ] < > \` ou backtick) que não existia em
 *      `from`. Português corrido não ganha chave/colchete numa correção, e
 *      quebra de linha nova reestrutura o markdown.
 *
 * Função pura, sem I/O — consumida por `scripts/clarice-apply.ts` (caminho do
 * MCP) e por `scripts/lib/clarice-chunk.ts` (fallback REST chunked), pra que
 * os dois caminhos recusem o mesmo ruído.
 */

export type ClariceNoiseReason = "whitespace_only" | "structural_injection";

/** Caracteres que nunca entram em texto editorial por uma correção da Clarice. */
const CODE_CHARS = ["{", "}", "[", "]", "<", ">", "\\", "`"] as const;

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Apara cada linha (borda do texto inteiro e borda de cada linha). */
function trimLines(s: string): string {
  return s
    .split("\n")
    .map((l) => l.trim())
    .join("\n");
}

/**
 * Quebra de linha que muda de LUGAR (#11876): com a mesma quantidade de `\n`,
 * cada linha precisa conter os mesmos caracteres visíveis. `a b\nc`→`a\nb c`
 * desloca a fronteira de parágrafo sem mudar a contagem.
 */
function linesShifted(from: string, to: string): boolean {
  const a = from.split("\n");
  const b = to.split("\n");
  return a.some((line, i) => stripWhitespace(line) !== stripWhitespace(b[i] ?? ""));
}

/**
 * Para cada caractere visível `k` (índice no texto sem espaços), o espaço que
 * vem antes dele. `gaps[n]` é o espaço depois do último caractere visível.
 */
function whitespaceGaps(s: string): { chars: string[]; gaps: string[] } {
  const chars: string[] = [];
  const gaps: string[] = [];
  let pending = "";
  for (const c of s) {
    if (/\s/.test(c)) {
      pending += c;
    } else {
      gaps.push(pending);
      chars.push(c);
      pending = "";
    }
  }
  gaps.push(pending);
  return { chars, gaps };
}

/**
 * Palavra (sequência de caracteres visíveis) que encosta no ponto `k`, em uma
 * das versões: o que vem antes até o espaço anterior, e o que vem depois até
 * o próximo espaço. `atLineStart` diz se a parte da esquerda começa no início
 * de linha (ou do trecho, que pode ser início de linha no texto inteiro).
 */
function tokenAround(
  chars: string[],
  gaps: string[],
  k: number,
): { left: string; right: string; atLineStart: boolean } {
  let i = k - 1;
  while (i > 0 && gaps[i] === "") i--;
  let j = k + 1;
  while (j < chars.length && gaps[j] === "") j++;
  const left = chars.slice(Math.max(i, 0), k).join("");
  const right = chars.slice(k, j).join("");
  const atLineStart = i <= 0 || gaps[i].includes("\n");
  return { left, right, atLineStart };
}

/** Marcador de bloco markdown no início da linha: lista, lista numerada, título, citação. */
const LINE_MARKER = /^(?:[-*+]|\d+[.)]|#{1,6}|>)/;
/**
 * TLDs comuns no texto da edição. Domínio "solto" só conta como domínio quando o
 * sufixo é um destes e termina em fronteira de palavra (#11974): sem a lista,
 * `ok.então` e `funciona.depois` (falta de espaço real depois do ponto, antes de
 * minúscula) casavam como domínio e a correção da Clarice era recusada. Fora
 * da lista, de propósito, TLDs que são palavra em português (`de`, `me`, `se`,
 * `es`...): `isso.de novo` é falta de espaço, não domínio alemão.
 */
const COMMON_TLDS =
  "com|br|ai|io|org|net|dev|app|co|tv|gov|edu|info|news|blog|tech|xyz|sh|ly|gg|pt|uk|fr|eu|jp|cn";
/**
 * URL, link markdown ou domínio. Domínio é: `openai.com`/`diar.ia.br` (TLD da
 * lista em fronteira de palavra), host com 2+ pontos ASCII (`blog.google.com`)
 * ou `x.y/caminho`. TLD minúsculo pra não pegar `fim.Começo`; lista + fronteira
 * pra não pegar `ok.então` (#11974).
 */
const URL_LIKE = new RegExp(
  String.raw`:\/\/|\]\(|www\.|[A-Za-z0-9-]\.(?:${COMMON_TLDS})(?![\p{L}\p{N}])` +
    String.raw`|[A-Za-z0-9-]\.[a-z0-9-]+\.[a-z]{2,}(?![\p{L}\p{N}])|[A-Za-z0-9-]\.[a-z]{2,}\/`,
  "u",
);
/**
 * Domínio de sufixo fora da lista (#11993): `Bolt.new`, `Pika.art`, `Manus.im`,
 * `Notion.so`, `deepmind.google`. O padrão antigo (`x.yy` qualquer) volta como
 * fallback, mas só com sufixo ASCII minúsculo inteiro até a fronteira de palavra
 * (`ok.então` não casa: `ã` é letra e corta o sufixo) e que não seja palavra
 * portuguesa comum (`funciona.depois`, `isso.de novo` seguem sendo falta de
 * espaço, #11974).
 */
const BARE_DOMAIN = /[A-Za-z0-9-]\.([a-z]{2,})(?![\p{L}\p{N}])/gu;
/**
 * Palavras portuguesas só-ASCII que podem vir coladas depois de um ponto. Sem
 * `so` (`só` sem acento): colide com `Notion.so`, e a grafia sem acento já é erro.
 * Demonstrativos e verbos comuns também são prosa após ponto (#12002).
 */
const PT_WORDS_AFTER_DOT = new Set(
  (
    "de do da dos das no na nos nas num numa em um uma uns umas se me te lhe " +
    "ao aos as os ou mas que por para pra pro com sem sob sobre entre ate apos " +
    "depois antes agora ainda assim logo pois porque quando onde como mais menos " +
    "bem mal sim nao ja tambem isso isto aquilo esse essa esses essas este esta estes estas " +
    "aquele aquela aqueles aquelas aqui ali la cada todo toda " +
    "todos todas tudo nada nem muito muita muitos muitas pouco outro outra outros " +
    "outras eu tu ele ela eles elas voce voces nosso nossa seu sua seus suas meu " +
    "minha foi era sao ser ter tem vai vao fazer faz pode podem deve devem vamos precisa precisam " +
    "hoje ontem amanha sempre nunca " +
    "talvez enfim alias inclusive entao veja vale olha confira leia saiba"
  ).split(" "),
);

function hasBareDomain(word: string): boolean {
  for (const m of word.matchAll(BARE_DOMAIN)) {
    if (!PT_WORDS_AFTER_DOT.has(m[1])) return true;
  }
  return false;
}
/** Ênfase/markup inline: negrito, itálico, tachado, tabela, título. */
const INLINE_MARKUP = /[*_~|#]/;

/**
 * Diferença de espaço DENTRO de URL ou de markup markdown (#11875): a Clarice
 * aplica "falta espaço depois da pontuação" a `openai.com` (→`openai. com`),
 * a caminho dentro de link, ou cola/descola o marcador de negrito, lista e
 * título (`** negrito**`, `-item`, `##Título`). Olha só a palavra que encosta
 * em cada ponto onde o espaço mudou, nas duas versões, pra que uma correção
 * real no mesmo trecho que um link não seja recusada à toa. No apply, recebe
 * o texto completo antes/depois da substituição (#11884), não só from/to.
 */
function touchesUrlOrMarkup(from: string, to: string): boolean {
  const f = whitespaceGaps(from);
  const t = whitespaceGaps(to);
  for (let k = 1; k < f.chars.length; k++) {
    if (f.gaps[k] === t.gaps[k]) continue;
    for (const v of [f, t]) {
      const { left, right, atLineStart } = tokenAround(v.chars, v.gaps, k);
      const word = left + right;
      if (URL_LIKE.test(word) || hasBareDomain(word) || INLINE_MARKUP.test(word)) return true;
      if (atLineStart && LINE_MARKER.test(word)) return true;
    }
  }
  return false;
}

/**
 * Diferença só de espaço que é ruído estrutural (#11798) e não correção
 * (#11867): `to` muda a quantidade de quebras de linha (parágrafo inserido ou
 * juntado), muda a quebra de lugar (#11876), a diferença fica só na borda das
 * linhas (começo/fim do trecho, indentação, espaço antes de `\n` que vira
 * hard break no markdown) ou cai dentro de URL/markup (#11875).
 *
 * Espaço inserido/removido NO MEIO da linha, em texto corrido, é correção
 * legítima e passa: `afim de`→`a fim de`, `Porque`→`Por que`, `se não`→`senão`,
 * `a cerca de`→`acerca de`, `texto,outro`→`texto, outro`, `a  b`→`a b`.
 */
function isStructuralWhitespaceChange(from: string, to: string): boolean {
  if (countChar(to, "\n") !== countChar(from, "\n")) return true;
  if (linesShifted(from, to)) return true;
  if (trimLines(from) === trimLines(to)) return true;
  // Borda/indentação/hard break continuam estruturais mesmo quando há
  // também uma correção legítima no meio da linha (#11884).
  const f = whitespaceGaps(from);
  const t = whitespaceGaps(to);
  for (let k = 0; k < f.gaps.length; k++) {
    if (f.gaps[k] === t.gaps[k]) continue;
    if (k === 0 || k === f.chars.length ||
        f.gaps[k].includes("\n") || t.gaps[k].includes("\n")) return true;
  }
  return touchesUrlOrMarkup(from, to);
}

/**
 * Classifica uma sugestão como ruído (retorna o motivo) ou como candidata
 * legítima (retorna `null`). Não julga se a correção é boa — só recusa as
 * formas que corrompem o texto quando aplicadas mecanicamente.
 *
 * `text` opcional fornece o contexto atual de todas as ocorrências (#11884).
 * `from === to` não é ruído aqui (é no-op, os chamadores já tratam).
 */
export function classifyClariceNoise(from: string, to: string, text?: string): ClariceNoiseReason | null {
  if (from === to) return null;

  if (stripWhitespace(from) === stripWhitespace(to)) {
    // Mesmos caracteres visíveis: ruído só se a mudança for estrutural
    // (#11867 — antes toda diferença de espaço era recusada, inclusive
    // `afim de`→`a fim de`). Sem caractere visível novo, não há injeção de
    // código a checar abaixo.
    // O trecho pode começar no meio de URL/markup. Avaliar cada ocorrência
    // no texto atual preserva esse contexto, inclusive após applies anteriores.
    if (text !== undefined && from.length > 0) {
      let pos = text.indexOf(from);
      if (pos !== -1) {
        while (pos !== -1) {
          const candidate = text.slice(0, pos) + to + text.slice(pos + from.length);
          if (isStructuralWhitespaceChange(text, candidate)) return "whitespace_only";
          pos = text.indexOf(from, pos + from.length);
        }
        return null;
      }
    }
    return isStructuralWhitespaceChange(from, to) ? "whitespace_only" : null;
  }

  if (countChar(to, "\n") > countChar(from, "\n")) return "structural_injection";

  for (const ch of CODE_CHARS) {
    if (countChar(to, ch) > countChar(from, ch)) return "structural_injection";
  }

  return null;
}

export interface FilteredClariceSuggestions<T> {
  kept: T[];
  dropped: Array<{ suggestion: T; reason: ClariceNoiseReason | "invalid_shape" | "fact_check_protected" }>;
}

/**
 * Separa as sugestões legítimas do ruído (#11798, fluxos manuais). Os fluxos em
 * que o LLM aplica "todas as sugestões" à mão (post semanal, artigo especial,
 * stack, voto-tema, apoiadores) não passam por `clarice-apply.ts`; o CLI
 * `scripts/clarice-filter.ts` usa isto pra que eles recusem o mesmo ruído.
 * `protection` no Stage 4 retém mudanças factuais para revisão humana:
 * qualquer sugestão sobre trecho corrigido, e remoções de verbos condicionais.
 */
export function filterClariceSuggestions<T>(
  suggestions: T[],
  protection?: { correctedTexts: string[]; protectConditional: boolean },
): FilteredClariceSuggestions<T> {
  const kept: T[] = [];
  const dropped: FilteredClariceSuggestions<T>["dropped"] = [];
  for (const s of suggestions) {
    const o = s as { from?: unknown; to?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.from !== "string" || typeof o.to !== "string") {
      dropped.push({ suggestion: s, reason: "invalid_shape" });
      continue;
    }
    // Stage 4: não deixar a revisão linguística desfazer a revisão factual.
    // from pode ser só uma palavra ("seria") dentro do trecho corrigido.
    const conditional = /\b(?:seria|seriam|teria|teriam|poderia|poderiam|deveria|deveriam|estaria|estariam)\b/gi;
    const removedConditional = (o.from.match(conditional) ?? []).some(
      (word) => !(o.to as string).toLowerCase().includes(word.toLowerCase()),
    );
    const protectedChange = protection && o.from !== o.to && o.from.trim() !== "" && (
      protection.correctedTexts.some((text) => text.includes(o.from as string) || (o.from as string).includes(text)) ||
      (protection.protectConditional && removedConditional)
    );
    const reason = protectedChange ? "fact_check_protected" : classifyClariceNoise(o.from, o.to);
    if (reason) dropped.push({ suggestion: s, reason });
    else kept.push(s);
  }
  return { kept, dropped };
}
