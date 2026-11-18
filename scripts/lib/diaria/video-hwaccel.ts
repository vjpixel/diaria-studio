/**
 * #13507: decode do bruto 4K HEVC pela GPU (`-hwaccel cuda`) na prévia, nos
 * trechos do XML leve e nos frames do face/gaze, com queda para a CPU.
 *
 * Medido no Neo (RTX 4060): prévia de 11 clipes 48,7 s → 11,6 s; trecho de
 * 10 s com NVENC 8,7 s → 4,5 s; frame 1,15 s → 0,40 s. Sem GPU (o 300 com o
 * NVML quebrado, #13505), juntar os frames num processo só do ffmpeg dá 4,10 s
 * contra 11,48 s por 10 frames (`batchFrameArgs`).
 *
 * Política (`createHwDecoder`): a GPU é tentada quando o ffmpeg lista `cuda`
 * em `-hwaccels` e `DIARIA_VIDEO_HWACCEL` não é `0`. Comando que falha com a
 * GPU é refeito na CPU; se a CPU passa, a falha era da GPU: `[aviso]` uma vez e
 * o resto da execução segue na CPU. Se a CPU também falha, o erro é do comando
 * (tempo além do fim, arquivo ausente) e sobe como sempre, sem desligar a GPU.
 * Sem `-hwaccel_output_format cuda`: os quadros voltam para a memória e os
 * filtros de software (crop, scale, hflip, fps) seguem iguais.
 */

export const HWACCEL_ENV = "DIARIA_VIDEO_HWACCEL";

/** `ffmpeg -hide_banner -hwaccels` lista `cuda`? */
export function ffmpegListsCuda(listing: string): boolean {
  return /^\s*cuda\s*$/m.test(listing);
}

/**
 * `-hwaccel cuda` antes do 1º `-i` (o vídeo do bruto, nos comandos de decode
 * daqui) ou, com `all`, antes de cada `-i` (frames em lote, todas as entradas
 * são o bruto). Nunca duplica um `-hwaccel` que já esteja nos argumentos.
 */
export function withHwDecode(args: readonly string[], opts: { all?: boolean } = {}): string[] {
  if (args.includes("-hwaccel")) return [...args];
  const out: string[] = [];
  let done = false;
  for (const a of args) {
    if (a === "-i" && (!done || opts.all)) {
      out.push("-hwaccel", "cuda");
      done = true;
    }
    out.push(a);
  }
  return out;
}

export type HwDecodeState = "unknown" | "cuda" | "cpu";

export interface HwDecoder {
  /** Roda `exec` com a GPU quando disponível e cai para a CPU; devolve onde rodou. */
  run(args: readonly string[], exec: (args: string[]) => void, what: string, opts?: { all?: boolean }): "cuda" | "cpu";
  state(): HwDecodeState;
}

export function createHwDecoder(deps: { listHwaccels: () => string; env?: Record<string, string | undefined>; warn: (line: string) => void }): HwDecoder {
  let state: HwDecodeState = "unknown";
  const resolveState = (): HwDecodeState => {
    if (state !== "unknown") return state;
    const env = deps.env ?? process.env;
    if ((env[HWACCEL_ENV] ?? "").trim() === "0") return (state = "cpu");
    let listing = "";
    try {
      listing = deps.listHwaccels();
    } catch {
      listing = "";
    }
    return (state = ffmpegListsCuda(listing) ? "cuda" : "cpu");
  };
  return {
    state: () => state,
    run(args, exec, what, opts = {}) {
      if (resolveState() !== "cuda") {
        exec([...args]);
        return "cpu";
      }
      try {
        exec(withHwDecode(args, opts));
        return "cuda";
      } catch (gpuErr) {
        // Refaz na CPU; só a CPU passando prova que a falha era da GPU.
        exec([...args]);
        state = "cpu";
        const why = (gpuErr as Error).message.split(/\r?\n/)[0];
        deps.warn(`[aviso] decode pela GPU (-hwaccel cuda) falhou em ${what} (${why}): segue na CPU nesta execução (#13507)`);
        return "cpu";
      }
    },
  };
}

/**
 * Prévia com a GPU caindo no meio (#13530 review): os clipes feitos pela GPU
 * podem sair com outro pix_fmt (nv12/p010 entregue ao libx264) que os da CPU
 * (yuv420p/yuv420p10le), e o `concat -c copy` exige parâmetros iguais. Devolve
 * os índices dos clipes feitos pela GPU quando algum outro saiu da CPU, para
 * serem refeitos na CPU e a prévia ficar uniforme; prévia toda num só device: [].
 */
export function clipsToRedoOnCpu(devices: readonly ("cuda" | "cpu")[]): number[] {
  if (!devices.includes("cpu")) return [];
  return devices.flatMap((d, i) => (d === "cuda" ? [i] : []));
}

/** Um frame a extrair do bruto: tempo LOCAL no arquivo, espelhamento e o PNG de saída. */
export interface FrameJob {
  src: string;
  atS: number;
  mirrored: boolean;
  out: string;
}

/** Entradas por processo do ffmpeg nos frames em lote: cada `-i` abre um decoder 4K. */
export const FRAME_BATCH_SIZE = 8;

/**
 * Um processo do ffmpeg para vários frames: uma entrada por frame (`-ss` antes
 * do `-i`, seek rápido e exato como no frame avulso) e uma saída por entrada,
 * cada uma com o próprio `hflip` e a largura pedida (720 px no face/gaze).
 */
export function batchFrameArgs(jobs: readonly FrameJob[], opts: { width: number }): string[] {
  if (!jobs.length) throw new Error("batchFrameArgs: nenhum frame");
  const args = ["-hide_banner", "-v", "error", "-y"];
  for (const j of jobs) args.push("-ss", j.atS.toFixed(3), "-i", j.src);
  jobs.forEach((j, k) => {
    args.push("-map", `${k}:v:0`, "-frames:v", "1", "-vf", `${j.mirrored ? "hflip," : ""}scale=${opts.width}:-2`, j.out);
  });
  return args;
}

/** `jobs` em lotes de até `size`. */
export function chunkFrameJobs<T>(jobs: readonly T[], size = FRAME_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < jobs.length; i += size) out.push(jobs.slice(i, i + size));
  return out;
}
