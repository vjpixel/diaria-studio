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

  it("#1180 verified=FALSE quando scheduled_publish_time no passado", () => {
    // Brevo/FB no próximo tick vai publicar — sai antes da hora planejada.
    const past = Math.floor(new Date("2026-05-01T09:00:00Z").getTime() / 1000);
    const scheduled = [{ id: "12345", scheduled_publish_time: past, message: "x" }];
    const r = reconcileFb(fbEntry(), scheduled, undefined, NOW);
    assert.equal(r.verified, false);
    assert.match(r.reason ?? "", /scheduled_at_in_past/);
  });

  it("#1180 boundary FB: scheduled_publish_time == now exato → verified=true (strict <)", () => {
    // Sentinela: o predicate é `scheduledMs < now.getTime()` (strict). Empate
    // exato fica do lado seguro (verified). Se alguém trocar pra `<=` por
    // engano, esse teste quebra antes de chegar em prod.
    const now = new Date("2026-05-12T10:00:00Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    const scheduled = [{ id: "12345", scheduled_publish_time: nowSec, message: "x" }];
    const r = reconcileFb(fbEntry(), scheduled, undefined, now);
    assert.equal(r.verified, true);
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
    const r = reconcileLinkedin(entry, queue, NOW);
    assert.equal(r.verified, true);
  });

  it("verified=true quando match por destaque (fallback)", () => {
    const queue = [mkQueueItem("d1", "2026-05-08T09:00:00Z")];
    const r = reconcileLinkedin(liEntry(), queue, NOW);
    assert.equal(r.verified, true);
  });

  it("verified=false quando destaque ausente no KV (silent fail)", () => {
    const queue = [mkQueueItem("d2", "2026-05-08T09:00:00Z")];
    const r = reconcileLinkedin(liEntry(), queue, NOW);
    assert.equal(r.verified, false);
    assert.match(r.reason ?? "", /nenhum item no Worker KV.*d1/);
  });

  it("#1180 verified=FALSE quando fallback_used (Make fire-now ignora scheduled_at)", () => {
    // Antes (#917): tratava fallback_used como verified=true (post foi/sera
    // enviado, só não enfileiravel). Mas Make IGNORA scheduled_at e publica
    // IMEDIATO — pra wave que deveria sair no futuro, isso é falha grave.
    const r = reconcileLinkedin(liEntry({ fallback_used: true, status: "draft" }), [], NOW);
    assert.equal(r.verified, false);
    assert.match(r.reason ?? "", /fallback_used_immediate_publish/);
    assert.match(r.reason ?? "", /IMEDIATO/);
  });

  it("#1180 verified=FALSE quando item na queue mas scheduled_at no passado (matchByKey path)", () => {
    // Worker cron dispara no próximo tick (~1min) → publica imediato.
    const key = "queue:2026-05-01T09:00:00Z:uuid-abc";
    const queue = [mkQueueItem("d1", "2026-05-01T09:00:00Z", key)]; // passado
    const entry = liEntry({ worker_queue_key: key });
    const now = new Date("2026-05-12T10:00:00Z"); // muito depois do scheduled
    const r = reconcileLinkedin(entry, queue, now);
    assert.equal(r.verified, false);
    assert.match(r.reason ?? "", /scheduled_at_in_past/);
  });

  it("#1180 verified=FALSE quando past-schedule via narrow match (sem worker_queue_key)", () => {
    const queue = [mkQueueItem("d1", "2026-05-01T09:00:00Z")]; // passado, sem key
    const entry = liEntry(); // sem worker_queue_key → cai no narrow path
    const now = new Date("2026-05-12T10:00:00Z");
    const r = reconcileLinkedin(entry, queue, now);
    assert.equal(r.verified, false);
    assert.match(r.reason ?? "", /scheduled_at_in_past/);
    assert.match(r.reason ?? "", /narrow match/);
  });

  it("#1180 boundary LinkedIn: scheduled_at == now exato → verified=true (strict <)", () => {
    // Espelha o teste de boundary FB — predicate `ms < now.getTime()` empate
    // exato fica do lado seguro. Defesa contra refactor que troque pra `<=`.
    const now = new Date("2026-05-12T10:00:00Z");
    const queue = [mkQueueItem("d1", now.toISOString())];
    const r = reconcileLinkedin(liEntry({ scheduled_at: now.toISOString() }), queue, now);
    assert.equal(r.verified, true);
  });

  it("multiplos matches por destaque: escolhe o mais proximo do scheduled_at", () => {
    const queue = [
      mkQueueItem("d1", "2026-05-08T09:00:00Z"), // exact
      mkQueueItem("d1", "2026-05-15T09:00:00Z"), // longe
    ];
    const r = reconcileLinkedin(liEntry(), queue, NOW);
    assert.equal(r.verified, true);
    const ext = r.external_state as { scheduled_at: string };
    assert.equal(ext.scheduled_at, "2026-05-08T09:00:00Z");
  });

  // ── #595 — fallback narrow por (destaque, action, webhook_target) ──

  function mkRichItem(
    destaque: string,
    scheduled: string,
    extras: { action?: "post" | "comment"; webhook_target?: "diaria" | "pixel"; key?: string } = {},
  ) {
    return {
      key: extras.key ?? `queue:${scheduled}:uuid-${destaque}-${extras.action ?? "post"}-${extras.webhook_target ?? "diaria"}`,
      text: `${extras.action ?? "post"} ${destaque}`,
      image_url: null,
      scheduled_at: scheduled,
      destaque,
      created_at: "2026-05-07T08:00:00Z",
      ...(extras.action !== undefined && { action: extras.action }),
      ...(extras.webhook_target !== undefined && { webhook_target: extras.webhook_target }),
    };
  }

  it("#595 main entry → match item com action=post, ignora comments", () => {
    const queue = [
      mkRichItem("d1", "2026-05-08T09:00:00Z", { action: "post", webhook_target: "diaria" }),
      mkRichItem("d1", "2026-05-08T09:03:00Z", { action: "comment", webhook_target: "diaria" }),
      mkRichItem("d1", "2026-05-08T09:08:00Z", { action: "comment", webhook_target: "pixel" }),
    ];
    const r = reconcileLinkedin(liEntry({ subtype: "main" }), queue, NOW);
    assert.equal(r.verified, true);
    const ext = r.external_state as { scheduled_at: string; action: string; subtype: string };
    assert.equal(ext.action, "post");
    assert.equal(ext.subtype, "main");
  });

  it("#595 comment_diaria entry → match item com action=comment + target=diaria", () => {
    const queue = [
      mkRichItem("d1", "2026-05-08T09:00:00Z", { action: "post", webhook_target: "diaria" }),
      mkRichItem("d1", "2026-05-08T09:03:00Z", { action: "comment", webhook_target: "diaria" }),
      mkRichItem("d1", "2026-05-08T09:08:00Z", { action: "comment", webhook_target: "pixel" }),
    ];
    const r = reconcileLinkedin(
      liEntry({ subtype: "comment_diaria", scheduled_at: "2026-05-08T09:03:00Z" }),
      queue,
      NOW,
    );
    assert.equal(r.verified, true);
    const ext = r.external_state as { scheduled_at: string; action: string; webhook_target: string };
    assert.equal(ext.action, "comment");
    assert.equal(ext.webhook_target, "diaria");
    assert.equal(ext.scheduled_at, "2026-05-08T09:03:00Z");
  });

  it("#595 comment_pixel entry → match item com action=comment + target=pixel", () => {
    const queue = [
      mkRichItem("d1", "2026-05-08T09:00:00Z", { action: "post", webhook_target: "diaria" }),
      mkRichItem("d1", "2026-05-08T09:03:00Z", { action: "comment", webhook_target: "diaria" }),
      mkRichItem("d1", "2026-05-08T09:08:00Z", { action: "comment", webhook_target: "pixel" }),
    ];
    const r = reconcileLinkedin(
      liEntry({ subtype: "comment_pixel", scheduled_at: "2026-05-08T09:08:00Z" }),
      queue,
      NOW,
    );
    assert.equal(r.verified, true);
    const ext = r.external_state as { webhook_target: string; scheduled_at: string };
    assert.equal(ext.webhook_target, "pixel");
    assert.equal(ext.scheduled_at, "2026-05-08T09:08:00Z");
  });

  it("#595 comment sem item correspondente no KV → verified=false (silent fail)", () => {
    const queue = [
      mkRichItem("d1", "2026-05-08T09:00:00Z", { action: "post", webhook_target: "diaria" }),
      // sem nenhum comment_pixel
    ];
    const r = reconcileLinkedin(liEntry({ subtype: "comment_pixel" }), queue, NOW);
    assert.equal(r.verified, false);
    assert.match(r.reason ?? "", /d1.*comment_pixel/);
  });

  it("#595 backward-compat: entry sem subtype + queue sem fields → match como main/post/diaria", () => {
    const queue = [mkQueueItem("d1", "2026-05-08T09:00:00Z")];
    const r = reconcileLinkedin(liEntry(), queue, NOW); // entry sem subtype
    assert.equal(r.verified, true);
    assert.equal(r.subtype, "main");
  });

  it("#595 subtype sempre exposto no result", () => {
    const r = reconcileLinkedin(
      liEntry({ subtype: "comment_diaria", worker_queue_key: "queue:2026-05-08T09:03:00.000Z:uuid-cd" }),
      [mkRichItem("d1", "2026-05-08T09:03:00Z", {
        key: "queue:2026-05-08T09:03:00.000Z:uuid-cd",
        action: "comment",
        webhook_target: "diaria",
      })],
    );
    assert.equal(r.subtype, "comment_diaria");
  });
});

describe("#1183 silent-fail quando schedule field omitido", () => {
  const PAST_NOW = new Date("2026-05-08T10:00:00Z");

  describe("FB: match sem scheduled_publish_time", () => {
    it("entry.scheduled_at no passado + match sem scheduled_publish_time → verified=false (via fallback)", () => {
      // FB retornou match mas omitiu o campo. Sem o fallback, viraria
      // verified=true silenciosamente.
      const scheduled = [
        { id: "12345", message: "x" } as { id: string; message: string; scheduled_publish_time?: number },
      ];
      const r = reconcileFb(
        fbEntry({ scheduled_at: "2026-05-08T09:00:00Z" }),
        scheduled,
        undefined,
        PAST_NOW,
      );
      assert.equal(r.verified, false, "deve falhar pq entry.scheduled_at passou");
      assert.match(r.reason ?? "", /scheduled_at_in_past/);
      assert.match(r.reason ?? "", /FB omitiu scheduled_publish_time/);
      const ext = r.external_state as { fallback_source?: string };
      assert.equal(ext.fallback_source, "entry.scheduled_at");
    });

    it("entry.scheduled_at no futuro + match sem scheduled_publish_time → verified=true (comportamento atual)", () => {
      const scheduled = [
        { id: "12345", message: "x" } as { id: string; message: string; scheduled_publish_time?: number },
      ];
      const r = reconcileFb(
        fbEntry({ scheduled_at: "2026-05-08T15:00:00Z" }), // 5h no futuro vs NOW=10
        scheduled,
        undefined,
        PAST_NOW,
      );
      assert.equal(r.verified, true);
    });

    it("entry.scheduled_at ausente + match sem scheduled_publish_time → verified=true (nada pra checar)", () => {
      const scheduled = [
        { id: "12345", message: "x" } as { id: string; message: string; scheduled_publish_time?: number },
      ];
      const r = reconcileFb(
        fbEntry({ scheduled_at: undefined }),
        scheduled,
        undefined,
        PAST_NOW,
      );
      assert.equal(r.verified, true, "sem nenhum source de schedule, não falha");
    });
  });

  describe("LinkedIn: queue item com scheduled_at vazio", () => {
    it("queue.scheduled_at vazio + entry.scheduled_at no passado → verified=false (via fallback)", () => {
      const key = "queue:2026-05-08T09:00:00.000Z:uuid-1";
      const queue = [
        {
          key,
          destaque: "d1",
          scheduled_at: "", // omitido / vazio
          action: "post",
          webhook_target: "diaria",
        } as unknown as Parameters<typeof reconcileLinkedin>[1][number],
      ];
      const entry = liEntry({
        worker_queue_key: key,
        scheduled_at: "2026-05-08T09:00:00Z", // já passou em PAST_NOW
      });
      const r = reconcileLinkedin(entry, queue, PAST_NOW);
      assert.equal(r.verified, false);
      assert.match(r.reason ?? "", /scheduled_at_in_past/);
      assert.match(r.reason ?? "", /Worker omitiu scheduled_at/);
      const ext = r.external_state as { fallback_source?: string };
      assert.equal(ext.fallback_source, "entry.scheduled_at");
    });

    it("queue.scheduled_at vazio + entry.scheduled_at futuro → verified=true", () => {
      const key = "queue:future:uuid-2";
      const queue = [
        {
          key,
          destaque: "d1",
          scheduled_at: "",
          action: "post",
          webhook_target: "diaria",
        } as unknown as Parameters<typeof reconcileLinkedin>[1][number],
      ];
      const entry = liEntry({
        worker_queue_key: key,
        scheduled_at: "2026-05-08T15:00:00Z",
      });
      const r = reconcileLinkedin(entry, queue, PAST_NOW);
      assert.equal(r.verified, true);
    });
  });
});
