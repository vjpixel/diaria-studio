/**
 * test/ga4-ingest-5248.test.ts (#5248)
 *
 * Cobre `scripts/lib/ga4-ingest.ts`: parsing de `runReport` (dimension/
 * metric headers posicionais → objetos nomeados) e o caminho fail-soft
 * (mesma disciplina de `test/google-ads-ingest-5237.test.ts`) que precisa
 * devolver `{ kind: "fallback" }` em vez de lançar sempre que rede/auth
 * falha — nunca chama a API real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseGa4RunReportRows,
  refreshGa4AccessToken,
  fetchGa4Report,
  runGa4Ingest,
  type Ga4RunReportApiResponse,
  type Ga4AuthConfig,
  type FetchLike,
} from "../scripts/lib/ga4-ingest.ts";

const AUTH: Ga4AuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  propertyId: "378028168",
};

describe("#5248 — parseGa4RunReportRows", () => {
  it("combina dimension/metric headers posicionais em objetos nomeados", () => {
    const response: Ga4RunReportApiResponse = {
      dimensionHeaders: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
      metricHeaders: [{ name: "activeUsers" }, { name: "sessions" }],
      rows: [
        {
          dimensionValues: [{ value: "20260815" }, { value: "Direct" }],
          metricValues: [{ value: "42" }, { value: "50" }],
        },
        {
          dimensionValues: [{ value: "20260814" }, { value: "Email" }],
          metricValues: [{ value: "10" }, { value: "12" }],
        },
      ],
    };

    const out = parseGa4RunReportRows(response);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], {
      date: "20260815",
      sessionDefaultChannelGroup: "Direct",
      activeUsers: "42",
      sessions: "50",
    });
    assert.equal(out[1].date, "20260814");
  });

  it("sem rows produz lista vazia", () => {
    assert.deepEqual(parseGa4RunReportRows({ dimensionHeaders: [], metricHeaders: [], rows: [] }), []);
  });

  it("resposta totalmente vazia (nem headers) não lança", () => {
    assert.deepEqual(parseGa4RunReportRows({}), []);
  });

  it("linha sem dimensionValues/metricValues é ignorada, não preenchida com undefined", () => {
    const response: Ga4RunReportApiResponse = {
      dimensionHeaders: [{ name: "date" }],
      metricHeaders: [{ name: "activeUsers" }],
      rows: [{}, { dimensionValues: [{ value: "20260815" }], metricValues: [{ value: "1" }] }],
    };
    const out = parseGa4RunReportRows(response);
    assert.equal(out.length, 1);
    assert.equal(out[0].date, "20260815");
  });
});

describe("#5248 — refreshGa4AccessToken (fail-soft)", () => {
  it("sucesso devolve o access_token", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ access_token: "tok-123" }), { status: 200 });
    const out = await refreshGa4AccessToken(fetchImpl, AUTH);
    assert.deepEqual(out, { accessToken: "tok-123" });
  });

  it("falha de rede nunca lança — devolve { error }", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const out = await refreshGa4AccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
    assert.match(out.error, /ECONNREFUSED/);
  });

  it("resposta HTTP de erro (sem access_token) devolve { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ error_description: "invalid_grant" }), { status: 400 });
    const out = await refreshGa4AccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
    assert.match(out.error, /invalid_grant/);
  });

  it("corpo não-JSON (ex: HTML de proxy) devolve { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () => new Response("<html>502</html>", { status: 502 });
    const out = await refreshGa4AccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
  });
});

describe("#5248 — fetchGa4Report (fail-soft)", () => {
  const reportRequest = { dateRanges: [{ startDate: "30daysAgo", endDate: "today" }], metrics: [{ name: "activeUsers" }] };

  it("sucesso devolve o payload de runReport", async () => {
    const payload: Ga4RunReportApiResponse = { rows: [] };
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify(payload), { status: 200 });
    const out = await fetchGa4Report(fetchImpl, AUTH, "tok", reportRequest);
    assert.deepEqual(out, { response: payload });
  });

  it("quota/auth error (HTTP não-2xx) vira { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ error: { code: 429, message: "Quota exceeded" } }), { status: 429 });
    const out = await fetchGa4Report(fetchImpl, AUTH, "tok", reportRequest);
    assert.ok("error" in out);
    assert.match(out.error, /429/);
  });

  it("falha de rede nunca lança", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const out = await fetchGa4Report(fetchImpl, AUTH, "tok", reportRequest);
    assert.ok("error" in out);
  });

  it("corpo não-JSON devolve { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () => new Response("not json", { status: 200 });
    const out = await fetchGa4Report(fetchImpl, AUTH, "tok", reportRequest);
    assert.ok("error" in out);
  });
});

describe("#5248 — runGa4Ingest (orquestração end-to-end, fail-soft)", () => {
  it("caminho feliz: token + runReport OK produz rows nomeadas + snapshotAt", async () => {
    let call = 0;
    const fetchImpl: FetchLike = async (url) => {
      call++;
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          dimensionHeaders: [{ name: "date" }],
          metricHeaders: [{ name: "activeUsers" }],
          rows: [{ dimensionValues: [{ value: "20260815" }], metricValues: [{ value: "42" }] }],
        }),
        { status: 200 },
      );
    };

    const result = await runGa4Ingest(fetchImpl, { auth: AUTH, now: () => new Date("2026-08-16T12:00:00Z") });
    assert.equal(call, 2);
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].activeUsers, "42");
      assert.equal(result.snapshotAt, "2026-08-16T12:00:00.000Z");
    }
  });

  it("falha de token (auth ausente/expirada) → fallback, nunca lança", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const result = await runGa4Ingest(fetchImpl, { auth: AUTH });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.match(result.reason, /ETIMEDOUT/);
  });

  it("token OK mas runReport falha (quota) → fallback, nunca lança", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { code: 429 } }), { status: 429 });
    };
    const result = await runGa4Ingest(fetchImpl, { auth: AUTH });
    assert.equal(result.kind, "fallback");
  });
});
