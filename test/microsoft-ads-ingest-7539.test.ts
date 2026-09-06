/**
 * test/microsoft-ads-ingest-7539.test.ts (#7539)
 *
 * Cobre a função irmã `fetchMicrosoftAdsPerformanceRows`
 * (`scripts/lib/microsoft-ads-ingest.ts`) — relatório de FECHAMENTO do §4 do
 * protocolo (`data/aquisicao/campanhas-260816/00-PROTOCOLO.md`), distinto do
 * caminho de `spend.csv` (`fetchMicrosoftAdsSpendRows`, coberto por
 * `test/microsoft-ads-ingest-5502.test.ts`). Os 3 testes de regressão
 * exigidos pela issue:
 *
 * 1. Colunas default do caminho de spend continuam `["TimePeriod","Spend"]`
 *    quando nada é passado — o novo caminho de fechamento nunca vaza pra lá.
 * 2. O parser aceita as colunas de share/perda e converte `"88.14%"` pra
 *    number sem perder o sinal de ausência (`undefined`, nunca `0`/`NaN`).
 * 3. `Success` + `ReportDownloadUrl` nil segue vazio legítimo (`{ rows: [] }`),
 *    não erro — invariante do #5928, preservado no caminho novo.
 *
 * Reusa os helpers de mock de `test/microsoft-ads-ingest-5502.test.ts` só
 * que reimplementados aqui (arquivo de teste não importa de outro arquivo de
 * teste, mesma convenção do resto do repo) — nunca chama a API real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import {
  fetchMicrosoftAdsPerformanceRows,
  parseMicrosoftAdsPercent,
  DEFAULT_MICROSOFT_ADS_PERFORMANCE_COLUMNS,
  type MicrosoftAdsAuthConfig,
  type FetchLike,
} from "../scripts/lib/microsoft-ads-ingest.ts";

const AUTH: MicrosoftAdsAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  developerToken: "dev-token",
  customerId: "12345678",
  accountId: "87654321",
};

const DATE_RANGE = { start: new Date("2026-09-05T00:00:00Z"), end: new Date("2026-09-06T00:00:00Z") };
const NO_SLEEP = { sleepImpl: async () => {} };
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

/** Mesmo router de `test/microsoft-ads-ingest-5502.test.ts`, reimplementado
 *  aqui pra este arquivo não depender de outro arquivo de teste. */
function mockReportingFlow(opts: {
  csv?: string;
  pollSuccessWithoutDownloadUrl?: boolean;
  onRequest?: (url: string, init: RequestInit | undefined) => void;
}): FetchLike {
  return async (url, init) => {
    opts.onRequest?.(url, init);
    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }
    if (url === DOWNLOAD_URL) {
      const body = buildTestZip(opts.csv ?? '"TimePeriod","Spend"\r\n"2026-09-05","1.34"\r\n');
      return new Response(new Uint8Array(body), { status: 200 });
    }
    if (url === SERVICE_URL) {
      const body = String(init?.body ?? "");
      if (body.includes(">SubmitGenerateReport<")) {
        return new Response(submitResponseXml("req-1"), { status: 200 });
      }
      if (body.includes(">PollGenerateReport<")) {
        const downloadUrl = opts.pollSuccessWithoutDownloadUrl ? undefined : DOWNLOAD_URL;
        return new Response(pollResponseXml("Success", downloadUrl), { status: 200 });
      }
    }
    throw new Error(`URL/corpo inesperado no mock: ${url} — ${String(init?.body).slice(0, 200)}`);
  };
}

describe("#7539 — parseMicrosoftAdsPercent (pure)", () => {
  it("converte '88.14%' para 88.14", () => {
    assert.equal(parseMicrosoftAdsPercent("88.14%"), 88.14);
  });

  it("aceita também sem o sufixo '%'", () => {
    assert.equal(parseMicrosoftAdsPercent("0.00"), 0);
  });

  it("undefined (coluna ausente) → undefined, nunca 0/NaN", () => {
    assert.equal(parseMicrosoftAdsPercent(undefined), undefined);
  });

  it("string vazia (célula vazia no CSV) → undefined", () => {
    assert.equal(parseMicrosoftAdsPercent(""), undefined);
  });

  it("string não-numérica → undefined, nunca NaN propagado", () => {
    assert.equal(parseMicrosoftAdsPercent("N/A"), undefined);
  });

  it("0% é um valor real — nunca confundido com ausência", () => {
    assert.equal(parseMicrosoftAdsPercent("0.00%"), 0);
    assert.notEqual(parseMicrosoftAdsPercent("0.00%"), undefined);
  });
});

describe("#7539 — fetchMicrosoftAdsPerformanceRows (relatório de fechamento, §4 do protocolo)", () => {
  it("caminho feliz: submete DEFAULT_MICROSOFT_ADS_PERFORMANCE_COLUMNS e converte os percentuais pra number", async () => {
    let submitBody = "";
    const fetchImpl = mockReportingFlow({
      csv:
        '"TimePeriod","CampaignName","Impressions","Clicks","Spend","ImpressionSharePercent","ImpressionLostToBudgetPercent","ImpressionLostToRankAggPercent"\r\n' +
        '"2026-09-05","PMax teste 2608","42","2","1.34","11.86%","0.00%","88.14%"\r\n' +
        '"2026-09-06","PMax teste 2608","18","0","0.00","11.86%","0.00%","88.14%"\r\n',
      onRequest: (url, init) => {
        if (url === SERVICE_URL && String(init?.body ?? "").includes(">SubmitGenerateReport<")) {
          submitBody = String(init?.body);
        }
      },
    });

    const out = await fetchMicrosoftAdsPerformanceRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok(!("error" in out), `esperava sucesso, recebeu erro: ${"error" in out ? out.error : ""}`);
    if ("error" in out) return;

    assert.equal(out.rows.length, 2);
    assert.deepEqual(out.rows[0], {
      TimePeriod: "2026-09-05",
      CampaignName: "PMax teste 2608",
      Impressions: "42",
      Clicks: "2",
      Spend: "1.34",
      ImpressionSharePercent: 11.86,
      ImpressionLostToBudgetPercent: 0,
      ImpressionLostToRankAggPercent: 88.14,
    });

    // As colunas exigidas pelo §4 do protocolo foram de fato submetidas —
    // não só as 2 do caminho de spend.
    for (const col of DEFAULT_MICROSOFT_ADS_PERFORMANCE_COLUMNS) {
      assert.match(submitBody, new RegExp(`<[^>]*CampaignPerformanceReportColumn[^>]*>${col}<`));
    }
  });

  it("achado real da issue: perda por orçamento 0% + perda por ranking 88% — as 2 colunas nunca se confundem", async () => {
    const fetchImpl = mockReportingFlow({
      csv:
        '"TimePeriod","CampaignName","Impressions","Clicks","Spend","ImpressionSharePercent","ImpressionLostToBudgetPercent","ImpressionLostToRankAggPercent"\r\n' +
        '"2026-09-05","PMax teste 2608","42","2","1.34","11.86%","0.00%","88.14%"\r\n',
    });
    const out = await fetchMicrosoftAdsPerformanceRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok(!("error" in out));
    if ("error" in out) return;
    assert.equal(out.rows[0].ImpressionLostToBudgetPercent, 0);
    assert.equal(out.rows[0].ImpressionLostToRankAggPercent, 88.14);
  });

  it("coluna percentual ausente do header (subconjunto de colunas) → campo undefined na linha, não erro", async () => {
    const fetchImpl = mockReportingFlow({
      csv: '"TimePeriod","Spend"\r\n"2026-09-05","1.34"\r\n', // subconjunto — só TimePeriod+Spend
    });
    const out = await fetchMicrosoftAdsPerformanceRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok(!("error" in out));
    if ("error" in out) return;
    assert.equal(out.rows[0].ImpressionLostToBudgetPercent, undefined);
    assert.deepEqual(out.rows, [{ TimePeriod: "2026-09-05", Spend: "1.34" }]);
  });

  it("CSV sem a coluna TimePeriod → { error } (mesma disciplina do caminho de spend, nunca 'zero' silencioso)", async () => {
    const fetchImpl = mockReportingFlow({ csv: '"CampaignName","Spend"\r\n"x","1.00"\r\n' });
    const out = await fetchMicrosoftAdsPerformanceRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
  });

  it("Success + ReportDownloadUrl nil → { rows: [] }, vazio LEGÍTIMO (invariante do #5928, preservada no caminho novo)", async () => {
    const fetchImpl = mockReportingFlow({ pollSuccessWithoutDownloadUrl: true });
    const out = await fetchMicrosoftAdsPerformanceRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.deepEqual(out, { rows: [] });
  });

  it("columns explícito (subconjunto menor que o default) é honrado na submissão", async () => {
    let submitBody = "";
    const fetchImpl = mockReportingFlow({
      csv: '"TimePeriod","Spend"\r\n"2026-09-05","1.34"\r\n',
      onRequest: (url, init) => {
        if (url === SERVICE_URL && String(init?.body ?? "").includes(">SubmitGenerateReport<")) {
          submitBody = String(init?.body);
        }
      },
    });
    const out = await fetchMicrosoftAdsPerformanceRows(fetchImpl, AUTH, "tok", DATE_RANGE, {
      ...NO_SLEEP,
      columns: ["TimePeriod", "Spend"],
    });
    assert.ok(!("error" in out));
    assert.doesNotMatch(submitBody, /ImpressionLostToRankAggPercent/);
  });
});

describe("#7539 — caminho de spend.csv (fetchMicrosoftAdsSpendRows) intocado", () => {
  it("colunas default continuam EXATAMENTE ['TimePeriod','Spend'] — nunca herda as colunas do relatório de fechamento", async () => {
    let submitBody = "";
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      if (url === DOWNLOAD_URL) return new Response(new Uint8Array(buildTestZip('"TimePeriod","Spend"\r\n"2026-09-05","1.34"\r\n')), { status: 200 });
      if (url === SERVICE_URL) {
        const body = String(init?.body ?? "");
        if (body.includes(">SubmitGenerateReport<")) {
          submitBody = body;
          return new Response(submitResponseXml("req-1"), { status: 200 });
        }
        if (body.includes(">PollGenerateReport<")) return new Response(pollResponseXml("Success", DOWNLOAD_URL), { status: 200 });
      }
      throw new Error(`URL inesperada: ${url}`);
    };

    const { fetchMicrosoftAdsSpendRows } = await import("../scripts/lib/microsoft-ads-ingest.ts");
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.deepEqual(out, { rows: [{ TimePeriod: "2026-09-05", Spend: "1.34" }] });

    assert.match(submitBody, /<Columns><CampaignPerformanceReportColumn>TimePeriod<\/CampaignPerformanceReportColumn><CampaignPerformanceReportColumn>Spend<\/CampaignPerformanceReportColumn><\/Columns>/);
    assert.doesNotMatch(submitBody, /CampaignName|ImpressionSharePercent|ImpressionLostToBudgetPercent|ImpressionLostToRankAggPercent/);
  });
});
