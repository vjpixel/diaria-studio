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

/** Por que uma borda acima do limiar relativo não é SOM CORTADO (#13194). */
export type SoftEdgeReason = "curta" | "sem-abertura";

/** O que segura a abertura de uma borda (#13194). */
export type EdgeLimitKind = "teto" | "arquivo" | "palavra vizinha" | "clipe vizinho";

/**
 * Cada borda tem três estados (#13194):
 * - `over`: a energia logo fora (40 ms) passa do limiar da borda;
 * - `cut` (SOM CORTADO, erro do verify-xml): acima do limiar fixo do bruto, como sempre foi; ou, entre o
 *   relativo e o fixo, energia SUSTENTADA (`SUSTAINED_EDGE`) que o build abriria (há silêncio antes do limite
 *   da abertura, `edgeOpenLimit`);
 * - `soft` ([aviso]): acima só do relativo, sem ser `cut`: `curta` (estalo, respiro, rajada de ruído) ou
 *   `sem-abertura` (sustentada, mas o build não abre: provável fala cortada, conferir no Premiere).
 * `open` é o que o build tenta abrir: acima do fixo, ou acima do relativo com energia sustentada.
 */
export interface EdgeFinding {
  clip: number;
  /** Segundos globais do bruto. */
  inS: number;
  outS: number;
  beforeDb: number;
  afterDb: number;
  cutIn: boolean;
  cutOut: boolean;
  overIn: boolean;
  overOut: boolean;
  openIn: boolean;
  openOut: boolean;
  softIn: boolean;
  softOut: boolean;
  softReasonIn?: SoftEdgeReason;
  softReasonOut?: SoftEdgeReason;
  /** No `sem-abertura`: o que segurou a abertura e onde (s globais). */
  limitIn?: EdgeLimitKind;
  limitOut?: EdgeLimitKind;
  limitInS?: number;
  limitOutS?: number;
  /** Quanto tempo (s) a energia fica acima do limiar, contínua, da borda para fora, até o teto `CUT_EDGE_OPEN.maxS` (0 quando não passa). */
  aboveInS: number;
  aboveOutS: number;
  /** Limiar aplicado em cada borda (dBFS): o fixo do bruto ou o relativo ao piso local, o menor (#13194). */
  thrInDb: number;
  thrOutDb: number;
}

/** Janela medida do lado de fora de cada borda (o edicao-video usa 40 ms). */
export const EDGE_WINDOW_S = 0.04;

/**
 * Limiar das bordas: um dBFS só para o bruto inteiro (o limiar fixo, `noiseDb`
 * do silences.meta.json), ou um por instante relativo ao piso de ruído em volta
 * da borda (`localEdgeThreshold`, #13194), que carrega o fixo por trás.
 */
export type EdgeThreshold = number | (((t: number) => number) & { fixedDb: number });

const thresholdAt = (thr: EdgeThreshold, t: number) => (typeof thr === "number" ? thr : thr(t));
/** O limiar fixo do bruto por trás do relativo: acima dele é SOM CORTADO como sempre foi (nunca afrouxa). */
const fixedOf = (thr: EdgeThreshold) => (typeof thr === "number" ? thr : thr.fixedDb);

/**
 * #13194: entre o limiar relativo (piso local + 3 dB) e o fixo do bruto, a
 * energia de fora só conta como fala quando é SUSTENTADA: contínua acima do
 * limiar por pelo menos `minS`, perfil de fala e não de estalo, respiro curto
 * ou rajada de ruído. Só ela vira SOM CORTADO (se o build a abriria) e só ela o
 * build abre; a curta vira [aviso] e a borda fica. Acima do fixo nada muda.
 * `smearS` desconta metade da janela do envelope (30 ms,
 * `ENVELOPE_DEFAULTS.winS`), o quanto ele estica o fim de cada som. Na 261117
 * as 4 caudas medidas ficam entre 65 e 75 ms (erro); um estalo de 30 ms sai com
 * ~45 ms (aviso).
 */
export const SUSTAINED_EDGE = { minS: 0.06, stepS: 0.01, smearS: 0.015 } as const;

/**
 * #13194 (decisão do editor de 15/11: na dúvida, silêncio a palavra cortada):
 * a borda só fecha onde a energia caiu ao piso de ruído LOCAL. Na 261117 o
 * piso do bruto em volta de 860 s é -55 dBFS (sala, não os -85 do piso
 * global), e a cauda de "cair" seguia a -48..-52 dBFS depois do corte: abaixo
 * do limiar fixo do bruto (`noiseDb`, -45 ali), ninguém via, e o Whisper do
 * final ouviu "caiu".
 *
 * - `windowS`: o piso é medido em ±4 s em volta da borda, o bastante para
 *   pegar as pausas entre frases;
 * - `percentile`: o 10º percentil do envelope nessa janela (o ruído de fundo,
 *   não a fala); quadro em zero digital (-120) não entra;
 * - `marginDb`: o silêncio é o piso + 3 dB. O ruído de sala estável oscila
 *   ~2 dB acima do p10 na janela de 40 ms (261117, 900 s: p10 -56, máximo -54);
 * - `minThresholdDb`: em bruto quieto (piso abaixo de -63 dBFS, onde piso + 3
 *   passaria de -60) o limiar não desce de -60 dBFS: respiro e estalo baixos
 *   não viram "som cortado".
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

// ── Limites da abertura (#13194) ──────────────────────────────────────────

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
  /** Limites (s globais) dos arquivos do bruto em vários arquivos: a janela nunca lê o arquivo vizinho (borda na emenda não é corte) e a abertura nunca passa para ele. */
  bounds?: ReadonlyArray<{ start: number; end: number }>;
}

/** O contexto de `edgeFindings`: o da abertura mais a janela medida do lado de fora. */
export interface EdgeFindingsContext extends EdgeOpenContext {
  windowS?: number;
}

/**
 * #13194: até onde o build pode abrir a borda `edge` do clipe `i` (s globais) e
 * o que segura: o teto (`CUT_EDGE_OPEN.maxS`), o arquivo do bruto, a palavra
 * vizinha INTEIRA de fora (com folga de `NEIGHBOR_WORD_GRACE_S`, nunca mais que
 * metade dela; a do próprio roteiro colada na borda não conta) e o clipe mais
 * próximo da sequência do mesmo lado (o áudio nunca se repete).
 *
 * A folga existe porque o Whisper costuma começar a palavra seguinte em cima
 * da cauda da anterior ("No[941,40-942,16]" na 261117, com a cauda de "ele."
 * caindo até 941,55 s e o piso dali até 942 s). A abertura para no 1º
 * silêncio, então só passa do tempo do Whisper quando a cauda emenda nele.
 * Limite aceito: palavra vizinha que começa com um vale curto (a oclusão de um
 * "t", ~50 ms) pode ter até 0,15 s do começo dela incluído, se o vale ficar
 * abaixo do limiar (é ele o 1º silêncio).
 */
export function edgeOpenLimit(clips: readonly TimelineClip[], rate: number, i: number, edge: "in" | "out", ctx: EdgeOpenContext = {}): { s: number; kind: EdgeLimitKind } {
  const eps = 1e-6;
  const c = clips[i];
  const a = c.gIn / rate;
  const b = c.gOut / rate;
  const mid = (a + b) / 2;
  const span = ctx.bounds?.find((s) => mid >= s.start - eps && mid < s.end) ?? { start: 0, end: Number.POSITIVE_INFINITY };
  const end = Math.min(span.end, ctx.durationS ?? Number.POSITIVE_INFINITY);
  const maxOpen = ctx.maxOpenS ?? CUT_EDGE_OPEN.maxS;
  const graceOf = (w: EdgeWord) => Math.min(NEIGHBOR_WORD_GRACE_S, Math.max(0, (w.end - w.start) / 2));
  let s: number;
  let kind: EdgeLimitKind;
  // `better(x)`: x segura mais que o limite atual (mais perto da borda).
  const better = (x: number) => (edge === "in" ? x > s + eps : x < s - eps);
  if (edge === "in") {
    s = a - maxOpen;
    kind = "teto";
    if (Math.max(0, span.start) > s + eps) [s, kind] = [Math.max(0, span.start), "arquivo"];
  } else {
    s = b + maxOpen;
    kind = "teto";
    if (end < s - eps) [s, kind] = [end, "arquivo"];
  }
  for (const w of ctx.words ?? []) {
    if (edge === "in") {
      if (w.end <= a + eps && !(a - w.end < OWN_WORD_GAP_S && ctx.ownWord?.(i, edge, w)) && better(w.end - graceOf(w))) [s, kind] = [w.end - graceOf(w), "palavra vizinha"];
    } else if (w.start >= b - eps && !(w.start - b < OWN_WORD_GAP_S && ctx.ownWord?.(i, edge, w)) && better(w.start + graceOf(w))) [s, kind] = [w.start + graceOf(w), "palavra vizinha"];
  }
  clips.forEach((o, j) => {
    if (j === i) return;
    if (edge === "in" && o.gOut <= c.gIn && better(o.gOut / rate)) [s, kind] = [o.gOut / rate, "clipe vizinho"];
    if (edge === "out" && o.gIn >= c.gOut && better(o.gIn / rate)) [s, kind] = [o.gIn / rate, "clipe vizinho"];
  });
  return { s, kind };
}

// ── Bordas: SOM CORTADO, aviso e o que o build abre (#12561, #13194) ──────

/**
 * Energia logo fora de cada borda (`levelDb(a, b)` = maior dBFS em [a, b] do
 * áudio do bruto) contra o limiar da borda (`thresholdDb`: o fixo do bruto, ou
 * o relativo ao piso local via `localEdgeThreshold`, #13194). Estados de cada
 * borda em `EdgeFinding`: `over` (passa do limiar), `cut` (SOM CORTADO: acima
 * do fixo, ou sustentada e abrível pelos mesmos limites do build), `soft`
 * ([aviso]: `curta` ou `sem-abertura`) e `open` (o que o build abre). O trecho
 * de fora dentro do clipe VIZINHO na sequência, contíguo no bruto, não conta
 * (fala que continua no clipe seguinte/anterior). Clipe `fixedOnly` (o filler
 * da vinheta) só tem o limiar fixo. Com limiar numérico (só o fixo), `over` =
 * `cut` = `open`, como antes do #13194.
 */
export function edgeFindings(
  clips: readonly TimelineClip[],
  rate: number,
  levelDb: (a: number, b: number) => number,
  thresholdDb: EdgeThreshold,
  ctx: EdgeFindingsContext = {},
): EdgeFinding[] {
  const windowS = ctx.windowS ?? EDGE_WINDOW_S;
  const bounds = ctx.bounds;
  // Só o clipe VIZINHO na sequência cobre a borda (fala que segue no próximo clipe); outro clipe qualquer que
  // contenha o trecho não impede o corte audível (review da PR #12563).
  const coveredBy = (k: TimelineClip | undefined, a: number, b: number) => !!k && k.gIn / rate <= a + 1e-6 && k.gOut / rate >= b - 1e-6;
  const spanOf = (t: number) => bounds?.find((s) => t >= s.start - 1e-6 && t < s.end) ?? { start: 0, end: Number.POSITIVE_INFINITY };
  const FLOOR = -120;
  const fixedDb = fixedOf(thresholdDb);
  const { minS, stepS, smearS } = SUSTAINED_EDGE;
  const maxOpen = ctx.maxOpenS ?? CUT_EDGE_OPEN.maxS;
  // #13194: o clipe `filler` (pausa da vinheta, #13239) nasceu de um silêncio no limiar fixo do bruto, com folga;
  // ele é julgado só pelo fixo, senão o relativo acusaria (e o build abriria) a cauda que ele encosta.
  const thrFor = (i: number, t: number) => (ctx.fixedOnly?.[i] ? fixedDb : thresholdAt(thresholdDb, t));
  // Energia contínua acima do limiar a partir da borda, para fora (dir -1 = antes da entrada), até `limit` (o teto).
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
  // O build acharia silêncio (janela inteira abaixo do limiar) antes do limite? Quadro a quadro, como ele abre.
  const frameS = 1 / rate;
  const silenceWithin = (t0: number, dir: 1 | -1, thr: number, limit: number) => {
    for (let t = t0 + dir * frameS; dir > 0 ? t <= limit + 1e-9 : t >= limit - 1e-9; t += dir * frameS) {
      if (!((dir > 0 ? levelDb(t, t + windowS) : levelDb(t - windowS, t)) > thr)) return true;
    }
    return false;
  };
  type Side = { over: boolean; cut: boolean; open: boolean; soft: boolean; reason?: SoftEdgeReason; limit?: EdgeLimitKind; limitS?: number; aboveS: number };
  const judge = (i: number, edge: "in" | "out", t0: number, db: number, thr: number, covered: boolean, fs: { start: number; end: number }): Side => {
    const over = db > thr && !covered;
    if (!over) return { over: false, cut: false, open: false, soft: false, aboveS: 0 };
    const dir = edge === "in" ? -1 : 1;
    const teto = dir > 0 ? Math.min(fs.end, ctx.durationS ?? Number.POSITIVE_INFINITY, t0 + maxOpen) : Math.max(0, fs.start, t0 - maxOpen);
    const aboveS = runAbove(t0, dir, thr, teto);
    const sustained = aboveS >= minS - 1e-9;
    if (db > fixedDb) return { over, cut: true, open: true, soft: false, aboveS };
    if (!sustained) return { over, cut: false, open: false, soft: true, reason: "curta", aboveS };
    const lim = edgeOpenLimit(clips, rate, i, edge, ctx);
    if (silenceWithin(t0, dir, thr, lim.s)) return { over, cut: true, open: true, soft: false, aboveS };
    return { over, cut: false, open: true, soft: true, reason: "sem-abertura", limit: lim.kind, limitS: lim.s, aboveS };
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
    const sIn = judge(i, "in", a, beforeDb, thrInDb, coveredBy(clips[i - 1], bLo, a), fs);
    const sOut = judge(i, "out", b, afterDb, thrOutDb, coveredBy(clips[i + 1], b, aHi), fs);
    return {
      clip: i + 1, inS: a, outS: b, beforeDb, afterDb,
      cutIn: sIn.cut, cutOut: sOut.cut, overIn: sIn.over, overOut: sOut.over, openIn: sIn.open, openOut: sOut.open,
      softIn: sIn.soft, softOut: sOut.soft,
      ...(sIn.reason ? { softReasonIn: sIn.reason } : {}), ...(sOut.reason ? { softReasonOut: sOut.reason } : {}),
      ...(sIn.limit ? { limitIn: sIn.limit, limitInS: sIn.limitS } : {}), ...(sOut.limit ? { limitOut: sOut.limit, limitOutS: sOut.limitS } : {}),
      aboveInS: sIn.aboveS, aboveOutS: sOut.aboveS, thrInDb, thrOutDb,
    };
  });
}

// ── Borda com SOM CORTADO aberta pelo build (#13194) ──────────────────────

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
  /** O verify-xml acusa como erro (SOM CORTADO); `false` = só [aviso] (`sem-abertura`). */
  error: boolean;
  aboveS: number;
  /** O que segurou a abertura e onde (s globais). */
  limit: EdgeLimitKind;
  limitS: number;
}

/**
 * #13194 (decisão do editor de 15/11: na dúvida, silêncio a palavra cortada):
 * o build aplica o critério do `verify-xml` (`edgeFindings`, a mesma janela de
 * 40 ms do lado de fora e o mesmo limiar) aos clipes que vai gravar no XML e
 * abre a borda `open` (acima do fixo do bruto, ou acima do relativo com energia
 * sustentada; nunca por estalo ou respiro curto), quadro a quadro, até o 1º
 * ponto em que o lado de fora fica abaixo do limiar da borda. A abertura para
 * no limite de `edgeOpenLimit` (teto `maxOpenS`, arquivo do bruto, palavra
 * vizinha INTEIRA de fora com folga, clipe vizinho). Sem silêncio até lá, a
 * borda fica como estava e sai em `unresolved`, com o limite: o `verify-xml`
 * acusa como erro (acima do fixo) ou avisa (`sem-abertura`). O `filler` só
 * abre acima do fixo, como antes do #13194, e segue limitando os vizinhos.
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
  const eps = 1e-6;
  const timeline = (cs: readonly T[]): TimelineClip[] => cs.map((c) => ({ start: 0, end: 0, in: c.frameIn, out: c.frameOut, fileId: "file-1", gIn: c.frameIn, gOut: c.frameOut }));
  const ctxOf = (cs: readonly T[]): EdgeFindingsContext => ({
    words: opts.words,
    ownWord: opts.ownWord ? (j, edge, w) => opts.ownWord!(cs[j], edge, w) : undefined,
    fixedOnly: cs.map((c) => !!c.filler),
    maxOpenS: opts.maxOpenS,
    durationS: opts.durationS,
    bounds: opts.bounds,
    windowS: opts.windowS,
  });
  const findings = (cs: readonly T[]) => edgeFindings(timeline(cs), fps, levelDb, thresholdDb, ctxOf(cs));
  const cur = clips.map((c) => ({ ...c }));
  const opened: OpenedEdge<T["block"]>[] = [];
  const first = findings(cur);
  for (let i = 0; i < cur.length; i++) {
    for (const edge of ["in", "out"] as const) {
      const f0 = first[i];
      if (!(edge === "in" ? f0.openIn : f0.openOut)) continue;
      const c = cur[i];
      const lim = edgeOpenLimit(timeline(cur), fps, i, edge, ctxOf(cur)).s;
      if (edge === "in") {
        const loFrame = Math.ceil(lim * fps - eps);
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
        const hiFrame = Math.floor(lim * fps + eps);
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
  const tl = timeline(cur);
  findings(cur).forEach((e, i) => {
    for (const edge of ["in", "out"] as const) {
      if (!(edge === "in" ? e.openIn : e.openOut)) continue;
      const lim = edgeOpenLimit(tl, fps, i, edge, ctxOf(cur));
      unresolved.push(
        edge === "in"
          ? { block: cur[i].block, edge, atS: e.inS, db: e.beforeDb, thresholdDb: e.thrInDb, error: e.cutIn, aboveS: e.aboveInS, limit: lim.kind, limitS: lim.s }
          : { block: cur[i].block, edge, atS: e.outS, db: e.afterDb, thresholdDb: e.thrOutDb, error: e.cutOut, aboveS: e.aboveOutS, limit: lim.kind, limitS: lim.s },
      );
    }
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

/** Uma borda com [aviso] do verify-xml (#13194), como vai para o `verify-xml.json`. */
export interface SoftEdge {
  clip: number;
  edge: "in" | "out";
  /** s globais do bruto. */
  atS: number;
  db: number;
  thresholdDb: number;
  aboveMs: number;
  reason: SoftEdgeReason;
  limit?: EdgeLimitKind;
  limitS?: number;
}

/** As bordas com [aviso] (#13194): acima do limiar relativo, sem ser SOM CORTADO. */
export function softEdges(edges: readonly EdgeFinding[]): SoftEdge[] {
  const out: SoftEdge[] = [];
  const ms = (s: number) => Math.round(s * 1000);
  for (const e of edges) {
    if (e.softIn) out.push({ clip: e.clip, edge: "in", atS: e.inS, db: e.beforeDb, thresholdDb: e.thrInDb, aboveMs: ms(e.aboveInS), reason: e.softReasonIn ?? "curta", ...(e.limitIn ? { limit: e.limitIn, limitS: e.limitInS } : {}) });
    if (e.softOut) out.push({ clip: e.clip, edge: "out", atS: e.outS, db: e.afterDb, thresholdDb: e.thrOutDb, aboveMs: ms(e.aboveOutS), reason: e.softReasonOut ?? "curta", ...(e.limitOut ? { limit: e.limitOut, limitS: e.limitOutS } : {}) });
  }
  return out;
}

/** O motivo do [aviso], em texto: `curta` ou `sem-abertura` com o limite que segurou. */
export function softReasonText(x: { reason: SoftEdgeReason; aboveMs: number; thresholdDb: number; limit?: EdgeLimitKind; limitS?: number }, clock: (s: number) => string): string {
  if (x.reason === "curta") return `curta: ${x.aboveMs} ms acima do limiar ${x.thresholdDb.toFixed(0)} dB, abaixo dos ${Math.round(SUSTAINED_EDGE.minS * 1000)} ms de fala (estalo, respiro ou ruído)`;
  return `sem-abertura: ${x.aboveMs} ms acima do limiar ${x.thresholdDb.toFixed(0)} dB, sem silêncio antes do limite da abertura (${x.limit ?? "teto"}${x.limitS !== undefined ? ` em ${clock(x.limitS)}` : ""}); provável fala cortada, conferir no Premiere`;
}

/** Linhas de [aviso] do verify-xml (#13194). */
export function softEdgeWarnings(edges: readonly EdgeFinding[], clock: (s: number) => string): string[] {
  return softEdges(edges).map((x) => `clipe ${x.clip}: ${x.edge === "in" ? "entrada" : "saída"} em ${clock(x.atS)} com ${x.db.toFixed(0)} dB fora: ${softReasonText(x, clock)} (#13194)`);
}

const edgeMark = (cut: boolean, soft: boolean, thr: number, aboveS: number, reason: SoftEdgeReason | undefined) =>
  cut
    ? ` ← SOM CORTADO (limiar ${thr.toFixed(0)} dB)`
    : soft
      ? ` ← [aviso] ${reason ?? "curta"}, ${Math.round(aboveS * 1000)} ms acima do limiar ${thr.toFixed(0)} dB`
      : "";

export function edgeLine(e: EdgeFinding, clock: (s: number) => string): string {
  return (
    `${String(e.clip).padStart(2)}  ${clock(e.inS)}–${clock(e.outS)}  antes da entrada ${e.beforeDb.toFixed(0)} dB${edgeMark(e.cutIn, e.softIn, e.thrInDb, e.aboveInS, e.softReasonIn)}` +
    `  depois da saída ${e.afterDb.toFixed(0)} dB${edgeMark(e.cutOut, e.softOut, e.thrOutDb, e.aboveOutS, e.softReasonOut)}`
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
