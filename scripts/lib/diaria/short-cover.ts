/**
 * short-cover.ts (#11547) — capa do vertical (o Still do Premiere) nos destinos
 * que aceitam capa. Miolo puro; o I/O fica em `publish-shorts.ts`,
 * `fetch-drive-video.ts` e `scripts/lib/linkedin-video.ts`.
 *
 * Por destino:
 *   - `facebook:{slug}`: `POST /{video-id}/thumbnails` (`source` = o JPEG,
 *     `is_preferred=true`) logo depois do upload, Reels e `/videos`;
 *   - `instagram`: `cover_url` (R2) no container (#11545);
 *   - `linkedin_profile`: `uploadThumbnail: true` no `initializeUpload` e PUT do
 *     JPEG na `thumbnailUploadUrl`;
 *   - `youtube_shorts`: `thumbnails.set` depois do `videos.insert` (medido pelo
 *     editor em 28/10/2026: HTTP 200 num Short, comentário da #11547);
 *   - `x` (Buffer): não aceita imagem, só `thumbnailOffset` (ms) no asset de
 *     vídeo. Derivado do timecode que o Premiere põe no nome do Still
 *     (`…V1.00_00_03_08.Still001.jpg` = 3 s + 8 frames);
 *   - `threads_profile`: a API não tem parâmetro de capa.
 *
 * Capa é sempre opcional: falha vira registro (`cover.ok: false`) e aviso,
 * nunca derruba a publicação do vídeo.
 */

import type { ShortPublishedEntry } from "./short-video.ts";

/** Capa do vertical na pasta da edição (`fetch-drive-video.ts` / `gen-youtube-thumb.ts --short-cover`). */
export const SHORT_COVER_FILE = "04-youtube-short-capa.jpg";

/**
 * Sidecar com o nome do Still do Drive que virou `04-youtube-short-capa.jpg`
 * (relativo à pasta da edição). Guarda o tamanho do JPEG gravado: capa trocada
 * depois à mão (ou regenerada) não casa e o nome deixa de valer.
 */
export const SHORT_COVER_SOURCE_FILE = "_internal/04-youtube-short-capa.source.json";

/**
 * fps assumido para converter os frames do timecode em ms. O vertical da
 * diar.ia.br sai do Premiere a 30 fps; com frame 00 (o caso de 261029) o fps não
 * importa.
 */
export const SHORT_COVER_DEFAULT_FPS = 30;

/** Como cada destino recebeu (ou tentou receber) a capa — gravado em `06-shorts-published.json`. */
export interface ShortCoverRecord {
  /** `missing_local` (#11660): a capa não estava na pasta da edição desta máquina — frame automático. */
  method: "thumbnail_upload" | "cover_url" | "thumbnails_set" | "thumbnail_offset" | "missing_local";
  ok: boolean;
  /** Só no `thumbnail_offset`. */
  offset_ms?: number;
  error?: string;
}

export interface ShortCoverSource {
  name: string;
  /** Tamanho em bytes do JPEG gravado a partir desse Still. */
  bytes: number;
}

/**
 * Pure: offset em ms do timecode `HH_MM_SS_FF` no nome do Still do Premiere
 * (`Diaria comentada_Instagram_V1.00_00_00_00.Still001.jpg` → 0). Sem timecode
 * reconhecível → null (não dá para afirmar qual frame é).
 */
export function stillTimecodeOffsetMs(name: string, fps = SHORT_COVER_DEFAULT_FPS): number | null {
  const m = name.match(/(?:^|[^\d])(\d{2})_(\d{2})_(\d{2})_(\d{2})(?!\d)/);
  if (!m) return null;
  const [h, min, s, ff] = m.slice(1).map(Number);
  if (min > 59 || s > 59 || ff >= fps) return null;
  return (h * 3600 + min * 60 + s) * 1000 + Math.round((ff * 1000) / fps);
}

/** Pure: conteúdo do sidecar. */
export function buildShortCoverSource(name: string, bytes: number): ShortCoverSource {
  return { name, bytes };
}

/**
 * Pure: o sidecar ainda descreve a capa no disco? Só quando o tamanho bate —
 * senão a capa foi trocada depois e o nome do Still não diz mais nada.
 * JSON inválido / campos faltando → null.
 */
export function parseShortCoverSource(raw: string | null, coverBytes: number | null): ShortCoverSource | null {
  if (raw === null || coverBytes === null) return null;
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j.name !== "string" || !j.name || typeof j.bytes !== "number") return null;
  return j.bytes === coverBytes ? { name: j.name, bytes: j.bytes } : null;
}

/**
 * Pure: `thumbnailOffset` (ms) que vai no asset de vídeo da Buffer. Só com o
 * Still do Drive conhecido e timecode no nome; capa local/gerada sem origem
 * conhecida → null (a Buffer escolhe o frame).
 */
export function bufferThumbnailOffsetMs(source: ShortCoverSource | null): number | null {
  return source ? stillTimecodeOffsetMs(source.name) : null;
}

/** Teto do offset quando a duração do vertical é desconhecida: nenhum Short passa de 10 min (#11679). */
export const SHORT_COVER_OFFSET_FALLBACK_MAX_MS = 10 * 60_000;

/**
 * Pure (#11679 item 2): o timecode do Still assume sequência do Premiere
 * começando em 00:00:00:00. Sequência com início 01:00:00:00 dá offset ≥ 1 h,
 * fora do vertical — a Buffer pode rejeitar o post ou ignorar o campo. Offset
 * fora do vídeo (ou, com duração desconhecida, acima de 10 min) vira null: a
 * Buffer escolhe o frame, como sem timecode.
 */
export function clampBufferThumbnailOffsetMs(offsetMs: number | null, durationSeconds: number | null): number | null {
  if (offsetMs === null) return null;
  const maxMs = durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds * 1000 : SHORT_COVER_OFFSET_FALLBACK_MAX_MS;
  return offsetMs < maxMs ? offsetMs : null;
}

/**
 * Pure: o que o plano (dry-run) promete por destino. Fonte do
 * `plan.cover.destinations`.
 */
export function planCoverDestination(
  item: { destination: string; mode?: string; action?: string },
  ctx: { coverPath: string | null; coverUploadReady: boolean; bufferOffsetMs: number | null },
): string {
  const d = item.destination;
  if (d === "threads_profile") return "unsupported (a Threads API não tem parâmetro de capa)";
  if (d === "x") {
    if (!ctx.coverPath) return "automatic";
    return ctx.bufferOffsetMs === null
      ? "automatic (sem timecode do Still no nome: a Buffer escolhe o frame)"
      : `thumbnail_offset ${ctx.bufferOffsetMs} ms`;
  }
  if (!ctx.coverPath) return "automatic";
  if (d === "instagram") return ctx.coverUploadReady ? "cover_url" : "unavailable: R2 credentials missing; automatic frame";
  if (d.startsWith("facebook:")) return "thumbnail_upload";
  if (d === "linkedin_profile") return "thumbnail_upload";
  if (d === "youtube_shorts") return item.mode === "guided" ? "guided (Studio: Miniatura → Enviar arquivo)" : "thumbnails_set";
  return "unsupported";
}

/**
 * Pure: o `--mark x=URL` (confirmação do tweet) substitui a entrada `buffer:` —
 * o registro da capa feito no agendamento não pode sumir junto.
 */
export function carryOverCover(next: ShortPublishedEntry, prior: ShortPublishedEntry | null | undefined): ShortPublishedEntry {
  if (next.cover || !prior?.cover || prior.destination !== next.destination) return next;
  return { ...next, cover: prior.cover };
}

/** Pure: anexa o registro da capa à entrada do registro (sem mutar). */
export function withCoverRecord(entry: ShortPublishedEntry, cover: ShortCoverRecord | null | undefined): ShortPublishedEntry {
  return cover ? { ...entry, cover } : entry;
}

/** Destinos que recebem a capa por arquivo (o X usa só o offset; o Threads não tem capa). */
const COVER_FILE_DESTINATIONS = (d: string): boolean =>
  d === "instagram" || d === "linkedin_profile" || d === "youtube_shorts" || d.startsWith("facebook:");

/** Texto do aviso/registro de capa ausente (#11660). */
export const SHORT_COVER_MISSING_ERROR = `${SHORT_COVER_FILE} ausente na pasta da edição desta máquina — saiu com o frame automático`;

/**
 * Pure (#11660): sem a capa no disco, o destino que aceitaria capa por arquivo
 * ganha `cover: { method: "missing_local", ok: false }` no registro, em vez de
 * silêncio. Caso real: o timer do 300 publica antes de o OneDrive replicar a
 * capa baixada no Neo. Entrada que já traz `cover` (ex.: veio de outro
 * processo) fica como está.
 */
export function withMissingCoverRecord(entry: ShortPublishedEntry, coverPresent: boolean): ShortPublishedEntry {
  if (coverPresent || entry.cover || !COVER_FILE_DESTINATIONS(entry.destination)) return entry;
  return { ...entry, cover: { method: "missing_local", ok: false, error: SHORT_COVER_MISSING_ERROR } };
}
