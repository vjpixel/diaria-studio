/**
 * test/brevo-draft-campaigns-5064.test.ts (#5064)
 *
 * `detectExistingWaveForSendDate` (clarice-envio-run.ts, #5058) só enxergava
 * onda `queued`/`sent` — uma onda PARCIALMENTE MONTADA (`--create` rodou,
 * `--schedule` falhou/não rodou ainda) fica invisível, porque o dashboard
 * (`/api/campaigns?includeScheduled=1`) nunca devolve `draft` (ver
 * `buildCampaignsResponse` no Worker). Fecha o guard consultando a Brevo
 * DIRETO (a key já está disponível localmente) — sem precisar de endpoint
 * novo no Worker `brevo-dashboard`.
 *
 * Cobertura:
 *  - fetchDraftCampaigns: paginação + filtro status=draft + objeto completo
 *    (name/recipients/status), ao contrário de fetchQueuedCampaignListIds/
 *    fetchSentCampaignListIds (que só devolvem list ids).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchDraftCampaigns } from "../scripts/lib/brevo-client.ts";

function makeJsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => "application/json" },
  } as unknown as Response);
}

describe("fetchDraftCampaigns (#5064)", () => {
  it("filtra status=draft e devolve objetos completos (name/recipients/status), paginado", async () => {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const urlStr = String(url);
      calls.push(urlStr);
      assert.ok(urlStr.includes("status=draft"), `toda chamada deve filtrar status=draft: ${urlStr}`);
      if (urlStr.includes("offset=0")) {
        const campaigns = Array.from({ length: 50 }, (_, i) => ({
          id: i,
          name: `Clarice 2607 grupo:d${i}-qui06`,
          status: "draft",
          recipients: { lists: [500 + i] },
        }));
        return makeJsonResponse({ campaigns });
      }
      return makeJsonResponse({
        campaigns: [{ id: 999, name: "Clarice 2607 grupo:d12-qua12", status: "draft", recipients: { lists: [900] } }],
      });
    }) as unknown as typeof fetch;
    try {
      const drafts = await fetchDraftCampaigns("fake-key");
      assert.equal(drafts.length, 51, "deve paginar até a página incompleta");
      assert.equal(calls.length, 2);
      assert.equal(drafts[50].name, "Clarice 2607 grupo:d12-qua12");
      assert.deepEqual(drafts[0].recipients, { lists: [500] });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("nenhuma campanha em draft => array vazio, 1 única chamada", async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return makeJsonResponse({ campaigns: [] });
    }) as unknown as typeof fetch;
    try {
      const drafts = await fetchDraftCampaigns("fake-key");
      assert.deepEqual(drafts, []);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("campanha sem recipients não quebra (undefined preservado, não crasha)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      makeJsonResponse({ campaigns: [{ id: 1, name: "Clarice 2607 grupo:novos", status: "draft" }] })) as unknown as typeof fetch;
    try {
      const drafts = await fetchDraftCampaigns("fake-key");
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].recipients, undefined);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
