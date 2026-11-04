/**
 * scripts/lib/diaria/video-cut-refine.ts (#11500)
 *
 * Refino dos cortes da montagem pelo ÁUDIO do bruto, rodado pelo `build` de
 * `scripts/video-montagem.ts` em toda montagem. Os cortes saem dos tempos por
 * palavra do Whisper (mais respiro e corte de silêncio), e esses tempos erram
 * nas bordas: o Whisper estica a palavra por cima da pausa ("junto" em
 * 573,11–573,91 s na 261029, quando ele começa em 573,6 s) e engole hesitação.
 * O ajuste manual da 261029 (tabela da issue) achou corte em plena fala, cauda
 * de palavra, hesitação "a," na borda e sobreposição entre clipes contíguos.
 *
 * Duas passadas, puras (o CLI lê o `audio.wav` e roda a retranscrição):
 *   A. `snapClipEdges`: cada entrada e saída vai para o vale de energia mais
 *      próximo, numa janela de ±0,4 s que não passa do meio da palavra vizinha
 *      (a de fora do clipe) nem do meio da própria 1ª/última palavra. Vale =
 *      RMS no limiar do silêncio ou abaixo (`silences.meta.json`, o mesmo
 *      relativo ao loudness do silencedetect, #11351); sem vale na janela, o
 *      ponto de menor energia se ele for `minDropDb` mais baixo que o corte.
 *   B. `edgeExtras`: a borda retranscrita sem VAD e sem
 *      `condition_on_previous_text` (o mesmo do `retranscribe`, #11364) é
 *      alinhada com as palavras do transcript dentro do clipe; som ouvido antes
 *      da 1ª palavra casada (entrada) ou depois da última (saída), dentro do
 *      clipe e com energia de fala, é som fora do roteiro (hesitação, cauda da
 *      palavra anterior, sílaba de tomada descartada) e sai do clipe. Palavra a
 *      mais que é a palavra do roteiro logo antes/depois (o transcript longo
 *      engoliu uma palavra dita) fica.
 * Depois das duas, `assembleClips` refaz a emenda dos contíguos (sem
 * sobreposição) e a alternância do zoom, e `speechCutWarnings` aponta corte
 * que ainda cai em plena fala (limiar + 15 dB).
 */

import {
  alignTokens,
  normalizeToken,
  tokenize,
  tokensMatch,
  trimWordsToSilences,
  type CutAdjustment,
  type RawClip,
  type TokenMatcher,
  type Word,
  type Interval,
} from "./video-montage.ts";

const round3 = (x: number) => Math.round(x * 1000) / 1000;

// ── Áudio ─────────────────────────────────────────────────────────────────

/** WAV PCM 16 bits (o `audio.wav` do `transcribe`: 16 kHz mono), misturado para mono. */
export function parseWavPcm16(buf: Uint8Array): { sampleRate: number; samples: Int16Array } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("audio.wav não é WAV (RIFF/WAVE)");
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    let size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt) throw new Error("audio.wav sem chunk fmt antes do data");
      if (fmt.format !== 1 && fmt.format !== 0xfffe) throw new Error(`audio.wav não é PCM (formato ${fmt.format})`);
      if (fmt.bits !== 16) throw new Error(`audio.wav com ${fmt.bits} bits; esperado 16`);
      // Tamanho 0/0xFFFFFFFF (escrito em stream) = até o fim do arquivo.
      if (size === 0 || size === 0xffffffff || body + size > buf.byteLength) size = buf.byteLength - body;
      const ch = Math.max(1, fmt.channels);
      const n = Math.floor(size / (2 * ch));
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let c = 0; c < ch; c++) acc += view.getInt16(body + 2 * (i * ch + c), true);
        samples[i] = Math.round(acc / ch);
      }
      return { sampleRate: fmt.sampleRate, samples };
    }
    off = body + size + (size % 2);
  }
  throw new Error("audio.wav sem chunk data");
}

/** Energia (RMS em dBFS) a cada `hopS`, janela de `winS` centrada em `i * hopS`. */
export interface Envelope {
  hopS: number;
  db: Float64Array;
}

export const ENVELOPE_DEFAULTS = { hopS: 0.01, winS: 0.03, floorDb: -120 } as const;

export function energyEnvelope(samples: Int16Array, sampleRate: number, opts: { hopS?: number; winS?: number } = {}): Envelope {
  const hopS = opts.hopS ?? ENVELOPE_DEFAULTS.hopS;
  const winS = opts.winS ?? ENVELOPE_DEFAULTS.winS;
  const sq = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i++) sq[i + 1] = sq[i] + samples[i] * samples[i];
  const n = Math.ceil(samples.length / (hopS * sampleRate));
  const half = Math.max(1, Math.round((winS * sampleRate) / 2));
  const db = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.round(i * hopS * sampleRate);
    const a = Math.max(0, c - half);
    const b = Math.min(samples.length, c + half);
    const ms = b > a ? (sq[b] - sq[a]) / (b - a) : 0;
    db[i] = ms > 0 ? Math.max(ENVELOPE_DEFAULTS.floorDb, 10 * Math.log10(ms / (32768 * 32768))) : ENVELOPE_DEFAULTS.floorDb;
  }
  return { hopS, db };
}

const idxOf = (env: Envelope, t: number) => Math.min(env.db.length - 1, Math.max(0, Math.round(t / env.hopS)));

/** Energia no instante `t` (o quadro mais próximo). */
export function dbAt(env: Envelope, t: number): number {
  return env.db.length ? env.db[idxOf(env, t)] : ENVELOPE_DEFAULTS.floorDb;
}

/** Maior energia em `[a, b]`. */
export function maxDbIn(env: Envelope, a: number, b: number): number {
  if (!env.db.length) return ENVELOPE_DEFAULTS.floorDb;
  let m: number = ENVELOPE_DEFAULTS.floorDb;
  for (let i = idxOf(env, a); i <= idxOf(env, b); i++) m = Math.max(m, env.db[i]);
  return m;
}

// ── Passada A: vale de energia ────────────────────────────────────────────

/** Parâmetros do refino (#11500); `windowS` e o "+15 dB" vêm da issue. */
export const CUT_REFINE = {
  /** Janela de busca do vale em volta de cada corte. */
  windowS: 0.4,
  /** Corte com energia acima de limiar + isso é "em plena fala" (vira ajuste ou aviso). */
  speechAboveDb: 15,
  /** Sem vale na janela: o ponto de menor energia só vale se for isso mais baixo que o corte. */
  minDropDb: 3,
  /** Retranscrição da borda: quanto do clipe entra na janela. */
  edgeSpanS: 1.6,
  /** Retranscrição da borda: quanto de fora do clipe entra na janela. */
  edgeOutsideS: 0.3,
  /** Som a mais na borda só conta com energia de fala: limiar + isso. */
  extraAboveDb: 6,
  /** Ar deixado antes da 1ª palavra casada / depois da última quando o som a mais sai. */
  edgeAirS: 0.05,
  /** Clipe nunca fica mais curto que isso pelo refino. */
  minClipS: 0.3,
} as const;

export type SnapHow = "ja-no-silencio" | "vale" | "minimo" | "sem-vale";

/**
 * O vale de energia mais próximo de `t` dentro de `[lo, hi]`: o próprio `t` se
 * já está no silêncio; senão o quadro no limiar ou abaixo mais perto de `t`
 * (empate: o de menor energia); sem nenhum, o mínimo da janela se ele cair
 * `minDropDb` abaixo de `t`; senão `t` (`sem-vale`).
 */
export function snapToValley(env: Envelope, t: number, lo: number, hi: number, thresholdDb: number, minDropDb: number = CUT_REFINE.minDropDb): { t: number; how: SnapHow } {
  if (!env.db.length || !(hi > lo)) return { t, how: "sem-vale" };
  const i0 = idxOf(env, t);
  if (env.db[i0] <= thresholdDb && t >= lo - 1e-9 && t <= hi + 1e-9) return { t, how: "ja-no-silencio" };
  const ilo = Math.ceil(lo / env.hopS - 1e-9);
  const ihi = Math.floor(hi / env.hopS + 1e-9);
  for (let d = 0; d <= Math.max(i0 - ilo, ihi - i0); d++) {
    const cands = [i0 - d, i0 + d].filter((i) => i >= Math.max(0, ilo) && i <= Math.min(env.db.length - 1, ihi) && env.db[i] <= thresholdDb);
    if (cands.length) {
      const best = cands.reduce((a, b) => (env.db[b] < env.db[a] ? b : a));
      return { t: round3(best * env.hopS), how: "vale" };
    }
  }
  let best = -1;
  for (let i = Math.max(0, ilo); i <= Math.min(env.db.length - 1, ihi); i++) if (best < 0 || env.db[i] < env.db[best]) best = i;
  if (best >= 0 && env.db[best] <= dbAt(env, t) - minDropDb) return { t: round3(best * env.hopS), how: "minimo" };
  return { t, how: "sem-vale" };
}

const mid = (w: Word) => (w.start + w.end) / 2;

/** Palavras do transcript com o meio dentro de `[a, b]`, e as vizinhas de fora. */
export function clipWordContext(words: Word[], a: number, b: number): { inside: Word[]; prev?: Word; next?: Word } {
  const inside = words.filter((w) => mid(w) >= a && mid(w) <= b);
  let prev: Word | undefined;
  let next: Word | undefined;
  for (const w of words) {
    if (mid(w) < a && (!prev || mid(w) > mid(prev))) prev = w;
    if (mid(w) > b && (!next || mid(w) < mid(next))) next = w;
  }
  return { inside, prev, next };
}

const fmtDb = (x: number) => `${Math.round(x)} dB`;

/**
 * Passada A: entrada e saída de cada clipe no vale de energia mais próximo
 * (janela de ±`windowS`, sem passar do meio da palavra vizinha de fora do
 * clipe nem do meio da 1ª/última palavra de dentro). Devolve os clipes novos e
 * os ajustes (só os que mudaram o corte).
 */
export function snapClipEdges(
  raws: RawClip[],
  env: Envelope,
  words: Word[],
  opts: { thresholdDb: number; durationS: number; windowS?: number; minDropDb?: number },
): { clips: RawClip[]; adjustments: CutAdjustment[] } {
  const W = opts.windowS ?? CUT_REFINE.windowS;
  const adjustments: CutAdjustment[] = [];
  const clips = raws.map((r) => {
    const { inside, prev, next } = clipWordContext(words, r.srcIn, r.srcOut);
    const first = inside[0];
    const last = inside[inside.length - 1];
    let srcIn = r.srcIn;
    let srcOut = r.srcOut;
    const inLo = Math.max(0, r.srcIn - W, prev ? mid(prev) : 0);
    const inHi = Math.min(r.srcIn + W, first ? mid(first) : r.srcOut, r.srcOut - CUT_REFINE.minClipS);
    const a = snapToValley(env, r.srcIn, inLo, inHi, opts.thresholdDb, opts.minDropDb);
    if (a.how === "vale" || a.how === "minimo") {
      adjustments.push({ block: r.block, edge: "in", from: r.srcIn, to: a.t, reason: `vale de energia (${fmtDb(dbAt(env, r.srcIn))} → ${fmtDb(dbAt(env, a.t))})` });
      srcIn = a.t;
    }
    const outLo = Math.max(srcIn + CUT_REFINE.minClipS, r.srcOut - W, last ? mid(last) : srcIn);
    const outHi = Math.min(opts.durationS, r.srcOut + W, next ? mid(next) : opts.durationS);
    const b = snapToValley(env, r.srcOut, outLo, outHi, opts.thresholdDb, opts.minDropDb);
    if (b.how === "vale" || b.how === "minimo") {
      adjustments.push({ block: r.block, edge: "out", from: r.srcOut, to: b.t, reason: `vale de energia (${fmtDb(dbAt(env, r.srcOut))} → ${fmtDb(dbAt(env, b.t))})` });
      srcOut = b.t;
    }
    return { ...r, srcIn, srcOut };
  });
  return { clips, adjustments };
}

// ── Passada B: som fora do roteiro na borda ───────────────────────────────

/** Janela de retranscrição (s, no bruto) e a chave do cache. */
export interface EdgeWindow {
  key: string;
  start: number;
  end: number;
}

export const windowKey = (start: number, end: number) => `${start.toFixed(2)}-${end.toFixed(2)}`;

/**
 * Janelas da retranscrição das bordas de um clipe: uma na entrada e uma na
 * saída (`edgeSpanS` para dentro, `edgeOutsideS` para fora); clipe curto, uma
 * janela só cobrindo os dois lados.
 */
export function edgeWindowsFor(clip: Pick<RawClip, "srcIn" | "srcOut">, durationS: number): EdgeWindow[] {
  const span = CUT_REFINE.edgeSpanS;
  const out = CUT_REFINE.edgeOutsideS;
  const mk = (a: number, b: number): EdgeWindow => {
    const start = round3(Math.max(0, a));
    const end = round3(Math.min(durationS, b));
    return { key: windowKey(start, end), start, end };
  };
  if (clip.srcOut - clip.srcIn <= 2 * span) return [mk(clip.srcIn - out, clip.srcOut + out)];
  return [mk(clip.srcIn - out, clip.srcIn + span), mk(clip.srcOut - span, clip.srcOut + out)];
}

/** As palavras retranscritas que cobrem a borda `edge` do clipe (a janela que contém o corte). */
export function heardForEdge(windows: EdgeWindow[], heard: Map<string, Word[]>, t: number): Word[] | undefined {
  const w = windows.find((x) => t >= x.start - 1e-6 && t <= x.end + 1e-6);
  return w ? heard.get(w.key) : undefined;
}

export interface EdgeDecision {
  /** Novo corte, só quando há som a mais para tirar. */
  to?: number;
  /** O som a mais (texto ouvido), quando saiu. */
  extra?: string;
  /** Por que não mexeu (para o relato), quando havia algo e ficou. */
  note?: string;
}

/**
 * Passada B, uma borda: alinha a fala retranscrita (`heard`, tempo do bruto)
 * com as palavras do transcript dentro do clipe (`reference`). Na entrada, as
 * palavras ouvidas ANTES da 1ª casada, com o meio dentro do clipe e com
 * energia de fala, são som fora do roteiro: o corte vai para o vale entre a
 * última delas e a 1ª casada (com `edgeAirS` de ar antes da palavra). Na
 * saída, o espelho. Palavra a mais que é a do roteiro (`script`) logo antes da
 * 1ª casada (entrada) ou logo depois da última (saída) fica: o transcript
 * longo é que a engoliu. Menos de 2 palavras casadas = retranscrição pouco
 * confiável, não mexe.
 */
export function edgeExtras(input: {
  edge: "in" | "out";
  clip: Pick<RawClip, "srcIn" | "srcOut" | "script">;
  heard: Word[];
  reference: Word[];
  env: Envelope;
  thresholdDb: number;
  match?: TokenMatcher;
}): EdgeDecision {
  const baseEq = input.match ?? tokensMatch;
  // Homófonos de borda: o Whisper pode ouvir "a" onde o roteiro diz "há".
  // Esta tolerância fica restrita ao refino; não muda o matcher da decupagem.
  const homophone = (s: string) => normalizeToken(s) === "ha" ? "a" : normalizeToken(s);
  const eq: TokenMatcher = (a, b) => baseEq(a, b) || homophone(a) === homophone(b);
  const { srcIn, srcOut } = input.clip;
  const H = input.heard.filter((w) => w.text.trim() && w.end > srcIn + 0.02 && w.start < srcOut - 0.02);
  const Ht = H.map((w) => normalizeToken(w.text));
  const Rt = input.reference.map((w) => normalizeToken(w.text)).filter(Boolean);
  const keep = H.map((_, i) => Boolean(Ht[i]));
  const Hk = H.filter((_, i) => keep[i]);
  const Hkt = Ht.filter((_, i) => keep[i]);
  if (Hk.length === 0 || Rt.length === 0) return {};
  const pairs = alignTokens(Hkt, Rt, eq);
  if (pairs.length < 2) return { note: "retranscrição da borda casou menos de 2 palavras com o clipe" };
  // Som a mais conta pelo pedaço DENTRO do clipe (a retranscrição também estica
  // a hesitação por cima da pausa: "a," em 571,74–573,28 s na 261029), com
  // energia de fala nele.
  const energetic = (w: Word) => {
    const a = Math.max(w.start, srcIn);
    const b = Math.min(w.end, srcOut);
    if (b - a < 0.04) return false;
    return input.env.db.length === 0 || maxDbIn(input.env, a, b) >= input.thresholdDb + CUT_REFINE.extraAboveDb;
  };
  const S = input.clip.script ? tokenize(input.clip.script) : [];
  // Posição no roteiro de uma palavra casada (1ª ocorrência a partir do começo, ou do fim).
  const scriptPos = (tok: string, fromEnd: boolean): number => {
    if (fromEnd) {
      for (let j = S.length - 1; j >= 0; j--) if (eq(tok, S[j])) return j;
    } else for (let j = 0; j < S.length; j++) if (eq(tok, S[j])) return j;
    return -1;
  };
  const air = CUT_REFINE.edgeAirS;
  if (input.edge === "in") {
    const [h0] = pairs[0];
    let extras = Hk.slice(0, h0).filter(energetic);
    if (!extras.length) return {};
    // A palavra do roteiro logo antes da 1ª casada não é som a mais.
    const sp = scriptPos(Hkt[h0], false);
    let k = sp - 1;
    while (extras.length && k >= 0 && eq(normalizeToken(extras[extras.length - 1].text), S[k])) {
      extras = extras.slice(0, -1);
      k--;
    }
    if (!extras.length) return { note: "palavra a mais na entrada é a do roteiro; fica" };
    const lastExtra = extras[extras.length - 1];
    const firstOk = Hk[h0];
    // Nunca depois do começo da 1ª palavra casada, mesmo com os tempos sobrepostos.
    const hi = firstOk.start;
    const lo = Math.max(srcIn, Math.min(lastExtra.end, hi));
    const target = Math.max(lo, hi - air);
    const v = snapToValley(input.env, target, lo, hi, input.thresholdDb);
    const to = round3(v.how === "vale" || v.how === "ja-no-silencio" ? v.t : target);
    if (!(to > srcIn) || srcOut - to < CUT_REFINE.minClipS) return { note: `som a mais na entrada ("${extras.map((w) => w.text.trim()).join(" ")}") sem espaço para cortar` };
    return { to, extra: extras.map((w) => w.text.trim()).join(" ") };
  }
  const [hL] = pairs[pairs.length - 1];
  let extras = Hk.slice(hL + 1).filter(energetic);
  if (!extras.length) return {};
  const sp = scriptPos(Hkt[hL], true);
  let k = sp >= 0 ? sp + 1 : S.length;
  while (extras.length && k < S.length && eq(normalizeToken(extras[0].text), S[k])) {
    extras = extras.slice(1);
    k++;
  }
  if (!extras.length) return { note: "palavra a mais na saída é a do roteiro; fica" };
  const firstExtra = extras[0];
  const lastOk = Hk[hL];
  // Nunca antes do fim da última palavra casada, mesmo com os tempos sobrepostos.
  const lo = lastOk.end;
  const hi = Math.min(srcOut, Math.max(firstExtra.start, lo));
  const target = Math.min(hi, lo + air);
  const v = snapToValley(input.env, target, lo, hi, input.thresholdDb);
  const to = round3(v.how === "vale" || v.how === "ja-no-silencio" ? v.t : target);
  if (!(to < srcOut) || to - srcIn < CUT_REFINE.minClipS) return { note: `som a mais na saída ("${extras.map((w) => w.text.trim()).join(" ")}") sem espaço para cortar` };
  return { to, extra: extras.map((w) => w.text.trim()).join(" ") };
}

/**
 * Passada B nos clipes: para cada borda com retranscrição (`heard` por chave
 * de janela, `edgeWindowsFor`), tira o som fora do roteiro (`edgeExtras`).
 * Borda sem retranscrição fica como está.
 */
export function trimEdgeExtras(
  raws: RawClip[],
  heard: Map<string, Word[]>,
  words: Word[],
  env: Envelope,
  opts: { thresholdDb: number; durationS: number; match?: TokenMatcher },
): { clips: RawClip[]; adjustments: CutAdjustment[]; notes: string[] } {
  const adjustments: CutAdjustment[] = [];
  const notes: string[] = [];
  const clips = raws.map((r) => {
    const windows = edgeWindowsFor(r, opts.durationS);
    const reference = clipWordContext(words, r.srcIn, r.srcOut).inside;
    let cur = { ...r };
    for (const edge of ["in", "out"] as const) {
      const t = edge === "in" ? cur.srcIn : cur.srcOut;
      const h = heardForEdge(windows, heard, edge === "in" ? r.srcIn : r.srcOut);
      if (!h) continue;
      const d = edgeExtras({ edge, clip: cur, heard: h, reference, env, thresholdDb: opts.thresholdDb, match: opts.match });
      if (d.note) notes.push(`${r.block} ${edge === "in" ? "entrada" : "saída"} em ${t.toFixed(2)} s: ${d.note}`);
      if (d.to === undefined) continue;
      adjustments.push({ block: r.block, edge, from: t, to: d.to, reason: `som fora do roteiro na borda: "${d.extra}"` });
      cur = edge === "in" ? { ...cur, srcIn: d.to } : { ...cur, srcOut: d.to };
    }
    return cur;
  });
  return { clips, adjustments, notes };
}

/** Cortes que ainda caem em plena fala (limiar + `speechAboveDb`), no tempo do bruto. */
export function speechCutWarnings(clips: Array<Pick<RawClip, "block" | "srcIn" | "srcOut">>, env: Envelope, thresholdDb: number): string[] {
  const lim = thresholdDb + CUT_REFINE.speechAboveDb;
  const out: string[] = [];
  for (const c of clips) {
    for (const [edge, t] of [["entrada", c.srcIn], ["saída", c.srcOut]] as const) {
      const db = dbAt(env, t);
      if (db > lim) out.push(`${c.block}: ${edge} em ${t.toFixed(2)} s do bruto cai em plena fala (${fmtDb(db)}, limiar de fala ${fmtDb(lim)}): conferir no Premiere`);
    }
  }
  return out;
}

/** #11940: banda acima de 3 kHz, medida no bruto a 48 kHz.
 * -51 dBFS é o limiar medido na 261103 (piso -63 + 12 dB), e é o PISO do
 * limiar: desde o #11968 ele sobe com o piso de ruído do próprio bruto
 * (`highBandThresholdDb`), senão um bruto quente ou com chiado acima de 3 kHz
 * nunca cai abaixo de -51 e o `silences.json` sai vazio.
 * Só silêncio sustentado por 80 ms permite fechar/abrir uma borda, com
 * 30 ms de ar; a montagem quantiza depois para os quadros do vídeo.
 */
export const SIBILANTS = {
  sampleRate: 48000,
  highpassHz: 3000,
  thresholdDb: -51,
  quietS: 0.08,
  airS: 0.03,
  windowS: 0.4,
  /** #11968: o limiar relativo fica `aboveFloorDb` acima do piso medido. */
  aboveFloorDb: 12,
  /** Percentil do envelope tomado como piso de ruído (quadros de silêncio digital fora). */
  floorPercentile: 0.01,
  /** Teto do limiar relativo: acima disso já é fala, não piso. */
  maxThresholdDb: -30,
  /** Distância mínima piso→mediana para o limiar relativo valer (senão, o fixo). */
  minFloorGapDb: 6,
} as const;

export interface HighBandThreshold {
  thresholdDb: number;
  /** Piso de ruído medido (percentil baixo do envelope), ausente sem quadros úteis. */
  floorDb?: number;
  medianDb?: number;
  /** `fixed` = o -51 do #11940 venceu; `relative` = subiu com o piso do bruto (#11968). */
  how: "fixed" | "relative";
}

const thresholdCache = new WeakMap<Envelope, HighBandThreshold>();

/**
 * Limiar de silêncio da banda alta relativo ao bruto (#11968): piso de ruído
 * (percentil `floorPercentile`, sem os quadros de silêncio digital) +
 * `aboveFloorDb`, nunca abaixo do -51 do #11940 nem acima do ponto médio entre
 * o piso e a mediana (a mediana é fala; o limiar não pode alcançá-la) nem de
 * `maxThresholdDb`. Mesma ideia do `silenceNoiseDb` no grave (#11351).
 */
export function highBandThresholdDb(env: Envelope): HighBandThreshold {
  const hit = thresholdCache.get(env);
  if (hit) return hit;
  const vals = Array.from(env.db).filter((d) => Number.isFinite(d) && d > ENVELOPE_DEFAULTS.floorDb).sort((a, b) => a - b);
  let out: HighBandThreshold = { thresholdDb: SIBILANTS.thresholdDb, how: "fixed" };
  if (vals.length) {
    const floorDb = vals[Math.min(vals.length - 1, Math.floor(SIBILANTS.floorPercentile * vals.length))];
    const medianDb = vals[Math.floor(vals.length / 2)];
    const rel = Math.min(floorDb + SIBILANTS.aboveFloorDb, (floorDb + medianDb) / 2, SIBILANTS.maxThresholdDb);
    // Piso colado na mediana (quase sem pausa, ou envelope chapado): não dá para
    // separar piso de fala, e o limiar relativo trataria a fala como silêncio.
    out = rel > SIBILANTS.thresholdDb && medianDb - floorDb >= SIBILANTS.minFloorGapDb
      ? { thresholdDb: Math.round(rel * 10) / 10, floorDb, medianDb, how: "relative" }
      : { thresholdDb: SIBILANTS.thresholdDb, floorDb, medianDb, how: "fixed" };
  }
  thresholdCache.set(env, out);
  return out;
}

/**
 * Aviso do transcribe (#11968): a interseção com a banda alta tirou mais da
 * metade das pausas do grave. É o sintoma do limiar alto demais para o bruto
 * (o caso em que nenhuma pausa sairia), não um corte que se possa conferir
 * depois sem o aviso.
 */
export function intersectionLossWarning(low: Interval[], kept: Interval[], minDurationS: number, highThreshold: HighBandThreshold): string | null {
  const n = low.filter((q) => q.end - q.start >= minDurationS).length;
  if (n === 0) return null;
  const k = kept.filter((q) => q.end - q.start >= minDurationS).length;
  if (k >= n / 2) return null;
  return `a banda alta (>3 kHz, limiar ${highThreshold.thresholdDb} dBFS${highThreshold.floorDb !== undefined ? `, piso ${Math.round(highThreshold.floorDb)} dBFS` : ""}) deixou ${k} de ${n} pausas do grave no silences.json: poucos cortes de pausa vão sair; conferir o chiado do bruto ou o limiar (#11968)`;
}

/** Interseção: só é pausa se grave E agudo estão em silêncio. */
export function intersectSilences(low: Interval[], high: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0, j = 0;
  while (i < low.length && j < high.length) {
    const start = Math.max(low[i].start, high[j].start);
    const end = Math.min(low[i].end, high[j].end);
    if (end > start) out.push({ start, end });
    if (low[i].end < high[j].end) i++; else j++;
  }
  return out;
}

/** Silêncios sustentados no envelope da banda alta (RMS, sem pico isolado). */
export function highBandSilences(env: Envelope, thresholdDb = highBandThresholdDb(env).thresholdDb): Interval[] {
  const out: Interval[] = [];
  let start: number | undefined;
  for (let i = 0; i <= env.db.length; i++) {
    if (i < env.db.length && env.db[i] <= thresholdDb) {
      start ??= i * env.hopS;
    } else if (start !== undefined) {
      const end = i * env.hopS;
      if (end - start >= SIBILANTS.quietS - 1e-9) out.push({ start, end });
      start = undefined;
    }
  }
  return out;
}

/** Proteção final, depois da retranscrição: só expande, nunca come fala.
 * Busca ar para fora do trecho selecionado. Não avança sobre a palavra vizinha;
 * sem espaço seguro mantém o corte e deixa o aviso para revisão humana.
 * `heard` (#11968), por clipe e na mesma ordem: as palavras da retranscrição
 * das bordas. Elas também contam como vizinhas, porque o som fora do roteiro
 * que a passada B cortou (ou que o transcript principal nem tem) só aparece
 * nelas; sem isso a expansão reabria a hesitação já tirada.
 */
export function preserveSibilants(
  raws: RawClip[],
  env: Envelope,
  words: Word[],
  durationS: number,
  fps?: number,
  heard?: ReadonlyArray<Word[] | undefined>,
): { clips: RawClip[]; adjustments: CutAdjustment[] } {
  const quiet = highBandSilences(env);
  const adjustments: CutAdjustment[] = [];
  const clips = raws.map((r, idx) => {
    const extra = (heard?.[idx] ?? []).filter((w) => w.text.trim());
    const { prev, next } = clipWordContext(extra.length ? [...words, ...extra] : words, r.srcIn, r.srcOut);
    let { srcIn, srcOut } = r;
    const lo = Math.max(0, srcIn - SIBILANTS.windowS, prev?.end ?? 0);
    const hi = Math.min(durationS, srcOut + SIBILANTS.windowS, next?.start ?? durationS);
    const safe = (t: number) => quiet.some((q) => q.start + SIBILANTS.airS <= t + 1e-9 && q.end - SIBILANTS.airS >= t - 1e-9);
    const rendered = (t: number) => fps ? Math.round(t * fps) / fps : t;
    if (!safe(rendered(srcIn))) {
      const q = quiet.filter((q) => q.start + SIBILANTS.airS <= srcIn && q.end - SIBILANTS.airS >= lo).at(-1);
      if (q) {
        const target = Math.min(srcIn, q.end - SIBILANTS.airS);
        const at = fps ? Math.floor(target * fps) / fps : target;
        if (at >= lo && safe(at)) srcIn = round3(at);
      }
    }
    if (!safe(rendered(srcOut))) {
      const q = quiet.find((q) => q.end - SIBILANTS.airS >= srcOut && q.start + SIBILANTS.airS <= hi);
      if (q) {
        const target = Math.max(srcOut, q.start + SIBILANTS.airS);
        const at = fps ? Math.ceil(target * fps) / fps : target;
        if (at <= hi && safe(at)) srcOut = round3(at);
      }
    }
    for (const [edge, from, to] of [["in", r.srcIn, srcIn], ["out", r.srcOut, srcOut]] as const) {
      if (from !== to) adjustments.push({ block: r.block, edge, from, to, reason: "preservar fonema agudo: silêncio de 80 ms com 30 ms de ar (#11940)" });
    }
    return { ...r, srcIn, srcOut };
  });
  return { clips, adjustments };
}

/** Verificação independente da proteção, inclusive se ela não encontrou espaço. */
export function highBandCutWarnings(clips: Array<Pick<RawClip, "block" | "srcIn" | "srcOut">>, env: Envelope): string[] {
  const quiet = highBandSilences(env);
  return clips.flatMap((c) => ([ ["entrada", c.srcIn], ["saída", c.srcOut] ] as const).flatMap(([edge, t]) =>
    quiet.some((q) => t >= q.start + SIBILANTS.airS - 1e-9 && t <= q.end - SIBILANTS.airS + 1e-9)
      ? [] : [`${c.block}: ${edge} em ${t.toFixed(2)} s do bruto sem margem de silêncio na banda alta (>3 kHz): possível fonema cortado; conferir no Premiere (#11940)`]));
}

/** Normaliza os limiares, preservando atividade em qualquer banda no refino. */
export function combinedCutEnvelope(low: Envelope, high: Envelope, lowThresholdDb: number): Envelope {
  const highThresholdDb = highBandThresholdDb(high).thresholdDb;
  return { hopS: low.hopS, db: Float64Array.from(low.db, (db, i) => Math.max(db, dbAt(high, i * low.hopS) - highThresholdDb + lowThresholdDb)) };
}

// ── Detector de fala do corte de pausas (#12089) ──────────────────────────

/**
 * Critério do corte de pausas validado pelo editor na 261104 (#12089), no
 * lugar do `silencedetect` a -35 dB, que num bruto quente (-10 LUFS, piso de
 * ruído a -38/-40 dB, respiração a -26/-33 dB) vê respiração e ruído de sala
 * como som: as entradas ficavam no ar antes da fala e as pausas de 0,24–0,9 s
 * dentro dos clipes iam inteiras para o XML.
 *  - áudio a 48 kHz, quadros de 5 ms;
 *  - fala = energia do sinal cheio acima de `fullDb` OU energia da 1ª
 *    diferença (passa-alta, pega a sibilante: o "s" final de "aplicativos"
 *    fica a -35/-38 dB no sinal cheio, -43/-46 dB na banda alta) acima de
 *    `diffDb`;
 *  - ilhas de fala com pausa menor que `minGapS` entre elas se juntam; ilha
 *    que sobra com menos de `minIslandS` é estalo, não fala (o de 10 ms entre
 *    "Segundo," e "nunca" virou um clipe de 0,13 s na 261104);
 *  - pausa de `minGapS` ou mais sai, deixando `padBeforeS` antes da fala
 *    seguinte e `padAfterS` depois da anterior (correção do editor no import
 *    do V2: com 50/70 ms "está cortando em cima da fala"; a emenda é seca e o
 *    in/out cai no quadro de 33 ms).
 * `longJoinPauseS` e `shortClipS` são os limiares dos avisos do `build`.
 */
export const SPEECH_DETECT = {
  sampleRate: 48000,
  hopS: 0.005,
  fullDb: -33,
  diffDb: -46,
  minIslandS: 0.06,
  minGapS: 0.32,
  padBeforeS: 0.15,
  padAfterS: 0.12,
  longJoinPauseS: 0.45,
  shortClipS: 0.3,
} as const;

/** Energia por quadro (não sobrepostos, `hopS`): o quadro `i` cobre `[i·hopS, (i+1)·hopS)`. */
export interface FrameEnergy {
  hopS: number;
  fullDb: Float64Array;
  /** Da 1ª diferença do sinal (`x[n] − x[n−1]`), um passa-alta simples. */
  diffDb: Float64Array;
}

/** As duas energias por quadro numa passada, sem cópia do sinal (o bruto de 20 min a 48 kHz tem 57 M amostras). */
export function frameEnergies(samples: Int16Array, sampleRate: number, hopS: number = SPEECH_DETECT.hopS): FrameEnergy {
  const per = Math.max(1, Math.round(hopS * sampleRate));
  const n = Math.ceil(samples.length / per);
  const fullDb = new Float64Array(n);
  const diffDb = new Float64Array(n);
  const full = 32768 * 32768;
  const toDb = (ms: number) => (ms > 0 ? Math.max(ENVELOPE_DEFAULTS.floorDb, 10 * Math.log10(ms / full)) : ENVELOPE_DEFAULTS.floorDb);
  for (let i = 0; i < n; i++) {
    const a = i * per;
    const b = Math.min(samples.length, a + per);
    let s = 0;
    let d = 0;
    for (let k = a; k < b; k++) {
      const x = samples[k];
      s += x * x;
      const dx = k > 0 ? x - samples[k - 1] : 0;
      d += dx * dx;
    }
    const len = b - a;
    fullDb[i] = toDb(s / len);
    diffDb[i] = toDb(d / len);
  }
  return { hopS: per / sampleRate, fullDb, diffDb };
}

/**
 * As ilhas de fala do bruto (#12089): quadros com fala (`fullDb` OU
 * `diffDb`), ilhas a menos de `minGapS` unidas, e só depois as que sobram com
 * menos de `minIslandS` descartadas (vogal curta colada na fala, "A empresa",
 * fica junto da palavra seguinte; o estalo isolado sai).
 */
export function speechIslands(e: FrameEnergy, opts: Partial<Pick<typeof SPEECH_DETECT, "fullDb" | "diffDb" | "minGapS" | "minIslandS">> = {}): Interval[] {
  const fullDb = opts.fullDb ?? SPEECH_DETECT.fullDb;
  const diffDb = opts.diffDb ?? SPEECH_DETECT.diffDb;
  const minGap = opts.minGapS ?? SPEECH_DETECT.minGapS;
  const minIsland = opts.minIslandS ?? SPEECH_DETECT.minIslandS;
  const raw: Interval[] = [];
  let open = -1;
  const n = e.fullDb.length;
  for (let i = 0; i <= n; i++) {
    const on = i < n && (e.fullDb[i] > fullDb || e.diffDb[i] > diffDb);
    if (on && open < 0) open = i;
    else if (!on && open >= 0) {
      raw.push({ start: open * e.hopS, end: i * e.hopS });
      open = -1;
    }
  }
  const merged: Interval[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < minGap - 1e-9) last.end = r.end;
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.end - r.start >= minIsland - 1e-9).map((r) => ({ start: round3(r.start), end: round3(r.end) }));
}

/**
 * As pausas a cortar (#12089), no formato do `silences.json`, já descontadas
 * as folgas: de `padAfterS` depois de uma ilha até `padBeforeS` antes da
 * seguinte, e as pontas do bruto. `speechParts` as recebe sem respiro próprio
 * (`SPEECH_DETECT_PLAN`). Sem ilha nenhuma, o bruto inteiro é pausa.
 */
export function speechPauseSilences(islands: Interval[], durationS: number, opts: Partial<Pick<typeof SPEECH_DETECT, "padBeforeS" | "padAfterS">> = {}): Interval[] {
  const before = opts.padBeforeS ?? SPEECH_DETECT.padBeforeS;
  const after = opts.padAfterS ?? SPEECH_DETECT.padAfterS;
  if (islands.length === 0) return durationS > 0 ? [{ start: 0, end: round3(durationS) }] : [];
  const out: Interval[] = [];
  const push = (a: number, b: number) => {
    if (b - a > 1e-6) out.push({ start: round3(a), end: round3(b) });
  };
  push(0, islands[0].start - before);
  for (let i = 1; i < islands.length; i++) push(islands[i - 1].end + after, islands[i].start - before);
  push(islands[islands.length - 1].end + after, durationS);
  return out;
}

/**
 * Palavra do transcript dita baixo demais para virar ilha (#12089, review da
 * PR #12142): um "e" sussurrado abaixo dos dois limiares fica inteira dentro
 * da pausa do detector, o corte a tira e o build barrava com "palavra fora dos
 * clipes", coisa que o `silences.json` não fazia. Aqui a pausa que cobre o
 * meio de uma palavra transcrita (já aparada pelas pausas, como a checagem do
 * `buildSequencePlan` faz) perde o trecho da palavra com as mesmas folgas da
 * fala; a palavra protegida volta para o relato do build como `[aviso]`.
 */
export function protectTranscribedWords(
  pauses: Interval[],
  words: Array<Interval & { text?: string }>,
  opts: Partial<Pick<typeof SPEECH_DETECT, "padBeforeS" | "padAfterS">> = {},
): { silences: Interval[]; protectedWords: Array<{ text: string; start: number; end: number }> } {
  const before = opts.padBeforeS ?? SPEECH_DETECT.padBeforeS;
  const after = opts.padAfterS ?? SPEECH_DETECT.padAfterS;
  const sorted = [...pauses].sort((a, b) => a.start - b.start);
  const protectedWords: Array<{ text: string; start: number; end: number }> = [];
  const holes: Interval[] = [];
  for (const raw of words) {
    const [w] = trimWordsToSilences([{ text: raw.text ?? "", start: raw.start, end: raw.end } as Word], sorted);
    const mid = (w.start + w.end) / 2;
    if (!sorted.some((p) => mid > p.start + 1e-6 && mid < p.end - 1e-6)) continue;
    protectedWords.push({ text: (raw.text ?? "").trim(), start: raw.start, end: raw.end });
    holes.push({ start: raw.start - before, end: raw.end + after });
  }
  if (holes.length === 0) return { silences: sorted, protectedWords };
  const out: Interval[] = [];
  for (const p of sorted) {
    let pieces: Interval[] = [{ ...p }];
    for (const h of holes) {
      if (h.end <= p.start || h.start >= p.end) continue;
      pieces = pieces.flatMap((q) => {
        if (h.end <= q.start || h.start >= q.end) return [q];
        const res: Interval[] = [];
        if (h.start - q.start > 1e-6) res.push({ start: q.start, end: round3(h.start) });
        if (q.end - h.end > 1e-6) res.push({ start: round3(h.end), end: q.end });
        return res;
      });
    }
    out.push(...pieces);
  }
  return { silences: out, protectedWords };
}

/**
 * Opções do corte com o detector de fala (`buildSequencePlan`, #12089): as
 * pausas já vêm com a folga descontada, então sem `padS`, sem pausa mínima e
 * sem desfazer o corte de pedaço curto (o detector já decidiu o que é fala; o
 * pedaço curto sai no aviso de `shortClipWarnings`, não some).
 */
export const SPEECH_DETECT_PLAN = { padS: 0, minGapS: 0, fragmentS: 0, minClipS: 0.1 } as const;

const ilhaAt = (islands: Interval[], t: number) => islands.find((s) => s.start < t - 1e-6 && s.end > t + 1e-6);

/**
 * Avisos do `build` com o detector de fala (#12089), por sequência, com o
 * tempo NA SEQUÊNCIA:
 *  - emenda com pausa acima de `longJoinPauseS` (cauda do clipe anterior +
 *    entrada do seguinte, medidas até a fala detectada);
 *  - clipe abaixo de `shortClipS` (pulo de imagem visível);
 *  - entrada ou saída de clipe em plena fala (dentro de uma ilha): a entrada
 *    depois do ataque come o começo da palavra ("A empresa", "Porque" na 261104).
 */
export function speechJoinWarnings(
  clips: Array<{ block: string; frameIn: number; frameOut: number; seqStart: number }>,
  islands: Interval[],
  fps: number,
  opts: Partial<Pick<typeof SPEECH_DETECT, "longJoinPauseS" | "shortClipS">> & {
    /** #12101: blocos cuja SAÍDA tem pausa longa de propósito (o respiro da vinheta depois do `titulo`): a emenda para o bloco seguinte não avisa. */
    longJoinOkAfter?: readonly string[];
  } = {},
): string[] {
  const longPause = opts.longJoinPauseS ?? SPEECH_DETECT.longJoinPauseS;
  const okAfter = new Set(opts.longJoinOkAfter ?? []);
  const shortClip = opts.shortClipS ?? SPEECH_DETECT.shortClipS;
  const out: string[] = [];
  const at = (frames: number) => `${(frames / fps).toFixed(2)} s`;
  const speechIn = (a: number, b: number) => islands.filter((s) => s.end > a && s.start < b);
  clips.forEach((c, i) => {
    const a = c.frameIn / fps;
    const b = c.frameOut / fps;
    if (b - a < shortClip - 1e-9) out.push(`${c.block}: clipe de ${(b - a).toFixed(2)} s em ${at(c.seqStart)} da sequência (abaixo de ${shortClip} s: pulo de imagem; conferir se é fala ou estalo)`);
    if (ilhaAt(islands, a)) out.push(`${c.block}: entrada em ${a.toFixed(2)} s do bruto (${at(c.seqStart)} da sequência) cai dentro da fala: pode comer o começo da palavra`);
    if (ilhaAt(islands, b)) out.push(`${c.block}: saída em ${b.toFixed(2)} s do bruto cai dentro da fala: pode comer o fim da palavra`);
    const next = clips[i + 1];
    if (!next) return;
    if (okAfter.has(c.block) && next.block !== c.block) return;
    const mine = speechIn(a, b);
    const theirs = speechIn(next.frameIn / fps, next.frameOut / fps);
    if (!mine.length || !theirs.length) return;
    const tail = Math.max(0, b - Math.min(b, mine[mine.length - 1].end));
    const head = Math.max(0, Math.max(next.frameIn / fps, theirs[0].start) - next.frameIn / fps);
    if (tail + head > longPause + 1e-9) {
      out.push(`${next.block}: emenda em ${at(next.seqStart)} da sequência com ${(tail + head).toFixed(2)} s de pausa (cauda ${tail.toFixed(2)} + entrada ${head.toFixed(2)}, acima de ${longPause} s)`);
    }
  });
  return out;
}
