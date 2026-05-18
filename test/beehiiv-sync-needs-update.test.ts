/**
 * beehiiv-sync-needs-update.test.ts (#1357)
 *
 * Unit tests pra `needsUpdate()` — decide se um post precisa re-fetch de detalhe.
 * Pure function — fácil de cobrir os 4 caminhos de decisão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { needsUpdate } from "../scripts/beehiiv-sync.ts";

const baseEntry = {
  id: "post_1",
  title: "T",
  status: "confirmed",
  publish_date: 1700000000,
  updated_at: "2026-01-01T00:00:00Z",
};

describe("needsUpdate", () => {
  it("full mode → sempre re-fetch", () => {
    const cached = new Map([[baseEntry.id, baseEntry]]);
    const summary = { id: "post_1", updated_at: "2026-01-01T00:00:00Z" };
    assert.equal(
      needsUpdate(summary, cached, () => true, { full: true }),
      true,
    );
  });

  it("não está no cache → fetch", () => {
    const cached = new Map<string, typeof baseEntry>();
    const summary = { id: "post_new", updated_at: "2026-01-01T00:00:00Z" };
    assert.equal(needsUpdate(summary, cached, () => false), true);
  });

  it("cached.updated_at == summary.updated_at + arquivo existe → skip", () => {
    const cached = new Map([[baseEntry.id, baseEntry]]);
    const summary = { id: "post_1", updated_at: "2026-01-01T00:00:00Z" };
    assert.equal(needsUpdate(summary, cached, () => true), false);
  });

  it("cached.updated_at != summary.updated_at → fetch (drift)", () => {
    const cached = new Map([[baseEntry.id, baseEntry]]);
    const summary = { id: "post_1", updated_at: "2026-01-02T00:00:00Z" };
    assert.equal(needsUpdate(summary, cached, () => true), true);
  });

  it("updated_at bate mas arquivo de detalhe sumiu → fetch", () => {
    const cached = new Map([[baseEntry.id, baseEntry]]);
    const summary = { id: "post_1", updated_at: "2026-01-01T00:00:00Z" };
    assert.equal(needsUpdate(summary, cached, () => false), true);
  });

  it("summary sem updated_at + cached existe + arquivo existe → skip", () => {
    const cached = new Map([[baseEntry.id, baseEntry]]);
    const summary = { id: "post_1" };
    assert.equal(needsUpdate(summary, cached, () => true), false);
  });
});
