/**
 * workers/draft/src/index.ts (#1239)
 *
 * Worker dedicado pra hospedar HTML preview da newsletter Diar.ia.
 * Extraído do Worker `diar-ia-poll` (rotas `/html/{key}` legados).
 *
 * Vantagens vs estar no poll Worker:
 * - URL mais curta e memorável: `draft.diaria.workers.dev/260514`
 *   (vs `diar-ia-poll.diaria.workers.dev/html/260514`)
 * - Separação de responsabilidade — poll faz voto/imagem/stats, draft faz HTML
 * - Namespace KV separado evita conflito de keys
 * - TTL/policy independente do poll
 *
 * Rotas:
 *   GET /{key}     → retorna HTML (text/html, CORS *, max-age curto)
 *   PUT /{key}     → grava HTML no KV. Auth via HMAC(ADMIN_SECRET, "html:{key}")
 *                    no header Authorization: "Bearer {sig}". TTL 12h.
 *   OPTIONS /{key} → preflight CORS
 *
 * Deploy: ver workers/draft/README.md (cria KV namespace + deploy).
 */

interface Env {
  DRAFT: KVNamespace;
  ADMIN_SECRET: string;
}

// ── HMAC helpers (copia local de workers/poll — idêntica) ─────────────────────

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
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" } as const;
const KV_PREFIX = "html:";
export const TTL_SECONDS = 12 * 60 * 60; // 12h

function extractKey(path: string): string {
  return decodeURIComponent(path.slice(1));
}

export async function handleGet(path: string, env: Env): Promise<Response> {
  const key = extractKey(path);
  if (!key) {
    return new Response("not found", { status: 404, headers: CORS_HEADERS });
  }
  const value = await env.DRAFT.get(KV_PREFIX + key, "text");
  if (!value) {
    return new Response("not found", { status: 404, headers: CORS_HEADERS });
  }
  return new Response(value, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      // Curto: re-render no mesmo edition sobrescreve sem stale.
      "Cache-Control": "private, max-age=60",
    },
  });
}

export async function handlePut(
  path: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const key = extractKey(path);
  if (!key) {
    return new Response(JSON.stringify({ error: "key required" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  // Auth: Authorization: Bearer {HMAC(ADMIN_SECRET, "html:{key}")}
  const authHeader = request.headers.get("authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+([0-9a-f]+)$/i);
  const sig = m?.[1] ?? "";
  if (!sig) {
    return new Response(JSON.stringify({ error: "missing Bearer token" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  const valid = await hmacVerify(env.ADMIN_SECRET, `html:${key}`, sig);
  if (!valid) {
    return new Response(JSON.stringify({ error: "invalid signature" }), {
      status: 403,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  const body = await request.text();
  if (!body) {
    return new Response(JSON.stringify({ error: "empty body" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (body.length > 5 * 1024 * 1024) {
    return new Response(JSON.stringify({ error: "body too large (>5MB)" }), {
      status: 413,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  await env.DRAFT.put(KV_PREFIX + key, body, { expirationTtl: TTL_SECONDS });
  return new Response(
    JSON.stringify({ ok: true, key, bytes: body.length, ttl_seconds: TTL_SECONDS }),
    {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, content-type",
        },
      });
    }
    if (request.method === "GET") return handleGet(path, env);
    if (request.method === "PUT") return handlePut(path, request, env);
    return new Response(
      JSON.stringify({ error: "method not allowed", allowed: ["GET", "PUT", "OPTIONS"] }),
      {
        status: 405,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  },
};
