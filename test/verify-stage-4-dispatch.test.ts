/**
 * Tests for #917 verify-stage-4-dispatch.ts.
 *
 * Cobertura focada nas funcoes puras (reconcileFb, reconcileLinkedin) — fetch
 * e main() sao smoke-testaveis via stub de fetch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  reconcileFb,
  reconcileLinkedin,
} from "../scripts/verify-stage-4-dispatch.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const NOW = new Date("2026-05-07T12:00:00Z");

function fbEntry(overrides: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "facebook",
    destaque: "d1",
    url: "https://fb.com/page/posts/123",
    status: "scheduled",
    scheduled_at: "2026-05-08T09:00:00Z",
    fb_post_id: "12345",
    ...overrides,
  };
}

function liEntry(overrides: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "linkedin",
    destaque: "d1",
    url: null,
    status: "scheduled",
    scheduled_at: "2026-05-08T09:00:00Z",
    ...overrides,
  };
}

describe("#917 reconcileFb", () => {
  it("verified=true quando scheduled_publish_time futuro", () => {
    const future = Math.floor(new Date("2026-05-08T09:00:00Z").getTime() / 1000);
    const r = reconcileFb(fbEntry(), { id: "12345", scheduled_publish_time: future }, NOW);
    assert.equal(r.verified, true);
    assert.equal(r.platform, "facebook");
    assert.equal(r.destaque, "d1");
  });

  it("verified=true quando ja published (sem scheduled_publish_time)", () => {
    const r = reconcileFb(
      fbEntry(),
      { id: "12345", is_published: true, created_time: "2026-05-07T11:00:00Z" },
      NOW,
    );
    assert.equal(r.verified, true);
  });

  it("verified=false quando Graph API retorna error", () => {
    const r = reconcileFb(fbEntry(), { error: { message: "OAuth" } }, NOW);
    assert.equal(r.verified, false);
    assert.match(r.reason ?? "", /graph_api_error: OAuth/);
  });

  it("verified=false quando scheduled_publish_time vencido + is_published nao true", () => {
    const past = Math.floor(new Date("2026-05-07T11:00:00Z").getTime() / 1000);
    const r = reconcileFb(
      fbEntry(),
      { id: "12345", scheduled_publish_time: past, is_published: false },
      NOW,
    );
    assert.equal(r.verified, false);
    assert.match(r.reason ?? "", /scheduled_publish_time vencido/);
  });

  it("verified=false quando Graph retorna sem id", () => {
    const r = reconcileFb(fbEntry(), {}, NOW);
    assert.equal(r.verified, false);
    assert.equal(r.reason, "graph_returned_no_id");
  });
});

describe("#917 reconcileLinkedin", () => {
  function mkQueueItem(destaque: string, scheduled: string, key?: string) {
    return {
      key: key ?? `queue:${scheduled}:uuid-${destaque}`,
      text: `post ${destaque}`,
      image_url: null,
      scheduled_at: scheduled,
      destaque,
      created_at: "2026-05-07T08:00:00Z",
    };
  }

  it("verified=true quando match por worker_queue_key (preciso)", () => {
    const key = "queue:2026-05-08T09:00:00.000Z:uuid-d1";
    const queue = [mkQueueItem("d1", "2026-05-08T09:00:00Z", key)];
    const entry = liEntry({ worker_queue_key: key });
    const r = reconcileLinkedin(entry, queue);
    assert.equal(r.verified, true);
  });

  it("verified=true quando match por destaque (fallback)", () => {
    const queue = [mkQueueItem("d1", "2026-05-08T09:00:00Z")];
    const r = reconcileLinkedin(liEntry(), queue);
    assert.equal(r.verified, true);
  });

  it("verified=false quando destaque ausente no KV (silent fail)", () => {
    const queue = [mkQueueItem("d2", "2026-05-08T09:00:00Z")];
    const r = reconcileLinkedin(liEntry(), queue);
    assert.equal(r.verified, false);
    assert.match(r.reason ?? "", /nenhum item no Worker KV.*d1/);
  });

  it("verified=true + flag quando fallback_used (Worker falhou, Make fire-now)", () => {
    const r = reconcileLinkedin(liEntry({ fallback_used: true, status: "draft" }), []);
    assert.equal(r.verified, true);
    assert.match(r.reason ?? "", /fallback_used/);
  });

  it("multiplos matches por destaque: escolhe o mais proximo do scheduled_at", () => {
    const queue = [
      mkQueueItem("d1", "2026-05-08T09:00:00Z"), // exact
      mkQueueItem("d1", "2026-05-15T09:00:00Z"), // longe
    ];
    const r = reconcileLinkedin(liEntry(), queue);
    assert.equal(r.verified, true);
    const ext = r.external_state as { scheduled_at: string };
    assert.equal(ext.scheduled_at, "2026-05-08T09:00:00Z");
  });
});
