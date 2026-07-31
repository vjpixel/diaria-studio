/**
 * workers/cursos/src/cookie.ts (#4052)
 *
 * Adapter fino sobre `scripts/lib/shared/session-cookie.ts` — fixa o NOME do
 * cookie e o TTL de sessão pra este worker. A lógica de sign/verify/Set-Cookie
 * em si é genérica e vive em `lib/shared/` (extraída no #4052 já pensando no
 * #4054, que precisará do MESMO primitivo em `workers/poll`).
 *
 * #4323: estado `pending` vs `confirmed`, portado do MESMO padrão que
 * `workers/poll/src/web-gate.ts` (#4121) já usa — `handleGateSubscribe`
 * (subscribe.ts) confiava em qualquer 2xx de `POST /subscriptions` da Beehiiv
 * pra emitir uma sessão de 30 dias com acesso completo, sem nunca checar o
 * `status` do corpo da resposta (double opt-in pode continuar pendente).
 * Mecanismo idêntico ao de `web-gate.ts`: o estado vai embutido no PAYLOAD
 * assinado via prefixo (`pending:{email}`) — `:` nunca aparece num e-mail
 * válido (`isValidEmailFormat`, subscribe.ts, rejeita `:` nos dois lados do
 * `@`), então não precisa de campo extra em `signSessionCookie` (genérico,
 * compartilhado com `workers/poll`). Cookies emitidos ANTES do #4323 nunca têm
 * o prefixo — `readSession` trata ausência como `pending: false` (mesma
 * decisão do editor em #4121: a janela de exposição já passou, tratar como
 * confirmado mantém quem já tinha sessão funcionando sem novo login).
 */
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  parseCookieHeader,
  signSessionCookie,
  verifySessionCookie,
} from "../../../scripts/lib/shared/session-cookie.ts";

export const CURSOS_SESSION_COOKIE = "diaria_cursos_session";
/** ~30 dias (#4052, decisão do editor: sessão longa — verificação já é soft-gate). */
export const CURSOS_SESSION_TTL_SEC = 30 * 24 * 60 * 60;

export type CursosSessionState = "pending" | "confirmed";
const PENDING_PREFIX = "pending:";

export async function issueSessionCookie(
  secret: string,
  email: string,
  state: CursosSessionState = "confirmed",
): Promise<string> {
  const payload = state === "pending" ? `${PENDING_PREFIX}${email}` : email;
  const value = await signSessionCookie(secret, payload, CURSOS_SESSION_TTL_SEC);
  return buildSetCookieHeader(CURSOS_SESSION_COOKIE, value, CURSOS_SESSION_TTL_SEC);
}

export interface CursosSession {
  email: string;
  /** true = cadastro feito via `/gate/subscribe`, Beehiiv ainda não confirmou
   * `status: "active"` no corpo da resposta — double opt-in pode continuar
   * pendente. `false` = sessão verificada de verdade (via `/gate/verify` ou
   * `?email=` confirmando `active`, ou cadastro que já veio `active` na
   * mesma resposta — o caminho comum e frictionless, #4305). */
  pending: boolean;
}

/** Lê a sessão completa (e-mail + estado pending/confirmed). `cookieHeader`
 * pode ser `null`/ausente. */
export async function readSession(secret: string, cookieHeader: string | null): Promise<CursosSession | null> {
  const raw = parseCookieHeader(cookieHeader, CURSOS_SESSION_COOKIE);
  if (!raw) return null;
  const result = await verifySessionCookie(secret, raw);
  if (!result.ok) return null;
  if (result.email.startsWith(PENDING_PREFIX)) {
    return { email: result.email.slice(PENDING_PREFIX.length), pending: true };
  }
  return { email: result.email, pending: false };
}

/** Retrocompat: só o e-mail de uma sessão CONFIRMADA — `null` pra sessão
 * `pending` (acesso completo não pode ser concedido antes da confirmação,
 * #4323) e pra ausência/assinatura inválida. Callers que precisam distinguir
 * os dois estados usam `readSession` diretamente. */
export async function readSessionEmail(secret: string, cookieHeader: string | null): Promise<string | null> {
  const session = await readSession(secret, cookieHeader);
  return session && !session.pending ? session.email : null;
}

export function clearSessionCookieHeader(): string {
  return buildClearCookieHeader(CURSOS_SESSION_COOKIE);
}
