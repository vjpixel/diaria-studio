/**
 * #13508: proxy 1440p do bruto 4K, gerado na MESMA leitura do `transcribe`
 * (o ffmpeg que já extrai o `audio.wav` ganha uma saída de vídeo em NVENC) e
 * lido pelos frames do `face`/`face-compare`/`gaze` no lugar do 4K. O XML
 * segue apontando o bruto 4K.
 *
 * Medido no Neo: 1440p sai em 6,4 s por 60 s de 4K, ocupa 135 MB/min, e um
 * frame tirado dele leva 0,25 s (1,15 s do 4K). 1440p e não 1080p porque o
 * recorte vertical em 1080p sai ampliado (528x939 para 720x1280).
 *
 * Só com NVENC (sem GPU, encodar 1440p na CPU custaria mais que o ganho), só
 * no bruto de UM arquivo de vídeo, e só quando o lado menor passa de 1440.
 * Qualquer falha cai no caminho de antes (audio.wav sem proxy), com [aviso].
 * O proxy só é lido quando a meta bate com o bruto do `source.json` (caminho,
 * tamanho em bytes, duração): bruto trocado = volta ao 4K.
 */

import { withHwDecode } from "./video-hwaccel.ts";

export const PROXY = {
  file: "bruto-proxy-1440p.mp4",
  meta: "bruto-proxy-1440p.meta.json",
  shortSide: 1440,
  version: 1,
  /** Diferença de duração (s) aceita entre o proxy e o bruto. */
  durationTolS: 0.5,
} as const;

export interface ProxyMeta {
  version: number;
  src: string;
  size: number;
  durationS: number;
  width: number;
  height: number;
}

/** O `scale` do proxy (lado menor em 1440, proporção mantida); `null` = o bruto já cabe, sem proxy. */
export function proxyScaleFilter(width: number, height: number): string | null {
  if (!(width > 0 && height > 0) || Math.min(width, height) <= PROXY.shortSide) return null;
  return width >= height ? `scale=-2:${PROXY.shortSide}` : `scale=${PROXY.shortSide}:-2`;
}

/**
 * O tamanho do proxy (#13508): lado menor em 1440 e o outro na proporção do
 * bruto, par, como o `scale=-2` do ffmpeg (arredonda para o par mais perto).
 * `null` = o bruto já cabe, sem proxy.
 */
export function proxySize(width: number, height: number): { width: number; height: number } | null {
  if (!proxyScaleFilter(width, height)) return null;
  const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
  return width >= height
    ? { width: even((width * PROXY.shortSide) / height), height: PROXY.shortSide }
    : { width: PROXY.shortSide, height: even((height * PROXY.shortSide) / width) };
}

/**
 * O recorte da prévia (#13508), em px do bruto, levado aos px do proxy: mesma
 * fração do quadro, arredondada para dentro dele (largura e altura pares, como
 * o `crop` do bruto). A prévia lê o proxy e o XML segue no bruto 4K.
 */
export function cropOnProxy(
  crop: { x: number; y: number; w: number; h: number },
  src: { width: number; height: number },
  proxy: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  const sx = proxy.width / src.width;
  const sy = proxy.height / src.height;
  const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
  const w = Math.min(even(crop.w * sx), proxy.width - (proxy.width % 2));
  const h = Math.min(even(crop.h * sy), proxy.height - (proxy.height % 2));
  const x = Math.min(Math.max(0, Math.round(crop.x * sx)), proxy.width - w);
  const y = Math.min(Math.max(0, Math.round(crop.y * sy)), proxy.height - h);
  return { x, y, w, h };
}

/**
 * A saída do proxy, para pendurar no ffmpeg que extrai o áudio (entrada 0 = o
 * bruto): só vídeo, NVENC, GOP curto (seek de frame barato), carimbos do bruto
 * preservados (o tempo do proxy é o tempo do bruto).
 */
export function proxyOutputArgs(input: { width: number; height: number; out: string }): string[] | null {
  const scale = proxyScaleFilter(input.width, input.height);
  if (!scale) return null;
  return [
    "-map", "0:v:0", "-an", "-vf", scale, "-fps_mode", "passthrough",
    "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-g", "30", "-bf", "0", "-pix_fmt", "yuv420p",
    "-f", "mp4", input.out,
  ];
}

/** A meta do proxy vale para este bruto? (bruto em vários arquivos ou só áudio: nunca há proxy). */
export function proxyUsable(
  meta: unknown,
  source: { path: string; durationS: number; files?: readonly unknown[]; audioOnly?: boolean },
  srcSize: number | null,
): boolean {
  if (source.audioOnly || (source.files?.length ?? 0) > 1 || srcSize === null) return false;
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Partial<ProxyMeta>;
  return (
    m.version === PROXY.version &&
    m.src === source.path &&
    m.size === srcSize &&
    typeof m.durationS === "number" &&
    Math.abs(m.durationS - source.durationS) <= PROXY.durationTolS
  );
}

/**
 * A extração do `transcribe` com o proxy pendurado (#13508): um ffmpeg só, com
 * o decode pela GPU (`-hwaccel cuda`), grava o áudio, mede o loudness e grava
 * o proxy. Se esse ffmpeg falha (sem GPU funcional, NVENC que não abre), o
 * proxy parcial é descartado e a extração roda como antes, só o áudio, com
 * [aviso]. Proxy gravado que não passa na conferência (`finish` lança) é
 * descartado com [aviso], sem refazer o áudio. Devolve o stderr da extração
 * que valeu (o loudnorm sai nele).
 */
export function runExtractWithProxy(input: {
  baseArgs: readonly string[];
  proxy: { args: readonly string[]; part: string } | null;
  exec: (args: string[]) => string;
  finish: (part: string) => void;
  discard: (part: string) => void;
  warn: (line: string) => void;
}): { stderr: string; proxy: "made" | "failed" | "skipped" } {
  if (!input.proxy) return { stderr: input.exec([...input.baseArgs]), proxy: "skipped" };
  let stderr: string;
  try {
    stderr = input.exec(withHwDecode([...input.baseArgs, ...input.proxy.args]));
  } catch (e) {
    input.discard(input.proxy.part);
    input.warn(`[aviso] proxy ${PROXY.shortSide}p na leitura do transcribe falhou (${(e as Error).message.split(/\r?\n/)[0]}): áudio extraído sem ele; face/gaze leem o bruto 4K (#13508)`);
    return { stderr: input.exec([...input.baseArgs]), proxy: "failed" };
  }
  try {
    input.finish(input.proxy.part);
    return { stderr, proxy: "made" };
  } catch (e) {
    input.discard(input.proxy.part);
    input.warn(`[aviso] proxy ${PROXY.shortSide}p descartado (${(e as Error).message.split(/\r?\n/)[0]}): face/gaze leem o bruto 4K (#13508)`);
    return { stderr, proxy: "failed" };
  }
}
