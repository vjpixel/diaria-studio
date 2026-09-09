/**
 * workers/meta-leads/src/crypto.ts (#7769)
 *
 * HMAC-SHA256 + constant-time string comparison — cópia local do padrão já
 * estabelecido em `workers/poll/src/index.ts` (`hmacSign`/`hmacVerify`) e em
 * `workers/linkedin-cron/src/index.ts` (`constantTimeEquals`). Cada Worker
 * do repo mantém sua própria cópia pequena em vez de importar de outro
 * Worker — mesmo padrão de `workers/draft/src/index.ts` ("HMAC helpers —
 * cópia local de workers/poll — idêntica"). Só Web Crypto (`crypto.subtle`),
 * nada de `node:*` — roda idêntico no runtime Cloudflare Workers e em Node
 * (testes via `node --test` + tsx).
 */

/** Constant-time string equality — evita timing attack em comparação de
 * segredo/assinatura. Mesma implementação de `constantTimeEquals`
 * (workers/linkedin-cron) e do comparador inline de `hmacVerify`
 * (workers/poll, workers/draft). */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** HMAC-SHA256 do `message` com `secret`, hex lowercase. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
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

/**
 * Verifica o header `X-Hub-Signature-256` da Meta (`sha256={hex}`) contra o
 * HMAC-SHA256 do CORPO CRU (a string exata recebida no request, antes de
 * qualquer `JSON.parse`/re-serialização — reserializar mudaria whitespace/
 * ordem de chaves e quebraria a assinatura mesmo com o payload
 * semanticamente idêntico) usando `appSecret` como chave.
 *
 * Nunca lança — header ausente, malformado (sem o prefixo `sha256=`), ou
 * secret vazio retornam `false` sem tentar computar HMAC de segredo vazio.
 */
export async function verifyMetaSignature(
  appSecret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!appSecret) return false;
  if (!signatureHeader) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length).toLowerCase().trim();
  const expected = await hmacSha256Hex(appSecret, rawBody);
  return constantTimeEquals(expected, provided);
}
