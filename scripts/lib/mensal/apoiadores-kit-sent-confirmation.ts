/**
 * scripts/lib/mensal/apoiadores-kit-sent-confirmation.ts (#12739)
 *
 * Pura: decide, a partir da RELEITURA do broadcast no Kit, se o envio da
 * Retrospectiva pros apoiadores pode ser registrado como `sent` no state local
 * (`_internal/beehiiv-apoiadores-state.json`).
 *
 * ## Por que existe
 *
 * O ciclo 2609-10 (broadcast 26211180) ficou com `status: "sent"` no state e
 * `email: done` no state por canal, mas o Kit mostrava o broadcast em `draft`,
 * `send_at: null` e zero aberturas (medição de 10/11/2026, #12611). `preparedAt`
 * e `sentAt` com 15s de diferença, `sentAt` fora de qualquer horário agendado
 * (17:25Z de uma sexta): o rascunho foi criado (a regra #9473 caiu pra rascunho
 * por faltar menos de 24h pro sábado) e o `--mark-sent` rodou logo depois, sem
 * nenhum envio. O `--mark-sent` gravava `sent` pela palavra de quem o rodava, e o
 * publisher gravava `sent` ao AGENDAR conferindo só a audiência na releitura.
 * Nos dois casos o state registrava o que o script fez, nunca o que o ESP fez
 * (mesma classe do #7655, no sentido inverso).
 *
 * A regra agora é a do #573: o estado vem da releitura do ESP, nunca do 2xx da
 * mutação nem da confirmação verbal. Só conta como enviado o broadcast que o Kit
 * devolve como `scheduled` (com `send_at`), `sending` ou `completed`.
 * `draft`, `aborted`, status desconhecido ou ausente recusam.
 */

/** Campos da releitura (`GET /v4/broadcasts/{id}`) que a decisão usa. */
export interface KitBroadcastSendSnapshot {
  status?: string;
  send_at?: string | null;
}

/** Status do Kit que provam envio feito, em curso ou agendado. */
export const KIT_SENT_STATUSES: readonly string[] = ["scheduled", "sending", "completed"];

export type KitSentConfirmation =
  | {
      ok: true;
      status: string;
      /** `send_at` relido (horário agendado ou de disparo), `null` se o Kit não ecoou. */
      sendAt: string | null;
    }
  | { ok: false; reason: string };

export function confirmKitBroadcastSent(live: KitBroadcastSendSnapshot, broadcastId: number): KitSentConfirmation {
  const status = live.status;
  if (status === undefined || !KIT_SENT_STATUSES.includes(status)) {
    const shown = status === undefined ? "desconhecido (a releitura não trouxe o campo)" : `"${status}"`;
    return {
      ok: false,
      reason:
        `o broadcast Kit id=${broadcastId} está com status ${shown} no Kit — só ` +
        `${KIT_SENT_STATUSES.join("/")} contam como envio (#12739). Nada foi enviado ainda: envie ou agende ` +
        "pelo painel do Kit e rode de novo.",
    };
  }
  const sendAt = typeof live.send_at === "string" && live.send_at.length > 0 ? live.send_at : null;
  if (status === "scheduled" && sendAt === null) {
    return {
      ok: false,
      reason:
        `o broadcast Kit id=${broadcastId} aparece como "scheduled", mas sem send_at na releitura — um agendamento ` +
        "zerado (armadilha 4 de kit-client.ts) não dispara. Confira o horário no painel do Kit (#12739).",
    };
  }
  return { ok: true, status, sendAt };
}
