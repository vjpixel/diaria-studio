/**
 * test/brevo-plan-credits.test.ts (#2910)
 *
 * Cobre `extractPlanCredits` (parse puro da resposta `/v3/account`) e
 * `fetchPlanCredits` (fetch ao vivo + cache KV + fallback pro último valor
 * bom conhecido) — o denominador DINÂMICO da seção "Volume enviado no
 * ciclo", substituindo o `CLARICE_PLAN_TOTAL=40_000` hardcoded (bug do
 * #2910: a seção nunca refletia créditos reais do mês).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPlanCredits, fetchPlanCredits, PLAN_CREDITS_KV_KEY } from "../workers/brevo-dashboard/src/index.ts";
import { withFetchSpy } from "./_helpers/with-fetch-spy.ts";

// ---------------------------------------------------------------------------
// extractPlanCredits — pura, sem I/O
// ---------------------------------------------------------------------------

describe("extractPlanCredits (#2910)", () => {
  it("prioriza a entrada creditsType='sendLimit' (plano de assinatura mensal)", () => {
    const credits = extractPlanCredits({
      plan: [{ type: "premium", credits: 55000, creditsType: "sendLimit" }],
    });
    assert.equal(credits, 55000);
  });

  it("com múltiplas entradas, escolhe a sendLimit mesmo se não for a primeira", () => {
    const credits = extractPlanCredits({
      plan: [
        { type: "addon", credits: 1000, creditsType: "credits" },
        { type: "premium", credits: 55000, creditsType: "sendLimit" },
      ],
    });
    assert.equal(credits, 55000);
  });

  it("sem entrada sendLimit, cai pro primeiro item com credits numérico (plano pay-as-you-go)", () => {
    const credits = extractPlanCredits({ plan: [{ type: "payg", credits: 12000 }] });
    assert.equal(credits, 12000);
  });

  it("plan ausente → null", () => {
    assert.equal(extractPlanCredits({}), null);
    assert.equal(extractPlanCredits(null), null);
    assert.equal(extractPlanCredits(undefined), null);
  });

  it("plan vazio → null", () => {
    assert.equal(extractPlanCredits({ plan: [] }), null);
  });

  it("plan com credits não-numérico em todas as entradas → null (nunca inventa número)", () => {
    assert.equal(extractPlanCredits({ plan: [{ type: "x" }] }), null);
  });
});

// ---------------------------------------------------------------------------
// fetchPlanCredits — fetch ao vivo + cache KV + fallback (mesmo padrão de
// getCouponUsage/LASTGOOD_CAMPAIGNS_KEY)
// ---------------------------------------------------------------------------

function makeKv(initial: { credits?: number } | null = null) {
  const store = new Map<string, string>();
  if (initial) store.set(PLAN_CREDITS_KV_KEY, JSON.stringify(initial));
  return {
    get: async (key: string, type?: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    _store: store,
  };
}

describe("fetchPlanCredits (#2910)", () => {
  it("fetch ao vivo com sucesso → retorna créditos E grava no KV (cache 24h)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ plan: [{ credits: 40000, creditsType: "sendLimit" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    try {
      const kv = makeKv();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fetchPlanCredits({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "cached");
      assert.equal(result, 40000);
      const cached = JSON.parse(kv._store.get(PLAN_CREDITS_KV_KEY)!);
      assert.equal(cached.credits, 40000, "grava no KV pra servir de fallback depois");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("chama o endpoint /v3/account (regressão: sem o /v3 a Brevo dá 404 e o denominador some)", async () => {
    const origFetch = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ plan: [{ credits: 34708, creditsType: "sendLimit" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      const kv = makeKv();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fetchPlanCredits({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "cached");
      assert.equal(result, 34708);
      // brevoFetch NÃO prefixa /v3 — o path precisa incluí-lo. `/account` (sem /v3)
      // retorna 404 e o plano cai pra "indisponível" (bug que fez #2910 nunca funcionar).
      assert.equal(
        calledUrl,
        "https://api.brevo.com/v3/account",
        "deve bater /v3/account, nunca /account",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("fetch ao vivo falha (rede/429/500) → cai pro último valor bom no KV", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("erro", { status: 500 })) as unknown as typeof globalThis.fetch;
    try {
      const kv = makeKv({ credits: 35000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fetchPlanCredits({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "cached");
      assert.equal(result, 35000, "degrada pro último valor bom conhecido");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("fetch falha E sem KV/cache → null (nunca inventa 40k)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("erro", { status: 500 })) as unknown as typeof globalThis.fetch;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fetchPlanCredits({ BREVO_API_KEY: "k", STATS_CACHE: undefined as any }, "cached");
      assert.equal(result, null);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("mode=kv-only → NUNCA chama fetch (caminho de fallback de 429 do Brevo, #2733/#2779)", async () => {
    await withFetchSpy(async (calls) => {
      const kv = makeKv({ credits: 22000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fetchPlanCredits({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "kv-only");
      assert.equal(result, 22000, "kv-only serve o último valor bom sem fetch");
      assert.deepEqual(calls, [], "nenhuma chamada externa em mode=kv-only");
    });
  });

  it("mode=kv-only sem cache → null, sem fetch", async () => {
    await withFetchSpy(async (calls) => {
      const kv = makeKv(null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fetchPlanCredits({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "kv-only");
      assert.equal(result, null);
      assert.deepEqual(calls, []);
    });
  });
});
