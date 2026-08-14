/**
 * test/clarice-dashboard-precompute-5217.test.ts (#5217)
 *
 * Cobertura do caminho de auth novo pro precompute horário:
 *  (1) Worker (`isAuthenticated`/rota `/`): Authorization: Bearer <AUTH_TOKEN>
 *      válido → autentica igual ao cookie; ausente/inválido → 401 (login
 *      page) como hoje, comportamento do cookie preservado.
 *  (2) scripts/clarice-dashboard-precompute.ts (`runPrecompute`): sucesso,
 *      status não-200, erro de rede — tudo via fetchFn mockado, sem rede real.
 *
 * Fixtures 100% sintéticas — nenhum id/email real.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import worker, { isAuthenticated } from "../workers/brevo-dashboard/src/index.ts";
import { runPrecompute, DASHBOARD_URL } from "../scripts/clarice-dashboard-precompute.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).caches = {
  default: {
    match: async (_req: unknown) => null,
    put: async (_req: unknown, _res: unknown) => {},
  },
};

const TOKEN = "precompute-test-token-abc123";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let origFetch: any;
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

describe("isAuthenticated — Authorization: Bearer (#5217)", () => {
  it("Bearer com o AUTH_TOKEN correto → true (equivalente ao cookie)", async () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/", { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.ok(await isAuthenticated(req, env), "Bearer correto deve autenticar igual ao cookie");
  });

  it("Bearer com token errado → false", async () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/", { headers: { Authorization: "Bearer wrong-value" } });
    assert.ok(!(await isAuthenticated(req, env)), "Bearer errado nunca autentica");
  });

  it("Authorization ausente, sem cookie → false (comportamento pré-#5217 preservado)", async () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/");
    assert.ok(!(await isAuthenticated(req, env)));
  });

  it("sem AUTH_TOKEN configurado, MESMO com Bearer → false (fail-closed, mesmo princípio do #2748)", async () => {
    const env = makeEnv(); // sem auth
    const req = new Request("http://localhost/", { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.ok(!(await isAuthenticated(req, env)), "sem AUTH_TOKEN configurado, nenhum Bearer autentica");
  });

  it("header Authorization malformado (sem 'Bearer ') → false, não lança", async () => {
    const env = makeEnv({ auth: TOKEN });
    const req = new Request("http://localhost/", { headers: { Authorization: TOKEN } });
    await assert.doesNotReject(() => isAuthenticated(req, env));
    assert.ok(!(await isAuthenticated(req, env)));
  });

  it("rota / com Bearer válido: retorna 200 dashboard (mesmo caminho que o cookie humano)", async () => {
    const req = new Request("http://localhost/", { headers: { Authorization: `Bearer ${TOKEN}` } });
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("Clarice News Dashboard"), "Bearer válido deve chegar no dashboard, não na login page");
  });

  it("rota / com Bearer inválido: retorna a login page (401 semanticamente — mesmo comportamento do cookie ausente)", async () => {
    const req = new Request("http://localhost/", { headers: { Authorization: "Bearer nope" } });
    const res = await worker.fetch(req, makeEnv({ auth: TOKEN }));
    const text = await res.text();
    assert.ok(text.includes("<form"), "Bearer inválido deve cair na login page, não expor o dashboard");
  });
});

describe("runPrecompute — scripts/clarice-dashboard-precompute.ts (#5217)", () => {
  it("200 → { ok: true }", async () => {
    let capturedUrl: string | null = null;
    let capturedAuth: string | null = null;
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
      return new Response("<html></html>", { status: 200 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const result = await runPrecompute("tok123", fakeFetch);
    assert.deepEqual(result, { ok: true, status: 200, error: null });
    assert.equal(capturedUrl, `${DASHBOARD_URL}/`, "deve bater na raiz, sem ?fresh=1");
    assert.equal(capturedAuth, "Bearer tok123");
  });

  it("status não-200 → { ok: false, status, error }", async () => {
    const fakeFetch = (async () => new Response("token inválido", { status: 401 })) as unknown as typeof fetch;
    const result = await runPrecompute("bad-token", fakeFetch);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.ok(result.error?.includes("inválido"));
  });

  it("erro de rede (fetch lança) → { ok: false, error } sem propagar a exceção", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await assert.doesNotReject(() => runPrecompute("tok", fakeFetch));
    const result = await runPrecompute("tok", fakeFetch);
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.match(result.error ?? "", /network down/);
  });
});
