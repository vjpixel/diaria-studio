/**
 * test/workers-draft.test.ts (#1239)
 *
 * Cobre handlers GET/PUT do Worker draft. Não testa KV real — usa mock
 * que armazena em Map em memória. Auth HMAC é testado com secret fixo.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  handleGet,
  handlePut,
  TTL_SECONDS,
} from "../workers/draft/src/index.ts";

interface MockKVNamespace {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  store: Map<string, { value: string; ttl?: number }>;
}

function makeMockKV(): MockKVNamespace {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    store,
    async get(key, _type) {
      return store.get(key)?.value ?? null;
    },
    async put(key, value, opts) {
      store.set(key, { value, ttl: opts?.expirationTtl });
    },
  };
}

function hmac(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

const ADMIN_SECRET = "test-admin-secret-1239";

let kv: MockKVNamespace;
let env: { DRAFT: MockKVNamespace; ADMIN_SECRET: string };

beforeEach(() => {
  kv = makeMockKV();
  env = { DRAFT: kv, ADMIN_SECRET };
});

describe("handleGet (#1239)", () => {
  it("retorna 200 + HTML quando key existe", async () => {
    kv.store.set("html:260514", { value: "<html>edition 260514</html>" });
    const res = await handleGet("/260514", env as never);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /edition 260514/);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("retorna 404 quando key não existe", async () => {
    const res = await handleGet("/260999", env as never);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("retorna 404 quando path é apenas /", async () => {
    const res = await handleGet("/", env as never);
    assert.equal(res.status, 404);
  });

  it("decoda key URL-encoded", async () => {
    kv.store.set("html:my key", { value: "<html>foo</html>" });
    const res = await handleGet("/my%20key", env as never);
    assert.equal(res.status, 200);
  });

  it("Cache-Control curto pra permitir re-render", async () => {
    kv.store.set("html:260514", { value: "<html>x</html>" });
    const res = await handleGet("/260514", env as never);
    const cc = res.headers.get("Cache-Control");
    assert.match(cc!, /max-age=60/);
    assert.doesNotMatch(cc!, /immutable/);
  });
});

describe("handlePut (#1239)", () => {
  it("rejeita 401 sem Authorization header", async () => {
    const req = new Request("https://draft.example.dev/260514", {
      method: "PUT",
      body: "<html>x</html>",
    });
    const res = await handlePut("/260514", req, env as never);
    assert.equal(res.status, 401);
  });

  it("rejeita 403 com sig inválida", async () => {
    const req = new Request("https://draft.example.dev/260514", {
      method: "PUT",
      body: "<html>x</html>",
      headers: { Authorization: "Bearer deadbeef" },
    });
    const res = await handlePut("/260514", req, env as never);
    assert.equal(res.status, 403);
  });

  it("rejeita 400 com body vazio", async () => {
    const sig = hmac(ADMIN_SECRET, "html:260514");
    const req = new Request("https://draft.example.dev/260514", {
      method: "PUT",
      body: "",
      headers: { Authorization: `Bearer ${sig}` },
    });
    const res = await handlePut("/260514", req, env as never);
    assert.equal(res.status, 400);
  });

  it("rejeita 400 com key vazia", async () => {
    const sig = hmac(ADMIN_SECRET, "html:");
    const req = new Request("https://draft.example.dev/", {
      method: "PUT",
      body: "<html>x</html>",
      headers: { Authorization: `Bearer ${sig}` },
    });
    const res = await handlePut("/", req, env as never);
    assert.equal(res.status, 400);
  });

  it("rejeita 413 com body > 5MB", async () => {
    const bigBody = "x".repeat(6 * 1024 * 1024);
    const sig = hmac(ADMIN_SECRET, "html:260514");
    const req = new Request("https://draft.example.dev/260514", {
      method: "PUT",
      body: bigBody,
      headers: { Authorization: `Bearer ${sig}` },
    });
    const res = await handlePut("/260514", req, env as never);
    assert.equal(res.status, 413);
  });

  it("aceita 200 com sig válida + body válido, grava no KV com TTL", async () => {
    const html = "<html>edition 260514</html>";
    const sig = hmac(ADMIN_SECRET, "html:260514");
    const req = new Request("https://draft.example.dev/260514", {
      method: "PUT",
      body: html,
      headers: { Authorization: `Bearer ${sig}` },
    });
    const res = await handlePut("/260514", req, env as never);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; key: string; bytes: number; ttl_seconds: number };
    assert.equal(body.ok, true);
    assert.equal(body.key, "260514");
    assert.equal(body.bytes, html.length);
    assert.equal(body.ttl_seconds, TTL_SECONDS);
    // KV check
    const stored = kv.store.get("html:260514");
    assert.ok(stored);
    assert.equal(stored!.value, html);
    assert.equal(stored!.ttl, TTL_SECONDS);
  });

  it("TTL é 12h (43200s) — confirma constante exposta", () => {
    assert.equal(TTL_SECONDS, 12 * 60 * 60);
  });

  it("aceita Bearer case-insensitive", async () => {
    const sig = hmac(ADMIN_SECRET, "html:260514");
    const req = new Request("https://draft.example.dev/260514", {
      method: "PUT",
      body: "<html>x</html>",
      headers: { Authorization: `bearer ${sig}` },
    });
    const res = await handlePut("/260514", req, env as never);
    assert.equal(res.status, 200);
  });
});
