/**
 * kit-sync-needs-update.test.ts (#7570)
 *
 * Unit tests pra `needsKitUpdate()` — decide se um broadcast precisa
 * re-fetch de detail+clicks+stats. Pure function, mesmo padrão de
 * `beehiiv-sync-needs-update.test.ts::needsUpdate`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { needsKitUpdate, KIT_REFRESH_WINDOW_DAYS } from "../scripts/kit-sync.ts";

const NOW = new Date("2026-09-07T12:00:00Z");

function summary(overrides: Partial<Parameters<typeof needsKitUpdate>[0]> = {}) {
  return {
    id: 1,
    status: "completed" as const,
    published_at: "2026-09-01T09:00:00Z", // 6 dias antes de NOW
    send_at: "2026-09-01T09:00:00Z",
    ...overrides,
  };
}

describe("needsKitUpdate", () => {
  it("--full → sempre re-fetch, mesmo cached e velho", () => {
    const cached = new Set([1]);
    const s = summary({ published_at: "2026-01-01T00:00:00Z" });
    assert.equal(needsKitUpdate(s, cached, { full: true, now: NOW }), true);
  });

  it("ausente do cache → fetch", () => {
    const cached = new Set<number>();
    assert.equal(needsKitUpdate(summary(), cached, { now: NOW }), true);
  });

  it("status não-terminal (draft/scheduled/sending) → sempre fetch, mesmo cached", () => {
    const cached = new Set([1]);
    for (const status of ["draft", "scheduled", "sending"] as const) {
      assert.equal(
        needsKitUpdate(summary({ status }), cached, { now: NOW }),
        true,
        `status=${status} deveria sempre refetch`,
      );
    }
  });

  it("terminal (completed) sem published_at nem send_at → fetch (sem data pra medir idade)", () => {
    const cached = new Set([1]);
    const s = summary({ published_at: null, send_at: null });
    assert.equal(needsKitUpdate(s, cached, { now: NOW }), true);
  });

  it("terminal, cached, mais novo que a janela → fetch (clicks ainda subindo)", () => {
    const cached = new Set([1]);
    const s = summary({ published_at: "2026-09-01T09:00:00Z" }); // 6 dias, < 14
    assert.equal(needsKitUpdate(s, cached, { now: NOW }), true);
  });

  it("terminal, cached, mais velho que a janela → skip (estável)", () => {
    const cached = new Set([1]);
    const s = summary({ published_at: "2026-08-01T09:00:00Z" }); // 37 dias, > 14
    assert.equal(needsKitUpdate(s, cached, { now: NOW }), false);
  });

  it("terminal, cached, exatamente na borda da janela → fetch (< estrito, não <=)", () => {
    const cached = new Set([1]);
    const borderMs = NOW.getTime() - KIT_REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const s = summary({ published_at: new Date(borderMs + 1).toISOString() });
    assert.equal(needsKitUpdate(s, cached, { now: NOW }), true);
  });

  it("aborted é tratado como terminal (mesma janela de completed)", () => {
    const cached = new Set([1]);
    const s = summary({ status: "aborted", published_at: "2026-08-01T09:00:00Z" });
    assert.equal(needsKitUpdate(s, cached, { now: NOW }), false);
  });

  it("published_at ausente cai pro fallback send_at", () => {
    const cached = new Set([1]);
    const s = summary({ published_at: null, send_at: "2026-08-01T09:00:00Z" });
    assert.equal(needsKitUpdate(s, cached, { now: NOW }), false);
  });

  it("data inválida (parse falha) → fetch, nunca NaN silencioso", () => {
    const cached = new Set([1]);
    const s = summary({ published_at: "não-é-uma-data" });
    assert.equal(needsKitUpdate(s, cached, { now: NOW }), true);
  });
});
