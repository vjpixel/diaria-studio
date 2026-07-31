/**
 * test/sync-pending-to-brevo-4266.test.ts (#4266)
 *
 * Triagem Pending(Beehiiv)→Brevo. Cobre: paginação/reconciliação da leitura
 * Beehiiv, diff puro (dedup pelo store, nunca pela Beehiiv), e a
 * ingestão real (mock de fetch — nunca rede real).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fetchPendingBeehiivSubscriptions,
  computeContactsToIngest,
  ingestContactToBrevo,
  type BeehiivPendingSubscription,
} from "../scripts/sync-pending-to-brevo.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchPendingBeehiivSubscriptions — paginação (#4266)", () => {
  it("agrega várias páginas até total_results", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL) => {
      calls++;
      // #4266 review: "per_page=100" contém "page=1" como substring — usar o
      // query param real (não string.includes ingênuo) pra não confundir
      // page=1 com per_page=100&page=2 etc.
      const pageParam = new URL(String(url)).searchParams.get("page");
      if (pageParam === "1") {
        return jsonRes(200, {
          data: [
            { id: "sub_1", email: "a@b.com" },
            { id: "sub_2", email: "b@b.com" },
          ],
          total_results: 3,
          limit: 2,
        });
      }
      return jsonRes(200, { data: [{ id: "sub_3", email: "C@B.com" }], total_results: 3, limit: 2 });
    }) as typeof fetch;

    const out = await fetchPendingBeehiivSubscriptions("pub_1", "key", fetchImpl);
    assert.equal(out.length, 3);
    assert.equal(out[2].email, "c@b.com", "email normalizado (lowercase)");
    assert.equal(calls, 2);
  });

  it("página truncada (total_results maior que o coletado) → lança (nunca ingestão incompleta silenciosa)", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: [{ id: "sub_1", email: "a@b.com" }], total_results: 5, limit: 1 })) as typeof fetch;
    // hasMorePages vai continuar pedindo (gotLength >= limit), mas simulando
    // uma resposta vazia na 2ª página sem bater o total:
    let page = 0;
    const truncating = (async () => {
      page++;
      if (page === 1) return jsonRes(200, { data: [{ id: "sub_1", email: "a@b.com" }], total_results: 5, limit: 1 });
      return jsonRes(200, { data: [], total_results: 5, limit: 1 });
    }) as typeof fetch;
    await assert.rejects(() => fetchPendingBeehiivSubscriptions("pub_1", "key", truncating), /terminou cedo/);
    void fetchImpl;
  });

  it("!ok em qualquer página → lança (fail loud)", async () => {
    const fetchImpl = (async () => jsonRes(500, { message: "boom" })) as typeof fetch;
    await assert.rejects(() => fetchPendingBeehiivSubscriptions("pub_1", "key", fetchImpl), /Beehiiv API 500/);
  });
});

describe("computeContactsToIngest — dedup pelo store, nunca pela Beehiiv (#4266)", () => {
  it("contato Pending ausente do store → entra na lista de ingestão", () => {
    const pending: BeehiivPendingSubscription[] = [{ id: "sub_1", email: "a@b.com" }];
    const store: BrevoDiariaStore = { contacts: [] };
    const out = computeContactsToIngest(pending, store);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { email: "a@b.com", beehiiv_subscription_id: "sub_1" });
  });

  it("contato já no store (qualquer status) → NUNCA re-ingerido", () => {
    const pending: BeehiivPendingSubscription[] = [
      { id: "sub_1", email: "a@b.com" },
      { id: "sub_2", email: "b@b.com" },
      { id: "sub_3", email: "c@b.com" },
    ];
    const store: BrevoDiariaStore = {
      contacts: [
        { email: "a@b.com", beehiiv_subscription_id: "sub_1", status: "in_brevo", opens_count: 0, sends_count: 0, last_score: null, added_at: "x", last_evaluated_at: null },
        { email: "b@b.com", beehiiv_subscription_id: "sub_2", status: "promoted_beehiiv", opens_count: 3, sends_count: 3, last_score: 60, added_at: "x", last_evaluated_at: "y", promoted_at: "z" },
      ],
    };
    const out = computeContactsToIngest(pending, store);
    assert.equal(out.length, 1);
    assert.equal(out[0].email, "c@b.com");
  });

  it("dedup interno da própria página Pending (mesmo email 2x na resposta)", () => {
    const pending: BeehiivPendingSubscription[] = [
      { id: "sub_1", email: "a@b.com" },
      { id: "sub_1b", email: "a@b.com" },
    ];
    const out = computeContactsToIngest(pending, { contacts: [] });
    assert.equal(out.length, 1);
  });
});

describe("ingestContactToBrevo — cria + verifica por releitura (#4266)", () => {
  const origFetch = globalThis.fetch;
  function restore() {
    globalThis.fetch = origFetch;
  }

  it("sucesso: POST cria, GET confirma listIds inclui o list_id", async () => {
    let posted: unknown;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") {
        posted = JSON.parse(init.body as string);
        return jsonRes(201, {});
      }
      return jsonRes(200, { email: "a@b.com", listIds: [7] });
    }) as typeof fetch;
    try {
      await ingestContactToBrevo("key", 7, "a@b.com");
      assert.deepEqual(posted, { email: "a@b.com", listIds: [7], updateEnabled: true });
    } finally {
      restore();
    }
  });

  it("releitura sem o list_id esperado → lança (mutação não confirmada)", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes(201, {});
      return jsonRes(200, { email: "a@b.com", listIds: [999] });
    }) as typeof fetch;
    try {
      await assert.rejects(() => ingestContactToBrevo("key", 7, "a@b.com"), /NÃO confere/);
    } finally {
      restore();
    }
  });

  it("releitura com status != 200 → lança", async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes(201, {});
      return jsonRes(404, {});
    }) as typeof fetch;
    try {
      await assert.rejects(() => ingestContactToBrevo("key", 7, "a@b.com"), /releitura pós-criação falhou/);
    } finally {
      restore();
    }
  });
});
