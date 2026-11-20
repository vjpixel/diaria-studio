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
 * #13791: a retentativa grava a marca `sending` (com `uncertain` e a tentativa
 * já somada) ANTES do POST. Se o registro não gravar depois do POST (lock
 * ocupado, EBUSY do Drive sincronizando, processo morto), a marca fica e a
 * pendência vale como incerta: a hora seguinte alarma em vez de comentar de
 * novo. Sem a marca, o comentário saía e o registro seguia com a tentativa
 * antiga, e o timer publicava outro comentário a cada hora, até 4.
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
    ...(p.sending === true ? { sending: true } : {}),
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
  // #13791: marca de envio sem resultado gravado = o comentário pode existir.
  if (pending.uncertain || pending.sending) return { kind: "uncertain", mediaId: entry.id, pending };
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
 * Pure (#13791): a entrada com a marca de envio, gravada ANTES do POST. A
 * tentativa já conta (`attempts + 1`) e a pendência fica incerta: se nada
 * gravar depois, o timer alarma (`first-comment-stuck`) e nunca comenta de novo.
 */
export function markFirstCommentSending(entry: ShortPublishedEntry, now: Date): ShortPublishedEntry {
  const pending = parseFirstCommentPending(entry.first_comment_pending);
  if (!pending) throw new Error("a entrada instagram não tem first_comment_pending legível: nada a retentar");
  if (pending.sending || pending.uncertain) throw new Error("a pendência do 1º comentário já está incerta (resposta sem id ou envio sem resultado gravado): não comenta de novo");
  const at = now.toISOString();
  const attempts = pending.attempts + 1;
  return {
    ...entry,
    first_comment_pending: {
      ...pending,
      error: `tentativa ${attempts} em envio desde ${at} sem resultado gravado: o comentário PODE ter saído (o registro não gravou depois do POST, ou o processo caiu); confira os comentários do post. Erro anterior: ${pending.error || "?"} (#13791)`,
      attempts,
      last_attempt_at: at,
      uncertain: true,
      sending: true,
    },
  };
}

/**
 * Pure: a entrada depois de uma tentativa. Sucesso grava `first_comment_id` e
 * apaga a pendência; falha soma a tentativa e guarda o erro. Depois da marca
 * de envio (#13791) a tentativa já foi somada: a falha só troca o erro e tira
 * a marca (e o `uncertain` que veio com ela, salvo resposta sem id de novo).
 */
export function applyFirstCommentAttempt(entry: ShortPublishedEntry, result: FirstCommentAttempt, now: Date): ShortPublishedEntry {
  const pending = parseFirstCommentPending(entry.first_comment_pending);
  if (!pending) throw new Error("a entrada instagram não tem first_comment_pending legível: nada a retentar");
  if (result.ok) {
    const { first_comment_pending: _drop, ...rest } = entry;
    return { ...rest, first_comment_id: result.id };
  }
  const { sending: wasSending, uncertain: wasUncertain, ...base } = pending;
  return {
    ...entry,
    first_comment_pending: {
      ...base,
      error: result.error,
      attempts: wasSending ? pending.attempts : pending.attempts + 1,
      last_attempt_at: now.toISOString(),
      ...(result.uncertain || (wasUncertain && !wasSending) ? { uncertain: true } : {}),
    },
  };
}
