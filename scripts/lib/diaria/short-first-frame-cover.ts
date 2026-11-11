/**
 * short-first-frame-cover.ts (#12100, opção 2 — decisão do editor de 11/11/2026)
 *
 * O `thumbnails.set` só troca a miniatura 16:9 do Short. A imagem do feed de
 * Shorts sem miniatura vertical própria é um frame automático do vídeo
 * (`i.ytimg.com/vi/{id}/oar2.jpg`). A aposta desta peça: pôr a capa vertical
 * (`04-youtube-short-capa.jpg`) nos PRIMEIROS frames do arquivo que vai para o
 * YouTube, por ~400 ms (arredondado ao frame; o registro grava o valor
 * efetivo) com áudio em silêncio, para o frame automático cair nela. O YouTube não garante pegar o 1º frame: o registro grava
 * `vertical_feed: "first_frame_cover"` (aplicado, NÃO confirmado) e a medição
 * é o `check-short-feed-cover.ts --image oar2` no Short seguinte.
 *
 * O arquivo derivado é gerado num diretório temporário e apagado depois do
 * upload: o vertical da pasta da edição (e o export do editor em `Final/`)
 * nunca é tocado, e os outros destinos (Reels, LinkedIn, X, Threads, TikTok)
 * seguem com o vertical original.
 *
 * Miolo puro (probe → plano → argumentos do ffmpeg → conferência da saída) +
 * um orquestrador com I/O injetado que NUNCA lança: qualquer falha volta
 * `ok: false` e o Short sobe com o vertical original (a capa no 1º frame é
 * sempre opcional). A saída do ffmpeg só vale depois de relida pelo ffprobe:
 * mesma W×H, áudio se e só se a origem tem, duração = original + capa.
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
/** fps acima disto é recusado (vertical da diar.ia.br sai a 30 fps; 120+ é metadado estranho, não vídeo real). */
export const FIRST_FRAME_MAX_FPS = 120;
/** Folga na conferência da duração da saída (s): o AAC e o arredondamento ao frame mexem nas bordas. */
export const FIRST_FRAME_DURATION_TOLERANCE_S = 0.2;
/** Divergência relativa entre `r_frame_rate` e `avg_frame_rate` a partir da qual vale o `avg` (VFR de celular). */
const FPS_DIVERGENCE = 0.1;

/** O que o ffprobe diz do vertical, no que importa para casar o still com ele. */
export interface VerticalProbe {
  width: number;
  height: number;
  /**
   * `r_frame_rate` como veio ("30/1", "30000/1001") — vai para o filtro `fps`
   * sem arredondar. Cai no `avg_frame_rate` quando o `r_frame_rate` é ilegível
   * ou diverge mais de 10% dele (VFR: o `r_frame_rate` é o menor intervalo, não
   * o ritmo do vídeo).
   */
  fpsExpr: string;
  /** O mesmo em número, para converter frames em segundos. */
  fps: number;
  hasAudio: boolean;
  audioSampleRate: number | null;
  audioChannels: number | null;
  /** Duração do container (s), ou a do stream de vídeo sem ela; null = o probe não trouxe nenhuma. */
  durationSeconds: number | null;
}

/** Pure: `r_frame_rate` → número. Inválido → null. */
export function parseFps(expr: string | undefined | null): number | null {
  if (!expr) return null;
  const [n, d] = expr.split("/").map(Number);
  const v = d === undefined ? n : d ? n / d : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Pure: escolhe a expressão de fps (ver `VerticalProbe.fpsExpr`); null = nenhuma legível. */
export function pickFpsExpr(rFrameRate: string | undefined, avgFrameRate: string | undefined): string | null {
  const r = parseFps(rFrameRate);
  const avg = parseFps(avgFrameRate);
  if (r !== null && avg !== null && Math.abs(r - avg) / avg > FPS_DIVERGENCE) return avgFrameRate!;
  if (r !== null) return rFrameRate!;
  return avg !== null ? avgFrameRate! : null;
}

function positiveSeconds(raw: string | undefined): number | null {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pure: lê o JSON de `ffprobe -show_streams -show_format`. Sem stream de vídeo,
 * sem dimensões, fps ilegível ou acima de `FIRST_FRAME_MAX_FPS` → lança (o
 * orquestrador transforma em `ok: false`).
 */
export function parseVerticalProbe(json: string): VerticalProbe {
  const j = JSON.parse(json) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      sample_rate?: string;
      channels?: number;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  const v = j.streams?.find((s) => s.codec_type === "video");
  if (!v || !(Number(v.width) > 0) || !(Number(v.height) > 0)) throw new Error("vertical sem stream de vídeo com dimensões");
  const fpsExpr = pickFpsExpr(v.r_frame_rate, v.avg_frame_rate);
  if (fpsExpr === null) throw new Error(`fps ilegível (r_frame_rate ${JSON.stringify(v.r_frame_rate)})`);
  const fps = parseFps(fpsExpr)!;
  if (fps > FIRST_FRAME_MAX_FPS) throw new Error(`fps ${fps.toFixed(1)} acima de ${FIRST_FRAME_MAX_FPS} (${fpsExpr}): metadado suspeito, não arrisca o encode`);
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const sr = a ? Number(a.sample_rate) : NaN;
  return {
    width: Number(v.width),
    height: Number(v.height),
    fpsExpr,
    fps,
    hasAudio: !!a,
    audioSampleRate: a && sr > 0 ? sr : null,
    audioChannels: a && Number(a.channels) > 0 ? Number(a.channels) : null,
    durationSeconds: positiveSeconds(j.format?.duration) ?? positiveSeconds(v.duration),
  };
}

export type FirstFrameCoverPlan =
  | { ok: true; frames: number; leadSeconds: number }
  | { ok: false; reason: string };

/**
 * Pure: quantos frames da capa entram no início. Pelo menos 1 frame; arredonda
 * os ms para o frame mais próximo. Recusa se o vertical + a capa passarem do
 * teto de Short (o YouTube trataria o upload como vídeo comum) e quando a
 * duração é desconhecida (não dá para garantir que não passa).
 */
export function planFirstFrameCover(input: { probe: VerticalProbe; leadMs: number; maxSeconds?: number }): FirstFrameCoverPlan {
  const max = input.maxSeconds ?? YOUTUBE_SHORT_MAX_SECONDS;
  const frames = Math.max(1, Math.round((input.leadMs / 1000) * input.probe.fps));
  const leadSeconds = frames / input.probe.fps;
  const dur = input.probe.durationSeconds;
  if (dur === null) return { ok: false, reason: "duração do vertical desconhecida (nem no container nem no stream de vídeo): sem como garantir o teto do Short" };
  if (dur + leadSeconds > max) {
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

/**
 * Pure: a saída do ffmpeg confere com o vertical? Mesma W×H, áudio se e só se
 * a origem tem, duração = original + capa (± `FIRST_FRAME_DURATION_TOLERANCE_S`).
 * null = confere; string = o motivo da divergência.
 */
export function checkFirstFrameCoverOutput(input: { source: VerticalProbe; output: VerticalProbe; leadSeconds: number }): string | null {
  const { source, output } = input;
  if (output.width !== source.width || output.height !== source.height) {
    return `saída ${output.width}x${output.height}, vertical ${source.width}x${source.height}`;
  }
  if (output.hasAudio !== source.hasAudio) return source.hasAudio ? "saída sem áudio, o vertical tem" : "saída com áudio, o vertical não tem";
  if (source.durationSeconds === null) return "duração do vertical desconhecida";
  if (output.durationSeconds === null) return "duração da saída desconhecida";
  const expected = source.durationSeconds + input.leadSeconds;
  if (Math.abs(output.durationSeconds - expected) > FIRST_FRAME_DURATION_TOLERANCE_S) {
    return `saída de ${output.durationSeconds.toFixed(2)} s, esperado ${expected.toFixed(2)} s (vertical + capa)`;
  }
  return null;
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
  /** Avisos que não derrubam o resultado (ex.: temporário não apagado). Ausente = silêncio. */
  log?: (line: string) => void;
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
    const outProbe = deps.runFfprobe(buildVerticalProbeArgs(output));
    if (!outProbe.ok) return { ok: false, error: `ffprobe da saída falhou: ${outProbe.error}` };
    const mismatch = checkFirstFrameCoverOutput({ source: probe, output: parseVerticalProbe(outProbe.stdout), leadSeconds: plan.leadSeconds });
    if (mismatch) return { ok: false, error: `saída do ffmpeg não confere (${mismatch})` };
    return { ok: true, bytes, frames: plan.frames, leadMs: Math.round(plan.leadSeconds * 1000), probe };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    if (tmp) {
      try {
        deps.removeDir(tmp);
      } catch (e) {
        // Não derruba o upload: o SO limpa o temporário, mas fica dito onde ele ficou.
        deps.log?.(`[aviso] youtube_shorts: diretório temporário ${tmp} não apagado (${(e as Error).message})`);
      }
    }
  }
}
