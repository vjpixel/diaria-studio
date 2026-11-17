/**
 * Verificação independente do XML (#12561), portada de `vjpixel/edicao-video`
 * (`scripts/montagem.ts`, `verifyXml`). O `build` gera o XML e a prévia do
 * MESMO plano; a prévia pode estar certa e o XML que o Premiere importa,
 * errado. Aqui o XML é lido como o Premiere lê:
 *
 *   - os `clipitem` de áudio da faixa principal (`a{n}`, e os pedaços
 *     `a{n}-2`/`a{n}-3` do clipe partido sob a vinheta, remontados num clipe
 *     só, #13249; a vinheta fica de fora), com `start`/`end`/`in`/`out` e a
 *     `timebase` declarada (inclusive NTSC 1000/1001);
 *   - o `<file>` de cada clipe decide o deslocamento: `file-{k}` é o k-ésimo
 *     arquivo do bruto (quadros locais, bruto em vários arquivos #12559),
 *     `file-audio` é a faixa tratada, que já está na linha do tempo global;
 *   - o áudio é remontado só com isso (cortes secos), a energia de cada borda
 *     é medida 40 ms do lado de FORA do corte (o que foi descartado) e a fala
 *     montada é comparada com o roteiro (`reviewPreview`).
 *
 * Diferença do edicao-video: borda que encosta num clipe contíguo no bruto
 * (o trecho de fora entra no clipe vizinho da sequência) não é "som cortado".
 */

export interface XmlAudioClip {
  /** Na sequência, quadros. */
  start: number;
  end: number;
  /** No `<file>` do clipe, quadros (locais do arquivo). */
  in: number;
  out: number;
  /** `id` do `<file>` referenciado (`file-1`, `file-audio`…). */
  fileId: string;
}

export interface ParsedXmlAudio {
  timebase: number;
  ntsc: boolean;
  /** Quadros por segundo efetivos (`timebase * 1000/1001` no NTSC). */
  rate: number;
  clips: XmlAudioClip[];
  /** `<duration>` declarada de cada `<file>` definido no documento (id → quadros). */
  fileDurations: Record<string, number>;
}

/** Lê o `<audio>` da (única) sequência do XML: timebase da sequência e os clipitem de áudio da faixa principal. */
export function parseXmlAudio(xml: string): ParsedXmlAudio {
  const seqAt = xml.indexOf("<sequence");
  if (seqAt < 0) throw new Error("XML sem <sequence>");
  const rateM = xml.slice(seqAt).match(/<rate><timebase>(\d+)<\/timebase><ntsc>(TRUE|FALSE)<\/ntsc><\/rate>/);
  if (!rateM) throw new Error("XML sem <rate> na sequência");
  const timebase = Number(rateM[1]);
  const ntsc = rateM[2] === "TRUE";
  const audioAt = xml.indexOf("<audio><numOutputChannels>", seqAt);
  if (audioAt < 0) throw new Error("XML sem a faixa de áudio da sequência");
  const audio = xml.slice(audioAt);
  const clips: XmlAudioClip[] = [];
  // #13249: o clipe de áudio sob a vinheta sai partido em `a{n}`, `a{n}-2`, `a{n}-3` (#13240, Audio Levels
  // diferente em cada pedaço). Pedaço contíguo ao anterior do MESMO clipe (mesmo `<file>`, sequência e mídia
  // emendadas) volta a ser um clipe só: o plano conta clipes, não pedaços, e a emenda não é corte. Pedaço
  // que não emenda fica separado, e `xmlStructureIssues`/`xmlPlanIssues` acusam.
  const re = /<clipitem id="a(\d+)(?:-(\d+))?">([\s\S]*?)<\/clipitem>/g;
  let lastBase: string | null = null;
  for (const m of audio.matchAll(re)) {
    const base = m[1];
    const isPiece = m[2] !== undefined;
    const body = m[3];
    const num = (tag: string) => {
      const x = body.match(new RegExp(`<${tag}>(-?\\d+)</${tag}>`));
      if (!x) throw new Error(`clipitem de áudio sem <${tag}>`);
      return Number(x[1]);
    };
    const file = body.match(/<file id="([^"]+)"/);
    if (!file) throw new Error("clipitem de áudio sem <file>");
    const clip: XmlAudioClip = { start: num("start"), end: num("end"), in: num("in"), out: num("out"), fileId: file[1] };
    const prev = clips[clips.length - 1];
    if (isPiece && prev && lastBase === base && prev.fileId === clip.fileId && prev.end === clip.start && prev.out === clip.in) {
      prev.end = clip.end;
      prev.out = clip.out;
    } else clips.push(clip);
    lastBase = base;
  }
  const fileDurations: Record<string, number> = {};
  for (const m of xml.matchAll(/<file id="([^"]+)"><name>[\s\S]*?<duration>(\d+)<\/duration>/g)) fileDurations[m[1]] ??= Number(m[2]);
  return { timebase, ntsc, rate: ntsc ? (timebase * 1000) / 1001 : timebase, clips, fileDurations };
}

/**
 * Conferência do XML contra o plano e as mídias (review da PR #12563): sem
 * clipe de áudio nenhum é erro (nunca "passa vazio"); número de clipes e
 * duração diferentes do plano; in/out fora da duração do `<file>` que o clipe
 * aponta (o clipe do 2º arquivo gravado no 1º com tempo global, por exemplo,
 * que o Premiere não toca).
 */
export function xmlPlanIssues(parsed: ParsedXmlAudio, plan: { clips: number; durationFrames: number }): string[] {
  const out: string[] = [];
  if (!parsed.clips.length) return ["nenhum clipitem de áudio na sequência (XML vazio ou ids fora do padrão a{n})"];
  if (parsed.clips.length !== plan.clips) out.push(`${parsed.clips.length} clipes de áudio no XML, ${plan.clips} no plano`);
  const end = parsed.clips[parsed.clips.length - 1].end;
  if (Math.abs(end - plan.durationFrames) > 1) out.push(`sequência com ${end} quadros no XML, ${plan.durationFrames} no plano`);
  parsed.clips.forEach((c, i) => {
    const dur = parsed.fileDurations[c.fileId];
    if (dur === undefined) out.push(`clipe ${i + 1}: ${c.fileId} sem definição (<duration>) no XML`);
    else if (c.in < 0 || c.out > dur) out.push(`clipe ${i + 1}: in/out ${c.in}–${c.out} fora da mídia ${c.fileId} (${dur} quadros)`);
  });
  return out;
}

/** Clipe do XML levado à linha do tempo global do bruto (quadros). */
export interface TimelineClip extends XmlAudioClip {
  gIn: number;
  gOut: number;
}

/**
 * Leva cada clipe à linha do tempo global: `file-{k}` soma o `offsetFrames` do
 * k-ésimo arquivo; o trecho do XML leve `file-{k}-t{início}` (#13219) soma
 * também o início dele; `file-audio` (faixa tratada) já é global. `<file>` que não
 * existe no bruto é erro (o XML aponta outro bruto).
 */
export function toTimeline(parsed: ParsedXmlAudio, offsets: readonly number[]): { clips: TimelineClip[]; errors: string[] } {
  const errors: string[] = [];
  const clips = parsed.clips.map((c, i) => {
    let off = 0;
    if (c.fileId !== "file-audio") {
      // #13219: o trecho do XML leve (`file-{k}-t{início}`) é o arquivo k a partir do quadro local `início`.
      const k = /^file-(\d+)(?:-t(\d+))?$/.exec(c.fileId);
      const o = k ? offsets[Number(k[1]) - 1] : undefined;
      if (o === undefined) errors.push(`clipe ${i + 1}: aponta ${c.fileId}, que não existe no bruto (${offsets.length} arquivo(s))`);
      else off = o + (k?.[2] !== undefined ? Number(k[2]) : 0);
    }
    return { ...c, gIn: c.in + off, gOut: c.out + off };
  });
  return { clips, errors };
}

/** Problemas de estrutura: duração na sequência ≠ na mídia; buraco ou sobreposição entre clipes. */
export function xmlStructureIssues(clips: readonly XmlAudioClip[]): string[] {
  const out: string[] = [];
  clips.forEach((c, i) => {
    if (c.end - c.start !== c.out - c.in) out.push(`clipe ${i + 1}: duração na sequência (${c.end - c.start}) ≠ na mídia (${c.out - c.in})`);
    if (c.out <= c.in) out.push(`clipe ${i + 1}: in ${c.in} ≥ out ${c.out}`);
    if (i > 0 && c.start !== clips[i - 1].end) out.push(`clipe ${i + 1}: ${c.start > clips[i - 1].end ? "buraco" : "sobreposição"} na sequência (${clips[i - 1].end} → ${c.start})`);
  });
  if (clips.length && clips[0].start !== 0) out.push(`clipe 1 começa em ${clips[0].start}, não em 0`);
  return out;
}

export interface EdgeFinding {
  clip: number;
  /** Segundos globais do bruto. */
  inS: number;
  outS: number;
  beforeDb: number;
  afterDb: number;
  /** SOM CORTADO (erro do verify-xml): acima do limiar fixo, ou acima do relativo com energia sustentada que o build abriria (#13194). */
  cutIn: boolean;
  cutOut: boolean;
  /** Energia logo fora acima do limiar da borda, sustentada ou não: o que o build tenta abrir (#13194). */
  overIn: boolean;
  overOut: boolean;
  /** Acima só do limiar relativo, sem ser SOM CORTADO (rajada curta ou sem silêncio até o teto): [aviso], não erro (#13194). */
  softIn: boolean;
  softOut: boolean;
  /** Quanto tempo (s) a energia fica acima do limiar, contínua, a partir da borda para fora (0 quando não passa). */
  aboveInS: number;
  aboveOutS: number;
  /** Limiar aplicado em cada borda (dBFS): o fixo do bruto ou o relativo ao piso local, o menor (#13194). */
  thrInDb: number;
  thrOutDb: number;
}

/** Janela medida do lado de fora de cada borda (o edicao-video usa 40 ms). */
export const EDGE_WINDOW_S = 0.04;

/**
 * Limiar das bordas: um dBFS só para o bruto inteiro, ou um por instante
 * (`localEdgeThreshold`, relativo ao piso de ruído em volta da borda, #13194).
 */
export type EdgeThreshold = number | (((t: number) => number) & { fixedDb?: number });

const thresholdAt = (thr: EdgeThreshold, t: number) => (typeof thr === "number" ? thr : thr(t));
/** O limiar fixo do bruto por trás do relativo: acima dele é SOM CORTADO como sempre foi (nunca afrouxa). */
const fixedOf = (thr: EdgeThreshold) => (typeof thr === "number" ? thr : (thr.fixedDb ?? Number.NEGATIVE_INFINITY));

/**
 * #13194: acima só do limiar relativo (entre o piso local + 3 dB e o fixo), a
 * borda é SOM CORTADO quando a energia de fora é SUSTENTADA (contínua acima do
 * limiar por pelo menos `minS`, perfil de fala e não de clique ou rajada de
 * ruído) e o build acharia silêncio para abri-la até `CUT_EDGE_OPEN.maxS`. Fora
 * disso vira [aviso] no verify-xml, com o limiar e a duração: sala ruidosa nunca
 * reprova o XML. Acima do fixo, nada muda: segue erro. `smearS` desconta
 * metade da janela do envelope (30 ms, `ENVELOPE_DEFAULTS.winS`), o quanto ele
 * estica o fim de cada som. Na 261117 as 4 caudas medidas ficam entre 65 e
 * 75 ms (erro); um estalo de 30 ms sai com ~45 ms (aviso).
 */
export const SUSTAINED_EDGE = { minS: 0.06, stepS: 0.01, smearS: 0.015 } as const;

/**
 * #13194 (decisão do editor de 15/11: na dúvida, silêncio a palavra cortada):
 * a borda só fecha onde a energia caiu ao piso de ruído LOCAL. Na 261117 o
 * piso do bruto em volta de 860 s é -55 dBFS (sala, não os -85 do piso
 * global), e a cauda de "cair" seguia a -48..-52 dBFS depois do corte: abaixo
 * dos -45 fixos, ninguém via, e o Whisper do final ouviu "caiu".
 *
 * - `windowS`: o piso é medido em ±4 s em volta da borda, o bastante para
 *   pegar as pausas entre frases;
 * - `percentile`: o 10º percentil do envelope nessa janela (o ruído de fundo,
 *   não a fala); quadro em zero digital (-120) não entra;
 * - `marginDb`: o silêncio é o piso + 3 dB. O ruído de sala estável oscila
 *   ~2 dB acima do p10 na janela de 40 ms (261117, 900 s: p10 -56, máximo -54);
 * - `minThresholdDb`: em bruto muito quieto (piso de -80 ou menos) o limiar
 *   não desce de -60 dBFS: respiro e estalo baixos não viram "som cortado".
 *
 * O limiar relativo só desce: nunca passa do limiar fixo do bruto (o
 * `noiseDb` do silences.meta.json). Em sala ruidosa (piso perto da fala) ele
 * fica no fixo. O que segura a abertura em sala ruidosa é o teto de
 * `openCutSoundEdges` (`CUT_EDGE_OPEN.maxS`, a palavra vizinha e o clipe
 * vizinho), nunca o limiar.
 */
export const LOCAL_FLOOR_EDGE = { windowS: 4, percentile: 0.1, marginDb: 3, minThresholdDb: -60 } as const;

/** Envelope de energia (o `energyEnvelope` do refino): `db[i]` no instante `i * hopS`. */
export interface LevelEnvelope {
  hopS: number;
  db: ArrayLike<number>;
}

/** Piso de ruído local em `t`: percentil do envelope em `[t - windowS, t + windowS]`, sem o zero digital. Sem quadro medido, `null`. */
export function localFloorDb(env: LevelEnvelope, t: number, opts: { windowS?: number; percentile?: number } = {}): number | null {
  const windowS = opts.windowS ?? LOCAL_FLOOR_EDGE.windowS;
  const p = opts.percentile ?? LOCAL_FLOOR_EDGE.percentile;
  const lo = Math.max(0, Math.floor((t - windowS) / env.hopS));
  const hi = Math.min(env.db.length - 1, Math.ceil((t + windowS) / env.hopS));
  const vals: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const d = env.db[i];
    if (Number.isFinite(d) && d > -119.5) vals.push(d);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
}

/**
 * Limiar das bordas relativo ao piso local (#13194): `min(fixo, max(-60, piso
 * local + 3 dB))`, por instante, com cache por quadro do envelope. Sem piso
 * medido em volta (fora do áudio, ou só zero digital), o fixo.
 */
export function localEdgeThreshold(
  env: LevelEnvelope,
  fixedDb: number,
  opts: { windowS?: number; percentile?: number; marginDb?: number; minThresholdDb?: number } = {},
): ((t: number) => number) & { fixedDb: number } {
  const margin = opts.marginDb ?? LOCAL_FLOOR_EDGE.marginDb;
  const minDb = opts.minThresholdDb ?? LOCAL_FLOOR_EDGE.minThresholdDb;
  const cache = new Map<number, number>();
  const at = (t: number) => {
    const k = Math.round(t / env.hopS);
    let v = cache.get(k);
    if (v === undefined) {
      const floor = localFloorDb(env, k * env.hopS, opts);
      v = floor === null ? fixedDb : Math.min(fixedDb, Math.max(minDb, floor + margin));
      cache.set(k, v);
    }
    return v;
  };
  return Object.assign(at, { fixedDb });
}

/**
 * Energia logo fora de cada borda (`levelDb(a, b)` = maior dBFS em [a, b] do
 * áudio do bruto). Acima do limiar da borda (`thresholdDb`: fixo, ou relativo
 * ao piso local via `localEdgeThreshold`, #13194) = som cortado, menos quando o trecho
 * de fora está dentro de outro clipe contíguo no bruto (fala que continua no
 * clipe seguinte/anterior da sequência).
 */
export function edgeFindings(
  clips: readonly TimelineClip[],
  rate: number,
  levelDb: (a: number, b: number) => number,
  thresholdDb: EdgeThreshold,
  windowS = EDGE_WINDOW_S,
  /** Limites (s globais) dos arquivos do bruto em vários arquivos: a janela nunca lê o arquivo vizinho (borda na emenda não é corte). */
  bounds?: ReadonlyArray<{ start: number; end: number }>,
  /** Palavras, clipes `filler` e teto: o que o build usa para decidir até onde abre (#13194). */
  ctx: EdgeOpenContext = {},
): EdgeFinding[] {
  // Só o clipe VIZINHO na sequência cobre a borda (fala que segue no próximo clipe); outro clipe qualquer que
  // contenha o trecho não impede o corte audível (review da PR #12563).
  const coveredBy = (k: TimelineClip | undefined, a: number, b: number) => !!k && k.gIn / rate <= a + 1e-6 && k.gOut / rate >= b - 1e-6;
  const spanOf = (t: number) => bounds?.find((s) => t >= s.start - 1e-6 && t < s.end) ?? { start: 0, end: Number.POSITIVE_INFINITY };
  const FLOOR = -120;
  const fixedDb = fixedOf(thresholdDb);
  const { minS, stepS, smearS } = SUSTAINED_EDGE;
  const limitCtx: EdgeOpenContext = { ...ctx, bounds: ctx.bounds ?? bounds };
  // #13194: o clipe `filler` (pausa da vinheta, #13239) nasceu de um silêncio a -45 com folga; ele é julgado só
  // pelo limiar fixo, senão o relativo acusaria (e o build abriria) a cauda de -48 que ele encosta.
  const thrFor = (i: number, t: number) => (ctx.fixedOnly?.[i] && Number.isFinite(fixedDb) ? fixedDb : thresholdAt(thresholdDb, t));
  // Energia contínua acima do limiar a partir da borda, para fora (dir -1 = antes da entrada), até `limit`.
  const runAbove = (t0: number, dir: 1 | -1, thr: number, limit: number) => {
    let n = 0;
    for (let t = t0; dir > 0 ? t < limit - 1e-9 : t > limit + 1e-9; t += dir * stepS) {
      const x = dir > 0 ? levelDb(t, Math.min(limit, t + stepS)) : levelDb(Math.max(limit, t - stepS), t);
      if (!(x > thr)) break;
      n++;
    }
    // Desconta o quanto a janela do envelope estica o fim do som: a duração do som, não a do envelope.
    return Math.max(0, Math.min(n * stepS, Math.abs(limit - t0)) - smearS);
  };
  // O build acharia silêncio (janela inteira abaixo do limiar) antes do teto? Quadro a quadro, como ele abre.
  const frameS = 1 / rate;
  const silenceWithin = (t0: number, dir: 1 | -1, thr: number, limit: number) => {
    for (let t = t0 + dir * frameS; dir > 0 ? t <= limit + 1e-9 : t >= limit - 1e-9; t += dir * frameS) {
      if (!((dir > 0 ? levelDb(t, t + windowS) : levelDb(t - windowS, t)) > thr)) return true;
    }
    return false;
  };
  return clips.map((c, i) => {
    const a = c.gIn / rate;
    const b = c.gOut / rate;
    const fs = spanOf((a + b) / 2);
    const bLo = Math.max(0, fs.start, a - windowS);
    const aHi = Math.min(fs.end, b + windowS);
    const beforeDb = bLo < a - 1e-6 ? levelDb(bLo, a) : FLOOR;
    const afterDb = aHi > b + 1e-6 ? levelDb(b, aHi) : FLOOR;
    const thrInDb = thrFor(i, a);
    const thrOutDb = thrFor(i, b);
    const overIn = beforeDb > thrInDb && !coveredBy(clips[i - 1], bLo, a);
    const overOut = afterDb > thrOutDb && !coveredBy(clips[i + 1], b, aHi);
    // Entre o relativo e o fixo: só é erro o que o build abriria (os mesmos limites dele: teto, arquivo, palavra
    // vizinha com folga, clipe vizinho). Calculado só quando precisa (custa uma varredura das palavras).
    const hardIn = beforeDb > fixedDb;
    const hardOut = afterDb > fixedDb;
    const inLimit = overIn && !hardIn ? edgeOpenLimitS(clips, rate, i, "in", limitCtx) : a;
    const outLimit = overOut && !hardOut ? edgeOpenLimitS(clips, rate, i, "out", limitCtx) : b;
    const aboveInS = overIn ? runAbove(a, -1, thrInDb, overIn && !hardIn ? inLimit : Math.max(0, fs.start, a - CUT_EDGE_OPEN.maxS)) : 0;
    const aboveOutS = overOut ? runAbove(b, 1, thrOutDb, overOut && !hardOut ? outLimit : Math.min(fs.end, b + CUT_EDGE_OPEN.maxS)) : 0;
    const cutIn = overIn && (hardIn || (aboveInS >= minS - 1e-9 && silenceWithin(a, -1, thrInDb, inLimit)));
    const cutOut = overOut && (hardOut || (aboveOutS >= minS - 1e-9 && silenceWithin(b, 1, thrOutDb, outLimit)));
    return {
      clip: i + 1, inS: a, outS: b, beforeDb, afterDb, cutIn, cutOut, overIn, overOut,
      softIn: overIn && !cutIn, softOut: overOut && !cutOut, aboveInS, aboveOutS, thrInDb, thrOutDb,
    };
  });
}

// ── Borda com SOM CORTADO aberta pelo build (#13194) ──────────────────────

/** Quanto o build pode abrir cada borda com SOM CORTADO até achar o silêncio (#13194). */
export const CUT_EDGE_OPEN = { maxS: 0.6 } as const;

/**
 * Quanto a abertura pode entrar no tempo do Whisper da palavra vizinha de fora (#13194): a cauda da palavra do
 * clipe que o Whisper deu à seguinte. Nunca mais que metade da palavra vizinha.
 */
export const NEIGHBOR_WORD_GRACE_S = 0.15;

/** Palavra de fora a menos disto da borda pode ser a do próprio clipe (`ownWord`). */
const OWN_WORD_GAP_S = 0.15;

type EdgeWord = { start: number; end: number; text?: string };

/** O que limita a abertura de uma borda (#13194), comum ao build (`openCutSoundEdges`) e ao `verify-xml` (`edgeFindings`). */
export interface EdgeOpenContext {
  /** Palavras do bruto (transcript + retranscrição das bordas): a vizinha INTEIRA de fora limita, com folga. */
  words?: ReadonlyArray<EdgeWord>;
  /** A palavra de fora colada na borda que é do PRÓPRIO clipe `i` (1ª/última do roteiro dele): não limita. */
  ownWord?: (clipIndex: number, edge: "in" | "out", w: EdgeWord) => boolean;
  /** Clipes julgados só pelo limiar fixo (o `filler` da pausa da vinheta, #13239): o build os abre só acima do fixo, como antes do #13194; seguem limitando os vizinhos. */
  fixedOnly?: ReadonlyArray<boolean>;
  maxOpenS?: number;
  /** Fim do bruto (s); sem ele, só o arquivo e o teto limitam. */
  durationS?: number;
  bounds?: ReadonlyArray<{ start: number; end: number }>;
}

/**
 * #13194: até onde o build pode abrir a borda `edge` do clipe `i` (s globais):
 * o teto (`CUT_EDGE_OPEN.maxS`), o arquivo do bruto, a palavra vizinha INTEIRA
 * de fora (com folga de `NEIGHBOR_WORD_GRACE_S`, nunca mais que metade dela; a
 * do próprio roteiro colada na borda não conta) e o clipe mais próximo da
 * sequência do mesmo lado (o áudio nunca se repete).
 */
export function edgeOpenLimitS(clips: readonly TimelineClip[], rate: number, i: number, edge: "in" | "out", ctx: EdgeOpenContext = {}): number {
  const eps = 1e-6;
  const c = clips[i];
  const a = c.gIn / rate;
  const b = c.gOut / rate;
  const mid = (a + b) / 2;
  const span = ctx.bounds?.find((s) => mid >= s.start - eps && mid < s.end) ?? { start: 0, end: ctx.durationS ?? Number.POSITIVE_INFINITY };
  const maxOpen = ctx.maxOpenS ?? CUT_EDGE_OPEN.maxS;
  const words = ctx.words ?? [];
  // O Whisper costuma começar a palavra seguinte em cima da cauda da anterior ("No[941,40-942,16]" na 261117, com a
  // cauda de "ele." caindo até 941,55 s e o piso dali até 942 s). A abertura pode entrar até `NEIGHBOR_WORD_GRACE_S`
  // (nunca mais que metade da palavra) no tempo dela: ela para no 1º silêncio, então só passa do tempo do Whisper
  // quando a cauda emenda nele, e o que leva é a cauda, não a palavra.
  const graceOf = (w: EdgeWord) => Math.min(NEIGHBOR_WORD_GRACE_S, Math.max(0, (w.end - w.start) / 2));
  let lim = edge === "in" ? Math.max(0, span.start, a - maxOpen) : Math.min(span.end, ctx.durationS ?? Number.POSITIVE_INFINITY, b + maxOpen);
  for (const w of words) {
    if (edge === "in") {
      if (w.end <= a + eps && !(a - w.end < OWN_WORD_GAP_S && ctx.ownWord?.(i, edge, w))) lim = Math.max(lim, w.end - graceOf(w));
    } else if (w.start >= b - eps && !(w.start - b < OWN_WORD_GAP_S && ctx.ownWord?.(i, edge, w))) lim = Math.min(lim, w.start + graceOf(w));
  }
  clips.forEach((o, j) => {
    if (j === i) return;
    if (edge === "in" && o.gOut <= c.gIn) lim = Math.max(lim, o.gOut / rate);
    if (edge === "out" && o.gIn >= c.gOut) lim = Math.min(lim, o.gIn / rate);
  });
  return lim;
}

/** Clipe da sequência como o build monta (s e quadros globais do bruto). */
export interface OpenableClip {
  block: string;
  srcIn: number;
  srcOut: number;
  frameIn: number;
  frameOut: number;
  /** Pausa da vinheta (#13239): só o limiar fixo vale nas bordas dela, então ela só abre acima do fixo, como antes do #13194. */
  filler?: boolean;
}

export interface OpenedEdge<B extends string = string> {
  block: B;
  edge: "in" | "out";
  from: number;
  to: number;
  /** Energia logo fora da borda antes (a que o verify-xml acusaria) e depois de abrir. */
  fromDb: number;
  toDb: number;
  /** Limiar da borda (dBFS) em que ela foi aberta (#13194: relativo ao piso local quando há envelope). */
  thresholdDb: number;
}

export interface UnresolvedEdge<B extends string = string> {
  block: B;
  edge: "in" | "out";
  atS: number;
  db: number;
  thresholdDb: number;
  /** O verify-xml acusa como erro (SOM CORTADO); `false` = só [aviso] (rajada curta, sem silêncio até o teto). */
  error: boolean;
  aboveS: number;
}

/**
 * #13194 (decisão do editor de 15/11: na dúvida, silêncio a palavra cortada):
 * o build aplica o critério do `verify-xml` (`edgeFindings`, a mesma janela de
 * 40 ms do lado de fora e o mesmo limiar) aos clipes que vai gravar no XML e
 * abre a borda com SOM CORTADO, quadro a quadro, até o 1º ponto em que o lado
 * de fora fica no silêncio. A abertura para em `maxOpenS`, no limite do arquivo
 * do bruto, na palavra vizinha INTEIRA de fora (`words`, a que termina antes da
 * entrada ou começa depois da saída, com folga de `NEIGHBOR_WORD_GRACE_S` para a
 * cauda que o Whisper deu a ela, #13194; a palavra que a borda corta ao meio é a
 * que se quer reabrir, e a 1ª/última do próprio roteiro do clipe colada na
 * borda também, via `ownWord`) e no clipe mais próximo da sequência do mesmo lado (o
 * áudio nunca se repete). Sem silêncio até lá, a borda fica como estava e sai
 * em `unresolved`, que o `verify-xml` segue acusando.
 */
export function openCutSoundEdges<T extends OpenableClip>(
  clips: readonly T[],
  fps: number,
  levelDb: (a: number, b: number) => number,
  thresholdDb: EdgeThreshold,
  opts: {
    durationS: number;
    words?: ReadonlyArray<{ start: number; end: number; text?: string }>;
    /** A palavra de fora colada na borda que é do PRÓPRIO clipe (a 1ª/última do roteiro dele, com o tempo do Whisper atrasado): não limita a abertura. */
    ownWord?: (clip: T, edge: "in" | "out", w: { start: number; end: number; text?: string }) => boolean;
    bounds?: ReadonlyArray<{ start: number; end: number }>;
    maxOpenS?: number;
    windowS?: number;
  },
): { clips: T[]; opened: OpenedEdge<T["block"]>[]; unresolved: UnresolvedEdge<T["block"]>[] } {
  const windowS = opts.windowS ?? EDGE_WINDOW_S;
  const eps = 1e-6;
  const timeline = (cs: readonly T[]): TimelineClip[] => cs.map((c) => ({ start: 0, end: 0, in: c.frameIn, out: c.frameOut, fileId: "file-1", gIn: c.frameIn, gOut: c.frameOut }));
  const ctxOf = (cs: readonly T[]): EdgeOpenContext => ({
    words: opts.words,
    ownWord: opts.ownWord ? (j, edge, w) => opts.ownWord!(cs[j], edge, w) : undefined,
    fixedOnly: cs.map((c) => !!c.filler),
    maxOpenS: opts.maxOpenS,
    durationS: opts.durationS,
    bounds: opts.bounds,
  });
  const findings = (cs: readonly T[]) => edgeFindings(timeline(cs), fps, levelDb, thresholdDb, windowS, opts.bounds, ctxOf(cs));
  const cur = clips.map((c) => ({ ...c }));
  const opened: OpenedEdge<T["block"]>[] = [];
  const first = findings(cur);
  for (let i = 0; i < cur.length; i++) {
    for (const edge of ["in", "out"] as const) {
      const f0 = first[i];
      if (!(edge === "in" ? f0.overIn : f0.overOut)) continue;
      const c = cur[i];
      if (edge === "in") {
        const lo = edgeOpenLimitS(timeline(cur), fps, i, edge, ctxOf(cur));
        const loFrame = Math.ceil(lo * fps - eps);
        for (let fr = c.frameIn - 1; fr >= loFrame; fr--) {
          const trial = cur.map((x, j) => (j === i ? { ...x, frameIn: fr, srcIn: fr / fps } : x));
          const e = findings(trial)[i];
          if (!e.overIn) {
            opened.push({ block: c.block, edge, from: c.srcIn, to: fr / fps, fromDb: f0.beforeDb, toDb: e.beforeDb, thresholdDb: e.thrInDb });
            cur[i] = trial[i];
            break;
          }
        }
      } else {
        const hi = edgeOpenLimitS(timeline(cur), fps, i, edge, ctxOf(cur));
        const hiFrame = Math.floor(hi * fps + eps);
        for (let fr = c.frameOut + 1; fr <= hiFrame; fr++) {
          const trial = cur.map((x, j) => (j === i ? { ...x, frameOut: fr, srcOut: fr / fps } : x));
          const e = findings(trial)[i];
          if (!e.overOut) {
            opened.push({ block: c.block, edge, from: c.srcOut, to: fr / fps, fromDb: f0.afterDb, toDb: e.afterDb, thresholdDb: e.thrOutDb });
            cur[i] = trial[i];
            break;
          }
        }
      }
    }
  }
  const unresolved: UnresolvedEdge<T["block"]>[] = [];
  findings(cur).forEach((e, i) => {
    if (e.overIn) unresolved.push({ block: cur[i].block, edge: "in", atS: e.inS, db: e.beforeDb, thresholdDb: e.thrInDb, error: e.cutIn, aboveS: e.aboveInS });
    if (e.overOut) unresolved.push({ block: cur[i].block, edge: "out", atS: e.outS, db: e.afterDb, thresholdDb: e.thrOutDb, error: e.cutOut, aboveS: e.aboveOutS });
  });
  return { clips: cur, opened, unresolved };
}

/** Trechos do bruto (s globais) na ordem da sequência: a entrada do `ffmpeg` que remonta o áudio só pelo XML. */
export function assemblySegments(clips: readonly TimelineClip[], rate: number): Array<{ start: number; end: number }> {
  return clips.map((c) => ({ start: c.gIn / rate, end: c.gOut / rate }));
}

/** Início (s) de cada clipe na sequência depois do 1º: os cortes, para a revisão ignorar a borda. */
export function sequenceCutsS(clips: readonly XmlAudioClip[], rate: number): number[] {
  return clips.slice(1).map((c) => c.start / rate);
}

const edgeMark = (cut: boolean, soft: boolean, thr: number, aboveS: number) =>
  cut
    ? ` ← SOM CORTADO (limiar ${thr.toFixed(0)} dB)`
    : soft
      ? ` ← [aviso] acima do piso local (limiar ${thr.toFixed(0)} dB) por ${Math.round(aboveS * 1000)} ms, sem fala sustentada ou sem silêncio até ${CUT_EDGE_OPEN.maxS} s`
      : "";

/** Bordas que viram só [aviso] no verify-xml (#13194): acima do limiar relativo, sem ser SOM CORTADO. */
export function softEdgeWarnings(edges: readonly EdgeFinding[], clock: (s: number) => string): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if (e.softIn) out.push(`clipe ${e.clip}: entrada em ${clock(e.inS)} com ${e.beforeDb.toFixed(0)} dB fora, acima do limiar relativo ${e.thrInDb.toFixed(0)} dB por ${Math.round(e.aboveInS * 1000)} ms (rajada curta ou sem silêncio até ${CUT_EDGE_OPEN.maxS} s): conferir no Premiere (#13194)`);
    if (e.softOut) out.push(`clipe ${e.clip}: saída em ${clock(e.outS)} com ${e.afterDb.toFixed(0)} dB fora, acima do limiar relativo ${e.thrOutDb.toFixed(0)} dB por ${Math.round(e.aboveOutS * 1000)} ms (rajada curta ou sem silêncio até ${CUT_EDGE_OPEN.maxS} s): conferir no Premiere (#13194)`);
  }
  return out;
}

export function edgeLine(e: EdgeFinding, clock: (s: number) => string): string {
  return (
    `${String(e.clip).padStart(2)}  ${clock(e.inS)}–${clock(e.outS)}  antes da entrada ${e.beforeDb.toFixed(0)} dB${edgeMark(e.cutIn, e.softIn, e.thrInDb, e.aboveInS)}` +
    `  depois da saída ${e.afterDb.toFixed(0)} dB${edgeMark(e.cutOut, e.softOut, e.thrOutDb, e.aboveOutS)}`
  );
}

// ── Ritmo da prévia (portado do `review` do edicao-video) ─────────────────

export interface Pause {
  /** Início da pausa na prévia (s). */
  at: number;
  durationS: number;
  /** A pausa cai num corte da sequência (respiro do corte) ou dentro da fala. */
  atCut: boolean;
}

/** Pausa acima disto entre falas = respiro sobrando (apertar o padding do corte). */
export const LONG_PAUSE_S = 0.3;

/**
 * Pausas longas da prévia (#12561, o "ritmo" do edicao-video): silêncios acima
 * de `LONG_PAUSE_S`, fora do respiro final, marcando se caem num corte.
 */
export function longPauses(silences: ReadonlyArray<{ start: number; end: number }>, cutsS: readonly number[], durationS: number, opts: { minS?: number; tailS?: number } = {}): Pause[] {
  const minS = opts.minS ?? LONG_PAUSE_S;
  const tail = opts.tailS ?? 0.2;
  return silences
    .filter((s) => s.end - s.start > minS && s.end < durationS - tail && s.start > 0.05)
    .map((s) => ({ at: Math.round(s.start * 100) / 100, durationS: Math.round((s.end - s.start) * 100) / 100, atCut: cutsS.some((t) => t >= s.start - 0.05 && t <= s.end + 0.05) }));
}
