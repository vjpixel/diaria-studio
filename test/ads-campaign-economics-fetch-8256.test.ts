/**
 * test/ads-campaign-economics-fetch-8256.test.ts (#8256)
 *
 * Cobre a separação por campanha do braço Microsoft do teste 2608 (PMax
 * 571543153 x Search 571615527) em `scripts/lib/ads-campaign-economics-fetch.ts`:
 *
 * 1. `fetchMicrosoftAdsChannelMetrics` pede `CampaignId` na MESMA chamada
 *    (1 único submit/poll/download) e devolve `metrics` com o total do
 *    braço INALTERADO (soma das campanhas) + `campaignBreakdown` com as
 *    linhas separadas.
 * 2. `fetchKitSignupsByChannel` devolve `signupsByCampaign` (por
 *    `fields.utm_campaign`) além de `signups` (total por canal), sem mudar
 *    `signups`.
 * 3. `fetchCampaignEconomicsSources` propaga os 2 campos novos
 *    (`microsoftCampaignBreakdown`/`signupsByCampaign`), `[]` quando a
 *    fonte correspondente falhou/não rodou.
 *
 * Mock de rede via `fetchImpl`/`globalThis.fetch`, mesmo padrão de
 * `test/ads-campaign-economics-fetch.test.ts` (Kit) e
 * `test/microsoft-ads-ingest-7539.test.ts` (Reporting API, caminho Azure AD)
 * — nunca a API real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import {
  fetchMicrosoftAdsChannelMetrics,
  fetchKitSignupsByChannel,
  fetchCampaignEconomicsSources,
  MICROSOFT_ADS_TESTE_CANAL,
  MICROSOFT_ADS_2608_CAMPAIGN_ID_TO_CANAL,
} from "../scripts/lib/ads-campaign-economics-fetch.ts";
import type { MicrosoftAdsAuthConfig } from "../scripts/lib/microsoft-ads-ingest.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Mock do transporte SOAP do Reporting API (caminho Azure AD, igual
// test/microsoft-ads-ingest-7539.test.ts — reimplementado aqui de propósito,
// arquivo de teste não importa de outro arquivo de teste).
// ---------------------------------------------------------------------------

const AUTH: MicrosoftAdsAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  developerToken: "dev-token",
  customerId: "12345678",
  accountId: "87654321",
};

const SERVICE_URL = "https://reporting.api.bingads.microsoft.com/Api/Advertiser/Reporting/v13/ReportingService.svc";
const DOWNLOAD_URL = "https://reporting-download.bingads.microsoft.com/fake/report.zip";

function buildTestZip(csvContent: string): Buffer {
  const data = Buffer.from(csvContent, "utf8");
  const compressed = deflateRawSync(data);
  const nameBuf = Buffer.from("CampaignPerformanceReport.csv", "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8); // compression method = deflate
  header.writeUInt32LE(0, 14); // crc32 — não validado pelo reader
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuf, compressed]);
}

function submitResponseXml(reportRequestId: string): string {
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><SubmitGenerateReportResponse xmlns="https://bingads.microsoft.com/Reporting/v13"><ReportRequestId>${reportRequestId}</ReportRequestId></SubmitGenerateReportResponse></s:Body></s:Envelope>`;
}

function pollResponseXml(status: string, downloadUrl?: string): string {
  const downloadEl = downloadUrl ? `<ReportDownloadUrl>${downloadUrl}</ReportDownloadUrl>` : "";
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><PollGenerateReportResponse xmlns="https://bingads.microsoft.com/Reporting/v13"><ReportRequestStatus><ReportRequestId>req-1</ReportRequestId><Status>${status}</Status>${downloadEl}</ReportRequestStatus></PollGenerateReportResponse></s:Body></s:Envelope>`;
}

function mockReportingFlow(opts: { csv: string; onRequest?: (url: string, init: RequestInit | undefined) => void }): typeof fetch {
  let submitCalls = 0;
  return (async (url: string, init?: RequestInit) => {
    opts.onRequest?.(url, init);
    if (url.includes("login.microsoftonline.com")) {
      return jsonResponse(200, { access_token: "tok" });
    }
    if (url === DOWNLOAD_URL) {
      return new Response(new Uint8Array(buildTestZip(opts.csv)), { status: 200 });
    }
    if (url === SERVICE_URL) {
      const body = String(init?.body ?? "");
      if (body.includes(">SubmitGenerateReport<")) {
        submitCalls++;
        if (submitCalls > 1) throw new Error("esperava só 1 SubmitGenerateReport — CampaignId deveria vir na MESMA chamada, não numa 2ª");
        return new Response(submitResponseXml("req-1"), { status: 200 });
      }
      if (body.includes(">PollGenerateReport<")) {
        return new Response(pollResponseXml("Success", DOWNLOAD_URL), { status: 200 });
      }
    }
    throw new Error(`URL/corpo inesperado no mock: ${url} — ${String(init?.body).slice(0, 200)}`);
  }) as typeof fetch;
}

describe("#8256 — fetchMicrosoftAdsChannelMetrics: separação PMax x Search", () => {
  const CSV =
    '"TimePeriod","CampaignId","Impressions","Clicks","Spend"\r\n' +
    '"2026-09-05","571543153","10","2","10.00"\r\n' +
    '"2026-09-05","571615527","20","3","15.00"\r\n' +
    '"2026-09-06","571543153","5","1","5.00"\r\n' +
    '"2026-09-06","571615527","8","2","8.00"\r\n';

  it("1 única chamada de rede pede CampaignId, metrics soma o total do braço (inalterado) e campaignBreakdown separa PMax/Search", async () => {
    let submitBody = "";
    const fetchImpl = mockReportingFlow({
      csv: CSV,
      onRequest: (url, init) => {
        if (url === SERVICE_URL && String(init?.body ?? "").includes(">SubmitGenerateReport<")) submitBody = String(init?.body);
      },
    });

    const result = await fetchMicrosoftAdsChannelMetrics(fetchImpl, AUTH, { now: new Date("2026-09-06T12:00:00Z"), lookbackDays: 5 });
    assert.equal(result.error, null);

    // A submissão pediu a coluna nova — regressão contra reverter pra
    // ADS_DASHBOARD_PERFORMANCE_COLUMNS (sem CampaignId), que voltaria a
    // agregar no servidor e impediria a separação.
    assert.match(submitBody, /<CampaignPerformanceReportColumn>CampaignId<\/CampaignPerformanceReportColumn>/);

    // Total do braço: soma das 2 campanhas por dia, EXATAMENTE como a
    // variante sem CampaignId devolvia antes (#8256, "com o total do braço
    // inalterado").
    const byDate = new Map(result.metrics.map((m) => [m.date, m]));
    assert.equal(result.metrics.length, 2);
    assert.equal(byDate.get("2026-09-05")?.canal, MICROSOFT_ADS_TESTE_CANAL);
    assert.equal(byDate.get("2026-09-05")?.gastoBrl, 25);
    assert.equal(byDate.get("2026-09-05")?.cliques, 5);
    assert.equal(byDate.get("2026-09-05")?.impressoes, 30);
    assert.equal(byDate.get("2026-09-06")?.gastoBrl, 13);

    // Quebra por campanha: 4 linhas (2 campanhas x 2 dias), rotuladas.
    assert.equal(result.campaignBreakdown?.length, 4);
    const pmax0905 = result.campaignBreakdown?.find((r) => r.canal === MICROSOFT_ADS_2608_CAMPAIGN_ID_TO_CANAL["571543153"] && r.date === "2026-09-05");
    const search0905 = result.campaignBreakdown?.find((r) => r.canal === MICROSOFT_ADS_2608_CAMPAIGN_ID_TO_CANAL["571615527"] && r.date === "2026-09-05");
    assert.equal(pmax0905?.gastoBrl, 10);
    assert.equal(search0905?.gastoBrl, 15);
  });

  it("token inválido nunca lança — { metrics: [], error }, sem campaignBreakdown", async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: "invalid_grant" })) as typeof fetch;
    const result = await fetchMicrosoftAdsChannelMetrics(fetchImpl, AUTH);
    assert.deepEqual(result.metrics, []);
    assert.ok(result.error);
    assert.equal(result.campaignBreakdown, undefined);
  });
});

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
});

describe("#8256 — fetchCampaignEconomicsSources: propaga os campos novos", () => {
  it("credenciais Microsoft/Kit ausentes: microsoftCampaignBreakdown e signupsByCampaign vêm [], nunca undefined/throw", async () => {
    const fetchImpl = (async () => jsonResponse(500, { error: "não deveria ser chamado" })) as typeof fetch;
    const result = await fetchCampaignEconomicsSources(fetchImpl, null, { env: {} });
    assert.deepEqual(result.microsoftCampaignBreakdown, []);
    assert.deepEqual(result.signupsByCampaign, []);
    assert.match(result.sources["Microsoft Ads"].error ?? "", /MICROSOFT_ADS_/);
    assert.match(result.sources.Kit.error ?? "", /KIT_API_KEY/);
  });
});
