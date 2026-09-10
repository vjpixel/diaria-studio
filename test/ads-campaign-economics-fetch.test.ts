/**
 * test/ads-campaign-economics-fetch.test.ts (#7536)
 *
 * Cobre `scripts/lib/ads-campaign-economics-fetch.ts` — fail-soft por
 * fonte (Google Ads / Microsoft Ads / Kit), nunca lança, e a atribuição
 * correta de cadastros do Kit por `fields.utm_source` (nunca `attribution`,
 * ver docstring do módulo). Sem rede real — `fetchImpl`/`globalThis.fetch`
 * mockados, mesmo padrão de `test/google-ads-ingest-5237.test.ts`/
 * `test/kit-subscribers.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchGoogleAdsChannelMetrics,
  fetchMicrosoftAdsChannelMetrics,
  fetchMetaAdsChannelMetrics,
  normalizeMetaAdsInsightsRows,
  fetchKitSignupsByChannel,
  fetchCampaignEconomicsSources,
  googleAdsAuthConfigFromEnv,
  microsoftAdsAuthConfigFromEnv,
  metaAdsAuthConfigFromEnv,
  META_ADS_TESTE_CANAL,
} from "../scripts/lib/ads-campaign-economics-fetch.ts";
import type { GoogleAdsAuthConfig } from "../scripts/lib/google-ads-ingest.ts";
import type { MicrosoftAdsAuthConfig } from "../scripts/lib/microsoft-ads-ingest.ts";

const GOOGLE_AUTH: GoogleAdsAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  developerToken: "dev-token",
  loginCustomerId: "6236094249",
  customerId: "2369219639",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("#7536 — fetchGoogleAdsChannelMetrics", () => {
  it("token OK + GAQL OK: normaliza pra ChannelDailyMetric[], marca fetchedAt", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("oauth2.googleapis.com")) return jsonResponse(200, { access_token: "tok" });
      return jsonResponse(200, {
        results: [
          { segments: { date: "2026-01-01" }, metrics: { costMicros: "1000000", clicks: "5", impressions: "100" } },
        ],
      });
    }) as typeof fetch;

    const result = await fetchGoogleAdsChannelMetrics(fetchImpl, GOOGLE_AUTH, { now: new Date("2026-01-02T00:00:00Z") });
    assert.equal(result.error, null);
    assert.equal(result.metrics.length, 1);
    assert.equal(result.metrics[0].canal, "Google Ads (teste 2608)");
    assert.equal(result.metrics[0].gastoBrl, 1);
    assert.equal(result.metrics[0].cliques, 5);
    assert.equal(result.metrics[0].impressoes, 100);
    assert.ok(result.fetchedAt);
  });

  it("falha de auth nunca lança — vira { metrics: [], error }", async () => {
    const fetchImpl = (async () => jsonResponse(401, { error: "invalid_grant" })) as typeof fetch;
    const result = await fetchGoogleAdsChannelMetrics(fetchImpl, GOOGLE_AUTH);
    assert.deepEqual(result.metrics, []);
    assert.ok(result.error);
    assert.equal(result.fetchedAt, null);
  });
});

describe("#7536 — fetchMicrosoftAdsChannelMetrics", () => {
  const AUTH: MicrosoftAdsAuthConfig = {
    developerToken: "dev-token",
    customerId: "123",
    accountId: "456",
    googleClientId: "gcid",
    googleClientSecret: "gsecret",
    googleRefreshToken: "grefresh",
  };

  it("falha de auth nunca lança — vira { metrics: [], error }", async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: "invalid_grant" })) as typeof fetch;
    const result = await fetchMicrosoftAdsChannelMetrics(fetchImpl, AUTH);
    assert.deepEqual(result.metrics, []);
    assert.ok(result.error);
  });
});

describe("#7536 — fetchMetaAdsChannelMetrics / normalizeMetaAdsInsightsRows", () => {
  it("insights OK: normaliza pra ChannelDailyMetric[], marca fetchedAt", async () => {
    const fetchImpl = (async (url: string) => {
      assert.match(url, /act_10151064543294811\/insights/);
      assert.doesNotMatch(url, /access_token=/);
      return jsonResponse(200, {
        data: [{ date_start: "2026-01-01", date_stop: "2026-01-01", spend: "87.65", clicks: "92", impressions: "2202" }],
        paging: {},
      });
    }) as typeof fetch;

    const result = await fetchMetaAdsChannelMetrics(fetchImpl, "tok-123", { now: new Date("2026-01-02T00:00:00Z") });
    assert.equal(result.error, null);
    assert.equal(result.metrics.length, 1);
    assert.equal(result.metrics[0].canal, META_ADS_TESTE_CANAL);
    assert.equal(result.metrics[0].gastoBrl, 87.65);
    assert.equal(result.metrics[0].cliques, 92);
    assert.equal(result.metrics[0].impressoes, 2202);
    assert.ok(result.fetchedAt);
  });

  it("segue paginação via paging.next até esgotar", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      if (url.includes("page2marker")) {
        return jsonResponse(200, { data: [{ date_start: "2026-01-02", spend: "10", clicks: "1", impressions: "10" }], paging: {} });
      }
      return jsonResponse(200, {
        data: [{ date_start: "2026-01-01", spend: "20", clicks: "2", impressions: "20" }],
        paging: { next: "https://graph.facebook.com/v21.0/act_x/insights?after=page2marker" },
      });
    }) as typeof fetch;

    const result = await fetchMetaAdsChannelMetrics(fetchImpl, "tok", { now: new Date("2026-01-02T00:00:00Z") });
    assert.equal(calls, 2);
    assert.equal(result.metrics.length, 2);
    assert.equal(result.error, null);
  });

  it("#7893 — token vai no header Authorization, nunca na query string, em TODAS as páginas", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls++;
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.Authorization, "Bearer segredo-nao-vaza");
      assert.doesNotMatch(url, /access_token=/);
      // A URL, mesmo capturada bruta (ex: por um `String(err)` de exceção
      // de fetch), nunca contém o token — só o header carrega o segredo.
      assert.doesNotMatch(url, /segredo-nao-vaza/);
      if (url.includes("page2marker")) {
        return jsonResponse(200, { data: [{ date_start: "2026-01-02", spend: "1", clicks: "1", impressions: "1" }], paging: {} });
      }
      return jsonResponse(200, {
        data: [{ date_start: "2026-01-01", spend: "1", clicks: "1", impressions: "1" }],
        paging: { next: "https://graph.facebook.com/v21.0/act_x/insights?after=page2marker" },
      });
    }) as typeof fetch;

    const result = await fetchMetaAdsChannelMetrics(fetchImpl, "segredo-nao-vaza", { now: new Date("2026-01-02T00:00:00Z") });
    assert.equal(calls, 2);
    assert.equal(result.error, null);
  });

  it("erro do Graph API (payload.error) nunca lança — vira { metrics: [], error }", async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: { message: "Invalid OAuth access token", code: 190 } })) as typeof fetch;
    const result = await fetchMetaAdsChannelMetrics(fetchImpl, "tok-invalido");
    assert.deepEqual(result.metrics, []);
    assert.match(result.error ?? "", /Invalid OAuth access token/);
    assert.equal(result.fetchedAt, null);
  });

  it("falha de rede nunca lança — vira { metrics: [], error }", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const result = await fetchMetaAdsChannelMetrics(fetchImpl, "tok");
    assert.deepEqual(result.metrics, []);
    assert.match(result.error ?? "", /ECONNRESET/);
  });

  it("corpo não-JSON nunca lança — vira { metrics: [], error }", async () => {
    const fetchImpl = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    const result = await fetchMetaAdsChannelMetrics(fetchImpl, "tok");
    assert.deepEqual(result.metrics, []);
    assert.ok(result.error);
  });

  it("linha sem date_start reconhecível é descartada, nunca contamina como 0", () => {
    const out = normalizeMetaAdsInsightsRows(
      [
        { date_start: "2026-01-01", spend: "5", clicks: "1", impressions: "10" },
        { spend: "999" }, // sem date_start — descartada
        { date_start: "not-a-date", spend: "1" }, // formato inválido — descartada
      ],
      "canal-x",
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].date, "2026-01-01");
  });

  it("paginação sem fim (paging.next sempre presente) excede maxPages -> { metrics: [], error }, nunca loop infinito", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      // Sempre devolve paging.next apontando pra si mesmo — nunca termina
      // por conta própria; só o guard maxPages deveria interromper.
      return jsonResponse(200, {
        data: [{ date_start: "2026-01-01", spend: "1", clicks: "1", impressions: "1" }],
        paging: { next: "https://graph.facebook.com/v21.0/act_x/insights?after=loop" },
      });
    }) as typeof fetch;

    const result = await fetchMetaAdsChannelMetrics(fetchImpl, "tok", { now: new Date("2026-01-02T00:00:00Z"), maxPages: 3 });
    assert.deepEqual(result.metrics, []);
    assert.equal(result.fetchedAt, null);
    assert.match(result.error ?? "", /maxPages=3/);
    assert.equal(calls, 3);
  });
});

describe("#7536 — metaAdsAuthConfigFromEnv", () => {
  it("META_ADS_ACCESS_TOKEN presente -> auth completo", () => {
    const result = metaAdsAuthConfigFromEnv({ META_ADS_ACCESS_TOKEN: "tok" });
    assert.deepEqual(result, { auth: { accessToken: "tok" } });
  });

  it("META_ADS_ACCESS_TOKEN ausente -> missing", () => {
    const result = metaAdsAuthConfigFromEnv({});
    assert.deepEqual(result, { missing: ["META_ADS_ACCESS_TOKEN"] });
  });
});

describe("#7536 — fetchKitSignupsByChannel", () => {
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

  it("conta cadastros por dia+canal a partir de fields.utm_source, ignora attribution e utm_source desconhecido", async () => {
    const result = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          subscribers: [
            {
              id: 1,
              email_address: "a@b.com",
              state: "active",
              created_at: "2026-01-05T10:00:00.000Z",
              fields: { utm_source: "google-ads" },
              attribution: { utm_source: null, referrer: "https://diar-ia-br.kit.com/" },
            },
            {
              id: 2,
              email_address: "c@d.com",
              state: "active",
              created_at: "2026-01-05T11:00:00.000Z",
              fields: { utm_source: "microsoft-ads" },
            },
            {
              id: 3,
              email_address: "e@f.com",
              state: "active",
              created_at: "2026-01-06T10:00:00.000Z",
              fields: { utm_source: "google-ads" },
            },
            {
              // Sem utm_source reconhecido — orgânico, não deve contar.
              id: 4,
              email_address: "g@h.com",
              state: "active",
              created_at: "2026-01-06T10:00:00.000Z",
              fields: {},
            },
            {
              id: 5,
              email_address: "i@j.com",
              state: "active",
              created_at: "2026-01-07T10:00:00.000Z",
              fields: { utm_source: "meta-ads" },
            },
          ],
          pagination: emptyPagination,
        })) as typeof fetch,
      () => fetchKitSignupsByChannel(TEST_CONFIG),
    );

    assert.equal(result.error, null);
    assert.equal(result.signups.length, 4);
    const googleD1 = result.signups.find((s) => s.canal === "Google Ads (teste 2608)" && s.date === "2026-01-05");
    const msD1 = result.signups.find((s) => s.canal === "Microsoft Ads (teste 2608)" && s.date === "2026-01-05");
    const googleD2 = result.signups.find((s) => s.canal === "Google Ads (teste 2608)" && s.date === "2026-01-06");
    const metaD3 = result.signups.find((s) => s.canal === META_ADS_TESTE_CANAL && s.date === "2026-01-07");
    assert.equal(googleD1?.cadastros, 1);
    assert.equal(msD1?.cadastros, 1);
    assert.equal(googleD2?.cadastros, 1);
    assert.equal(metaD3?.cadastros, 1);
  });

  it("dateRangeStart filtra cadastros anteriores ao início do teste", async () => {
    const result = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          subscribers: [
            { id: 1, email_address: "a@b.com", state: "active", created_at: "2025-12-01T00:00:00.000Z", fields: { utm_source: "google-ads" } },
            { id: 2, email_address: "b@c.com", state: "active", created_at: "2026-01-05T00:00:00.000Z", fields: { utm_source: "google-ads" } },
          ],
          pagination: emptyPagination,
        })) as typeof fetch,
      () => fetchKitSignupsByChannel(TEST_CONFIG, { dateRangeStart: "2026-01-01" }),
    );
    assert.equal(result.signups.length, 1);
    assert.equal(result.signups[0].date, "2026-01-05");
  });

  it("has_next_page sem end_cursor -> erro explícito, nunca trata como fim de lista (guard #7200/#6491)", async () => {
    const result = await withMockFetch(
      (async () =>
        jsonResponse(200, {
          subscribers: [],
          pagination: { ...emptyPagination, has_next_page: true, end_cursor: null },
        })) as typeof fetch,
      () => fetchKitSignupsByChannel(TEST_CONFIG),
    );
    assert.deepEqual(result.signups, []);
    assert.match(result.error ?? "", /end_cursor/);
  });

  it("falha de rede/HTTP nunca lança — vira { signups: [], error }", async () => {
    const result = await withMockFetch(
      (async () => jsonResponse(500, { error: "internal" })) as typeof fetch,
      () => fetchKitSignupsByChannel(TEST_CONFIG),
    );
    assert.deepEqual(result.signups, []);
    assert.ok(result.error);
  });
});

describe("#7536 — googleAdsAuthConfigFromEnv / microsoftAdsAuthConfigFromEnv", () => {
  it("Google: todas as vars presentes -> auth completo", () => {
    const result = googleAdsAuthConfigFromEnv({
      GOOGLE_ADS_DEVELOPER_TOKEN: "dt",
      GOOGLE_ADS_CLIENT_ID: "ci",
      GOOGLE_ADS_CLIENT_SECRET: "cs",
      GOOGLE_ADS_REFRESH_TOKEN: "rt",
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1",
      GOOGLE_ADS_CUSTOMER_ID: "2",
    });
    assert.ok("auth" in result);
  });

  it("Google: env vazio -> missing lista as 6 vars", () => {
    const result = googleAdsAuthConfigFromEnv({});
    assert.ok("missing" in result);
    if ("missing" in result) assert.equal(result.missing.length, 6);
  });

  it("Microsoft: caminho Google completo -> auth, sem exigir Azure AD", () => {
    const result = microsoftAdsAuthConfigFromEnv({
      MICROSOFT_ADS_DEVELOPER_TOKEN: "dt",
      MICROSOFT_ADS_CUSTOMER_ID: "c",
      MICROSOFT_ADS_ACCOUNT_ID: "a",
      GOOGLE_CLIENT_ID: "gci",
      GOOGLE_CLIENT_SECRET: "gcs",
      MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN: "grt",
    });
    assert.ok("auth" in result);
    if ("auth" in result) assert.equal(result.auth.googleRefreshToken, "grt");
  });

  it("Microsoft: nem Google nem Azure completos -> missing concatena os 2 conjuntos", () => {
    const result = microsoftAdsAuthConfigFromEnv({
      MICROSOFT_ADS_DEVELOPER_TOKEN: "dt",
      MICROSOFT_ADS_CUSTOMER_ID: "c",
      MICROSOFT_ADS_ACCOUNT_ID: "a",
    });
    assert.ok("missing" in result);
    if ("missing" in result) assert.equal(result.missing.length, 5); // 3 Google + 2 Azure
  });
});

describe("#7536 — fetchCampaignEconomicsSources", () => {
  const TEST_CONFIG = { apiKey: "kit_test_key" };
  const emptyPagination = { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 };

  it("credenciais Google/Microsoft ausentes + Kit ok: sources reporta os 2 erros, metrics vazio, signups do Kit presentes", async () => {
    // Kit vai por `kitFetch` (global `fetch`), não pelo `fetchImpl` injetado
    // (esse só serve Google/Microsoft) — mesmo padrão de `withMockFetch`
    // usado no describe de `fetchKitSignupsByChannel` acima.
    const fetchImpl = (async () => jsonResponse(200, { results: [] })) as typeof fetch;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        subscribers: [{ id: 1, email_address: "a@b.com", state: "active", created_at: "2026-01-05T00:00:00.000Z", fields: { utm_source: "google-ads" } }],
        pagination: emptyPagination,
      })) as typeof fetch;

    let result: Awaited<ReturnType<typeof fetchCampaignEconomicsSources>>;
    try {
      result = await fetchCampaignEconomicsSources(fetchImpl, TEST_CONFIG, { env: {} });
    } finally {
      globalThis.fetch = orig;
    }
    assert.deepEqual(result.metrics, []);
    assert.equal(result.signups.length, 1);
    assert.match(result.sources["Google Ads"].error ?? "", /GOOGLE_ADS_/);
    assert.match(result.sources["Microsoft Ads"].error ?? "", /MICROSOFT_ADS_/);
    assert.match(result.sources["Meta Ads"].error ?? "", /META_ADS_/);
    assert.equal(result.sources["Kit"].error, null);
  });

  it("kitConfig null (sem KIT_API_KEY): sources.Kit reporta erro, signups vazio", async () => {
    const fetchImpl = (async () => jsonResponse(200, { results: [] })) as typeof fetch;
    const result = await fetchCampaignEconomicsSources(fetchImpl, null, { env: {} });
    assert.deepEqual(result.signups, []);
    assert.match(result.sources["Kit"].error ?? "", /KIT_API_KEY/);
  });

  it("META_ADS_ACCESS_TOKEN presente: fonte Meta Ads entra em metrics junto de Google/Microsoft", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("oauth2.googleapis.com")) return jsonResponse(200, { access_token: "tok" });
      if (url.includes("graph.facebook.com")) {
        return jsonResponse(200, { data: [{ date_start: "2026-01-05", spend: "42", clicks: "4", impressions: "40" }], paging: {} });
      }
      // Google/Microsoft GAQL/Reporting API — sem credencial completa nesta chamada, então nunca alcançado.
      return jsonResponse(200, { results: [] });
    }) as typeof fetch;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(200, { subscribers: [], pagination: emptyPagination })) as typeof fetch;

    let result: Awaited<ReturnType<typeof fetchCampaignEconomicsSources>>;
    try {
      result = await fetchCampaignEconomicsSources(fetchImpl, null, { env: { META_ADS_ACCESS_TOKEN: "tok-meta" } });
    } finally {
      globalThis.fetch = orig;
    }
    assert.equal(result.sources["Meta Ads"].error, null);
    assert.equal(result.metrics.length, 1);
    assert.equal(result.metrics[0].canal, "Meta Ads (teste 2608)");
  });
});
