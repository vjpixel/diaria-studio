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
 *     editor em 28/10/2026: HTTP 200 num Short, comentário da #11547). Só
 *     troca a miniatura 16:9 (busca, player, relacionados): a imagem da aba
 *     Shorts (`i.ytimg.com/vi/{id}/sardefault.jpg`, #12251) é escolhida à
 *     parte e, sem miniatura vertical própria, cai no frame automático (#12100). A
 *     YouTube Data API não tem chamada para ela: o registro grava
 *     `vertical_feed: "manual"` e o agente aplica a capa vertical no Studio web
 *     (Passo B3a de `/diaria-publica-video`, #12254). Desde a opção 2 do
 *     #12100 (11/11/2026) o vertical enviado leva a capa nos primeiros frames
 *     (`short-first-frame-cover.ts`) e o registro grava `first_frame_cover`,
 *     sem confirmação até a medição do `oar2.jpg`;
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
  /**
   * #12100: só no `thumbnails_set` com `ok: true`. O `ok` diz que a miniatura
   * 16:9 foi trocada; a capa do feed de Shorts (`sardefault.jpg`, #12251) não muda pela API
   * e fica para o Studio web (`manual`, Passo B3a, #12254). Depois que o agente
   * aplica o JPG vertical pelo Studio web e confere a persistência, o Passo B3a
   * de `/diaria-publica-video` troca o valor para `studio_web` (#12436).
   * Desde a opção 2 do #12100 (11/11/2026), o vertical enviado ao YouTube leva
   * a capa nos primeiros frames e o valor é `first_frame_cover`: aplicado, mas
   * NÃO confirmado — nada aqui afirma que o leitor vê a capa no feed até a
   * medição do `oar2.jpg` (`check-short-feed-cover.ts --image oar2`).
   */
  vertical_feed?: ShortVerticalFeedCover;
  /**
   * #12100 opção 2: duração (ms) da capa no início do vertical enviado ao
   * YouTube. Fica no registro mesmo depois de o Passo B3a trocar o
   * `vertical_feed` para `studio_web`, para a medição saber qual Short levou
   * a capa no 1º frame.
   */
  first_frame_ms?: number;
}

/**
 * #12436: estado da capa do feed de Shorts no registro. `manual` = pendente
 * (o script grava após o `thumbnails.set`); `studio_web` = aplicada pelo Studio
 * web e conferida (gravado pelo agente no Passo B3a); `first_frame_cover`
 * (#12100 opção 2) = a capa foi posta nos primeiros frames do vertical enviado,
 * sem confirmação de que o frame automático do YouTube caiu nela. `manual` e
 * `first_frame_cover` geram o aviso de `youtubeShortsVerticalCoverWarning`.
 */
export const SHORT_VERTICAL_FEED_COVER_VALUES = ["manual", "studio_web", "first_frame_cover"] as const;
export type ShortVerticalFeedCover = (typeof SHORT_VERTICAL_FEED_COVER_VALUES)[number];

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
  ctx: {
    coverPath: string | null;
    coverUploadReady: boolean;
    bufferOffsetMs: number | null;
    /** #12100 opção 2: ms da capa no início do vertical do YouTube; null/ausente = desligado. */
    youtubeFirstFrameMs?: number | null;
  },
): string {
  const d = item.destination;
  if (d === "threads_profile") return "unsupported (a Threads API não tem parâmetro de capa)";
  // #11515: o TikTok sai pela Buffer como o X: a capa é só o `thumbnailOffset`.
  if (d === "x" || d === "tiktok") {
    if (!ctx.coverPath) return "automatic";
    return ctx.bufferOffsetMs === null
      ? "automatic (sem timecode do Still no nome: a Buffer escolhe o frame)"
      : `thumbnail_offset ${ctx.bufferOffsetMs} ms`;
  }
  if (!ctx.coverPath) return "automatic";
  if (d === "instagram") return ctx.coverUploadReady ? "cover_url" : "unavailable: R2 credentials missing; automatic frame";
  if (d.startsWith("facebook:")) return "thumbnail_upload";
  if (d === "linkedin_profile") return "thumbnail_upload";
  if (d === "youtube_shorts") {
    if (item.mode === "guided") return "guided (Studio: Miniatura → Enviar arquivo)";
    return ctx.youtubeFirstFrameMs ? `${YOUTUBE_SHORTS_COVER_PLAN}; ${youtubeFirstFrameCoverPlan(ctx.youtubeFirstFrameMs)}` : YOUTUBE_SHORTS_COVER_PLAN;
  }
  return "unsupported";
}

/**
 * #12100: o que o plano promete para o Short pela API. O `thumbnails.set` só
 * troca a miniatura 16:9; a do feed de Shorts fica para o Studio web (#12254).
 */
export const YOUTUBE_SHORTS_COVER_PLAN =
  "thumbnails_set (só a miniatura 16:9; a capa do feed de Shorts é manual no Studio web, Passo B3a, #12100/#12254)";

/** #12100 opção 2: a parte do plano que descreve a capa no 1º frame (não confirmada). */
export function youtubeFirstFrameCoverPlan(ms: number): string {
  return `first_frame_cover (capa nos primeiros ${ms} ms do vertical enviado ao YouTube; não confirmado que o frame automático do feed cai nela, medir o oar2.jpg)`;
}

/**
 * #12251/#12254: como aplicar a capa vertical do Short, citado nos avisos do
 * verificador (`check-short-feed-cover.ts`) e do registro `vertical_feed:
 * "manual"`. O passo é do agente no Studio web (Passo B3a de
 * `/diaria-publica-video`), nunca uma tarefa do editor no app do celular: os
 * avisos diziam "no app do YouTube, Editar → Miniatura" depois que o #12254
 * mudou o passo no SKILL.md.
 */
export const SHORT_VERTICAL_COVER_HOWTO =
  "no Studio web (studio.youtube.com), Detalhes → Miniatura → enviar o JPG 1080x1920, salvar e conferir após reload (Passo B3a de /diaria-publica-video, #12254)";

/**
 * #12100/#12251: imagem que a aba Shorts do canal mostra. Medido pelo editor na
 * rede da página do canal (04/11/2026, #12251): a aba carrega `sardefault.jpg`
 * quando o Short tem miniatura vertical própria e cai no frame automático
 * (`oar2.jpg`/`oar1.jpg`) quando não tem — 404 no `sardefault` = sem capa
 * vertical. O `oar2.jpg`, que o #12100 media, é sempre o frame automático,
 * inclusive nos Shorts que mostram a capa na aba.
 */
export function youtubeShortFeedThumbUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/sardefault.jpg`;
}

/**
 * #12100 opção 2: o frame automático que o YouTube escolheu para o Short
 * (`oar2.jpg`, 1080x1920). É o que a capa no 1º frame quer mudar: a medição
 * compara esta imagem com a capa local (`check-short-feed-cover.ts --image oar2`).
 */
export function youtubeShortAutoFrameUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/oar2.jpg`;
}

/**
 * Pure (#12100): registro da capa do Short a partir do resultado do
 * `thumbnails.set`. O `ok` vale só para a miniatura 16:9; o feed vertical fica
 * em `vertical_feed`: `manual` sem a capa no 1º frame, `first_frame_cover`
 * (com `first_frame_ms`) quando o vertical enviado levou a capa no início —
 * nos dois casos sem afirmar que o leitor vê a capa. A capa no 1º frame vale
 * mesmo com o `thumbnails.set` falho (é outro canal). Tentativa não feita → null.
 */
export function youtubeShortsCoverRecord(
  thumb: { attempted: boolean; ok: boolean; error?: string | null } | null | undefined,
  firstFrame?: { ms: number } | null,
): ShortCoverRecord | null {
  if (!thumb?.attempted) return null;
  const vertical: Pick<ShortCoverRecord, "vertical_feed" | "first_frame_ms"> = firstFrame
    ? { vertical_feed: "first_frame_cover", first_frame_ms: firstFrame.ms }
    : {};
  return thumb.ok
    ? { method: "thumbnails_set", ok: true, vertical_feed: "manual", ...vertical }
    : { method: "thumbnails_set", ok: false, error: thumb.error ?? "sem detalhe", ...vertical };
}

/**
 * Pure (#12100): aviso do passo manual da capa do feed de Shorts, para o
 * registro com `vertical_feed: "manual"`. Qualquer outro registro → null.
 */
export function youtubeShortsVerticalCoverWarning(videoId: string, cover: ShortCoverRecord | null | undefined): string | null {
  if (!cover || cover.method !== "thumbnails_set") return null;
  if (cover.vertical_feed === "first_frame_cover") {
    // #12100 opção 2: aplicado, não confirmado. A medição é o oar2; o passo do Studio web segue até a medição mostrar que o 1º frame basta.
    return (
      `capa nos primeiros ${cover.first_frame_ms ?? "?"} ms do vertical enviado (#12100, não confirmado): medir se o frame automático do feed caiu nela com ` +
      `npx tsx scripts/check-short-feed-cover.ts --id ${videoId} --cover {capa} --image oar2 (${youtubeShortAutoFrameUrl(videoId)}); ` +
      `até a medição confirmar, aplicar ${SHORT_COVER_FILE} ${SHORT_VERTICAL_COVER_HOWTO}`
    );
  }
  if (!cover.ok || cover.vertical_feed !== "manual") return null;
  return (
    `capa 16:9 aplicada; a do feed de Shorts não muda pela API (#12100): aplicar ${SHORT_COVER_FILE} ${SHORT_VERTICAL_COVER_HOWTO}, ` +
    `e conferir com npx tsx scripts/check-short-feed-cover.ts --id ${videoId} --cover {capa} (${youtubeShortFeedThumbUrl(videoId)})`
  );
}

/**
 * Pure (#12459): a re-execução que troca a capa 16:9 de um Short já agendado
 * (`--update-scheduled`, inclusive a do timer do corte) grava de novo
 * `vertical_feed: "manual"`, o que reverteria a capa do feed já aplicada pelo
 * agente no Studio web (`studio_web`, Passo B3a, #12436) e reabriria o aviso.
 * O `thumbnails.set` não mexe na capa do feed de Shorts (#12100), então o
 * `studio_web` do registro anterior vale: o campo é preservado (merge), não
 * substituído. Vale também quando o `thumbnails.set` da re-execução FALHA
 * (review do PR #12489): a falha é da miniatura 16:9, a capa do feed aplicada
 * no Studio web continua lá, e o registro da falha guarda `studio_web` para o
 * Passo B3a não perder essa informação (o aviso só acende com `ok` +
 * `manual`). Qualquer outro caso devolve `next` como veio.
 */
export function keepStudioWebVerticalFeed(
  next: ShortCoverRecord | null,
  prior: ShortCoverRecord | null | undefined,
): ShortCoverRecord | null {
  if (!next || next.method !== "thumbnails_set") return next;
  if (prior?.method !== "thumbnails_set") return next;
  // #12100 opção 2: a re-execução não reenvia o vídeo, então a capa no 1º
  // frame do vertical já no ar continua lá; `first_frame_ms` acompanha.
  const firstFrame = next.first_frame_ms === undefined && prior.first_frame_ms !== undefined ? { first_frame_ms: prior.first_frame_ms } : {};
  if (next.ok && next.vertical_feed !== "manual") return { ...next, ...firstFrame };
  if (prior.vertical_feed === "studio_web") return { ...next, ...firstFrame, vertical_feed: "studio_web" };
  if (prior.vertical_feed === "first_frame_cover") return { ...next, ...firstFrame, vertical_feed: "first_frame_cover" };
  return next;
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
