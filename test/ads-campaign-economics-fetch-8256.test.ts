/**
 * test/ads-campaign-economics-fetch-8256.test.ts (#8256)
 *
 * Cobre a quebra por `utm_campaign` dos cadastros do Kit em
 * `scripts/lib/ads-campaign-economics-fetch.ts` (PMax x Search do braço
 * Microsoft do teste 2608):
 *
 * 1. `fetchKitSignupsByChannel` devolve `signupsByCampaign` (por
 *    `fields.utm_campaign`) além de `signups` (total por canal), sem mudar
 *    `signups`.
 * 2. `fetchCampaignEconomicsSources` propaga `signupsByCampaign`, `[]`
 *    quando o Kit falhou/não rodou.
 *
 * #10755 (21/10/2026): o canal Microsoft Ads foi encerrado e a busca ao
 * vivo da Reporting API saiu (com ela, `fetchMicrosoftAdsChannelMetrics`,
 * `campaignBreakdown` e `microsoftCampaignBreakdown`). A quebra de
 * CADASTROS fica: vem do Kit e segue valendo pros cadastros históricos
 * com `utm_source=microsoft-ads`.
 *
 * Mock de rede via `globalThis.fetch`, mesmo padrão de
 * `test/ads-campaign-economics-fetch.test.ts` (Kit) — nunca a API real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchKitSignupsByChannel,
  fetchCampaignEconomicsSources,
  MICROSOFT_ADS_TESTE_CANAL,
} from "../scripts/lib/ads-campaign-economics-fetch.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("#8256 — fetchKitSignupsByChannel: signupsByCampaign (utm_campaign)", () => {
  const TEST_CONFIG = { apiKey: "kit_test_key" };
  const emptyPagination = { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 };

  async function withMockFetch<T>(handler: typeof fetch, fn: () => Promise<T>): Promise<T> {
    const orig = globalThis.fetch;
    globalThis.fetch = handler;
    try {
      return await fn();
    } finally {
      globalThis.fetch = orig;
    }
  }

  it("separa cadastros microsoft-ads por utm_campaign (PMax x Search) sem mudar o total em signups", async () => {
    const result = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          subscribers: [
            {
              id: 1,
              email_address: "a@b.com",
              state: "active",
              created_at: "2026-09-05T10:00:00.000Z",
              fields: { utm_source: "microsoft-ads", utm_campaign: "ads-microsoft-2608" },
            },
            {
              id: 2,
              email_address: "c@d.com",
              state: "active",
              created_at: "2026-09-05T11:00:00.000Z",
              fields: { utm_source: "microsoft-ads", utm_campaign: "ads-microsoft-2608-search" },
            },
            {
              id: 3,
              email_address: "e@f.com",
              state: "active",
              created_at: "2026-09-05T12:00:00.000Z",
              // utm_campaign ausente — nunca descartado, cai no bucket
              // '(sem utm_campaign)', mas segue contando no total do canal.
              fields: { utm_source: "microsoft-ads" },
            },
          ],
          pagination: emptyPagination,
        })) as typeof fetch,
      () => fetchKitSignupsByChannel(TEST_CONFIG),
    );

    assert.equal(result.error, null);
    assert.equal(result.signups.length, 1);
    assert.equal(result.signups[0].canal, MICROSOFT_ADS_TESTE_CANAL);
    assert.equal(result.signups[0].cadastros, 3, "total do canal inalterado — soma das 3, independente de utm_campaign");

    assert.equal(result.signupsByCampaign.length, 3);
    const pmax = result.signupsByCampaign.find((s) => s.utmCampaign === "ads-microsoft-2608");
    const search = result.signupsByCampaign.find((s) => s.utmCampaign === "ads-microsoft-2608-search");
    const semCampanha = result.signupsByCampaign.find((s) => s.utmCampaign === "(sem utm_campaign)");
    assert.equal(pmax?.cadastros, 1);
    assert.equal(search?.cadastros, 1);
    assert.equal(semCampanha?.cadastros, 1);

    // Soma da quebra bate com o total — nenhum cadastro perdido na quebra.
    const somaQuebra = result.signupsByCampaign.filter((s) => s.canal === MICROSOFT_ADS_TESTE_CANAL).reduce((acc, s) => acc + s.cadastros, 0);
    assert.equal(somaQuebra, result.signups[0].cadastros);
  });

  it("falha de rede: signupsByCampaign vem [] junto de signups: [] — nunca undefined", async () => {
    const result = await withMockFetch((async () => jsonResponse(500, { error: "boom" })) as typeof fetch, () => fetchKitSignupsByChannel(TEST_CONFIG));
    assert.deepEqual(result.signups, []);
    assert.deepEqual(result.signupsByCampaign, []);
    assert.ok(result.error);
  });

  it("utm_campaign com '|' literal (dado de visitante, nunca sanitizado) não corrompe o canal decodificado (achado do silent-failure-hunter, PR #8450)", async () => {
    const result = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          subscribers: [
            {
              id: 1,
              email_address: "a@b.com",
              state: "active",
              created_at: "2026-09-05T10:00:00.000Z",
              // utm_campaign com pipe embutido — poderia vir de query string
              // pública mal-formada/adversarial. O canal (à esquerda da
              // chave composta) precisa continuar batendo exatamente com
              // MICROSOFT_ADS_TESTE_CANAL mesmo assim.
              fields: { utm_source: "microsoft-ads", utm_campaign: "ads-microsoft-2608|injected" },
            },
          ],
          pagination: emptyPagination,
        })) as typeof fetch,
      () => fetchKitSignupsByChannel(TEST_CONFIG),
    );

    assert.equal(result.error, null);
    assert.equal(result.signupsByCampaign.length, 1);
    assert.equal(result.signupsByCampaign[0].canal, MICROSOFT_ADS_TESTE_CANAL, "canal não pode ser corrompido por '|' dentro de utm_campaign");
    assert.equal(result.signupsByCampaign[0].utmCampaign, "ads-microsoft-2608|injected");
    assert.equal(result.signupsByCampaign[0].date, "2026-09-05");
  });
});

describe("#8256 — fetchCampaignEconomicsSources: propaga signupsByCampaign", () => {
  it("Kit ausente: signupsByCampaign vem [], nunca undefined/throw; Microsoft não é mais fonte (#10755)", async () => {
    const fetchImpl = (async () => jsonResponse(500, { error: "não deveria ser chamado" })) as typeof fetch;
    const result = await fetchCampaignEconomicsSources(fetchImpl, null, { env: {} });
    assert.deepEqual(result.signupsByCampaign, []);
    assert.equal("microsoftCampaignBreakdown" in result, false);
    assert.equal("Microsoft Ads" in result.sources, false);
    assert.match(result.sources.Kit.error ?? "", /KIT_API_KEY/);
  });
});
