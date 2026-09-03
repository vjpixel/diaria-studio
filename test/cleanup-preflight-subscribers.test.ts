/**
 * cleanup-preflight-subscribers.test.ts (#5545, migrado pro Kit no #7359)
 *
 * Cobre decideOutcome (puro) e o fluxo end-to-end (cleanupOneArm) com fetch
 * mockado contra os endpoints Kit — nenhuma chamada de rede real (regra de
 * dispatch overnight/#738).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideOutcome,
  cleanupOneArm,
  formatResultsTable,
  buildAdhocPlan,
  type CleanupResult,
} from "../scripts/cleanup-preflight-subscribers.ts";
import { buildPreflightPlan } from "../scripts/lib/preflight-utm-arms.ts";
import type { KitConfig } from "../scripts/lib/kit-config.ts";

const FAKE_CONFIG: KitConfig = { apiKey: "kit_test_key" };

describe("decideOutcome (#5545) — pura", () => {
  it("not_found quando status é null (sem registro)", () => {
    assert.equal(decideOutcome(null, true), "not_found");
    assert.equal(decideOutcome(null, false), "not_found");
  });

  it("already_inactive quando já cancelled/bounced/complained", () => {
    for (const s of ["cancelled", "bounced", "complained"]) {
      assert.equal(decideOutcome(s, true), "already_inactive");
      assert.equal(decideOutcome(s, false), "already_inactive");
    }
  });

  it("unsubscribed quando active e push=true", () => {
    assert.equal(decideOutcome("active", true), "unsubscribed");
  });

  it("skipped_dry_run quando active e push=false", () => {
    assert.equal(decideOutcome("active", false), "skipped_dry_run");
  });

  it("trata inactive (double opt-in pendente) como candidato à ação, não como já-limpo", () => {
    // Diferente da Beehiiv (onde "inactive" já significava fora da base),
    // no Kit "inactive" é double opt-in pendente — ainda membro da base
    // (ver KIT_EXITED_STATES em kit-subscribers-ingest.ts).
    assert.equal(decideOutcome("inactive", true), "unsubscribed");
    assert.equal(decideOutcome("inactive", false), "skipped_dry_run");
  });
});

// Mock de `kitFetch` via `globalThis.fetch` — GET /subscribers?email_address=...
// devolve o subscriber (ou lista vazia pra "não encontrado"); POST
// /subscribers/{id}/unsubscribe é a mutação sob teste.
function mockKitFetch(opts: {
  state: string | null; // null = não encontrado
  onUnsubscribe?: () => void;
}) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST" && u.includes("/unsubscribe")) {
      opts.onUnsubscribe?.();
      return new Response(null, { status: 204 });
    }
    if (opts.state === null) {
      return new Response(
        JSON.stringify({ subscribers: [], pagination: { has_next_page: false, end_cursor: null } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // #7373 review: `getKitSubscriberByEmail` agora exige match EXATO de
    // e-mail (senão lança) — o mock precisa devolver o mesmo e-mail que foi
    // buscado, não um hardcoded "a@x.com" alheio a toda query.
    const queriedEmail = new URL(u, "https://api.kit.com").searchParams.get("email_address") ?? "a@x.com";
    return new Response(
      JSON.stringify({
        subscribers: [{ id: 42, email_address: queriedEmail, state: opts.state, created_at: "x", fields: {} }],
        pagination: { has_next_page: false, end_cursor: null },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = orig; } };
}

describe("cleanupOneArm (#5545, Kit desde #7359) — fluxo end-to-end com fetch mockado", () => {
  it("dry-run: não chama unsubscribe quando active, reporta skipped_dry_run", async () => {
    const [plan] = buildPreflightPlan("preflight-2609");
    let unsubCalled = false;
    const m = mockKitFetch({ state: "active", onUnsubscribe: () => { unsubCalled = true; } });
    try {
      const result = await cleanupOneArm(plan, false, FAKE_CONFIG);
      assert.equal(unsubCalled, false);
      assert.equal(result.outcome, "skipped_dry_run");
      assert.equal(result.status_before, "active");
    } finally { m.restore(); }
  });

  it("--push: chama unsubscribe quando active, reporta unsubscribed", async () => {
    const [plan] = buildPreflightPlan("preflight-2609");
    let unsubCalled = false;
    const m = mockKitFetch({ state: "active", onUnsubscribe: () => { unsubCalled = true; } });
    try {
      const result = await cleanupOneArm(plan, true, FAKE_CONFIG);
      assert.equal(unsubCalled, true);
      assert.equal(result.outcome, "unsubscribed");
    } finally { m.restore(); }
  });

  it("idempotente: já cancelled não chama unsubscribe mesmo com --push", async () => {
    const [plan] = buildPreflightPlan("preflight-2609");
    let unsubCalled = false;
    const m = mockKitFetch({ state: "cancelled", onUnsubscribe: () => { unsubCalled = true; } });
    try {
      const result = await cleanupOneArm(plan, true, FAKE_CONFIG);
      assert.equal(unsubCalled, false);
      assert.equal(result.outcome, "already_inactive");
    } finally { m.restore(); }
  });

  it("sem registro: NOOP, nunca chama unsubscribe", async () => {
    const [plan] = buildPreflightPlan("preflight-2609");
    let unsubCalled = false;
    const m = mockKitFetch({ state: null, onUnsubscribe: () => { unsubCalled = true; } });
    try {
      const result = await cleanupOneArm(plan, true, FAKE_CONFIG);
      assert.equal(unsubCalled, false);
      assert.equal(result.outcome, "not_found");
    } finally { m.restore(); }
  });
});

describe("buildAdhocPlan (#5736) — pura", () => {
  it("aceita qualquer e-mail literal, sem exigir o padrão vjpixel+test-preflight-{arm}-{campaign}", () => {
    const plan = buildAdhocPlan("vjpixel+preflightgoogle@gmail.com");
    assert.equal(plan.email, "vjpixel+preflightgoogle@gmail.com");
    assert.equal(plan.arm.key, "adhoc");
  });

  it("reconhece e-mail fora do padrão de nomeação do plano scriptado (achado #5736)", () => {
    const plan = buildAdhocPlan("vjpixel+preflightmicrosoft@gmail.com");
    assert.equal(plan.email, "vjpixel+preflightmicrosoft@gmail.com");
  });
});

describe("cleanupOneArm com plano avulso (#5736) — fluxo end-to-end com fetch mockado", () => {
  it("--push num e-mail avulso: chama unsubscribe quando active, reporta unsubscribed", async () => {
    const plan = buildAdhocPlan("vjpixel+preflightgoogle@gmail.com");
    let unsubCalled = false;
    const m = mockKitFetch({ state: "active", onUnsubscribe: () => { unsubCalled = true; } });
    try {
      const result = await cleanupOneArm(plan, true, FAKE_CONFIG);
      assert.equal(unsubCalled, true);
      assert.equal(result.outcome, "unsubscribed");
      assert.equal(result.email, "vjpixel+preflightgoogle@gmail.com");
    } finally { m.restore(); }
  });

  it("dry-run num e-mail avulso: não chama unsubscribe", async () => {
    const plan = buildAdhocPlan("vjpixel+preflightmicrosoft@gmail.com");
    let unsubCalled = false;
    const m = mockKitFetch({ state: "active", onUnsubscribe: () => { unsubCalled = true; } });
    try {
      const result = await cleanupOneArm(plan, false, FAKE_CONFIG);
      assert.equal(unsubCalled, false);
      assert.equal(result.outcome, "skipped_dry_run");
    } finally { m.restore(); }
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
