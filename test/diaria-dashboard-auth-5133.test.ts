/**
 * test/diaria-dashboard-auth-5133.test.ts (#5133)
 *
 * `diaria-dashboard` servia HTML + JSON operacional (histórico de rodadas,
 * payload agregado inteiro, espelho de superfície pré-publicação) sem
 * NENHUMA autenticação — `X-Robots-Tag: noindex` (#5097) impede indexação,
 * não impede acesso. Este teste cobre o gate de token compartilhado
 * (header `X-Dashboard-Token` OU cookie de sessão) adicionado em resposta:
 *
 *   - token ausente/errado → 401 (fail-CLOSED, `AUTH_TOKEN` não configurado
 *     nega acesso a TODO mundo)
 *   - token correto (header OU cookie) → 200
 *   - `/healthz`, `/robots.txt`, `/login` seguem públicos por design
 *   - `POST /login` com token correto seta cookie `HttpOnly; Secure;
 *     SameSite=Strict` e redireciona pra `/`
 *   - `HEAD /` devolve o mesmo status de `GET /` (era 500, ver
 *     test/diaria-dashboard-head-5133.test.ts pro grosso dessa cobertura)
 *
 * Mesmo padrão de import dinâmico + polyfill de `caches` do resto da suíte
 * de diaria-dashboard (ver test/diaria-dashboard-noindex-5097.test.ts).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../workers/diaria-dashboard/src/index.ts";

const mod = await import("../workers/diaria-dashboard/src/index.ts");

function resolveWorker(m: Record<string, unknown>): { fetch: (req: Request, env: Env) => Promise<Response> } {
  const level1 = m.default as { fetch?: unknown; default?: unknown } | undefined;
  if (level1 && typeof level1.fetch === "function") {
    return level1 as { fetch: (req: Request, env: Env) => Promise<Response> };
  }
  const level2 = level1?.default as { fetch?: unknown } | undefined;
  if (level2 && typeof level2.fetch === "function") {
    return level2 as { fetch: (req: Request, env: Env) => Promise<Response> };
  }
  throw new Error("resolveWorker: não achou {fetch} nem em mod.default nem em mod.default.default");
}
const worker = resolveWorker(mod);
const { isAuthenticated, loginPage } = mod;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let origCaches: any;
before(() => {
  origCaches = (globalThis as unknown as { caches?: unknown }).caches;
  (globalThis as unknown as { caches: unknown }).caches = {
    default: { match: async () => null, put: async () => {} },
  };
});
after(() => {
  (globalThis as unknown as { caches: unknown }).caches = origCaches;
});

const TOKEN = "s3cr3t-test-token";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DASHBOARD_DATA: { get: async () => null },
    AUTH_TOKEN: TOKEN,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeEnvNoToken(): Env {
  return {
    DASHBOARD_DATA: { get: async () => null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ─── isAuthenticated (unidade) ─────────────────────────────────────────────

describe("isAuthenticated (#5133)", () => {
  it("fail-CLOSED: AUTH_TOKEN ausente nega acesso mesmo com header correto", async () => {
    const req = new Request("https://x/", { headers: { "X-Dashboard-Token": "qualquer-coisa" } });
    assert.equal(await isAuthenticated(req, makeEnvNoToken()), false);
  });

  it("nega quando não há header nem cookie", async () => {
    const req = new Request("https://x/");
    assert.equal(await isAuthenticated(req, makeEnv()), false);
  });

  it("nega quando o header tem o token errado", async () => {
    const req = new Request("https://x/", { headers: { "X-Dashboard-Token": "token-errado" } });
    assert.equal(await isAuthenticated(req, makeEnv()), false);
  });

  it("autentica via header X-Dashboard-Token correto", async () => {
    const req = new Request("https://x/", { headers: { "X-Dashboard-Token": TOKEN } });
    assert.equal(await isAuthenticated(req, makeEnv()), true);
  });

  it("autentica via cookie diaria-dash-auth correto", async () => {
    const req = new Request("https://x/", { headers: { Cookie: `diaria-dash-auth=${TOKEN}` } });
    assert.equal(await isAuthenticated(req, makeEnv()), true);
  });

  it("nega quando o cookie tem o token errado", async () => {
    const req = new Request("https://x/", { headers: { Cookie: "diaria-dash-auth=token-errado" } });
    assert.equal(await isAuthenticated(req, makeEnv()), false);
  });

  it("cookie certo entre outros cookies (parsing de Cookie multi-valor)", async () => {
    const req = new Request("https://x/", {
      headers: { Cookie: `outro=1; diaria-dash-auth=${TOKEN}; terceiro=2` },
    });
    assert.equal(await isAuthenticated(req, makeEnv()), true);
  });
});

// ─── loginPage ──────────────────────────────────────────────────────────────

describe("loginPage (#5133)", () => {
  it("default (sem args) é 401 — resposta de gate, não de visita a /login", () => {
    const res = loginPage();
    assert.equal(res.status, 401);
  });

  it("status 200 explícito para a visita GET /login", () => {
    const res = loginPage(200);
    assert.equal(res.status, 200);
  });

  it("nunca cacheável (Cache-Control: no-store)", () => {
    const res = loginPage(200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });
});

// ─── Rotas públicas (fora do gate) ──────────────────────────────────────────

describe("rotas públicas seguem sem auth (#5133)", () => {
  it("/healthz não exige token", async () => {
    const res = await worker.fetch(new Request("https://x/healthz"), makeEnv());
    assert.equal(res.status, 200);
  });

  it("/robots.txt não exige token", async () => {
    const res = await worker.fetch(new Request("https://x/robots.txt"), makeEnv());
    assert.equal(res.status, 200);
  });

  it("GET /login não exige token (é o próprio ponto de entrada de login)", async () => {
    const res = await worker.fetch(new Request("https://x/login"), makeEnv());
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Token de acesso/);
  });
});

// ─── Gate aplicado a rotas sensíveis ────────────────────────────────────────

describe("token ausente/errado → 401 em rotas protegidas (#5133)", () => {
  for (const path of ["/", "/api/data", "/studio", "/api/studio-snapshot"]) {
    it(`${path} sem token devolve 401`, async () => {
      const res = await worker.fetch(new Request(`https://x${path}`), makeEnv());
      assert.equal(res.status, 401);
    });

    it(`${path} com token errado devolve 401`, async () => {
      const res = await worker.fetch(
        new Request(`https://x${path}`, { headers: { "X-Dashboard-Token": "errado" } }),
        makeEnv(),
      );
      assert.equal(res.status, 401);
    });
  }

  it("AUTH_TOKEN nunca configurado nega acesso mesmo com um header 'válido' coincidente (fail-CLOSED)", async () => {
    // Sem AUTH_TOKEN no env, isAuthenticated retorna false incondicionalmente
    // — não há segredo nenhum pra comparar, então NENHUM header abre a porta.
    const res = await worker.fetch(
      new Request("https://x/", { headers: { "X-Dashboard-Token": "" } }),
      makeEnvNoToken(),
    );
    assert.equal(res.status, 401);
  });
});

describe("token correto → 200 em rotas protegidas (#5133)", () => {
  it("/ com header correto devolve 200 (dashboard não inicializado, sem KV)", async () => {
    const res = await worker.fetch(
      new Request("https://x/", { headers: { "X-Dashboard-Token": TOKEN } }),
      makeEnv(),
    );
    assert.equal(res.status, 200);
  });

  it("/ com cookie correto devolve 200", async () => {
    const res = await worker.fetch(
      new Request("https://x/", { headers: { Cookie: `diaria-dash-auth=${TOKEN}` } }),
      makeEnv(),
    );
    assert.equal(res.status, 200);
  });

  it("/api/data com header correto devolve 404 (não 401) — sem dado no KV, mas autenticado", async () => {
    const res = await worker.fetch(
      new Request("https://x/api/data", { headers: { "X-Dashboard-Token": TOKEN } }),
      makeEnv(),
    );
    assert.equal(res.status, 404);
  });
});

// ─── POST /login ────────────────────────────────────────────────────────────

describe("POST /login (#5133)", () => {
  function loginForm(token: string): Request {
    const body = new URLSearchParams({ token });
    return new Request("https://x/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }

  it("token correto → 302 pra / com Set-Cookie HttpOnly/Secure/SameStrict", async () => {
    const res = await worker.fetch(loginForm(TOKEN), makeEnv());
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), "/");
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    assert.match(setCookie, /diaria-dash-auth=s3cr3t-test-token/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
  });

  it("token errado → 401 com a mesma loginPage (erro visível)", async () => {
    const res = await worker.fetch(loginForm("token-errado"), makeEnv());
    assert.equal(res.status, 401);
    assert.match(await res.text(), /Token inválido/);
  });

  it("AUTH_TOKEN nunca configurado → 403 genérico (não 500, não revela a causa)", async () => {
    const res = await worker.fetch(loginForm("qualquer"), makeEnvNoToken());
    assert.equal(res.status, 403);
  });

  it("método não suportado (ex: DELETE) → 405", async () => {
    const res = await worker.fetch(new Request("https://x/login", { method: "DELETE" }), makeEnv());
    assert.equal(res.status, 405);
  });
});
