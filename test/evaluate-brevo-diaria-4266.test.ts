/**
 * test/evaluate-brevo-diaria-4266.test.ts (#4266, reescrito no #4476 —
 * fórmula por taxa de abertura + descadastro nativo como 3ª saída terminal)
 *
 * Avaliação periódica dos contatos in_brevo: contadores + emailBlacklisted a
 * partir de UMA leitura só do estado da Brevo, veredito puro (taxa de
 * abertura + threshold), a checagem de auto-confirmação Beehiiv que fecha o
 * gap de duplicidade registrado na própria issue #4266, e a checagem de
 * descadastro nativo (#4476 item 7) que roda ANTES de tudo isso.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCountsFromBrevoStatistics,
  computeMatureCountsFromBrevoStatistics,
  hasUserUnsubscription,
  evaluateContact,
  fetchBrevoContactState,
  fetchBeehiivSubscriptionStatus,
  verifyPromotedToBeehiiv,
  verifySuppressedInBrevo,
  suppressInBrevo,
  unlinkFromBrevoList,
  promoteBeehiivSubscription,
  unsubscribeInBeehiiv,
  verifyUnsubscribedInBeehiiv,
  PROMOTION_VERIFY_RETRY_DELAY_MS,
  runEvaluation,
} from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";
import { BREVO_DIARIA_PROMOCAO_SCORE_UTM } from "../scripts/lib/shared/utm-registry.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fixture — contato `in_brevo` mínimo, com overrides pontuais por teste. */
function contact(email: string, overrides: Partial<BrevoDiariaContact> = {}): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: `sub_${email}`,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-07-01T00:00:00.000Z",
    last_evaluated_at: null,
    ...overrides,
  };
}

// ── fixtures de timestamp — janela de maturação de 48h (#4476) ─────────────

const HOUR_MS = 60 * 60 * 1000;
/** Timestamp ISO `hoursAgo` horas atrás de "agora" (real, `Date.now()`). */
function hoursAgoIso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * HOUR_MS).toISOString();
}
/** Evento `messagesSent`/`opened` MADURO (bem acima de 48h — 72h, margem
 * confortável contra timing flake). */
function matureEvent(campaignId: number) {
  return { campaignId, date: hoursAgoIso(72) };
}
/** Evento `messagesSent`/`opened` IMATURO (1h atrás — bem abaixo de 48h). */
function freshEvent(campaignId: number) {
  return { campaignId, date: hoursAgoIso(1) };
}

describe("computeCountsFromBrevoStatistics — dedup por campaignId (#4266)", () => {
  it("statistics ausente → 0/0", () => {
    assert.deepEqual(computeCountsFromBrevoStatistics(undefined), { sends_count: 0, opens_count: 0 });
  });

  it("conta campanhas ÚNICAS enviadas/abertas, não eventos brutos", () => {
    const stats = {
      messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
      // campanha 1 reaberta 2x — deve contar 1, não 2
      opened: [{ campaignId: 1 }, { campaignId: 1 }, { campaignId: 2 }],
    };
    assert.deepEqual(computeCountsFromBrevoStatistics(stats), { sends_count: 3, opens_count: 2 });
  });

  it("arrays malformados (não-array) → 0", () => {
    assert.deepEqual(
      computeCountsFromBrevoStatistics({ messagesSent: undefined, opened: undefined }),
      { sends_count: 0, opens_count: 0 },
    );
  });
});

describe("evaluateContact — taxa de abertura + threshold combinados, instant/mature (#4476 item 1)", () => {
  it("4 enviados/2 abertos (instant) → openRate 0.5 → promote_to_beehiiv (piso de promoção n>=3, revisado 260804)", () => {
    const ev = evaluateContact({ instant: { opens_count: 2, sends_count: 4 }, mature: { opens_count: 2, sends_count: 4 } });
    assert.equal(ev.open_rate, 0.5);
    assert.equal(ev.action, "promote_to_beehiiv");
  });

  it("2 enviados/1 aberto (instant) → openRate 0.5 mas abaixo do piso de amostra (n=2<3) → keep", () => {
    const ev = evaluateContact({ instant: { opens_count: 1, sends_count: 2 }, mature: { opens_count: 1, sends_count: 2 } });
    assert.equal(ev.open_rate, 0.5);
    assert.equal(ev.action, "keep");
  });

  it("5 enviados/1 aberto (mature) → openRate 0.2 → suppress", () => {
    const ev = evaluateContact({ instant: { opens_count: 1, sends_count: 5 }, mature: { opens_count: 1, sends_count: 5 } });
    assert.equal(ev.open_rate, 0.2);
    assert.equal(ev.action, "suppress");
  });

  it("4 enviados/1 aberto (mature) → openRate 25%, piso de amostra atingido (n=4>=3) mas taxa acima do threshold (25%>20%) → keep", () => {
    const ev = evaluateContact({ instant: { opens_count: 1, sends_count: 4 }, mature: { opens_count: 1, sends_count: 4 } });
    assert.equal(ev.action, "keep");
  });

  it("2 enviados maduros/0 abertos → abaixo do piso de amostra de supressão (n<3) → keep, mesmo com openRate=0%", () => {
    const ev = evaluateContact({ instant: { opens_count: 0, sends_count: 2 }, mature: { opens_count: 0, sends_count: 2 } });
    assert.equal(ev.action, "keep");
  });

  it("`open_rate`/`opens_count`/`sends_count` retornados são SEMPRE os instantâneos, mesmo quando mature difere", () => {
    const ev = evaluateContact({ instant: { opens_count: 2, sends_count: 10 }, mature: { opens_count: 0, sends_count: 3 } });
    assert.equal(ev.opens_count, 2, "reporta o instantâneo, não o maduro");
    assert.equal(ev.sends_count, 10, "reporta o instantâneo, não o maduro");
    assert.equal(ev.open_rate, 0.2, "20% instantâneo (2/10)");
    // mature: 0/3 = 0% <= 20%, n=3 >= piso → suprime (o resultado da AÇÃO usa mature, o valor REPORTADO usa instant)
    assert.equal(ev.action, "suppress");
  });
});

describe("computeMatureCountsFromBrevoStatistics — janela de maturação de 48h (#4476, self-review)", () => {
  it("envio maduro (72h) conta; envio imaturo (1h) NÃO conta pra sends_count", () => {
    const stats = { messagesSent: [matureEvent(1), freshEvent(2)], opened: [] };
    assert.deepEqual(computeMatureCountsFromBrevoStatistics(stats), { sends_count: 1, opens_count: 0 });
  });

  it("envio <48h com opens_count=0 NÃO conta pra avaliação de supressão (teste de regressão explícito do achado #4476)", () => {
    // 1 único envio, mandado há 1h, ainda não aberto — se contasse como
    // maduro, entraria como "0/1 = 0%" e (com n>=1... mas piso é 3) não
    // suprimiria sozinho; o ponto do teste é que NENHUM envio recente entra
    // na contagem, então sends_count maduro fica 0, não 1.
    const stats = { messagesSent: [freshEvent(1)], opened: [] };
    const mature = computeMatureCountsFromBrevoStatistics(stats);
    assert.equal(mature.sends_count, 0, "envio de 1h não é maduro — excluído da contagem, não contado como 'não aberto'");
  });

  it("opens_count maduro só conta abertura cujo envio correspondente também é maduro", () => {
    // campanha 2 foi enviada há 1h (imatura) mas "aberta" no mesmo instante
    // (cenário raro, mas a invariante deve segurar): não conta em nenhum dos dois.
    const stats = { messagesSent: [matureEvent(1), freshEvent(2)], opened: [matureEvent(1), freshEvent(2)] };
    assert.deepEqual(computeMatureCountsFromBrevoStatistics(stats), { sends_count: 1, opens_count: 1 });
  });

  it("entrada sem timestamp parseável → tratada como IMATURA (fail-safe), nunca conta", () => {
    const stats = { messagesSent: [{ campaignId: 1 }], opened: [] }; // sem campo de data
    assert.deepEqual(computeMatureCountsFromBrevoStatistics(stats), { sends_count: 0, opens_count: 0 });
  });

  it("statistics ausente → 0/0", () => {
    assert.deepEqual(computeMatureCountsFromBrevoStatistics(undefined), { sends_count: 0, opens_count: 0 });
  });

  it("`nowMs` injetável — envio de exatamente 48h vira maduro (borda inclusiva `>=`)", () => {
    const nowMs = Date.parse("2026-08-10T12:00:00.000Z");
    const sentAt48hAgo = "2026-08-08T12:00:00.000Z"; // exatos 48h antes de nowMs
    const stats = { messagesSent: [{ campaignId: 1, date: sentAt48hAgo }], opened: [] };
    assert.equal(computeMatureCountsFromBrevoStatistics(stats, nowMs).sends_count, 1);
  });

  it("`nowMs` injetável — envio de 47h59min NÃO é maduro (1 minuto abaixo da borda)", () => {
    const nowMs = Date.parse("2026-08-10T12:00:00.000Z");
    const sentAt = "2026-08-08T12:01:00.000Z"; // 47h59min antes de nowMs
    const stats = { messagesSent: [{ campaignId: 1, date: sentAt }], opened: [] };
    assert.equal(computeMatureCountsFromBrevoStatistics(stats, nowMs).sends_count, 0);
  });
});

describe("hasUserUnsubscription — sinal PRIMÁRIO de descadastro genuíno (#4630)", () => {
  it("array userUnsubscription não-vazio → true", () => {
    assert.equal(hasUserUnsubscription({ unsubscriptions: { userUnsubscription: [{ date: "x" }] } }), true);
  });

  it("array userUnsubscription vazio → false", () => {
    assert.equal(hasUserUnsubscription({ unsubscriptions: { userUnsubscription: [] } }), false);
  });

  it("só adminUnsubscription (userUnsubscription ausente) → false — adminUnsubscription isolado nunca é genuíno", () => {
    assert.equal(hasUserUnsubscription({ unsubscriptions: { adminUnsubscription: [{ date: "x" }] } }), false);
  });

  it("unsubscriptions ausente inteiro → false", () => {
    assert.equal(hasUserUnsubscription({}), false);
  });

  it("statistics ausente (undefined) → false", () => {
    assert.equal(hasUserUnsubscription(undefined), false);
  });

  it("userUnsubscription malformado (não-array) → false, fail-safe", () => {
    assert.equal(hasUserUnsubscription({ unsubscriptions: { userUnsubscription: "not-an-array" as unknown as unknown[] } }), false);
  });
});

describe("fetchBrevoContactState — 1 leitura, contadores + emailBlacklisted (#4476 item 7)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("extrai contadores instantâneos, contadores maduros, E emailBlacklisted:false do mesmo body", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, {
        // 1 e 2 maduros (72h), 3 imaturo (1h) — sends_count instantâneo=3, maduro=2
        statistics: { messagesSent: [matureEvent(1), matureEvent(2), freshEvent(3)], opened: [matureEvent(1)] },
      })) as typeof fetch;
    try {
      const state = await fetchBrevoContactState("key", "a@b.com");
      assert.deepEqual(state, {
        sends_count: 3,
        opens_count: 1,
        mature_sends_count: 2,
        mature_opens_count: 1,
        emailBlacklisted: false,
        userUnsubscribed: false, // #4630 — sem statistics.unsubscriptions.userUnsubscription no fixture
      });
    } finally {
      restore();
    }
  });

  it("emailBlacklisted:true no body → refletido no estado", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, { emailBlacklisted: true, statistics: { messagesSent: [], opened: [] } })) as typeof fetch;
    try {
      const state = await fetchBrevoContactState("key", "a@b.com");
      assert.equal(state.emailBlacklisted, true);
    } finally {
      restore();
    }
  });

  it("#4630 — userUnsubscription não-vazio no body → userUnsubscribed:true no estado (sinal PRIMÁRIO de descadastro genuíno)", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, {
        emailBlacklisted: true,
        statistics: {
          messagesSent: [],
          opened: [],
          unsubscriptions: { userUnsubscription: [{ date: "2026-08-01T00:00:00.000Z" }], adminUnsubscription: [] },
        },
      })) as typeof fetch;
    try {
      const state = await fetchBrevoContactState("key", "a@b.com");
      assert.equal(state.userUnsubscribed, true);
    } finally {
      restore();
    }
  });

  it("#4630 — só adminUnsubscription (userUnsubscription vazio/ausente) → userUnsubscribed:false, mesmo com emailBlacklisted:true", async () => {
    globalThis.fetch = (async () =>
      jsonRes(200, {
        emailBlacklisted: true,
        statistics: {
          messagesSent: [],
          opened: [],
          unsubscriptions: { adminUnsubscription: [{ date: "2026-08-01T00:00:00.000Z" }] },
        },
      })) as typeof fetch;
    try {
      const state = await fetchBrevoContactState("key", "a@b.com");
      assert.equal(state.userUnsubscribed, false, "adminUnsubscription isolado NUNCA é sinal genuíno de descadastro (#4630)");
    } finally {
      restore();
    }
  });

  it("404 (contato não encontrado) → lança com mensagem própria (fail loud)", async () => {
    globalThis.fetch = (async () => jsonRes(404, {})) as typeof fetch;
    try {
      await assert.rejects(() => fetchBrevoContactState("key", "a@b.com"), /não foi possível ler estado/);
    } finally {
      restore();
    }
  });

  it("erro HTTP não-404 (ex: 403) → lança (propaga o fail-loud de brevoGet)", async () => {
    globalThis.fetch = (async () => jsonRes(403, {})) as typeof fetch;
    try {
      await assert.rejects(() => fetchBrevoContactState("key", "a@b.com"), /Brevo GET .* falhou \(403\)/);
    } finally {
      restore();
    }
  });
});

describe("fetchBeehiivSubscriptionStatus — auto-confirmação (#4266)", () => {
  it("404 → null (contato não encontrado nessa forma)", async () => {
    const fetchImpl = (async () => jsonRes(404, {})) as typeof fetch;
    const status = await fetchBeehiivSubscriptionStatus("pub_1", "key", "a@b.com", fetchImpl);
    assert.equal(status, null);
  });

  it('status "active" (confirmou por conta própria)', async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "active" } })) as typeof fetch;
    const status = await fetchBeehiivSubscriptionStatus("pub_1", "key", "a@b.com", fetchImpl);
    assert.equal(status, "active");
  });

  it('status "pending" (ainda não confirmou)', async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "pending" } })) as typeof fetch;
    const status = await fetchBeehiivSubscriptionStatus("pub_1", "key", "a@b.com", fetchImpl);
    assert.equal(status, "pending");
  });

  it("!ok não-404 → lança (fail loud)", async () => {
    const fetchImpl = (async () => jsonRes(500, {})) as typeof fetch;
    await assert.rejects(() => fetchBeehiivSubscriptionStatus("pub_1", "key", "a@b.com", fetchImpl), /Beehiiv API 500/);
  });
});

describe("verifyPromotedToBeehiiv — fail-safe se ainda pending (#4266, corrigido pro caso 'invalid' no #4476 item 3)", () => {
  it("status active → true (promoção confirmada)", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "active" } })) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), true);
  });

  it("status ainda pending → false (fail-safe: NÃO confirma promoção)", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "pending" } })) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), false);
  });

  it('status "invalid" → false (#4476 item 3, achado do teste ao vivo: reactivate_existing:true pode retornar 201 mas deixar status="invalid" — NÃO é confirmação, mesmo não sendo "pending")', async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "invalid" } })) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), false);
  });

  it("404 (subscription sumiu) → false", async () => {
    const fetchImpl = (async () => jsonRes(404, {})) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), false);
  });

  it('status "validating" (estado transitório, achado ao vivo 260802) → 1 retry após espera, releitura "active" → true', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonRes(200, { data: { status: calls === 1 ? "validating" : "active" } });
    }) as typeof fetch;
    let sleptMs = -1;
    const sleepImpl = async (ms: number) => {
      sleptMs = ms;
    };
    const result = await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl, sleepImpl);
    assert.equal(result, true);
    assert.equal(calls, 2, "GET inicial + 1 releitura após o retry");
    assert.equal(sleptMs, 2000);
  });

  it('status "validating" → retry, mas releitura AINDA não confirma → false (nunca 2º retry)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonRes(200, { data: { status: "validating" } });
    }) as typeof fetch;
    const result = await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl, async () => {});
    assert.equal(result, false);
    assert.equal(calls, 2, "só 1 retry, nunca fica reesperando indefinidamente");
  });
});

// ── #4398 review: fixes 1-4 (silent-failure-hunter, code-reviewer,
// pr-test-analyzer convergiram nestes pontos) ────────────────────────────

describe("suppressInBrevo / unlinkFromBrevoList / promoteBeehiivSubscription — branches de erro (#4398 item 8)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("suppressInBrevo faz PUT emailBlacklisted:true", async () => {
    let body: unknown;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(init!.body as string);
      return jsonRes(200, {});
    }) as typeof fetch;
    try {
      await suppressInBrevo("key", "a@b.com");
      assert.deepEqual(body, { emailBlacklisted: true });
    } finally {
      restore();
    }
  });

  it("suppressInBrevo lança se a Brevo responder erro (fail loud, nunca silencioso)", async () => {
    globalThis.fetch = (async () => jsonRes(403, { message: "forbidden" })) as typeof fetch;
    try {
      await assert.rejects(() => suppressInBrevo("key", "a@b.com"), /Brevo API PUT/);
    } finally {
      restore();
    }
  });

  it("unlinkFromBrevoList faz PUT unlinkListIds", async () => {
    let body: unknown;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(init!.body as string);
      return jsonRes(200, {});
    }) as typeof fetch;
    try {
      await unlinkFromBrevoList("key", 7, "a@b.com");
      assert.deepEqual(body, { unlinkListIds: [7] });
    } finally {
      restore();
    }
  });

  it("unlinkFromBrevoList lança se a Brevo responder erro", async () => {
    globalThis.fetch = (async () => jsonRes(500, { message: "boom" })) as typeof fetch;
    try {
      await assert.rejects(() => unlinkFromBrevoList("key", 7, "a@b.com"), /Brevo API PUT/);
    } finally {
      restore();
    }
  });

  /** Mock roteado por método — GET (by_email) / DELETE / POST (create), com
   * captura de sequência (#4488 review, pr-test-analyzer: mock antigo só
   * checava status HTTP, não confirmava que o DELETE mira o id CERTO). */
  function routedPromoteFetch(handlers: {
    get?: () => Response | Promise<Response>;
    del?: () => Response | Promise<Response>;
    post?: (body: unknown) => Response | Promise<Response>;
  }): { fetchImpl: typeof fetch; calls: { method: string; url: string }[] } {
    const calls: { method: string; url: string }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url) });
      if (method === "DELETE") return handlers.del ? handlers.del() : new Response(null, { status: 204 });
      if (method === "POST") return handlers.post ? handlers.post(init?.body ? JSON.parse(init.body as string) : undefined) : jsonRes(200, {});
      return handlers.get ? handlers.get() : new Response(null, { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it("promoteBeehiivSubscription: busca o id ATUAL via GET by_email (não confia em id armazenado, #4488 review), deleta e cria sem reactivate_existing", async () => {
    const { fetchImpl, calls } = routedPromoteFetch({
      get: () => jsonRes(200, { data: { id: "sub_atual", status: "pending" } }),
      post: (body) => {
        // #4530: atribuição — utm_source/medium/campaign + referring_site do
        // registry, não mais só {email, send_welcome_email}.
        assert.deepEqual(body, {
          email: "a@b.com",
          send_welcome_email: false,
          utm_source: BREVO_DIARIA_PROMOCAO_SCORE_UTM.source,
          utm_medium: BREVO_DIARIA_PROMOCAO_SCORE_UTM.medium,
          utm_campaign: BREVO_DIARIA_PROMOCAO_SCORE_UTM.campaign,
          referring_site: BREVO_DIARIA_PROMOCAO_SCORE_UTM.referringSite,
        });
        return jsonRes(200, {});
      },
    });
    await promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl);
    assert.deepEqual(calls.map((c) => c.method), ["GET", "DELETE", "POST"]);
    assert.equal(calls[0].url, "https://api.beehiiv.com/v2/publications/pub_1/subscriptions/by_email/a%40b.com");
    assert.equal(
      calls[1].url,
      "https://api.beehiiv.com/v2/publications/pub_1/subscriptions/sub_atual",
      "DELETE mira o id vindo do GET, nunca um id armazenado que pode estar obsoleto",
    );
  });

  it("promoteBeehiivSubscription: GET 404 (nunca existiu, ou já foi deletado por uma tentativa anterior) → pula DELETE, cria direto", async () => {
    let postCalled = false;
    const { fetchImpl, calls } = routedPromoteFetch({
      get: () => new Response(null, { status: 404 }),
      post: () => {
        postCalled = true;
        return jsonRes(200, {});
      },
    });
    await promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl);
    assert.equal(postCalled, true);
    assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
  });

  it("promoteBeehiivSubscription: GET com corpo não-parseável → lança (nunca trata como 'não existe' em silêncio, #4488 review silent-failure-hunter)", async () => {
    const { fetchImpl } = routedPromoteFetch({ get: () => new Response("<html>gateway error</html>", { status: 200 }) });
    await assert.rejects(() => promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl), /corpo não-parseável/);
  });

  it("promoteBeehiivSubscription: GET erro não-404 → lança, nunca chega no DELETE/CREATE", async () => {
    const { fetchImpl, calls } = routedPromoteFetch({ get: () => new Response("boom", { status: 500 }) });
    await assert.rejects(() => promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl), /GET.*by_email.*HTTP 500/);
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  });

  it("promoteBeehiivSubscription: DELETE 404 (registro já sumiu entre o GET e o DELETE) → segue pro CREATE mesmo assim", async () => {
    let postCalled = false;
    const { fetchImpl } = routedPromoteFetch({
      get: () => jsonRes(200, { data: { id: "sub_sumiu", status: "pending" } }),
      del: () => new Response(null, { status: 404 }),
      post: () => {
        postCalled = true;
        return jsonRes(200, {});
      },
    });
    await promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl);
    assert.equal(postCalled, true);
  });

  it("promoteBeehiivSubscription: DELETE falha (não-404) → lança, nunca chega no CREATE", async () => {
    let postCalled = false;
    const { fetchImpl } = routedPromoteFetch({
      get: () => jsonRes(200, { data: { id: "sub_old", status: "pending" } }),
      del: () => new Response("locked", { status: 423 }),
      post: () => {
        postCalled = true;
        return jsonRes(200, {});
      },
    });
    await assert.rejects(
      () => promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl),
      /DELETE.*sub_old.*a@b\.com.*\(HTTP 423\)/,
    );
    assert.equal(postCalled, false);
  });

  it("promoteBeehiivSubscription: CREATE !ok lança com status e email na mensagem", async () => {
    const { fetchImpl } = routedPromoteFetch({
      get: () => jsonRes(200, { data: { id: "sub_old", status: "pending" } }),
      post: () => new Response("conflict", { status: 409 }),
    });
    await assert.rejects(
      () => promoteBeehiivSubscription("pub_1", "key", "a@b.com", fetchImpl),
      /a@b\.com.*\(HTTP 409\)/,
    );
  });
});

describe("unsubscribeInBeehiiv / verifyUnsubscribedInBeehiiv — propagação do descadastro nativo (#4538)", () => {
  it("unsubscribeInBeehiiv faz PUT unsubscribe:true no endpoint by_email (não status, não DELETE)", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    let capturedMethod = "";
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedMethod = init?.method ?? "";
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonRes(200, {});
    }) as typeof fetch;
    await unsubscribeInBeehiiv("pub_1", "key", "a@b.com", fetchImpl);
    assert.equal(capturedMethod, "PUT");
    assert.equal(capturedUrl, "https://api.beehiiv.com/v2/publications/pub_1/subscriptions/by_email/a%40b.com");
    assert.deepEqual(capturedBody, { unsubscribe: true });
  });

  it("unsubscribeInBeehiiv lança se a Beehiiv responder erro (fail loud, nunca silencioso)", async () => {
    const fetchImpl = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    await assert.rejects(() => unsubscribeInBeehiiv("pub_1", "key", "a@b.com", fetchImpl), /PUT subscriptions\/by_email.*unsubscribe:true.*falhou.*403/);
  });

  it('verifyUnsubscribedInBeehiiv: status "inactive" → true (confirmado)', async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "inactive" } })) as typeof fetch;
    assert.equal(await verifyUnsubscribedInBeehiiv("pub_1", "key", "a@b.com", fetchImpl), true);
  });

  it('verifyUnsubscribedInBeehiiv: status ainda "pending" mesmo após o retry → false (2xx no PUT não é garantia — mesma armadilha do endpoint de tags)', async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "pending" } })) as typeof fetch;
    assert.equal(await verifyUnsubscribedInBeehiiv("pub_1", "key", "a@b.com", fetchImpl, async () => {}), false);
  });

  it("verifyUnsubscribedInBeehiiv: 404 (subscription sumiu) mesmo após o retry → false", async () => {
    const fetchImpl = (async () => jsonRes(404, {})) as typeof fetch;
    assert.equal(await verifyUnsubscribedInBeehiiv("pub_1", "key", "a@b.com", fetchImpl, async () => {}), false);
  });

  it('verifyUnsubscribedInBeehiiv: releitura imediata "pending" (eventual consistency), retry após espera confirma "inactive" → true (#4545 review)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonRes(200, { data: { status: calls === 1 ? "pending" : "inactive" } });
    }) as typeof fetch;
    let sleptMs = -1;
    const sleepImpl = async (ms: number) => {
      sleptMs = ms;
    };
    const result = await verifyUnsubscribedInBeehiiv("pub_1", "key", "a@b.com", fetchImpl, sleepImpl);
    assert.equal(result, true);
    assert.equal(calls, 2, "GET inicial + 1 releitura após o retry — retry é INCONDICIONAL, não depende de um status intermediário nomeado");
    assert.equal(sleptMs, PROMOTION_VERIFY_RETRY_DELAY_MS);
  });

  it("verifyUnsubscribedInBeehiiv: retry esgotado, releitura AINDA não mostra inactive → false (nunca um 2º retry)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonRes(200, { data: { status: "pending" } });
    }) as typeof fetch;
    const result = await verifyUnsubscribedInBeehiiv("pub_1", "key", "a@b.com", fetchImpl, async () => {});
    assert.equal(result, false);
    assert.equal(calls, 2, "só 1 retry, nunca fica reesperando indefinidamente");
  });
});

describe("verifySuppressedInBrevo — releitura pós-supressão (#4398 fix 4)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("emailBlacklisted:true e sem o list_id → true (supressão confirmada)", async () => {
    globalThis.fetch = (async () => jsonRes(200, { emailBlacklisted: true, listIds: [] })) as typeof fetch;
    try {
      assert.equal(await verifySuppressedInBrevo("key", 7, "a@b.com"), true);
    } finally {
      restore();
    }
  });

  it("emailBlacklisted:false → false (PUT não pegou, mesmo com 2xx)", async () => {
    globalThis.fetch = (async () => jsonRes(200, { emailBlacklisted: false, listIds: [] })) as typeof fetch;
    try {
      assert.equal(await verifySuppressedInBrevo("key", 7, "a@b.com"), false);
    } finally {
      restore();
    }
  });

  it("emailBlacklisted:true mas AINDA no list_id (unlink não confirmado) → false", async () => {
    globalThis.fetch = (async () => jsonRes(200, { emailBlacklisted: true, listIds: [7] })) as typeof fetch;
    try {
      assert.equal(await verifySuppressedInBrevo("key", 7, "a@b.com"), false);
    } finally {
      restore();
    }
  });

  it("status != 200 (404 — contato sumiu) → false (fail-safe, nunca assume sucesso)", async () => {
    globalThis.fetch = (async () => jsonRes(404, {})) as typeof fetch;
    try {
      assert.equal(await verifySuppressedInBrevo("key", 7, "a@b.com"), false);
    } finally {
      restore();
    }
  });
});

describe("runEvaluation — descadastro nativo (#4476 item 7), passo 0 (reescrito #4630/#4633)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  /** Evento `userUnsubscription` genuíno — presença mínima que
   * `hasUserUnsubscription` exige (array não-vazio; conteúdo não importa). */
  const userUnsubscriptionEvent = { date: "2026-08-01T00:00:00.000Z" };

  it("emailBlacklisted:true + userUnsubscription genuína, não-active na Beehiiv → unsubscribedNative, nunca kept/suppressed/selfConfirmed (#4630)", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      // #4630: pré-checagem Beehiiv-já-ativo (Passo 0) — não está active.
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (u.includes("/contacts/")) {
        return jsonRes(200, {
          emailBlacklisted: true,
          statistics: { messagesSent: [], opened: [], unsubscriptions: { userUnsubscription: [userUnsubscriptionEvent] } },
        });
      }
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("unsub@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.unsubscribedNative, 1);
      assert.equal(result.kept, 0);
      assert.equal(result.suppressed, 0);
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.failed, 0);
    } finally {
      restore();
    }
  });

  it("push:true, userUnsubscription genuína, releitura Beehiiv confirma 'inactive' → PUT unsubscribe:true emitido, unlinkFromBrevoList chamado, store marca status unsubscribed motivo native_unsubscribe (#4538 caso a, #4630)", async () => {
    const putCalls: { url: string; body: unknown }[] = [];
    let beehiivPutCalled = false;
    let byEmailCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com") && init?.method === "PUT") {
        beehiivPutCalled = true;
        assert.deepEqual(JSON.parse(init.body as string), { unsubscribe: true }, "PUT unsubscribe:true — não status, não DELETE");
        return jsonRes(200, {});
      }
      if (u.includes("api.beehiiv.com") && u.includes("subscriptions/by_email/")) {
        byEmailCalls++;
        // 1ª chamada: pré-checagem Beehiiv-já-ativo do #4630 — não active.
        if (byEmailCalls === 1) return jsonRes(200, { data: { status: "pending" } });
        // 2ª chamada: releitura pós-propagação — confirma inactive.
        return jsonRes(200, { data: { status: "inactive" } });
      }
      if (init?.method === "PUT") {
        putCalls.push({ url: u, body: JSON.parse(init.body as string) });
        return jsonRes(200, {});
      }
      if (u.includes("/contacts/")) {
        return jsonRes(200, {
          emailBlacklisted: true,
          statistics: { messagesSent: [], opened: [], unsubscriptions: { userUnsubscription: [userUnsubscriptionEvent] } },
        });
      }
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("unsub2@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.unsubscribedNative, 1);
      assert.equal(result.failed, 0);
      assert.equal(beehiivPutCalled, true, "chamada Beehiiv (unsubscribe:true) foi emitida");
      assert.deepEqual(putCalls, [{ url: putCalls[0]?.url, body: { unlinkListIds: [7] } }]);
      const c = findContact(result.store, "unsub2@b.com")!;
      assert.equal(c.status, "unsubscribed");
      assert.equal(c.resolution_reason, "native_unsubscribe");
    } finally {
      restore();
    }
  });

  it("push:true, userUnsubscription genuína, releitura Beehiiv NÃO confirma 'inactive' → contato segue in_brevo no store (nunca marcado unsubscribed sem confirmação), run sai com failed>0, unlinkFromBrevoList NUNCA chamado (#4538 caso b, fail-safe)", async () => {
    const brevoPutCalls: { body: unknown }[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com") && init?.method === "PUT") {
        // PUT aceito (2xx)...
        return jsonRes(200, {});
      }
      if (u.includes("api.beehiiv.com") && u.includes("subscriptions/by_email/")) {
        // ...mas TODA leitura (pré-checagem #4630 E releitura pós-propagação)
        // NÃO confirma "inactive" — mesma armadilha do endpoint de tags, a
        // mutação foi ignorada em silêncio.
        return jsonRes(200, { data: { status: "pending" } });
      }
      if (init?.method === "PUT") {
        brevoPutCalls.push({ body: JSON.parse(init.body as string) });
        return jsonRes(200, {});
      }
      if (u.includes("/contacts/")) {
        return jsonRes(200, {
          emailBlacklisted: true,
          statistics: { messagesSent: [], opened: [], unsubscriptions: { userUnsubscription: [userUnsubscriptionEvent] } },
        });
      }
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("unsub3@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 1, "verificação não confirmada conta como falha, nunca silenciosa");
      assert.equal(result.unsubscribedNative, 1, "contado como 'intenção' detectada, mesmo revertido pelo fail-safe (mesmo padrão de promoted/suppressed)");
      assert.deepEqual(brevoPutCalls, [], "unlinkFromBrevoList NUNCA chamado sem confirmação da Beehiiv");
      const c = findContact(result.store, "unsub3@b.com")!;
      assert.equal(c.status, "in_brevo", "NUNCA marcado unsubscribed sem confirmação — segue in_brevo pra retentar na próxima rodada");
      assert.equal(c.resolution_reason, undefined);
    } finally {
      restore();
    }
  });

  it("push:true, userUnsubscription genuína, PUT pra Beehiiv retorna erro TRANSITÓRIO (500) → mesmo fail-safe: contato segue in_brevo, failed>0, unlink nunca chamado (cenário (d) do #4633 — nunca confundir com 404 permanente)", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com") && init?.method === "PUT") return new Response("boom", { status: 500 });
      // #4630: pré-checagem Beehiiv-já-ativo — não active (500 é só na propagação em si).
      if (u.includes("api.beehiiv.com") && u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (init?.method === "PUT") throw new Error("unlinkFromBrevoList não deveria ser chamado");
      if (u.includes("/contacts/")) {
        return jsonRes(200, {
          emailBlacklisted: true,
          statistics: { messagesSent: [], opened: [], unsubscriptions: { userUnsubscription: [userUnsubscriptionEvent] } },
        });
      }
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("unsub4@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 1);
      const c = findContact(result.store, "unsub4@b.com")!;
      assert.equal(c.status, "in_brevo");
      assert.equal(c.resolution_reason, undefined);
    } finally {
      restore();
    }
  });

  it("push:true, userUnsubscription genuína, propagação retorna HTTP 404 (sem registro Beehiiv pra este e-mail) → marca unsubscribed DIRETO sem esperar confirmação (nada a confirmar), resolution_reason native_unsubscribe_beehiiv_404, nunca fica preso em in_brevo, nunca conta como failed (#4633, caso do achado ao vivo walterhaoliveira.rj@gmail.com)", async () => {
    const brevoPutCalls: { body: unknown }[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.beehiiv.com") && init?.method === "PUT") {
        return new Response(
          JSON.stringify({ status: 404, errors: [{ message: "Couldn't find subscriber", code: "RECORD_NOT_FOUND" }] }),
          { status: 404 },
        );
      }
      // #4630: pré-checagem Beehiiv-já-ativo — não active (404 é só na propagação PUT).
      if (u.includes("api.beehiiv.com") && u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (init?.method === "PUT") {
        brevoPutCalls.push({ body: JSON.parse(init.body as string) });
        return jsonRes(200, {});
      }
      if (u.includes("/contacts/")) {
        return jsonRes(200, {
          emailBlacklisted: true,
          statistics: { messagesSent: [], opened: [], unsubscriptions: { userUnsubscription: [userUnsubscriptionEvent] } },
        });
      }
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("orfao404@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 0, "404 é PERMANENTE, resolvido na mesma rodada — nunca fica marcado como falha (diferente do 5xx/timeout)");
      assert.equal(result.unsubscribedNative, 1);
      assert.deepEqual(brevoPutCalls, [{ body: { unlinkListIds: [7] } }], "unlinkFromBrevoList AINDA é chamado — sai da lista Brevo mesmo sem registro Beehiiv");
      const c = findContact(result.store, "orfao404@b.com")!;
      assert.equal(c.status, "unsubscribed", "marcado direto — nunca preso em in_brevo esperando confirmação que nunca chegaria");
      assert.equal(c.resolution_reason, "native_unsubscribe_beehiiv_404");
    } finally {
      restore();
    }
  });

  it("emailBlacklisted:true SEM userUnsubscription (bounce/ação admin) MAS já ativo na Beehiiv → tratado como auto-confirmação, NUNCA reverte o assinante real (#4630, caso do achado ao vivo marcelo.nunes@safra.com.br)", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "active" } });
      if (u.includes("/contacts/")) {
        // emailBlacklisted:true sem statistics.unsubscriptions.userUnsubscription
        // — só adminUnsubscription/bounce, nunca clique real do usuário.
        return jsonRes(200, { emailBlacklisted: true, statistics: { messagesSent: [], opened: [] } });
      }
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("bounce-mas-ativo@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.selfConfirmed, 1, "tratado como auto-confirmação — a Beehiiv já mostra active");
      assert.equal(result.unsubscribedNative, 0, "NUNCA a saída nativa — reverteria um assinante já confirmado (o bug original do #4630)");
      assert.equal(result.failed, 0);
    } finally {
      restore();
    }
  });

  it("push:true, mesmo caso acima (bounce/admin + Beehiiv já active) → applySelfConfirmed aplicado, unlinkFromBrevoList chamado, status final promoted_beehiiv/self_confirmed_beehiiv (nunca unsubscribed)", async () => {
    let unlinkBody: unknown;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "active" } });
      if (init?.method === "PUT") {
        unlinkBody = JSON.parse(init.body as string);
        return jsonRes(200, {});
      }
      if (u.includes("/contacts/")) {
        return jsonRes(200, { emailBlacklisted: true, statistics: { messagesSent: [], opened: [] } });
      }
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("bounce-mas-ativo2@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.selfConfirmed, 1);
      assert.deepEqual(unlinkBody, { unlinkListIds: [7] });
      const c = findContact(result.store, "bounce-mas-ativo2@b.com")!;
      assert.equal(c.status, "promoted_beehiiv");
      assert.equal(c.resolution_reason, "self_confirmed_beehiiv");
    } finally {
      restore();
    }
  });

  it("emailBlacklisted:true SEM userUnsubscription E sem estar ativo na Beehiiv → NÃO tratado como descadastro nativo (#4630, ruído de bounce/admin isolado), segue avaliação normal por score, beehiivStatus buscado 1x só (reusado entre passo 0 e passo 1)", async () => {
    let byEmailCalls = 0;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) {
        byEmailCalls++;
        return jsonRes(200, { data: { status: "pending" } });
      }
      if (u.includes("/contacts/")) {
        return jsonRes(200, {
          emailBlacklisted: true,
          statistics: { messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }], opened: [] },
        });
      }
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("bounce-nao-ativo@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.unsubscribedNative, 0, "adminUnsubscription isolado nunca é tratado como saída nativa (#4630)");
      assert.equal(result.selfConfirmed, 0);
      // eventos sem timestamp de data → tratados como IMATUROS (fail-safe) →
      // mature sends_count=0 < piso de supressão (3) → keep.
      assert.equal(result.kept, 1);
      assert.equal(result.failed, 0);
      assert.equal(byEmailCalls, 1, "beehiivStatus buscado só 1x — reusado entre o passo 0 (pré-checagem) e o passo 1 (auto-confirmação)");
    } finally {
      restore();
    }
  });

  it("emailBlacklisted:true, falha ao checar status Beehiiv (pré-checagem #4630) → conta failed, contato pulado inteiro (nem native, nem self-confirmed, nem score)", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return new Response("boom", { status: 500 });
      if (u.includes("/contacts/")) return jsonRes(200, { emailBlacklisted: true, statistics: { messagesSent: [], opened: [] } });
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("falha-precheck@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 1);
      assert.equal(result.unsubscribedNative, 0);
      assert.equal(result.selfConfirmed, 0);
      assert.equal(result.kept, 0);
    } finally {
      restore();
    }
  });

  it("emailBlacklisted:false → prossegue normalmente pra auto-confirmação/score (não é uma saída)", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (u.includes("/contacts/")) {
        return jsonRes(200, {
          emailBlacklisted: false,
          statistics: { messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }], opened: [] },
        });
      }
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("normal@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.unsubscribedNative, 0);
      // eventos sem timestamp de data → tratados como IMATUROS (fail-safe) →
      // mature sends_count=0 < piso de supressão (3) → keep. (O foco deste
      // teste é confirmar que o passo de descadastro nativo não interfere no
      // fluxo normal — não os detalhes do threshold, cobertos em
      // `computeMatureCountsFromBrevoStatistics` acima.)
      assert.equal(result.kept, 1);
    } finally {
      restore();
    }
  });

  it("sem brevoApiKey (dry-run sem a key configurada) → passo 0 pulado inteiro, nenhuma chamada a /contacts", async () => {
    let contactsCalls = 0;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (u.includes("/contacts/")) {
        contactsCalls++;
        return jsonRes(200, {});
      }
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("sem-key@b.com", { opens_count: 1, sends_count: 3 })];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        // brevoApiKey ausente de propósito
        listId: 7,
        log: () => {},
      });
      assert.equal(contactsCalls, 0, "sem brevoApiKey, passo 0 nunca chama /contacts");
      assert.equal(result.unsubscribedNative, 0);
      // usa contadores do store como fallback (instant=mature, documentado em
      // runEvaluation): 1/3 = 33%, piso de amostra atingido (n=3) mas taxa
      // acima do threshold de supressão (20%) → keep
      assert.equal(result.kept, 1);
    } finally {
      restore();
    }
  });

  it("falha ao checar estado Brevo (passo 0) → conta failed, NÃO avalia auto-confirmação/score com dado incompleto", async () => {
    let beehiivCalls = 0;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) {
        beehiivCalls++;
        return jsonRes(200, { data: { status: "pending" } });
      }
      // 403 (não 500/429) — brevoGet lança IMEDIATAMENTE, sem retry/backoff
      // (evita o teste esperar segundos reais de sleep entre tentativas).
      if (u.includes("/contacts/")) return jsonRes(403, {});
      throw new Error(`fetch inesperado: ${u}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("falha-estado@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 1);
      assert.equal(result.kept, 0);
      assert.equal(result.unsubscribedNative, 0);
      assert.equal(beehiivCalls, 0, "auto-confirmação nunca chamada — o contato pula pra próxima rodada inteiro");
    } finally {
      restore();
    }
  });
});

describe("runEvaluation — fail-safe por contato, nunca aborta o run (#4398 fixes 1-4, atualizado #4476)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("dry-run sem brevoApiKey: falha ao checar status Beehiiv de 1 contato conta em failed, mas os demais são avaliados normalmente", async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/falha%40b.com")) return new Response("boom", { status: 500 });
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      throw new Error(`fetch inesperado em dry-run: ${u}`);
    }) as typeof fetch;

    try {
      // #4476: fixtures ajustadas pra "keep" sob a nova fórmula (3 enviados/1
      // aberto → 33%, abaixo do piso de amostra de supressão) — o teste
      // continua cobrindo o mesmo cenário original (falha de auto-confirmação
      // não impede a avaliação de score dos demais), só com valores
      // compatíveis com a fórmula por taxa.
      const contacts = [
        contact("falha@b.com", { opens_count: 1, sends_count: 3 }),
        contact("ok@b.com", { opens_count: 1, sends_count: 3 }),
      ];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: false,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        listId: 7,
        log,
      });
      assert.equal(result.failed, 1, "1 falha de checagem contada");
      assert.equal(result.kept, 2, "ambos avaliados por taxa de abertura mesmo com a falha de auto-confirmação");
      assert.ok(logs.some((l) => l.includes("falha ao checar status Beehiiv de falha@b.com")));
    } finally {
      restore();
    }
  });

  it("push: exceção ao checar estado Brevo (passo 0) de 1 contato NÃO aborta o run — o próximo contato ainda é processado", async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (init?.method === undefined && u.includes("/contacts/erro%40b.com")) {
        return new Response("forbidden", { status: 403 }); // brevoGet: 403 lança sem retry
      }
      if (init?.method === undefined && u.includes("/contacts/ok%40b.com")) {
        // 3 enviados/1 aberto → 33%, acima do threshold de supressão (20%) → keep
        // (eventos sem timestamp de data também seriam imaturos por
        // fail-safe — mas aqui a taxa em si já não qualifica, então o
        // resultado é keep por dupla razão, não só a ausência de timestamp).
        return jsonRes(200, {
          statistics: {
            messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
            opened: [{ campaignId: 1 }],
          },
        });
      }
      throw new Error(`fetch inesperado: ${u} ${init?.method}`);
    }) as typeof fetch;

    try {
      const contacts = [contact("erro@b.com"), contact("ok@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log,
      });
      assert.equal(result.failed, 1, "só o contato com erro no passo 0 conta como falha");
      assert.equal(result.kept, 1, "o segundo contato foi processado normalmente (33% → keep)");
      assert.ok(logs.some((l) => l.includes("falha ao checar estado Brevo de erro@b.com")));
    } finally {
      restore();
    }
  });

  it("push: suppress bem-sucedido (verify confirma blacklist + desvinculação) → status suppressed no store (fix 3+4)", async () => {
    const putCalls: { body: unknown }[] = [];
    let getContactCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (init?.method === "PUT") {
        putCalls.push({ body: JSON.parse(init.body as string) });
        return jsonRes(200, {});
      }
      getContactCalls++;
      if (getContactCalls === 1) {
        // 1ª GET (passo 0 — descadastro nativo + contadores reusados no passo 2):
        // 5 enviados MADUROS (>=48h), 0 abertos → openRate 0% <= 20%,
        // mature sends_count=5 >= piso de supressão (3) → suprime.
        return jsonRes(200, {
          statistics: {
            messagesSent: [matureEvent(1), matureEvent(2), matureEvent(3), matureEvent(4), matureEvent(5)],
            opened: [],
          },
        });
      }
      // 2ª GET: releitura pós-supressão — confirma blacklist + fora da lista
      return jsonRes(200, { emailBlacklisted: true, listIds: [] });
    }) as typeof fetch;

    try {
      const contacts = [contact("supr@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 0);
      assert.equal(result.suppressed, 1);
      assert.equal(putCalls.length, 2, "suppressInBrevo + unlinkFromBrevoList, ambos chamados");
      assert.deepEqual(putCalls[0].body, { emailBlacklisted: true });
      assert.deepEqual(putCalls[1].body, { unlinkListIds: [7] });
      assert.equal(findContact(result.store, "supr@b.com")!.status, "suppressed");
    } finally {
      restore();
    }
  });

  it("push: suppress cuja releitura NÃO confirma → mantém in_brevo (fail-safe fix 4), conta failed", async () => {
    let getContactCalls = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) return jsonRes(200, { data: { status: "pending" } });
      if (init?.method === "PUT") return jsonRes(200, {});
      getContactCalls++;
      if (getContactCalls === 1) {
        // 5 enviados MADUROS (>=48h), 0 abertos → suprime (mesma fixture do
        // teste "suppress bem-sucedido" acima).
        return jsonRes(200, {
          statistics: {
            messagesSent: [matureEvent(1), matureEvent(2), matureEvent(3), matureEvent(4), matureEvent(5)],
            opened: [],
          },
        });
      }
      // releitura NÃO confirma: PUT foi 2xx mas o estado real não mudou (mesma armadilha da Beehiiv, ver disclaimer do módulo)
      return jsonRes(200, { emailBlacklisted: false, listIds: [7] });
    }) as typeof fetch;

    try {
      const contacts = [contact("supr2@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 1, "verificação não confirmada conta como falha, nunca silenciosa");
      assert.equal(result.suppressed, 1, "contado como 'intenção' da avaliação de score, mesmo revertido pelo fail-safe");
      assert.equal(findContact(result.store, "supr2@b.com")!.status, "in_brevo", "NUNCA marcado suppressed sem confirmação");
    } finally {
      restore();
    }
  });

  it("push: promote bem-sucedido continua funcionando após o refactor de runEvaluation (regressão, #4488: promoteBeehiivSubscription agora busca o id via GET também)", async () => {
    let byEmailCalls = 0;
    const deleteUrls: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("subscriptions/by_email/")) {
        byEmailCalls++;
        // 1ª chamada: auto-confirmação (passo 1, ainda "pending", cai no
        // caminho de score). 2ª chamada: o GET interno de
        // promoteBeehiivSubscription (#4488) buscando o id atual pra
        // deletar — também "pending", com um id pra DELETE mirar. 3ª
        // chamada: verifyPromotedToBeehiiv pós-promoção (já "active", confirma).
        if (byEmailCalls === 1) return jsonRes(200, { data: { status: "pending" } });
        if (byEmailCalls === 2) return jsonRes(200, { data: { id: "sub_promo_atual", status: "pending" } });
        return jsonRes(200, { data: { status: "active" } });
      }
      if (init?.method === "DELETE") {
        // promoteBeehiivSubscription: deleta o registro pending travado antes
        // de recriar (#4476/#4488, mecânica corrigida — não mais reactivate_existing).
        deleteUrls.push(u);
        return new Response(null, { status: 204 });
      }
      if (u.includes("/publications/pub_1/subscriptions") && init?.method === "POST") {
        return jsonRes(200, {});
      }
      if (init?.method === "PUT") {
        return jsonRes(200, {});
      }
      // GET /contacts/{email} (passo 0, reusado no passo 2) — 3 enviados/3
      // abertos → openRate 1.0, sends_count=3 >= 3 → promote
      return jsonRes(200, {
        statistics: {
          messagesSent: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
          opened: [{ campaignId: 1 }, { campaignId: 2 }, { campaignId: 3 }],
        },
      });
    }) as typeof fetch;

    try {
      const contacts = [contact("promo@b.com")];
      const result = await runEvaluation({
        contacts,
        store: { contacts },
        push: true,
        publicationId: "pub_1",
        beehiivApiKey: "bkey",
        brevoApiKey: "brkey",
        listId: 7,
        log: () => {},
      });
      assert.equal(result.failed, 0);
      assert.equal(result.promoted, 1);
      assert.equal(findContact(result.store, "promo@b.com")!.status, "promoted_beehiiv");
      assert.deepEqual(deleteUrls, ["https://api.beehiiv.com/v2/publications/pub_1/subscriptions/sub_promo_atual"], "DELETE mira o id vindo do GET interno, nunca um id armazenado");
    } finally {
      restore();
    }
  });
});
