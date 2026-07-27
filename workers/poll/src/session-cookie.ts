/**
 * workers/poll/src/session-cookie.ts (#4054)
 *
 * **Espelho local** de `scripts/lib/shared/session-cookie.ts` — a fonte da
 * verdade do projeto. Mesmo motivo de `utm-registry.ts`/`ds-tokens.generated.ts`
 * neste diretório: o bundle do Worker `poll` é construído pelo
 * `wrangler`/esbuild a partir de `workers/poll/src/**` e nunca alcança
 * `scripts/**` — nenhum arquivo deste diretório importa de fora dele hoje.
 * Um import relativo `../../../scripts/lib/shared/...` funcionaria no
 * `tsc --noEmit` mas arrastaria o diretório inteiro pra dentro do grafo do
 * bundle — risco desnecessário num artefato que sobe pra produção.
 *
 * **A sincronia é lint-enforced:** `test/session-cookie-mirror-4054.test.ts`
 * compara este arquivo (via `assert.deepEqual` das funções em execução, não
 * string-diff de fonte) com o shared e falha se qualquer comportamento
 * divergir. Editar um dos dois sem o outro quebra o CI.
 *
 * NÃO editar aqui sem editar `scripts/lib/shared/session-cookie.ts` também
 * (ou vice-versa) — copiar byte-a-byte é o contrato.
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

function hasUnsafeChars(email: string): boolean {
  return email.includes("|") || email.includes("\n") || email.includes("\r");
}

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

export function buildSetCookieHeader(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; HttpOnly; Secure; SameSite=Lax`;
}

export function buildClearCookieHeader(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

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
