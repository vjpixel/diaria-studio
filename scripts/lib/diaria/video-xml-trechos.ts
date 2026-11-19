/**
 * XML "leve" (#13219): o XML do Premiere aponta para TRECHOS curtos do bruto
 * em H.264 + PCM, não para o bruto inteiro.
 *
 * Por quê: o bruto do celular é HEVC 4K a ~96 Mbps com áudio AAC (na 261116,
 * 5 arquivos, ~20 GB). O Premiere converte o AAC de cada arquivo INTEIRO
 * (`.cfa`, "Preparing audio"), lendo os 20 GB pelo Google Drive, para uma
 * montagem que usa ~5 min; e o HEVC a 96 Mbps lido por streaming não toca em
 * tempo real ("Error retrieving frame", quadros pretos). O contorno da 261116
 * (script de sessão) cortava só o que os XMLs usam: ~1,6 GB e nenhum conform.
 *
 * Este módulo é puro (planejamento dos trechos, nome, argumentos do ffmpeg,
 * escolha do encoder); quem roda o ffmpeg e escreve o XML é o `build` de
 * `scripts/video-montagem.ts`, e o `<file>` de cada trecho sai em
 * `buildXmeml` (`opts.trechos`).
 *
 *   - Um trecho cobre os clipes de UM arquivo do bruto, com `folgaS` de cada
 *     lado; trechos a menos de `mergeGapS` um do outro viram um só.
 *   - Os limites são arredondados para fora, em segundos inteiros: um rebuild
 *     que mexe pouco nos cortes cai nos mesmos limites e reaproveita o arquivo.
 *   - O nome leva o arquivo do bruto e os quadros de início E fim (a issue
 *     pedia início; com só o início, um rebuild que estica o fim reaproveitaria
 *     um trecho curto demais, com quadro preto no fim do clipe).
 *   - O `<file id>` é `file-{k}-t{início}` (k = arquivo do bruto, 1-based;
 *     início em quadros locais dele): o `verify-xml` volta ao tempo do bruto
 *     só pelo id (`toTimeline`, `video-xml-verify.ts`).
 *   - O 4K fica: o zoom do vertical (115–130%) e do horizontal não perde nada.
 *
 * #13493 (na 261118 o XML leve deixou a montagem mais lenta: 3 rodadas de
 * recodificação, trechos truncados, `.part` no Drive):
 *   - Os limites ficam ancorados no BLOCO DE SILÊNCIO do `silences.json` em
 *     que o corte cai (`trechoStartFor`/`trechoEndFor`), não no quadro exato
 *     do corte: um ajuste de borda dentro do mesmo silêncio dá o mesmo trecho,
 *     com o mesmo nome, e ele é reaproveitado. Sem silêncio, o segundo inteiro.
 *   - O XML leve liga sozinho só acima de um limiar (`decideXmlLeve`,
 *     `publishing.video.xml_leve`); abaixo, o XML aponta o bruto.
 *   - O XML só é dado por pronto com os trechos na nuvem
 *     (`esperarTrechosNaNuvem`).
 */

export const TRECHOS = {
  /** Folga de cada lado do trecho, em segundos (`--trechos-folga`). */
  folgaS: 1,
  /** Trechos (já com folga) a menos disto um do outro viram um só, em segundos. */
  mergeGapS: 3,
  /** Subpasta do out dir (a pasta da edição) onde os trechos ficam. */
  dirName: "trechos",
  /** GOP curto e sem B-frames: scrubbing e corte no Premiere sem decodificar muito para trás. */
  gop: 15,
  /** Qualidade constante do H.264 (cq do NVENC, crf do libx264). */
  quality: 19,
  /**
   * #13493: até quanto do silêncio (antes da fala ou depois dela) o trecho
   * engole quando o limite fica ancorado no bloco de silêncio, em segundos.
   * Também o máximo que o limite pode recuar (ou avançar) até a borda do bloco
   * vizinho; além disso, volta ao segundo inteiro.
   */
  silenceMaxS: 3,
  /** #13493: o corte do refino pode cair uns quadros depois do fim do silêncio detectado (ou antes do começo). */
  silenceTolS: 0.25,
  /**
   * #13493: marcador da regra que decide os limites (e portanto os nomes) dos
   * trechos. Entra na versão do XML (`xmlVersionHashOf`) quando há trechos:
   * mudar a regra com o mesmo plano e a mesma folga gera trechos novos, e o
   * `<sequence id>`/`_V{n}` precisa mudar junto. Trocar ao mudar a regra.
   */
  anchorRule: "silencio-13493",
} as const;

/**
 * #13493: quando o XML leve liga sozinho (`publishing.video.xml_leve`). Na
 * 261116 (~20 GB em 8 arquivos) o Premiere travava lendo o bruto pelo Drive;
 * na 261118 (11,9 GB) o bruto já sincronizado servia e os trechos só
 * atrasaram. Acima de `minGb` (GiB, como o Explorer mostra) OU de
 * `maxArquivos` arquivos, XML leve; senão o bruto direto. #13629: o editor
 * baixou o limiar de tamanho de 15 para 2 GB em 19/11/2026 (o mesmo valor do
 * `platform.config.json`); o limite de 8 arquivos ficou.
 */
export const XML_LEVE_LIMIAR_DEFAULT = { minGb: 2, maxArquivos: 8 } as const;

export interface XmlLeveLimiar {
  minGb: number;
  maxArquivos: number;
}

/** `--xml-leve` força os trechos, `--xml-bruto` força o bruto; sem nenhum, o limiar decide. */
export type XmlLeveChoice = "auto" | "leve" | "bruto";

/** `--xml-leve` e `--xml-bruto` juntos é erro (#13493). */
export function parseXmlLeveChoice(flags: { leve: boolean; bruto: boolean }): XmlLeveChoice {
  if (flags.leve && flags.bruto) throw new Error("--xml-leve e --xml-bruto juntos: escolha um (#13493)");
  return flags.leve ? "leve" : flags.bruto ? "bruto" : "auto";
}

/**
 * `publishing.video.xml_leve` (`{ min_gb, max_arquivos }`) do config (#13493).
 * Ausente = o default; valor que não é número positivo = o default daquele
 * campo, com aviso.
 */
export function xmlLeveLimiarFrom(config: unknown, warn: (m: string) => void = () => {}): XmlLeveLimiar {
  const raw = (config as { publishing?: { video?: { xml_leve?: unknown } } } | null)?.publishing?.video?.xml_leve;
  if (raw === undefined || raw === null) return { ...XML_LEVE_LIMIAR_DEFAULT };
  const o = typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const pick = (key: string, def: number, integer: boolean): number => {
    const v = o[key];
    if (v === undefined) return def;
    if (typeof v === "number" && Number.isFinite(v) && v > 0 && (!integer || Number.isInteger(v))) return v;
    warn(`publishing.video.xml_leve.${key} inválido (${JSON.stringify(v)}): vale o default ${def} (#13493)`);
    return def;
  };
  if (o !== raw) warn(`publishing.video.xml_leve não é objeto (${JSON.stringify(raw)}): vale o default (#13493)`);
  return { minGb: pick("min_gb", XML_LEVE_LIMIAR_DEFAULT.minGb, false), maxArquivos: pick("max_arquivos", XML_LEVE_LIMIAR_DEFAULT.maxArquivos, true) };
}

const GIB = 1024 ** 3;

/**
 * #13493: XML leve ou o bruto direto. `totalBytes` null = o tamanho de algum
 * arquivo do bruto não foi lido: decide só pelo número de arquivos (dito no
 * motivo). Forçado pela CLI, o limiar não conta.
 */
export function decideXmlLeve(input: { choice: XmlLeveChoice; totalBytes: number | null; files: number; limiar: XmlLeveLimiar }): { enabled: boolean; reason: string } {
  const { limiar } = input;
  const size = input.totalBytes === null ? "tamanho não lido" : `${(input.totalBytes / GIB).toFixed(1)} GB`;
  const bruto = `bruto de ${size} em ${input.files} arquivo(s)`;
  const regra = `limiar: mais de ${limiar.minGb} GB ou de ${limiar.maxArquivos} arquivos, publishing.video.xml_leve`;
  if (input.choice === "leve") return { enabled: true, reason: `--xml-leve (${bruto})` };
  if (input.choice === "bruto") return { enabled: false, reason: `--xml-bruto (${bruto})` };
  const bySize = input.totalBytes !== null && input.totalBytes > limiar.minGb * GIB;
  const byFiles = input.files > limiar.maxArquivos;
  if (bySize || byFiles) return { enabled: true, reason: `${bruto}, acima do ${regra}` };
  return { enabled: false, reason: `${bruto}, dentro do ${regra}${input.totalBytes === null ? " (sem o tamanho, só o número de arquivos decidiu)" : ""}` };
}

export type TrechoEncoder = "h264_nvenc" | "libx264";

/** Um clipe do plano no arquivo do bruto que ele usa: quadros LOCAIS do arquivo, `out` exclusivo. */
export interface TrechoUse {
  fileIndex: number;
  in: number;
  out: number;
}

/** O que o planejamento lê de cada arquivo do bruto. */
export interface TrechoSourceFile {
  /** Caminho local (o ffmpeg lê dele); o nome sem extensão vai no nome do trecho. */
  path: string;
  frames: number;
}

/** Um trecho planejado: quadros LOCAIS do arquivo `fileIndex`, `end` exclusivo. */
export interface Trecho {
  fileIndex: number;
  start: number;
  end: number;
  /** Nome do `.mov` (estável: arquivo + início + fim). */
  name: string;
  /** `<file id>` no XML. */
  id: string;
}

/** O trecho como o `buildXmeml` o grava: o caminho que vai no `pathurl` e o tamanho do arquivo do bruto de onde saiu. */
export interface TrechoXml extends Trecho {
  xmlPath: string;
  width: number;
  height: number;
}

const stem = (p: string): string => (p.replace(/\\/g, "/").split("/").pop() ?? p).replace(/\.[^.]+$/, "");
const pad = (n: number): string => String(n).padStart(6, "0");

export function trechoName(sourcePath: string, start: number, end: number): string {
  return `${stem(sourcePath)}_q${pad(start)}-${pad(end)}.mov`;
}

export function trechoFileId(fileIndex: number, start: number): string {
  return `file-${fileIndex + 1}-t${start}`;
}

/** Nome de trecho (`{stem}_q{início}-{fim}.mov`) → quadros de início e fim (`end` exclusivo); outro nome = null (#13488). */
export function parseTrechoName(name: string): { start: number; end: number } | null {
  const m = /_q(\d{6,})-(\d{6,})\.mov$/.exec(name);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return end > start ? { start, end } : null;
}

/**
 * Folga, em quadros, entre os quadros que o nome promete e os do arquivo
 * (#13488). O ffmpeg com `-t` + CFR dá o número exato; 1 quadro cobre o
 * arredondamento do `-t`. Os truncados da 261118 perdiam de 240 a 511.
 */
export const TRECHO_FRAME_TOL = 1;

/**
 * O arquivo do trecho tem os quadros que o nome promete (#13488)? `got` null
 * (ffprobe que falha: arquivo sem `moov`, cortado no meio) = não.
 */
export function trechoFramesOk(expected: number, got: number | null): boolean {
  return got !== null && Number.isFinite(got) && Math.abs(got - expected) <= TRECHO_FRAME_TOL;
}

/**
 * #13500/#13643: o quanto um corte que chega ao fim do vídeo de origem pode sair
 * mais curto que o intervalo: o stream de vídeo costuma acabar antes do
 * container (padding do AAC), e um fim = fim do arquivo rende de 1 a 3 quadros
 * a menos. Vale para o trecho inserido (#13500) e para o trecho do XML leve que
 * vai até o fim do arquivo do bruto (#13643), cujos quadros saem da duração do
 * container (`format.duration`).
 */
export const TRECHO_END_SHORT_TOL_S = 0.1;

/**
 * #13643: o mínimo de quadros aceito no arquivo de um trecho do XML leve. Os
 * do nome (`end - start`), salvo quando o trecho termina no fim do arquivo do
 * bruto (`end >= fileFrames`): aí até `TRECHO_END_SHORT_TOL_S` a menos (o
 * `trechoEndFor` prende o fim em `frames`, a contagem do container). Sem
 * `fileFrames` (arquivo do bruto desconhecido), os do nome.
 */
export function trechoMinFrames(t: { start: number; end: number }, fileFrames: number | null | undefined, fps: number): number {
  const expected = t.end - t.start;
  if (fileFrames === null || fileFrames === undefined || !(fps > 0) || t.end < fileFrames) return expected;
  return Math.max(1, expected - Math.ceil(TRECHO_END_SHORT_TOL_S * fps));
}

/** #13643: o nome do arquivo do bruto (sem extensão) de que o trecho saiu (`{stem}_q…-….mov`); outro nome = null. */
export function trechoSourceStem(name: string): string | null {
  const m = /^(.*)_q\d{6,}-\d{6,}\.mov$/.exec(name);
  return m ? m[1] : null;
}

/** #13643: os quadros de cada arquivo do bruto pelo nome sem extensão, a chave que `trechoSourceStem` devolve. */
export function trechoFileFramesByStem(files: readonly TrechoSourceFile[]): Map<string, number> {
  return new Map(files.map((f) => [stem(f.path), f.frames]));
}

/**
 * Argumentos do ffprobe que contam os pacotes de vídeo do trecho (#13488):
 * sem decodificar (um trecho 4K de 30 s conta em menos de 1 s), e um pacote
 * por quadro no H.264 sem B-frames que o build grava.
 */
export function trechoFrameProbeArgs(path: string): string[] {
  return ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path];
}

/** A saída do ffprobe de `trechoFrameProbeArgs` → quadros; vazia/ilegível = null. */
export function parseTrechoFrameProbe(stdout: string): number | null {
  const n = Number(stdout.trim().split(/\r?\n/)[0]?.replace(/,$/, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Os nomes de trecho que um XML leve aponta (o `<name>` de cada `<file>`), sem repetição, na ordem em que aparecem (#13488). */
export function trechoNamesInXml(xmlText: string): string[] {
  const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return [...new Set([...xmlText.matchAll(/<name>([^<]*_q\d{6,}-\d{6,}\.mov)<\/name>/g)].map((m) => unescape(m[1])))];
}

/** `file-{k}-t{início}` → arquivo (0-based) e início local; outro id = null. */
export function parseTrechoFileId(id: string): { fileIndex: number; start: number } | null {
  const m = /^file-(\d+)-t(\d+)$/.exec(id);
  return m ? { fileIndex: Number(m[1]) - 1, start: Number(m[2]) } : null;
}

/** Um silêncio em quadros LOCAIS de um arquivo do bruto, `end` exclusivo (#13493). */
export interface FrameInterval {
  start: number;
  end: number;
}

/**
 * #13493: os silêncios do `silences.json` (segundos, linha do tempo global do
 * projeto) em quadros locais de cada arquivo do bruto, cortados nas bordas do
 * arquivo e em ordem.
 */
export function silencesPerFile(silences: readonly { start: number; end: number }[], files: readonly { offsetFrames: number; frames: number }[], fps: number): FrameInterval[][] {
  return files.map((f) =>
    silences
      .map((s) => ({ start: Math.max(0, Math.round(s.start * fps) - f.offsetFrames), end: Math.min(f.frames, Math.round(s.end * fps) - f.offsetFrames) }))
      .filter((s) => s.end > s.start)
      .sort((a, b) => a.start - b.start || a.end - b.end),
  );
}

interface AnchorCtx {
  fps: number;
  folgaS: number;
  frames: number;
  silences: readonly FrameInterval[];
}

/** As bordas dos blocos (começo e fim de cada silêncio, mais o começo e o fim do arquivo), em ordem. */
function blockPoints(c: AnchorCtx): number[] {
  return [...new Set([0, c.frames, ...c.silences.flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b);
}

/**
 * #13493: o início do trecho de um clipe que começa em `inF`. Com o `inF`
 * dentro de um silêncio, o limite depende só desse silêncio (nunca do quadro
 * exato do corte): o silêncio inteiro antes da fala, até `silenceMaxS` (sempre
 * pelo menos a folga); silêncio mais curto que a folga recua até a borda de
 * bloco anterior (até `silenceMaxS` além da folga) ou ao segundo inteiro antes
 * de `fim do silêncio - folga`. Um ajuste de borda dentro do mesmo silêncio
 * cai no mesmo trecho, e o nome (que leva os quadros) não muda. Corte fora de
 * silêncio, ou sem `silences.json`, volta à regra do #13219: o segundo inteiro
 * antes de `inF - folga`.
 */
export function trechoStartFor(inF: number, c: AnchorCtx): { frame: number; anchor: "silencio" | "segundo" } {
  const legacy = { frame: Math.max(0, Math.round(Math.floor(inF / c.fps - c.folgaS + 1e-9) * c.fps)), anchor: "segundo" as const };
  const folgaF = Math.round(c.folgaS * c.fps);
  const maxF = Math.max(Math.round(TRECHOS.silenceMaxS * c.fps), folgaF);
  const tolF = Math.round(TRECHOS.silenceTolS * c.fps);
  const s = c.silences.find((x) => x.start <= inF && inF <= x.end + tolF);
  if (!s) return legacy;
  let b: number;
  if (s.end - folgaF >= s.start) b = Math.max(s.start, s.end - maxF);
  else {
    const target = s.end - folgaF;
    const p = blockPoints(c).filter((x) => x <= target).pop();
    b = p !== undefined && target - p <= maxF ? p : Math.max(0, Math.round(Math.floor(target / c.fps + 1e-9) * c.fps));
  }
  b = Math.max(0, b);
  return b <= inF ? { frame: b, anchor: "silencio" } : legacy;
}

/** #13493: o fim do trecho de um clipe que termina em `outF` (`end` exclusivo); o espelho de `trechoStartFor`. */
export function trechoEndFor(outF: number, c: AnchorCtx): { frame: number; anchor: "silencio" | "segundo" } {
  const legacy = { frame: Math.min(c.frames, Math.round(Math.ceil(outF / c.fps + c.folgaS - 1e-9) * c.fps)), anchor: "segundo" as const };
  const folgaF = Math.round(c.folgaS * c.fps);
  const maxF = Math.max(Math.round(TRECHOS.silenceMaxS * c.fps), folgaF);
  const tolF = Math.round(TRECHOS.silenceTolS * c.fps);
  const s = c.silences.find((x) => x.start - tolF <= outF && outF <= x.end);
  if (!s) return legacy;
  let e: number;
  if (s.start + folgaF <= s.end) e = Math.min(s.end, s.start + maxF);
  else {
    const target = s.start + folgaF;
    const p = blockPoints(c).find((x) => x >= target);
    e = p !== undefined && p - target <= maxF ? p : Math.round(Math.ceil(target / c.fps - 1e-9) * c.fps);
  }
  e = Math.min(c.frames, e);
  return e >= outF ? { frame: e, anchor: "silencio" } : legacy;
}

/**
 * Os trechos que cobrem todos os `uses` (#13219). Clipe com in/out fora do
 * arquivo (ou vazio) é erro: o plano é de outro bruto. Com `silences` (por
 * arquivo, quadros locais, `silencesPerFile`), os limites ficam ancorados nos
 * blocos de silêncio (#13493, `trechoStartFor`/`trechoEndFor`).
 */
export function planTrechos(
  uses: readonly TrechoUse[],
  files: readonly TrechoSourceFile[],
  fps: number,
  opts: { folgaS?: number; mergeGapS?: number; silences?: readonly (readonly FrameInterval[])[] } = {},
): Trecho[] {
  const folgaS = opts.folgaS ?? TRECHOS.folgaS;
  const mergeGapS = opts.mergeGapS ?? TRECHOS.mergeGapS;
  if (!(fps > 0)) throw new Error(`trechos: fps inválido (${fps})`);
  if (!(folgaS >= 0)) throw new Error(`trechos: folga inválida (${folgaS})`);
  const byFile = new Map<number, { start: number; end: number }[]>();
  for (const u of uses) {
    const f = files[u.fileIndex];
    if (!f) throw new Error(`trechos: clipe aponta o arquivo ${u.fileIndex}, mas o bruto tem ${files.length}`);
    if (!(u.in >= 0 && u.out > u.in && u.out <= f.frames)) throw new Error(`trechos: clipe ${u.in}–${u.out} fora de ${stem(f.path)} (${f.frames} quadros)`);
    // #13493: ancorado no bloco de silêncio quando há silences; senão, para fora em segundos inteiros (#13219).
    const c: AnchorCtx = { fps, folgaS, frames: f.frames, silences: opts.silences?.[u.fileIndex] ?? [] };
    const start = trechoStartFor(u.in, c).frame;
    const end = trechoEndFor(u.out, c).frame;
    const list = byFile.get(u.fileIndex) ?? [];
    list.push({ start, end });
    byFile.set(u.fileIndex, list);
  }
  const gap = mergeGapS * fps;
  const out: Trecho[] = [];
  for (const k of [...byFile.keys()].sort((a, b) => a - b)) {
    const spans = byFile.get(k)!.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: { start: number; end: number }[] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.start - last.end < gap) last.end = Math.max(last.end, s.end);
      else merged.push({ ...s });
    }
    for (const m of merged) out.push({ fileIndex: k, start: m.start, end: m.end, name: trechoName(files[k].path, m.start, m.end), id: trechoFileId(k, m.start) });
  }
  return out;
}

/** O trecho que contém o clipe inteiro (`in`/`out` locais do arquivo); nenhum = null. */
export function findTrecho<T extends Trecho>(trechos: readonly T[], fileIndex: number, inF: number, outF: number): T | null {
  return trechos.find((t) => t.fileIndex === fileIndex && t.start <= inF && outF <= t.end) ?? null;
}

/** Quadros de bruto cobertos pelos trechos e o total do bruto (para o relato do build). */
export function trechosCoverage(trechos: readonly Trecho[], files: readonly TrechoSourceFile[]): { frames: number; totalFrames: number } {
  return { frames: trechos.reduce((s, t) => s + (t.end - t.start), 0), totalFrames: files.reduce((s, f) => s + f.frames, 0) };
}

/** NVENC quando o ffmpeg o lista (`ffmpeg -encoders`); senão libx264 (o 300 não tem GPU NVIDIA). */
export function pickTrechoEncoder(encodersListing: string): TrechoEncoder {
  return /^\s*V\S*\s+h264_nvenc\b/m.test(encodersListing) ? "h264_nvenc" : "libx264";
}

/**
 * Argumentos do ffmpeg de um trecho: seek no input (exato com recodificação),
 * vídeo em H.264 no tamanho do bruto (4K fica 4K), CFR no fps do projeto
 * (o XML conta quadros), GOP de 15 sem B-frames, áudio PCM 16 bits 48 kHz.
 * Container MOV forçado (`-f mov`), para a saída poder ser um `.part`.
 */
export function trechoEncodeArgs(input: { src: string; out: string; start: number; end: number; fps: number; encoder: TrechoEncoder }): string[] {
  const startS = (input.start / input.fps).toFixed(6);
  const durS = ((input.end - input.start) / input.fps).toFixed(6);
  const q = String(TRECHOS.quality);
  const video = input.encoder === "h264_nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", q, "-b:v", "0"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", q];
  return [
    "-hide_banner", "-v", "error", "-y",
    "-ss", startS, "-i", input.src, "-t", durS,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-fps_mode", "cfr", "-r", String(input.fps),
    ...video, "-g", String(TRECHOS.gop), "-bf", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le", "-ar", "48000",
    "-f", "mov", input.out,
  ];
}

/**
 * #13493: dos trechos do XML leve (nome e tamanho no disco), os que ainda não
 * estão na nuvem com o mesmo tamanho: ausentes, com outro tamanho (subida pela
 * metade) ou só como `.part` (o Drive for desktop sobe o `.part` e demora a
 * propagar o rename; na 261118 o Mac viu 9 `.mov.part` e 8 `.mov` de 22, e o
 * Premiere importou o XML sem fazer nada e sem erro).
 */
export function trechosPendentesNaNuvem(
  local: readonly { name: string; size: number }[],
  remote: readonly { name: string; size?: string | number }[],
): TrechoPendente[] {
  const byName = new Map<string, { name: string; size?: string | number }[]>();
  for (const r of remote) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  return local.flatMap((l): TrechoPendente[] => {
    const found = byName.get(l.name) ?? [];
    if (found.some((r) => r.size !== undefined && Number(r.size) === l.size)) return [];
    if (found.length) return [{ name: l.name, why: "tamanho" }];
    return [{ name: l.name, why: byName.has(`${l.name}.part`) ? "part" : "ausente" }];
  });
}

/** Um trecho que ainda não está na nuvem e por quê (#13493). */
export interface TrechoPendente {
  name: string;
  why: "ausente" | "tamanho" | "part";
}

/**
 * #13493: espera os trechos chegarem à nuvem, relendo a listagem a cada
 * `pollS` até `timeoutS` (0 = uma leitura só). Listagem que falha conta como
 * "não conferido" (`error`), nunca como pronto.
 */
export async function esperarTrechosNaNuvem(input: {
  local: readonly { name: string; size: number }[];
  list: () => Promise<readonly { name: string; size?: string | number }[]>;
  timeoutS: number;
  pollS: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}): Promise<{ pending: TrechoPendente[]; error: string | null; waitedS: number }> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = input.now ?? (() => Date.now());
  const t0 = now();
  let pending: TrechoPendente[] = input.local.map((l) => ({ name: l.name, why: "ausente" }));
  let error: string | null = null;
  for (;;) {
    try {
      pending = trechosPendentesNaNuvem(input.local, await input.list());
      error = null;
    } catch (e) {
      error = (e as Error).message.split(/\r?\n/)[0];
    }
    const waitedS = Math.round((now() - t0) / 1000);
    if ((!pending.length && !error) || waitedS + input.pollS > input.timeoutS) return { pending, error, waitedS };
    input.log?.(`[video-montagem] ${error ? `listagem do Drive falhou (${error})` : `${pending.length} de ${input.local.length} trecho(s) ainda não estão no Drive`}; conferindo de novo em ${input.pollS} s (até ${input.timeoutS} s, #13493)`);
    await sleep(input.pollS * 1000);
  }
}

/** `--esperar-nuvem S`: segundos de 0 a 3600 (#13493); ausente = `def`. */
export function parseEsperarNuvemArg(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n) || n < 0 || n > 3600) throw new Error(`--esperar-nuvem espera segundos de 0 a 3600 (recebeu "${v}")`);
  return n;
}

/** `--trechos-folga S`: segundos de 0 a 10. */
export function parseTrechosFolgaArg(v: string | undefined): number {
  if (v === undefined) return TRECHOS.folgaS;
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n) || n < 0 || n > 10) throw new Error(`--trechos-folga espera segundos de 0 a 10 (recebeu "${v}")`);
  return n;
}
