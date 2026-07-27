/**
 * workers/cursos/src/cookie.ts (#4052)
 *
 * Adapter fino sobre `scripts/lib/shared/session-cookie.ts` — fixa o NOME do
 * cookie e o TTL de sessão pra este worker. A lógica de sign/verify/Set-Cookie
 * em si é genérica e vive em `lib/shared/` (extraída no #4052 já pensando no
 * #4054, que precisará do MESMO primitivo em `workers/poll`).
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

export async function issueSessionCookie(secret: string, email: string): Promise<string> {
  const value = await signSessionCookie(secret, email, CURSOS_SESSION_TTL_SEC);
  return buildSetCookieHeader(CURSOS_SESSION_COOKIE, value, CURSOS_SESSION_TTL_SEC);
}

export async function readSessionEmail(secret: string, cookieHeader: string | null): Promise<string | null> {
  const raw = parseCookieHeader(cookieHeader, CURSOS_SESSION_COOKIE);
  if (!raw) return null;
  const result = await verifySessionCookie(secret, raw);
  return result.ok ? result.email : null;
}

export function clearSessionCookieHeader(): string {
  return buildClearCookieHeader(CURSOS_SESSION_COOKIE);
}
