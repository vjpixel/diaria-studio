/**
 * test/dashboard-auth.test.ts (#2721)
 *
 * Cobre:
 *  (1) isAuthenticated: dev mode, sem cookie, cookie errado, cookie correto.
 *  (2) loginPage: status e conteúdo corretos.
 *  (3) Fetch handler: /login GET, /login POST, /healthz exempt, / sem auth, / com auth.
 *
 * Usa polyfill de caches + mock de fetch para Brevo — sem deps externas reais.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, {
  isAuthenticated,
  loginPage,
} from "../workers/brevo-dashboard/src/index.ts";

// ---------------------------------------------------------------------------
// Polyfills para APIs do Cloudflare Worker não disponíveis no Node.js
// ---------------------------------------------------------------------------

// Cache API (usada por /api/campaigns e /)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).caches = {
  default: {
    match: async (_req: unknown) => null,
    put: async (_req: unknown, _res: unknown) => {},
  },
};

// Mock da Brevo API — retorna campanhas vazias para todos os requests
const origFetch = globalThis.fetch;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).fetch = async (input: any, init?: any): Promise<Response> => {
  const url = typeof input === "string" ? input : (input as Request)?.url ?? String(input);
  if (url.includes("brevo.com")) {
    return new Response(JSON.stringify({ campaigns: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return origFetch(input, init);
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN = "test-token-abc123-xyz789";
const COOKIE = `cf-dash-auth=${TOKEN}`;
const WRONG_COOKIE = `cf-dash-auth=wrong-value`;

// Mock KV namespace — sempre retorna null (sem cache)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockKV: any = {
  get: async () => null,
  put: async () => {},
  delete: async () => {},
  getWithMetadata: async () => ({ value: null, metadata: null }),
  list: async () => ({ keys: [], list_complete: true, cursor: "" }),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeEnv = (opts: { auth?: string } = {}): any => ({
  BREVO_API_KEY: "mock-key",
  STATS_CACHE: mockKV,
  AUTH_TOKEN: opts.auth,
});

// ---------------------------------------------------------------------------
// Tests: isAuthenticated
// ---------------------------------------------------------------------------

describe("isAuthenticated", () => {
  it("no AUTH_TOKEN → always true (dev mode)", () => {
    const env = makeEnv();
    const req = new Request("http://localhost/");
    assert.ok(isAuthenticated(req, env), "deve retornar true quando AUTH_TOKEN não configurado");
  });

  it("AUTH_TOKEN set, no cookie → false", () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/");
    assert.ok(!isAuthenticated(req, env), "deve retornar false sem cookie");
  });

  it("AUTH_TOKEN set, wrong cookie → false", () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/", { headers: { Cookie: WRONG_COOKIE } });
    assert.ok(!isAuthenticated(req, env), "deve retornar false com cookie errado");
  });

  it("AUTH_TOKEN set, correct cookie → true", () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
    assert.ok(isAuthenticated(req, env), "deve retornar true com cookie correto");
  });
});

// ---------------------------------------------------------------------------
// Tests: loginPage
// ---------------------------------------------------------------------------

describe("loginPage", () => {
  it("loginPage(false): status 200, content-type text/html, sem 'inválido'", async () => {
    const res = loginPage();
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("Content-Type")?.includes("text/html"), "deve ter Content-Type text/html");
    const text = await res.text();
    assert.ok(!text.includes("inválido"), "não deve ter mensagem de erro");
    assert.ok(text.includes("<form"), "deve ter formulário");
  });

  it("loginPage(true): status 401, contém 'inválido'", async () => {
    const res = loginPage(true);
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.ok(text.includes("inválido"), "deve exibir mensagem de erro");
  });
});

// ---------------------------------------------------------------------------
// Tests: fetch handler — rotas de auth
// ---------------------------------------------------------------------------

describe("Worker fetch — auth routes", () => {
  it("/login GET: retorna 200 login page", async () => {
    const req = new Request("http://localhost/login", { method: "GET" });
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("<form"), "deve conter formulário de login");
  });

  it("/login POST token errado: retorna 401 com mensagem de erro", async () => {
    const form = new FormData();
    form.append("token", "wrong-token");
    const req = new Request("http://localhost/login", { method: "POST", body: form });
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.ok(text.includes("inválido"), "deve exibir mensagem de token inválido");
  });

  it("/login POST token correto: 302 para /, Set-Cookie com valor correto", async () => {
    const form = new FormData();
    form.append("token", TOKEN);
    const req = new Request("http://localhost/login", { method: "POST", body: form });
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "/");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    assert.ok(cookie.includes(`cf-dash-auth=${TOKEN}`), "cookie deve ter o token correto");
    assert.ok(cookie.includes("HttpOnly"), "cookie deve ser HttpOnly");
    assert.ok(cookie.includes("Secure"), "cookie deve ser Secure");
    assert.ok(cookie.includes("SameSite=Strict"), "cookie deve ter SameSite=Strict");
  });

  it("/healthz sem auth: retorna 200 (isento de autenticação)", async () => {
    const req = new Request("http://localhost/healthz");
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  it("/ sem auth (AUTH_TOKEN configurado): retorna 200 login page, não dashboard", async () => {
    const req = new Request("http://localhost/");
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("<form"), "deve exibir formulário de login");
    assert.ok(!text.includes("Clarice News Dashboard"), "não deve exibir o dashboard");
  });

  it("/ com cookie válido: retorna 200 dashboard", async () => {
    const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("Clarice News Dashboard"), "deve exibir o dashboard");
    assert.ok(!text.includes("<form"), "não deve exibir formulário de login");
  });
});
