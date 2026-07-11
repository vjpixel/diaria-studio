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
  // #3081: isAuthenticated virou async (comparação timing-safe via
  // crypto.subtle.digest) — todo teste precisa await agora.
  it("no AUTH_TOKEN → sempre false (fail-closed, #2748)", async () => {
    const env = makeEnv();
    const req = new Request("http://localhost/");
    assert.ok(!(await isAuthenticated(req, env)), "deve retornar false quando AUTH_TOKEN não configurado — nunca libera tudo");
  });

  it("no AUTH_TOKEN, MESMO com um cookie qualquer → false (não há valor que passe)", async () => {
    const env = makeEnv();
    const req = new Request("http://localhost/", { headers: { Cookie: "cf-dash-auth=anything" } });
    assert.ok(!(await isAuthenticated(req, env)), "sem AUTH_TOKEN configurado, nenhum cookie autentica");
  });

  it("AUTH_TOKEN set, no cookie → false", async () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/");
    assert.ok(!(await isAuthenticated(req, env)), "deve retornar false sem cookie");
  });

  it("AUTH_TOKEN set, wrong cookie → false", async () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/", { headers: { Cookie: WRONG_COOKIE } });
    assert.ok(!(await isAuthenticated(req, env)), "deve retornar false com cookie errado");
  });

  it("AUTH_TOKEN set, correct cookie → true", async () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/", { headers: { Cookie: COOKIE } });
    assert.ok(await isAuthenticated(req, env), "deve retornar true com cookie correto");
  });

  // #3081: regressão — comparação timing-safe não pode quebrar cookies com
  // tamanho DIFERENTE do token real (bug plausível numa implementação ingênua
  // via hash: comparar digests de tamanhos diferentes sem normalizar).
  it("cookie muito mais curto que o token → false (não lança, não autentica)", async () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/", { headers: { Cookie: "cf-dash-auth=x" } });
    assert.ok(!(await isAuthenticated(req, env)), "cookie curto nunca autentica");
  });

  it("cookie muito mais longo que o token → false", async () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/", { headers: { Cookie: `cf-dash-auth=${TOKEN}-com-sufixo-extra-bem-longo` } });
    assert.ok(!(await isAuthenticated(req, env)), "cookie longo nunca autentica");
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

  // #3081 (achado no /code-review max, PR3162): a comparação de /login POST
  // também virou timing-safe (hash+XOR, mesmo helper de isAuthenticated) —
  // antes só o cookie-check tinha sido endurecido. Regressão: token de
  // tamanho MUITO diferente do real não pode nem lançar nem autenticar
  // (mesma classe de bug que os testes de cookie curto/longo já cobrem).
  it("/login POST token de tamanho muito diferente do real: 401, não lança", async () => {
    const form = new FormData();
    form.append("token", "x");
    const req = new Request("http://localhost/login", { method: "POST", body: form });
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 401);
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
    // #3257: a checagem era `!text.includes("<form")` — servia como proxy pra
    // "não é a login page" só porque, até então, o único <form> de todo o
    // worker era o de /login. Isso deixou de valer com o botão "Atualizar"
    // da aba Engajamento (EIA_REFRESH_BUTTON em sections-kv.ts), que é um
    // <form method="POST" action="/api/eia/refresh"> LEGÍTIMO dentro do
    // próprio dashboard autenticado — não um vazamento da login page.
    // Assertion agora mira o marcador REAL do form de login (action="/login"),
    // preservando a intenção original sem quebrar por causa do form novo.
    assert.ok(!text.includes('action="/login"'), "não deve exibir formulário de login");
  });

  it("/api/campaigns sem auth: retorna JSON (isento de autenticação)", async () => {
    const req = new Request("http://localhost/api/campaigns");
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 200);
    const ct = res.headers.get("Content-Type") ?? "";
    assert.ok(ct.includes("application/json"), "deve retornar JSON, não login page");
  });

  // #2748: /api/coupons é a ÚNICA rota /api/* que exige auth explícita (carrega
  // PII — e-mail de clientes) — o exato caso que o fail-open original expunha.
  // Cobertura E2E via worker.fetch (não só unit test de getCouponUsage) pra
  // travar contra uma futura "simplificação" que reuse a isenção genérica /api/*.
  it("/api/coupons sem cookie (AUTH_TOKEN configurado): NÃO retorna dados — login page", async () => {
    const req = new Request("http://localhost/api/coupons");
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    const text = await res.text();
    assert.ok(text.includes("<form"), "deve receber a login page, não JSON de cupons");
    const ct = res.headers.get("Content-Type") ?? "";
    assert.ok(!ct.includes("application/json"), "não deve retornar JSON sem auth");
  });

  it("/api/coupons com cookie ERRADO (AUTH_TOKEN configurado): NÃO retorna dados", async () => {
    const req = new Request("http://localhost/api/coupons", { headers: { Cookie: WRONG_COOKIE } });
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    const text = await res.text();
    assert.ok(text.includes("<form"), "cookie errado → login page, não dados de cupons");
  });

  it("/api/coupons SEM AUTH_TOKEN configurado: fail-closed, NÃO expõe dados (#2748 — o bug original)", async () => {
    const req = new Request("http://localhost/api/coupons");
    const res = await worker.fetch(req, makeEnv());  // sem auth token
    const text = await res.text();
    assert.ok(text.includes("<form"), "sem AUTH_TOKEN configurado, /api/coupons deve cair na login page, nunca vazar PII");
  });

  it("/api/coupons com cookie VÁLIDO: passa do gate de auth (não recebe a login page)", async () => {
    const req = new Request("http://localhost/api/coupons", { headers: { Cookie: COOKIE } });
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    const text = await res.text();
    // Sem COUPONS_TAB_ENABLED/dado no KV, getCouponUsage tende a retornar null
    // (404) — o que importa aqui é que o gate de auth foi PASSADO, não travado
    // na login page (prova de que um cookie válido chega até a lógica de dados).
    assert.ok(!text.includes("<form"), "cookie válido não deve cair na login page");
  });

  it("/login PUT: retorna 405 Method Not Allowed", async () => {
    const req = new Request("http://localhost/login", { method: "PUT" });
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 405);
    assert.ok((res.headers.get("Allow") ?? "").includes("POST"), "deve ter Allow header com POST");
  });

  it("/login POST sem AUTH_TOKEN: 403 genérico (fail-closed, #2748 — NÃO redireciona pra /)", async () => {
    const form = new FormData();
    form.append("token", "qualquer");
    const req = new Request("http://localhost/login", { method: "POST", body: form });
    const res = await worker.fetch(req, makeEnv());  // no auth token
    // 403 (não 500): negação de acesso deliberada, não erro de servidor — e a
    // mensagem NÃO nomeia "AUTH_TOKEN" pra não sinalizar a um scanner externo
    // que este deploy específico tem o secret ausente (vs. token errado).
    assert.equal(res.status, 403);
    assert.notEqual(res.headers.get("Location"), "/", "não deve mais deixar entrar via /login sem AUTH_TOKEN");
    const text = await res.text();
    assert.ok(!text.includes("AUTH_TOKEN"), "mensagem não deve nomear a causa exata (evita reconhecimento externo)");
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
