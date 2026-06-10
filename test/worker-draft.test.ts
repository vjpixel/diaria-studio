/**
 * test/worker-draft.test.ts (#2046)
 *
 * Testa o `handleGet` do Worker `draft` com foco no fallback de leitura
 * novo→legado implementado em #2046.
 *
 * Casos cobertos:
 *   1. key nova presente no KV → serve direto (sem fallback)
 *   2. key nova ausente, legada presente → serve a legada (retrocompat)
 *   3. ambas ausentes → 404
 *   4. key legada pedida diretamente (m{YYMM}) → comportamento atual inalterado
 *      (sem tentar fallback pra key nova)
 *
 * Também cobre `legacyKeyFromNew` — helper puro exportado para testabilidade.
 *
 * Mock KV: Map<string, string> em memória. Não usa wrangler/unstable_dev —
 * testes são Node puros, sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleGet, legacyKeyFromNew } from "../workers/draft/src/index.ts";

// ── Mock Env ──────────────────────────────────────────────────────────────────

type MockKV = Map<string, string>;

function makeEnv(kv: MockKV): { DRAFT: { get: (key: string, type: string) => Promise<string | null> }; ADMIN_SECRET: string } {
  return {
    DRAFT: {
      async get(key: string, _type: string): Promise<string | null> {
        return kv.get(key) ?? null;
      },
    },
    ADMIN_SECRET: "test-secret",
  };
}

// ── legacyKeyFromNew (pure helper) ────────────────────────────────────────────

describe("legacyKeyFromNew (#2046)", () => {
  it("formato novo m{YYMM}-{MM} → m{YYMM}", () => {
    assert.equal(legacyKeyFromNew("m2605-06"), "m2605");
    assert.equal(legacyKeyFromNew("m2612-01"), "m2612");
    assert.equal(legacyKeyFromNew("m0001-02"), "m0001");
  });

  it("formato legado m{YYMM} → null (não elegível para fallback)", () => {
    assert.equal(legacyKeyFromNew("m2605"), null);
  });

  it("key de diária (AAMMDD sem prefixo m) → null", () => {
    assert.equal(legacyKeyFromNew("260518"), null);
  });

  it("key social (hash) → null", () => {
    assert.equal(legacyKeyFromNew("social-260518-abc123"), null);
  });

  it("string vazia → null", () => {
    assert.equal(legacyKeyFromNew(""), null);
  });

  it("formato m com sufixo longo (não é -MM) → null", () => {
    // m2605-061 tem 3 dígitos após o hífen — não casa o regex
    assert.equal(legacyKeyFromNew("m2605-061"), null);
    assert.equal(legacyKeyFromNew("m2605-6"), null); // MM não zero-padded
  });
});

// ── handleGet — fallback de leitura (#2046) ────────────────────────────────────

describe("handleGet — fallback novo→legado (#2046)", () => {
  it("caso 1: key nova presente → 200, serve direto sem fallback", async () => {
    const kv: MockKV = new Map([
      ["html:m2605-06", "<html>novo</html>"],
      ["html:m2605", "<html>legado</html>"],
    ]);
    const env = makeEnv(kv);
    const res = await handleGet("/m2605-06", env as never);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, "<html>novo</html>", "deve servir a key nova (sem cair no legado)");
  });

  it("caso 2: key nova ausente + legada presente → 200, serve a legada (retrocompat)", async () => {
    const kv: MockKV = new Map([
      // Sem "html:m2605-06" — simula preview publicado antes da migração
      ["html:m2605", "<html>legado</html>"],
    ]);
    const env = makeEnv(kv);
    const res = await handleGet("/m2605-06", env as never);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, "<html>legado</html>", "fallback: retorna o conteúdo da key legada");
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
  });

  it("caso 3: ambas ausentes → 404", async () => {
    const kv: MockKV = new Map(); // KV vazio
    const env = makeEnv(kv);
    const res = await handleGet("/m2605-06", env as never);
    assert.equal(res.status, 404);
  });

  it("caso 4: key legada pedida diretamente → comportamento inalterado (sem tentar nova)", async () => {
    const kv: MockKV = new Map([
      // Key nova presente, legada ausente — mas pedimos /m2605 (formato legado)
      ["html:m2605-06", "<html>novo</html>"],
    ]);
    const env = makeEnv(kv);
    const res = await handleGet("/m2605", env as never);
    // legacyKeyFromNew("m2605") retorna null → sem fallback → 404
    assert.equal(res.status, 404, "key legada ausente + sem tentativa de nova → 404");
  });

  it("key vazia (path '/') → 404", async () => {
    const kv: MockKV = new Map();
    const env = makeEnv(kv);
    const res = await handleGet("/", env as never);
    assert.equal(res.status, 404);
  });

  it("key de diária (AAMMDD) presente → 200 direto, sem fallback mensal", async () => {
    const kv: MockKV = new Map([["html:260518", "<html>diaria</html>"]]);
    const env = makeEnv(kv);
    const res = await handleGet("/260518", env as never);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, "<html>diaria</html>");
  });

  it("key de diária ausente → 404 sem fallback (legacyKeyFromNew retorna null)", async () => {
    const kv: MockKV = new Map();
    const env = makeEnv(kv);
    const res = await handleGet("/260518", env as never);
    assert.equal(res.status, 404);
  });

  it("CORS header presente em 200 via fallback", async () => {
    const kv: MockKV = new Map([["html:m2605", "<html>legado</html>"]]);
    const env = makeEnv(kv);
    const res = await handleGet("/m2605-06", env as never);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("CORS header presente em 404", async () => {
    const kv: MockKV = new Map();
    const env = makeEnv(kv);
    const res = await handleGet("/m2605-06", env as never);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });
});
