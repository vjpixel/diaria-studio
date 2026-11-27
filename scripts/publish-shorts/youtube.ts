/**
 * YouTube Short: arquivo de upload, capa do 1º frame e publicação.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShortPublishedEntry } from "../lib/diaria/short-video.ts";
import { checkYouTubeAudio, describeYouTubeAudioCheck, mp4HasAudioTrack } from "../lib/diaria/youtube-audio-check.ts";
import { buildYouTubeInsertRequest, buildYouTubeTags, type YouTubeScheduleDecision } from "../lib/diaria/youtube-video.ts";
import {
  ExistingEditionVideoError,
  defaultYouTubeUploadDeps,
  describeYouTubeState,
  failedUploadStatus,
  isIndeterminateUploadFailure,
  missingYouTubeCredentials,
  uploadYouTubeVideo,
  type YouTubeUploadDeps,
} from "../lib/diaria/youtube-upload.ts";
import { resolveYouTubeState } from "../lib/publish-state.ts";
import { youtubeShortsCoverRecord, youtubeShortsVerticalCoverWarning } from "../lib/diaria/short-cover.ts";
import { FIRST_FRAME_FFMPEG_TIMEOUT_MS, prepareYouTubeFirstFrameCover, type FirstFrameCoverDeps } from "../lib/diaria/short-first-frame-cover.ts";
import { readShortReplacements } from "../lib/diaria/shorts-published-store.ts";
import type { PublishOutcome } from "./facebook.ts";
import type { ShortsPublishItem, ShortsSendContext, ShortsSendStep } from "./send-context.ts";

/** #12100 opção 2: I/O real da capa no 1º frame (ffprobe/ffmpeg do PATH, diretório em `os.tmpdir()`). */
export const defaultFirstFrameCoverDeps: FirstFrameCoverDeps = {
  runFfprobe: (args) => {
    const r = spawnSync("ffprobe", args, { encoding: "utf8", timeout: 60_000 });
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0) return { ok: false, error: (r.stderr ?? "").trim().slice(-500) || `exit ${r.status}` };
    return { ok: true, stdout: r.stdout };
  },
  runFfmpeg: (args) => {
    const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: FIRST_FRAME_FFMPEG_TIMEOUT_MS });
    if (r.error) return { ok: false, error: `${r.error.message}${r.signal ? ` (sinal ${r.signal})` : ""}` };
    if (r.signal) return { ok: false, error: `ffmpeg encerrado por ${r.signal}` };
    if (r.status !== 0) return { ok: false, error: (r.stderr ?? "").trim().slice(-500) || `exit ${r.status}` };
    return { ok: true };
  },
  makeTempDir: () => mkdtempSync(join(tmpdir(), "diaria-short-first-frame-")),
  writeFile: (p, b) => writeFileSync(p, b),
  readFile: (p) => readFileSync(p),
  removeDir: (d) => rmSync(d, { recursive: true, force: true }),
};

/**
 * #12100 opção 2: o arquivo que sobe para o YouTube Shorts. Com a opção ligada
 * e a capa no disco, o vertical ganha a capa nos primeiros `leadMs`; desligada,
 * sem capa (ou capa ilegível, `coverUnreadable`) ou com falha do ffmpeg, sobe o
 * vertical original (com `[aviso]` na falha). Loga o que foi feito — "arquivo
 * preparado", nunca "enviado": roda antes do upload. Nunca lança.
 */
export function youtubeShortUploadFile(input: {
  file: Buffer;
  videoPath: string;
  cover: Buffer | null;
  /** #12100: motivo da leitura falha da capa (`readShortCover().unreadable`): a capa existe, mas não deu para ler. */
  coverUnreadable?: string;
  leadMs: number | null;
  log: (line: string) => void;
  deps?: FirstFrameCoverDeps;
}): { file: Buffer; firstFrame: { ms: number } | null } {
  if (input.leadMs === null) {
    input.log("[premissa] youtube_shorts: capa no 1º frame desligada (publishing.shorts.youtube_first_frame_cover = false) — sobe o vertical original");
    return { file: input.file, firstFrame: null };
  }
  if (!input.cover) {
    input.log(
      input.coverUnreadable
        ? `[aviso] youtube_shorts: capa local ilegível (${input.coverUnreadable}), o vertical sobe sem a capa no 1º frame (#12100)`
        : "[aviso] youtube_shorts: sem capa local, o vertical sobe sem a capa no 1º frame (#12100)",
    );
    return { file: input.file, firstFrame: null };
  }
  const deps = { ...(input.deps ?? defaultFirstFrameCoverDeps), log: input.log };
  const r = prepareYouTubeFirstFrameCover(deps, { videoPath: input.videoPath, cover: input.cover, leadMs: input.leadMs });
  if (!r.ok) {
    input.log(`[aviso] youtube_shorts: capa no 1º frame não aplicada (${r.error}) — sobe o vertical original (#12100)`);
    return { file: input.file, firstFrame: null };
  }
  input.log(
    `[ok] youtube_shorts: arquivo preparado com a capa nos primeiros ${r.leadMs} ms (${r.frames} frames a ${r.probe.fpsExpr} fps, ${r.probe.width}x${r.probe.height}); ` +
      `${(r.bytes.length / 1e6).toFixed(1)} MB em memória, o vertical da edição não muda (#12100, não confirmado: medir o oar2.jpg)`,
  );
  return { file: r.bytes, firstFrame: { ms: r.leadMs } };
}

/**
 * #12100 opção 2 (review da PR #12844): o `youtube_shorts` desta rodada prepara
 * o arquivo com a capa no 1º frame? Só no `publish` e com a credencial do
 * canal no ambiente. Pure; o CLI chama ANTES de `markShortSending`.
 */
export function youtubeShortsPrepareBeforeMarker(
  item: { destination: string; action?: string },
  env: Record<string, string | undefined>,
): boolean {
  return item.destination === "youtube_shorts" && item.action === "publish" && missingYouTubeCredentials(env).length === 0;
}

/**
 * #12279: IDs de Short que uma troca tirou de cena (histórico). Histórico
 * ilegível lança: a conferência do canal não segue às cegas.
 */
export function replacedYouTubeIds(dir: string): string[] {
  return readShortReplacements(dir).filter((r) => r.destination === "youtube_shorts").map((r) => r.id);
}

/**
 * #14204: etapa do YouTube Short no laço do `--publish` (`mainUnlocked`).
 * `prepared` é o arquivo que o laço montou ANTES do marcador de envio (capa no
 * 1º frame, #12100 opção 2); `null` = sem credencial, sobe o original e
 * `publishYouTubeShort` recusa. O `send_unknown` vai ao registro antes do PUT.
 */
export async function sendYouTubeShortItem(
  ctx: ShortsSendContext,
  item: ShortsPublishItem,
  prepared: { file: Buffer; firstFrame: { ms: number } | null } | null,
  uploadDeps: YouTubeUploadDeps = defaultYouTubeUploadDeps,
): Promise<ShortsSendStep> {
  // #12100 opção 2: o arquivo foi preparado antes do marcador (acima); sem credencial, sobe o original (e a função recusa).
  const yt = prepared ?? { file: ctx.file, firstFrame: null };
  const { corte, videoHash } = ctx;
  const outcome = await publishYouTubeShort({
    deps: uploadDeps,
    env: process.env,
    aammdd: ctx.aammdd,
    title: item.title ?? ctx.plan.youtube.title,
    description: item.caption,
    scheduledAt: item.scheduledAt,
    file: yt.file,
    firstFrame: yt.firstFrame,
    cover: ctx.shortCover.bytes,
    force: ctx.forceYouTube,
    // #12279: o Short antigo de uma troca (private sem agendamento no canal) nunca conta como "já está lá".
    ignoreVideoIds: replacedYouTubeIds(ctx.dir),
    matchTitleOnly: corte !== null,
    ...(corte ? { corteSlug: corte.slug } : {}),
    // Grava send_unknown antes do PUT: um processo morto no upload não duplica o Short.
    onBeforeBytes: (marker) => {
      ctx.registry.persist(videoHash ? { ...marker, video_sha256: videoHash } : marker);
    },
  });
  return { kind: "outcome", outcome };
}

/** URL pública do Short (#11070) — o `youtu.be/{id}` também abre, mas o registro guarda a de Shorts. */
export function youtubeShortUrl(videoId: string): string {
  return `https://youtube.com/shorts/${videoId}`;
}

/**
 * #11070: Short pela YouTube Data API — o mesmo `uploadYouTubeVideo` do
 * horizontal (`publish-youtube.ts`), com `publishAt` no horário do vertical.
 * Capa (#11547): `thumbnails.set` com o Still depois do insert — vale pra Short
 * (HTTP 200 medido pelo editor em 28/10/2026); falha só vira aviso. Antes de enviar confere o canal (`kind: "short"`): Short da edição já
 * lá (subido à mão) vira registro, sem novo upload; reconhecido só pelo dia,
 * lança pedindo confirmação (`--mark youtube_shorts=URL` ou `--force-youtube`).
 * Falha a partir do PUT dos bytes devolve `send_unknown` (o vídeo PODE
 * existir; a próxima rodada não re-envia). `onBeforeBytes` recebe o mesmo
 * `send_unknown` pra gravar ANTES do PUT: um processo morto no meio do upload
 * também não duplica.
 */
export async function publishYouTubeShort(input: {
  deps: YouTubeUploadDeps;
  env: Record<string, string | undefined>;
  aammdd: string;
  title: string;
  description: string;
  scheduledAt: string | null;
  file: Buffer;
  /** `--force-youtube`: pula a conferência do canal. */
  force: boolean;
  /** #12279: IDs que a conferência do canal ignora (o Short trocado pelo --replace-scheduled). */
  ignoreVideoIds?: readonly string[];
  onBeforeBytes?: (entry: ShortPublishedEntry) => void;
  /** #11547: capa (JPEG) — `thumbnails.set` depois do insert; falha não desfaz o Short. */
  cover?: Buffer | null;
  /**
   * #12100 opção 2: `file` já leva a capa nos primeiros `ms` (gerado por
   * `prepareYouTubeFirstFrameCover`). Só muda o registro: `vertical_feed:
   * "first_frame_cover"` + `first_frame_ms`, sem afirmar que o feed mostra a capa.
   */
  firstFrame?: { ms: number } | null;
  /**
   * #11795: corte avulso — só o título conta como "já está no canal". A marca
   * da edição e o dia acusariam o Short da EDIÇÃO do mesmo dia.
   */
  matchTitleOnly?: boolean;
  /** #13734: corte avulso — o comando da checagem do áudio sai com `--corte SLUG`, não `--edition`. */
  corteSlug?: string;
}): Promise<PublishOutcome> {
  const missing = missingYouTubeCredentials(input.env);
  if (missing.length) throw new Error(`faltam ${missing.join(", ")} no ambiente (rode scripts/youtube-oauth-setup.ts)`);
  const schedule: YouTubeScheduleDecision = input.scheduledAt
    ? { mode: "scheduled", publishAt: input.scheduledAt, privacyStatus: "private", premise: "" }
    : { mode: "immediate", publishAt: null, privacyStatus: "public", premise: "" };
  const request = buildYouTubeInsertRequest(
    { title: input.title, description: input.description, tags: buildYouTubeTags() },
    schedule,
    { contentType: "video/mp4", contentLength: input.file.length },
  );
  const unknownEntry = (): ShortPublishedEntry => {
    const at = input.deps.now().toISOString();
    return { destination: "youtube_shorts", status: "send_unknown", id: `send_unknown-${at}`, scheduled_at: input.scheduledAt, at };
  };
  let result;
  try {
    result = await uploadYouTubeVideo(input.deps, {
      creds: {
        clientId: (input.env.GOOGLE_CLIENT_ID ?? "").trim(),
        clientSecret: (input.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
        refreshToken: (input.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
        channelId: (input.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
      },
      request,
      video: input.file,
      contentType: "video/mp4",
      thumbnail: input.cover ?? null,
      ...(input.force ? {} : { existingVideoCheck: { aammdd: input.aammdd, title: input.title, kind: "short" as const, ...(input.matchTitleOnly ? { titleOnly: true } : {}), ...(input.ignoreVideoIds?.length ? { ignoreVideoIds: input.ignoreVideoIds } : {}) } }),
      ...(input.onBeforeBytes ? { beforeVideoBytes: () => input.onBeforeBytes!(unknownEntry()) } : {}),
      // #13403: guard do áudio registrado pelo YouTube; nunca derruba o upload.
      checkAudio: (token: string, videoId: string) => checkYouTubeAudio(input.deps, token, videoId, mp4HasAudioTrack(input.file)),
    });
  } catch (e) {
    if (e instanceof ExistingEditionVideoError) {
      const v = e.video;
      if (v.matchedBy === "period") {
        throw new Error(
          `há um Short no canal no dia da edição sem a marca dela (${v.url}, "${v.title || "sem título"}") — nada enviado. ` +
            "Se for o Short desta edição, registre com --mark youtube_shorts=URL; se não for, rode com --force-youtube",
        );
      }
      const now = input.deps.now();
      const state = v.status ? resolveYouTubeState({ status: v.status }, now) : "unknown";
      const at = now.toISOString();
      const base = { destination: "youtube_shorts", id: v.videoId, url: youtubeShortUrl(v.videoId), at };
      const warn = `já no canal (reconhecido por ${v.matchedBy}), nada enviado`;
      if (state === "published") return { entry: { ...base, status: "published", scheduled_at: null }, warnings: [warn] };
      if (state === "scheduled") return { entry: { ...base, status: "scheduled", scheduled_at: v.status?.publishAt ?? null }, warnings: [warn] };
      return { entry: { ...base, status: "send_unknown", scheduled_at: null }, warnings: [`${warn}; estado ${state} — confira no YouTube Studio`] };
    }
    if (!isIndeterminateUploadFailure(e)) throw e;
    return {
      entry: unknownEntry(),
      warnings: [`upload em estado incerto (${(e as Error).message}) — o Short PODE ter sido criado; confira o canal e registre com --mark youtube_shorts=URL`],
    };
  }
  const warnings: string[] = [];
  if (result.rereadError) warnings.push(`releitura do estado falhou: ${result.rereadError}`);
  // #13403: a linha do guard vira aviso do destino (o CLI a imprime como `[aviso] youtube_shorts: ...`).
  // O alarme do degradado sai no CLI, depois de o registro estar gravado (`alarmYouTubeAudioDegraded`).
  const audioLine = result.audio_check ? describeYouTubeAudioCheck(result.audio_check, result.videoId, input.aammdd, input.corteSlug) : null;
  if (audioLine) warnings.push(audioLine.replace(/^\[(aviso|pendente)\] /, ""));
  const failed = failedUploadStatus(result.rereadStatus);
  // #11547: `thumbnails.set` vale para Short (medido em 28/10/2026); falha só vira registro.
  // #12100: o sucesso troca só a miniatura 16:9; a capa do feed de Shorts vira aviso de passo manual.
  const cover = youtubeShortsCoverRecord(result.thumbnail, input.firstFrame ?? null);
  if (cover && !cover.ok) warnings.push(`capa não aplicada (${cover.error}) — troque no YouTube Studio (Miniatura → Enviar arquivo)`);
  const verticalWarning = youtubeShortsVerticalCoverWarning(result.videoId, cover);
  if (verticalWarning) warnings.push(verticalWarning);
  const base = {
    destination: "youtube_shorts",
    id: result.videoId,
    url: youtubeShortUrl(result.videoId),
    at: result.uploadedAt,
    ...(cover ? { cover } : {}),
    ...(result.audio_check ? { audio_check: result.audio_check } : {}),
  };
  if (failed) {
    warnings.push(`o YouTube marcou uploadStatus=${failed} — o Short não vai ao ar; confira no Studio (registro mantido para não re-enviar)`);
    return { entry: { ...base, status: "send_unknown", scheduled_at: null }, warnings };
  }
  if (result.state !== "published" && result.state !== "scheduled") warnings.push(`estado relido ${result.state}: ${describeYouTubeState(result.state)}`);
  return {
    entry: input.scheduledAt ? { ...base, status: "scheduled", scheduled_at: input.scheduledAt } : { ...base, status: "published", scheduled_at: null },
    ...(warnings.length ? { warnings } : {}),
  };
}
