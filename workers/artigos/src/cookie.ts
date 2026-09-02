/**
 * workers/artigos/src/cookie.ts (#7030)
 *
 * Adapter fino sobre `scripts/lib/shared/session-cookie.ts` — mesmo padrão
 * de `workers/cursos/src/cookie.ts` (#4052), fixando nome do cookie + TTL
 * pra este worker. Sem estado `pending` (diferente de cursos): este gate não
 * tem cadastro inline — só verificação de e-mail já apoiador
 * (`POST /gate/verify`), então toda sessão emitida já é "confirmada".
 */
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  parseCookieHeader,
  signSessionCookie,
  verifySessionCookie,
} from "../../../scripts/lib/shared/session-cookie.ts";

export const ARTIGOS_SESSION_COOKIE = "diaria_especial_session";
/** 30 dias — mesma decisão de `workers/cursos` (#4052): sessão longa, é
 * soft-gate por convite, não segurança de alto risco. */
export const ARTIGOS_SESSION_TTL_SEC = 30 * 24 * 60 * 60;

export async function issueSessionCookie(secret: string, email: string): Promise<string> {
  const value = await signSessionCookie(secret, email, ARTIGOS_SESSION_TTL_SEC);
  return buildSetCookieHeader(ARTIGOS_SESSION_COOKIE, value, ARTIGOS_SESSION_TTL_SEC);
}

/** `null` = sem sessão válida (ausente, expirada, adulterada). */
export async function readSessionEmail(secret: string, cookieHeader: string | null): Promise<string | null> {
  const raw = parseCookieHeader(cookieHeader, ARTIGOS_SESSION_COOKIE);
  if (!raw) return null;
  const result = await verifySessionCookie(secret, raw);
  return result.ok ? result.email : null;
}

export function clearSessionCookieHeader(): string {
  return buildClearCookieHeader(ARTIGOS_SESSION_COOKIE);
}
