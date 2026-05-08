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
  findScheduledMatch,
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

describe("#974 reconcileFb (via /scheduled_posts)", () => {
  it("verified=true quando post_id está na lista /scheduled_posts (match exato)", () => {
    const future = Math.floor(new Date("2026-05-08T09:00:00Z").getTime() / 1000);
    const scheduled = [{ id: "12345", scheduled_publish_time: future, message: "x" }];
    const r = reconcileFb(fbEntry(), scheduled, undefined, NOW);
    assert.equal(r.verified, true);
    assert.equal(r.platform, "facebook");
    assert.equal(r.destaque, "d1");
    const ext = r.external_state as { scheduled_publish_time: number };
    assert.equal(ext.scheduled_publish_time, future);
  });

  it("verified=true quando Graph retorna id formato {page_id}_{post_id}", () => {
    const future = Math.floor(new Date("2026-05-08T09:00:00Z").getTime() / 1000);
    const scheduled = [{ id: "987654_12345", scheduled_publish_time: future }];
    const r = reconcileFb(fbEntry(), scheduled, undefined, NOW);
    assert.equal(r.verified, true);
  });

  it("verified=true via fallback GET quando post não está em /scheduled_posts (já publicado)", () => {
    const r = reconcileFb(
      fbEntry(),
      [],
      { id: "12345", permalink_url: "https://fb.com/p/12345", created_time: "2026-05-07T11:00:00Z" },
      NOW,
    );
    assert.equal(r.verified, true);
    const ext = r.external_state as { post_exists: boolean };
    assert.equal(ext.post_exists, true);
  });

  it("verified=false quando fallback Graph API retorna error", () => {
    const r = reconcileFb(fbEntry(), [], { error: { message: "OAuth" } }, NOW);
    assert.equal(r.verified, false);
    assert.match(r.reason ?? "", /graph_api_error: OAuth/);
  });

  it("verified=false quando post não está em /scheduled_posts e fallback nem foi feito", () => {
    const r = reconcileFb(fbEntry(), [], undefined, NOW);
    assert.equal(r.verified, false);
    assert.match(r.reason ?? "", /post_missing/);
  });

  it("verified=false quando entry sem fb_post_id", () => {
    const e = fbEntry();
    delete (e as Record<string, unknown>).fb_post_id;
    const r = reconcileFb(e, [], undefined, NOW);
    assert.equal(r.verified, false);
    assert.equal(r.reason, "no_fb_post_id");
  });
});

describe("#974 findScheduledMatch", () => {
  it("match exato por id", () => {
    const m = findScheduledMatch("12345", [{ id: "12345" }]);
    assert.equal(m?.id, "12345");
  });

  it("match por sufixo {page}_{post}", () => {
    const m = findScheduledMatch("12345", [{ id: "987654_12345" }]);
    assert.equal(m?.id, "987654_12345");
  });

  it("match na direção inversa (fb_post_id já tem prefix de page)", () => {
    const m = findScheduledMatch("987654_12345", [{ id: "12345" }]);
    assert.equal(m?.id, "12345");
  });

  it("undefined quando não há match", () => {
    const m = findScheduledMatch("99999", [{ id: "12345" }]);
    assert.equal(m, undefined);
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
