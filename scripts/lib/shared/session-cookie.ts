/**
 * session-cookie.ts (#4052)
 *
 * Cookie de sessão assinado (HMAC-SHA256) — genérico, sem dependência de
 * `Env`/binding de nenhum worker específico. Extraído pra `lib/shared/`
 * (#4054, briefing do coordenador) porque `workers/cursos` (#4052, primeiro
 * consumidor) e `workers/poll` (#4054, "É IA? diário: e-mail obrigatório no
 * caminho de fora") precisam do MESMO primitivo de sessão — sign/verify +
 * TTL + construção do header `Set-Cookie` (HttpOnly; Secure; SameSite=Lax).
 *
 * Só usa Web Crypto (`crypto.subtle`) — roda idêntico em Node (test) e no
 * runtime Cloudflare Workers, sem polyfill/`nodejs_compat`. Nenhum import de
 * `node:*` aqui (mantém a fronteira de `test/lib-boundary.test.ts` limpa e
 * mantém o módulo importável por qualquer worker sem custo de bundle).
 *
 * Payload do cookie: `{email}|{expiryEpochSeconds}|{hmacHex}` — texto simples
 * separado por `|` (não JSON: menor, e email/expiry nunca contêm `|`).
 * `hmacHex` cobre `{email}|{expiryEpochSeconds}` — adulterar qualquer um dos
 * dois campos invalida a assinatura.
 */

async function hmacSign(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacVerify(secret: string, message: string, sig: string): Promise<boolean> {
  const expected = await hmacSign(secret, message);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export type SessionVerifyResult =
  | { ok: true; email: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/** `|` no e-mail quebraria o parse — nunca deveria acontecer (e-mail válido
 * não contém `|`), mas defensivo: rejeita antes de assinar. */
function hasUnsafeChars(email: string): boolean {
  return email.includes("|") || email.includes("\n") || email.includes("\r");
}

/**
 * Assina `{email, expiresAt}` → valor de cookie opaco. `now` injetável pra
 * teste (default: relógio real).
 */
export async function signSessionCookie(
  secret: string,
  email: string,
  ttlSec: number,
  now: () => number = () => Date.now(),
): Promise<string> {
  if (hasUnsafeChars(email)) throw new Error("email contém caractere reservado do cookie");
  const expiresAt = Math.floor(now() / 1000) + Math.floor(ttlSec);
  const message = `${email}|${expiresAt}`;
  const sig = await hmacSign(secret, message);
  return `${message}|${sig}`;
}

/**
 * Verifica um valor de cookie: assinatura válida E não expirado. `now`
 * injetável pra teste. Nunca lança — toda entrada malformada vira
 * `{ok:false, reason:"malformed"}`.
 */
export async function verifySessionCookie(
  secret: string,
  cookieValue: string,
  now: () => number = () => Date.now(),
): Promise<SessionVerifyResult> {
  const parts = cookieValue.split("|");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [email, expiresAtRaw, sig] = parts;
  const expiresAt = parseInt(expiresAtRaw, 10);
  if (!email || !Number.isFinite(expiresAt)) return { ok: false, reason: "malformed" };

  const message = `${email}|${expiresAt}`;
  const valid = await hmacVerify(secret, message, sig);
  if (!valid) return { ok: false, reason: "bad_signature" };

  if (Math.floor(now() / 1000) >= expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, email };
}

/**
 * Monta o header `Set-Cookie` completo (HttpOnly; Secure; SameSite=Lax;
 * Path=/; Max-Age). `maxAgeSec` deve bater com o `ttlSec` usado em
 * `signSessionCookie` (não é derivado automaticamente — caller decide, ex:
 * cookie de "logout" usa `Max-Age=0` com valor vazio).
 */
export function buildSetCookieHeader(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; HttpOnly; Secure; SameSite=Lax`;
}

/** Header `Set-Cookie` que expira/apaga o cookie imediatamente. */
export function buildClearCookieHeader(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Extrai o valor de um cookie nomeado do header `Cookie` cru da request.
 * Retorna `null` se ausente. Nunca lança. */
export function parseCookieHeader(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}
