/**
 * test/ga4-client-5248.test.ts (#5248)
 *
 * Cobre `scripts/lib/ga4-client.ts` (cliente da GA4 Data API) e
 * `scripts/ga4-sync.ts` (montagem dos requests de ingestão). Nenhum teste
 * aqui chama a rede — `fetchImpl` é sempre um fake, mesmo padrão de
 * `test/postmaster-v2-client.test.ts` (regra do dispatch #5248: NUNCA chamar
 * a API real do GA4 nesta unidade).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveGa4PropertyId,
  buildRunReportBody,
  extractReportRows,
  describeGa4Failure,
  runGa4Report,
  Ga4ConfigError,
  GA4_PROPERTY_ID_ENV,
  type Ga4RunReportResponse,
} from "../scripts/lib/ga4-client.ts";
import { buildSyncRequests } from "../scripts/ga4-sync.ts";

describe("#5248 — resolveGa4PropertyId", () => {
  it("lança Ga4ConfigError com mensagem apontando pro doc de setup quando ausente", () => {
    assert.throws(
      () => resolveGa4PropertyId({}),
      (e: unknown) => {
        assert.ok(e instanceof Ga4ConfigError);
        assert.match((e as Error).message, /GA4_PROPERTY_ID/);
        assert.match((e as Error).message, /docs\/ga4-data-api-setup\.md/);
        return true;
      },
    );
  });

  it("lança quando a var está presente mas vazia/espaço", () => {
    assert.throws(() => resolveGa4PropertyId({ [GA4_PROPERTY_ID_ENV]: "   " }));
  });

  it("retorna o valor (trimado) quando presente", () => {
    assert.equal(resolveGa4PropertyId({ [GA4_PROPERTY_ID_ENV]: " 123456789 " }), "123456789");
  });
});

describe("#5248 — buildRunReportBody", () => {
  it("monta dimensions/metrics/dateRanges no formato da Data API", () => {
    const body = buildRunReportBody({
      propertyId: "123",
      dimensions: ["date"],
      metrics: ["sessions"],
      dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
    });
    assert.deepEqual(body, {
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }],
      dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
    });
  });

  it("inclui limit só quando passado", () => {
    const body = buildRunReportBody({
      propertyId: "123",
      dimensions: ["pagePath"],
      metrics: ["screenPageViews"],
      dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
      limit: 25,
    });
    assert.equal((body as { limit: string }).limit, "25");
  });

  it("rejeita 0 dimensions E 0 metrics", () => {
    assert.throws(() =>
      buildRunReportBody({ propertyId: "123", dimensions: [], metrics: [], dateRanges: [{ startDate: "a", endDate: "b" }] }),
    );
  });

  it("rejeita dateRanges vazio", () => {
    assert.throws(() => buildRunReportBody({ propertyId: "123", dimensions: ["date"], metrics: [], dateRanges: [] }));
  });
});

describe("#5248 — extractReportRows", () => {
  it("achata rows usando os headers pra nomear dimension/metric", () => {
    const res: Ga4RunReportResponse = {
      dimensionHeaders: [{ name: "pagePath" }],
      metricHeaders: [{ name: "screenPageViews" }, { name: "averageSessionDuration" }],
      rows: [
        {
          dimensionValues: [{ value: "/" }],
          metricValues: [{ value: "120" }, { value: "45.2" }],
        },
        {
          dimensionValues: [{ value: "/privacidade" }],
          metricValues: [{ value: "5" }, { value: "12.0" }],
        },
      ],
    };
    assert.deepEqual(extractReportRows(res), [
      { pagePath: "/", screenPageViews: "120", averageSessionDuration: "45.2" },
      { pagePath: "/privacidade", screenPageViews: "5", averageSessionDuration: "12.0" },
    ]);
  });

  it("rows/headers ausentes devolvem array vazio, nunca lança (janela sem dado ainda)", () => {
    assert.deepEqual(extractReportRows({}), []);
    assert.deepEqual(extractReportRows({ rowCount: 0 }), []);
  });
});

describe("#5248 — describeGa4Failure", () => {
  it("scope insuficiente aponta pro oauth-setup + doc", () => {
    const msg = describeGa4Failure(403, '{"error":{"message":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}}');
    assert.match(msg, /analytics\.readonly/);
    assert.match(msg, /oauth-setup/);
    assert.match(msg, /docs\/ga4-data-api-setup\.md/);
  });

  it("API desabilitada no projeto GCP", () => {
    const msg = describeGa4Failure(403, '{"error":{"message":"Google Analytics Data API has not been used in project 123"}}');
    assert.match(msg, /não habilitada/);
  });

  it("401 aponta reautenticação", () => {
    assert.match(describeGa4Failure(401, "nope"), /oauth-setup/);
  });

  it("404 orienta a diferença Property ID vs Measurement ID", () => {
    const msg = describeGa4Failure(404, "not found");
    assert.match(msg, /Property ID/);
    assert.match(msg, /Measurement ID/);
  });

  it("403 sem código conhecido orienta checar permissão de leitura", () => {
    const msg = describeGa4Failure(403, "algo genérico");
    assert.match(msg, /Gerenciamento de acesso/);
  });

  it("429 explica cota", () => {
    assert.match(describeGa4Failure(429, ""), /cota/);
  });

  it("status desconhecido cai no fallback genérico com o corpo", () => {
    const msg = describeGa4Failure(500, "boom");
    assert.match(msg, /HTTP 500/);
    assert.match(msg, /boom/);
  });
});

describe("#5248 — runGa4Report", () => {
  it("retorna o JSON parseado em caso de sucesso", async () => {
    const fakeFetch = async (url: string) => {
      assert.match(url, /properties\/123:runReport$/);
      return new Response(JSON.stringify({ rowCount: 1, rows: [] }), { status: 200 });
    };
    const res = await runGa4Report(
      { propertyId: "123", dimensions: ["date"], metrics: ["sessions"], dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }] },
      fakeFetch,
    );
    assert.equal(res.rowCount, 1);
  });

  it("lança com a mensagem fail-soft quando a API responde erro", async () => {
    const fakeFetch = async () => new Response('{"error":{"message":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}}', { status: 403 });
    await assert.rejects(
      runGa4Report(
        { propertyId: "123", dimensions: ["date"], metrics: [], dateRanges: [{ startDate: "a", endDate: "b" }] },
        fakeFetch,
      ),
      /analytics\.readonly/,
    );
  });

  it("lança quando a resposta 2xx não é JSON válido", async () => {
    const fakeFetch = async () => new Response("<html>não é json</html>", { status: 200 });
    await assert.rejects(
      runGa4Report(
        { propertyId: "123", dimensions: ["date"], metrics: [], dateRanges: [{ startDate: "a", endDate: "b" }] },
        fakeFetch,
      ),
      /não é JSON válido/,
    );
  });
});

describe("#5248 — buildSyncRequests (ga4-sync.ts)", () => {
  it("monta overview (por data) e topPages (por pagePath, com limit)", () => {
    const { overview, topPages } = buildSyncRequests("999", 7);
    assert.equal(overview.propertyId, "999");
    assert.deepEqual(overview.dimensions, ["date"]);
    assert.deepEqual(overview.dateRanges, [{ startDate: "7daysAgo", endDate: "yesterday" }]);
    assert.ok(overview.metrics.includes("sessions"));

    assert.deepEqual(topPages.dimensions, ["pagePath"]);
    assert.ok(typeof topPages.limit === "number" && topPages.limit > 0);
  });

  it("respeita a janela --days passada", () => {
    const { overview } = buildSyncRequests("999", 30);
    assert.deepEqual(overview.dateRanges, [{ startDate: "30daysAgo", endDate: "yesterday" }]);
  });
});
