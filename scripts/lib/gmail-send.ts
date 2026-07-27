/**
 * gmail-send.ts (#4064)
 *
 * Envio de e-mail via Gmail API direta (`users.messages.send`) — usado por
 * `scripts/clarice-guardrail-alarm.ts`, que roda fora de uma sessão Claude
 * Code (Task Scheduler) e por isso não tem acesso ao MCP Gmail (`create_draft`
 * só existe dentro de um agente vivo). Reusa `gFetch`/OAuth de
 * `google-auth.ts` (mesmo refresh token de Drive/inbox-drain), com o novo
 * scope `gmail.send` (#4064 — ver `oauth-setup.ts`; `gmail.readonly`/
 * `gmail.modify`, já concedidos, NÃO incluem enviar mensagens).
 *
 * Sem dependência de libs de MIME externas — a mensagem é texto puro (um
 * alarme não precisa de HTML), então o RFC 2822 mínimo é construído à mão.
 */

import { gFetch } from "../google-auth.ts";

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/**
 * Codifica uma string em base64url (RFC 4648 §5) — formato exigido pelo campo
 * `raw` da Gmail API (não base64 "normal": `+`→`-`, `/`→`_`, sem padding `=`).
 */
export function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Monta um e-mail RFC 2822 mínimo (texto puro, UTF-8) — Subject/To/From
 * (From omitido: a API usa a conta autenticada) + corpo. Pura/testável.
 */
export function buildMimeMessage(to: string, subject: string, bodyText: string): string {
  // #4064: Subject com acentuação precisa de encoded-word (RFC 2047) — texto
  // puro fora do header (Content-Type text/plain; charset=utf-8) já cobre o
  // corpo, mas o header Subject em si é interpretado como ASCII por padrão.
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
  return [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    bodyText,
  ].join("\r\n");
}

export interface GmailSendResult {
  id: string;
  threadId: string;
}

/**
 * Envia um e-mail via Gmail API (`users.messages.send`). Lança em qualquer
 * falha (auth, rede, 4xx/5xx) — nunca engole erro silenciosamente (o caller
 * decide o que fazer; para o alarme de guardrail, uma falha de envio deve
 * ser visível, não mascarada).
 */
export async function sendGmailMessage(
  to: string,
  subject: string,
  bodyText: string,
  _fetchImpl: typeof gFetch = gFetch,
): Promise<GmailSendResult> {
  const raw = base64UrlEncode(buildMimeMessage(to, subject, bodyText));
  const res = await _fetchImpl(GMAIL_SEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail API users.messages.send falhou (${res.status}): ${text.slice(0, 500)}`);
  }
  return (await res.json()) as GmailSendResult;
}
