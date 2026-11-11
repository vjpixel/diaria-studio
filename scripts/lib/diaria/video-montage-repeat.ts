/**
 * scripts/lib/diaria/video-montage-repeat.ts (#12711) — tomada repetida que o
 * Whisper colapsou, detectada sem depender do texto do roteiro.
 *
 * Na 261111 o item "Quem fica, ou quem entra, é quem sabe fazer a IA funcionar
 * melhor," (1096.98–1105.88 s) cobria duas tomadas: o `transcript.json`
 * esticou "funcionar" por 5,1 s e a transcrição da sequência esticou "fazer"
 * por 4,5 s, sem as palavras do meio. Na 261110 o item "Treinar" (206 s) era o
 * fim de "…treinamento, de…": a retranscrição da janela do roteiro esticou
 * "treinar" de 206,1 a 216,9 s, e a tomada boa estava em 216,55 s. O Whisper
 * (faster-whisper com o roteiro ou o vocabulário no prompt) completa ou
 * colapsa a fala para casar com o texto esperado, então o casamento palavra a
 * palavra com o roteiro (`fala-extra`, `tomada-duplicada`) não vê nada.
 *
 * Sinais aqui, todos sobre o tempo e o som, não sobre o texto:
 *   - `speechRateSuspects`: o intervalo do item tem muito mais fala (fora dos
 *     silêncios) do que o texto dele pede no ritmo desta gravação (letras por
 *     segundo, mediana dos itens da edição).
 *   - `repeatedPhraseSuspects`: a mesma sequência de palavras aparece mais
 *     vezes nas palavras do intervalo do que no texto do item.
 *   - `windowHeardSuspects`: na retranscrição da janela do item (sem o roteiro
 *     no prompt, a do `roteiro`), palavra esticada sobre som ou as palavras de
 *     conteúdo do item ausentes.
 *   - `stretchedWordFindings`: palavra esticada sobre som na transcrição do
 *     áudio montado (`verify-xml`) ou da prévia (`review`).
 * Tudo é aviso para conferir no áudio: nenhum sinal troca tomada sozinho.
 */

import { collapsedTakeSuspects, describeCollapsedSuspect, normalizeToken, tokenize, tokensMatch, type Interval, type ResolvedItem, type ReviewFinding, type TokenMatcher, type Word } from "./video-montage.ts";

export const TAKE_REPEAT = {
  /** Fala no intervalo acima deste múltiplo do esperado pelo texto. */
  rateFactor: 1.6,
  /** E pelo menos estes segundos a mais (item curto oscila muito). */
  rateExcessS: 1.5,
  /** Itens mínimos com texto para calibrar o ritmo da gravação. */
  minItemsForRate: 5,
  /** Tamanho da sequência de palavras repetida. */
  ngram: 3,
  /** Palavra de conteúdo: 4+ letras (artigo e preposição ficam com o `video-short-words.ts`). */
  contentMinLen: 4,
  /** Fração mínima das palavras de conteúdo do item ouvidas na retranscrição da janela. */
  minContentHeard: 0.5,
} as const;

export type TakeRepeatKind = "fala-longa" | "frase-repetida" | "palavra-esticada" | "fala-divergente";

export interface TakeRepeatItem {
  /** `comentario[6]`. */
  id: string;
  text: string;
  start: number;
  end: number;
  /** Palavras do bruto no intervalo (as do `transcript.json`). */
  words?: Word[];
}

export interface TakeRepeatSuspect {
  id: string;
  kind: TakeRepeatKind;
  /** Trecho do bruto a conferir. */
  at: number;
  end: number;
  detail: string;
}

/** Segundos de `[a, b]` fora dos silêncios. */
export function audibleWithin(a: number, b: number, silences: readonly Interval[]): number {
  if (!(b > a)) return 0;
  let covered = 0;
  let cur = a;
  for (const s of [...silences].sort((x, y) => x.start - y.start)) {
    const lo = Math.max(cur, s.start);
    const hi = Math.min(b, s.end);
    if (hi > lo) {
      covered += hi - lo;
      cur = hi;
    }
  }
  return b - a - covered;
}

/** Letras faladas do texto; cada algarismo conta 3 ("20" se diz "vinte"). */
export function spokenLetters(text: string): number {
  const t = text.normalize("NFD").replace(/\p{M}+/gu, "");
  return (t.match(/\p{L}/gu)?.length ?? 0) + 3 * (t.match(/\p{N}/gu)?.length ?? 0);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const fmt = (x: number) => x.toFixed(1).replace(".", ",");

/**
 * Item com fala demais para o texto (#12711): segundos de som no intervalo
 * (fora dos silêncios) contra o tempo que o texto leva no ritmo DESTA gravação
 * (mediana de letras por segundo dos itens). Sem itens suficientes para
 * calibrar, não acusa nada.
 */
export function speechRateSuspects(items: readonly TakeRepeatItem[], silences: readonly Interval[]): TakeRepeatSuspect[] {
  const measured = items
    .map((it) => ({ it, letters: spokenLetters(it.text), audible: audibleWithin(it.start, it.end, silences) }))
    .filter((m) => m.letters > 0 && m.audible > 0.2);
  if (measured.length < TAKE_REPEAT.minItemsForRate) return [];
  const rate = median(measured.map((m) => m.letters / m.audible));
  if (!(rate > 0)) return [];
  const out: TakeRepeatSuspect[] = [];
  for (const m of measured) {
    const expected = m.letters / rate;
    if (m.audible > TAKE_REPEAT.rateFactor * expected && m.audible - expected > TAKE_REPEAT.rateExcessS) {
      out.push({
        id: m.it.id,
        kind: "fala-longa",
        at: m.it.start,
        end: m.it.end,
        detail: `${fmt(m.audible)} s de fala no intervalo para um texto de ~${fmt(expected)} s no ritmo desta gravação (${fmt(rate)} letras/s): pode cobrir mais de uma tomada`,
      });
    }
  }
  return out;
}

/** Quantas vezes a sequência `g` aparece em `toks`, sem sobreposição. */
function countNgram(toks: readonly string[], g: readonly string[], match: TokenMatcher): number {
  let n = 0;
  for (let i = 0; i + g.length <= toks.length; ) {
    if (g.every((x, k) => match(toks[i + k], x))) {
      n++;
      i += g.length;
    } else i++;
  }
  return n;
}

/**
 * A mesma sequência de `TAKE_REPEAT.ngram` palavras mais vezes no intervalo do
 * que no texto do item (#12711): o item pegou a tomada repetida junto. Só
 * quando o `transcript.json` registrou as duas (quando colapsou, quem pega é a
 * `speechRateSuspects`).
 */
export function repeatedPhraseSuspects(items: readonly TakeRepeatItem[], match: TokenMatcher = tokensMatch): TakeRepeatSuspect[] {
  const n = TAKE_REPEAT.ngram;
  const out: TakeRepeatSuspect[] = [];
  for (const it of items) {
    const ws = (it.words ?? []).filter((w) => normalizeToken(w.text) !== "");
    const toks = ws.map((w) => normalizeToken(w.text));
    const text = tokenize(it.text);
    for (let i = 0; i + n <= toks.length; i++) {
      const g = toks.slice(i, i + n);
      const heard = countNgram(toks, g, match);
      if (heard < 2 || heard <= countNgram(text, g, match)) continue;
      out.push({
        id: it.id,
        kind: "frase-repetida",
        at: ws[i].start,
        end: it.end,
        detail: `"${ws.slice(i, i + n).map((w) => w.text.trim()).join(" ")}" aparece ${heard} vezes no intervalo e ${countNgram(text, g, match)} no texto: o intervalo cobre mais de uma tomada`,
      });
      break;
    }
  }
  return out;
}

/**
 * Na retranscrição da janela do item (`heard`, tempo do bruto, sem o roteiro
 * no prompt): palavra esticada ou som sem palavra acima do limiar da tomada
 * colapsada (#11754) dentro do intervalo, e palavras de conteúdo do texto que
 * a retranscrição não ouviu (#12711, caso "Treinar" da 261110). Janela sem
 * nada ouvido não acusa (o Whisper às vezes devolve vazio numa janela curta).
 */
export function windowHeardSuspects(item: TakeRepeatItem, heard: readonly Word[], silences: readonly Interval[], match: TokenMatcher = tokensMatch): TakeRepeatSuspect[] {
  const ws = heard.filter((w) => normalizeToken(w.text) !== "");
  if (!ws.length) return [];
  const out: TakeRepeatSuspect[] = [];
  const stretched = collapsedTakeSuspects(ws, [...silences]).find((s) => s.end > item.start && s.at < item.end);
  if (stretched) {
    out.push({ id: item.id, kind: "palavra-esticada", at: stretched.at, end: stretched.end, detail: `na retranscrição da janela, ${describeCollapsedSuspect(stretched)}: tomada repetida que o Whisper juntou numa só` });
  }
  const content = tokenize(item.text).filter((t) => t.length >= TAKE_REPEAT.contentMinLen);
  if (content.length) {
    const toks = ws.map((w) => normalizeToken(w.text));
    const hit = content.filter((c) => toks.some((t) => match(t, c))).length;
    if (hit / content.length < TAKE_REPEAT.minContentHeard) {
      out.push({
        id: item.id,
        kind: "fala-divergente",
        at: item.start,
        end: item.end,
        detail: `a retranscrição da janela ouviu "${ws.map((w) => w.text.trim()).join(" ")}", sem ${content.length - hit} de ${content.length} palavra(s) do texto: a fala do item pode ser de outra tomada (ou fragmento da anterior)`,
      });
    }
  }
  return out;
}

/** Uma linha de aviso por suspeita, com a janela para o `retranscribe --sub` conferir. */
export function takeRepeatLine(s: TakeRepeatSuspect): string {
  return `${s.id}: ${s.detail}; conferir no áudio ${s.at.toFixed(2)}–${s.end.toFixed(2)} s (retranscribe --sub --from ${Math.max(0, s.at - 1).toFixed(1)} --to ${(s.end + 1).toFixed(1)}) (#12711)`;
}

/**
 * Palavra esticada (ou som sem palavra) acima do limiar da tomada colapsada
 * na transcrição do áudio MONTADO (#12711): `verify-xml` e `review`. É o
 * sinal que a transcrição da sequência da 261111 tinha ("fazer" por 4,5 s) e
 * que o casamento com o roteiro não acusa. `silences` = os do mesmo áudio.
 */
export function stretchedWordFindings(words: readonly Word[], silences: readonly Interval[]): ReviewFinding[] {
  return collapsedTakeSuspects([...words], [...silences]).map((s) => ({
    kind: "tomada-colapsada" as const,
    at: s.at,
    detail: `${describeCollapsedSuspect(s)} (${s.at.toFixed(2)}–${s.end.toFixed(2)} s): tomada repetida que o Whisper juntou numa só? Conferir no áudio e mover o começo do item para a tomada completa (#12711)`,
  }));
}

/**
 * Os itens resolvidos do `blocks.json` como `TakeRepeatItem` (#12711). Item
 * que o `resolveBlocks` já acusou como tomada colapsada (#11754) fica de fora:
 * o aviso dele já saiu, com a janela a retranscrever.
 */
export function takeRepeatItems(resolved: Partial<Record<string, ReadonlyArray<Pick<ResolvedItem, "interval" | "text" | "words" | "collapsed">>>>): TakeRepeatItem[] {
  return Object.entries(resolved).flatMap(([key, items]) =>
    (items ?? []).flatMap((it, i) => (it.collapsed ? [] : [{ id: `${key}[${i}]`, text: it.text, start: it.interval.start, end: it.interval.end, words: it.words }])),
  );
}

/** Os avisos de tomada repetida do `build`/`roteiro` (#12711): ritmo de fala e frase repetida no intervalo de cada item. */
export function takeRepeatWarnings(items: readonly TakeRepeatItem[], silences: readonly Interval[], match: TokenMatcher = tokensMatch): string[] {
  const all: TakeRepeatSuspect[] = [...speechRateSuspects(items, silences), ...repeatedPhraseSuspects(items, match)];
  return all.map(takeRepeatLine);
}
