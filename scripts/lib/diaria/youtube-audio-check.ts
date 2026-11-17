/**
 * scripts/lib/diaria/youtube-audio-check.ts (#13403, item 1)
 *
 * Guard pós-upload do áudio no YouTube. Em 17/11/2026 o Short 7OMVoFQNru8
 * saiu com o áudio degradado: o `videos.list?part=fileDetails` registrou
 * `audioStreams[0].bitrateBps` = 2.377, contra 309.422 no reenvio bom do
 * mesmo vertical (UxmyPxgSCV0) e 309.410 no horizontal 4HgymlXJrTE. O áudio
 * da origem estava bom e nada no pipeline acusou.
 *
 * Depois do upload, `publish-shorts.ts` (youtube_shorts) e `publish-youtube.ts`
 * (horizontal) leem `videos.list?part=fileDetails,processingDetails`:
 *   - origem sem faixa de áudio → nada a conferir (`no_source_audio`), sem chamada;
 *   - processamento não terminou (`processingStatus` ≠ `succeeded` ou
 *     `fileDetailsAvailability` ≠ `available`) → `pending`, nunca bloqueia;
 *     a checagem posterior é `scripts/check-youtube-audio.ts --id ID`;
 *   - algum `audioStreams[].bitrateBps` abaixo de 32 kbps (ou nenhum stream
 *     de áudio registrado) com áudio na origem → `degraded`: `[aviso]` +
 *     alarme ao editor;
 *   - falha de leitura → `error`, que vira aviso. Nunca lança.
 *
 * Lógica pura (`assessYouTubeAudio`, `mp4HasAudioTrack`) separada do I/O
 * (`fetchYouTubeFileDetails`, `checkYouTubeAudio`), com `fetch` injetável.
 */

import { notifyEditor, type NotifyEditorDeps, type NotifyEditorResult } from "../editor-notify.ts";
import { YOUTUBE_API_BASE, explainYouTubeUploadError, type YouTubeUploadDeps } from "./youtube-upload.ts";

/**
 * Limiar do áudio registrado pelo YouTube. Os bons medidos ficam em ~309 kbps;
 * o degradado, em 2,4 kbps; a cópia com 400 ms de silêncio (Hkx35UI-XCM), em
 * 89,7 kbps. 32 kbps é o piso de AAC estéreo ainda inteligível.
 */
export const YOUTUBE_AUDIO_MIN_BITRATE_BPS = 32_000;

/** Comando da checagem sob demanda, citado no log quando o processamento não terminou. */
export function youtubeAudioCheckCommand(videoId: string): string {
  return `npx tsx scripts/check-youtube-audio.ts --id ${videoId}`;
}

export type YouTubeAudioCheck =
  | { status: "ok"; ok: true; bitrate_bps: number; source_audio: boolean | null; checked_at: string }
  | { status: "degraded"; ok: false; bitrate_bps: number | null; source_audio: boolean | null; reason: string; checked_at: string }
  | { status: "pending"; pending: true; processing_status: string | null; file_details_availability: string | null; checked_at: string }
  | { status: "no_source_audio"; ok: true; source_audio: false; checked_at: string }
  | { status: "error"; error: string; checked_at: string };

/** O pedaço do recurso `video` que o guard lê. */
export interface YouTubeFileDetailsItem {
  id?: string;
  fileDetails?: { audioStreams?: Array<{ bitrateBps?: number | string; codec?: string; channelCount?: number }> };
  processingDetails?: { processingStatus?: string; fileDetailsAvailability?: string };
}

/** `bitrateBps` é uint64: a API o devolve como string ("309422"); aceita número também. */
function parseBitrate(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * Pure: decide o estado do áudio. `sourceHasAudio` false = origem sem faixa de
 * áudio (nada a conferir); null = não deu para ler a origem, e o guard confere
 * do mesmo jeito (o vídeo da diária sempre tem fala).
 */
export function assessYouTubeAudio(input: { sourceHasAudio: boolean | null; item: YouTubeFileDetailsItem | null; now: Date }): YouTubeAudioCheck {
  const checked_at = input.now.toISOString();
  if (input.sourceHasAudio === false) return { status: "no_source_audio", ok: true, source_audio: false, checked_at };
  if (!input.item) return { status: "error", error: "videos.list não devolveu o vídeo", checked_at };
  const processing_status = input.item.processingDetails?.processingStatus ?? null;
  const file_details_availability = input.item.processingDetails?.fileDetailsAvailability ?? null;
  if (processing_status !== "succeeded" || file_details_availability !== "available") {
    return { status: "pending", pending: true, processing_status, file_details_availability, checked_at };
  }
  const streams = input.item.fileDetails?.audioStreams ?? [];
  if (streams.length === 0) {
    return { status: "degraded", ok: false, bitrate_bps: null, source_audio: input.sourceHasAudio, reason: "o YouTube não registrou nenhum stream de áudio", checked_at };
  }
  const rates = streams.map((s) => parseBitrate(s.bitrateBps));
  if (rates.some((r) => r === null)) return { status: "error", error: "fileDetails.audioStreams sem bitrateBps legível", checked_at };
  const min = Math.min(...(rates as number[]));
  if (min < YOUTUBE_AUDIO_MIN_BITRATE_BPS) {
    return {
      status: "degraded",
      ok: false,
      bitrate_bps: min,
      source_audio: input.sourceHasAudio,
      reason: `áudio registrado a ${min} bps, abaixo de ${YOUTUBE_AUDIO_MIN_BITRATE_BPS} bps`,
      checked_at,
    };
  }
  return { status: "ok", ok: true, bitrate_bps: min, source_audio: input.sourceHasAudio, checked_at };
}

/**
 * Pure: o MP4 tem faixa de áudio? Percorre `moov/trak/mdia/hdlr` e procura
 * `handler_type` = `soun`. null = não deu para ler (não é MP4, truncado).
 */
export function mp4HasAudioTrack(buf: Buffer): boolean | null {
  const children = (start: number, end: number): Array<{ type: string; start: number; end: number }> | null => {
    const out: Array<{ type: string; start: number; end: number }> = [];
    let off = start;
    while (off + 8 <= end) {
      let size = buf.readUInt32BE(off);
      const type = buf.toString("latin1", off + 4, off + 8);
      let header = 8;
      if (size === 1) {
        if (off + 16 > end) return null;
        size = Number(buf.readBigUInt64BE(off + 8));
        header = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < header || off + size > end) return null;
      out.push({ type, start: off + header, end: off + size });
      off += size;
    }
    return out;
  };
  const top = children(0, buf.length);
  const moov = top?.find((b) => b.type === "moov");
  if (!moov) return null;
  const traks = children(moov.start, moov.end)?.filter((b) => b.type === "trak");
  if (!traks) return null;
  let parsedAny = false;
  for (const trak of traks) {
    const mdia = children(trak.start, trak.end)?.find((b) => b.type === "mdia");
    const hdlr = mdia ? children(mdia.start, mdia.end)?.find((b) => b.type === "hdlr") : undefined;
    if (!hdlr || hdlr.start + 12 > hdlr.end) continue;
    parsedAny = true;
    if (buf.toString("latin1", hdlr.start + 8, hdlr.start + 12) === "soun") return true;
  }
  return parsedAny ? false : null;
}

/** Lê `fileDetails,processingDetails` do vídeo. null = a API não devolveu o item. Lança em erro HTTP. */
export async function fetchYouTubeFileDetails(deps: Pick<YouTubeUploadDeps, "fetch">, token: string, videoId: string): Promise<YouTubeFileDetailsItem | null> {
  const res = await deps.fetch(`${YOUTUBE_API_BASE}/videos?part=fileDetails,processingDetails&id=${encodeURIComponent(videoId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      // corpo ilegível: segue com a mensagem pelo status
    }
    throw new Error(explainYouTubeUploadError(res.status, body, "reread"));
  }
  let json: { items?: YouTubeFileDetailsItem[] } | null;
  try {
    json = (await res.json()) as { items?: YouTubeFileDetailsItem[] } | null;
  } catch {
    throw new Error(`videos.list (fileDetails) devolveu corpo não-JSON (HTTP ${res.status})`);
  }
  return json?.items?.find((i) => i.id === videoId) ?? null;
}

/** Leitura + decisão. Nunca lança: falha vira `status: "error"`. Origem sem áudio não chama a API. */
export async function checkYouTubeAudio(
  deps: Pick<YouTubeUploadDeps, "fetch" | "now">,
  token: string,
  videoId: string,
  sourceHasAudio: boolean | null,
): Promise<YouTubeAudioCheck> {
  if (sourceHasAudio === false) return assessYouTubeAudio({ sourceHasAudio, item: null, now: deps.now() });
  try {
    const item = await fetchYouTubeFileDetails(deps, token, videoId);
    return assessYouTubeAudio({ sourceHasAudio, item, now: deps.now() });
  } catch (e) {
    return { status: "error", error: (e as Error).message, checked_at: deps.now().toISOString() };
  }
}

/**
 * Pure: a linha de log da checagem. null = nada a dizer (ok, origem sem áudio).
 * `[aviso]` no degradado e na falha de leitura; `[pendente]` com o comando da
 * checagem posterior quando o processamento não terminou.
 */
export function describeYouTubeAudioCheck(check: YouTubeAudioCheck, videoId: string): string | null {
  switch (check.status) {
    case "degraded":
      return `[aviso] áudio do YouTube degradado em ${videoId}: ${check.reason} (#13403). A origem tem áudio bom? Reenvie o vídeo e confira de novo com \`${youtubeAudioCheckCommand(videoId)}\``;
    case "pending":
      return `[pendente] áudio do YouTube não conferido em ${videoId}: processamento ainda não terminou (processingStatus ${check.processing_status ?? "?"}, fileDetails ${check.file_details_availability ?? "?"}). Confira depois com \`${youtubeAudioCheckCommand(videoId)}\` (#13403)`;
    case "error":
      return `[aviso] áudio do YouTube não conferido em ${videoId} (${check.error}); confira depois com \`${youtubeAudioCheckCommand(videoId)}\` (#13403)`;
    default:
      return null;
  }
}

/** Pure: assunto e corpo do alarme do áudio degradado. */
export function buildYouTubeAudioAlarm(check: Extract<YouTubeAudioCheck, { status: "degraded" }>, ctx: { videoId: string; url: string; label: string }): { subject: string; body: string } {
  return {
    subject: `[diar.ia.br] Áudio do YouTube degradado: ${ctx.label} (${ctx.videoId})`,
    body: [
      `O YouTube registrou o áudio de ${ctx.url} com ${check.bitrate_bps === null ? "nenhum stream de áudio" : `${check.bitrate_bps} bps`} (fileDetails.audioStreams), abaixo de ${YOUTUBE_AUDIO_MIN_BITRATE_BPS} bps, com áudio na origem.`,
      "Referência (#13403): 309.422 bps num Short bom e 2.377 bps num Short com o áudio degradado.",
      "O que fazer:",
      "- Ouvir o vídeo no YouTube. Se o áudio estiver ruim, tornar o vídeo privado e reenviar o arquivo original.",
      `- Depois do reenvio, conferir com \`${youtubeAudioCheckCommand("{novo id}")}\`.`,
    ].join("\n"),
  };
}

/** Abre (ou reaproveita) a issue de alarme do áudio degradado. Nunca lança. */
export async function notifyYouTubeAudioDegraded(
  check: Extract<YouTubeAudioCheck, { status: "degraded" }>,
  ctx: { videoId: string; url: string; label: string },
  deps: NotifyEditorDeps = {},
  notify: typeof notifyEditor = notifyEditor,
): Promise<{ ok: boolean; detail: string }> {
  const { subject, body } = buildYouTubeAudioAlarm(check, ctx);
  try {
    const res: NotifyEditorResult = await notify(
      { check: "youtube-audio-degraded", fingerprint: ctx.videoId, severity: "acao", family: "evento", priority: "P1", subject, body },
      deps,
    );
    if (!res.issue || res.issue.action === "failed") return { ok: false, detail: `alarme não aberto (${res.issue?.error ?? "?"})` };
    return { ok: true, detail: `alarme ${res.issue.action}${res.issue.url ? ` ${res.issue.url}` : ""}` };
  } catch (e) {
    return { ok: false, detail: `alarme não aberto (${(e as Error).message})` };
  }
}

/** Alarme injetável do áudio degradado (produção: `notifyYouTubeAudioDegraded`). */
export type YouTubeAudioAlarmFn = (
  check: Extract<YouTubeAudioCheck, { status: "degraded" }>,
  ctx: { videoId: string; url: string; label: string },
) => Promise<{ ok: boolean; detail: string }>;

/**
 * Loga o resultado da checagem e, no degradado, dispara o alarme. Nunca lança.
 * Devolve as linhas logadas (o publisher do vertical as leva como avisos do destino).
 */
export async function reportYouTubeAudioCheck(
  check: YouTubeAudioCheck | undefined,
  ctx: { videoId: string; url: string; label: string },
  log: (line: string) => void,
  alarm?: YouTubeAudioAlarmFn,
): Promise<string[]> {
  if (!check) return [];
  const lines: string[] = [];
  const line = describeYouTubeAudioCheck(check, ctx.videoId);
  if (line) lines.push(line);
  if (check.status === "degraded") {
    if (alarm) {
      try {
        const r = await alarm(check, ctx);
        lines.push(r.ok ? `[ok] áudio degradado: ${r.detail}` : `[aviso] áudio degradado: ${r.detail}; avise o editor à mão`);
      } catch (e) {
        lines.push(`[aviso] áudio degradado: alarme não aberto (${(e as Error).message}); avise o editor à mão`);
      }
    } else {
      lines.push("[aviso] áudio degradado: alarme não configurado nesta chamada; avise o editor à mão");
    }
  }
  for (const l of lines) log(l);
  return lines;
}
