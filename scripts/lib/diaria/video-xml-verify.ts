/**
 * Verificação independente do XML (#12561), portada de `vjpixel/edicao-video`
 * (`scripts/montagem.ts`, `verifyXml`). O `build` gera o XML e a prévia do
 * MESMO plano; a prévia pode estar certa e o XML que o Premiere importa,
 * errado. Aqui o XML é lido como o Premiere lê:
 *
 *   - os `clipitem` de áudio da faixa principal (`a{n}`; a vinheta fica de
 *     fora), com `start`/`end`/`in`/`out` e a `timebase` declarada (inclusive
 *     NTSC 1000/1001);
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
  const re = /<clipitem id="a\d+">([\s\S]*?)<\/clipitem>/g;
  for (const m of audio.matchAll(re)) {
    const body = m[1];
    const num = (tag: string) => {
      const x = body.match(new RegExp(`<${tag}>(-?\\d+)</${tag}>`));
      if (!x) throw new Error(`clipitem de áudio sem <${tag}>`);
      return Number(x[1]);
    };
    const file = body.match(/<file id="([^"]+)"/);
    if (!file) throw new Error("clipitem de áudio sem <file>");
    clips.push({ start: num("start"), end: num("end"), in: num("in"), out: num("out"), fileId: file[1] });
  }
  return { timebase, ntsc, rate: ntsc ? (timebase * 1000) / 1001 : timebase, clips };
}

/** Clipe do XML levado à linha do tempo global do bruto (quadros). */
export interface TimelineClip extends XmlAudioClip {
  gIn: number;
  gOut: number;
}

/**
 * Leva cada clipe à linha do tempo global: `file-{k}` soma o `offsetFrames` do
 * k-ésimo arquivo; `file-audio` (faixa tratada) já é global. `<file>` que não
 * existe no bruto é erro (o XML aponta outro bruto).
 */
export function toTimeline(parsed: ParsedXmlAudio, offsets: readonly number[]): { clips: TimelineClip[]; errors: string[] } {
  const errors: string[] = [];
  const clips = parsed.clips.map((c, i) => {
    let off = 0;
    if (c.fileId !== "file-audio") {
      const k = /^file-(\d+)$/.exec(c.fileId);
      const o = k ? offsets[Number(k[1]) - 1] : undefined;
      if (o === undefined) errors.push(`clipe ${i + 1}: aponta ${c.fileId}, que não existe no bruto (${offsets.length} arquivo(s))`);
      else off = o;
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
  cutIn: boolean;
  cutOut: boolean;
}

/** Janela medida do lado de fora de cada borda (o edicao-video usa 40 ms). */
export const EDGE_WINDOW_S = 0.04;

/**
 * Energia logo fora de cada borda (`levelDb(a, b)` = maior dBFS em [a, b] do
 * áudio do bruto). Acima de `thresholdDb` = som cortado, menos quando o trecho
 * de fora está dentro de outro clipe contíguo no bruto (fala que continua no
 * clipe seguinte/anterior da sequência).
 */
export function edgeFindings(clips: readonly TimelineClip[], rate: number, levelDb: (a: number, b: number) => number, thresholdDb: number, windowS = EDGE_WINDOW_S): EdgeFinding[] {
  const covered = (a: number, b: number) => clips.some((k) => k.gIn / rate <= a + 1e-6 && k.gOut / rate >= b - 1e-6);
  return clips.map((c, i) => {
    const a = c.gIn / rate;
    const b = c.gOut / rate;
    const beforeDb = levelDb(Math.max(0, a - windowS), a);
    const afterDb = levelDb(b, b + windowS);
    const cutIn = beforeDb > thresholdDb && !covered(Math.max(0, a - windowS), a);
    const cutOut = afterDb > thresholdDb && !covered(b, b + windowS);
    return { clip: i + 1, inS: a, outS: b, beforeDb, afterDb, cutIn, cutOut };
  });
}

/** Trechos do bruto (s globais) na ordem da sequência: a entrada do `ffmpeg` que remonta o áudio só pelo XML. */
export function assemblySegments(clips: readonly TimelineClip[], rate: number): Array<{ start: number; end: number }> {
  return clips.map((c) => ({ start: c.gIn / rate, end: c.gOut / rate }));
}

/** Início (s) de cada clipe na sequência depois do 1º: os cortes, para a revisão ignorar a borda. */
export function sequenceCutsS(clips: readonly XmlAudioClip[], rate: number): number[] {
  return clips.slice(1).map((c) => c.start / rate);
}

export function edgeLine(e: EdgeFinding, clock: (s: number) => string): string {
  return (
    `${String(e.clip).padStart(2)}  ${clock(e.inS)}–${clock(e.outS)}  antes da entrada ${e.beforeDb.toFixed(0)} dB${e.cutIn ? " ← SOM CORTADO" : ""}` +
    `  depois da saída ${e.afterDb.toFixed(0)} dB${e.cutOut ? " ← SOM CORTADO" : ""}`
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
