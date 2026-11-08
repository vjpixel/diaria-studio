/**
 * scripts/lib/diaria/linkedin-page-actions.ts (#11121, #10983)
 *
 * Ações da PÁGINA diar.ia.br no LinkedIn que saem pela fila do Worker
 * `diaria-linkedin-cron`, com o token de organização (`w_organization_social`,
 * gerado no #8055):
 *   - repost do vídeo vertical do perfil do editor (#11121, `publish-shorts.ts`);
 *   - 1º comentário do post do D1 com o link do vídeo (#10983,
 *     `link-video-d1.ts` e `video-d1-link-watch.ts`).
 *
 * Guard: o Worker só aceita essas entries com `LINKEDIN_ACCESS_TOKEN` e
 * `LINKEDIN_AUTHOR_URN` provisionados (o `wrangler secret put` é o #8816, do
 * editor). Sem eles, o enqueue devolve 400 `linkedin_creds_missing` e o caller
 * segue no caminho de sempre (passo guiado/manual), com aviso. Nunca chama a
 * API do LinkedIn daqui: só a fila do Worker.
 *
 * Idempotência: cada ação leva `idempotency_key` fixa por edição; rodar de
 * novo cai na MESMA entry da fila (o Worker responde `duplicate`, ou 409
 * `already_fired` se ela já disparou), nunca num 2º repost/comentário.
 */

import { extractYouTubeVideoId } from "./d1-video-link.ts";
import { WorkerQueueError, type WorkerQueuePayload } from "../worker-queue-client.ts";

/** Mesma regra do Worker (`LINKEDIN_POST_URN_RE`): só post aceita repost/comentário. */
export const LINKEDIN_POST_URN_RE = /^urn:li:(share|ugcPost):\d{1,30}$/;

/** Folga entre o disparo do D1 e o comentário (o webhook Make publica com atraso). */
export const LINKEDIN_D1_COMMENT_DELAY_MS = 5 * 60 * 1000;
/** Folga mínima a partir de agora (o Worker dispara entries vencidas na hora). */
export const LINKEDIN_PAGE_ACTION_MIN_LEAD_MS = 60 * 1000;

export type EnqueueFn = (payload: WorkerQueuePayload) => Promise<{ key: string; scheduled_at: string; duplicate?: boolean }>;

export type PageActionResult =
  /** Na fila do Worker (o 202 prova a fila, não o disparo — #573). */
  | { status: "queued"; key: string; scheduled_at: string; duplicate: boolean }
  /** A mesma `idempotency_key` já disparou: nada novo agendado. */
  | { status: "already_fired"; detail: string }
  /** Worker sem os segredos da página (#8816): segue guiado/manual. */
  | { status: "creds_missing"; detail: string }
  /** Sem URL/token do Worker nesta máquina. */
  | { status: "no_worker"; detail: string }
  | { status: "failed"; detail: string; ambiguous: boolean };

/**
 * URN do post a partir de um registro (`id` ou URL `feed/update/{urn}`).
 * `null` quando não é post (ex.: `send_unknown-…`, `urn:li:activity:…`).
 */
export function linkedInPostUrnFrom(entry: { id?: unknown; url?: unknown } | null | undefined): string | null {
  if (!entry) return null;
  if (typeof entry.id === "string" && LINKEDIN_POST_URN_RE.test(entry.id)) return entry.id;
  if (typeof entry.url === "string") {
    const m = entry.url.match(/urn:li:(share|ugcPost):\d{1,30}/);
    if (m) return m[0];
  }
  return null;
}

function laterOf(isoA: string, msB: number): string {
  const a = Date.parse(isoA);
  return new Date(Number.isFinite(a) && a > msB ? a : msB).toISOString();
}

/**
 * #11121: chave fixa por edição — 1 repost do vertical por dia. `variant`
 * (o slug do corte avulso) separa o repost do corte do repost da edição.
 */
export function shortsPageRepostIdempotencyKey(aammdd: string, variant?: string): string {
  const suffix = variant ? `-${variant.replace(/[^A-Za-z0-9._-]/g, "-")}` : "";
  return `shorts-page-repost-${aammdd}${suffix}`.slice(0, 128);
}

/** #11121: payload do repost do vídeo do perfil pela página. */
export function buildPageRepostPayload(input: {
  aammdd: string;
  targetPostUrn: string;
  scheduledAt: string;
  now: Date;
  variant?: string;
}): WorkerQueuePayload {
  if (!LINKEDIN_POST_URN_RE.test(input.targetPostUrn)) {
    throw new Error(`URN do post do perfil inválida para repost: ${JSON.stringify(input.targetPostUrn)}`);
  }
  return {
    text: "",
    image_url: null,
    scheduled_at: laterOf(input.scheduledAt, input.now.getTime() + LINKEDIN_PAGE_ACTION_MIN_LEAD_MS),
    destaque: "shorts",
    channel: "linkedin",
    action: "repost",
    target_post_urn: input.targetPostUrn,
    idempotency_key: shortsPageRepostIdempotencyKey(input.aammdd, input.variant),
  };
}

/** #10983: chave fixa por edição + vídeo — 1 comentário do link por D1. */
export function d1VideoCommentIdempotencyKey(aammdd: string, videoUrl: string): string {
  return `d1-video-comment-${aammdd}-${extractYouTubeVideoId(videoUrl) ?? "sem-id"}`;
}

/**
 * #10983: payload do 1º comentário do D1 da página. O post do D1 sai pelo
 * webhook Make (sem URN): o Worker acha o post pela hora (`parent_scheduled_at`)
 * no disparo. Horário: D1 + 5 min, ou daqui a 1 min se o D1 já saiu.
 */
export function buildD1VideoCommentPayload(input: {
  aammdd: string;
  videoUrl: string;
  text: string;
  d1ScheduledAt: string;
  now: Date;
}): WorkerQueuePayload {
  const d1Ms = Date.parse(input.d1ScheduledAt);
  if (!Number.isFinite(d1Ms)) throw new Error(`horário do D1 inválido: ${JSON.stringify(input.d1ScheduledAt)}`);
  return {
    text: input.text,
    image_url: null,
    scheduled_at: laterOf(new Date(d1Ms + LINKEDIN_D1_COMMENT_DELAY_MS).toISOString(), input.now.getTime() + LINKEDIN_PAGE_ACTION_MIN_LEAD_MS),
    destaque: "d1",
    parent_destaque: "d1",
    channel: "linkedin",
    action: "comment",
    webhook_target: "diaria",
    parent_scheduled_at: new Date(d1Ms).toISOString(),
    idempotency_key: d1VideoCommentIdempotencyKey(input.aammdd, input.videoUrl),
  };
}

/** Enfileira e traduz a resposta do Worker. Nunca lança. */
export async function enqueuePageAction(enqueue: EnqueueFn | null, payload: WorkerQueuePayload): Promise<PageActionResult> {
  if (!enqueue) return { status: "no_worker", detail: "sem URL/token do Worker diaria-linkedin-cron nesta máquina (DIARIA_LINKEDIN_CRON_URL/TOKEN)" };
  try {
    const r = await enqueue(payload);
    return { status: "queued", key: r.key, scheduled_at: r.scheduled_at, duplicate: r.duplicate === true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof WorkerQueueError) {
      if (e.code === "linkedin_creds_missing") {
        return {
          status: "creds_missing",
          detail: `o Worker ainda não tem LINKEDIN_ACCESS_TOKEN/LINKEDIN_AUTHOR_URN (wrangler secret put, #8816) — segue o passo manual (${msg})`,
        };
      }
      if (e.status === 409 && /already_fired/.test(msg)) {
        return { status: "already_fired", detail: "a fila do Worker já disparou esta ação (mesma idempotency_key) — nada novo agendado" };
      }
      return { status: "failed", detail: msg, ambiguous: e.status >= 500 || e.status === 409 };
    }
    // Rede/timeout depois das tentativas: a entry pode ter entrado na fila.
    return { status: "failed", detail: msg, ambiguous: true };
  }
}
