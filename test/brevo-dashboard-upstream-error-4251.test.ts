/**
 * test/brevo-dashboard-upstream-error-4251.test.ts (#4251)
 *
 * Regressão: incidente 260728 -- `GET /api/campaigns` (e a rota `/`) devolvia
 * um 502/503 cru quando a Brevo respondia 403 (token-manager.brevo.com fora
 * do ar) ou qualquer 5xx. O #2280/#2733 já ensinaram o dashboard a servir o
 * último dado bom (stale, com banner) quando a Brevo devolve 429 -- este
 * fix estende o MESMO caminho para 403/5xx (item 3 da issue; itens 1-2 eram
 * investigação de credencial, fechados pelo editor -- não fazem parte deste
 * escopo).
 *
 * Critério de aceite (do dispatch):
 *  - upstream 403 → serve último estado bom, com aviso de defasagem.
 *  - upstream 5xx → idem.
 *  - sem último estado bom em cache → erro explícito, nunca página em branco
 *    nem dado inventado.
 *
 * Fixtures 100% sintéticas -- nenhum id/email real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  brevoFetch,
  BrevoUpstreamError,
  isBrevoOutageStatus,
  injectUpstreamErrorBanner,
  buildUpstreamErrorStaleResponse,
  upstreamErrorResponse,
  buildUpstreamErrorFallback,
  buildUpstreamErrorCampaignsJsonFallback,
  LASTGOOD_CAMPAIGNS_KEY,
} from "../workers/brevo-dashboard/src/index.ts";
import { withFetchSpy } from "./_helpers/with-fetch-spy.ts";

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string, type?: string) => {
      const val = store.get(key);
      if (val == null) return null;
      return type === "json" ? JSON.parse(val) : val;
    },
    put: async (key: string, value: string) => { store.set(key, value); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

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

// ─── isBrevoOutageStatus ─────────────────────────────────────────────────────

describe("isBrevoOutageStatus (#4251)", () => {
  it("403 → true (incidente 260728: token-manager fora do ar, Brevo recusa auth)", () => {
    assert.strictEqual(isBrevoOutageStatus(403), true);
  });

  it("500/502/503/599 → true (qualquer 5xx)", () => {
    for (const s of [500, 502, 503, 599]) assert.strictEqual(isBrevoOutageStatus(s), true, `status ${s}`);
  });

  it("400/401/404 → false (bug nosso, não indisponibilidade externa — não mascarar)", () => {
    for (const s of [400, 401, 404]) assert.strictEqual(isBrevoOutageStatus(s), false, `status ${s}`);
  });

  it("429 → false (tem seu próprio caminho de fallback, BrevoRateLimitError)", () => {
    assert.strictEqual(isBrevoOutageStatus(429), false);
  });
});

// ─── brevoFetch lança BrevoUpstreamError com o status certo ─────────────────

describe("brevoFetch (#4251) — 403/5xx viram BrevoUpstreamError com status", () => {
  it("403 → BrevoUpstreamError{status: 403}", async () => {
    const realFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (async () => ({
      status: 403,
      ok: false,
      headers: new Headers(),
      text: async () => "perform validation: fetch public keys: HTTP 523",
    })) as any;
    try {
      await assert.rejects(
        () => brevoFetch("/v3/emailCampaigns?status=sent&limit=6&sort=desc", { BREVO_API_KEY: "t" } as any),
        (e: unknown) => {
          assert.ok(e instanceof BrevoUpstreamError, "deve ser BrevoUpstreamError");
          assert.strictEqual((e as BrevoUpstreamError).status, 403);
          return true;
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("500 → BrevoUpstreamError{status: 500}", async () => {
    const realFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (async () => ({
      status: 500,
      ok: false,
      headers: new Headers(),
      text: async () => "internal server error",
    })) as any;
    try {
      await assert.rejects(
        () => brevoFetch("/v3/account", { BREVO_API_KEY: "t" } as any),
        (e: unknown) => {
          assert.ok(e instanceof BrevoUpstreamError);
          assert.strictEqual((e as BrevoUpstreamError).status, 500);
          return true;
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("429 continua lançando BrevoRateLimitError, não BrevoUpstreamError (caminho preexistente intacto)", async () => {
    const realFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (async () => ({
      status: 429,
      ok: false,
      headers: new Headers({ "retry-after": "5" }),
      text: async () => "",
    })) as any;
    try {
      await assert.rejects(
        () => brevoFetch("/v3/emailCampaigns?status=sent", { BREVO_API_KEY: "t" } as any),
        (e: unknown) => {
          assert.strictEqual(e instanceof BrevoUpstreamError, false, "429 não deve virar BrevoUpstreamError");
          return true;
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ─── injectUpstreamErrorBanner ────────────────────────────────────────────────

describe("injectUpstreamErrorBanner (#4251)", () => {
  it("com generatedAt → inclui 'defasado desde' + o status", () => {
    const html = `<!DOCTYPE html><html><body><h1>Dash</h1></body></html>`;
    const out = injectUpstreamErrorBanner(html, 403, "2026-07-28T12:00:00.000Z");
    assert.ok(out.includes("HTTP 403"), "status presente no banner");
    assert.ok(out.includes("defasado desde"), "aviso de defasagem presente");
    assert.ok(out.includes("<h1>Dash</h1>"), "conteúdo original preservado");
  });

  it("sem generatedAt → sem afirmar um timestamp que não existe", () => {
    const out = injectUpstreamErrorBanner("<body></body>", 500, null);
    assert.ok(out.includes("HTTP 500"));
    assert.ok(!out.includes("defasado desde"), "sem generatedAt, não inventa timestamp");
  });

  it("sem <body> → prepend (nunca perde conteúdo)", () => {
    const out = injectUpstreamErrorBanner("<div>conteudo</div>", 403, null);
    assert.ok(out.startsWith("<div style="));
    assert.ok(out.includes("<div>conteudo</div>"));
  });
});

// ─── buildUpstreamErrorStaleResponse / upstreamErrorResponse ────────────────

describe("buildUpstreamErrorStaleResponse (#4251)", () => {
  it("200 + banner + X-Dashboard-Stale: upstream-error (nunca 5xx quando há stale)", async () => {
    const html = `<!DOCTYPE html><html><body><h1>D</h1></body></html>`;
    const resp = buildUpstreamErrorStaleResponse(html, 403, "2026-07-28T12:00:00.000Z");
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(resp.headers.get("X-Dashboard-Stale"), "upstream-error");
    assert.strictEqual(resp.headers.get("Cache-Control"), "no-store");
    const body = await resp.text();
    assert.ok(body.includes("<h1>D</h1>") && body.includes("HTTP 403"));
  });
});

describe("upstreamErrorResponse (#4251) — erro explícito quando não há stale", () => {
  it("HTML: 503 + mensagem honesta (não inventa dado)", async () => {
    const resp = upstreamErrorResponse(403, true);
    assert.strictEqual(resp.status, 503);
    const body = await resp.text();
    assert.ok(body.includes("403"));
    assert.ok(body.includes("não há nenhum dado recente"));
  });

  it("JSON: 503 + shape estruturado", async () => {
    const resp = upstreamErrorResponse(500, false);
    assert.strictEqual(resp.status, 503);
    const body = await resp.json();
    assert.deepEqual(body, { error: "brevo_upstream_error", status: 500 });
  });
});

// ─── buildUpstreamErrorFallback (rota `/`) — o caminho ponta-a-ponta ────────

describe("buildUpstreamErrorFallback (#4251) — HTML: serve o último dado bom com aviso de defasagem", () => {
  it("403 com stale em cache → 200, banner com defasagem, abas KV frescas", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleCampaign],
        scheduled: [],
        generatedAt: "2026-07-28T10:00:00.000Z",
        campaignsLimit: 100,
      }),
    });
    const env = { COUPONS_TAB_ENABLED: "false", STATS_CACHE: kv };
    await withFetchSpy(async (externalCalls) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await buildUpstreamErrorFallback(env as any, 403);
      assert.strictEqual(resp.status, 200, "fallback é 200 (stale), não 503");
      assert.strictEqual(resp.headers.get("X-Dashboard-Stale"), "upstream-error");
      const body = await resp.text();
      assert.ok(body.includes("HTTP 403"), "banner nomeia o status real");
      assert.ok(body.includes("defasado desde"), "aviso de defasagem presente");
      assert.ok(body.includes(staleCampaign.name.slice(0, 10)) || body.length > 0, "render não vazio");
      assert.deepEqual(externalCalls, [], "caminho de erro nunca faz chamada externa (kv-only)");
    });
  });

  it("5xx com stale em cache → mesmo caminho (200, banner)", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleCampaign],
        scheduled: [],
        generatedAt: "2026-07-28T10:00:00.000Z",
      }),
    });
    const env = { COUPONS_TAB_ENABLED: "false", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildUpstreamErrorFallback(env as any, 502);
    assert.strictEqual(resp.status, 200);
    const body = await resp.text();
    assert.ok(body.includes("HTTP 502"));
  });

  it("STATS_CACHE ausente → 503 explícito (nunca página em branco)", async () => {
    const env = { COUPONS_TAB_ENABLED: "false", STATS_CACHE: undefined };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildUpstreamErrorFallback(env as any, 403);
    assert.strictEqual(resp.status, 503);
    const body = await resp.text();
    assert.ok(body.includes("403"));
  });

  it("STATS_CACHE presente mas sem nenhum último dado bom gravado → 503 explícito, não dado inventado", async () => {
    const kv = makeKv({}); // KV vazio — nunca gravou dash:lastgood:campaigns
    const env = { COUPONS_TAB_ENABLED: "false", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildUpstreamErrorFallback(env as any, 500);
    assert.strictEqual(resp.status, 503, "sem last-good, o critério do #4251 exige erro explícito");
    const body = await resp.text();
    assert.ok(body.includes("500"));
  });

  it("KV corrompido (campaigns não-array) → nunca lança, degrada graciosamente", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({ campaigns: "corrompido", scheduled: 0, generatedAt: "2026-07-28T10:00:00.000Z" }),
    });
    const env = { COUPONS_TAB_ENABLED: "false", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assert.doesNotReject(() => buildUpstreamErrorFallback(env as any, 403));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildUpstreamErrorFallback(env as any, 403);
    assert.ok(resp.status === 200 || resp.status === 503, "degrada graciosamente");
  });
});

// ─── buildUpstreamErrorCampaignsJsonFallback (rota `/api/campaigns`) ────────
//
// Este é o caminho que o incidente real (260728) exercitou -- o sintoma
// original foi um 403 direto em `GET /api/campaigns`, consumido por
// automação (CLAUDE.md #1172: lookup da próxima wave Clarice).

describe("buildUpstreamErrorCampaignsJsonFallback (#4251) — /api/campaigns", () => {
  it("403 com stale em cache → array cru de campanhas + headers de defasagem (shape preservado p/ automação)", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleCampaign],
        generatedAt: "2026-07-28T10:00:00.000Z",
      }),
    });
    const resp = await buildUpstreamErrorCampaignsJsonFallback({ STATS_CACHE: kv }, 5, 403);
    assert.ok(resp, "deve servir o fallback, não null");
    assert.strictEqual(resp!.headers.get("X-Dashboard-Stale"), "upstream-error");
    assert.strictEqual(resp!.headers.get("X-Dashboard-Upstream-Status"), "403");
    assert.strictEqual(resp!.headers.get("X-Dashboard-Stale-Since"), "2026-07-28T10:00:00.000Z");
    const body = await resp!.json();
    assert.ok(Array.isArray(body), "corpo continua um ARRAY cru — automação espera CampaignRow[] direto, não um wrapper");
    assert.strictEqual(body[0].id, staleCampaign.id);
  });

  it("sem stale em cache → null (caller degrada pro 503 explícito)", async () => {
    const kv = makeKv({});
    const resp = await buildUpstreamErrorCampaignsJsonFallback({ STATS_CACHE: kv }, 5, 403);
    assert.strictEqual(resp, null);
  });

  it("STATS_CACHE ausente → null", async () => {
    const resp = await buildUpstreamErrorCampaignsJsonFallback({ STATS_CACHE: undefined }, 5, 500);
    assert.strictEqual(resp, null);
  });

  it("limit respeitado (slice)", async () => {
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleCampaign, { ...staleCampaign, id: 901 }, { ...staleCampaign, id: 902 }],
      }),
    });
    const resp = await buildUpstreamErrorCampaignsJsonFallback({ STATS_CACHE: kv }, 2, 403);
    const body = await resp!.json();
    assert.strictEqual(body.length, 2);
  });
});
