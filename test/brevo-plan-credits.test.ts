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
import {
  extractPlanCredits,
  fetchPlanCredits,
  resolvePlanTotal,
  PLAN_CREDITS_KV_KEY,
  LASTGOOD_CAMPAIGNS_KEY,
  billingCycleWindow,
} from "../workers/brevo-dashboard/src/index.ts";
import { withFetchSpy } from "./_helpers/with-fetch-spy.ts";

/** Campanha Clarice mínima, sentDate dentro da janela de cobrança ATUAL
 * (`billingCycleWindow()`, sem argumento — "agora") — usada só pra alimentar
 * `estimateCumulativeSentFromLastGood` (via `LASTGOOD_CAMPAIGNS_KEY`) nos
 * testes de `resolvePlanTotal`. */
function makePlanCreditsCampaign(id: number, sent: number) {
  const window = billingCycleWindow();
  const sentDate = new Date(window.start.getTime() + 24 * 60 * 60 * 1000).toISOString(); // 1 dia após o início
  return {
    id,
    name: "Clarice News 2606-07 — A: assunto teste",
    subject: "Test",
    status: "sent",
    sentDate,
    scheduledAt: null,
    createdAt: sentDate,
    recipients: { lists: [id + 100] },
    statistics: { globalStats: { sent, delivered: sent, hardBounces: 0, softBounces: 0, uniqueViews: 0, viewed: 0, trackableViews: 0, uniqueClicks: 0, clickers: 0, unsubscriptions: 0, complaints: 0, appleMppOpens: 0 } },
  };
}

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

// #3081 (review): variante instrumentada de makeKv que conta chamadas a
// `get()` — usada especificamente pra provar a garantia "no máximo 1 read de
// PLAN_CREDITS_KV_KEY por chamada" (o bug original: mode="cached" com miss +
// fetch ao vivo também falho relia a MESMA chave 2x no fallback final).
function makeCountingKv(initial: { credits?: number } | null = null) {
  const kv = makeKv(initial);
  let getCalls = 0;
  return {
    ...kv,
    get: async (key: string, type?: string) => {
      getCalls++;
      return kv.get(key, type);
    },
    getCallCount: () => getCalls,
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

  // #3081 (review): regressão pro double-KV-read fixado neste PR — mode="cached"
  // com KV miss + fetch ao vivo também falho não pode reler PLAN_CREDITS_KV_KEY
  // uma 2ª vez (nada escreveu nele entre as duas leituras, miss garantido).
  // Testes de retorno (acima) passariam igual com ou sem o bug — só a contagem
  // de chamadas ao KV prova a garantia "no máximo 1 read por chamada".
  it("mode=cached, KV MISS + fetch ao vivo também falha → lê o KV UMA vez só (#3081, regressão double-read)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("erro", { status: 500 })) as unknown as typeof globalThis.fetch;
    try {
      const kv = makeCountingKv(null); // sem cache — miss garantido nas 2 leituras se o bug reaparecer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fetchPlanCredits({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "cached");
      assert.equal(result, null);
      assert.equal(kv.getCallCount(), 1, "deve ler PLAN_CREDITS_KV_KEY no máximo 1x, não 2x (bug original)");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("mode=cached, KV HIT → lê o KV UMA vez só (nunca tenta fetch)", async () => {
    await withFetchSpy(async (calls) => {
      const kv = makeCountingKv({ credits: 33000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fetchPlanCredits({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "cached");
      assert.equal(result, 33000);
      assert.equal(kv.getCallCount(), 1, "1 read (hit) — não deve reler nem tentar fetch");
      assert.deepEqual(calls, []);
    });
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

  // #3081: bug — mode="cached" se comportava IDÊNTICO a "fresh" (sempre buscava
  // ao vivo primeiro, KV só entrava em erro), então nunca honrava o KV como
  // cache de fato — o nome do modo mentia sobre o comportamento. Este teste
  // prova a semântica correta: KV populado → ZERO chamadas de fetch.
  it("mode=cached com KV JÁ populado → NÃO chama fetch (usa o KV como cache de verdade, #3081)", async () => {
    await withFetchSpy(async (calls) => {
      const kv = makeKv({ credits: 33000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fetchPlanCredits({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "cached");
      assert.equal(result, 33000, "deve servir do KV sem tentar fetch ao vivo");
      assert.deepEqual(calls, [], "mode=cached com KV hit não deve chamar a Brevo");
    });
  });

  it("mode=fresh com KV JÁ populado → bypassa o KV e busca ao vivo (comportamento distinto de 'cached', #3081)", async () => {
    const origFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ plan: [{ credits: 41000, creditsType: "sendLimit" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      const kv = makeKv({ credits: 33000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fetchPlanCredits({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "fresh");
      assert.equal(result, 41000, "fresh deve preferir o valor ao vivo, não o KV");
      assert.ok(called, "fresh deve chamar fetch mesmo com KV populado");
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

// ---------------------------------------------------------------------------
// resolvePlanTotal (#6394) — substituto de fetchPlanCredits pra quem alimenta
// renderVolumeSection: entrega o TOTAL do ciclo já snapshot-consistente (par
// {credits, sentAtFetch, planTotal} gravado no MESMO instante), nunca mais o
// restante cru recombinado com um cumulativeSent de outro instante.
// ---------------------------------------------------------------------------

describe("resolvePlanTotal (#6394)", () => {
  // Teste de regressão OBRIGATÓRIO, especificado no corpo da issue #6394:
  // dado um planCredits de snapshot ANTIGO + um cumulativeSent ATUAL maior, o
  // denominador exibido NÃO pode crescer — precisa continuar servindo o
  // planTotal congelado do snapshot, não recombinar.
  it("#6394 regressão: snapshot antigo + cumulativeSent atual maior → denominador NÃO cresce", async () => {
    await withFetchSpy(async (calls) => {
      const kv = makeKv();
      // Snapshot ANTIGO consistente: 150.000 é o total real do plano (batia
      // exatamente com o caso ao vivo relatado na issue).
      await kv.put(
        PLAN_CREDITS_KV_KEY,
        JSON.stringify({ credits: 38119, sentAtFetch: 111881, planTotal: 150000, fetchedAt: "2026-08-25T10:00:00Z" }),
      );
      // `cumulativeSent` ATUAL (via LASTGOOD_CAMPAIGNS_KEY) é MAIOR que o
      // `sentAtFetch` gravado no snapshot — simula os envios de 26/08 que
      // infladavam o denominador pra 162.010 no bug original.
      await kv.put(
        LASTGOOD_CAMPAIGNS_KEY,
        JSON.stringify({ campaigns: [makePlanCreditsCampaign(1, 123891)] }),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await resolvePlanTotal({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "cached");
      assert.equal(result, 150000, "denominador deve ficar CONGELADO no planTotal do snapshot, nunca recombinar com o cumulativeSent atual");
      assert.deepEqual(calls, [], "KV HIT nunca deve chamar a Brevo");
    });
  });

  it("mode=cached com KV HIT (formato novo) → serve planTotal direto, sem fetch", async () => {
    await withFetchSpy(async (calls) => {
      const kv = makeKv();
      await kv.put(
        PLAN_CREDITS_KV_KEY,
        JSON.stringify({ credits: 20000, sentAtFetch: 20000, planTotal: 40000, fetchedAt: "2026-08-01T00:00:00Z" }),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await resolvePlanTotal({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "cached");
      assert.equal(result, 40000);
      assert.deepEqual(calls, []);
    });
  });

  it("mode=kv-only → serve planTotal do snapshot direto, nunca chama fetch", async () => {
    await withFetchSpy(async (calls) => {
      const kv = makeKv();
      await kv.put(
        PLAN_CREDITS_KV_KEY,
        JSON.stringify({ credits: 5000, sentAtFetch: 45000, planTotal: 50000, fetchedAt: "2026-08-01T00:00:00Z" }),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await resolvePlanTotal({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "kv-only");
      assert.equal(result, 50000);
      assert.deepEqual(calls, []);
    });
  });

  it("KV MISS + fetch ao vivo com sucesso → grava o par consistente e retorna credits+estimativa", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ plan: [{ credits: 10000, creditsType: "sendLimit" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    try {
      const kv = makeKv();
      await kv.put(LASTGOOD_CAMPAIGNS_KEY, JSON.stringify({ campaigns: [makePlanCreditsCampaign(1, 5000)] }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await resolvePlanTotal({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "cached");
      assert.equal(result, 15000, "credits (10000) + estimativa de cumulativeSent (5000)");
      const cached = JSON.parse(kv._store.get(PLAN_CREDITS_KV_KEY)!);
      assert.equal(cached.credits, 10000);
      assert.equal(cached.sentAtFetch, 5000);
      assert.equal(cached.planTotal, 15000, "grava o par JÁ consistente, não só credits");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("entrada legada sem planTotal ({credits, fetchedAt}) → degrada pro cálculo antigo (nunca pior que antes)", async () => {
    await withFetchSpy(async (calls) => {
      const kv = makeKv({ credits: 30000 }); // formato pré-#6394, escrito por fetchPlanCredits
      await kv.put(LASTGOOD_CAMPAIGNS_KEY, JSON.stringify({ campaigns: [makePlanCreditsCampaign(1, 10000)] }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await resolvePlanTotal({ BREVO_API_KEY: "k", STATS_CACHE: kv as any }, "cached");
      assert.equal(result, 40000, "sem planTotal gravado, cai pro credits+estimativa (mesmo comportamento de antes da correção)");
      assert.deepEqual(calls, []);
    });
  });

  it("sem cache e sem fetch (STATS_CACHE ausente) → null, nunca lança", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolvePlanTotal({ BREVO_API_KEY: "k", STATS_CACHE: undefined as any }, "kv-only");
    assert.equal(result, null);
  });
});
