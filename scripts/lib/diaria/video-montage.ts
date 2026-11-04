/**
 * scripts/lib/diaria/video-montage.ts (#11208)
 *
 * Lógica pura da montagem do vídeo diário "diar.ia.br comentada", do bruto do
 * Drive até o ponto de partida no Premiere. Portada dos scripts da sessão
 * manual de 26/10/2026 (edição 261027: `build_xml.py`, `srt_from_seq.py`,
 * `render_preview.py`, `transcribe.py`, preservados no 1º comentário da
 * #11208), sem os parâmetros fixos daquela edição: os intervalos dos blocos
 * vêm do `blocks.json` da edição (gate de decupagem), o enquadramento do
 * `framing` dele, as correções de vocabulário de
 * `context/video-montagem/vocabulario.json`.
 *
 * Sem rede, sem processo filho: o CLI `scripts/video-montagem.ts` roda
 * ffmpeg/ffprobe e o helper Python (`scripts/video/transcribe_words.py`) e
 * passa as saídas para cá.
 *
 * Partes:
 *   - silêncios (`parseSilenceDetect`) e trechos de fala (`speechParts`);
 *   - escolha de tomada (`findTakes`, `chooseTake`): a última tomada completa
 *     da frase, com o corte preso entre o fim da palavra anterior e o começo
 *     da seguinte (os dois bugs da 261027: tomada falsa duplicada e sílaba da
 *     tomada seguinte vazando no corte);
 *   - plano das sequências (`buildSequencePlan`) e o XML FCP7 xmeml v4
 *     (`buildXmeml`), 3 sequências com áudio linkado e zoom alternando só nos cortes (#11503);
 *   - enquadramento (`framingFor`): crop da prévia e Center do Basic Motion a
 *     partir do centro do rosto, olhos a ~40% da altura;
 *   - legendas (`segmentCues`, `cuesToSrt`, vocabulário, pontuação do roteiro);
 *   - autorrevisão (`reviewPreview`): diff de palavras prévia × roteiro.
 */

import { corteSuffixOf, videoTargetOf } from "./drive-video-source.ts";

// ── Tipos básicos ─────────────────────────────────────────────────────────

/** Intervalo em segundos. */
export interface Interval {
  start: number;
  end: number;
}

/** Palavra com tempo (saída do faster-whisper com `word_timestamps`). */
export interface Word {
  start: number;
  end: number;
  text: string;
}

/** Segmento do Whisper (frase), com as palavras dele. */
export interface Segment {
  start: number;
  end: number;
  text: string;
  words?: Word[];
}

export interface Transcript {
  duration?: number;
  model?: string;
  segments: Segment[];
  /** Subjanela do `retranscribe --sub` (#11958), com a janela no bruto: só a busca do falso começo a lê. */
  sub?: { window: Interval };
}

/** Todas as palavras do transcript, em ordem. */
export function transcriptWords(t: Transcript): Word[] {
  return t.segments.flatMap((s) => s.words ?? []).filter((w) => w.text.trim() !== "");
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Janela máxima da retranscrição: curta de propósito, é para um trecho em dúvida (#11364). */
export const RETRANSCRIBE_MAX_S = 60;

/** Valida a janela `--from`/`--to` da retranscrição; devolve o erro ou o intervalo. */
export function retranscribeWindow(from: string | undefined, to: string | undefined, durationS?: number): { ok: true; window: Interval } | { ok: false; error: string } {
  const a = Number(from);
  const b = Number(to);
  if (from === undefined || to === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, error: "retranscribe exige --from SEGUNDOS e --to SEGUNDOS" };
  if (a < 0 || b <= a) return { ok: false, error: `janela inválida: --from ${from} --to ${to}` };
  if (b - a > RETRANSCRIBE_MAX_S) return { ok: false, error: `janela de ${(b - a).toFixed(1)} s passa de ${RETRANSCRIBE_MAX_S} s: retranscrever só o trecho em dúvida` };
  if (durationS !== undefined && a >= durationS) return { ok: false, error: `--from ${from} além do bruto (${durationS.toFixed(1)} s)` };
  return { ok: true, window: { start: a, end: durationS !== undefined ? Math.min(b, durationS) : b } };
}

/** Desloca os tempos de um transcript de janela para o tempo do bruto. */
export function offsetTranscript(t: Transcript, offsetS: number): Transcript {
  const sh = (x: number) => round3(x + offsetS);
  return {
    ...t,
    segments: t.segments.map((s) => ({ ...s, start: sh(s.start), end: sh(s.end), words: s.words?.map((w) => ({ ...w, start: sh(w.start), end: sh(w.end) })) })),
  };
}

// ── Silêncios e fala ──────────────────────────────────────────────────────

/**
 * Parâmetros do `silencedetect` (#11208). `noiseDb` é o limiar quando o
 * loudness do bruto não foi medido, e o PISO do limiar relativo
 * (`silenceNoiseDb`, #11351). `minDurationS` acompanha o `minGapS` de
 * `SPEECH_DEFAULTS` (#11753): pausa mais curta que a detecção nunca chega ao
 * corte (era 0,45 s com o corte em 0,8 s).
 */
export const SILENCE_DETECT = { noiseDb: -45, minDurationS: 0.35 } as const;

/**
 * Limiar relativo do silêncio (#11351): o loudness integrado do bruto menos
 * `belowLufsDb`, entre `noiseDb` de `SILENCE_DETECT` (-45, o da 261027, bruto
 * baixo) e `maxDb`. Na 261028 o bruto veio a -9,9 LUFS e o -45 fixo achou 1
 * silêncio em 21 min; -35 achou 120.
 */
export const SILENCE_RELATIVE = { belowLufsDb: 25, maxDb: -25 } as const;

export type SilenceThreshold = { noiseDb: number; how: "override" | "relative" | "default" };

/** Limiar do `silencedetect` para este bruto: `overrideDb` (--silence-db) vence; sem loudness medido, -45. */
export function silenceNoiseDb(m: LoudnessMeasure | null, overrideDb?: number): SilenceThreshold {
  if (overrideDb !== undefined) return { noiseDb: overrideDb, how: "override" };
  if (!m || !Number.isFinite(m.inputI)) return { noiseDb: SILENCE_DETECT.noiseDb, how: "default" };
  const rel = Math.round(m.inputI - SILENCE_RELATIVE.belowLufsDb);
  return { noiseDb: Math.min(SILENCE_RELATIVE.maxDb, Math.max(SILENCE_DETECT.noiseDb, rel)), how: "relative" };
}

/**
 * Silêncios a partir do stderr do `ffmpeg -af silencedetect`. Linhas
 * `silence_start: X` e `silence_end: Y | silence_duration: Z`, em pares. Um
 * `silence_start` sem fim (silêncio até o fim do arquivo) fecha em
 * `durationS`, quando informado; sem ele, é descartado.
 */
export function parseSilenceDetect(stderr: string, durationS?: number): Interval[] {
  const out: Interval[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+(?:e-?\d+)?)/.exec(line);
    if (s) {
      open = Math.max(0, Number(s[1]));
      continue;
    }
    const e = /silence_end:\s*(-?[\d.]+(?:e-?\d+)?)/.exec(line);
    if (e && open !== null) {
      const end = Number(e[1]);
      if (end > open) out.push({ start: open, end });
      open = null;
    }
  }
  if (open !== null && durationS !== undefined && durationS > open) out.push({ start: open, end: durationS });
  return out;
}

/**
 * Corte de silêncio da montagem. #11753 (decisão do editor, 02/11/2026): a
 * pausa de 0,35 s ou mais sai, com 0,07 s de respiro de cada lado (sobra
 * ~0,14 s, o que o editor deixa no Premiere; antes era ≥0,8 s com 0,2 s, e as
 * pausas de 0,3–0,8 s iam inteiras para o XML). Clipe <0,6 s isolado por pausa
 * longa é descartado. `longGapS` separa a pausa longa (≥0,8 s, o corte de
 * antes) da curta: a curta não deixa pedaço abaixo de `minClipS` (o pedaço
 * volta a se juntar ao vizinho) e não troca o zoom (`assembleClips`).
 */
export const SPEECH_DEFAULTS = { minGapS: 0.35, padS: 0.07, minClipS: 0.6, longGapS: 0.8 } as const;

/** Opções do corte de silêncio (`speechParts`, `buildSequencePlan`). */
export interface SpeechOptions {
  minGapS?: number;
  padS?: number;
  minClipS?: number;
  /** Pausa a partir da qual o corte é "longo" (#11753). */
  longGapS?: number;
  /** Pedaço abaixo disso, separado do vizinho só por pausa curta, volta a se juntar a ele. Default: `minClipS`. */
  fragmentS?: number;
}

/**
 * Trechos de fala dentro de `[a, b]`: remove os silêncios de `minGapS` ou mais,
 * mantendo `padS` de respiro de cada lado. Pedaço com menos de `fragmentS`
 * separado do vizinho por pausa CURTA (abaixo de `longGapS`) não é cortado: o
 * corte daquela pausa é desfeito e o pedaço volta ao vizinho (com o corte em
 * 0,35 s, uma palavra solta entre duas pausas curtas é fala, não ruído,
 * #11753). Sobra de pedaço isolado por pausa longa, com menos de `minClipS`, é
 * descartada como antes; pedaço que encosta em UMA ponta de `[a, b]` sem
 * silêncio ali fica (a fala continua no item vizinho, e o `assembleClips`
 * emenda os dois: com o respiro de 0,07 s, a sobra de um item que termina no
 * meio da fala passou a ficar abaixo de `minClipS`). Nunca sai de `[a, b]`.
 * Porta do `speech()` de `build_xml.py`.
 */
export function speechParts(a: number, b: number, silences: Interval[], opts: SpeechOptions = {}): Interval[] {
  const minGap = opts.minGapS ?? SPEECH_DEFAULTS.minGapS;
  const pad = opts.padS ?? SPEECH_DEFAULTS.padS;
  const minClip = opts.minClipS ?? SPEECH_DEFAULTS.minClipS;
  const longGap = opts.longGapS ?? SPEECH_DEFAULTS.longGapS;
  const fragment = opts.fragmentS ?? minClip;
  if (!(b > a)) return [];
  const parts: Interval[] = [];
  let cur = a;
  for (const s of [...silences].sort((x, y) => x.start - y.start)) {
    if (s.end - s.start < minGap || s.end <= a || s.start >= b) continue;
    if (s.start + pad > cur) parts.push({ start: cur, end: Math.min(b, s.start + pad) });
    cur = Math.max(cur, s.end - pad);
  }
  if (cur < b) parts.push({ start: cur, end: b });
  // A pausa removida entre dois pedaços (o vão no bruto mais os dois respiros).
  const removed = (i: number) => parts[i + 1].start - parts[i].end + 2 * pad;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].end - parts[i].start >= fragment - 1e-9) continue;
      const left = i > 0 ? removed(i - 1) : Number.POSITIVE_INFINITY;
      const right = i + 1 < parts.length ? removed(i) : Number.POSITIVE_INFINITY;
      if (!(Math.min(left, right) < longGap - 1e-9)) continue;
      if (left <= right) parts.splice(i - 1, 2, { start: parts[i - 1].start, end: parts[i].end });
      else parts.splice(i, 2, { start: parts[i].start, end: parts[i + 1].end });
      changed = true;
      break;
    }
  }
  return parts.filter((p) => p.end - p.start >= minClip - 1e-9 || touchesEdge(p, a, b)).map((p) => ({ start: round3(p.start), end: round3(p.end) }));
}

/**
 * O pedaço encosta em UMA ponta de `[a, b]` (sem silêncio cortado ali): a fala
 * segue no item vizinho (#11753). O item inteiro curto (as duas pontas) não
 * conta: continua sumindo no corte (regressão F do #11208).
 */
function touchesEdge(p: Interval, a: number, b: number): boolean {
  const atA = p.start <= a + 1e-6;
  const atB = p.end >= b - 1e-6;
  return atA !== atB;
}

/**
 * Os pedaços de `speechParts` em que o corte ANTES deles removeu só uma pausa
 * curta (abaixo de `longGapS`): o índice de cada um. Esses cortes não trocam o
 * zoom (#11753): o editor tira a pausa no Premiere dentro do mesmo clipe, com a
 * mesma escala; os cortes longos, de item e de tomada continuam trocando (#11503).
 */
export function shortPauseCuts(parts: Interval[], opts: Pick<SpeechOptions, "padS" | "longGapS"> = {}): Set<number> {
  const pad = opts.padS ?? SPEECH_DEFAULTS.padS;
  const longGap = opts.longGapS ?? SPEECH_DEFAULTS.longGapS;
  const out = new Set<number>();
  for (let i = 1; i < parts.length; i++) if (parts[i].start - parts[i - 1].end + 2 * pad < longGap - 1e-9) out.add(i);
  return out;
}

/** O fecho segura 0,5 s depois da última palavra (#11208). */
export const FECHO_HOLD_S = 0.5;

// ── Tokens e casamento de palavras ────────────────────────────────────────

/** Minúsculas, sem acento e sem pontuação: "Atualização," → "atualizacao". */
export function normalizeToken(t: string): string {
  return t
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function tokenize(text: string): string[] {
  return text.split(/\s+/).map(normalizeToken).filter(Boolean);
}

/**
 * Texto de uma lista de palavras do Whisper, unidas por espaço, colando ao
 * número anterior o pedaço que o Whisper separa (#11360): "6" ".1" → "6.1",
 * "53" ",6" "%" → "53,6%". `%` cola sempre; `.`/`,` seguido de dígito só
 * depois de um token que termina em dígito.
 */
export function joinWordTexts(texts: string[]): string {
  let out = "";
  for (const raw of texts) {
    const t = raw.trim();
    if (!t) continue;
    if (out && (t.startsWith("%") || (/^[.,]\d/.test(t) && /\d$/.test(out)))) out += t;
    else out += (out ? " " : "") + t;
  }
  return out;
}

/**
 * Junta palavras do Whisper que, coladas, formam um token do roteiro com
 * número ("GPT" "6" ".1" → "GPT-6.1"; "53" ",6" "%" → "53,6%"), para o
 * alinhamento palavra a palavra casar o token inteiro (#11360). Só junta
 * quando o token do roteiro tem dígito (um "a" + "o" nunca vira "ao"). A
 * palavra juntada vai do início da 1ª ao fim da última.
 */
export function mergeSplitNumberTokens(words: Word[], scriptTokens: string[]): Word[] {
  const targets = new Set(scriptTokens.filter((t) => /\d/.test(t)).map(normalizeToken).filter(Boolean));
  if (targets.size === 0) return words.map((w) => ({ ...w }));
  const out: Word[] = [];
  for (let i = 0; i < words.length; ) {
    let merged = false;
    for (const n of [3, 2]) {
      if (i + n > words.length) continue;
      const slice = words.slice(i, i + n);
      const own = normalizeToken(slice[0].text);
      if (targets.has(own)) break; // a 1ª palavra já é o token inteiro
      if (targets.has(slice.map((w) => normalizeToken(w.text)).join(""))) {
        out.push({ start: slice[0].start, end: slice[n - 1].end, text: joinWordTexts(slice.map((w) => w.text)) });
        i += n;
        merged = true;
        break;
      }
    }
    if (!merged) out.push({ ...words[i++] });
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Formas faladas que o Whisper escreve diferente do roteiro e que valem a
 * mesma palavra ("pra" = "para"). Só equivalências gramaticais genéricas;
 * nomes próprios vão em `aliases` de `context/video-montagem/vocabulario.json`.
 */
const SPOKEN_EQUIV: Readonly<Record<string, string>> = { pra: "para", pras: "paras", ta: "esta", tao: "estao", to: "estou", ce: "voce", ces: "voces" };

function canonical(t: string): string {
  return SPOKEN_EQUIV[t] ?? t;
}

/** Igual (com as formas faladas equivalentes), ou (palavras de 5+ letras) a 1 edição de distância: o Whisper erra acento/plural. */
export function tokensMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = canonical(a);
  const y = canonical(b);
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 5 && levenshtein(x, y) <= 1;
}

/** Forma ouvida pelo Whisper → forma escrita no roteiro ("diária" → "diar.ia.br"), de `vocabulario.json`. */
export interface VocabAlias {
  heard: string;
  written: string;
  note?: string;
}

/** Casador de token do transcript (`w`) com token do roteiro (`s`), com os aliases. */
export type TokenMatcher = (w: string, s: string) => boolean;

export function makeMatcher(aliases: VocabAlias[] = []): TokenMatcher {
  const pairs = aliases.map((a) => [normalizeToken(a.heard), normalizeToken(a.written)] as const);
  return (w, s) => tokensMatch(w, s) || pairs.some(([h, wr]) => w === h && s === wr);
}

/**
 * Alinhamento por maior subsequência comum (LCS) entre duas listas de tokens
 * normalizados. Devolve os pares casados `[i, j]` em ordem.
 */
export function alignTokens(a: string[], b: string[], match: TokenMatcher = tokensMatch): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = match(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (match(a[i], b[j]) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * A fala ouvida (`heard`, tokens) diz o mesmo que o texto pedido (`wanted`)?
 * Iguais palavra a palavra pelo `match` (acento, plural, "pra", aliases), ou
 * iguais com tudo colado ("GPT 5" × "GPT-5"). Palavra trocada, engolida ou a
 * mais = diferente (#11362).
 */
export function sameSpeech(heard: string[], wanted: string[], match: TokenMatcher = tokensMatch): boolean {
  let i = 0;
  let j = 0;
  // Quantos tokens de `xs`, a partir de `k`, colados dão `target` (2 ou 3; 0 = nenhum).
  const glue = (xs: string[], k: number, target: string) =>
    k + 1 < xs.length && xs[k] + xs[k + 1] === target ? 2 : k + 2 < xs.length && xs[k] + xs[k + 1] + xs[k + 2] === target ? 3 : 0;
  while (i < heard.length && j < wanted.length) {
    if (match(heard[i], wanted[j])) {
      i++;
      j++;
      continue;
    }
    const gh = glue(heard, i, wanted[j]);
    if (gh) {
      i += gh;
      j++;
      continue;
    }
    const gw = glue(wanted, j, heard[i]);
    if (gw) {
      i++;
      j += gw;
      continue;
    }
    return false;
  }
  return i === heard.length && j === wanted.length;
}

// ── Tomadas ───────────────────────────────────────────────────────────────

/** Margens do corte de uma tomada (premissa #11208, medidas na 261027). */
export const TAKE_DEFAULTS = {
  /** Ar antes da 1ª palavra. */
  preRollS: 0.15,
  /** Ar depois da última palavra. */
  postRollS: 0.25,
  /** Distância mínima até a palavra vizinha (fora da tomada). */
  guardS: 0.05,
  /** Pausa maior que isso entre duas palavras encerra a tomada, salvo se a palavra seguinte é a esperada do roteiro (#11505). */
  maxGapS: 2.5,
  /** Fração mínima das palavras da frase que a tomada precisa casar. */
  minRatio: 0.8,
  /**
   * Frase com menos palavras que isso é "curta" (#11362): aceita UMA tolerância
   * só (palavra engolida, a mais, ou trocada por uma parecida), nunca uma troca
   * de sentido. Na 261028, "com esforço médio de raciocínio," casou com "com
   * baixo esforço de raciocínio," (palavra a mais + palavra engolida = troca).
   */
  shortPhraseTokens: 8,
  /** Na frase curta, a palavra trocada só vale a até esta distância de edição ("Fotos" × "Photos" = 2; "médio" × "baixo" = 5). */
  shortSwapMaxEdits: 2,
} as const;

export interface Take {
  /** Índice (em `words`) da 1ª e da última palavra da tomada. */
  firstWord: number;
  lastWord: number;
  /** Palavras da frase casadas. */
  matched: number;
  /** Chegou ao fim da frase com `minRatio` casado. */
  complete: boolean;
}

export interface TakeMatchOptions {
  maxGapS?: number;
  minRatio?: number;
  /** Aliases do vocabulário ("diária" ouvido = "diar.ia.br" no roteiro). */
  match?: TokenMatcher;
}

/**
 * Todas as tomadas da frase `phrase` no transcript (as palavras já com o
 * vocabulário aplicado, ver `resolveBlocks`). Uma tomada começa numa palavra
 * que casa com a 1ª palavra da frase (ou com a 2ª, se o Whisper engoliu a 1ª)
 * e segue casando em ordem. Tolera os erros comuns do Whisper:
 *   - 1 palavra inserida, 1 omitida ou 1 TROCADA (por tomada, cada); na frase
 *     CURTA (`shortPhraseTokens`, #11362) só UMA dessas no total, e a trocada
 *     só se parecida com a do roteiro (`shortSwapMaxEdits`): frase curta com
 *     uma palavra de sentido trocada é OUTRA frase, não a tomada dela;
 *   - palavra partida ou juntada ("GPT 5" × "GPT-5", "GPT 6 .1" × "GPT-6.1":
 *     2 ou 3 tokens concatenados, #11360);
 *   - a última palavra da frase omitida (completa com todas menos a última,
 *     se ainda casar `minRatio` das palavras).
 * Encerra numa pausa maior que `maxGapS` seguida de palavra que não é a
 * esperada (#11505: pausa longa no meio da frase não quebra), numa palavra que não casa, ou
 * quando a frase RECOMEÇA: a palavra atual casa com a 1ª da frase (e não com a
 * esperada) E a seguinte casa com a 2ª — a tomada falsa, "Uma atualização de…
 * Uma atualização de privacidade". Um "o"/"a" repetido no meio da frase, sem a
 * 2ª palavra depois, não é recomeço.
 * Tomadas completas com a mesma última palavra viram uma só (a que casou mais
 * palavras; no empate, a que começa depois).
 */
export function findTakes(words: Word[], phrase: string, opts: TakeMatchOptions = {}): Take[] {
  const P = tokenize(phrase);
  if (P.length === 0) return [];
  const W = words.map((w) => normalizeToken(w.text));
  const eq = opts.match ?? tokensMatch;
  const maxGap = opts.maxGapS ?? TAKE_DEFAULTS.maxGapS;
  const minRatio = opts.minRatio ?? TAKE_DEFAULTS.minRatio;
  const short = P.length < TAKE_DEFAULTS.shortPhraseTokens;
  const restarts = (k: number, p: number) =>
    P.length > 1 && p > 0 && eq(W[k], P[0]) && !eq(W[k], P[p]) && k + 1 < W.length && eq(W[k + 1], P[1]);
  // Quantos tokens do transcript, juntos, formam o token `target` do roteiro
  // (3 antes de 2: "53" ",6" "%" → "536" leva o "%" junto). 0 = nenhum.
  const glued = (k: number, target: string): number => {
    if (k + 2 < W.length && W[k] + W[k + 1] + W[k + 2] === target) return 3;
    if (k + 1 < W.length && W[k] + W[k + 1] === target) return 2;
    return 0;
  };
  const takes: Take[] = [];
  for (let i = 0; i < W.length; i++) {
    let p: number;
    if (eq(W[i], P[0]) || glued(i, P[0]) > 0) p = 0;
    else if (P.length > 2 && eq(W[i], P[1]) && !(i > 0 && eq(W[i - 1], P[0]))) p = 1;
    else continue;
    let k = i;
    let matched = 0;
    let last = i;
    let swaps = 0;
    let skips = 0;
    let inserts = 0;
    // Frase curta: uma tolerância só, somando as três (#11362).
    const canTolerate = () => !short || swaps + skips + inserts === 0;
    while (p < P.length && k < W.length) {
      // Pausa longa só encerra a tomada quando a palavra depois dela NÃO segue o
      // roteiro (#11505): fala pausada ("por exemplo, [4 s] a Anthropic", 261029)
      // continua a mesma tomada se a palavra seguinte é a esperada, exata ou
      // colada. Do outro lado da pausa nenhuma tolerância vale (palavra engolida,
      // a mais ou trocada): aí a pausa encerra, como antes.
      if (k > i && words[k].start - words[k - 1].end > maxGap && !(eq(W[k], P[p]) || glued(k, P[p]) > 0)) break;
      if (k > i && restarts(k, p)) break;
      const g = eq(W[k], P[p]) ? 0 : glued(k, P[p]);
      if (eq(W[k], P[p])) {
        matched++;
        last = k;
        p++;
        k++;
      } else if (g > 0) {
        // "GPT 5" ouvido, "GPT-5" no roteiro; "GPT 6 .1" × "GPT-6.1" (#11360)
        matched++;
        last = k + g - 1;
        p++;
        k += g;
      } else if (p + 1 < P.length && W[k] === P[p] + P[p + 1]) {
        matched += 2;
        last = k;
        p += 2;
        k++;
      } else if (skips < 1 && canTolerate() && p + 1 < P.length && eq(W[k], P[p + 1])) {
        // palavra da frase engolida
        skips++;
        matched++;
        last = k;
        p += 2;
        k++;
      } else if (inserts < 1 && canTolerate() && k > i && k + 1 < W.length && eq(W[k + 1], P[p])) {
        // palavra a mais no meio
        inserts++;
        k++;
      } else if (
        swaps < 1 &&
        canTolerate() &&
        k > i &&
        p + 1 < P.length &&
        k + 1 < W.length &&
        eq(W[k + 1], P[p + 1]) &&
        // Na frase curta, número nunca é trocado ("10%" × "20%" é outro fato): só casa exato ou colado.
        (!short || (!/\d/.test(W[k]) && !/\d/.test(P[p]) && levenshtein(canonical(W[k]), canonical(P[p])) <= TAKE_DEFAULTS.shortSwapMaxEdits))
      ) {
        // palavra trocada ("Fotos" no lugar de "Photos"); nunca na última
        // posição, senão a 1ª palavra da fala seguinte entraria no corte
        swaps++;
        last = k;
        p++;
        k++;
      } else break;
    }
    const enough = matched / P.length >= minRatio;
    const complete = enough && (p >= P.length || (p >= P.length - 1 && P.length >= 4));
    takes.push({ firstWord: i, lastWord: last, matched, complete });
  }
  // Completas que terminam na mesma palavra: fica a que casou mais palavras e,
  // no empate, a que começa DEPOIS (nunca a que arrasta uma tomada falsa junto).
  const best = new Map<number, Take>();
  for (const t of takes.filter((x) => x.complete)) {
    const cur = best.get(t.lastWord);
    if (!cur || t.matched > cur.matched || (t.matched === cur.matched && t.firstWord > cur.firstWord)) best.set(t.lastWord, t);
  }
  const incomplete = takes.filter((t) => !t.complete && ![...best.values()].some((b) => t.firstWord >= b.firstWord && t.firstWord <= b.lastWord));
  return [...best.values(), ...incomplete].sort((x, y) => x.firstWord - y.firstWord || x.lastWord - y.lastWord);
}

/**
 * Intervalo de corte da tomada: margem antes/depois, mas sempre entre o fim da
 * palavra anterior e o começo da seguinte (com `guardS` de folga), nunca
 * cortando a própria tomada. É o que impede a sílaba da tomada vizinha de
 * vazar no corte (bug real da 261027).
 */
export function takeInterval(
  words: Word[],
  take: Pick<Take, "firstWord" | "lastWord">,
  opts: { preRollS?: number; postRollS?: number; guardS?: number } = {},
): Interval {
  const pre = opts.preRollS ?? TAKE_DEFAULTS.preRollS;
  const post = opts.postRollS ?? TAKE_DEFAULTS.postRollS;
  const guard = opts.guardS ?? TAKE_DEFAULTS.guardS;
  const first = words[take.firstWord];
  const last = words[take.lastWord];
  const prev = take.firstWord > 0 ? words[take.firstWord - 1] : undefined;
  const next = take.lastWord + 1 < words.length ? words[take.lastWord + 1] : undefined;
  const lo = prev ? prev.end + guard : 0;
  const hi = next ? next.start - guard : Number.POSITIVE_INFINITY;
  const start = Math.min(first.start, Math.max(lo, first.start - pre));
  const end = Math.max(last.end, Math.min(hi, last.end + post));
  return { start: round3(Math.max(0, start)), end: round3(end) };
}

export type TakeChoice =
  | { ok: true; take: Take; takeNumber: number; interval: Interval; completeTakes: number; text: string }
  | { ok: false; reason: string; takes: Take[] };

/**
 * Escolhe a tomada da frase: por padrão a ÚLTIMA completa (o editor regrava
 * até sair boa); `take` (1-based, entre as completas) força outra.
 */
export function chooseTake(words: Word[], phrase: string, opts: TakeMatchOptions & { take?: number } = {}): TakeChoice {
  const takes = findTakes(words, phrase, opts);
  const complete = takes.filter((t) => t.complete);
  if (complete.length === 0) {
    return { ok: false, reason: `nenhuma tomada completa de "${phrase}" (${takes.length} parcial(is))`, takes };
  }
  let idx = complete.length - 1;
  if (opts.take !== undefined) {
    if (!Number.isInteger(opts.take) || opts.take < 1 || opts.take > complete.length) {
      return { ok: false, reason: `take ${opts.take} fora do intervalo 1..${complete.length} para "${phrase}"`, takes };
    }
    idx = opts.take - 1;
  }
  const take = complete[idx];
  return {
    ok: true,
    take,
    takeNumber: idx + 1,
    interval: takeInterval(words, take),
    completeTakes: complete.length,
    text: joinWordTexts(words.slice(take.firstWord, take.lastWord + 1).map((w) => w.text)),
  };
}

// ── Tomada colapsada (#11754) ─────────────────────────────────────────────

/**
 * Tomada colapsada (#11754): quando a frase foi regravada logo em seguida, o
 * Whisper às vezes registra UMA tomada só, com as palavras esticadas por cima
 * das outras (261030: "dos@294,29 médicos@298,45", 3 tomadas em 289–309 s). O
 * sinal é som sem palavra: mais de `gapS` entre duas palavras seguidas, ou
 * dentro de uma palavra, fora dos silêncios detectados (pausa de verdade, como
 * a fala pausada do #11505, não conta). Decisão do editor (02/11/2026): 1,5 s.
 */
export const COLLAPSED_TAKE = { gapS: 1.5, marginS: 0.5 } as const;

export interface CollapsedTakeSuspect {
  kind: "intervalo" | "palavra-longa";
  /** Onde, no bruto: o fim da palavra antes do vão (ou o começo da palavra longa). */
  at: number;
  /** Fim do trecho suspeito: o começo da palavra depois do vão (ou o fim da palavra longa), #11958. */
  end: number;
  /** Índice, nas palavras do trecho, da palavra longa (ou da palavra antes do vão), #11958. */
  word: number;
  /** Segundos de som sem palavra (fora dos silêncios). */
  audibleS: number;
  before: string;
  after?: string;
  /** Janela sugerida para o `retranscribe` (as palavras do trecho com margem, no máximo `RETRANSCRIBE_MAX_S`). */
  window: Interval;
}

/** Segundos de `[a, b]` fora dos silêncios. */
function audibleSeconds(a: number, b: number, silences: Interval[]): number {
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

/**
 * Suspeitas de tomada colapsada nas palavras de UM trecho (um segmento do
 * Whisper ou as palavras de um item do roteiro). Sem silêncios, conta o vão
 * inteiro.
 */
export function collapsedTakeSuspects(words: Word[], silences: Interval[] = [], opts: { gapS?: number; durationS?: number } = {}): CollapsedTakeSuspect[] {
  const gap = opts.gapS ?? COLLAPSED_TAKE.gapS;
  const ws = words.filter((w) => w.text.trim() !== "");
  if (ws.length === 0) return [];
  const lo = Math.max(0, ws[0].start - COLLAPSED_TAKE.marginS);
  const hiRaw = ws[ws.length - 1].end + COLLAPSED_TAKE.marginS;
  const hi = opts.durationS !== undefined ? Math.min(opts.durationS, hiRaw) : hiRaw;
  const windowAround = (t: number): Interval => {
    if (hi - lo <= RETRANSCRIBE_MAX_S) return { start: round3(lo), end: round3(hi) };
    const start = Math.max(lo, Math.min(t - RETRANSCRIBE_MAX_S / 2, hi - RETRANSCRIBE_MAX_S));
    return { start: round3(start), end: round3(Math.min(hi, start + RETRANSCRIBE_MAX_S)) };
  };
  const out: CollapsedTakeSuspect[] = [];
  ws.forEach((w, i) => {
    const inWord = audibleSeconds(w.start, w.end, silences);
    if (inWord > gap) out.push({ kind: "palavra-longa", at: round3(w.start), end: round3(w.end), word: i, audibleS: round3(inWord), before: w.text.trim(), window: windowAround(w.start) });
    const n = ws[i + 1];
    if (!n) return;
    const between = audibleSeconds(w.end, n.start, silences);
    if (between > gap) out.push({ kind: "intervalo", at: round3(w.end), end: round3(n.start), word: i, audibleS: round3(between), before: w.text.trim(), after: n.text.trim(), window: windowAround(w.end) });
  });
  return out;
}

/** Uma linha legível da suspeita ("4,2 s de som sem palavra entre "dos" e "médicos""). */
export function describeCollapsedSuspect(s: CollapsedTakeSuspect): string {
  const secs = `${s.audibleS.toFixed(1).replace(".", ",")} s`;
  return s.kind === "intervalo" ? `${secs} de som sem palavra entre "${s.before}" e "${s.after}"` : `"${s.before}" esticada por ${secs} de som`;
}

// ── Falso começo e repetição dentro do clipe (#11958) ────────────────────

/**
 * Falso começo que o Whisper engole (#11958, 261103): "duas… dois… duas
 * linhas" e "de seus… de suas conversas" saíram no `transcript.json` como UMA
 * palavra esticada sobre 2–4 s de fala, e a retranscrição da janela inteira
 * também "achou uma tomada só". O que achou o corte, à mão, foram
 * retranscrições em subjanelas de 3–5 s cruzadas com a energia. `windowS`/
 * `hopS` = as subjanelas do `retranscribe --sub` (o arquivo leva `sub.window`,
 * que separa a subjanela da retranscrição da janela inteira); o corte proposto tem de
 * `minCutS` a `maxCutS` e pelo menos `minAudibleS` de som fora dos silêncios
 * (é fala sem palavra, não pausa).
 */
export const REPETITION = { windowS: 4, hopS: 2, marginS: 1.5, minCutS: 0.3, maxCutS: 20, minAudibleS: 0.3, lookbackWords: 3 } as const;

/** As subjanelas do `retranscribe --sub` (#11958): `windowS` com passo `hopS`, a última encostada no fim. */
export function subWindows(w: Interval, windowS: number = REPETITION.windowS, hopS: number = REPETITION.hopS): Interval[] {
  if (!(w.end > w.start)) return [];
  if (w.end - w.start <= windowS + 1e-9) return [{ start: round3(w.start), end: round3(w.end) }];
  const out: Interval[] = [];
  for (let a = w.start; a + windowS < w.end - 1e-9; a += hopS) out.push({ start: round3(a), end: round3(a + windowS) });
  out.push({ start: round3(w.end - windowS), end: round3(w.end) });
  return out;
}

/** Janela sugerida para o `retranscribe --sub` em volta de uma suspeita: o trecho com `marginS` de cada lado, dentro da janela dela. */
export function subRetranscribeWindow(s: Pick<CollapsedTakeSuspect, "at" | "end" | "window">): Interval {
  return { start: round3(Math.max(s.window.start, s.at - REPETITION.marginS)), end: round3(Math.min(s.window.end, s.end + REPETITION.marginS)) };
}

/**
 * Palavras de várias subjanelas sobrepostas, sem duplicar: a mesma palavra
 * ouvida em duas subjanelas (sobreposição de mais da metade da mais curta)
 * fica com a versão mais longe da borda da janela dela (na borda o Whisper
 * corta ou inventa). Em ordem de tempo.
 */
export function mergeWindowWords(windows: Array<{ start: number; end: number; words: Word[] }>): Word[] {
  const cands = windows.flatMap((p) =>
    p.words.filter((w) => w.text.trim() !== "").map((w) => ({ w, edge: Math.min((w.start + w.end) / 2 - p.start, p.end - (w.start + w.end) / 2) })),
  );
  cands.sort((a, b) => b.edge - a.edge);
  const kept: Word[] = [];
  for (const c of cands) {
    const clash = kept.some((k) => {
      const inter = Math.min(k.end, c.w.end) - Math.max(k.start, c.w.start);
      return inter > 0.5 * Math.max(1e-3, Math.min(k.end - k.start, c.w.end - c.w.start));
    });
    if (!clash) kept.push(c.w);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Parecida o bastante para ser o mesmo começo de palavra num falso começo: igual, prefixo cortado ("organiz"), ou 2 letras trocadas com a mesma inicial ("dois"/"duas", "seus"/"suas"). */
function falseStartLike(heard: string, wanted: string, match: TokenMatcher): boolean {
  if (match(heard, wanted)) return true;
  if (heard.length >= 3 && wanted.startsWith(heard)) return true;
  return heard.length >= 3 && wanted.length >= 3 && heard[0] === wanted[0] && levenshtein(heard, wanted) <= 2;
}

export interface RepetitionCut {
  /** O trecho a tirar, no bruto: do fim da palavra antes do falso começo ao começo da repetição final. */
  cut: Interval;
  /** O que a subjanela ouviu no trecho cortado. */
  falseStart: string;
  /** O começo da repetição que fica ("duas linhas"). */
  restart: string;
  /** Segundos de som fora dos silêncios dentro do corte (o cruzamento com a energia). */
  audibleS: number;
}

/**
 * O corte de um falso começo dentro do trecho (#11958): nas palavras das
 * subjanelas (`heard`, já sem duplicata), a ÚLTIMA ocorrência do recomeço (as
 * 1–2 palavras do trecho a partir da palavra suspeita, ou de até
 * `lookbackWords` antes dela) precedida, dentro da suspeita, de outra
 * ocorrência parecida do mesmo começo. O corte vai do fim da palavra antes do
 * recomeço (no transcript do bruto) ao começo da repetição final, e só vale
 * com fala de verdade dentro (`minAudibleS` fora dos silêncios): é a regra da
 * tomada colapsada, a repetição final vale. `null` = as subjanelas não acharam
 * repetição.
 */
export function findRepetitionCut(
  itemWords: Word[],
  suspect: Pick<CollapsedTakeSuspect, "at" | "end" | "word">,
  heard: Word[],
  silences: Interval[] = [],
  match: TokenMatcher = tokensMatch,
): RepetitionCut | null {
  const ws = itemWords.filter((w) => w.text.trim() !== "");
  const toks = ws.map((w) => normalizeToken(w.text));
  const hs = heard.filter((w) => w.text.trim() !== "" && normalizeToken(w.text) !== "");
  const ht = hs.map((w) => normalizeToken(w.text));
  if (!ws.length || !hs.length || suspect.word < 0 || suspect.word >= ws.length) return null;
  const lo = suspect.at - REPETITION.marginS;
  const hi = suspect.end + REPETITION.marginS;
  for (let r = suspect.word; r >= Math.max(0, suspect.word - REPETITION.lookbackWords); r--) {
    const m = Math.min(2, toks.length - r);
    // A repetição final: as `m` palavras do recomeço, em sequência, terminando dentro da suspeita (ou logo depois).
    let last = -1;
    for (let i = hs.length - m; i >= 0; i--) {
      if (hs[i].start > hi || hs[i].start < lo) continue;
      let ok = true;
      for (let k = 0; k < m; k++) if (!match(ht[i + k], toks[r + k])) ok = false;
      if (ok) {
        last = i;
        break;
      }
    }
    if (last <= 0) continue;
    const prevEnd = r > 0 ? ws[r - 1].end : null;
    const first = hs.findIndex((w, i) => i < last && w.start >= Math.max(lo, (prevEnd ?? lo) - 0.3) && falseStartLike(ht[i], toks[r], match));
    if (first < 0) continue;
    const start = prevEnd !== null && prevEnd <= hs[first].start + 1e-6 ? prevEnd : hs[first].start;
    const end = hs[last].start;
    const len = end - start;
    if (len < REPETITION.minCutS || len > REPETITION.maxCutS) continue;
    const audible = audibleSeconds(start, end, silences);
    if (audible < REPETITION.minAudibleS) continue;
    return {
      cut: { start: round3(start), end: round3(end) },
      falseStart: joinWordTexts(hs.slice(first, last).map((w) => w.text.trim())),
      restart: joinWordTexts(hs.slice(last, last + m).map((w) => w.text.trim())),
      audibleS: round3(audible),
    };
  }
  return null;
}

export type CollapsedPick =
  | { ok: true; take: Take; takeNumber: number; completeTakes: number; interval: Interval; words: Word[]; why: string }
  | { ok: false; completeTakes: number; reason: string };

/**
 * A tomada a usar quando a retranscrição da janela separou as tomadas
 * (#11754): por padrão a ÚLTIMA completa (o critério do editor nas 261028 e
 * 261030), salvo comentário da direção no trecho retranscrito: "aprova" vale
 * para a tomada logo antes dele, "aprova-primeira" para a 1ª, "prefere-anterior"
 * para a de antes da última antes do comentário, e "rejeita" tira a tomada
 * logo antes da escolha. Menos de 2 tomadas completas = a retranscrição não
 * separou nada (`ok: false`). `words` já com o vocabulário aplicado.
 */
export function pickCollapsedTake(words: Word[], segments: Segment[], phrase: string, opts: TakeMatchOptions = {}): CollapsedPick {
  const complete = findTakes(words, phrase, opts).filter((t) => t.complete);
  if (complete.length < 2) return { ok: false, completeTakes: complete.length, reason: complete.length ? "a retranscrição achou uma tomada só" : "nenhuma tomada completa na retranscrição" };
  const endOf = (t: Take) => words[t.lastWord].end;
  const rejected = new Set<number>();
  let approved: { idx: number; why: string } | null = null;
  for (const cue of directionCues(segments)) {
    const at = segments[cue.segment].start;
    const before = complete.map((t, i) => [t, i] as const).filter(([t]) => endOf(t) <= at + 1e-6).map(([, i]) => i);
    const idx = before.length ? before[before.length - 1] : -1;
    if (cue.kind === "aprova" && idx >= 0) approved = { idx, why: `aprovada pela direção: "${cue.text}"` };
    else if (cue.kind === "aprova-primeira") approved = { idx: 0, why: `aprovada pela direção: "${cue.text}"` };
    else if (cue.kind === "prefere-anterior" && idx >= 1) approved = { idx: idx - 1, why: `a direção preferiu a anterior: "${cue.text}"` };
    else if (cue.kind === "rejeita" && idx >= 0) rejected.add(idx);
  }
  let pick = approved?.idx;
  let why = approved?.why;
  if (pick === undefined) {
    const free = complete.map((_, i) => i).filter((i) => !rejected.has(i));
    pick = free.length ? free[free.length - 1] : complete.length - 1;
    why = pick === complete.length - 1 ? "a última tomada" : "a última tomada que a direção não recusou";
  }
  const take = complete[pick];
  return {
    ok: true,
    take,
    takeNumber: pick + 1,
    completeTakes: complete.length,
    interval: takeInterval(words, take),
    words: words.slice(take.firstWord, take.lastWord + 1),
    why: why!,
  };
}

// ── Decupagem (gate 1) ────────────────────────────────────────────────────

export interface TakeGroup {
  /** Índices dos segmentos (tomadas da mesma frase), em ordem. */
  segments: number[];
  /** Segmento sugerido (a última tomada completa). */
  suggested: number;
}

function startsAlike(a: string[], b: string[], n: number): boolean {
  const k = Math.min(n, a.length, b.length);
  if (k === 0) return false;
  for (let i = 0; i < k; i++) if (!tokensMatch(a[i], b[i])) return false;
  return true;
}

/**
 * Agrupa segmentos consecutivos que começam igual (as primeiras `prefixTokens`
 * palavras) como tomadas da mesma frase. Sugestão: a última tomada "completa"
 * do grupo — termina em pontuação final e tem pelo menos 80% das palavras da
 * maior tomada; sem nenhuma assim, a mais longa.
 */
export function groupTakes(segments: Segment[], opts: { prefixTokens?: number; skip?: ReadonlySet<number> } = {}): TakeGroup[] {
  const n = opts.prefixTokens ?? 3;
  const toks = segments.map((s) => tokenize(s.text));
  const groups: number[][] = [];
  for (let i = 0; i < segments.length; i++) {
    // Segmento pulado (comentário da direção entre tomadas, #11364) não quebra
    // o grupo nem entra nele.
    if (opts.skip?.has(i)) continue;
    const g = groups[groups.length - 1];
    if (g && startsAlike(toks[g[0]], toks[i], n)) g.push(i);
    else groups.push([i]);
  }
  return groups.map((g) => {
    const longest = Math.max(...g.map((i) => toks[i].length));
    const full = g.filter((i) => /[.!?…]["”']?$/.test(segments[i].text.trim()) && toks[i].length >= 0.8 * longest);
    const suggested = full.length ? full[full.length - 1] : g.reduce((a, b) => (toks[b].length >= toks[a].length ? b : a));
    return { segments: g, suggested };
  });
}

// ── Decisão por critério (#11364) ─────────────────────────────────────────

/**
 * Comentário da direção gravado entre as tomadas, lido do transcript:
 * - `aprova`: aprova a tomada logo antes ("Beleza, é este take", "Muito bom");
 * - `prefere-anterior`: "a anterior tava melhor" (a de antes da última);
 * - `aprova-primeira`: "foi o primeiro do começo" (a 1ª tomada da frase);
 * - `rejeita`: pede outra ("de novo", "errei", "não ficou bom").
 */
export type DirectionKind = "aprova" | "prefere-anterior" | "aprova-primeira" | "rejeita";

export interface DirectionCue {
  /** Índice 0-based do segmento do comentário. */
  segment: number;
  kind: DirectionKind;
  text: string;
}

/** Comentário da direção é curto; frase longa com "muito bom" no meio é fala do roteiro. */
export const DIRECTION_MAX_TOKENS = 10;

/**
 * Teto do comentário GENÉRICO ("Muito bom.", "De novo.", "Perfeito!"): sem
 * marcador de tomada, só o segmento quase todo comentário conta. Fala do
 * roteiro com essas palavras ("A OpenAI subiu de novo o preço.", "O modelo
 * não é perfeito.") passa disso e fica como fala (#11364).
 */
export const DIRECTION_GENERIC_MAX_TOKENS = 4;

// Marcadores específicos (take/tomada, "do começo", "a anterior", "errei"): valem até DIRECTION_MAX_TOKENS.
// Ordem importa: recusa antes de aprovação ("não ficou bom esse take").
const DIRECTION_ANCHORED: Array<[DirectionKind, RegExp]> = [
  ["prefere-anterior", /\b(a|o) (anterior|de antes) (tava|estava|ficou|foi|era) melhor\b/],
  ["aprova-primeira", /\b(o|a) primeir[oa] (do comeco|take|tomada)\b/],
  ["rejeita", /\berrei\b|\b(faz|vamos|mais) (outra|outro|uma) (take|tomada)\b|\bnao (ficou|foi|ta|esta) (bom|boa) (esse|este|essa|esta) (take|tomada)\b/],
  ["aprova", /\b(e|foi) (este|esse|essa|esta) (take|tomada)\b|\b(take|tomada) (bom|boa|valendo|perfeito|perfeita)\b|\botimo take\b/],
];

// Comentário genérico: o segmento inteiro (até DIRECTION_GENERIC_MAX_TOKENS), com muleta opcional na frente.
const LEAD = "(?:(?:beleza|ok|ta|isso|pronto|show|espera|opa|ai) )*";
const DIRECTION_GENERIC: Array<[DirectionKind, RegExp]> = [
  ["aprova-primeira", new RegExp(`^${LEAD}(foi|e|usa|fica|vai) (o|a) primeir[oa]$`)],
  ["rejeita", new RegExp(`^${LEAD}(de novo|outra vez|mais uma vez|vamos outra|faz outra|repete|repetir|nao (ficou|foi|ta|esta) (bom|boa))$`)],
  ["aprova", new RegExp(`^${LEAD}(muito bom|muito boa|ficou (muito )?(bom|boa|otimo|otima|perfeito|perfeita)|perfeito|otimo)( (esse|este|essa|esta))?$`)],
];

/** Lê um segmento como comentário da direção; null se for fala (ou longo demais para ser comentário). */
export function directionKind(text: string): DirectionKind | null {
  const toks = tokenize(text);
  if (toks.length === 0 || toks.length > DIRECTION_MAX_TOKENS) return null;
  const norm = toks.join(" ");
  for (const [kind, re] of DIRECTION_ANCHORED) if (re.test(norm)) return kind;
  if (toks.length > DIRECTION_GENERIC_MAX_TOKENS) return null;
  for (const [kind, re] of DIRECTION_GENERIC) if (re.test(norm)) return kind;
  return null;
}

export function directionCues(segments: Segment[]): DirectionCue[] {
  const out: DirectionCue[] = [];
  segments.forEach((s, i) => {
    const kind = directionKind(s.text);
    if (kind) out.push({ segment: i, kind, text: s.text.trim() });
  });
  return out;
}

/** Qual critério decidiu a linha (a ordem da SKILL, Passo 2). */
export type DecisionCriterion = "direcao" | "ultima-completa" | "bastidor" | "sem-criterio";

export interface TakeDecision {
  /** Índice 0-based do segmento. */
  segment: number;
  suggestion: "usar" | "cortar";
  reason: string;
  criterion: DecisionCriterion;
  /** Segmentos (0-based) do grupo de tomadas da mesma frase; vazio no comentário da direção. */
  group: number[];
}

export interface TakeDecisions {
  cues: DirectionCue[];
  groups: TakeGroup[];
  /** Por segmento: só os que têm decisão (tomadas repetidas, tomada aprovada, comentário da direção). */
  bySegment: Map<number, TakeDecision>;
}

const isComplete = (s: Segment) => /[.!?…]["”']?$/.test(s.text.trim());

/**
 * Decide usar/cortar por critério, uma tomada por frase (#11364), na ordem:
 * (1) a tomada que a direção aprovou (o comentário vale para a tomada logo
 * antes dele; o último comentário vence); (2) emendar com a frase seguinte do
 * roteiro, que depende do roteiro e fica com a skill; (3) a última tomada
 * completa, fora as que a direção recusou. O comentário da direção sai
 * "cortar" (bastidor). Grupo em que a direção recusou todas as tomadas fica
 * `sem-criterio`: é a dúvida real, para retranscrever o trecho antes.
 */
export function decideTakes(segments: Segment[]): TakeDecisions {
  const cues = directionCues(segments);
  const cueSet = new Set(cues.map((c) => c.segment));
  const groups = groupTakes(segments, { skip: cueSet });
  const groupOf = new Map<number, TakeGroup>();
  for (const g of groups) for (const s of g.segments) groupOf.set(s, g);
  const approved = new Map<TakeGroup, { seg: number; cue: DirectionCue }>();
  const rejected = new Map<number, DirectionCue>();
  for (const cue of cues) {
    let prev = cue.segment - 1;
    while (prev >= 0 && cueSet.has(prev)) prev--;
    if (prev < 0) continue;
    const g = groupOf.get(prev)!;
    const pos = g.segments.indexOf(prev);
    if (cue.kind === "aprova") approved.set(g, { seg: prev, cue });
    else if (cue.kind === "aprova-primeira") approved.set(g, { seg: g.segments[0], cue });
    else if (cue.kind === "prefere-anterior") {
      rejected.set(prev, cue);
      if (pos > 0) approved.set(g, { seg: g.segments[pos - 1], cue });
    } else rejected.set(prev, cue);
  }
  const bySegment = new Map<number, TakeDecision>();
  for (const cue of cues) {
    bySegment.set(cue.segment, { segment: cue.segment, suggestion: "cortar", reason: `bastidor: comentário da direção, "${cue.text}"`, criterion: "bastidor", group: [] });
  }
  const ord = (g: TakeGroup, s: number) => `${g.segments.indexOf(s) + 1}ª`;
  for (const g of groups) {
    const ap = approved.get(g);
    if (g.segments.length < 2 && !ap && !rejected.has(g.segments[0])) continue;
    const set = (s: number, suggestion: "usar" | "cortar", reason: string, criterion: DecisionCriterion) =>
      bySegment.set(s, { segment: s, suggestion, reason, criterion, group: g.segments });
    if (ap) {
      for (const s of g.segments) {
        if (s === ap.seg) set(s, "usar", `aprovada pela direção: "${ap.cue.text}"`, "direcao");
        else set(s, "cortar", `a direção aprovou a ${ord(g, ap.seg)} tomada`, "direcao");
      }
      continue;
    }
    const toks = g.segments.map((s) => tokenize(segments[s].text).length);
    const longest = Math.max(...toks);
    const full = new Set(g.segments.filter((s, k) => isComplete(segments[s]) && toks[k] >= 0.8 * longest));
    const pick = g.segments.filter((s) => full.has(s) && !rejected.has(s)).at(-1);
    if (pick === undefined) {
      for (const s of g.segments) set(s, "cortar", rejected.has(s) ? `a direção pediu outra: "${rejected.get(s)!.text}"` : "tomada incompleta", "sem-criterio");
      continue;
    }
    for (const s of g.segments) {
      if (s === pick) set(s, "usar", g.segments.length > 1 ? `${ord(g, s)} tomada, a última completa` : "a última completa", "ultima-completa");
      else if (rejected.has(s)) set(s, "cortar", `a direção pediu outra: "${rejected.get(s)!.text}"`, "ultima-completa");
      else if (!full.has(s)) set(s, "cortar", "tomada incompleta", "ultima-completa");
      else set(s, "cortar", `a ${ord(g, pick)} tomada é a última completa`, "ultima-completa");
    }
  }
  return { cues, groups, bySegment };
}

/** mm:ss.d */
export function clockTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(1).padStart(4, "0")}`;
}

// ── Blocos e sequências ───────────────────────────────────────────────────

/** Blocos conhecidos do roteiro (#11208). Nenhuma versão leva "Por que isso importa?" (editor, 26/10/2026). */
export const BLOCK_KEYS = ["titulo", "abertura", "resumo", "resumo_curto", "comentario", "cta_yt", "cta_vertical", "cta_ig", "cta_out", "fecho"] as const;
export type BlockKey = (typeof BLOCK_KEYS)[number];

export function isBlockKey(k: string): k is BlockKey {
  return (BLOCK_KEYS as readonly string[]).includes(k);
}

/**
 * Item de um bloco: a FRASE (a tomada sai sozinha, a última completa; `take`
 * força outra) ou um INTERVALO explícito no bruto (com `text` opcional, o que
 * deveria estar sendo dito).
 */
export type BlockItem = ItemScope &
  (
    | { text: string; take?: number; start?: undefined; end?: undefined }
    | { start: number; end: number; text?: string; take?: undefined }
  );

export type SequenceTarget = "youtube" | "instagram" | "outras-redes";
export const SEQUENCE_TARGETS: readonly SequenceTarget[] = ["youtube", "instagram", "outras-redes"];

/**
 * Em quais versões um item de bloco entra (#11377): `targets` lista as versões
 * em que entra; `skip`, as que pula. Os dois ausentes = todas. Os dois juntos é
 * erro na validação. Serve para cortar parte do comentário só nas verticais
 * (passaram de 3:00 do Shorts) sem duplicar o bloco.
 */
export interface ItemScope {
  /** Destinos (`youtube`/`instagram`/`outras-redes`) ou slugs de corte (#11900). */
  targets?: SequenceKey[];
  skip?: SequenceKey[];
}

/**
 * Identidade de uma sequência no plano (#11900): o slug do corte, ou o destino
 * na sequência sem corte. Única por plano (a validação recusa repetida). É a
 * chave dos arquivos de trabalho (`seq-{key}.wav`, `previa-{key}`,
 * `review-{key}.json`), do `--seq` do CLI e dos `targets`/`skip` dos itens.
 * Sem corte ela é o próprio destino, então o `blocks.json` sem corte e os
 * arquivos de trabalho dele não mudam.
 */
export type SequenceKey = string;
export type SequenceRef = { target: SequenceTarget; corte?: string };

export function sequenceKey(spec: SequenceRef): SequenceKey {
  return spec.corte ?? spec.target;
}

/**
 * A lista (`targets`/`skip` de item, `targets` de regra de vocabulário) cita
 * esta sequência? Cita pelo slug do corte ou pelo destino. Um corte também
 * casa pelo destino interno dele (compatível com o `blocks.json` de 1 extra,
 * em que `"targets": ["instagram"]` mirava o corte de target `instagram`); para
 * mirar um corte só, use o slug.
 */
export function sequenceInList(list: readonly string[], seq: SequenceTarget | SequenceRef): boolean {
  const ref: SequenceRef = typeof seq === "string" ? { target: seq } : seq;
  return list.includes(ref.target) || (ref.corte !== undefined && list.includes(ref.corte));
}

/** O item entra na versão `seq` (destino, ou a sequência com o corte)? */
export function itemInTarget(scope: ItemScope, seq: SequenceTarget | SequenceRef): boolean {
  if (scope.targets && !sequenceInList(scope.targets, seq)) return false;
  if (scope.skip && sequenceInList(scope.skip, seq)) return false;
  return true;
}

/** Erros de `targets`/`skip` de um item (lista não vazia de destinos ou cortes do plano, sem os dois juntos). */
function validateItemScope(it: Record<string, unknown>, label: string, cortes: readonly string[] = []): string[] {
  const errors: string[] = [];
  const known: readonly string[] = [...SEQUENCE_TARGETS, ...cortes];
  for (const field of ["targets", "skip"] as const) {
    const v = it[field];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length === 0 || v.some((t) => !known.includes(t as string))) {
      errors.push(`${label}: ${field} precisa ser uma lista não vazia de ${known.join("/")}`);
    }
  }
  if (it.targets !== undefined && it.skip !== undefined) errors.push(`${label}: targets e skip juntos; usar só um`);
  return errors;
}

export interface SequenceSpec {
  target: SequenceTarget;
  /** Nome da sequência no Premiere = nome default do export (`videoTargetOf` reconhece o destino). */
  name: string;
  width: number;
  height: number;
  /** Blocos, na ordem. */
  order: BlockKey[];
  /** Escala (%) alternada nos cortes (clipes contíguos fundidos antes, #11503): [base, punch-in]. */
  scales: [number, number];
  /**
   * Vertical extra, fora do fluxo da edição (261103: a 2ª vertical, sobre IA
   * soberana); o editor publica com `publish-shorts.ts --corte {slug} --video …`.
   * O nome é o da vertical normal com `-{corte}` no fim
   * (`Diaria comentada_Vertical_V1-soberana`), que `videoTargetOf` lê como
   * `null`: o fetch da edição nunca a confunde com a vertical do dia. A
   * sequência é identificada pelo slug (`sequenceKey`, #11900): pode haver
   * várias, e o `target` delas (`instagram`/`outras-redes`) só diz o formato e
   * pode repetir. Os `targets`/`skip` dos itens miram o corte pelo slug (ou
   * pelo destino, que pega todas as sequências daquele destino).
   */
  corte?: string;
  /**
   * Só no corte (#11900): o título na tela DESTA vertical, que sobrepõe o
   * `screenTitle` do arquivo e o título do D1 (o corte tem outro roteiro; sem
   * isto ele saía com o título da notícia). Também é o `--title` da publicação
   * (`video-extra-verticals.ts`). "" = sem título na tela.
   */
  screenTitle?: string;
  /**
   * Só no corte (#11900): o gancho da publicação (`--hook` do modo corte).
   * Ausente = o texto do `resumo_curto` (ou do `resumo`) que entra nesta vertical.
   */
  hook?: string;
}

/** O bruto, como o `transcribe` mediu (`source.json`, a fonte única). */
export interface SourceInfo {
  /** Caminho local do bruto (Drive for desktop), com `/`. */
  path: string;
  fps: number;
  durationS: number;
  width: number;
  height: number;
  /**
   * Bruto espelhado (a caneca aparece invertida). O `transcribe` decide pelo
   * metadado da câmera, quando houver (traseira não espelha, #11959), senão
   * pelo `publishing.video.mirrored_default` do config (true, a premissa do
   * #11208); `blocks.json` sobrepõe.
   */
  mirrored: boolean;
  /** De onde veio o `mirrored` do `transcribe` (#11959); ausente em `source.json` anterior a ele. */
  mirroredFrom?: MirroredFrom;
  /** Câmera lida do metadado do bruto (#11959), quando houver. */
  camera?: CameraFacing;
  /**
   * Bruto só de áudio (#11552, edição 261029): sem stream de vídeo, `width` e
   * `height` saem 0 e `fps` é o nominal `AUDIO_ONLY_FPS` (só a grade dos
   * tempos do roteiro). Transcrição, decupagem e roteiro rodam; build, srt,
   * prévia, review e frame param antes, dizendo o motivo. Ausente = vídeo.
   */
  audioOnly?: true;
}

/** fps nominal do modo áudio (#11552): o roteiro conta tempo em frames; 30 é o dos brutos de vídeo. */
export const AUDIO_ONLY_FPS = 30;

/** Centro do rosto, em fração do quadro JÁ desespelhado: x do centro, y da linha dos olhos. */
export interface Framing {
  faceX: number;
  eyeY: number;
  /**
   * Caixa da caneca diar.ia.br no bruto já desespelhado, em fração do quadro
   * (#11939). Opcional: sem ela o recorte é só pelo rosto, como antes. Com
   * ela, `framingFor` desloca o recorte em direção à caneca até
   * `MUG_MAX_FACE_SHIFT` da largura do bruto; o rosto continua a prioridade.
   */
  mug?: MugBox;
}

export interface MugBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface VocabRule {
  /** Regex (fonte), aplicada ao texto das palavras unido por espaço. */
  pattern: string;
  replacement: string;
  /** Flags da regex; default "g". */
  flags?: string;
  /** Só nestas versões (destino, ou slug de corte no `blocks.json`, #11900); ausente = todas. */
  targets?: SequenceKey[];
  note?: string;
}

/**
 * O que o gate da decupagem decide, por edição
 * (`_internal/video-montagem/blocks.json`). O bruto em si vem do
 * `source.json`; aqui só os overrides.
 */
export interface BlocksFile {
  edition: string;
  /** Sobrepõe o `mirrored` do `source.json` (false quando a caneca aparece legível no bruto). */
  mirrored?: boolean;
  /** Legado: só conferido contra o `source.json` (path, duração, fps); o `mirrored` dele vale como override. */
  source?: Partial<SourceInfo>;
  framing?: Framing;
  blocks: Partial<Record<BlockKey, BlockItem[]>>;
  sequences?: SequenceSpec[];
  /** Formato da gravação (#11507); decide as sequências default quando `sequences` falta. Ausente = inferido dos blocos (`effectiveFormat`). */
  format?: VideoFormat;
  /** Regras extras desta edição, somadas às de `context/video-montagem/vocabulario.json`. */
  vocabulary?: VocabRule[];
  /** Blocos que seguram `FECHO_HOLD_S` depois da última palavra. Default ["fecho"]. */
  holdBlocks?: BlockKey[];
  /** Duração-alvo da vertical nesta edição, em segundos (#11757); ausente = `VERTICAL_TARGET_S` (85). */
  verticalTargetS?: number;
  /**
   * Título em texto na abertura das verticais (#11756): sobrepõe o título do D1
   * (`02-reviewed.md`), para a versão curta que cabe na tela. "" = sem título.
   */
  screenTitle?: string;
}

/** Slug de corte: minúsculas, dígitos e hífen (`soberana`, `ia-soberana`). */
const CORTE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function validRegex(pattern: unknown, flags: unknown): string | null {
  if (typeof pattern !== "string" || pattern === "") return "pattern vazio ou não-string";
  try {
    new RegExp(pattern, typeof flags === "string" ? flags : "g");
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Confere as regras de vocabulário (de `vocabulario.json` ou do `blocks.json`). */
export function validateVocabRules(raw: unknown, where: string, cortes: readonly string[] = []): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [`${where}: precisa ser uma lista`];
  const errors: string[] = [];
  const known: readonly string[] = [...SEQUENCE_TARGETS, ...cortes];
  raw.forEach((r, i) => {
    if (!isObj(r)) return void errors.push(`${where}[${i}]: precisa ser objeto`);
    const bad = validRegex(r.pattern, r.flags);
    if (bad) errors.push(`${where}[${i}]: regex inválida (${bad})`);
    if (typeof r.replacement !== "string") errors.push(`${where}[${i}]: replacement precisa ser string`);
    if (r.targets !== undefined && (!Array.isArray(r.targets) || r.targets.some((t) => !known.includes(t as string)))) {
      errors.push(`${where}[${i}]: targets fora de ${known.join("/")}`);
    }
  });
  return errors;
}

/**
 * Valida o `blocks.json` lido do disco, juntando TODOS os erros (o gate mostra
 * tudo de uma vez): chaves de bloco conhecidas, itens bem formados, sequências
 * com destino único e coerente com o nome, escalas, vocabulário que compila.
 */
export function parseBlocksFile(raw: unknown): { ok: true; file: BlocksFile } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["blocks.json precisa ser um objeto"] };
  // Os cortes do plano (#11900): os `targets`/`skip` dos itens e do vocabulário podem citá-los pelo slug.
  const cortes = Array.isArray(raw.sequences)
    ? raw.sequences.flatMap((s) => (isObj(s) && typeof s.corte === "string" && CORTE_SLUG_RE.test(s.corte) ? [s.corte] : []))
    : [];
  if (typeof raw.edition !== "string" || !/^\d{6}$/.test(raw.edition)) errors.push("edition precisa ser AAMMDD");
  if (raw.mirrored !== undefined && typeof raw.mirrored !== "boolean") errors.push("mirrored precisa ser true/false");
  if (raw.format !== undefined && !VIDEO_FORMATS.includes(raw.format as VideoFormat)) errors.push(`format precisa ser ${VIDEO_FORMATS.join(" ou ")}`);
  if (raw.source !== undefined && !isObj(raw.source)) errors.push("source (legado) precisa ser objeto");
  if (raw.framing !== undefined) {
    const fr = raw.framing;
    if (!isObj(fr) || !isNum(fr.faceX) || !isNum(fr.eyeY) || fr.faceX < 0 || fr.faceX > 1 || fr.eyeY < 0 || fr.eyeY > 1) {
      errors.push("framing precisa de faceX e eyeY entre 0 e 1 (fração do quadro)");
    }
    if (isObj(fr) && fr.mug !== undefined) {
      const m = fr.mug;
      const inUnit = (v: unknown) => isNum(v) && v >= 0 && v <= 1;
      if (!isObj(m) || ![m.left, m.right, m.top, m.bottom].every(inUnit) || !((m.left as number) < (m.right as number)) || !((m.top as number) < (m.bottom as number))) {
        errors.push("framing.mug precisa de left < right e top < bottom, entre 0 e 1 (fração do quadro desespelhado)");
      }
    }
  }
  if (!isObj(raw.blocks)) errors.push("blocks precisa ser um objeto");
  else {
    for (const [key, items] of Object.entries(raw.blocks)) {
      if (!isBlockKey(key)) {
        errors.push(`blocks.${key}: bloco desconhecido (válidos: ${BLOCK_KEYS.join(", ")})`);
        continue;
      }
      if (!Array.isArray(items)) {
        errors.push(`blocks.${key}: precisa ser uma lista`);
        continue;
      }
      items.forEach((it, i) => {
        const label = `blocks.${key}[${i}]`;
        if (!isObj(it)) return void errors.push(`${label}: precisa ser objeto`);
        const hasRange = it.start !== undefined || it.end !== undefined;
        if (hasRange) {
          if (!isNum(it.start) || !isNum(it.end) || it.start < 0 || !(it.end > it.start)) errors.push(`${label}: intervalo inválido (start=${it.start}, end=${it.end})`);
          if (it.take !== undefined) errors.push(`${label}: take não vale com intervalo explícito`);
          if (it.text !== undefined && typeof it.text !== "string") errors.push(`${label}: text precisa ser string`);
        } else {
          if (typeof it.text !== "string" || !it.text.trim()) errors.push(`${label}: sem texto nem intervalo`);
          if (it.take !== undefined && !(Number.isInteger(it.take) && (it.take as number) >= 1)) errors.push(`${label}: take precisa ser inteiro ≥ 1`);
        }
        errors.push(...validateItemScope(it, label, cortes));
      });
    }
  }
  if (raw.verticalTargetS !== undefined && !(isNum(raw.verticalTargetS) && raw.verticalTargetS > 0)) errors.push("verticalTargetS precisa ser um número de segundos maior que 0");
  if (raw.screenTitle !== undefined && typeof raw.screenTitle !== "string") errors.push('screenTitle precisa ser texto ("" = sem título na vertical)');
  if (raw.holdBlocks !== undefined) {
    if (!Array.isArray(raw.holdBlocks) || raw.holdBlocks.some((k) => typeof k !== "string" || !isBlockKey(k))) errors.push("holdBlocks precisa listar blocos conhecidos");
  }
  if (raw.sequences === undefined && isObj(raw.blocks) && ([raw.blocks.cta_ig, raw.blocks.cta_out].some((items) => Array.isArray(items) && items.length > 0))) {
    errors.push("blocks.json legado: renomeie o CTA escolhido (cta_out ou cta_ig) para cta_vertical e remova o outro; ou informe sequences explícitas para preservar os cortes antigos");
  }
  if (raw.sequences !== undefined) {
    if (!Array.isArray(raw.sequences) || raw.sequences.length === 0) errors.push("sequences precisa ser uma lista não vazia");
    else {
      const seen = new Set<string>();
      raw.sequences.forEach((s, i) => {
        const label = `sequences[${i}]`;
        if (!isObj(s)) return void errors.push(`${label}: precisa ser objeto`);
        // Identidade única por plano (#11900): o slug do corte, ou o destino na sequência sem corte.
        // Cortes podem repetir o destino (várias verticais extras); só a chave não repete.
        const corteOk = typeof s.corte === "string" && CORTE_SLUG_RE.test(s.corte);
        if (typeof s.target !== "string" || !SEQUENCE_TARGETS.includes(s.target as SequenceTarget)) errors.push(`${label}: target fora de ${SEQUENCE_TARGETS.join("/")}`);
        else if (s.corte === undefined) {
          if (seen.has(s.target)) errors.push(`${label}: target ${s.target} repetido`);
          else seen.add(s.target);
        }
        if (s.corte !== undefined && !corteOk) errors.push(`${label}: corte precisa ser um slug (minúsculas, dígitos e hífen)`);
        else if (corteOk) {
          const c = s.corte as string;
          if ((SEQUENCE_TARGETS as readonly string[]).includes(c)) errors.push(`${label}: corte "${c}" é nome de destino; use outro slug`);
          else if (seen.has(`corte:${c}`)) errors.push(`${label}: corte ${c} repetido`);
          else seen.add(`corte:${c}`);
        }
        for (const k of ["screenTitle", "hook"] as const) {
          if (s[k] === undefined) continue;
          if (typeof s[k] !== "string") errors.push(`${label}: ${k} precisa ser texto`);
          else if (s.corte === undefined) errors.push(`${label}: ${k} só vale numa sequência de corte (a vertical da edição usa o screenTitle do arquivo e o D1)`);
        }
        if (typeof s.hook === "string" && !s.hook.trim()) errors.push(`${label}: hook vazio (omita para usar o resumo_curto)`);
        if (typeof s.name !== "string" || !s.name.trim()) errors.push(`${label}: sem name`);
        else if (typeof s.corte === "string") {
          if (corteSuffixOf(s.name) !== s.corte) errors.push(`${label}: o nome "${s.name}" de um corte precisa terminar em _V{n}-${s.corte}`);
          if (s.target === "youtube") errors.push(`${label}: corte é vertical; target instagram ou outras-redes`);
          if (Number.isInteger(s.width) && Number.isInteger(s.height) && (s.height as number) <= (s.width as number)) errors.push(`${label}: corte é vertical (height > width)`);
        } else if (videoTargetOf(s.name) !== s.target) {
          errors.push(`${label}: o nome "${s.name}" não indica o destino ${s.target} (export cairia no destino errado da pasta Final/)`);
        }
        if (!Number.isInteger(s.width) || !Number.isInteger(s.height) || (s.width as number) <= 0 || (s.height as number) <= 0) errors.push(`${label}: width/height inteiros positivos`);
        if (!Array.isArray(s.order) || s.order.length === 0 || s.order.some((k) => typeof k !== "string" || !isBlockKey(k))) errors.push(`${label}: order precisa listar blocos conhecidos`);
        if (!Array.isArray(s.scales) || s.scales.length !== 2 || s.scales.some((x) => !isNum(x) || x <= 0)) errors.push(`${label}: scales precisa de exatamente 2 números positivos`);
      });
    }
  }
  errors.push(...validateVocabRules(raw.vocabulary, "vocabulary", cortes));
  if (errors.length) return { ok: false, errors };
  return { ok: true, file: raw as unknown as BlocksFile };
}

/**
 * O bruto efetivo: o `source.json` com o `mirrored` sobreposto pelo
 * `blocks.json`. Um `source` legado no `blocks.json` que diverge do
 * `source.json` (outro bruto, outra duração, outro fps) é erro, nunca
 * escolha silenciosa. fps fracionário também (o XML usa timebase inteiro).
 */
export function effectiveSource(measured: SourceInfo, file?: Pick<BlocksFile, "mirrored" | "source">): { source: SourceInfo; errors: string[] } {
  const errors: string[] = [];
  const legacy = file?.source;
  const norm = (p: string) => p.replace(/\\/g, "/");
  if (legacy) {
    if (legacy.path !== undefined && norm(legacy.path) !== norm(measured.path)) errors.push(`blocks.json aponta outro bruto (${legacy.path}) que o source.json (${measured.path})`);
    if (legacy.durationS !== undefined && Math.abs(legacy.durationS - measured.durationS) > 0.05) errors.push(`duração do blocks.json (${legacy.durationS}) diverge do source.json (${measured.durationS})`);
    if (legacy.fps !== undefined && legacy.fps !== measured.fps) errors.push(`fps do blocks.json (${legacy.fps}) diverge do source.json (${measured.fps})`);
  }
  if (!Number.isInteger(measured.fps)) errors.push(`fps ${measured.fps} não inteiro: o XML usa timebase inteiro com NTSC=FALSE`);
  const mirrored = file?.mirrored ?? legacy?.mirrored ?? measured.mirrored ?? true;
  return { source: { ...measured, mirrored }, errors };
}

/** Enquadramento medido na 261027 (`cx=1850`, olhos em y=1160 no 3840x2160, depois do flip). */
export const FRAMING_261027: Framing = { faceX: 1850 / 3840, eyeY: 1160 / 2160 };

/** O framing do `blocks.json`, ou o da 261027 (`assumed: true`, para o `[premissa]`). Um ponto só para build e prévia. */
export function effectiveFraming(file: Pick<BlocksFile, "framing">): { framing: Framing; assumed: boolean } {
  return file.framing ? { framing: file.framing, assumed: false } : { framing: FRAMING_261027, assumed: true };
}

/**
 * Formato da gravação (#11507). `monologo` (o de sempre): o Pixel grava título,
 * resumo e comentário. `entrevista` (261029): a entrevistadora pergunta, o
 * Pixel responde, sem título nem resumo gravados; as sequências default
 * pulam esses blocos.
 */
export type VideoFormat = "monologo" | "entrevista";
export const VIDEO_FORMATS: readonly VideoFormat[] = ["monologo", "entrevista"];

/** Blocos que só o monólogo grava: sem nenhum deles (e com comentário), o formato é entrevista. */
export const MONOLOGUE_ONLY_BLOCKS: readonly BlockKey[] = ["titulo", "resumo", "resumo_curto"];

/**
 * O formato da edição: o `format` do `blocks.json` vence; sem ele, `entrevista`
 * quando nenhum bloco de `MONOLOGUE_ONLY_BLOCKS` tem item e o comentário tem
 * (`inferred: true`, para o `[premissa]`).
 */
export function effectiveFormat(file: { format?: VideoFormat; blocks: Partial<Record<BlockKey, unknown[]>> }): { format: VideoFormat; inferred: boolean } {
  if (file.format) return { format: file.format, inferred: false };
  const has = (k: BlockKey) => (file.blocks[k]?.length ?? 0) > 0;
  const entrevista = has("comentario") && MONOLOGUE_ONLY_BLOCKS.every((k) => !has(k));
  return { format: entrevista ? "entrevista" : "monologo", inferred: entrevista };
}

/**
 * As 2 versões (#11491). Nomes no padrão dos finais da pasta `Final/`
 * (`Diaria comentada_Youtube_V3.mp4`, #11222): o Premiere sugere o nome da
 * sequência no export, e `videoTargetOf` lê o destino dele. Escalas: 50/62 no
 * horizontal (50% de um 4K enche 1920x1080); 115/130 nas verticais (a da
 * prévia aprovada da 261027; o XML dela saiu com 89/105, "enquadramento
 * pequeno" na autorrevisão).
 */
export function defaultSequences(version = "V1", format: VideoFormat = "monologo"): SequenceSpec[] {
  if (format === "entrevista") {
    // #11507 (261029): sem título nem resumo gravados, a ordem que o editor montou à mão.
    return [
      { target: "youtube", name: `Diaria comentada_Youtube_${version}`, width: 1920, height: 1080, order: ["abertura", "comentario", "cta_yt", "fecho"], scales: [50, 62] },
      { target: "outras-redes", name: `Diaria comentada_Vertical_${version}`, width: 1080, height: 1920, order: ["abertura", "comentario", "cta_vertical", "fecho"], scales: [115, 130] },
    ];
  }
  return [
    {
      target: "youtube",
      name: `Diaria comentada_Youtube_${version}`,
      width: 1920,
      height: 1080,
      order: ["titulo", "abertura", "resumo", "comentario", "cta_yt", "fecho"],
      scales: [50, 62],
    },
    {
      target: "outras-redes",
      name: `Diaria comentada_Vertical_${version}`,
      width: 1080,
      height: 1920,
      order: ["titulo", "resumo_curto", "comentario", "cta_vertical", "fecho"],
      scales: [115, 130],
    },
  ];
}

export type ResolvedItem = {
  interval: Interval;
  text: string;
  /**
   * A fala ouvida no trecho, só quando difere do `text` pedido (#11362): o
   * `roteiro` mostra a diferença no Gate 2 em vez de o casamento tolerante
   * esconder uma palavra trocada.
   */
  heard?: string;
  /** Palavras do bruto dentro do intervalo (meio da palavra dentro). */
  words: Word[];
  /** Fim da última palavra dita no trecho; null sem palavra. */
  lastWordEnd: number | null;
  /** Até onde um respiro pode ir sem pegar a palavra seguinte do bruto (`next.start - guardS`, ou a duração). */
  holdLimit: number;
  /**
   * Tomada colapsada no trecho (#11754): as suspeitas e, quando uma
   * retranscrição da janela separou as tomadas, a escolhida (o `interval` e as
   * `words` já são os dela). Sem `picked`, o trecho segue inteiro e o roteiro
   * pede a retranscrição.
   */
  collapsed?: {
    suspects: CollapsedTakeSuspect[];
    picked?: { takeNumber: number; completeTakes: number; why: string; from: Interval };
    /** Retranscrição da janela existe mas não separou as tomadas. */
    unresolved?: string;
    /** Subjanelas curtas (`retranscribe --sub`) cobrem a suspeita (#11958). */
    subChecked?: boolean;
    /** Falso começo achado nas subjanelas (#11958): corte PROPOSTO, o editor aprova no Gate 2 (o intervalo do item não muda). */
    repetition?: RepetitionCut;
  };
} & ItemScope &
  ({ how: "take"; take: number; completeTakes: number } | { how: "explicit" });

/** O escopo do item, só com os campos presentes (o `plan.json` não ganha `targets: undefined`). */
const scopeOf = (it: ItemScope): ItemScope => ({ ...(it.targets ? { targets: it.targets } : {}), ...(it.skip ? { skip: it.skip } : {}) });

export interface ResolveOptions {
  silences?: Interval[];
  durationS: number;
  /** Vocabulário aplicado às palavras do bruto antes de casar as frases. */
  rules?: VocabRule[];
  aliases?: VocabAlias[];
  /**
   * Retranscrições de janela já no tempo do bruto (`retranscribe-*.json`,
   * #11754): o trecho com tomada colapsada que uma delas cobre usa a tomada
   * que ela separou (`pickCollapsedTake`).
   */
  retranscribed?: Transcript[];
}

/** Apara só as bordas dentro de silêncio; preserva palavras sem núcleo audível. */
export function trimWordsToSilences(words: Word[], silences: Interval[]): Word[] {
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  return words.map((w) => {
    let { start, end } = w;
    for (const s of sorted) {
      if (start >= s.start && start < s.end) start = Math.min(end, s.end);
      if (end > s.start && end <= s.end) end = Math.max(start, s.start);
    }
    return end > start ? { ...w, start, end } : { ...w };
  });
}

/**
 * Resolve os blocos contra o transcript do bruto: frase → tomada (`chooseTake`,
 * com o vocabulário já aplicado às palavras e os aliases no casamento),
 * intervalo explícito → ele mesmo. Erros juntos, para o gate mostrar tudo de
 * uma vez.
 */
export function resolveBlocks(
  file: BlocksFile,
  rawWords: Word[],
  opts: ResolveOptions,
): { blocks: Partial<Record<BlockKey, ResolvedItem[]>>; errors: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const words = applyVocabularyToWords(trimWordsToSilences(rawWords, opts.silences ?? []), [...(opts.rules ?? []), ...(file.vocabulary ?? [])], undefined, (w) => warnings.push(w));
  const match = makeMatcher(opts.aliases);
  const guard = TAKE_DEFAULTS.guardS;
  const blocks: Partial<Record<BlockKey, ResolvedItem[]>> = {};
  const errors: string[] = [];
  const limitAfter = (idx: number) => (idx < words.length ? words[idx].start - guard : opts.durationS);
  // A fala ouvida, quando ela difere do texto pedido (#11362); undefined quando bate.
  const heardIfDiffers = (label: string, wanted: string | undefined, ws: Word[]): string | undefined => {
    if (wanted === undefined || ws.length === 0) return undefined;
    const heard = joinWordTexts(ws.map((w) => w.text));
    if (sameSpeech(tokenize(heard), tokenize(wanted), match)) return undefined;
    warnings.push(`${label}: a fala ouvida difere do texto pedido: "${heard}" (pedido: "${wanted.trim()}")`);
    return heard;
  };
  // Tomada colapsada (#11754): suspeita no trecho → a retranscrição que o cobre decide a tomada.
  const firstWordAfter = (t: number) => words.findIndex((w) => w.start >= t - 1e-6);
  const limitAfterTime = (t: number) => {
    const idx = firstWordAfter(t);
    return idx < 0 ? opts.durationS : limitAfter(idx);
  };
  const patches = (opts.retranscribed ?? [])
    .map((t) => {
      const ws = applyVocabularyToWords(trimWordsToSilences(transcriptWords(t), opts.silences ?? []), [...(opts.rules ?? []), ...(file.vocabulary ?? [])]);
      if (t.sub) return { sub: true, segments: t.segments, words: ws, start: t.sub.window.start, end: t.sub.window.end };
      return ws.length ? { sub: false, segments: t.segments, words: ws, start: ws[0].start, end: ws[ws.length - 1].end } : null;
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  // Subjanelas (#11958, `retranscribe --sub`): juntas sem duplicar, só para achar o falso começo.
  const subPatches = patches.filter((p) => p.sub);
  const windowPatches = patches.filter((p) => !p.sub && p.words.length);
  const repetitionOf = (ws: Word[], sus: CollapsedTakeSuspect): { subChecked: boolean; repetition?: RepetitionCut } => {
    const near = subPatches.filter((p) => p.end >= sus.at - REPETITION.marginS && p.start <= sus.end + REPETITION.marginS);
    if (!near.length) return { subChecked: false };
    const rep = findRepetitionCut(ws, sus, mergeWindowWords(near), opts.silences ?? [], match);
    return rep ? { subChecked: true, repetition: rep } : { subChecked: true };
  };
  const repetitionWarning = (label: string, rep: RepetitionCut) =>
    `${label}: falso começo/repetição "${rep.falseStart}" (${rep.cut.start.toFixed(2)}–${rep.cut.end.toFixed(2)} s, ${rep.audibleS.toFixed(1)} s de fala sem palavra no transcript): corte proposto no roteiro, linha repetição, para aprovar no Gate 2 (#11958)`;
  const collapse = (
    label: string,
    span: Interval,
    text: string | undefined,
    ws: Word[],
    mayPick: boolean,
  ): { info?: NonNullable<ResolvedItem["collapsed"]>; picked?: { interval: Interval; words: Word[] } } => {
    const suspects = collapsedTakeSuspects(ws, opts.silences ?? [], { durationS: opts.durationS });
    if (suspects.length === 0) return {};
    const what = describeCollapsedSuspect(suspects[0]);
    const win = suspects[0].window;
    const tol = COLLAPSED_TAKE.marginS;
    // A retranscrição que cobre as palavras do trecho; a mais recente na lista vence.
    const lo = ws[0].start;
    const hi = ws[ws.length - 1].end;
    const patch = [...windowPatches].reverse().find((p) => p.start <= lo + tol + 1 && p.end >= hi - tol - 1);
    const sub = repetitionOf(ws, suspects[0]);
    const subInfo = { ...(sub.subChecked ? { subChecked: true } : {}), ...(sub.repetition ? { repetition: sub.repetition } : {}) };
    if (!patch || text === undefined || !mayPick) {
      const why = !mayPick ? "take explícito no blocks.json: tomada mantida" : text === undefined ? "intervalo sem text: não dá para separar as tomadas" : `retranscrever ${win.start.toFixed(1)}–${win.end.toFixed(1)} s e rodar de novo`;
      warnings.push(`${label}: possível tomada colapsada (${what}): ${why} (#11754)`);
      if (sub.repetition) warnings.push(repetitionWarning(label, sub.repetition));
      return { info: { suspects, ...subInfo } };
    }
    const inside = patch.words.filter((w) => (w.start + w.end) / 2 >= span.start - tol && (w.start + w.end) / 2 <= span.end + tol);
    const pick = pickCollapsedTake(inside, patch.segments, text, { match });
    if (!pick.ok) {
      if (sub.repetition) warnings.push(repetitionWarning(label, sub.repetition));
      else {
        const sw = subRetranscribeWindow(suspects[0]);
        const next = sub.subChecked ? "as subjanelas também não acharam repetição: conferir no áudio" : `retranscrever em subjanelas (--sub --from ${sw.start.toFixed(1)} --to ${sw.end.toFixed(1)}) e rodar de novo (#11958)`;
        warnings.push(`${label}: possível tomada colapsada (${what}); a retranscrição não separou as tomadas (${pick.reason}): o trecho segue inteiro, ${next} (#11754)`);
      }
      return { info: { suspects, unresolved: pick.reason, ...subInfo } };
    }
    warnings.push(
      `${label}: tomada colapsada (${what}): a retranscrição separou ${pick.completeTakes} tomadas; usando a ${pick.takeNumber}ª (${pick.why}), ${pick.interval.start.toFixed(2)}–${pick.interval.end.toFixed(2)} s (#11754)`,
    );
    return {
      info: { suspects, picked: { takeNumber: pick.takeNumber, completeTakes: pick.completeTakes, why: pick.why, from: span } },
      picked: { interval: pick.interval, words: pick.words },
    };
  };
  for (const [key, items] of Object.entries(file.blocks) as Array<[BlockKey, BlockItem[]]>) {
    const out: ResolvedItem[] = [];
    blocks[key] = out;
    items.forEach((it, i) => {
      const label = `${key}[${i}]`;
      if (it.start !== undefined) {
        if (it.end > opts.durationS + 1e-6) return void errors.push(`${label}: end ${it.end} além da duração do bruto (${opts.durationS})`);
        const idx = words.map((w, n) => [w, n] as const).filter(([w]) => (w.start + w.end) / 2 >= it.start && (w.start + w.end) / 2 <= it.end);
        const inside = idx.map(([w]) => w);
        const lastIdx = idx.length ? idx[idx.length - 1][1] : -1;
        const nextIdx = lastIdx >= 0 ? lastIdx + 1 : words.findIndex((w) => w.start >= it.end);
        const col = collapse(label, { start: it.start, end: it.end }, it.text, inside, true);
        const ws = col.picked ? col.picked.words : inside;
        const heard = heardIfDiffers(label, it.text, ws);
        const holdIdx = col.picked ? firstWordAfter(col.picked.interval.end) : nextIdx;
        out.push({
          interval: col.picked ? col.picked.interval : { start: it.start, end: it.end },
          text: it.text ?? joinWordTexts(inside.map((w) => w.text)),
          ...(heard !== undefined ? { heard } : {}),
          words: ws,
          lastWordEnd: ws.length ? ws[ws.length - 1].end : null,
          holdLimit: round3(Math.min(opts.durationS, holdIdx < 0 ? opts.durationS : limitAfter(holdIdx))),
          ...(col.info ? { collapsed: col.info } : {}),
          ...scopeOf(it),
          how: "explicit",
        });
        return;
      }
      const c = chooseTake(words, it.text, { take: it.take, match });
      if (!c.ok) return void errors.push(`${label}: ${c.reason}`);
      const takeWords = words.slice(c.take.firstWord, c.take.lastWord + 1);
      // `take` explícito no blocks.json é decisão: a suspeita só é avisada, nunca troca a tomada.
      const col = collapse(label, c.interval, it.text, takeWords, it.take === undefined);
      const ws = col.picked ? col.picked.words : takeWords;
      const heard = heardIfDiffers(label, it.text, ws);
      out.push({
        interval: col.picked ? col.picked.interval : c.interval,
        text: it.text.trim(),
        ...(heard !== undefined ? { heard } : {}),
        words: ws,
        lastWordEnd: ws[ws.length - 1].end,
        holdLimit: round3(Math.min(opts.durationS, col.picked ? limitAfterTime(col.picked.interval.end) : limitAfter(c.take.lastWord + 1))),
        ...(col.info ? { collapsed: col.info } : {}),
        ...scopeOf(it),
        how: "take",
        take: c.takeNumber,
        completeTakes: c.completeTakes,
      });
    });
  }
  const cta = youtubeCtaSubscribeWarning((blocks.cta_yt ?? []).map((it) => it.heard ?? it.text));
  if (cta) warnings.push(cta);
  return { blocks, errors, warnings };
}

/** CTA do fim do horizontal desde o #12079 (decisão do editor, 03/11/2026). */
export const YOUTUBE_CTA_SUBSCRIBE_TEXT = "Se você ainda não é inscrito, se inscreve: sai um vídeo por dia útil.";

/**
 * Puro (#12079): o CTA do fim do horizontal pede inscrição, não like. O CTA é
 * o que o editor fala na gravação, então o roteiro (Gate 2) só avisa quando o
 * `cta_yt` não pede inscrição, para o editor regravar ou decidir manter.
 * `null` = sem `cta_yt` (entrevista, edição antiga) ou CTA que já pede inscrição.
 */
export function youtubeCtaSubscribeWarning(ctaTexts: readonly string[]): string | null {
  const text = ctaTexts.join(" ").trim();
  if (!text) return null;
  if (/\binscre(?:v|ver)|\binscri[çc]/i.test(text)) return null;
  const like = /\blike\b|\bcurt(?:e|ir|iu)\b/i.test(text);
  return (
    `cta_yt: o CTA do horizontal ${like ? "pede like" : "não pede inscrição"} ("${text}"); desde o #12079 ele pede inscrição ` +
    `("${YOUTUBE_CTA_SUBSCRIBE_TEXT}"). Regravar o CTA ou seguir com este por decisão do editor no Gate 2`
  );
}

export interface PlannedClip {
  block: BlockKey;
  /** No bruto, segundos. */
  srcIn: number;
  srcOut: number;
  /** No bruto, frames (a verdade do corte: XML e prévia usam estes). */
  frameIn: number;
  frameOut: number;
  /** Na sequência, frames. */
  seqStart: number;
  seqEnd: number;
  scale: number;
  /** Texto do roteiro que o clipe cobre (o do item, ou dos itens fundidos): a referência do refino das bordas (#11500). */
  script?: string;
  /** Clipe fundido de trechos de blocos DIFERENTES: o pedaço de cada bloco (a duração por bloco do roteiro sai daqui). */
  parts?: Array<{ block: BlockKey; srcIn: number; srcOut: number }>;
  /** O corte antes deste clipe tirou só uma pausa curta dentro do item: mantém a escala do anterior (#11753). */
  keepScale?: true;
}

/** Trecho do bruto antes de virar clipe (sem frames, sem posição na sequência, sem escala). */
export interface RawClip {
  block: BlockKey;
  srcIn: number;
  srcOut: number;
  script?: string;
  parts?: PlannedClip["parts"];
  keepScale?: true;
}

/** Segundos do clipe que são do bloco `key` (clipe fundido de blocos diferentes conta só o pedaço do bloco). */
export function clipSecondsOfBlock(c: Pick<PlannedClip, "block" | "frameIn" | "frameOut" | "parts">, key: BlockKey, fps: number): number {
  const a = c.frameIn / fps;
  const b = c.frameOut / fps;
  if (!c.parts?.length) return c.block === key ? b - a : 0;
  // Bordas do clipe fora dos pedaços (refino, respiro do fecho) contam para o pedaço vizinho.
  return c.parts.reduce((acc, p, i, all) => {
    if (p.block !== key) return acc;
    const lo = i === 0 ? a : Math.max(a, p.srcIn);
    const hi = i === all.length - 1 ? b : Math.min(b, all[i + 1].srcIn);
    return acc + Math.max(0, hi - lo);
  }, 0);
}

/** Ajuste de um corte, no tempo do bruto (#11500): vai para o `plan.json` e para o relato do `build`. */
export interface CutAdjustment {
  block: BlockKey;
  /** `in` = entrada do clipe, `out` = saída; `emenda` = dois clipes contíguos (ou sobrepostos) viraram um. */
  edge: "in" | "out" | "emenda";
  from: number;
  to: number;
  reason: string;
}

/**
 * Clipes da sequência a partir dos trechos do bruto, na ordem (#11503, #11500):
 *   1. trecho que começa colado no anterior (menos de 1 frame depois do fim
 *      dele) ou por cima dele (sobreposição: o áudio sairia repetido) se funde
 *      com o anterior num clipe só, que vai do começo do 1º ao fim mais tardio.
 *      Fala contínua no bruto nunca vira dois clipes;
 *   2. a escala alterna base/punch-in a cada clipe JÁ fundido, menos no clipe
 *      marcado `keepScale` (o corte antes dele tirou só uma pausa curta dentro
 *      do item, #11753), que fica com a escala do anterior.
 * Resultado, as duas regras do zoom (decisão do editor, 28/10/2026): todo corte
 * de pausa longa, de item ou de tomada muda o zoom, e nenhuma mudança de zoom
 * acontece sem corte. O corte de pausa curta (#11753) é o que o editor faz no
 * Premiere dentro do mesmo clipe, sem trocar a escala. Trecho que volta
 * no bruto (começa antes do começo do anterior) é corte de verdade, não funde.
 * Clipe fundido de dois blocos leva o nome do 1º e guarda o pedaço de cada um
 * em `parts` (`clipSecondsOfBlock`).
 */
export function assembleClips(
  spec: Pick<SequenceSpec, "scales">,
  raws: RawClip[],
  fps: number,
): { clips: PlannedClip[]; durationFrames: number; merges: CutAdjustment[] } {
  const merged: RawClip[] = [];
  const merges: CutAdjustment[] = [];
  const frame = 1 / fps;
  for (const r of raws) {
    if (!(r.srcOut > r.srcIn)) continue;
    const prev = merged[merged.length - 1];
    if (prev && r.srcIn >= prev.srcIn - 1e-9 && r.srcIn - prev.srcOut < frame - 1e-9) {
      merges.push({
        block: r.block,
        edge: "emenda",
        from: prev.srcOut,
        to: r.srcIn,
        reason: r.srcIn < prev.srcOut ? `sobreposição de ${Math.round((prev.srcOut - r.srcIn) * 1000)} ms fundida (áudio repetido)` : "contíguos no bruto: um clipe só, sem troca de zoom",
      });
      if (prev.parts || r.parts || r.block !== prev.block) {
        const own = (x: RawClip) => x.parts ?? [{ block: x.block, srcIn: x.srcIn, srcOut: x.srcOut }];
        prev.parts = [...own(prev), ...own(r)];
      }
      prev.srcOut = Math.max(prev.srcOut, r.srcOut);
      if (r.script) prev.script = prev.script ? `${prev.script} ${r.script}` : r.script;
      continue;
    }
    merged.push({ ...r });
  }
  const clips: PlannedClip[] = [];
  let t = 0;
  let zoom = 0;
  for (const r of merged) {
    const frameIn = Math.round(r.srcIn * fps);
    const frameOut = Math.round(r.srcOut * fps);
    if (frameOut <= frameIn) continue;
    if (clips.length > 0 && !r.keepScale) zoom++;
    const scale = spec.scales[zoom % 2];
    clips.push({
      block: r.block,
      srcIn: round3(r.srcIn),
      srcOut: round3(r.srcOut),
      frameIn,
      frameOut,
      seqStart: t,
      seqEnd: t + (frameOut - frameIn),
      scale,
      ...(r.script ? { script: r.script } : {}),
      ...(r.parts ? { parts: r.parts } : {}),
      ...(r.keepScale && clips.length > 0 ? { keepScale: true as const } : {}),
    });
    t += frameOut - frameIn;
  }
  return { clips, durationFrames: t, merges };
}

export interface SequencePlan {
  spec: SequenceSpec;
  clips: PlannedClip[];
  durationFrames: number;
  /** Texto do roteiro desta versão (os blocos na ordem), base da autorrevisão e das legendas. */
  script: string;
  /**
   * Blocos da ordem sem nenhum item no `blocks.json`. Bloco com itens que
   * `targets`/`skip` tiram todos desta versão não conta: foi decisão, não falta.
   */
  missingBlocks: BlockKey[];
  /** Itens que sumiram no corte (0 clipes) ou palavras que ficaram fora dos clipes. */
  dropped: string[];
  /** Emendas de clipes contíguos e, depois do refino por áudio, os ajustes de corte (#11500, #11503). */
  cutAdjustments?: CutAdjustment[];
}

/**
 * A palavra está no vídeo mesmo com o meio fora dos clipes (#11351): o Whisper
 * estica a palavra por cima da pausa seguinte ("medida" em 1035,2–1036,2 s com
 * silêncio em 1035,5–1036,8 s), o corte do silêncio passa no meio dela e o
 * áudio da palavra continua no clipe. Coberta = parte dela dentro de um clipe
 * E todo o resto dentro de silêncios detectados. Palavra sem nada dentro dos
 * clipes continua perdida.
 */
export function wordCoveredBySilence(w: Interval, parts: Interval[], silences: Interval[], tolS = 1e-6): boolean {
  const sorted = [...parts].sort((a, b) => a.start - b.start);
  if (!sorted.some((p) => Math.min(w.end, p.end) - Math.max(w.start, p.start) > tolS)) return false;
  // Pedaços da palavra fora dos clipes.
  const gaps: Interval[] = [];
  let cur = w.start;
  for (const p of sorted) {
    if (p.end <= cur || p.start >= w.end) continue;
    if (p.start > cur) gaps.push({ start: cur, end: Math.min(p.start, w.end) });
    cur = Math.max(cur, p.end);
  }
  if (cur < w.end) gaps.push({ start: cur, end: w.end });
  return gaps.every((g) => g.end - g.start <= tolS || silences.some((s) => s.start <= g.start + tolS && s.end >= g.end - tolS));
}

/**
 * Clipes de uma sequência: cada item do bloco vira os trechos de fala dele
 * (`speechParts`); trechos contíguos no bruto (itens do roteiro escritos frase a
 * frase sobre uma fala contínua) se fundem e a escala alterna base/punch-in a
 * cada clipe fundido, ou seja, exatamente nos cortes (`assembleClips`, #11503),
 * menos no corte de pausa curta dentro do item (`shortPauseCuts`, #11753). No bloco de
 * fecho, o último trecho termina `FECHO_HOLD_S` depois da ÚLTIMA PALAVRA, preso
 * antes da palavra seguinte do bruto (`holdLimit`), e o descarte de clipe curto
 * vem depois desse respiro. Item que some no corte, ou palavra que fica de
 * fora, vai para `dropped` (palavra esticada sobre a pausa não conta, ver
 * `wordCoveredBySilence`). Item com `targets`/`skip` que exclui esta versão
 * fica de fora dela (#11377); o respiro do fecho vai no último item que entra.
 */
export function buildSequencePlan(
  spec: SequenceSpec,
  resolved: Partial<Record<BlockKey, ResolvedItem[]>>,
  silences: Interval[],
  source: Pick<SourceInfo, "fps" | "durationS">,
  opts: { holdBlocks?: BlockKey[] } & SpeechOptions = {},
): SequencePlan {
  const hold = new Set<BlockKey>(opts.holdBlocks ?? ["fecho"]);
  const minClip = opts.minClipS ?? SPEECH_DEFAULTS.minClipS;
  const fps = source.fps;
  const raws: RawClip[] = [];
  const missingBlocks: BlockKey[] = [];
  const dropped: string[] = [];
  const scriptParts: string[] = [];
  const wordChecks: Array<{ label: string; words: Word[] }> = [];
  for (const key of spec.order) {
    const items = resolved[key];
    if (!items || items.length === 0) {
      missingBlocks.push(key);
      continue;
    }
    const holding = hold.has(key);
    // Só os itens desta versão (`targets`/`skip`, #11377); o rótulo guarda o índice do blocks.json.
    const mine = items.map((it, idx) => ({ it, idx })).filter(({ it }) => itemInTarget(it, spec));
    mine.forEach(({ it, idx }, n) => {
      scriptParts.push(it.text);
      // O descarte do clipe curto vem depois do respiro do fecho; o pedaço curto entre pausas curtas já volta ao vizinho aqui (#11753).
      const parts = speechParts(it.interval.start, it.interval.end, silences, { ...opts, minClipS: 0, fragmentS: opts.fragmentS ?? minClip });
      // Corte de pausa curta dentro do item não troca o zoom (#11753).
      const keep = shortPauseCuts(parts, opts);
      if (holding && n === mine.length - 1 && parts.length) {
        const lastPart = parts[parts.length - 1];
        const target = it.lastWordEnd !== null ? it.lastWordEnd + FECHO_HOLD_S : lastPart.end + FECHO_HOLD_S;
        const floor = it.lastWordEnd ?? lastPart.start;
        lastPart.end = round3(Math.max(floor, Math.min(it.holdLimit, source.durationS, target)));
      }
      // Pedaço curto na ponta do item, sem silêncio ali, fica: emenda no item vizinho (#11753). O do fecho é medido depois do respiro.
      const edge = parts.map((p, k) => !(holding && k === parts.length - 1) && touchesEdge(p, it.interval.start, it.interval.end));
      const kept = parts.map((p, k) => ({ ...p, keepScale: keep.has(k), edge: edge[k] })).filter((p) => p.end - p.start >= minClip - 1e-9 || p.edge);
      if (kept.length === 0) {
        dropped.push(`${key}[${idx}]: some no corte (fala abaixo de ${minClip} s depois de tirar os silêncios)`);
        return;
      }
      wordChecks.push({ label: `${key}[${idx}]`, words: trimWordsToSilences(it.words, silences) });
      for (const p of kept) raws.push({ block: key, srcIn: p.start, srcOut: p.end, script: it.text, ...(p.keepScale ? { keepScale: true as const } : {}) });
    });
  }
  // Contíguos no bruto viram um clipe só antes de alternar a escala (#11503).
  const { clips, durationFrames, merges } = assembleClips(spec, raws, fps);
  // Na emenda, o núcleo pode estar no clipe do item vizinho; validar a sequência mantida.
  const kept = clips.map((c) => ({ start: c.frameIn / fps, end: c.frameOut / fps }));
  for (const { label, words } of wordChecks) {
    const lost = words.filter((w) => !kept.some((p) => (w.start + w.end) / 2 >= p.start && (w.start + w.end) / 2 <= p.end) && !wordCoveredBySilence(w, kept, silences));
    if (lost.length) dropped.push(`${label}: palavra(s) fora dos clipes: "${lost.map((w) => w.text.trim()).join(" ")}"`);
  }
  return { spec, clips, durationFrames, script: scriptParts.join(" "), missingBlocks, dropped, cutAdjustments: merges };
}

// ── Enquadramento ─────────────────────────────────────────────────────────

/** Olhos a ~40% da altura do quadro (#11208). */
export const EYE_LINE_FRACTION = 0.4;

export interface FramingResult {
  /** Recorte no bruto (px, já desespelhado); `w`/`h` pares para o ffmpeg, na proporção da sequência. */
  crop: { x: number; y: number; w: number; h: number };
  /**
   * Center do Basic Motion do xmeml: deslocamento do centro do clipe em
   * relação ao centro da sequência (px da sequência), dividido pela
   * largura/altura do BRUTO (positivo = direita/baixo). O Premiere lê o
   * Center como fração da mídia original, sem escala: unidade validada no
   * import da 261104 (#12091), quando `0.1225` num bruto 3840 virou 470,4 px
   * de Position; o valor corrigido está pendente de re-import. Até o #12091
   * o divisor era a sequência e o rosto saía à direita.
   */
  center: { horiz: number; vert: number };
  /** Escala efetiva (%): a pedida, ou maior quando o bruto é pequeno demais para ela (ex.: 1080p). */
  scalePct: number;
  /**
   * Só com `framing.mug` (#11939): quanto da caneca o recorte mostra.
   * `inteira` = a caixa cabe; `parcial` = parte dela (deslocamento no limite);
   * `fora` = nem no limite ela aparece, o recorte fica centrado no rosto.
   */
  mug?: "inteira" | "parcial" | "fora";
  /** Deslocamento do recorte em relação ao centrado no rosto, em fração da largura do bruto (+ = direita). */
  mugShift?: number;
  /** `[aviso]` para o relato quando a caneca não sai inteira; nunca aborta o build. */
  warning?: string;
}

/**
 * Quanto o recorte pode sair do centro do rosto para mostrar a caneca, em
 * fração da largura do bruto (#11939): o editor aceitou 2% na 261103 (`faceX`
 * 0,48 → 0,50) e recusou 7% (0,55), que descentralizava o rosto.
 */
export const MUG_MAX_FACE_SHIFT = 0.02;

/**
 * Posição horizontal do recorte com a caneca como esforço (#11939). Ordem:
 * (1) o menor deslocamento que deixa a caixa inteira, se não passa do limite;
 * (2) senão, o deslocamento no limite em direção à caneca, se assim ela
 * aparece em parte (o meio-termo da 261103); (3) senão, o recorte centrado no
 * rosto. Arredonda sempre em direção ao rosto, para nunca passar do limite.
 */
function mugCropX(a: { faceCropX: number; w: number; y: number; h: number; srcW: number; srcH: number; mug: MugBox }): { x: number; mug: "inteira" | "parcial" | "fora" } {
  const { faceCropX, w, y, h, srcW, srcH, mug } = a;
  const maxX = srcW - w;
  const limit = MUG_MAX_FACE_SHIFT * srcW;
  const mL = mug.left * srcW;
  const mR = mug.right * srcW;
  const mT = mug.top * srcH;
  const mB = mug.bottom * srcH;
  const vFull = mT >= y && mB <= y + h;
  const vAny = mT < y + h && mB > y;
  const towardFace = (x: number) => (x > faceCropX ? Math.floor(x) : x < faceCropX ? Math.ceil(x) : Math.round(x));
  const centered = { x: Math.round(faceCropX), mug: "fora" as const };
  if (!vAny) return centered;
  const lo = Math.max(0, mR - w);
  const hi = Math.min(maxX, mL);
  if (lo <= hi) {
    const x = clamp(faceCropX, lo, hi);
    if (Math.abs(x - faceCropX) <= limit + 1e-9) {
      const xi = towardFace(x);
      // O arredondamento em direção ao rosto pode deixar 1 px da caixa fora: conta como inteira.
      return { x: xi, mug: vFull ? "inteira" : "parcial" };
    }
  }
  const dir = (mL + mR) / 2 >= faceCropX + w / 2 ? 1 : -1;
  const x = clamp(faceCropX + dir * limit, 0, maxX);
  const xi = towardFace(x);
  if (mL < xi + w && mR > xi) return { x: xi, mug: "parcial" };
  return centered;
}

const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Recorte e posição de um clipe com escala `scalePct` (100 = 1 px do bruto por
 * px da sequência, como no Premiere): o rosto (`faceX`) no centro horizontal,
 * a linha dos olhos (`eyeY`) a `eyeFraction` da altura, sem sair do bruto (o
 * recorte encosta na borda em vez de mostrar faixa preta). O recorte mantém
 * SEMPRE a proporção da sequência: se o bruto não cobre o quadro na escala
 * pedida (bruto 1080p numa vertical a 115%), a escala sobe até cobrir.
 */
export function framingFor(input: {
  srcW: number;
  srcH: number;
  seqW: number;
  seqH: number;
  scalePct: number;
  framing: Framing;
  eyeFraction?: number;
}): FramingResult {
  let s = input.scalePct / 100;
  if (!(s > 0)) throw new Error(`escala inválida: ${input.scalePct}`);
  const eyeFrac = input.eyeFraction ?? EYE_LINE_FRACTION;
  let wf = input.seqW / s;
  let hf = input.seqH / s;
  const fit = Math.min(1, input.srcW / wf, input.srcH / hf);
  if (fit < 1) {
    wf *= fit;
    hf *= fit;
    s /= fit;
  }
  const w = Math.min(input.srcW - (input.srcW % 2), even(wf));
  const h = Math.min(input.srcH - (input.srcH % 2), even(hf));
  const faceCropX = clamp(input.framing.faceX * input.srcW - w / 2, 0, input.srcW - w);
  const y = Math.round(clamp(input.framing.eyeY * input.srcH - eyeFrac * h, 0, input.srcH - h));
  const mugBox = input.framing.mug;
  const withMug = mugBox ? mugCropX({ faceCropX, w, y, h, srcW: input.srcW, srcH: input.srcH, mug: mugBox }) : null;
  const x = withMug ? withMug.x : Math.round(faceCropX);
  const dx = (input.srcW / 2 - (x + w / 2)) * s;
  const dy = (input.srcH / 2 - (y + h / 2)) * s;
  const r4 = (v: number) => Math.round(v * 10000) / 10000 || 0;
  const base: FramingResult = { crop: { x, y, w, h }, center: { horiz: r4(dx / input.srcW), vert: r4(dy / input.srcH) }, scalePct: Math.round(s * 10000) / 100 };
  if (!withMug) return base;
  const mugShift = r4((x - Math.round(faceCropX)) / input.srcW);
  const pct = (v: number) => `${(Math.abs(v) * 100).toFixed(1).replace(".", ",")}%`;
  const warning = withMug.mug === "inteira" ? undefined
    : withMug.mug === "parcial" ? `caneca só em parte no recorte (deslocamento de ${pct(mugShift)} da largura do bruto, limite ${pct(MUG_MAX_FACE_SHIFT)}; rosto prioritário)`
    : `caneca fora do recorte: mostrá-la exigiria descentralizar o rosto mais que ${pct(MUG_MAX_FACE_SHIFT)} da largura do bruto; recorte centrado no rosto`;
  return { ...base, mug: withMug.mug, mugShift, ...(warning ? { warning } : {}) };
}

/**
 * Um `[aviso]` por sequência e escala em que a caneca não sai inteira
 * (#11939), para o relato do `build`, da prévia e da `review`. Sem
 * `framing.mug`, uma linha só dizendo que a caneca não foi conferida.
 */
export function mugFramingWarnings(
  plans: ReadonlyArray<{ spec: { name: string; width: number; height: number }; clips: ReadonlyArray<{ scale: number }> }>,
  source: { width: number; height: number },
  framing: Framing,
): string[] {
  if (!framing.mug) return ["framing sem mug: a caneca não entrou no cálculo do recorte (ler a caixa dela no frame e gravar framing.mug)"];
  const out: string[] = [];
  for (const p of plans) {
    for (const scalePct of [...new Set(p.clips.map((c) => c.scale))].sort((a, b) => a - b)) {
      const fr = framingFor({ srcW: source.width, srcH: source.height, seqW: p.spec.width, seqH: p.spec.height, scalePct, framing });
      if (fr.warning) out.push(`${p.spec.name} (${scalePct}%): ${fr.warning}`);
    }
  }
  return out;
}

/** Escalas que o `frame` desenha (#11939): as do horizontal e as das verticais. */
export const FRAME_PREVIEW_CROPS: ReadonlyArray<{ seqW: number; seqH: number; scales: readonly number[]; color: string }> = [
  { seqW: 1920, seqH: 1080, scales: [50, 62], color: "yellow" },
  { seqW: 1080, seqH: 1920, scales: [115, 130], color: "cyan" },
];

/**
 * Filtros `drawbox` do `frame` (#11939): o recorte de cada escala desenhado
 * no bruto (já desespelhado), para conferir rosto e caneca de uma vez, e a
 * caixa da caneca em magenta quando o `framing` a traz. Cada linha de aviso
 * vem com a escala.
 */
export function frameCropOverlays(source: { width: number; height: number }, framing: Framing): { filters: string[]; warnings: string[] } {
  const filters: string[] = [];
  const warnings: string[] = [];
  for (const { seqW, seqH, scales, color } of FRAME_PREVIEW_CROPS) {
    for (const scalePct of scales) {
      const fr = framingFor({ srcW: source.width, srcH: source.height, seqW, seqH, scalePct, framing });
      const { x, y, w, h } = fr.crop;
      filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}@0.8:t=4`);
      if (fr.warning) warnings.push(`${seqW}x${seqH} ${scalePct}%: ${fr.warning}`);
    }
  }
  const m = framing.mug;
  if (m) {
    const x = Math.round(m.left * source.width);
    const y = Math.round(m.top * source.height);
    filters.push(`drawbox=x=${x}:y=${y}:w=${Math.round(m.right * source.width) - x}:h=${Math.round(m.bottom * source.height) - y}:color=magenta@0.9:t=3`);
  }
  return { filters, warnings };
}

// ── XML FCP7 (xmeml v4) ───────────────────────────────────────────────────

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** `file://localhost/G:/Meu%20Drive/...` (o formato que o Premiere importou na 261027). */
export function pathUrl(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  return "file://localhost/" + p.split("/").map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":")).join("/");
}

function baseName(path: string): string {
  const p = path.replace(/\\/g, "/");
  return p.slice(p.lastIndexOf("/") + 1);
}

function motionFilter(scale: number, center: { horiz: number; vert: number }): string {
  return (
    `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>\n` +
    `<parameter><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>${scale}</value></parameter>\n` +
    `<parameter><parameterid>center</parameterid><name>Center</name><value><horiz>${center.horiz}</horiz><vert>${center.vert}</vert></value></parameter></effect></filter>`
  );
}

// ── Ganho de áudio (#11755) ───────────────────────────────────────────────

/** Alvo da fala no XML: o mesmo do `review-final` (-14 LUFS ±1). */
export const AUDIO_GAIN_TARGET_LUFS = -14;
/** Teto do true peak depois do ganho. */
export const AUDIO_GAIN_TP_CEILING_DBTP = -1;
/** `valuemax` do Audio Levels do FCP7 (3.98109 linear = +12 dB). */
export const AUDIO_LEVELS_MAX_DB = 12;

export interface AudioGain {
  /** Ganho em dB (negativo = baixa). */
  db: number;
  /** O mesmo ganho em amplitude linear, o valor que o Audio Levels do FCP7 grava (1 = 0 dB). */
  linear: number;
  /** O que limitou o ganho: o alvo de loudness, o teto de true peak ou o máximo do Audio Levels. */
  limitedBy: "target" | "true-peak" | "max";
}

/**
 * Ganho único de todos os clipes de áudio (#11755): leva o loudness integrado
 * do bruto (`loudness.json`) a `AUDIO_GAIN_TARGET_LUFS` sem passar o true peak
 * de `AUDIO_GAIN_TP_CEILING_DBTP`. Bruto de 261028 (-9,87 LUFS, TP +0,68):
 * -4,13 dB. Sem medida, sem ganho (null). Sem true peak medido, só atenua: sem
 * o pico não dá para saber se um ganho positivo clipa. O loudness é do bruto
 * inteiro (com pausas e tomadas descartadas), não da fala montada: o limiter,
 * se o editor usar, continua no Premiere.
 */
export function audioGainFor(m: LoudnessMeasure | null): AudioGain | null {
  if (!m || !Number.isFinite(m.inputI)) return null;
  let db = AUDIO_GAIN_TARGET_LUFS - m.inputI;
  let limitedBy: AudioGain["limitedBy"] = "target";
  if (Number.isFinite(m.inputTp)) {
    const tpCap = AUDIO_GAIN_TP_CEILING_DBTP - m.inputTp;
    if (tpCap < db) {
      db = tpCap;
      limitedBy = "true-peak";
    }
  } else if (db > 0) return null;
  if (db > AUDIO_LEVELS_MAX_DB) {
    db = AUDIO_LEVELS_MAX_DB;
    limitedBy = "max";
  }
  db = Math.round(db * 100) / 100 || 0;
  return { db, linear: Math.round(10 ** (db / 20) * 1e6) / 1e6, limitedBy };
}

function audioLevelsFilter(linear: number): string {
  return (
    `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>\n` +
    `<parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>${linear}</value></parameter></effect></filter>\n`
  );
}

// ── Título na vertical (#11756) ───────────────────────────────────────────

/** Sequência vertical (mais alta que larga): onde vai o título em texto. */
export function isVerticalSpec(spec: Pick<SequenceSpec, "width" | "height">): boolean {
  return spec.height > spec.width;
}

/**
 * Estilo do título: serifada, branca, negrito, centrada no topo (o lettering
 * das verticais 261028-261030), sobre um fundo preto a 70% (#11941).
 *
 * Medidas em pixel de uma vertical de `refWidth` (1080) de largura; outra
 * largura escala junto (`screenTitleLayout`). `fontPx` é o tamanho que a letra
 * deve TER na tela, não o número que vai no XML: ver `xmlSizeRefWidth`.
 */
export const SCREEN_TITLE_STYLE = {
  font: "Georgia",
  refWidth: 1080,
  /** Altura da letra na tela, numa vertical de 1080 px (#11941: 80 no XML passou da largura no import da 261103). */
  fontPx: 64,
  /**
   * `[premissa]` #11941: o `fontsize` do gerador "Text" do FCP7 não é pixel da
   * sequência. Premissa sem medição (não há Premiere neste executor): o
   * Premiere lê o tamanho como o de um quadro de referência de 720 px de
   * largura (o SD do FCP7, onde o tamanho 36 padrão do gerador foi desenhado)
   * e escala pela largura da sequência. Com ela, 80 virava 120 px numa
   * vertical de 1080, e 20 caracteres de Georgia negrito (~1440 px) passavam
   * da largura, como o editor viu. O XML leva `fontPx * xmlSizeRefWidth / largura`.
   * Se o 1º import mostrar outro fator, é só esta constante.
   */
  xmlSizeRefWidth: 720,
  /** Largura média de um caractere de Georgia negrito, em em (estimativa para quebrar linha e medir o fundo). */
  avgCharEm: 0.6,
  /** Máximo de caracteres por linha: 22 x 0,6 x 64 = 845 px, dentro dos 1080 menos margem e respiro do fundo. */
  maxLineChars: 22,
  /** Entrelinha, em múltiplos do tamanho da letra. */
  lineHeightEm: 1.2,
  /** Centro do bloco de texto: fração da altura a partir do centro (negativo = acima); -0,35 = 15% do topo. */
  originVert: -0.35,
  /** Margem mínima entre o fundo e a borda lateral do quadro, em px de 1080. */
  marginPx: 54,
  /** Respiro do fundo em volta do texto, em px de 1080. */
  padXPx: 40,
  padYPx: 28,
  /** Opacidade do fundo preto, em % (pedido do editor, #11941). */
  backgroundOpacityPct: 70,
  /**
   * `[premissa]` separador de linha DENTRO do texto do gerador (só no
   * `--title-mode text`, #12091). O `&#13;` abriu uma caixa por linha no
   * Premiere (261103, #11941) e o `&#10;` apareceu literal na tela, numa
   * linha só (261104, #12091): o Premiere não decodifica referência de
   * caractere no `str`. Agora vai o CR literal, sem entidade (um parser XML
   * conforme o normaliza para LF). Conferir num import real antes de tirar o
   * gerador de trás da flag.
   */
  xmlLineBreak: "\r",
} as const;

/** Geometria do título numa sequência (#11941): tamanho da letra, linhas e a caixa do fundo, em px da sequência. */
export interface ScreenTitleLayout {
  lines: string[];
  fontPx: number;
  lineH: number;
  /** Centro vertical do bloco de texto. */
  centerY: number;
  /** Caixa do fundo preto (x/y = canto superior esquerdo). */
  box: { x: number; y: number; w: number; h: number };
  /** Valor do `fontsize` do gerador "Text" no XML (ver `SCREEN_TITLE_STYLE.xmlSizeRefWidth`). */
  xmlFontSize: number;
}

export function screenTitleLayout(text: string, width: number, height: number): ScreenTitleLayout {
  const st = SCREEN_TITLE_STYLE;
  const k = width / st.refWidth;
  const lines = wrapScreenTitle(text);
  const fontPx = st.fontPx * k;
  const lineH = fontPx * st.lineHeightEm;
  const centerY = height / 2 + st.originVert * height;
  const longest = Math.max(0, ...lines.map((l) => l.length));
  const maxW = width - 2 * st.marginPx * k;
  const w = Math.min(longest * st.avgCharEm * fontPx + 2 * st.padXPx * k, maxW);
  const h = lines.length * lineH + 2 * st.padYPx * k;
  const box = { x: Math.round((width - w) / 2), y: Math.round(centerY - h / 2), w: Math.round(w), h: Math.round(h) };
  return { lines, fontPx, lineH, centerY, box, xmlFontSize: Math.round((fontPx * st.xmlSizeRefWidth) / width) };
}

/** Quebra o título em linhas de até `maxChars` (palavra maior que isso fica inteira na linha). */
export function wrapScreenTitle(text: string, maxChars: number = SCREEN_TITLE_STYLE.maxLineChars): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > maxChars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Trecho da sequência que leva o título, em frames: os clipes do bloco
 * `titulo`; sem ele (gravação sem bloco de título, 261029), os clipes do 1º
 * bloco da sequência (o gancho). Sequência vazia = null.
 */
export function screenTitleSpan(plan: Pick<SequencePlan, "clips">): { start: number; end: number; block: BlockKey } | null {
  if (plan.clips.length === 0) return null;
  const block: BlockKey = plan.clips.some((c) => c.block === "titulo") ? "titulo" : plan.clips[0].block;
  const mine = plan.clips.filter((c) => c.block === block);
  return { start: Math.min(...mine.map((c) => c.seqStart)), end: Math.max(...mine.map((c) => c.seqEnd)), block };
}

/** A 1ª vertical que leva título: o tamanho do PNG do fallback e quem define o `<file>` dele no XML. */
export function firstTitledVertical(plans: SequencePlan[]): SequencePlan | null {
  return plans.find((p) => isVerticalSpec(p.spec) && (screenTitleSpan(p)?.end ?? 0) > (screenTitleSpan(p)?.start ?? 0)) ?? null;
}

/**
 * Título nas verticais (#11756). `png` (padrão desde o #12091; pendente de
 * conferência no 1º import com o PNG via XML: na 261104 o PNG foi arrastado
 * à mão) = o PNG transparente do tamanho da sequência (`pngPath`,
 * já no caminho que o Premiere vai abrir) como clipe na V2, com o fundo a 70%
 * desenhado só na caixa; `text` (só com `--title-mode text`, não validado) =
 * gerador de texto do FCP7 (`generatoritem` "Text") na V3 sobre o fundo
 * Color+Crop na V2 (#11941), que no import da 261104 saiu com `&#10;` na tela
 * e o fundo como bloco preto.
 */
export type ScreenTitleXml = { text: string; mode: "text" } | { text: string; mode: "png"; pngPath: string };

const xmlParam = (pid: string, name: string, body: string) => `<parameter><parameterid>${pid}</parameterid><name>${name}</name>${body}</parameter>\n`;

/** Valor de 0 a 100 com 2 casas (Crop/Opacity do FCP7 são em %). */
const pct = (v: number) => String(Math.round(Math.min(100, Math.max(0, v)) * 100) / 100);

/**
 * Fundo do título (#11941): gerador "Color" do FCP7 (matte preto) recortado
 * pelo filtro Crop na caixa de `screenTitleLayout` e com Opacity a 70%. Fica
 * na faixa logo abaixo do texto (V2 = fundo, V3 = texto). Crop e Opacity são
 * filtros de movimento do FCP7 em %, os que o import de XML do Premiere lê
 * junto com o Basic Motion (premissa, conferir no 1º import).
 */
function backgroundGenerator(id: string, layout: ScreenTitleLayout, width: number, height: number, len: number, start: number, rate: string): string {
  const { box } = layout;
  const crop = (pid: string, v: number) => xmlParam(pid, pid, `<valuemin>0</valuemin><valuemax>100</valuemax><value>${pct(v)}</value>`);
  return (
    `<generatoritem id="${id}"><name>titulo-fundo</name><enabled>TRUE</enabled><duration>${len}</duration>\n` +
    `${rate}<start>${start}</start><end>${start + len}</end><in>0</in><out>${len}</out><anamorphic>FALSE</anamorphic><alphatype>none</alphatype>\n` +
    `<effect><name>Color</name><effectid>Color</effectid><effectcategory>Matte</effectcategory><effecttype>generator</effecttype><mediatype>video</mediatype>\n` +
    xmlParam("fillcolor", "Color", `<value><alpha>255</alpha><red>0</red><green>0</green><blue>0</blue></value>`) +
    `</effect>\n` +
    `<filter><effect><name>Crop</name><effectid>crop</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>\n` +
    crop("left", (box.x / width) * 100) +
    crop("right", ((width - box.x - box.w) / width) * 100) +
    crop("top", (box.y / height) * 100) +
    crop("bottom", ((height - box.y - box.h) / height) * 100) +
    `</effect></filter>\n` +
    `<filter><effect><name>Opacity</name><effectid>opacity</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>\n` +
    xmlParam("opacity", "opacity", `<valuemin>0</valuemin><valuemax>100</valuemax><value>${SCREEN_TITLE_STYLE.backgroundOpacityPct}</value>`) +
    `</effect></filter></generatoritem>`
  );
}

/**
 * O título num gerador "Text" só (#11941): o texto inteiro num `str`, com as
 * linhas separadas por `xmlLineBreak` (uma caixa, não uma por linha), e o
 * `fontsize` convertido de `fontPx` pela premissa de `xmlSizeRefWidth`.
 */
function textGenerator(id: string, layout: ScreenTitleLayout, len: number, start: number, rate: string): string {
  const st = SCREEN_TITLE_STYLE;
  const p = xmlParam;
  return (
    `<generatoritem id="${id}"><name>titulo-tela</name><enabled>TRUE</enabled><duration>${len}</duration>\n` +
    `${rate}<start>${start}</start><end>${start + len}</end><in>0</in><out>${len}</out><anamorphic>FALSE</anamorphic><alphatype>black</alphatype>\n` +
    `<effect><name>Text</name><effectid>Text</effectid><effectcategory>Text</effectcategory><effecttype>generator</effecttype><mediatype>video</mediatype>\n` +
    p("str", "Text", `<value>${layout.lines.map(escapeXml).join(st.xmlLineBreak)}</value>`) +
    p("fontname", "Font", `<value>${st.font}</value>`) +
    p("fontsize", "Size", `<valuemin>0</valuemin><valuemax>1000</valuemax><value>${layout.xmlFontSize}</value>`) +
    p("fontstyle", "Style", `<valuemin>1</valuemin><valuemax>4</valuemax><value>2</value>`) +
    p("fontalign", "Alignment", `<valuemin>1</valuemin><valuemax>3</valuemax><value>2</value>`) +
    p("fontcolor", "Font Color", `<value><alpha>255</alpha><red>255</red><green>255</green><blue>255</blue></value>`) +
    p("origin", "Origin", `<value><horiz>0</horiz><vert>${st.originVert}</vert></value>`) +
    `</effect></generatoritem>`
  );
}

/**
 * SVG com o título (fallback PNG, #11756): mesmo estilo e mesma geometria do
 * gerador (`screenTitleLayout`), linhas centradas em torno de `originVert`,
 * sobre o fundo preto a 70% (#11941). Fora da caixa o PNG é transparente (o
 * sharp grava com alfa). Fonte: Georgia, com fallback serif onde ela não
 * existe (o raster é por máquina).
 */
export function screenTitleSvg(text: string, width: number, height: number): string {
  const st = SCREEN_TITLE_STYLE;
  const { lines, fontPx, lineH, centerY, box } = screenTitleLayout(text, width, height);
  const firstBaseline = centerY - ((lines.length - 1) * lineH) / 2 + fontPx * 0.35;
  const tspans = lines.map((l, i) => `<text x="${width / 2}" y="${Math.round(firstBaseline + i * lineH)}">${escapeXml(l)}</text>`).join("\n  ");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
    `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#000000" fill-opacity="${st.backgroundOpacityPct / 100}"/>\n` +
    `<g font-family="${st.font}, 'DejaVu Serif', serif" font-size="${Math.round(fontPx)}" font-weight="700" fill="#FFFFFF" text-anchor="middle">\n  ${tspans}\n</g>\n</svg>\n`
  );
}

/**
 * XML FCP7 (xmeml v4) com uma sequência por plano, importável no Premiere
 * (estrutura da 261027, que importou). Um `<file>` só (o bruto), definido no
 * 1º clipe e referenciado nos outros; vídeo e áudio linkados clipe a clipe
 * (áudio com 1 `sourcetrack`: o Premiere importa os 2 canais, conferido no
 * import da 261027, #11358). Cada clipe leva a escala efetiva e o Center de
 * `framingFor` (o mesmo da prévia). O XML nunca leva o desespelhamento: o
 * Premiere ignora o filtro "Flop" do FCP7 no import (#11358), então o
 * Horizontal Flip é aplicado à mão.
 *
 * `audioGain` (#11755): o Audio Levels em cada clipe de áudio. `screenTitle`
 * (#11756): o título nas sequências verticais, no trecho de `screenTitleSpan`
 * (modo png, o padrão: o PNG com o fundo na V2, pendente de conferência no 1º
 * import com o PNG via XML, #12091; modo text, só por flag: V2 = fundo preto a 70%, V3 = texto, #11941).
 */
export function buildXmeml(
  plans: SequencePlan[],
  source: SourceInfo,
  framing: Framing,
  opts: {
    mediaPath?: string;
    audioGain?: AudioGain | null;
    screenTitle?: ScreenTitleXml | null;
    /** #11900: título próprio de cada corte (chave = `spec.corte`); `null` = corte sem título. Ausente = o `screenTitle` geral. */
    screenTitleByCorte?: Readonly<Record<string, ScreenTitleXml | null>>;
  } = {},
): string {
  // #11641: o caminho gravado no XML pode diferir do de leitura (bruto em cache local fora do Neo).
  const mediaPath = opts.mediaPath ?? source.path;
  const fps = source.fps;
  const total = Math.round(source.durationS * fps);
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  let defined = false;
  let cid = 0;
  const fileEl = () => {
    if (defined) return '<file id="file-1"/>';
    defined = true;
    return (
      `<file id="file-1"><name>${escapeXml(baseName(mediaPath))}</name><pathurl>${escapeXml(pathUrl(mediaPath))}</pathurl>\n` +
      `${rate}<duration>${total}</duration>\n` +
      `<media><video><samplecharacteristics><width>${source.width}</width><height>${source.height}</height></samplecharacteristics></video>\n` +
      `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>`
    );
  };
  const gain = opts.audioGain ? audioLevelsFilter(opts.audioGain.linear) : "";
  const usable = (t: ScreenTitleXml | null | undefined): ScreenTitleXml | null => (t && t.text.trim() ? t : null);
  const byCorte = opts.screenTitleByCorte ?? {};
  const titleOf = (spec: SequenceSpec): ScreenTitleXml | null =>
    spec.corte !== undefined && Object.prototype.hasOwnProperty.call(byCorte, spec.corte) ? usable(byCorte[spec.corte]) : usable(opts.screenTitle);
  // Um `<file>` por PNG: definido no 1º uso, referenciado depois (o geral e o de cada corte são arquivos diferentes).
  const pngFileIds = new Map<string, string>();
  const screenTitleTrack = (plan: SequencePlan, si: number): string => {
    const title = titleOf(plan.spec);
    if (!title || !isVerticalSpec(plan.spec)) return "";
    const span = screenTitleSpan(plan);
    if (!span || span.end <= span.start) return "";
    const len = span.end - span.start;
    const id = `titulo-${si + 1}`;
    if (title.mode === "text") {
      // #11941: V2 = fundo preto a 70%, V3 = o texto numa caixa só.
      const layout = screenTitleLayout(title.text, plan.spec.width, plan.spec.height);
      return (
        `\n<track>${backgroundGenerator(`titulo-fundo-${si + 1}`, layout, plan.spec.width, plan.spec.height, len, span.start, rate)}</track>` +
        `\n<track>${textGenerator(id, layout, len, span.start, rate)}</track>`
      );
    }
    // PNG (#11941): o fundo já vem desenhado no próprio PNG, num clipe só.
    // PNG parado: duração do arquivo longa (a do bruto), recortada pelo in/out do clipe.
    const known = pngFileIds.get(title.pngPath);
    const fileId = known ?? (pngFileIds.size === 0 ? "file-titulo" : `file-titulo-${pngFileIds.size + 1}`);
    const fileRef = known
      ? `<file id="${fileId}"/>`
      : `<file id="${fileId}"><name>${escapeXml(baseName(title.pngPath))}</name><pathurl>${escapeXml(pathUrl(title.pngPath))}</pathurl>\n${rate}<duration>${total}</duration>\n` +
        `<media><video><samplecharacteristics><width>${plan.spec.width}</width><height>${plan.spec.height}</height></samplecharacteristics></video></media></file>`;
    pngFileIds.set(title.pngPath, fileId);
    return (
      `\n<track><clipitem id="${id}"><name>titulo-tela</name><enabled>TRUE</enabled><duration>${total}</duration>\n` +
      `${rate}<start>${span.start}</start><end>${span.end}</end><in>0</in><out>${len}</out>\n${fileRef}</clipitem></track>`
    );
  };
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE xmeml>", '<xmeml version="4">'];
  plans.forEach((plan, si) => {
    const { spec } = plan;
    const v: string[] = [];
    const a: string[] = [];
    plan.clips.forEach((c, i) => {
      cid++;
      const fr = framingFor({ srcW: source.width, srcH: source.height, seqW: spec.width, seqH: spec.height, scalePct: c.scale, framing });
      const links =
        `<link><linkclipref>v${cid}</linkclipref><mediatype>video</mediatype></link>` +
        `<link><linkclipref>a${cid}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>${i + 1}</clipindex></link>`;
      const head =
        `<name>${escapeXml(c.block)}</name><enabled>TRUE</enabled><duration>${total}</duration>\n` +
        `${rate}<start>${c.seqStart}</start><end>${c.seqEnd}</end><in>${c.frameIn}</in><out>${c.frameOut}</out>\n`;
      v.push(`<clipitem id="v${cid}">${head}${fileEl()}${motionFilter(fr.scalePct, fr.center)}\n${links}</clipitem>`);
      a.push(
        `<clipitem id="a${cid}">${head}<file id="file-1"/><sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>\n${gain}${links}</clipitem>`,
      );
    });
    const titleTrack = screenTitleTrack(plan, si);
    out.push(
      `<sequence id="seq-${si + 1}-${escapeXml(sequenceKey(spec))}"><name>${escapeXml(spec.name)}</name><duration>${plan.durationFrames}</duration>\n` +
        `${rate}\n` +
        `<media><video><format><samplecharacteristics>${rate}<width>${spec.width}</width><height>${spec.height}</height><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>\n` +
        `<track>${v.join("\n")}</track>${titleTrack}</video>\n` +
        `<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format><track>${a.join("\n")}</track></audio></media></sequence>`,
    );
  });
  out.push("</xmeml>");
  return out.join("\n") + "\n";
}

// ── Legendas ──────────────────────────────────────────────────────────────

/**
 * Vocabulário sobre a lista de palavras, REGRA A REGRA: une as palavras (para
 * a regra pegar termos de 2+ palavras, "inteligência personalizada"), aplica e
 * redistribui pelas palavras que cada casamento tocou. Desde o #11506 a regra
 * pode mudar o número de palavras: o Whisper ouve "ChatGPT" como "chat EPT", e
 * N palavras viram 1 (do início da 1ª ao fim da última); 1 palavra que vira N
 * (ou N→M) divide o tempo do trecho pelo tamanho de cada palavra nova. Só a
 * regra que APAGARIA palavras (substituição vazia) é pulada, com aviso, sem
 * derrubar as outras: sem palavra não há onde pôr o tempo.
 */
export function applyVocabularyToWords(words: Word[], rules: VocabRule[], target?: SequenceTarget | SequenceRef, warn?: (msg: string) => void): Word[] {
  let cur = words.map((w) => ({ ...w, text: w.text.trim() }));
  for (const r of rules) {
    if (r.targets && (!target || !sequenceInList(r.targets, target))) continue;
    const next = applyRuleToWords(cur, r);
    if (next === null) {
      warn?.(`regra de vocabulário /${r.pattern}/ apagaria palavras; pulada`);
      continue;
    }
    cur = next;
  }
  return cur;
}

/** Expande `$1`, `$<nome>`, `$&`, `$$` da substituição para um casamento (a mesma sintaxe de `String.replace`). */
function expandReplacement(tpl: string, m: RegExpExecArray): string {
  return tpl.replace(/\$(\$|&|`|'|<([^>]*)>|(\d{1,2}))/g, (all, tok: string, name: string | undefined, num: string | undefined) => {
    if (tok === "$") return "$";
    if (tok === "&") return m[0];
    if (tok === "`") return m.input.slice(0, m.index);
    if (tok === "'") return m.input.slice(m.index + m[0].length);
    if (name !== undefined) return m.groups?.[name] ?? "";
    const n = Number(num);
    if (n >= 1 && n < m.length) return m[n] ?? "";
    // "$12" com 1 grupo só: "$1" + "2", como o String.replace.
    if (num && num.length === 2 && Number(num[0]) >= 1 && Number(num[0]) < m.length) return (m[Number(num[0])] ?? "") + num[1];
    return all;
  });
}

/**
 * Uma regra sobre as palavras (#11506). Cada casamento toca as palavras que
 * cobre (inteiras ou em parte); casamentos que tocam a mesma palavra formam um
 * trecho só. O texto novo do trecho é dividido por espaço: o mesmo número de
 * palavras guarda os tempos de cada uma; 1 palavra nova fica com o trecho
 * inteiro; outro número divide o trecho pelo tamanho. `null` = a regra apaga
 * todas as palavras de algum trecho. Sem casamento, devolve `words` como veio.
 */
function applyRuleToWords(words: Word[], r: VocabRule): Word[] | null {
  if (words.length === 0) return words;
  const starts: number[] = [];
  const ends: number[] = [];
  let pos = 0;
  for (const w of words) {
    starts.push(pos);
    pos += w.text.length;
    ends.push(pos);
    pos += 1; // o espaço que une
  }
  const joined = words.map((w) => w.text).join(" ");
  const flags = r.flags ?? "g";
  const re = new RegExp(r.pattern, flags.includes("g") ? flags : flags + "g");
  const matches: Array<{ start: number; end: number; repl: string }> = [];
  for (let m = re.exec(joined); m !== null; m = re.exec(joined)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    matches.push({ start: m.index, end: m.index + m[0].length, repl: expandReplacement(r.replacement, m) });
    if (!flags.includes("g")) break;
  }
  if (matches.length === 0) return words;
  // Palavras de cada casamento: da que contém o início (ou a anterior ao espaço
  // onde ele começa) à que contém o fim (ou a seguinte, se o casamento comeu o espaço).
  const spans: Array<{ first: number; last: number; ms: typeof matches }> = [];
  for (const m of matches) {
    let first = 0;
    while (first + 1 < words.length && starts[first + 1] <= m.start) first++;
    let last = first;
    while (last + 1 < words.length && starts[last + 1] < m.end) last++;
    if (m.end > ends[last] && last + 1 < words.length) last++;
    const prev = spans[spans.length - 1];
    if (prev && first <= prev.last) {
      prev.last = Math.max(prev.last, last);
      prev.ms.push(m);
    } else spans.push({ first, last, ms: [m] });
  }
  let changed = false;
  const out: Word[] = [];
  let i = 0;
  for (const sp of spans) {
    while (i < sp.first) out.push(words[i++]);
    const a = starts[sp.first];
    const b = ends[sp.last];
    let text = "";
    let p = a;
    for (const m of sp.ms) {
      text += joined.slice(p, m.start) + m.repl;
      p = m.end;
    }
    text += joined.slice(p, b);
    const original = joined.slice(a, b);
    const parts = text.split(" ").filter((t) => t !== "");
    if (parts.length === 0) return null;
    const span = words.slice(sp.first, sp.last + 1);
    if (text !== original) changed = true;
    if (parts.length === span.length) span.forEach((w, k) => out.push({ ...w, text: parts[k] }));
    else {
      const t0 = span[0].start;
      const t1 = span[span.length - 1].end;
      const total = parts.reduce((n, t) => n + t.length, 0);
      let acc = 0;
      for (const t of parts) {
        const s = t0 + ((t1 - t0) * acc) / total;
        acc += t.length;
        out.push({ start: round3(s), end: round3(t0 + ((t1 - t0) * acc) / total), text: t });
      }
    }
    i = sp.last + 1;
  }
  while (i < words.length) out.push(words[i++]);
  return changed ? out : words;
}

/**
 * O texto aprovado vence (#11208): cada palavra casada com o roteiro
 * (alinhamento LCS, com os aliases do vocabulário, "diária" ouvido =
 * "diar.ia.br") vira o token do roteiro, com a grafia, a maiúscula e a
 * pontuação dele. Corrige o Whisper fechando frase onde o roteiro tem vírgula
 * ("Personalizada. Recurso" → "Personalizada, recurso") sem regra genérica que
 * trocaria o adjetivo ("rotina diária" continua "diária"). Palavra sem par no
 * roteiro fica como o Whisper ouviu.
 */
export function alignPunctuationToScript(words: Word[], script: string, aliases: VocabAlias[] = []): Word[] {
  const raw = script.split(/\s+/).filter((t) => normalizeToken(t));
  // Número partido pelo Whisper ("GPT" "6" ".1") vira 1 palavra antes de casar com "GPT-6.1" (#11360).
  const merged = mergeSplitNumberTokens(words, raw);
  const pairs = alignTokens(merged.map((w) => normalizeToken(w.text)), raw.map(normalizeToken), makeMatcher(aliases));
  const out = merged.map((w) => ({ ...w, text: w.text.trim() }));
  for (const [i, j] of pairs) out[i].text = raw[j];
  return out;
}

/** Por que uma palavra ouvida sem par no roteiro saiu da legenda (#11960). */
export type DroppedHeardReason = "depois do fim" | "antes do roteiro" | "perto de corte" | "em silêncio";

export interface ForcedAlignment {
  /** As palavras da legenda: o texto do roteiro, com o tempo da fala ouvida. */
  words: Word[];
  /** Ouvidas sem par no roteiro que saíram (alucinação, cauda de tomada, fala depois do fim). */
  dropped: Array<{ word: Word; reason: DroppedHeardReason }>;
  /** Ouvidas sem par no roteiro que ficaram (em plena fala, longe de corte): conferir. */
  kept: Word[];
  /** Palavras do roteiro sem par na fala ouvida, com o tempo interpolado entre as vizinhas. */
  interpolated: string[];
  /** Trechos em que o roteiro e a fala ouvida divergem palavra a palavra ("um" × "o"): fica o roteiro, no tempo do ouvido. */
  substituted: Array<{ heard: string; script: string }>;
}

/** Tolerâncias do alinhamento forçado (#11960). */
export const FORCED_ALIGN_DEFAULTS = { cutTolS: 0.4, silenceGapS: 0.3, guessWordS: 0.25 } as const;

/** Divide `[a, b]` entre os tokens, pelo tamanho de cada um (o mesmo critério das regras do vocabulário). */
function spreadTokens(tokens: string[], a: number, b: number): Word[] {
  const end = Math.max(a, b);
  const total = tokens.reduce((n, t) => n + Math.max(1, t.length), 0);
  let acc = 0;
  return tokens.map((t) => {
    const s = a + ((end - a) * acc) / total;
    acc += Math.max(1, t.length);
    return { start: round3(s), end: round3(a + ((end - a) * acc) / total), text: t };
  });
}

/**
 * Alinhamento forçado do texto aprovado aos tempos da fala ouvida (#11960),
 * base da legenda: o roteiro vence também no que o Whisper inventou ou pulou.
 * Na 261103 a legenda saiu com "Tá," (cauda de "atrás" depois de um corte),
 * "E aí E aí" depois do fim, "ele" pulado e "o" no lugar de "um".
 *
 * Casamento LCS como em `alignPunctuationToScript` (aliases, número partido).
 * Entre dois pares casados:
 * - roteiro e ouvido sem par dos dois lados: o texto do roteiro, no tempo do trecho ouvido;
 * - só roteiro: tempo interpolado entre as vizinhas;
 * - só ouvido: sai se está antes da 1ª ou depois da última palavra casada,
 *   depois do fim da sequência, a até `cutTolS` de um corte, ou isolado por
 *   `silenceGapS` dos dois lados; em plena fala fica, em `kept`, para conferir.
 * Sem roteiro (texto vazio), devolve o ouvido como veio.
 */
export function forceAlignToScript(
  heard: Word[],
  script: string,
  opts: { aliases?: VocabAlias[]; cuts?: number[]; endS?: number; cutTolS?: number; silenceGapS?: number; guessWordS?: number } = {},
): ForcedAlignment {
  const raw = script.split(/\s+/).filter((t) => normalizeToken(t));
  const result: ForcedAlignment = { words: [], dropped: [], kept: [], interpolated: [], substituted: [] };
  const cutTol = opts.cutTolS ?? FORCED_ALIGN_DEFAULTS.cutTolS;
  const silenceGap = opts.silenceGapS ?? FORCED_ALIGN_DEFAULTS.silenceGapS;
  const guess = opts.guessWordS ?? FORCED_ALIGN_DEFAULTS.guessWordS;
  const cuts = opts.cuts ?? [];
  const endS = opts.endS ?? Infinity;
  let all = mergeSplitNumberTokens(heard, raw).map((w) => ({ ...w, text: w.text.trim() }));
  // Fala que começa no fim da sequência ou depois dele não está no vídeo.
  for (const w of all) if (w.start >= endS) result.dropped.push({ word: w, reason: "depois do fim" });
  all = all.filter((w) => w.start < endS);
  if (raw.length === 0) {
    result.words = all;
    return result;
  }
  const pairs = alignTokens(all.map((w) => normalizeToken(w.text)), raw.map(normalizeToken), makeMatcher(opts.aliases));
  const nearCut = (w: Word) => cuts.some((c) => Math.abs(w.start - c) <= cutTol || Math.abs(w.end - c) <= cutTol);
  const out = result.words;
  let pi = -1;
  let pj = -1;
  for (const [i, j] of [...pairs, [all.length, raw.length] as [number, number]]) {
    const gapH = all.slice(pi + 1, i);
    const gapS = raw.slice(pj + 1, j);
    const prev = out.length ? out[out.length - 1] : null;
    const next = i < all.length ? all[i] : null;
    const head = pi === -1 && i < all.length;
    const tail = i === all.length;
    if (gapS.length && gapH.length) {
      out.push(...spreadTokens(gapS, gapH[0].start, gapH[gapH.length - 1].end));
      result.substituted.push({ heard: joinWordTexts(gapH.map((w) => w.text)), script: joinWordTexts(gapS) });
    } else if (gapS.length) {
      const a = prev ? prev.end : next ? Math.max(0, next.start - guess * gapS.length) : 0;
      const b = next ? next.start : Math.min(endS, a + guess * gapS.length);
      out.push(...spreadTokens(gapS, a, b));
      result.interpolated.push(...gapS);
    } else {
      gapH.forEach((w, k) => {
        const before = k > 0 ? gapH[k - 1] : prev;
        const after = k + 1 < gapH.length ? gapH[k + 1] : next;
        const isolated = (!before || w.start - before.end >= silenceGap) && (!after || after.start - w.end >= silenceGap);
        const reason: DroppedHeardReason | null = tail && pairs.length ? "depois do fim" : head || !pairs.length ? "antes do roteiro" : nearCut(w) ? "perto de corte" : isolated ? "em silêncio" : null;
        if (reason) result.dropped.push({ word: w, reason });
        else {
          out.push(w);
          result.kept.push(w);
        }
      });
    }
    if (i < all.length) out.push({ ...all[i], text: raw[j] });
    pi = i;
    pj = j;
  }
  return result;
}

/** As linhas `[aviso]`/`[premissa]` do alinhamento forçado de uma sequência (#11960). */
export function forcedAlignmentNotes(seqName: string, a: ForcedAlignment): string[] {
  const fmt = (w: Word) => `"${w.text}" (${w.start.toFixed(2)} s)`;
  const notes: string[] = [];
  if (a.dropped.length) notes.push(`[aviso] ${seqName}: ${a.dropped.length} palavra(s) ouvida(s) fora do roteiro descartada(s) da legenda: ${a.dropped.map((d) => `${fmt(d.word)} ${d.reason}`).join("; ")}`);
  if (a.kept.length) notes.push(`[aviso] ${seqName}: ${a.kept.length} palavra(s) ouvida(s) fora do roteiro em plena fala ficaram na legenda (conferir): ${a.kept.map(fmt).join("; ")}`);
  if (a.interpolated.length) notes.push(`[premissa] ${seqName}: palavra(s) do roteiro sem par na fala ouvida entraram com tempo interpolado: ${a.interpolated.join(" ")}`);
  for (const s of a.substituted) notes.push(`[premissa] ${seqName}: ouvido "${s.heard}", legenda com o roteiro "${s.script}"`);
  return notes;
}

/** Quebra de cue (#11208): >50 caracteres, pontuação final, ou vírgula depois de 30. */
export const CUE_DEFAULTS = { maxChars: 50, commaMinChars: 30, wrapOver: 28, tailS: 0.3 } as const;

/**
 * Cues: fecha a cue ANTES da palavra que a faria passar de `maxChars`, e
 * depois de pontuação final ou de vírgula com mais de `commaMinChars`.
 */
export function segmentCues(words: Word[], opts: { maxChars?: number; commaMinChars?: number } = {}): Word[][] {
  const maxChars = opts.maxChars ?? CUE_DEFAULTS.maxChars;
  const commaMin = opts.commaMinChars ?? CUE_DEFAULTS.commaMinChars;
  const cues: Word[][] = [];
  let cur: Word[] = [];
  const textOf = (ws: Word[]) => joinWordTexts(ws.map((x) => x.text));
  for (const w of words) {
    if (cur.length && textOf([...cur, w]).length > maxChars) {
      cues.push(cur);
      cur = [];
    }
    cur.push(w);
    const text = textOf(cur);
    if (/[.?!]$/.test(text) || (text.endsWith(",") && text.length > commaMin)) {
      cues.push(cur);
      cur = [];
    }
  }
  if (cur.length) cues.push(cur);
  return cues;
}

/** Acima de `wrapOver` caracteres, 2 linhas, quebradas no espaço mais perto do meio. */
export function wrapCueText(text: string, wrapOver: number = CUE_DEFAULTS.wrapOver): string {
  if (text.length <= wrapOver) return text;
  const spaces = [...text].map((ch, k) => (ch === " " ? k : -1)).filter((k) => k >= 0);
  if (spaces.length === 0) return text;
  const mid = text.length / 2;
  const k = spaces.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
  return text.slice(0, k) + "\n" + text.slice(k + 1);
}

export function srtTimestamp(x: number): string {
  let ms = Math.max(0, Math.round(x * 1000));
  const h = Math.floor(ms / 3_600_000);
  ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000);
  ms -= m * 60_000;
  const s = Math.floor(ms / 1000);
  ms -= s * 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/** SRT: fim de cada cue = min(fim + 0,3 s, início da próxima); a última termina na última palavra. */
export function cuesToSrt(cues: Word[][], opts: { tailS?: number; wrapOver?: number } = {}): string {
  const tail = opts.tailS ?? CUE_DEFAULTS.tailS;
  return cues
    .map((c, i) => {
      const last = c[c.length - 1];
      const next = cues[i + 1];
      const end = next ? Math.min(last.end + tail, next[0].start) : last.end;
      const text = wrapCueText(joinWordTexts(c.map((w) => w.text)), opts.wrapOver);
      return `${i + 1}\n${srtTimestamp(c[0].start)} --> ${srtTimestamp(end)}\n${text}\n`;
    })
    .join("\n");
}

/**
 * Palavras do transcript do BRUTO remapeadas para o tempo da sequência (só as
 * que têm o meio dentro de um clipe). Caminho de fallback das legendas: o
 * padrão é retranscrever o áudio montado (`srt` sem `--from-raw`), que dá
 * tempos mais confiáveis (#11208).
 */
export function mapWordsToSequence(words: Word[], clips: PlannedClip[], fps: number): Word[] {
  const out: Word[] = [];
  for (const c of clips) {
    const t0 = c.seqStart / fps;
    const a = c.frameIn / fps;
    const z = c.frameOut / fps;
    for (const w of words) {
      const mid = (w.start + w.end) / 2;
      if (mid < a || mid > z) continue;
      out.push({ start: round3(t0 + Math.max(w.start, a) - a), end: round3(t0 + Math.min(w.end, z) - a), text: w.text.trim() });
    }
  }
  return out;
}

/** Trechos do bruto (s) que compõem a sequência, na ordem: para montar o áudio dela. */
export function sequenceSourceRanges(plan: SequencePlan, fps: number): Interval[] {
  return plan.clips.map((c) => ({ start: c.frameIn / fps, end: c.frameOut / fps }));
}

/** Instantes de corte na sequência (s), sem o 0 nem o fim. */
export function cutPoints(plan: SequencePlan, fps: number): number[] {
  return plan.clips.slice(1).map((c) => c.seqStart / fps);
}

// ── Autorrevisão da prévia ────────────────────────────────────────────────

export type ReviewKind = "tomada-duplicada" | "silaba-vazada" | "fala-extra" | "fala-faltando" | "final-seco";

export interface ReviewFinding {
  kind: ReviewKind;
  /** Instante na prévia (s). */
  at: number;
  detail: string;
  /** Instante no bruto (s), pelos clipes do plano (#11500): é onde se corrige. Ausente/null fora dos clipes. */
  srcAt?: number | null;
}

/** O fecho precisa de ao menos isso depois da última palavra (a 261027 saiu "seca"). */
export const MIN_TAIL_S = 0.3;

/**
 * Compara a transcrição da prévia com o roteiro da versão (alinhamento LCS,
 * com os aliases do vocabulário). As palavras da prévia sem par no roteiro
 * são agrupadas em trechos contíguos e classificadas:
 *   - `tomada-duplicada`: trecho de 2+ palavras igual às palavras logo antes
 *     ou logo depois dele na prévia;
 *   - `silaba-vazada`: 1 palavra só, a até `cutToleranceS` (0,4 s) de um
 *     corte, com ≤3 letras ou menos de 0,35 s de duração;
 *   - `fala-extra`: o resto.
 * Trecho do roteiro sem par na prévia = `fala-faltando` (marcado no fim da
 * última palavra casada antes dele). Menos de `minTailS` entre a última
 * palavra e o fim da prévia = `final-seco`.
 */
export function reviewPreview(input: {
  words: Word[];
  script: string;
  cuts: number[];
  durationS: number;
  minTailS?: number;
  cutToleranceS?: number;
  aliases?: VocabAlias[];
}): ReviewFinding[] {
  const tol = input.cutToleranceS ?? 0.4;
  // "GPT 6 .1" ouvido = "GPT-6.1" do roteiro, não fala-extra + fala-faltando (#11360).
  input = { ...input, words: mergeSplitNumberTokens(input.words, input.script.split(/\s+/)) };
  const W = input.words.map((w) => normalizeToken(w.text));
  const S = tokenize(input.script);
  const pairs = alignTokens(W, S, makeMatcher(input.aliases));
  const matchedW = new Set(pairs.map(([i]) => i));
  const findings: ReviewFinding[] = [];

  // Palavras a mais, em sequências contíguas.
  let i = 0;
  while (i < W.length) {
    if (matchedW.has(i) || !W[i]) {
      i++;
      continue;
    }
    let k = i;
    while (k + 1 < W.length && !matchedW.has(k + 1)) k++;
    const run = W.slice(i, k + 1).filter(Boolean);
    const words = input.words.slice(i, k + 1);
    const text = words.map((w) => w.text.trim()).join(" ");
    const before = W.slice(Math.max(0, i - run.length), i);
    const after = W.slice(k + 1, k + 1 + run.length);
    const same = (xs: string[]) => xs.length === run.length && xs.every((x, n) => tokensMatch(x, run[n]));
    const nearCut = input.cuts.some((c) => words.some((w) => w.end >= c - tol && w.start <= c + tol));
    const first = words[0];
    if (run.length >= 2 && (same(before) || same(after))) {
      findings.push({ kind: "tomada-duplicada", at: first.start, detail: `"${text}" repete o trecho ao lado` });
    } else if (run.length === 1 && nearCut && (run[0].length <= 3 || first.end - first.start < 0.35)) {
      findings.push({ kind: "silaba-vazada", at: first.start, detail: `"${text}" perto de um corte, fora do roteiro` });
    } else {
      findings.push({ kind: "fala-extra", at: first.start, detail: `"${text}" fora do roteiro` });
    }
    i = k + 1;
  }

  // Roteiro sem correspondência.
  const matchedS = new Set(pairs.map(([, j]) => j));
  let j = 0;
  while (j < S.length) {
    if (matchedS.has(j)) {
      j++;
      continue;
    }
    let k = j;
    while (k + 1 < S.length && !matchedS.has(k + 1)) k++;
    const prevPair = [...pairs].reverse().find(([, sj]) => sj < j);
    const at = prevPair ? input.words[prevPair[0]].end : 0;
    findings.push({ kind: "fala-faltando", at: round3(at), detail: `roteiro sem fala na prévia: "${S.slice(j, k + 1).join(" ")}"` });
    j = k + 1;
  }

  const lastWord = input.words[input.words.length - 1];
  const minTail = input.minTailS ?? MIN_TAIL_S;
  if (lastWord && input.durationS - lastWord.end < minTail) {
    findings.push({
      kind: "final-seco",
      at: lastWord.end,
      detail: `${(input.durationS - lastWord.end).toFixed(2)} s depois da última palavra (mínimo ${minTail} s)`,
    });
  }
  return findings.sort((x, y) => x.at - y.at);
}

// ── Loudness, fonte, prévia ───────────────────────────────────────────────

/** Abaixo disso o bruto chega baixo demais (261027: -31 LUFS; finais anteriores -21 a -23). */
export const LOUDNESS_WARN_LUFS = -24;
/** Acima disso o bruto chega quente demais (261028: -9,9 LUFS, pico em 0 dBFS), #11351. */
export const LOUDNESS_HOT_LUFS = -14;
/** True peak a partir disso = provável clipping no bruto (#11351). */
export const TRUE_PEAK_CLIP_DBTP = 0;
/** Alvo do `loudnorm` da prévia. */
export const LOUDNORM_TARGET = "loudnorm=I=-16:TP=-1.5:LRA=11";

export interface LoudnessMeasure {
  inputI: number;
  inputTp: number;
  inputLra: number;
}

/** Bloco JSON que o `loudnorm=print_format=json` imprime no stderr. */
export function parseLoudnormJson(stderr: string): LoudnessMeasure | null {
  const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, string>;
    const num = (k: string) => Number(j[k]);
    const r = { inputI: num("input_i"), inputTp: num("input_tp"), inputLra: num("input_lra") };
    return Number.isFinite(r.inputI) ? r : null;
  } catch {
    return null;
  }
}

export function loudnessWarning(m: LoudnessMeasure | null): string | null {
  if (!m) return "loudness do bruto não medido (o loudnorm não imprimiu o resumo)";
  if (m.inputI < LOUDNESS_WARN_LUFS) {
    return `bruto em ${m.inputI.toFixed(1)} LUFS, abaixo de ${LOUDNESS_WARN_LUFS} LUFS: normalizar no Premiere (a prévia já sai com loudnorm I=-16)`;
  }
  const hot = m.inputI > LOUDNESS_HOT_LUFS;
  const clip = Number.isFinite(m.inputTp) && m.inputTp >= TRUE_PEAK_CLIP_DBTP;
  if (hot || clip) {
    const why = [
      hot ? `${m.inputI.toFixed(1)} LUFS, acima de ${LOUDNESS_HOT_LUFS} LUFS` : null,
      clip ? `true peak ${m.inputTp.toFixed(1)} dBTP (≥ ${TRUE_PEAK_CLIP_DBTP}): provável clipping` : null,
    ].filter(Boolean);
    return `bruto quente: ${why.join("; ")}. Conferir o áudio no Premiere e baixar o ganho do microfone na próxima gravação (o silencedetect já usa limiar relativo ao loudness)`;
  }
  return null;
}

/**
 * O bruto na pasta da edição: o maior vídeo solto nela (fora de `Final/`), que
 * não seja um final (`final` no nome) nem uma prévia nossa. `candidates` traz
 * todos os que serviriam: com mais de um, o CLI avisa listando-os (o editor
 * pode ter gravado em 2 arquivos; `--source` escolhe outro). Sem nenhum vídeo,
 * o maior áudio solto (`audioOnly: true`, #11552).
 */
export function pickRawSource<T extends { name: string; size: number }>(files: T[]): { pick: T; candidates: T[]; audioOnly?: true } | null {
  const usable = (f: { name: string }) => !/(?<!\p{L})final(?!\p{L})/iu.test(f.name) && !/previa|prévia/i.test(f.name);
  const vids = files.filter((f) => /\.(mp4|mov)$/i.test(f.name) && usable(f));
  if (vids.length > 0) return { pick: vids.reduce((a, b) => (b.size > a.size ? b : a)), candidates: vids };
  // #11552: sem vídeo solto, um arquivo de áudio (os comentários gravados à parte).
  const audios = files.filter((f) => AUDIO_EXT.test(f.name) && usable(f));
  if (audios.length === 0) return null;
  return { pick: audios.reduce((a, b) => (b.size > a.size ? b : a)), candidates: audios, audioOnly: true };
}

/** Extensões de áudio aceitas como bruto quando não há vídeo solto (#11552). */
const AUDIO_EXT = /\.(m4a|mp3|wav|aac|ogg|opus|flac)$/i;

/** fps a partir do `r_frame_rate` do ffprobe ("30/1", "30000/1001"). */
export function parseFrameRate(r: string): number {
  const [n, d] = r.split("/").map(Number);
  const v = d ? n / d : n;
  if (!Number.isFinite(v) || v <= 0) throw new Error(`r_frame_rate inválido: ${r}`);
  return Math.round(v * 1000) / 1000;
}

/**
 * Saída do `ffprobe -show_streams -show_format -of json` → o que a montagem
 * usa. Rotação de metadado (vídeo de celular gravado "em pé") não é tratada:
 * o bruto da diar.ia.br é horizontal sem rotação (261027).
 */
export type CameraFacing = "front" | "back";
export type MirroredFrom = "camera-metadata" | "config" | "default";

/** Default do espelhamento sem metadado da câmera nem config: a premissa do #11208 (o bruto da 261027 era espelhado). */
export const MIRRORED_DEFAULT = true;

/** `publishing.video.mirrored_default` do `platform.config.json` (#11959); `null` = ausente ou não booleano. */
export function mirroredDefaultFrom(config: unknown): boolean | null {
  const v = (config as { publishing?: { video?: { mirrored_default?: unknown } } })?.publishing?.video?.mirrored_default;
  return typeof v === "boolean" ? v : null;
}

type ProbeTags = Record<string, unknown> | undefined;

/**
 * A câmera do bruto pelos metadados do ffprobe (#11959), quando o aparelho
 * grava: o iPhone põe `com.apple.quicktime.camera.lens_model` ("iPhone 15 Pro
 * back triple camera…", "… front camera …") e `…camera.identifier`
 * ("Back"/"Front"). Só tags com "camera"/"lens"/"facing" no nome contam;
 * nenhuma, ou as duas ao mesmo tempo, = `null` (sem leitura).
 */
export function cameraFacingFromTags(...tagSets: ProbeTags[]): CameraFacing | null {
  let front = false;
  let back = false;
  for (const tags of tagSets) {
    for (const [k, v] of Object.entries(tags ?? {})) {
      if (!/camera|lens|facing/i.test(k) || typeof v !== "string") continue;
      if (/\b(back|rear|traseira)\b/i.test(v)) back = true;
      if (/\b(front|frontal|selfie)\b/i.test(v)) front = true;
    }
  }
  return back === front ? null : back ? "back" : "front";
}

/**
 * O `mirrored` do `transcribe` (#11959): câmera traseira não espelha, então
 * `back` no metadado = false; câmera frontal e bruto sem metadado ficam com o
 * default do config (o espelhamento da frontal depende do aparelho), e sem
 * config com `MIRRORED_DEFAULT`.
 */
export function resolveMirrored(camera: CameraFacing | null, configDefault: boolean | null): { mirrored: boolean; mirroredFrom: MirroredFrom } {
  if (camera === "back") return { mirrored: false, mirroredFrom: "camera-metadata" };
  if (configDefault !== null) return { mirrored: configDefault, mirroredFrom: "config" };
  return { mirrored: MIRRORED_DEFAULT, mirroredFrom: "default" };
}

/** A premissa do espelhamento em uma linha, para o `transcribe` e o `frame` registrarem no Gate 1 (#11959). */
export function mirroredPremise(s: Pick<SourceInfo, "mirrored" | "mirroredFrom" | "camera">, override?: boolean): string {
  if (override !== undefined && override !== s.mirrored) return `mirrored=${override} pelo blocks.json (o transcribe tinha gravado ${s.mirrored})`;
  const how =
    s.mirroredFrom === "camera-metadata"
      ? "metadado da câmera: traseira, não espelha"
      : s.mirroredFrom === "config"
        ? `publishing.video.mirrored_default do config${s.camera === "front" ? " (câmera frontal no metadado: o espelho depende do aparelho)" : " (sem metadado da câmera)"}`
        : s.mirroredFrom === "default"
          ? "default do #11208, sem metadado da câmera nem config"
          : "source.json anterior ao #11959, origem não registrada";
  const ambiguous = s.mirroredFrom !== "camera-metadata";
  return `mirrored=${s.mirrored} (${how})${ambiguous ? ": premissa, conferir no frame lado a lado no Gate 1 (o lado em que a caneca lê certo diz o valor: bruto = false, espelhado = true; o \"mirrored\" do blocks.json sobrepõe)" : ""}`;
}

export function parseProbe(json: string, path: string, opts: { mirroredDefault?: boolean | null } = {}): SourceInfo {
  const j = JSON.parse(json) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string; disposition?: { attached_pic?: number }; tags?: Record<string, unknown> }>;
    format?: { duration?: string; tags?: Record<string, unknown> };
  };
  // Capa embutida num .m4a/.mp3 vem como stream de vídeo `attached_pic`: não é vídeo.
  const v = j.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const durationS = Number(j.format?.duration);
  if (!v && j.streams?.some((s) => s.codec_type === "audio")) {
    // #11552: bruto só de áudio. Segue no modo áudio (transcrição, decupagem, roteiro).
    if (!Number.isFinite(durationS) || durationS <= 0) throw new Error("ffprobe sem duração");
    return { path, fps: AUDIO_ONLY_FPS, durationS: round3(durationS), width: 0, height: 0, mirrored: false, audioOnly: true };
  }
  if (!v || !v.width || !v.height || !v.r_frame_rate) throw new Error("ffprobe sem stream de vídeo com largura/altura/fps");
  if (!Number.isFinite(durationS) || durationS <= 0) throw new Error("ffprobe sem duração");
  const fps = parseFrameRate(v.r_frame_rate);
  if (!Number.isInteger(fps)) {
    throw new Error(`fps ${fps} não inteiro: o XML usa timebase inteiro com NTSC=FALSE (premissa da 261027, 30 fps)`);
  }
  const camera = cameraFacingFromTags(j.format?.tags, ...(j.streams ?? []).map((st) => st.tags));
  const m = resolveMirrored(camera, opts.mirroredDefault ?? null);
  return { path, fps, durationS: round3(durationS), width: v.width, height: v.height, mirrored: m.mirrored, mirroredFrom: m.mirroredFrom, ...(camera ? { camera } : {}) };
}

/**
 * Argumentos do ffmpeg de UM clipe da prévia vertical: seek no bruto, flip se
 * espelhado, recorte do `framingFor`, 720x1280, fade de áudio de 20 ms na
 * entrada e 30 ms na saída (sem estalo no corte).
 */
export function previewClipArgs(input: {
  src: string;
  start: number;
  end: number;
  crop: FramingResult["crop"];
  mirrored: boolean;
  fps: number;
  out: string;
  width?: number;
  height?: number;
}): string[] {
  const d = input.end - input.start;
  if (!(d > 0)) throw new Error(`clipe vazio (${input.start}-${input.end})`);
  const { x, y, w, h } = input.crop;
  const vf = `${input.mirrored ? "hflip," : ""}crop=${w}:${h}:${x}:${y},scale=${input.width ?? 720}:${input.height ?? 1280},setsar=1,fps=${input.fps}`;
  const af = `afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, d - 0.03).toFixed(3)}:d=0.03`;
  return [
    "-y", "-v", "error",
    "-ss", input.start.toFixed(3), "-to", input.end.toFixed(3), "-i", input.src,
    "-vf", vf, "-af", af,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-ar", "48000", "-ac", "2",
    input.out,
  ];
}

/** Estilo da legenda queimada na prévia (o da 261027). */
export const PREVIEW_SUBTITLE_STYLE =
  "FontName=Arial,FontSize=10,PrimaryColour=&H00FFFFFF,BackColour=&H40201A10,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginV=100";
