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
 *     (`buildXmeml`), 3 sequências com áudio linkado e zoom alternado;
 *   - enquadramento (`framingFor`): crop da prévia e Center do Basic Motion a
 *     partir do centro do rosto, olhos a ~40% da altura;
 *   - legendas (`segmentCues`, `cuesToSrt`, vocabulário, pontuação do roteiro);
 *   - autorrevisão (`reviewPreview`): diff de palavras prévia × roteiro.
 */

import { videoTargetOf } from "./drive-video-source.ts";

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
}

/** Todas as palavras do transcript, em ordem. */
export function transcriptWords(t: Transcript): Word[] {
  return t.segments.flatMap((s) => s.words ?? []).filter((w) => w.text.trim() !== "");
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

// ── Silêncios e fala ──────────────────────────────────────────────────────

/** Parâmetros do `silencedetect` da 261027 (#11208). */
export const SILENCE_DETECT = { noiseDb: -45, minDurationS: 0.45 } as const;

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

/** Corte de silêncio da montagem (#11208): ≥0,8 s sai, 0,2 s de respiro, clipe <0,6 s descartado. */
export const SPEECH_DEFAULTS = { minGapS: 0.8, padS: 0.2, minClipS: 0.6 } as const;

/**
 * Trechos de fala dentro de `[a, b]`: remove os silêncios de `minGapS` ou mais,
 * mantendo `padS` de respiro de cada lado, e descarta trechos com menos de
 * `minClipS`. Nunca sai de `[a, b]`. Porta do `speech()` de `build_xml.py`.
 */
export function speechParts(
  a: number,
  b: number,
  silences: Interval[],
  opts: { minGapS?: number; padS?: number; minClipS?: number } = {},
): Interval[] {
  const minGap = opts.minGapS ?? SPEECH_DEFAULTS.minGapS;
  const pad = opts.padS ?? SPEECH_DEFAULTS.padS;
  const minClip = opts.minClipS ?? SPEECH_DEFAULTS.minClipS;
  if (!(b > a)) return [];
  const parts: Interval[] = [];
  let cur = a;
  for (const s of [...silences].sort((x, y) => x.start - y.start)) {
    if (s.end - s.start < minGap || s.end <= a || s.start >= b) continue;
    if (s.start + pad > cur) parts.push({ start: cur, end: Math.min(b, s.start + pad) });
    cur = Math.max(cur, s.end - pad);
  }
  if (cur < b) parts.push({ start: cur, end: b });
  return parts.filter((p) => p.end - p.start >= minClip - 1e-9).map((p) => ({ start: round3(p.start), end: round3(p.end) }));
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

// ── Tomadas ───────────────────────────────────────────────────────────────

/** Margens do corte de uma tomada (premissa #11208, medidas na 261027). */
export const TAKE_DEFAULTS = {
  /** Ar antes da 1ª palavra. */
  preRollS: 0.15,
  /** Ar depois da última palavra. */
  postRollS: 0.25,
  /** Distância mínima até a palavra vizinha (fora da tomada). */
  guardS: 0.05,
  /** Pausa maior que isso entre duas palavras encerra a tomada. */
  maxGapS: 2.5,
  /** Fração mínima das palavras da frase que a tomada precisa casar. */
  minRatio: 0.8,
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
 *   - 1 palavra inserida, 1 omitida ou 1 TROCADA (por tomada, cada);
 *   - palavra partida ou juntada ("GPT 5" × "GPT-5": tokens concatenados);
 *   - a última palavra da frase omitida (completa com todas menos a última,
 *     se ainda casar `minRatio` das palavras).
 * Encerra numa pausa maior que `maxGapS`, numa palavra que não casa, ou
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
  const restarts = (k: number, p: number) =>
    P.length > 1 && p > 0 && eq(W[k], P[0]) && !eq(W[k], P[p]) && k + 1 < W.length && eq(W[k + 1], P[1]);
  const takes: Take[] = [];
  for (let i = 0; i < W.length; i++) {
    let p: number;
    if (eq(W[i], P[0]) || (i + 1 < W.length && W[i] + W[i + 1] === P[0])) p = 0;
    else if (P.length > 2 && eq(W[i], P[1]) && !(i > 0 && eq(W[i - 1], P[0]))) p = 1;
    else continue;
    let k = i;
    let matched = 0;
    let last = i;
    let swaps = 0;
    let skips = 0;
    let inserts = 0;
    while (p < P.length && k < W.length) {
      if (k > i && words[k].start - words[k - 1].end > maxGap) break;
      if (k > i && restarts(k, p)) break;
      if (eq(W[k], P[p])) {
        matched++;
        last = k;
        p++;
        k++;
      } else if (k + 1 < W.length && W[k] + W[k + 1] === P[p]) {
        // "GPT 5" ouvido, "GPT-5" no roteiro
        matched++;
        last = k + 1;
        p++;
        k += 2;
      } else if (p + 1 < P.length && W[k] === P[p] + P[p + 1]) {
        matched += 2;
        last = k;
        p += 2;
        k++;
      } else if (skips < 1 && p + 1 < P.length && eq(W[k], P[p + 1])) {
        // palavra da frase engolida
        skips++;
        matched++;
        last = k;
        p += 2;
        k++;
      } else if (inserts < 1 && k > i && k + 1 < W.length && eq(W[k + 1], P[p])) {
        // palavra a mais no meio
        inserts++;
        k++;
      } else if (swaps < 1 && k > i && p + 1 < P.length && k + 1 < W.length && eq(W[k + 1], P[p + 1])) {
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
    text: words.slice(take.firstWord, take.lastWord + 1).map((w) => w.text.trim()).join(" "),
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
export function groupTakes(segments: Segment[], opts: { prefixTokens?: number } = {}): TakeGroup[] {
  const n = opts.prefixTokens ?? 3;
  const toks = segments.map((s) => tokenize(s.text));
  const groups: number[][] = [];
  for (let i = 0; i < segments.length; i++) {
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

/** mm:ss.d */
export function clockTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(1).padStart(4, "0")}`;
}

// ── Blocos e sequências ───────────────────────────────────────────────────

/** Blocos conhecidos do roteiro (#11208). Nenhuma versão leva "Por que isso importa?" (editor, 26/10/2026). */
export const BLOCK_KEYS = ["titulo", "abertura", "resumo", "resumo_curto", "comentario", "cta_yt", "cta_ig", "cta_out", "fecho"] as const;
export type BlockKey = (typeof BLOCK_KEYS)[number];

export function isBlockKey(k: string): k is BlockKey {
  return (BLOCK_KEYS as readonly string[]).includes(k);
}

/**
 * Item de um bloco: a FRASE (a tomada sai sozinha, a última completa; `take`
 * força outra) ou um INTERVALO explícito no bruto (com `text` opcional, o que
 * deveria estar sendo dito).
 */
export type BlockItem =
  | { text: string; take?: number; start?: undefined; end?: undefined }
  | { start: number; end: number; text?: string; take?: undefined };

export type SequenceTarget = "youtube" | "instagram" | "outras-redes";
export const SEQUENCE_TARGETS: readonly SequenceTarget[] = ["youtube", "instagram", "outras-redes"];

export interface SequenceSpec {
  target: SequenceTarget;
  /** Nome da sequência no Premiere = nome default do export (`videoTargetOf` reconhece o destino). */
  name: string;
  width: number;
  height: number;
  /** Blocos, na ordem. */
  order: BlockKey[];
  /** Escala (%) alternada entre os clipes: [base, punch-in]. */
  scales: [number, number];
}

/** O bruto, como o `transcribe` mediu (`source.json`, a fonte única). */
export interface SourceInfo {
  /** Caminho local do bruto (Drive for desktop), com `/`. */
  path: string;
  fps: number;
  durationS: number;
  width: number;
  height: number;
  /** Bruto espelhado (a caneca aparece invertida). O `transcribe` grava true (premissa #11208); `blocks.json` sobrepõe. */
  mirrored: boolean;
}

/** Centro do rosto, em fração do quadro JÁ desespelhado: x do centro, y da linha dos olhos. */
export interface Framing {
  faceX: number;
  eyeY: number;
}

export interface VocabRule {
  /** Regex (fonte), aplicada ao texto das palavras unido por espaço. */
  pattern: string;
  replacement: string;
  /** Flags da regex; default "g". */
  flags?: string;
  /** Só nestas versões; ausente = todas. */
  targets?: SequenceTarget[];
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
  /** Regras extras desta edição, somadas às de `context/video-montagem/vocabulario.json`. */
  vocabulary?: VocabRule[];
  /** Blocos que seguram `FECHO_HOLD_S` depois da última palavra. Default ["fecho"]. */
  holdBlocks?: BlockKey[];
}

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
export function validateVocabRules(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [`${where}: precisa ser uma lista`];
  const errors: string[] = [];
  raw.forEach((r, i) => {
    if (!isObj(r)) return void errors.push(`${where}[${i}]: precisa ser objeto`);
    const bad = validRegex(r.pattern, r.flags);
    if (bad) errors.push(`${where}[${i}]: regex inválida (${bad})`);
    if (typeof r.replacement !== "string") errors.push(`${where}[${i}]: replacement precisa ser string`);
    if (r.targets !== undefined && (!Array.isArray(r.targets) || r.targets.some((t) => !SEQUENCE_TARGETS.includes(t as SequenceTarget)))) {
      errors.push(`${where}[${i}]: targets fora de ${SEQUENCE_TARGETS.join("/")}`);
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
  if (typeof raw.edition !== "string" || !/^\d{6}$/.test(raw.edition)) errors.push("edition precisa ser AAMMDD");
  if (raw.mirrored !== undefined && typeof raw.mirrored !== "boolean") errors.push("mirrored precisa ser true/false");
  if (raw.source !== undefined && !isObj(raw.source)) errors.push("source (legado) precisa ser objeto");
  if (raw.framing !== undefined) {
    const fr = raw.framing;
    if (!isObj(fr) || !isNum(fr.faceX) || !isNum(fr.eyeY) || fr.faceX < 0 || fr.faceX > 1 || fr.eyeY < 0 || fr.eyeY > 1) {
      errors.push("framing precisa de faceX e eyeY entre 0 e 1 (fração do quadro)");
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
      });
    }
  }
  if (raw.holdBlocks !== undefined) {
    if (!Array.isArray(raw.holdBlocks) || raw.holdBlocks.some((k) => typeof k !== "string" || !isBlockKey(k))) errors.push("holdBlocks precisa listar blocos conhecidos");
  }
  if (raw.sequences !== undefined) {
    if (!Array.isArray(raw.sequences) || raw.sequences.length === 0) errors.push("sequences precisa ser uma lista não vazia");
    else {
      const seen = new Set<string>();
      raw.sequences.forEach((s, i) => {
        const label = `sequences[${i}]`;
        if (!isObj(s)) return void errors.push(`${label}: precisa ser objeto`);
        if (typeof s.target !== "string" || !SEQUENCE_TARGETS.includes(s.target as SequenceTarget)) errors.push(`${label}: target fora de ${SEQUENCE_TARGETS.join("/")}`);
        else if (seen.has(s.target)) errors.push(`${label}: target ${s.target} repetido`);
        else seen.add(s.target);
        if (typeof s.name !== "string" || !s.name.trim()) errors.push(`${label}: sem name`);
        else if (videoTargetOf(s.name) !== s.target) {
          errors.push(`${label}: o nome "${s.name}" não indica o destino ${s.target} (export cairia no destino errado da pasta Final/)`);
        }
        if (!Number.isInteger(s.width) || !Number.isInteger(s.height) || (s.width as number) <= 0 || (s.height as number) <= 0) errors.push(`${label}: width/height inteiros positivos`);
        if (!Array.isArray(s.order) || s.order.length === 0 || s.order.some((k) => typeof k !== "string" || !isBlockKey(k))) errors.push(`${label}: order precisa listar blocos conhecidos`);
        if (!Array.isArray(s.scales) || s.scales.length !== 2 || s.scales.some((x) => !isNum(x) || x <= 0)) errors.push(`${label}: scales precisa de exatamente 2 números positivos`);
      });
    }
  }
  errors.push(...validateVocabRules(raw.vocabulary, "vocabulary"));
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
 * As 3 versões (#11208). Nomes no padrão dos finais da pasta `Final/`
 * (`Diaria comentada_Youtube_V3.mp4`, #11222): o Premiere sugere o nome da
 * sequência no export, e `videoTargetOf` lê o destino dele. Escalas: 50/62 no
 * horizontal (50% de um 4K enche 1920x1080); 115/130 nas verticais (a da
 * prévia aprovada da 261027; o XML dela saiu com 89/105, "enquadramento
 * pequeno" na autorrevisão).
 */
export function defaultSequences(version = "V1"): SequenceSpec[] {
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
      target: "instagram",
      name: `Diaria comentada_Instagram_${version}`,
      width: 1080,
      height: 1920,
      order: ["titulo", "resumo_curto", "comentario", "cta_ig", "fecho"],
      scales: [115, 130],
    },
    {
      target: "outras-redes",
      name: `Diaria comentada_Outras redes_${version}`,
      width: 1080,
      height: 1920,
      order: ["titulo", "resumo_curto", "comentario", "cta_out", "fecho"],
      scales: [115, 130],
    },
  ];
}

export type ResolvedItem = {
  interval: Interval;
  text: string;
  /** Palavras do bruto dentro do intervalo (meio da palavra dentro). */
  words: Word[];
  /** Fim da última palavra dita no trecho; null sem palavra. */
  lastWordEnd: number | null;
  /** Até onde um respiro pode ir sem pegar a palavra seguinte do bruto (`next.start - guardS`, ou a duração). */
  holdLimit: number;
} & ({ how: "take"; take: number; completeTakes: number } | { how: "explicit" });

export interface ResolveOptions {
  durationS: number;
  /** Vocabulário aplicado às palavras do bruto antes de casar as frases. */
  rules?: VocabRule[];
  aliases?: VocabAlias[];
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
  const words = applyVocabularyToWords(rawWords, [...(opts.rules ?? []), ...(file.vocabulary ?? [])], undefined, (w) => warnings.push(w));
  const match = makeMatcher(opts.aliases);
  const guard = TAKE_DEFAULTS.guardS;
  const blocks: Partial<Record<BlockKey, ResolvedItem[]>> = {};
  const errors: string[] = [];
  const limitAfter = (idx: number) => (idx < words.length ? words[idx].start - guard : opts.durationS);
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
        out.push({
          interval: { start: it.start, end: it.end },
          text: it.text ?? inside.map((w) => w.text.trim()).join(" "),
          words: inside,
          lastWordEnd: inside.length ? inside[inside.length - 1].end : null,
          holdLimit: round3(Math.min(opts.durationS, nextIdx < 0 ? opts.durationS : limitAfter(nextIdx))),
          how: "explicit",
        });
        return;
      }
      const c = chooseTake(words, it.text, { take: it.take, match });
      if (!c.ok) return void errors.push(`${label}: ${c.reason}`);
      out.push({
        interval: c.interval,
        text: it.text.trim(),
        words: words.slice(c.take.firstWord, c.take.lastWord + 1),
        lastWordEnd: words[c.take.lastWord].end,
        holdLimit: round3(Math.min(opts.durationS, limitAfter(c.take.lastWord + 1))),
        how: "take",
        take: c.takeNumber,
        completeTakes: c.completeTakes,
      });
    });
  }
  return { blocks, errors, warnings };
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
}

export interface SequencePlan {
  spec: SequenceSpec;
  clips: PlannedClip[];
  durationFrames: number;
  /** Texto do roteiro desta versão (os blocos na ordem), base da autorrevisão e das legendas. */
  script: string;
  /** Blocos da ordem sem nenhum item no `blocks.json`. */
  missingBlocks: BlockKey[];
  /** Itens que sumiram no corte (0 clipes) ou palavras que ficaram fora dos clipes. */
  dropped: string[];
}

/**
 * Clipes de uma sequência: cada item do bloco vira os trechos de fala dele
 * (`speechParts`), a escala alterna base/punch-in clipe a clipe. No bloco de
 * fecho, o último trecho termina `FECHO_HOLD_S` depois da ÚLTIMA PALAVRA, preso
 * antes da palavra seguinte do bruto (`holdLimit`), e o descarte de clipe curto
 * vem depois desse respiro. Item que some no corte, ou palavra que fica de
 * fora, vai para `dropped`.
 */
export function buildSequencePlan(
  spec: SequenceSpec,
  resolved: Partial<Record<BlockKey, ResolvedItem[]>>,
  silences: Interval[],
  source: Pick<SourceInfo, "fps" | "durationS">,
  opts: { holdBlocks?: BlockKey[]; minGapS?: number; padS?: number; minClipS?: number } = {},
): SequencePlan {
  const hold = new Set<BlockKey>(opts.holdBlocks ?? ["fecho"]);
  const minClip = opts.minClipS ?? SPEECH_DEFAULTS.minClipS;
  const fps = source.fps;
  const clips: PlannedClip[] = [];
  const missingBlocks: BlockKey[] = [];
  const dropped: string[] = [];
  const scriptParts: string[] = [];
  let t = 0;
  for (const key of spec.order) {
    const items = resolved[key];
    if (!items || items.length === 0) {
      missingBlocks.push(key);
      continue;
    }
    const holding = hold.has(key);
    items.forEach((it, idx) => {
      scriptParts.push(it.text);
      let parts = speechParts(it.interval.start, it.interval.end, silences, { ...opts, minClipS: 0 });
      if (holding && idx === items.length - 1 && parts.length) {
        const lastPart = parts[parts.length - 1];
        const target = it.lastWordEnd !== null ? it.lastWordEnd + FECHO_HOLD_S : lastPart.end + FECHO_HOLD_S;
        const floor = it.lastWordEnd ?? lastPart.start;
        lastPart.end = round3(Math.max(floor, Math.min(it.holdLimit, source.durationS, target)));
      }
      parts = parts.filter((p) => p.end - p.start >= minClip - 1e-9);
      if (parts.length === 0) {
        dropped.push(`${key}[${idx}]: some no corte (fala abaixo de ${minClip} s depois de tirar os silêncios)`);
        return;
      }
      const lost = it.words.filter((w) => !parts.some((p) => (w.start + w.end) / 2 >= p.start && (w.start + w.end) / 2 <= p.end));
      if (lost.length) dropped.push(`${key}[${idx}]: palavra(s) fora dos clipes: "${lost.map((w) => w.text.trim()).join(" ")}"`);
      for (const p of parts) {
        const frameIn = Math.round(p.start * fps);
        const frameOut = Math.round(p.end * fps);
        if (frameOut <= frameIn) continue;
        const scale = spec.scales[clips.length % 2];
        clips.push({ block: key, srcIn: p.start, srcOut: p.end, frameIn, frameOut, seqStart: t, seqEnd: t + (frameOut - frameIn), scale });
        t += frameOut - frameIn;
      }
    });
  }
  return { spec, clips, durationFrames: t, script: scriptParts.join(" "), missingBlocks, dropped };
}

// ── Enquadramento ─────────────────────────────────────────────────────────

/** Olhos a ~40% da altura do quadro (#11208). */
export const EYE_LINE_FRACTION = 0.4;

export interface FramingResult {
  /** Recorte no bruto (px, já desespelhado); `w`/`h` pares para o ffmpeg, na proporção da sequência. */
  crop: { x: number; y: number; w: number; h: number };
  /**
   * Center do Basic Motion do xmeml: deslocamento do centro do clipe em
   * relação ao centro da sequência, em fração da largura/altura da sequência
   * (positivo = direita/baixo). Premissa a conferir no 1º import (#11208).
   */
  center: { horiz: number; vert: number };
  /** Escala efetiva (%): a pedida, ou maior quando o bruto é pequeno demais para ela (ex.: 1080p). */
  scalePct: number;
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
  const x = Math.round(clamp(input.framing.faceX * input.srcW - w / 2, 0, input.srcW - w));
  const y = Math.round(clamp(input.framing.eyeY * input.srcH - eyeFrac * h, 0, input.srcH - h));
  const dx = (input.srcW / 2 - (x + w / 2)) * s;
  const dy = (input.srcH / 2 - (y + h / 2)) * s;
  const r4 = (v: number) => Math.round(v * 10000) / 10000 || 0;
  return { crop: { x, y, w, h }, center: { horiz: r4(dx / input.seqW), vert: r4(dy / input.seqH) }, scalePct: Math.round(s * 10000) / 100 };
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

export interface XmemlOptions {
  /**
   * Leva o desespelhamento no XML como o filtro "Flop" (horizontal) do FCP7.
   * Default false: não foi conferido no Premiere (#11208), que pode ignorar o
   * filtro no import; aí o editor aplica Horizontal Flip à mão, como na 261027.
   */
  flopFilter?: boolean;
}

function motionFilter(scale: number, center: { horiz: number; vert: number }): string {
  return (
    `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>\n` +
    `<parameter><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>${scale}</value></parameter>\n` +
    `<parameter><parameterid>center</parameterid><name>Center</name><value><horiz>${center.horiz}</horiz><vert>${center.vert}</vert></value></parameter></effect></filter>`
  );
}

const FLOP_FILTER =
  `<filter><effect><name>Flop</name><effectid>Flop</effectid><effectcategory>Perspective</effectcategory><effecttype>filter</effecttype><mediatype>video</mediatype>\n` +
  `<parameter><parameterid>direction</parameterid><name>Direction</name><value>1</value></parameter></effect></filter>`;

/**
 * XML FCP7 (xmeml v4) com uma sequência por plano, importável no Premiere
 * (estrutura da 261027, que importou). Um `<file>` só (o bruto), definido no
 * 1º clipe e referenciado nos outros; vídeo e áudio linkados clipe a clipe
 * (áudio com 1 `sourcetrack`, premissa a conferir no 1º import). Cada clipe
 * leva a escala efetiva e o Center de `framingFor` (o mesmo da prévia).
 */
export function buildXmeml(plans: SequencePlan[], source: SourceInfo, framing: Framing, opts: XmemlOptions = {}): string {
  const fps = source.fps;
  const total = Math.round(source.durationS * fps);
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  const flop = opts.flopFilter && source.mirrored ? FLOP_FILTER : "";
  let defined = false;
  let cid = 0;
  const fileEl = () => {
    if (defined) return '<file id="file-1"/>';
    defined = true;
    return (
      `<file id="file-1"><name>${escapeXml(baseName(source.path))}</name><pathurl>${escapeXml(pathUrl(source.path))}</pathurl>\n` +
      `${rate}<duration>${total}</duration>\n` +
      `<media><video><samplecharacteristics><width>${source.width}</width><height>${source.height}</height></samplecharacteristics></video>\n` +
      `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>`
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
      v.push(`<clipitem id="v${cid}">${head}${fileEl()}${flop}${motionFilter(fr.scalePct, fr.center)}\n${links}</clipitem>`);
      a.push(
        `<clipitem id="a${cid}">${head}<file id="file-1"/><sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>\n${links}</clipitem>`,
      );
    });
    out.push(
      `<sequence id="seq-${si + 1}-${escapeXml(spec.target)}"><name>${escapeXml(spec.name)}</name><duration>${plan.durationFrames}</duration>\n` +
        `${rate}\n` +
        `<media><video><format><samplecharacteristics>${rate}<width>${spec.width}</width><height>${spec.height}</height><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>\n` +
        `<track>${v.join("\n")}</track></video>\n` +
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
 * redistribui. A regra que muda o número de palavras é pulada (com aviso), sem
 * derrubar as outras.
 */
export function applyVocabularyToWords(words: Word[], rules: VocabRule[], target?: SequenceTarget, warn?: (msg: string) => void): Word[] {
  let cur = words.map((w) => ({ ...w, text: w.text.trim() }));
  for (const r of rules) {
    if (r.targets && (!target || !r.targets.includes(target))) continue;
    const joined = cur.map((w) => w.text).join(" ");
    const next = joined.replace(new RegExp(r.pattern, r.flags ?? "g"), r.replacement);
    if (next === joined) continue;
    const parts = next.split(" ");
    if (parts.length !== cur.length) {
      warn?.(`regra de vocabulário /${r.pattern}/ muda o número de palavras; pulada`);
      continue;
    }
    cur = cur.map((w, i) => ({ ...w, text: parts[i] }));
  }
  return cur;
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
  const pairs = alignTokens(words.map((w) => normalizeToken(w.text)), raw.map(normalizeToken), makeMatcher(aliases));
  const out = words.map((w) => ({ ...w, text: w.text.trim() }));
  for (const [i, j] of pairs) out[i].text = raw[j];
  return out;
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
  const textOf = (ws: Word[]) => ws.map((x) => x.text).join(" ");
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
      const text = wrapCueText(c.map((w) => w.text).join(" "), opts.wrapOver);
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
  return null;
}

/**
 * O bruto na pasta da edição: o maior vídeo solto nela (fora de `Final/`), que
 * não seja um final (`final` no nome) nem uma prévia nossa. `candidates` traz
 * todos os que serviriam: com mais de um, o CLI avisa listando-os (o editor
 * pode ter gravado em 2 arquivos; `--source` escolhe outro).
 */
export function pickRawSource(files: Array<{ name: string; size: number }>): { pick: { name: string; size: number }; candidates: Array<{ name: string; size: number }> } | null {
  const vids = files.filter(
    (f) => /\.(mp4|mov)$/i.test(f.name) && !/(?<!\p{L})final(?!\p{L})/iu.test(f.name) && !/previa|prévia/i.test(f.name),
  );
  if (vids.length === 0) return null;
  return { pick: vids.reduce((a, b) => (b.size > a.size ? b : a)), candidates: vids };
}

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
export function parseProbe(json: string, path: string): SourceInfo {
  const j = JSON.parse(json) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>;
    format?: { duration?: string };
  };
  const v = j.streams?.find((s) => s.codec_type === "video");
  if (!v || !v.width || !v.height || !v.r_frame_rate) throw new Error("ffprobe sem stream de vídeo com largura/altura/fps");
  const durationS = Number(j.format?.duration);
  if (!Number.isFinite(durationS) || durationS <= 0) throw new Error("ffprobe sem duração");
  const fps = parseFrameRate(v.r_frame_rate);
  if (!Number.isInteger(fps)) {
    throw new Error(`fps ${fps} não inteiro: o XML usa timebase inteiro com NTSC=FALSE (premissa da 261027, 30 fps)`);
  }
  return { path, fps, durationS: round3(durationS), width: v.width, height: v.height, mirrored: true };
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
