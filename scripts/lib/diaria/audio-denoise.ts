/**
 * audio-denoise.ts (#13234) — o motor de redução de ruído da faixa de áudio
 * tratada do `video-montagem.ts build` (#12102), e as medidas para comparar
 * motores no mesmo trecho.
 *
 * Contexto: em 261116 a faixa tratada (`afftdn` + `agate`, #12102/#12262) ainda
 * veio com ruído externo, e o editor seguiu passando o áudio pelo Enhance do
 * Adobe Podcast à mão. Com bruto baixo (-31 LUFS, piso a -52 dB), o DSP
 * clássico tira pouco sem passar a comer a voz.
 *
 * Dois motores:
 *  - `ffmpeg` (padrão): a cadeia de sempre, `AUDIO_CLEAN` em `video-montage.ts`;
 *  - `deepfilternet`: o binário `deep-filter` do DeepFilterNet 3 (realce neural
 *    de fala, local, CPU, sem custo recorrente). O binário não vem com o repo:
 *    `docs/setup.md`, seção "Vídeo: montagem".
 *
 * O padrão segue `ffmpeg` até o editor escolher de ouvido (A/B cego,
 * `scripts/video-audio-denoise-ab.ts`): escolha que depende de audição não sai
 * de teste com áudio sintético. Para trocar: `--audio-denoise deepfilternet` no
 * build ou `DIARIA_VIDEO_AUDIO_DENOISE=deepfilternet` no `.env`.
 *
 * Premissa sobre a CLI do `deep-filter` (o `enhance_wav` do DeepFilterNet,
 * conferida pela leitura do código, não rodada nesta máquina): flags longas
 * `--compensate-delay`, `--atten-lim-db` e `--output-dir`, e o WAV de saída
 * com o MESMO nome do de entrada dentro do `--output-dir`. O
 * `check-video-env.ts --montagem` confere as três flags no `--help` do binário
 * instalado (`deepFilterHelpMissingFlags`); flag ausente = aviso lá, e o build
 * cai no ffmpeg com `[aviso]` se o binário falhar.
 */

import { basename, join } from "node:path";

export type AudioDenoiseEngine = "ffmpeg" | "deepfilternet";

export const AUDIO_DENOISE_ENGINES: readonly AudioDenoiseEngine[] = ["ffmpeg", "deepfilternet"];

export interface AudioDenoiseChoice {
  engine: AudioDenoiseEngine;
  /**
   * Só no `deepfilternet`: teto da atenuação (dB), mistura do sinal realçado
   * com o original. `null` = sem teto (o padrão do binário, 100 dB). Valor
   * menor é a "intensidade reduzida" do A/B: menos artefato na voz, mais
   * ruído residual.
   */
  attenDb: number | null;
  /** De onde veio a escolha (para o log). */
  from: "flag" | "env" | "default";
}

/** Binário do DeepFilterNet: `DIARIA_DEEP_FILTER` (caminho) ou `deep-filter` do PATH. */
export function deepFilterBin(env: string | undefined): string {
  return env && env.trim() ? env.trim() : "deep-filter";
}

/** Flags longas da CLI que o render usa; o check de ambiente as procura no `--help`. */
export const DEEP_FILTER_FLAGS = ["--compensate-delay", "--atten-lim-db", "--output-dir"] as const;

/** Intensidade reduzida do A/B (dB de teto da atenuação), quando `--df-atten-db` não é dado. */
export const DEEP_FILTER_REDUCED_ATTEN_DB = 18;

function parseAttenDb(raw: string, label: string): number {
  const n = Number(raw);
  if (!raw.trim() || !Number.isFinite(n) || n <= 0 || n > 100) throw new Error(`${label} espera dB entre 0 e 100 (recebido: "${raw}")`);
  return n;
}

/**
 * Escolha do motor: `--audio-denoise` > `DIARIA_VIDEO_AUDIO_DENOISE` > `ffmpeg`;
 * teto do DeepFilterNet: `--df-atten-db` > `DIARIA_VIDEO_DF_ATTEN_DB` > sem teto.
 * Valor inválido LANÇA (o build para antes de baixar o bruto): motor digitado
 * errado cair no padrão em silêncio trocaria o tratamento sem aviso.
 */
export function resolveAudioDenoise(opts: { flag?: string; env?: string; attenFlag?: string; attenEnv?: string }): AudioDenoiseChoice {
  const raw = opts.flag ?? (opts.env && opts.env.trim() ? opts.env : undefined);
  const from: AudioDenoiseChoice["from"] = opts.flag !== undefined ? "flag" : raw !== undefined ? "env" : "default";
  const engine = (raw ?? "ffmpeg").trim().toLowerCase();
  if (!(AUDIO_DENOISE_ENGINES as readonly string[]).includes(engine)) {
    throw new Error(`--audio-denoise / DIARIA_VIDEO_AUDIO_DENOISE: "${raw}" não é motor conhecido (${AUDIO_DENOISE_ENGINES.join(" | ")}) (#13234)`);
  }
  const attenRaw = opts.attenFlag ?? (opts.attenEnv && opts.attenEnv.trim() ? opts.attenEnv : undefined);
  const attenDb = attenRaw === undefined ? null : parseAttenDb(attenRaw, "--df-atten-db / DIARIA_VIDEO_DF_ATTEN_DB");
  return { engine: engine as AudioDenoiseEngine, attenDb: engine === "deepfilternet" ? attenDb : null, from };
}

/** Args do `deep-filter` sobre um WAV mono 48 kHz; a saída sai em `outDir/{basename(input)}`. */
export function deepFilterArgs(input: { wav: string; outDir: string; attenDb: number | null }): string[] {
  return ["--compensate-delay", ...(input.attenDb !== null ? ["--atten-lim-db", String(input.attenDb)] : []), "--output-dir", input.outDir, input.wav];
}

/** Onde o `deep-filter` grava o WAV realçado (premissa do cabeçalho). */
export function deepFilterOutputPath(input: { wav: string; outDir: string }): string {
  return join(input.outDir, basename(input.wav));
}

/** WAV de entrada do modelo: o áudio do bruto, mono 48 kHz PCM 16 bits (o que o DeepFilterNet 3 espera). */
export function deepFilterInputArgs(input: { src: string; out: string }): string[] {
  return ["-y", "-v", "error", "-i", input.src, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav", input.out];
}

/** Versão do binário a partir da saída de `deep-filter --version` (ex.: `deep-filter 0.5.6`); `null` sem número. */
export function parseDeepFilterVersion(stdout: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/.exec(stdout);
  return m ? m[1] : null;
}

/** Flags que o render usa e que o `--help` do binário instalado não mostra (lista vazia = a CLI bate com a premissa). */
export function deepFilterHelpMissingFlags(help: string): string[] {
  return DEEP_FILTER_FLAGS.filter((f) => !help.includes(f));
}

/**
 * Item `deepfilter` do `check-video-env.ts --montagem` a partir das saídas de
 * `--version` e `--help` (`null` = o comando não rodou). Ok só com versão
 * legível E as flags do render no `--help`: um binário com outra CLI falharia
 * no build e cairia no ffmpeg, então conta como ausente aqui.
 */
export function assessDeepFilterProbe(input: { bin: string; version: string | null; help: string | null; error?: string }): { ok: boolean; detail: string } {
  if (input.error) return { ok: false, detail: `${input.bin} indisponível: ${input.error}` };
  const version = input.version !== null ? parseDeepFilterVersion(input.version) : null;
  if (!version) return { ok: false, detail: `${input.bin} --version sem número de versão` };
  const missing = deepFilterHelpMissingFlags(input.help ?? "");
  if (missing.length) return { ok: false, detail: `${input.bin} ${version} sem ${missing.join(", ")} no --help (a CLI não bate com a do render, #13234)` };
  return { ok: true, detail: `${input.bin} ${version}` };
}

/**
 * Descritor do tratamento DeepFilterNet: entra no hash da faixa tratada
 * (`cleanAudioKey`) e na versão do XML, com motor, versão e teto. Trocar o
 * modelo ou a versão grava um WAV novo em vez de reaproveitar o anterior
 * (#12102).
 */
export function deepFilterDescriptor(version: string, attenDb: number | null): string {
  return `deepfilternet=version=${version}:atten_lim_db=${attenDb ?? "off"}:compensate_delay=1`;
}

// ── Medidas para o A/B (#13234) ────────────────────────────────────────────

export interface AudioLevelStats {
  /** Piso nas pausas: percentil 10 da energia por janela (dBFS). */
  floorDb: number;
  /** Nível da fala: percentil 90 da energia por janela (dBFS). */
  speechDb: number;
  /** `speechDb - floorDb`: a separação entre fala e fundo. */
  separationDb: number;
}

const FLOOR = -120;

/** Energia por janela (dBFS), sem sobreposição. */
export function windowDb(samples: Int16Array | Float32Array, sampleRate: number, winS = 0.05): number[] {
  const scale = samples instanceof Int16Array ? 32768 : 1;
  const n = Math.max(1, Math.round(winS * sampleRate));
  const out: number[] = [];
  for (let a = 0; a + n <= samples.length; a += n) {
    let s = 0;
    for (let i = a; i < a + n; i++) s += (samples[i] / scale) ** 2;
    const ms = s / n;
    out.push(ms > 0 ? Math.max(FLOOR, 10 * Math.log10(ms)) : FLOOR);
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return FLOOR;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** Piso das pausas, nível da fala e a separação entre os dois. */
export function audioLevelStats(samples: Int16Array | Float32Array, sampleRate: number, winS = 0.05): AudioLevelStats {
  const db = windowDb(samples, sampleRate, winS).sort((a, b) => a - b);
  const floorDb = percentile(db, 10);
  const speechDb = percentile(db, 90);
  return { floorDb, speechDb, separationDb: speechDb - floorDb };
}

/** Embaralha (Fisher-Yates) com gerador injetável: a ordem do A/B cego. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
