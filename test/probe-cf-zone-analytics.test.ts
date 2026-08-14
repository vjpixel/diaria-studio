/**
 * test/probe-cf-zone-analytics.test.ts (#5247)
 *
 * Cobertura de `scripts/probe-cf-zone-analytics.ts` com `fetch` mockado —
 * mesma disciplina de `check-cloudflare-token.ts`/`worker-drift-check.ts`
 * (REST puro testável sem tocar rede real). Trava a distinção 400
 * (schema ausente) vs 403 (sem escopo) que a issue #5247 pede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveZoneId,
  buildProbeQuery,
  probeHttpRequestsAdaptiveGroups,
} from "../scripts/probe-cf-zone-analytics.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("resolveZoneId", () => {
  it("200 com result[0].id → zoneId resolvido", async () => {
    const fetchFn = (async () => jsonResponse(200, { result: [{ id: "zone123" }] })) as typeof fetch;
    const r = await resolveZoneId("diar.ia.br", "tok", fetchFn);
    assert.equal(r.zoneId, "zone123");
    assert.equal(r.error, null);
  });

  it("200 com result vazio → zoneId null, error explicando zona ausente", async () => {
    const fetchFn = (async () => jsonResponse(200, { result: [] })) as typeof fetch;
    const r = await resolveZoneId("nao-existe.example", "tok", fetchFn);
    assert.equal(r.zoneId, null);
    assert.match(r.error ?? "", /nenhuma zona encontrada/);
  });

  it("403 → zoneId null, httpStatus 403 propagado (caller decide forbidden_scope)", async () => {
    const fetchFn = (async () => jsonResponse(403, { errors: [{ message: "not authorized" }] })) as typeof fetch;
    const r = await resolveZoneId("diar.ia.br", "tok", fetchFn);
    assert.equal(r.zoneId, null);
    assert.equal(r.httpStatus, 403);
  });

  it("erro de rede → zoneId null, error com a mensagem", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const r = await resolveZoneId("diar.ia.br", "tok", fetchFn);
    assert.equal(r.zoneId, null);
    assert.match(r.error ?? "", /network down/);
  });
});

describe("buildProbeQuery", () => {
  it("inclui httpRequestsAdaptiveGroups sem sub-seleção de logs, com as 3 variáveis", () => {
    const { query, variables } = buildProbeQuery("zone123", "2026-08-13T00:00:00.000Z", "2026-08-14T00:00:00.000Z");
    assert.match(query, /httpRequestsAdaptiveGroups/);
    assert.ok(!query.includes("logs"));
    assert.deepEqual(variables, {
      zoneTag: "zone123",
      since: "2026-08-13T00:00:00.000Z",
      until: "2026-08-14T00:00:00.000Z",
    });
  });
});

describe("probeHttpRequestsAdaptiveGroups", () => {
  it("HTTP 403 → status forbidden_scope (não confundir com indisponibilidade do dataset)", async () => {
    const fetchFn = (async () => jsonResponse(403, { errors: [{ message: "Authentication error" }] })) as typeof fetch;
    const r = await probeHttpRequestsAdaptiveGroups("zone123", "tok", fetchFn);
    assert.equal(r.status, "forbidden_scope");
    assert.equal(r.httpStatus, 403);
  });

  it("HTTP 400 com erro de schema → status unavailable_schema (mesma classe do #4382)", async () => {
    const fetchFn = (async () =>
      jsonResponse(400, {
        errors: [{ message: 'Cannot query field "httpRequestsAdaptiveGroups" on type "ZonesFilter".' }],
      })) as typeof fetch;
    const r = await probeHttpRequestsAdaptiveGroups("zone123", "tok", fetchFn);
    assert.equal(r.status, "unavailable_schema");
    assert.equal(r.httpStatus, 400);
  });

  it("HTTP 400 sem sinal claro de unknown field → ainda unavailable_schema, mas detail pede inspeção manual", async () => {
    const fetchFn = (async () => jsonResponse(400, { errors: [{ message: "some other validation error" }] })) as typeof fetch;
    const r = await probeHttpRequestsAdaptiveGroups("zone123", "tok", fetchFn);
    assert.equal(r.status, "unavailable_schema");
    assert.match(r.detail, /inspecionar manualmente/);
  });

  it("HTTP 200 sem errors → status available", async () => {
    const fetchFn = (async () =>
      jsonResponse(200, { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [{ count: 42 }] }] } } })) as typeof fetch;
    const r = await probeHttpRequestsAdaptiveGroups("zone123", "tok", fetchFn);
    assert.equal(r.status, "available");
    assert.equal(r.httpStatus, 200);
  });

  it("HTTP 200 mas com errors no payload → status error (anomalia, não o par 400/403 esperado)", async () => {
    const fetchFn = (async () => jsonResponse(200, { errors: [{ message: "partial failure" }] })) as typeof fetch;
    const r = await probeHttpRequestsAdaptiveGroups("zone123", "tok", fetchFn);
    assert.equal(r.status, "error");
  });

  it("HTTP 5xx → status error", async () => {
    const fetchFn = (async () => new Response("upstream error", { status: 502 })) as typeof fetch;
    const r = await probeHttpRequestsAdaptiveGroups("zone123", "tok", fetchFn);
    assert.equal(r.status, "error");
    assert.equal(r.httpStatus, 502);
  });

  it("erro de rede/timeout → status error", async () => {
    const fetchFn = (async () => {
      throw new Error("timeout");
    }) as typeof fetch;
    const r = await probeHttpRequestsAdaptiveGroups("zone123", "tok", fetchFn);
    assert.equal(r.status, "error");
    assert.match(r.detail, /timeout/);
  });
});
