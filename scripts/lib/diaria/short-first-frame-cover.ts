/**
 * short-first-frame-cover.ts (#12100, opção 2 — decisão do editor de 11/11/2026)
 *
 * O `thumbnails.set` só troca a miniatura 16:9 do Short. A imagem do feed de
 * Shorts sem miniatura vertical própria é um frame automático do vídeo
 * (`i.ytimg.com/vi/{id}/oar2.jpg`). A aposta desta peça: pôr a capa vertical
 * (`04-youtube-short-capa.jpg`) nos PRIMEIROS frames do arquivo que vai para o
 * YouTube, por ~0,4 s com áudio em silêncio, para o frame automático cair
 * nela. O YouTube não garante pegar o 1º frame: o registro grava
 * `vertical_feed: "first_frame_cover"` (aplicado, NÃO confirmado) e a medição
 * é o `check-short-feed-cover.ts --image oar2` no Short seguinte.
 *
 * O arquivo derivado é gerado num diretório temporário e apagado depois do
 * upload: o vertical da pasta da edição (e o export do editor em `Final/`)
 * nunca é tocado, e os outros destinos (Reels, LinkedIn, X, Threads, TikTok)
 * seguem com o vertical original.
 *
 * Miolo puro (probe → plano → argumentos do ffmpeg) + um orquestrador com I/O
 * injetado que NUNCA lança: qualquer falha volta `ok: false` e o Short sobe com
 * o vertical original (a capa no 1º frame é sempre opcional).
 */

/** Duração default da capa no início do vertical do YouTube (ms). */
export const SHORT_FIRST_FRAME_COVER_DEFAULT_MS = 400;
/** Faixa aceita em `publishing.shorts.youtube_first_frame_cover_ms`. */
export const SHORT_FIRST_FRAME_COVER_MIN_MS = 100;
export const SHORT_FIRST_FRAME_COVER_MAX_MS = 2000;
/** Teto de duração de um Short no YouTube (3 min desde 15/10/2024). */
export const YOUTUBE_SHORT_MAX_SECONDS = 180;
/** Teto de cada passada do ffmpeg/ffprobe. */
export const FIRST_FRAME_FFMPEG_TIMEOUT_MS = 15 * 60_000;

/** O que o ffprobe diz do vertical, no que importa para casar o still com ele. */
export interface VerticalProbe {
  width: number;
  height: number;
  /** `r_frame_rate` como veio ("30/1", "30000/1001") — vai para o filtro `fps` sem arredondar. */
  fpsExpr: string;
  /** O mesmo em número, para converter frames em segundos. */
  fps: number;
  hasAudio: boolean;
  audioSampleRate: number | null;
  audioChannels: number | null;
  /** Duração do container (s); null = o probe não trouxe. */
  durationSeconds: number | null;
}

/** Pure: `r_frame_rate` → número. Inválido → null. */
export function parseFps(expr: string | undefined | null): number | null {
  if (!expr) return null;
  const [n, d] = expr.split("/").map(Number);
  const v = d === undefined ? n : d ? n / d : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Pure: lê o JSON de `ffprobe -show_streams -show_format`. Sem stream de vídeo,
 * sem dimensões ou fps ilegível → lança (o orquestrador transforma em
 * `ok: false`).
 */
export function parseVerticalProbe(json: string): VerticalProbe {
  const j = JSON.parse(json) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; sample_rate?: string; channels?: number }>;
    format?: { duration?: string };
  };
  const v = j.streams?.find((s) => s.codec_type === "video");
  if (!v || !(Number(v.width) > 0) || !(Number(v.height) > 0)) throw new Error("vertical sem stream de vídeo com dimensões");
  const fpsExpr = parseFps(v.r_frame_rate) !== null ? v.r_frame_rate! : parseFps(v.avg_frame_rate) !== null ? v.avg_frame_rate! : null;
  if (fpsExpr === null) throw new Error(`fps ilegível (r_frame_rate ${JSON.stringify(v.r_frame_rate)})`);
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const sr = a ? Number(a.sample_rate) : NaN;
  const dur = Number(j.format?.duration);
  return {
    width: Number(v.width),
    height: Number(v.height),
    fpsExpr,
    fps: parseFps(fpsExpr)!,
    hasAudio: !!a,
    audioSampleRate: a && sr > 0 ? sr : null,
    audioChannels: a && Number(a.channels) > 0 ? Number(a.channels) : null,
    durationSeconds: Number.isFinite(dur) && dur > 0 ? dur : null,
  };
}

export type FirstFrameCoverPlan =
  | { ok: true; frames: number; leadSeconds: number }
  | { ok: false; reason: string };

/**
 * Pure: quantos frames da capa entram no início. Pelo menos 1 frame; arredonda
 * os ms para o frame mais próximo. Recusa se o vertical + a capa passarem do
 * teto de Short (o YouTube trataria o upload como vídeo comum).
 */
export function planFirstFrameCover(input: { probe: VerticalProbe; leadMs: number; maxSeconds?: number }): FirstFrameCoverPlan {
  const max = input.maxSeconds ?? YOUTUBE_SHORT_MAX_SECONDS;
  const frames = Math.max(1, Math.round((input.leadMs / 1000) * input.probe.fps));
  const leadSeconds = frames / input.probe.fps;
  const dur = input.probe.durationSeconds;
  if (dur !== null && dur + leadSeconds > max) {
    return { ok: false, reason: `vertical de ${dur.toFixed(1)} s + ${leadSeconds.toFixed(2)} s de capa passa do teto de ${max} s do Short` };
  }
  return { ok: true, frames, leadSeconds };
}

/**
 * Pure: argumentos do ffmpeg. Entradas: 0 = a capa em loop no fps do vertical;
 * 1 = silêncio (`anullsrc`) com a taxa/canais do áudio do vertical (só se ele
 * tiver áudio); última = o vertical. A capa é escalada para caber em W×H do
 * vertical e completada com preto (capa 9:16 de outro tamanho não distorce),
 * cortada em `frames` frames; o silêncio, na mesma duração. `concat` junta
 * capa + vertical num encode H.264/AAC (yuv420p, `+faststart`), o mesmo
 * formato que o YouTube recebe hoje.
 */
export function buildFirstFrameCoverFfmpegArgs(input: {
  cover: string;
  video: string;
  output: string;
  probe: VerticalProbe;
  frames: number;
}): string[] {
  const { probe, frames } = input;
  const W = probe.width;
  const H = probe.height;
  const leadSeconds = (frames / probe.fps).toFixed(6);
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", probe.fpsExpr, "-i", input.cover];
  const coverChain =
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `setsar=1,fps=${probe.fpsExpr},format=yuv420p,trim=end_frame=${frames},setpts=PTS-STARTPTS[cv]`;
  if (probe.hasAudio) {
    const sr = probe.audioSampleRate ?? 48000;
    const layout = probe.audioChannels === 1 ? "mono" : "stereo";
    args.push("-f", "lavfi", "-i", `anullsrc=channel_layout=${layout}:sample_rate=${sr}`, "-i", input.video);
    const filter =
      `${coverChain};[1:a]atrim=end=${leadSeconds},asetpts=PTS-STARTPTS[ca];` +
      `[2:v]setsar=1,fps=${probe.fpsExpr},format=yuv420p[mv];[2:a]aresample=${sr},aformat=channel_layouts=${layout}[ma];` +
      `[cv][ca][mv][ma]concat=n=2:v=1:a=1[v][a]`;
    args.push("-filter_complex", filter, "-map", "[v]", "-map", "[a]");
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-i", input.video);
    const filter = `${coverChain};[1:v]setsar=1,fps=${probe.fpsExpr},format=yuv420p[mv];[cv][mv]concat=n=2:v=1:a=0[v]`;
    args.push("-filter_complex", filter, "-map", "[v]");
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p");
  }
  args.push("-movflags", "+faststart", input.output);
  return args;
}

/** Pure: argumentos do ffprobe para `parseVerticalProbe`. */
export function buildVerticalProbeArgs(video: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", video];
}

export interface FirstFrameCoverDeps {
  runFfprobe: (args: string[]) => { ok: true; stdout: string } | { ok: false; error: string };
  runFfmpeg: (args: string[]) => { ok: true } | { ok: false; error: string };
  /** Diretório temporário novo (o chamador apaga com `removeDir`). */
  makeTempDir: () => string;
  writeFile: (path: string, bytes: Buffer) => void;
  readFile: (path: string) => Buffer;
  removeDir: (dir: string) => void;
}

export type FirstFrameCoverResult =
  | { ok: true; bytes: Buffer; frames: number; leadMs: number; probe: VerticalProbe }
  | { ok: false; error: string };

/**
 * Gera o vertical do YouTube com a capa nos primeiros frames. NUNCA lança: o
 * chamador sobe o vertical original quando `ok: false`. `videoPath` é lido só
 * pelo ffmpeg/ffprobe (nunca escrito); a capa vai de `cover` (bytes) para um
 * arquivo no diretório temporário, que é apagado no fim, com ou sem sucesso.
 */
export function prepareYouTubeFirstFrameCover(
  deps: FirstFrameCoverDeps,
  input: { videoPath: string; cover: Buffer; leadMs: number },
): FirstFrameCoverResult {
  let tmp: string | null = null;
  try {
    const pr = deps.runFfprobe(buildVerticalProbeArgs(input.videoPath));
    if (!pr.ok) return { ok: false, error: `ffprobe falhou: ${pr.error}` };
    const probe = parseVerticalProbe(pr.stdout);
    const plan = planFirstFrameCover({ probe, leadMs: input.leadMs });
    if (!plan.ok) return { ok: false, error: plan.reason };
    tmp = deps.makeTempDir();
    const coverFile = `${tmp}/capa.jpg`;
    const output = `${tmp}/youtube-short-first-frame.mp4`;
    deps.writeFile(coverFile, input.cover);
    const r = deps.runFfmpeg(buildFirstFrameCoverFfmpegArgs({ cover: coverFile, video: input.videoPath, output, probe, frames: plan.frames }));
    if (!r.ok) return { ok: false, error: `ffmpeg falhou: ${r.error}` };
    const bytes = deps.readFile(output);
    if (bytes.length === 0) return { ok: false, error: "ffmpeg terminou com arquivo vazio" };
    return { ok: true, bytes, frames: plan.frames, leadMs: Math.round(plan.leadSeconds * 1000), probe };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    if (tmp) {
      try {
        deps.removeDir(tmp);
      } catch {
        // diretório temporário: o SO limpa; não derruba o upload
      }
    }
  }
}
