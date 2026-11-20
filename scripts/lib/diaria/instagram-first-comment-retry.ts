/**
 * instagram-first-comment-retry.ts (#13759) — retentativa do 1º comentário do
 * Reels com o link por edição (#13709).
 *
 * O Reels do vertical leva na legenda "link no primeiro comentário" e o
 * comentário sai logo depois do `media_publish` (`postInstagramReelFirstComment`
 * em `scripts/publish-shorts.ts`). Até o #13759 a falha do comentário (token
 * sem `instagram_manage_comments`, 5xx) virava só aviso: o registro saía sem
 * `first_comment_id` e sem rastro, e a rodada seguinte do timer via o
 * `instagram` registrado e não fazia mais nada. A legenda ficava prometendo um
 * comentário que não existia.
 *
 * Agora a falha grava `first_comment_pending` na entrada (texto, erro,
 * tentativas). O timer do 300 (`scripts/shorts-instagram-timer.ts`), a cada
 * execução, vê a pendência e roda `scripts/retry-instagram-first-comment.ts`,
 * até `INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS` tentativas no total; falha abre
 * o alarme `first-comment` (uma vez por edição) e o esgotamento abre outro.
 * Sucesso troca a pendência pelo `first_comment_id`. Resposta sem id
 * (`uncertain`) nunca retenta: o comentário pode existir e sairia duplicado.
 *
 * Miolo puro: nada aqui chama a Graph API nem grava arquivo.
 */

import type { InstagramFirstCommentPending, ShortPublishedEntry } from "./short-video.ts";

export type { InstagramFirstCommentPending };

/** Tentativas no total (a do publish + as do timer, uma por execução de hora em hora). */
export const INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS = 4;

export type FirstCommentRetryState =
  | { kind: "none" }
  /** O comentário falhou e ainda cabe tentativa. */
  | { kind: "retry"; mediaId: string; pending: InstagramFirstCommentPending }
  /** Tentativas esgotadas: só o editor resolve (comentar à mão). */
  | { kind: "exhausted"; mediaId: string; pending: InstagramFirstCommentPending }
  /** A Graph respondeu sem id: o comentário pode existir; o editor confere. */
  | { kind: "uncertain"; mediaId: string; pending: InstagramFirstCommentPending }
  /** Pendência ilegível ou entrada sem id de mídia utilizável: o timer avisa, nunca comenta às cegas. */
  | { kind: "invalid"; reason: string };

/** Pure: a pendência gravada é legível? */
export function parseFirstCommentPending(raw: unknown): InstagramFirstCommentPending | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.message !== "string" || !p.message.trim()) return null;
  if (typeof p.attempts !== "number" || !Number.isInteger(p.attempts) || p.attempts < 1) return null;
  return {
    message: p.message,
    error: typeof p.error === "string" ? p.error : "",
    attempts: p.attempts,
    last_attempt_at: typeof p.last_attempt_at === "string" ? p.last_attempt_at : "",
    ...(p.uncertain === true ? { uncertain: true } : {}),
  };
}

/**
 * Pure: o que fazer com o 1º comentário desta entrada `instagram`. Só uma
 * entrada `published` com permalink aceita retentativa: `send_unknown` e o
 * publish incerto (registrado com o id do container, sem `url`) não garantem
 * que o id é o da mídia.
 */
export function firstCommentRetryState(
  entry: Pick<ShortPublishedEntry, "destination" | "status" | "id" | "url" | "first_comment_id" | "first_comment_pending">,
): FirstCommentRetryState {
  if (entry.destination !== "instagram") return { kind: "none" };
  if (entry.first_comment_pending === undefined) return { kind: "none" };
  if (entry.first_comment_id) return { kind: "none" };
  const pending = parseFirstCommentPending(entry.first_comment_pending);
  if (!pending) return { kind: "invalid", reason: "first_comment_pending ilegível no registro (sem message ou attempts)" };
  if (entry.status !== "published" || !entry.url) {
    return { kind: "invalid", reason: `o Reels não está registrado como publicado com permalink (status ${entry.status}${entry.url ? "" : ", sem url"}): o id ${entry.id} pode não ser o da mídia` };
  }
  if (pending.uncertain) return { kind: "uncertain", mediaId: entry.id, pending };
  if (pending.attempts >= INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS) return { kind: "exhausted", mediaId: entry.id, pending };
  return { kind: "retry", mediaId: entry.id, pending };
}

/** Resultado de uma tentativa de comentar (`postInstagramReelFirstComment`). */
export type FirstCommentAttempt = { ok: true; id: string } | { ok: false; error: string; uncertain?: boolean };

/** Pure: a pendência da 1ª falha (a do publish). */
export function initialFirstCommentPending(message: string, attempt: Extract<FirstCommentAttempt, { ok: false }>, now: Date): InstagramFirstCommentPending {
  return { message, error: attempt.error, attempts: 1, last_attempt_at: now.toISOString(), ...(attempt.uncertain ? { uncertain: true } : {}) };
}

/**
 * Pure: a entrada depois de uma tentativa. Sucesso grava `first_comment_id` e
 * apaga a pendência; falha soma a tentativa e guarda o erro.
 */
export function applyFirstCommentAttempt(entry: ShortPublishedEntry, result: FirstCommentAttempt, now: Date): ShortPublishedEntry {
  const pending = parseFirstCommentPending(entry.first_comment_pending);
  if (!pending) throw new Error("a entrada instagram não tem first_comment_pending legível: nada a retentar");
  if (result.ok) {
    const { first_comment_pending: _drop, ...rest } = entry;
    return { ...rest, first_comment_id: result.id };
  }
  return {
    ...entry,
    first_comment_pending: {
      ...pending,
      error: result.error,
      attempts: pending.attempts + 1,
      last_attempt_at: now.toISOString(),
      ...(result.uncertain ? { uncertain: true } : {}),
    },
  };
}
