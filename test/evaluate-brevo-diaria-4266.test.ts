/**
 * test/evaluate-brevo-diaria-4266.test.ts (#4266)
 *
 * Avaliação periódica dos contatos in_brevo: contadores a partir da
 * estatística de contato da Brevo, veredito puro (score + threshold), e a
 * checagem de auto-confirmação Beehiiv que fecha o gap de duplicidade
 * registrado na própria issue.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCountsFromBrevoStatistics,
  evaluateContact,
  fetchBeehiivSubscriptionStatus,
  verifyPromotedToBeehiiv,
} from "../scripts/evaluate-brevo-diaria.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

describe("evaluateContact — score + threshold combinados (#4266)", () => {
  it("3 enviados/3 abertos → score 60 → promote_to_beehiiv", () => {
    const ev = evaluateContact({ opens_count: 3, sends_count: 3 });
    assert.equal(ev.score, 60);
    assert.equal(ev.action, "promote_to_beehiiv");
  });

  it("3 enviados/0 abertos → score -30 → suppress", () => {
    const ev = evaluateContact({ opens_count: 0, sends_count: 3 });
    assert.equal(ev.score, -30);
    assert.equal(ev.action, "suppress");
  });

  it("2 enviados/1 aberto → score 10 → keep", () => {
    const ev = evaluateContact({ opens_count: 1, sends_count: 2 });
    assert.equal(ev.score, 10);
    assert.equal(ev.action, "keep");
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

describe("verifyPromotedToBeehiiv — fail-safe se ainda pending (#4266)", () => {
  it("status active → true (promoção confirmada)", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "active" } })) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), true);
  });

  it("status ainda pending → false (fail-safe: NÃO confirma promoção)", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "pending" } })) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), false);
  });

  it("404 (subscription sumiu) → false", async () => {
    const fetchImpl = (async () => jsonRes(404, {})) as typeof fetch;
    assert.equal(await verifyPromotedToBeehiiv("pub_1", "key", "a@b.com", fetchImpl), false);
  });
});
