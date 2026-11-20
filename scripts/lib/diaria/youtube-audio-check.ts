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
 *   - processamento em curso (`processingStatus` `processing` ou ausente, ou
 *     `fileDetailsAvailability` ≠ `available`) → `pending`, nunca bloqueia;
 *     a checagem posterior é `scripts/check-youtube-audio.ts --id ID`, que
 *     também regrava o `audio_check` no registro (`--edition`);
 *   - processamento `failed`/`terminated` → `error` com o motivo;
 *   - algum `audioStreams[].bitrateBps` legível abaixo do limiar (ou nenhum
 *     stream de áudio registrado) com áudio na origem → `degraded`:
 *     `[aviso]` + alarme ao editor, disparado só DEPOIS de gravado o registro;
 *   - falha de leitura → `error`, que vira aviso. Nunca lança.
 *
 * Lógica pura (`assessYouTubeAudio`, `mp4HasAudioTrack`) separada do I/O
 * (`fetchYouTubeFileDetails`, `checkYouTubeAudio`), com `fetch` injetável.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic-write.ts";
import { withFileLock } from "../file-lock.ts";
import { notifyEditor, type NotifyEditorDeps, type NotifyEditorResult } from "../editor-notify.ts";
import { YOUTUBE_API_BASE, explainYouTubeUploadError, type YouTubeUploadDeps } from "./youtube-upload.ts";

/**
 * Limiar do áudio registrado pelo YouTube, tirado das medições da #13403: o
 * degradado ficou em 2,4 kbps (7OMVoFQNru8); a cópia com 400 ms de silêncio
 * no começo (Hkx35UI-XCM), que não teve queixa de áudio, em 89,7 kbps; os
 * arquivos originais, em ~309 kbps. 32 kbps fica bem acima do degradado e
 * bem abaixo do pior caso aceitável medido, então não dispara à toa.
 */
export const YOUTUBE_AUDIO_MIN_BITRATE_BPS = 32_000;

/**
 * Comando da checagem sob demanda, citado no log quando o processamento não terminou.
 * #13734: o vertical de um corte avulso mora em `data/cortes/{slug}/`, não na pasta da
 * edição: com `corteSlug` o comando leva `--corte SLUG` (o `--edition {data do corte}`
 * não acha o registro e sai `exit 2`).
 */
export function youtubeAudioCheckCommand(videoId: string, aammdd?: string, corteSlug?: string): string {
  const where = corteSlug ? ` --corte ${corteSlug}` : aammdd ? ` --edition ${aammdd}` : "";
  return `npx tsx scripts/check-youtube-audio.ts --id ${videoId}${where}`;
}

/** Resultado gravado em `audio_check`. `status` é o único discriminante. */
export type YouTubeAudioCheck =
  | { status: "ok"; bitrate_bps: number; source_audio: true | null; checked_at: string }
  | { status: "degraded"; bitrate_bps: number | null; source_audio: true | null; reason: string; checked_at: string }
  | { status: "pending"; processing_status: string | null; file_details_availability: string | null; checked_at: string }
  | { status: "no_source_audio"; checked_at: string }
  | { status: "error"; error: string; checked_at: string };

export type YouTubeAudioDegraded = Extract<YouTubeAudioCheck, { status: "degraded" }>;

/** Contexto do alarme: qual vídeo, onde abrir e como chamá-lo no assunto. */
export interface YouTubeAudioAlarmContext {
  videoId: string;
  url: string;
  label: string;
}

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
  if (input.sourceHasAudio === false) return { status: "no_source_audio", checked_at };
  const source_audio: true | null = input.sourceHasAudio;
  if (!input.item) return { status: "error", error: "videos.list não devolveu o vídeo", checked_at };
  const processing_status = input.item.processingDetails?.processingStatus ?? null;
  const file_details_availability = input.item.processingDetails?.fileDetailsAvailability ?? null;
  if (processing_status !== null && processing_status !== "processing" && processing_status !== "succeeded") {
    return { status: "error", error: `processamento do YouTube ${processing_status}: o vídeo não terminou de processar e não vai terminar`, checked_at };
  }
  if (processing_status !== "succeeded" || file_details_availability !== "available") {
    return { status: "pending", processing_status, file_details_availability, checked_at };
  }
  const streams = input.item.fileDetails?.audioStreams ?? [];
  if (streams.length === 0) {
    return { status: "degraded", bitrate_bps: null, source_audio, reason: "o YouTube não registrou nenhum stream de áudio", checked_at };
  }
  const rates = streams.map((s) => parseBitrate(s.bitrateBps));
  const legible = rates.filter((r): r is number => r !== null);
  // Um stream legível abaixo do limiar já é a degradação, mesmo com outro ilegível ao lado.
  if (legible.length > 0) {
    const min = Math.min(...legible);
    if (min < YOUTUBE_AUDIO_MIN_BITRATE_BPS) {
      return { status: "degraded", bitrate_bps: min, source_audio, reason: `áudio registrado a ${min} bps, abaixo de ${YOUTUBE_AUDIO_MIN_BITRATE_BPS} bps`, checked_at };
    }
  }
  if (legible.length < rates.length) return { status: "error", error: "fileDetails.audioStreams sem bitrateBps legível", checked_at };
  return { status: "ok", bitrate_bps: Math.min(...legible), source_audio, checked_at };
}

/**
 * Pure: o MP4 tem faixa de áudio? Percorre `moov/trak/mdia/hdlr` e procura
 * `handler_type` = `soun`. null = não deu para afirmar: arquivo que não é MP4,
 * truncado, ou algum `trak` ilegível (pode ser justamente o de áudio).
 */
export function mp4HasAudioTrack(buf: Buffer): boolean | null {
  const children = (start: number, end: number): Array<{ type: string; start: number; end: number }> | null => {
    const out: Array<{ type: string; start: number; end: number }> = [];
    let off = start;
    while (off < end) {
      if (off + 8 > end) return null;
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
  if (!traks || traks.length === 0) return null;
  let unreadable = false;
  for (const trak of traks) {
    const mdia = children(trak.start, trak.end)?.find((b) => b.type === "mdia");
    const hdlr = mdia ? children(mdia.start, mdia.end)?.find((b) => b.type === "hdlr") : undefined;
    if (!hdlr || hdlr.start + 12 > hdlr.end) {
      unreadable = true;
      continue;
    }
    if (buf.toString("latin1", hdlr.start + 8, hdlr.start + 12) === "soun") return true;
  }
  return unreadable ? null : false;
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
export function describeYouTubeAudioCheck(check: YouTubeAudioCheck, videoId: string, aammdd?: string, corteSlug?: string): string | null {
  const cmd = youtubeAudioCheckCommand(videoId, aammdd, corteSlug);
  switch (check.status) {
    case "degraded":
      return `[aviso] áudio do YouTube degradado em ${videoId}: ${check.reason} (#13403). A origem tem áudio bom? Reenvie o vídeo e confira de novo com \`${cmd}\``;
    case "pending":
      return `[pendente] áudio do YouTube não conferido em ${videoId}: processamento ainda não terminou (processingStatus ${check.processing_status ?? "?"}, fileDetails ${check.file_details_availability ?? "?"}). Confira depois com \`${cmd}\` (#13403)`;
    case "error":
      return `[aviso] áudio do YouTube não conferido em ${videoId} (${check.error}); confira depois com \`${cmd}\` (#13403)`;
    default:
      return null;
  }
}

/** Pure: assunto e corpo do alarme do áudio degradado. */
export function buildYouTubeAudioAlarm(check: YouTubeAudioDegraded, ctx: YouTubeAudioAlarmContext): { subject: string; body: string } {
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
  check: YouTubeAudioDegraded,
  ctx: YouTubeAudioAlarmContext,
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
export type YouTubeAudioAlarmFn = (check: YouTubeAudioDegraded, ctx: YouTubeAudioAlarmContext) => Promise<{ ok: boolean; detail: string }>;

/**
 * Dispara o alarme quando o áudio veio degradado. Chamar DEPOIS de gravar o
 * registro (o alarme cita um vídeo que o registro já conhece). Nunca lança.
 * Devolve a linha logada (`[alarme]` ou `[aviso]`), ou null quando não havia o que alarmar.
 */
export async function alarmYouTubeAudioDegraded(
  check: YouTubeAudioCheck | undefined,
  ctx: YouTubeAudioAlarmContext,
  alarm: YouTubeAudioAlarmFn | undefined,
  log: (line: string) => void,
): Promise<string | null> {
  if (check?.status !== "degraded") return null;
  let line: string;
  if (!alarm) {
    line = "[aviso] áudio degradado: alarme não configurado nesta chamada; avise o editor à mão";
  } else {
    try {
      const r = await alarm(check, ctx);
      line = r.ok ? `[alarme] áudio degradado em ${ctx.videoId}: ${r.detail}` : `[aviso] áudio degradado: ${r.detail}; avise o editor à mão`;
    } catch (e) {
      line = `[aviso] áudio degradado: alarme não aberto (${(e as Error).message}); avise o editor à mão`;
    }
  }
  log(line);
  return line;
}

/**
 * Regrava `audio_check` no registro do horizontal (`05-youtube-published.json`)
 * sob lock (`{path}.lock`), relendo o arquivo DENTRO do lock e gravando atômico.
 * Lança se o registro não existir, for de outra edição ou de outro vídeo.
 */
export function writeYouTubeRecordAudioCheck(path: string, aammdd: string, videoId: string, check: YouTubeAudioCheck, lockTimeoutMs = 30_000): void {
  if (!existsSync(path)) throw new Error(`registro ${path} não existe`);
  withFileLock(
    `${path}.lock`,
    () => {
      const rec = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error(`registro ${path} não é um objeto JSON`);
      if (rec.aammdd !== aammdd) throw new Error(`registro ${path} é de outra edição (${JSON.stringify(rec.aammdd ?? null)})`);
      if (rec.videoId !== videoId) throw new Error(`registro ${path} é de outro vídeo (${JSON.stringify(rec.videoId ?? null)})`);
      writeFileAtomic(path, JSON.stringify({ ...rec, audio_check: check }, null, 2) + "\n");
    },
    lockTimeoutMs,
  );
}
