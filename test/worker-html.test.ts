/**
 * worker-html.test.ts (#1178)
 *
 * Tests pra `/html/{key}` handler do Worker poll. Substitui o paste flow
 * chunk-html-base64 + javascript_tool (~80K tokens) por fetch direto
 * (~5K tokens).
 *
 * Cobertura:
 *   - GET: serve HTML quando key existe, 404 quando ausente, CORS em ambos
 *   - PUT: aceita HTML com Bearer HMAC válido, rejeita sem sig, rejeita sig
 *     errado, rejeita body vazio, rejeita >5MB
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  handleHtmlGet,
  handleHtmlPut,
  type Env,
} from "../workers/poll/src/index.ts";

const ADMIN_SECRET = "test-admin-secret";

/** Mock minimal Env com KV stub que armazena strings em memória. */
function makeEnv(store: Map<string, string> = new Map()): Env {
  return {
    POLL: {
      get: async (key: string, _type: string) => store.get(key) ?? null,
      put: async (
        key: string,
        value: string,
        _opts?: { expirationTtl?: number },
      ) => {
        store.set(key, value);
      },
    } as unknown as KVNamespace,
    POLL_SECRET: "test-poll-secret",
    ADMIN_SECRET,
    ALLOWED_ORIGINS: "https://diar.ia.br",
  };
}

function sigFor(key: string): string {
  return createHmac("sha256", ADMIN_SECRET).update(`html:${key}`).digest("hex");
}

describe("handleHtmlGet", () => {
  it("retorna 200 + HTML quando key existe", async () => {
    const store = new Map([["html:260514", "<p>Newsletter body</p>"]]);
    const env = makeEnv(store);
    const res = await handleHtmlGet("/html/260514", env);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<p>Newsletter body</p>");
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("retorna 404 quando key ausente — CORS preservado", async () => {
    const env = makeEnv();
    const res = await handleHtmlGet("/html/missing", env);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("retorna 404 quando key vazia (path = /html/)", async () => {
    const env = makeEnv();
    const res = await handleHtmlGet("/html/", env);
    assert.equal(res.status, 404);
  });

  it("decodifica key URL-encoded", async () => {
    const store = new Map([["html:260514/main", "<p>X</p>"]]);
    const env = makeEnv(store);
    const res = await handleHtmlGet("/html/260514%2Fmain", env);
    assert.equal(res.status, 200);
  });

  it("Cache-Control é private + curto (re-render sobrescreve sem stale)", async () => {
    const store = new Map([["html:260514", "<p>x</p>"]]);
    const env = makeEnv(store);
    const res = await handleHtmlGet("/html/260514", env);
    const cache = res.headers.get("Cache-Control") ?? "";
    assert.match(cache, /private/);
    assert.match(cache, /max-age=/);
  });
});

describe("handleHtmlPut", () => {
  function mkRequest(
    path: string,
    body: string,
    auth?: string,
  ): Request {
    return new Request(`https://example.com${path}`, {
      method: "PUT",
      headers: auth ? { Authorization: auth } : {},
      body,
    });
  }

  it("aceita PUT com Bearer HMAC válido, grava em KV com prefix 'html:'", async () => {
    const store = new Map<string, string>();
    const env = makeEnv(store);
    const sig = sigFor("260514");
    const res = await handleHtmlPut(
      "/html/260514",
      mkRequest("/html/260514", "<p>hello</p>", `Bearer ${sig}`),
      env,
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; key: string; bytes: number };
    assert.equal(data.ok, true);
    assert.equal(data.key, "260514");
    assert.equal(data.bytes, "<p>hello</p>".length);
    // Persiste com prefix
    assert.equal(store.get("html:260514"), "<p>hello</p>");
  });

  it("rejeita 401 quando Authorization ausente", async () => {
    const env = makeEnv();
    const res = await handleHtmlPut(
      "/html/260514",
      mkRequest("/html/260514", "<p>x</p>"),
      env,
    );
    assert.equal(res.status, 401);
  });

  it("rejeita 401 quando Bearer mal-formado", async () => {
    const env = makeEnv();
    const res = await handleHtmlPut(
      "/html/260514",
      mkRequest("/html/260514", "<p>x</p>", "Basic foo"),
      env,
    );
    assert.equal(res.status, 401);
  });

  it("rejeita 403 com Bearer sig inválido (HMAC errado)", async () => {
    const env = makeEnv();
    const wrongSig = createHmac("sha256", "wrong-secret")
      .update("html:260514")
      .digest("hex");
    const res = await handleHtmlPut(
      "/html/260514",
      mkRequest("/html/260514", "<p>x</p>", `Bearer ${wrongSig}`),
      env,
    );
    assert.equal(res.status, 403);
  });

  it("rejeita 403 quando key na URL != key assinado", async () => {
    const env = makeEnv();
    const sigFor260514 = sigFor("260514");
    const res = await handleHtmlPut(
      "/html/260515",
      mkRequest("/html/260515", "<p>x</p>", `Bearer ${sigFor260514}`),
      env,
    );
    assert.equal(res.status, 403);
  });

  it("rejeita 400 com body vazio", async () => {
    const env = makeEnv();
    const sig = sigFor("260514");
    const res = await handleHtmlPut(
      "/html/260514",
      mkRequest("/html/260514", "", `Bearer ${sig}`),
      env,
    );
    assert.equal(res.status, 400);
  });

  it("rejeita 413 com body >5MB", async () => {
    const env = makeEnv();
    const sig = sigFor("260514");
    const big = "x".repeat(5 * 1024 * 1024 + 1);
    const res = await handleHtmlPut(
      "/html/260514",
      mkRequest("/html/260514", big, `Bearer ${sig}`),
      env,
    );
    assert.equal(res.status, 413);
  });

  it("rejeita 400 quando key vazia (path = /html/)", async () => {
    const env = makeEnv();
    const sig = sigFor("");
    const res = await handleHtmlPut(
      "/html/",
      mkRequest("/html/", "<p>x</p>", `Bearer ${sig}`),
      env,
    );
    assert.equal(res.status, 400);
  });
});
