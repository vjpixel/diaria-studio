/**
 * brevo-committed-campaigns-3682.test.ts (#3682)
 *
 * Regressão do incidente: ramp-warm reenviou 100% da mesma edição pros
 * envios 4-5 do mensal 2606, porque a única exclusão existente
 * (`fetchQueuedCampaignListIds`, #2994) só cobria campanhas `queued` — uma
 * campanha já `sent` (envios 1-3) nunca entrava no set de exclusão, e
 * `sends_count=0` local não é confiável como proxy porque o sync incremental
 * do store (task diária) tem lag de propagação (~1 dia no incidente real).
 *
 * Cobertura:
 *  - fetchQueuedCampaignListIds / fetchSentCampaignListIds: paginação +
 *    extração de recipients.lists, por status.
 *  - fetchCommittedCampaignListIds: união queued+sent — a peça nova que
 *    fecha o furo.
 *  - Cenário de ponta a ponta replicando o incidente: contato com
 *    sends_count=0 (lag) mas pertencente à lista de uma campanha SENT do
 *    ciclo é excluído da próxima seleção via
 *    excludeCommittedToQueuedCampaigns(rows, fetchCommittedCampaignListIds(...)).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fetchQueuedCampaignListIds,
  fetchSentCampaignListIds,
  fetchCommittedCampaignListIds,
} from "../scripts/lib/brevo-client.ts";
import { excludeCommittedToQueuedCampaigns, type StoreRow } from "../scripts/lib/clarice-segment.ts";

function makeJsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => "application/json" },
  } as unknown as Response);
}

function row(p: Partial<StoreRow> & { email: string }): StoreRow {
  return {
    tier: null,
    cohort: null,
    priority_points: 0,
    send_eligible: 1,
    ineligible_reason: null,
    sends_count: 0,
    opens_count: 0,
    last_sent_at: null,
    mv_bucket: "verified",
    brevo_list_ids: null,
    name: null,
    ...p,
  } as StoreRow;
}

describe("fetchSentCampaignListIds (#3682)", () => {
  it("agrega recipients.lists de campanhas status=sent, paginado", async () => {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      const urlStr = String(url);
      if (urlStr.includes("offset=0")) {
        const campaigns = Array.from({ length: 50 }, (_, i) => ({
          id: i,
          recipients: { lists: [72] },
        }));
        return makeJsonResponse({ campaigns });
      }
      return makeJsonResponse({ campaigns: [{ id: 999, recipients: { lists: [73] } }] });
    }) as unknown as typeof fetch;
    try {
      const ids = await fetchSentCampaignListIds("fake-key");
      assert.deepEqual([...ids].sort(), ["72", "73"]);
      assert.ok(calls.every((u) => u.includes("status=sent")), "toda chamada deve filtrar status=sent");
      assert.equal(calls.length, 2, "deve paginar até a página incompleta");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("campanha sem recipients.lists não quebra (vazio, não undefined-crash)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => makeJsonResponse({ campaigns: [{ id: 1 }] })) as unknown as typeof fetch;
    try {
      const ids = await fetchSentCampaignListIds("fake-key");
      assert.deepEqual([...ids], []);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("fetchCommittedCampaignListIds (#3682) — união queued+sent", () => {
  it("une listas de campanhas queued E sent num único Set", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("status=queued")) {
        return makeJsonResponse({ campaigns: [{ id: 1, recipients: { lists: [74] } }] });
      }
      if (urlStr.includes("status=sent")) {
        return makeJsonResponse({
          campaigns: [
            { id: 2, recipients: { lists: [72] } },
            { id: 3, recipients: { lists: [73] } },
          ],
        });
      }
      throw new Error(`URL inesperada: ${urlStr}`);
    }) as unknown as typeof fetch;
    try {
      const ids = await fetchCommittedCampaignListIds("fake-key");
      assert.deepEqual([...ids].sort(), ["72", "73", "74"]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("cenário do incidente real: contato com sends_count=0 (lag) mas em lista SENT é excluído da próxima seleção", async () => {
    // Réplica do incidente 260716-260721 (#3682): envio 4 (lista 72, w1-ter)
    // e envio 5 (lista 73, w2-sex) já são SENT; um contato dessas listas
    // ainda aparece com sends_count=0 no store (lag) — sem o fix, ele seria
    // re-selecionado pro envio 6.
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("status=queued")) return makeJsonResponse({ campaigns: [] });
      if (urlStr.includes("status=sent")) {
        return makeJsonResponse({
          campaigns: [
            { id: 91, recipients: { lists: [72] } }, // envio 4 (w1-ter)
            { id: 92, recipients: { lists: [73] } }, // envio 5 (w2-sex)
          ],
        });
      }
      throw new Error(`URL inesperada: ${urlStr}`);
    }) as unknown as typeof fetch;
    try {
      const rows = [
        row({ email: "ja-recebeu-lag@x.com", sends_count: 0, brevo_list_ids: '["72"]' }), // já recebeu envio 4, store ainda não propagou
        row({ email: "novo-w3@x.com", sends_count: 0, brevo_list_ids: '["74"]' }), // genuinamente novo, lista do envio 6
      ];
      const committedListIds = await fetchCommittedCampaignListIds("fake-key");
      const result = excludeCommittedToQueuedCampaigns(rows, committedListIds);
      assert.deepEqual(
        result.map((r) => r.email),
        ["novo-w3@x.com"],
        "contato já em lista SENT deve ser excluído mesmo com sends_count=0 local (fix #3682)",
      );
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("fetchQueuedCampaignListIds (#2994) — cobertura direta (não existia antes do #3682)", () => {
  it("comportamento inalterado: só agrega campanhas status=queued", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const urlStr = String(url);
      assert.ok(urlStr.includes("status=queued"));
      return makeJsonResponse({ campaigns: [{ id: 1, recipients: { lists: [68] } }] });
    }) as unknown as typeof fetch;
    try {
      const ids = await fetchQueuedCampaignListIds("fake-key");
      assert.deepEqual([...ids], ["68"]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
