/**
 * cleanup-preflight-subscribers.test.ts (#5545)
 *
 * Cobre decideOutcome (puro) e o fluxo fetchStatus/unsubscribe com fetch
 * mockado — nenhuma chamada de rede real (regra de dispatch overnight/#738).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideOutcome,
  fetchStatus,
  unsubscribe,
  cleanupOneArm,
  formatResultsTable,
  type CleanupResult,
} from "../scripts/cleanup-preflight-subscribers.ts";
import { buildPreflightPlan } from "../scripts/lib/preflight-utm-arms.ts";

describe("decideOutcome (#5545) — pura", () => {
  it("not_found quando status é null (404)", () => {
    assert.equal(decideOutcome(null, true), "not_found");
    assert.equal(decideOutcome(null, false), "not_found");
  });

  it("already_inactive quando já está inactive", () => {
    assert.equal(decideOutcome("inactive", true), "already_inactive");
    assert.equal(decideOutcome("inactive", false), "already_inactive");
  });

  it("unsubscribed quando active e push=true", () => {
    assert.equal(decideOutcome("active", true), "unsubscribed");
  });

  it("skipped_dry_run quando active e push=false", () => {
    assert.equal(decideOutcome("active", false), "skipped_dry_run");
  });

  it("trata qualquer status não-inactive/null como candidato à ação (ex: validating)", () => {
    assert.equal(decideOutcome("validating", true), "unsubscribed");
    assert.equal(decideOutcome("validating", false), "skipped_dry_run");
  });
});

describe("fetchStatus (#5545) — fetch mockado", () => {
  it("retorna null em 404", async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const status = await fetchStatus("pub_1", "key", "a@x.com", fetchImpl);
    assert.equal(status, null);
  });

  it("retorna o status do corpo em 200", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { status: "active" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const status = await fetchStatus("pub_1", "key", "a@x.com", fetchImpl);
    assert.equal(status, "active");
  });

  it("lança em erro HTTP diferente de 404", async () => {
    const fetchImpl = (async () => new Response("erro", { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(() => fetchStatus("pub_1", "key", "a@x.com", fetchImpl));
  });
});

describe("unsubscribe (#5545) — fetch mockado", () => {
  it("faz PUT com unsubscribe:true e não lança em 200", async () => {
    let capturedBody: string | undefined;
    let capturedMethod: string | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      capturedMethod = init?.method;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await unsubscribe("pub_1", "key", "a@x.com", fetchImpl);
    assert.equal(capturedMethod, "PUT");
    assert.deepEqual(JSON.parse(capturedBody ?? "{}"), { unsubscribe: true });
  });

  it("lança em erro HTTP", async () => {
    const fetchImpl = (async () => new Response("erro", { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(() => unsubscribe("pub_1", "key", "a@x.com", fetchImpl));
  });
});

describe("cleanupOneArm (#5545) — fluxo end-to-end com fetch mockado", () => {
  it("dry-run: não chama PUT quando active, reporta skipped_dry_run", async () => {
    const [plan] = buildPreflightPlan("preflight-2608");
    let putCalled = false;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCalled = true;
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ data: { status: "active" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await cleanupOneArm("pub_1", "key", plan, false, fetchImpl);
    assert.equal(putCalled, false);
    assert.equal(result.outcome, "skipped_dry_run");
    assert.equal(result.status_before, "active");
  });

  it("--push: chama PUT quando active, reporta unsubscribed", async () => {
    const [plan] = buildPreflightPlan("preflight-2608");
    let putCalled = false;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCalled = true;
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ data: { status: "active" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await cleanupOneArm("pub_1", "key", plan, true, fetchImpl);
    assert.equal(putCalled, true);
    assert.equal(result.outcome, "unsubscribed");
  });

  it("idempotente: já inactive não chama PUT mesmo com --push", async () => {
    const [plan] = buildPreflightPlan("preflight-2608");
    let putCalled = false;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCalled = true;
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ data: { status: "inactive" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await cleanupOneArm("pub_1", "key", plan, true, fetchImpl);
    assert.equal(putCalled, false);
    assert.equal(result.outcome, "already_inactive");
  });

  it("sem registro (404): NOOP, nunca chama PUT", async () => {
    const [plan] = buildPreflightPlan("preflight-2608");
    let putCalled = false;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCalled = true;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const result = await cleanupOneArm("pub_1", "key", plan, true, fetchImpl);
    assert.equal(putCalled, false);
    assert.equal(result.outcome, "not_found");
  });
});

describe("formatResultsTable (#5545)", () => {
  it("adiciona o aviso de dry-run quando push=false", () => {
    const results: CleanupResult[] = [
      { arm: "google-ads", email: "a@x.com", status_before: "active", outcome: "skipped_dry_run" },
    ];
    const out = formatResultsTable(results, false);
    assert.match(out, /dry-run — nenhuma escrita feita/);
  });

  it("não adiciona o aviso de dry-run quando push=true", () => {
    const results: CleanupResult[] = [
      { arm: "google-ads", email: "a@x.com", status_before: "active", outcome: "unsubscribed" },
    ];
    const out = formatResultsTable(results, true);
    assert.doesNotMatch(out, /dry-run/);
  });
});
