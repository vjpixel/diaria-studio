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

import { describe, it, before, after } from "node:test";
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

// Mock da Brevo API — escopo restrito com before/after para não vazar entre arquivos de teste
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let origFetch: any;

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

before(() => {
  origFetch = globalThis.fetch;
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
});

after(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = origFetch;
});

// ---------------------------------------------------------------------------
// Tests: isAuthenticated
// ---------------------------------------------------------------------------

describe("isAuthenticated", () => {
  it("no AUTH_TOKEN → sempre false (fail-closed, #2748)", () => {
    const env = makeEnv();
    const req = new Request("http://localhost/");
    assert.ok(!isAuthenticated(req, env), "deve retornar false quando AUTH_TOKEN não configurado — nunca libera tudo");
  });

  it("no AUTH_TOKEN, MESMO com um cookie qualquer → false (não há valor que passe)", () => {
    const env = makeEnv();
    const req = new Request("http://localhost/", { headers: { Cookie: "cf-dash-auth=anything" } });
    assert.ok(!isAuthenticated(req, env), "sem AUTH_TOKEN configurado, nenhum cookie autentica");
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

  it("/api/campaigns sem auth: retorna JSON (isento de autenticação)", async () => {
    const req = new Request("http://localhost/api/campaigns");
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 200);
    const ct = res.headers.get("Content-Type") ?? "";
    assert.ok(ct.includes("application/json"), "deve retornar JSON, não login page");
  });

  it("/login PUT: retorna 405 Method Not Allowed", async () => {
    const req = new Request("http://localhost/login", { method: "PUT" });
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 405);
    assert.ok((res.headers.get("Allow") ?? "").includes("POST"), "deve ter Allow header com POST");
  });

  it("/login POST sem AUTH_TOKEN: 500 acesso negado (fail-closed, #2748 — NÃO redireciona pra /)", async () => {
    const form = new FormData();
    form.append("token", "qualquer");
    const req = new Request("http://localhost/login", { method: "POST", body: form });
    const res = await worker.fetch(req, makeEnv());  // no auth token
    assert.equal(res.status, 500);
    assert.notEqual(res.headers.get("Location"), "/", "não deve mais deixar entrar via /login sem AUTH_TOKEN");
    const text = await res.text();
    assert.ok(text.includes("não configurado"), "mensagem explica a causa (config ausente, não erro do usuário)");
  });

  it("/ sem AUTH_TOKEN configurado: mostra login page, NÃO o dashboard com PII (#2748)", async () => {
    const req = new Request("http://localhost/");
    const res = await worker.fetch(req, makeEnv());  // no auth token
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("<form"), "deve exibir formulário de login");
    assert.ok(!text.includes("Clarice News Dashboard"), "NUNCA deve expor o dashboard sem AUTH_TOKEN configurado");
  });
});
