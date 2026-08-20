/**
 * test/verify-social-worker-dispatch.test.ts (#5766)
 *
 * Cobertura das funções puras de verify-social-worker-dispatch.ts —
 * reconciliação de LinkedIn/Instagram/Threads contra o Worker Cloudflare
 * `diaria-linkedin-cron` (`/list` + `/dlq`). NENHUM teste aqui faz chamada de
 * rede real: `verifyWorkerDispatch` recebe um `fetchJson` stub em memória.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  reconcileWorkerEntry,
  verifyWorkerDispatch,
  WORKER_RECONCILABLE_PLATFORMS,
  DLQ_REASON_PLACEHOLDER,
  type PostEntry,
  type SocialPublished,
  type FetchJsonFn,
} from "../scripts/verify-social-worker-dispatch.ts";

const NOW = new Date("2026-08-20T20:00:00Z");

function entry(overrides: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "instagram",
    destaque: "d1",
    url: null,
    status: "scheduled",
    scheduled_at: "2026-08-20T10:00:00Z",
    worker_queue_key: "queue:2026-08-20T10:00:00.000Z:uuid-1",
    ...overrides,
  };
}

describe("reconcileWorkerEntry — canais fora de escopo/estado não mudam", () => {
  it("ignora platform fora de WORKER_RECONCILABLE_PLATFORMS (twitter)", () => {
    const e = entry({ platform: "twitter" });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, false);
    assert.deepEqual(r.updated, e);
  });

  it("ignora entry já não-scheduled (published)", () => {
    const e = entry({ status: "published" });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, false);
  });

  it("ignora entry sem worker_queue_key (legacy / fallback_used)", () => {
    const e = entry({ worker_queue_key: undefined });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, false);
  });

  it("WORKER_RECONCILABLE_PLATFORMS é exatamente linkedin/instagram/threads", () => {
    assert.deepEqual([...WORKER_RECONCILABLE_PLATFORMS].sort(), ["instagram", "linkedin", "threads"]);
  });
});

describe("reconcileWorkerEntry — ainda na fila", () => {
  it("key presente em queueKeys: nada muda, mesmo vencido", () => {
    const key = "queue:2026-08-20T10:00:00.000Z:uuid-1";
    const e = entry({ worker_queue_key: key });
    const r = reconcileWorkerEntry(e, new Set([key]), new Set(), NOW);
    assert.equal(r.changed, false);
    assert.equal(r.updated.status, "scheduled");
  });
});

describe("reconcileWorkerEntry — DLQ (falha real, qualquer canal)", () => {
  for (const platform of ["linkedin", "instagram", "threads"]) {
    it(`${platform}: key em dlqKeys → failed com motivo genérico documentado`, () => {
      const key = "dlq:2026-08-20T10:00:00.000Z:uuid-1";
      const e = entry({ platform, worker_queue_key: key });
      const r = reconcileWorkerEntry(e, new Set(), new Set([key]), NOW);
      assert.equal(r.changed, true);
      assert.equal(r.updated.status, "failed");
      assert.equal(r.updated.failure_reason, DLQ_REASON_PLACEHOLDER);
      assert.equal(r.updated.verification_note, undefined);
    });
  }
});

describe("reconcileWorkerEntry — nem fila nem DLQ (fired)", () => {
  it("instagram: vira published com verification_note de ALTA confiança (entrega real)", () => {
    const e = entry({ platform: "instagram" });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, true);
    assert.equal(r.updated.status, "published");
    assert.equal(r.updated.published_at, NOW.toISOString());
    assert.match(r.updated.verification_note as string, /confirmed_by_worker_high_confidence/);
    assert.equal(r.updated.failure_reason, undefined);
  });

  it("threads: mesmo caminho de alta confiança do instagram", () => {
    const e = entry({ platform: "threads" });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, true);
    assert.equal(r.updated.status, "published");
    assert.match(r.updated.verification_note as string, /confirmed_by_worker_high_confidence/);
  });

  it("linkedin: vira published mas com verification_note de confiança MAIS FRACA (sem confirmação da plataforma)", () => {
    const e = entry({ platform: "linkedin" });
    const r = reconcileWorkerEntry(e, new Set(), new Set(), NOW);
    assert.equal(r.changed, true);
    assert.equal(r.updated.status, "published");
    assert.match(
      r.updated.verification_note as string,
      /make_webhook_accepted_no_platform_delivery_confirmation/,
    );
    // Nunca a mesma nota de alta confiança do Instagram/Threads.
    assert.doesNotMatch(r.updated.verification_note as string, /confirmed_by_worker_high_confidence/);
  });
});

describe("verifyWorkerDispatch — orquestra list+dlq+reconcile sem rede real", () => {
  it("aplica DLQ, fired e still-queued em uma edição mista, conta changes corretamente", async () => {
    const published: SocialPublished = {
      posts: [
        entry({ platform: "instagram", destaque: "d1", worker_queue_key: "queue:t1" }), // vira published
        entry({ platform: "linkedin", destaque: "d2", worker_queue_key: "queue:t2" }), // vira published (fraco)
        entry({ platform: "threads", destaque: "d3", worker_queue_key: "queue:t3" }), // ainda na fila
        entry({ platform: "instagram", destaque: "d1", worker_queue_key: "queue:t4", subtype: "main" }), // dlq → failed
        entry({ platform: "facebook", destaque: "d1", worker_queue_key: undefined }), // fora de escopo
      ],
    };
    // Ajusta a 4a entry pra usar dlq
    published.posts[3] = { ...published.posts[3], worker_queue_key: "queue:t4" };

    const fetchJson: FetchJsonFn = async (url: string) => {
      if (url.endsWith("/list")) {
        return { count: 1, items: [{ key: "queue:t3" }] };
      }
      if (url.endsWith("/dlq")) {
        return { count: 1, items: [{ key: "queue:t4" }] };
      }
      throw new Error(`unexpected url ${url}`);
    };

    const { updated, changes } = await verifyWorkerDispatch(
      published,
      "https://worker.example/",
      "tok",
      fetchJson,
      NOW,
    );

    assert.equal(changes, 3); // t1 fired, t2 fired, t4 dlq — t3 still queued, facebook untouched
    const byKey = new Map(updated.posts.map((p) => [p.worker_queue_key as string | undefined, p]));
    assert.equal(byKey.get("queue:t1")?.status, "published");
    assert.equal(byKey.get("queue:t2")?.status, "published");
    assert.equal(byKey.get("queue:t3")?.status, "scheduled");
    assert.equal(byKey.get("queue:t4")?.status, "failed");
  });

  it("edição sem nenhuma entry reconciliável: 0 changes, nenhuma chamada extra falha", async () => {
    const published: SocialPublished = {
      posts: [entry({ platform: "facebook", worker_queue_key: undefined, status: "published" })],
    };
    const fetchJson: FetchJsonFn = async (url: string) =>
      url.endsWith("/list") ? { count: 0, items: [] } : { count: 0, items: [] };
    const { changes } = await verifyWorkerDispatch(published, "https://worker.example/", "tok", fetchJson, NOW);
    assert.equal(changes, 0);
  });
});
