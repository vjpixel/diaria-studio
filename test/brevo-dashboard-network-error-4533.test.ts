/**
 * test/brevo-dashboard-network-error-4533.test.ts (#4533)
 *
 * Regressão: `GET /api/campaigns` (consumida tanto pelo dashboard humano
 * quanto por guards determinísticos de automação -- `scripts/clarice-check-semaphore.ts`,
 * guard D4 de `/diaria-clarice-novos`) devolvia 502 genérico em ~90% das
 * chamadas numa janela em que `curl` direto pra `api.brevo.com` respondia 200
 * consistentemente. Hipótese mais provável (a issue #4533 é explícita: "não
 * reproduzido em ambiente de teste" -- o log adicionado por este PR é
 * justamente o que confirmaria isso em produção): `buildCampaignsResponse`
 * (index.ts) só tenta o fallback stale (`buildUpstreamErrorCampaignsJsonFallback`,
 * #4251) para `BrevoRateLimitError`/`BrevoUpstreamError` com
 * `isBrevoOutageStatus` (403/5xx estruturado) -- um erro de rede/timeout CRU
 * do `fetch()` nativo pra Brevo (TypeError/AbortError, sem `.status` HTTP
 * porque nenhuma Response chegou a existir) caía direto no 502 genérico,
 * mesmo com um stale bom disponível no KV.
 *
 * Critério de aceite (do dispatch, "Sugestão de investigação" itens 1-2 da
 * issue): logar o erro cru antes de decidir 502 vs. fallback; se for erro de
 * rede/timeout, tratar como equivalente a outage (mesmo fallback stale que
 * 403/5xx estruturado já usa).
 *
 * Fix: `isNetworkOrTimeoutError` (brevo-api.ts) reconhece essa classe de erro
 * e a rota do catch de `buildCampaignsResponse` passa a tentar o MESMO
 * fallback stale nesse caso -- estritamente aditivo, o caminho 403/5xx
 * estruturado (#4251) e o 502 genérico sem stale disponível (fail-honesto)
 * continuam intactos.
 *
 * Fixtures 100% sintéticas -- nenhum id/email real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, {
  isNetworkOrTimeoutError,
  buildUpstreamErrorCampaignsJsonFallback,
  LASTGOOD_CAMPAIGNS_KEY,
} from "../workers/brevo-dashboard/src/index.ts";

// Cache API -- mesmo polyfill das outras suítes de brevo-dashboard: sempre
// cache-miss, força o caminho de live-fetch em toda chamada.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).caches = {
  default: {
    match: async (_req: unknown) => null,
    put: async (_req: unknown, _res: unknown) => {},
  },
};

const staleCampaign = {
  id: 900,
  name: "Clarice 2607 grupo:envio12",
  subject: "Assunto sintético",
  status: "sent",
  sentDate: "2026-07-27T09:00:00Z",
  scheduledAt: null,
  createdAt: "2026-07-27T09:00:00Z",
  recipients: { lists: [] as number[] },
};

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string, type?: string) => {
      const val = store.get(key);
      if (val == null) return null;
      return type === "json" ? JSON.parse(val) : val;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ─── isNetworkOrTimeoutError (unidade, pura) ────────────────────────────────

describe("isNetworkOrTimeoutError (#4533)", () => {
  it("TypeError (fetch nativo: falha de conexão/DNS/TLS) → true", () => {
    assert.strictEqual(isNetworkOrTimeoutError(new TypeError("fetch failed")), true);
  });

  it("TypeError com mensagem de runtime CF (\"Network connection lost\") → true", () => {
    assert.strictEqual(isNetworkOrTimeoutError(new TypeError("Network connection lost.")), true);
  });

  it("erro com .name AbortError (timeout via AbortController) → true", () => {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    assert.strictEqual(isNetworkOrTimeoutError(e), true);
  });

  it("erro com .name TimeoutError (AbortSignal.timeout) → true", () => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    assert.strictEqual(isNetworkOrTimeoutError(e), true);
  });

  it("BrevoUpstreamError (tem .status estruturado -- caminho #4251 já cobre) → false", () => {
    class FakeBrevoUpstreamError extends Error {
      status = 500;
      constructor() {
        super("Brevo API failed (500)");
        this.name = "BrevoUpstreamError";
      }
    }
    assert.strictEqual(isNetworkOrTimeoutError(new FakeBrevoUpstreamError()), false);
  });

  it("Error genérico (ex: bug de render, SyntaxError de JSON malformado) → false", () => {
    assert.strictEqual(isNetworkOrTimeoutError(new Error("qualquer outra coisa")), false);
    assert.strictEqual(isNetworkOrTimeoutError(new SyntaxError("Unexpected token")), false);
  });

  // Achado CRITICAL do fleet review pré-merge (PR #4540): a versão original
  // deste guard casava QUALQUER `TypeError`, independente da mensagem --
  // mascararia bugs de programação sem relação com rede (ex: acesso a
  // propriedade de `null`/`undefined`, `Response.json()` chamado 2x) como
  // "erro de rede", servindo o stale silenciosamente (200, zero log). Este
  // teste documenta o comportamento CORRETO pós-fix: só `TypeError` com
  // mensagem batendo um padrão conhecido de falha de rede conta.
  it("TypeError com mensagem NÃO relacionada a rede (bug de programação) → false", () => {
    assert.strictEqual(
      isNetworkOrTimeoutError(new TypeError("Cannot read properties of undefined (reading 'x')")),
      false,
    );
    assert.strictEqual(
      isNetworkOrTimeoutError(new TypeError("Body has already been used")),
      false,
    );
  });

  it("valor não-Error (string, undefined, objeto cru) → false", () => {
    assert.strictEqual(isNetworkOrTimeoutError("string crua"), false);
    assert.strictEqual(isNetworkOrTimeoutError(undefined), false);
    assert.strictEqual(isNetworkOrTimeoutError({ message: "fake" }), false);
  });
});

// ─── buildUpstreamErrorCampaignsJsonFallback com status "network_error" ────

describe("buildUpstreamErrorCampaignsJsonFallback (#4533) — status literal network_error", () => {
  it("com stale em cache → array cru + X-Dashboard-Upstream-Status: network_error", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleCampaign],
        generatedAt: "2026-08-03T10:00:00.000Z",
      }),
    });
    const resp = await buildUpstreamErrorCampaignsJsonFallback({ STATS_CACHE: kv }, 5, "network_error");
    assert.ok(resp, "deve servir o fallback, não null");
    assert.strictEqual(resp!.status, 200, "fallback stale é 200, não 5xx");
    assert.strictEqual(resp!.headers.get("X-Dashboard-Stale"), "upstream-error");
    assert.strictEqual(
      resp!.headers.get("X-Dashboard-Upstream-Status"),
      "network_error",
      "header deve nomear a causa real (erro de rede), não inventar um status HTTP",
    );
    const body = await resp!.json();
    assert.ok(Array.isArray(body), "corpo continua um ARRAY cru — automação espera CampaignRow[] direto");
    assert.strictEqual(body[0].id, staleCampaign.id);
  });

  it("sem stale em cache → null (caller degrada pro 502 genérico)", async () => {
    const kv = makeKv({});
    const resp = await buildUpstreamErrorCampaignsJsonFallback({ STATS_CACHE: kv }, 5, "network_error");
    assert.strictEqual(resp, null);
  });
});

// ─── GET /api/campaigns fim-a-fim — o caminho real que o incidente exercitou ─

describe("GET /api/campaigns — erro de rede cru do fetch (#4533)", () => {
  it("fetch() rejeita com TypeError + stale bom no KV → 200 com dado stale, NUNCA 502", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleCampaign],
        generatedAt: "2026-08-03T10:00:00.000Z",
      }),
    });
    const origFetch = globalThis.fetch;
    // Simula exatamente o sintoma do #4533: fetch() pra api.brevo.com rejeita
    // com um erro de rede cru (sem Response, sem .status) -- não um 403/5xx.
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      const req = new Request("http://localhost/api/campaigns?limit=5");
      const res = await worker.fetch(req, { BREVO_API_KEY: "k", STATS_CACHE: kv });
      assert.strictEqual(res.status, 200, "deve servir o stale, não o 502 genérico pré-fix");
      assert.strictEqual(res.headers.get("X-Dashboard-Stale"), "upstream-error");
      assert.strictEqual(res.headers.get("X-Dashboard-Upstream-Status"), "network_error");
      const body = (await res.json()) as Array<{ id: number }>;
      assert.ok(Array.isArray(body), "shape preservado -- automação (clarice-check-semaphore.ts) espera array cru");
      assert.strictEqual(body[0]?.id, staleCampaign.id);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("fetch() rejeita com TypeError + SEM stale no KV → 502 genérico continua (fail-honesto, sem dado bom pra servir)", async () => {
    const kv = makeKv({}); // KV vazio -- nunca gravou dash:lastgood:campaigns
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      const req = new Request("http://localhost/api/campaigns?limit=5");
      const res = await worker.fetch(req, { BREVO_API_KEY: "k", STATS_CACHE: kv });
      assert.strictEqual(res.status, 502, "sem stale disponível, o 502 honesto continua sendo o comportamento correto");
      const text = await res.text();
      assert.ok(text.includes("fetch failed"), "corpo do 502 deve conter a mensagem do erro cru");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("caminho 403/5xx estruturado (#4251) continua intacto -- não regressado por este fix", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleCampaign],
        generatedAt: "2026-08-03T10:00:00.000Z",
      }),
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 403,
      ok: false,
      headers: new Headers(),
      text: async () => "perform validation: fetch public keys: HTTP 523",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    try {
      const req = new Request("http://localhost/api/campaigns?limit=5");
      const res = await worker.fetch(req, { BREVO_API_KEY: "k", STATS_CACHE: kv });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        res.headers.get("X-Dashboard-Upstream-Status"),
        "403",
        "403 estruturado continua nomeando o status HTTP real, não o literal network_error",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
