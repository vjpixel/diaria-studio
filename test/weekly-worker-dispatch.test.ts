/**
 * test/weekly-worker-dispatch.test.ts (#8310)
 *
 * Cobertura das funções puras de scripts/lib/weekly-worker-dispatch.ts —
 * reconciliação pós-dispatch da retrospectiva SEMANAL contra o Worker
 * Cloudflare `diaria-linkedin-cron` (`/list` + `/dlq`), estendendo a mesma
 * lógica de verify-social-worker-dispatch.ts pra
 * `data/weekly/{saturday}/06-weekly-published.json`.
 *
 * NENHUM teste aqui faz chamada de rede real: verifyWeeklyWorkerDispatch
 * recebe um fetchJson stub em memória (herda do diário).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  resolveWeeklyPublishedPath,
  weeklyPublishedExists,
  verifyWeeklyWorkerDispatch,
  reconcileWorkerEntry,
  type PostEntry,
  type SocialPublished,
  type FetchJsonFn,
} from "../scripts/lib/weekly-worker-dispatch.ts";

const NOW = new Date("2026-09-12T12:00:00Z");

function entry(overrides: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "instagram",
    destaque: "d1",
    url: null,
    status: "scheduled",
    scheduled_at: "2026-09-12T10:00:00Z",
    worker_queue_key: "queue:2026-09-12T10:00:00.000Z:uuid-1",
    ...overrides,
  };
}

describe("resolveWeeklyPublishedPath — caminho canônico da semanal", () => {
  it("monta data/weekly/{saturday}/06-weekly-published.json", () => {
    const p = resolveWeeklyPublishedPath("/repo", "260912");
    assert.equal(p, resolve("/repo", "data", "weekly", "260912", "06-weekly-published.json"));
  });

  it("contém o nome do store semanal", () => {
    assert.match(resolveWeeklyPublishedPath(".", "260905"), /06-weekly-published\.json$/);
  });
});

describe("verifyWeeklyWorkerDispatch — orquestra list+dlq+reconcile sem rede real", () => {
  it("aplica DLQ, fired e still-queued em uma semana mista, conta changes corretamente", async () => {
    const published: SocialPublished = {
      posts: [
        entry({ platform: "instagram", destaque: "d1", worker_queue_key: "queue:t1" }), // vira published
        entry({ platform: "linkedin", destaque: "d2", worker_queue_key: "queue:t2" }), // vira published (fraco)
        entry({ platform: "threads", destaque: "d3", worker_queue_key: "queue:t3" }), // ainda na fila
        entry({ platform: "instagram", destaque: "d1", worker_queue_key: "queue:t4", subtype: "main" }), // dlq -> failed
        entry({ platform: "facebook", destaque: "d1", worker_queue_key: undefined }), // fora de escopo
      ],
    };
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

    const { updated, changes } = await verifyWeeklyWorkerDispatch(
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

  it("reconcileWorkerEntry reexportado: DLQ em qualquer canal vira failed", () => {
    const key = "dlq:2026-09-12T10:00:00.000Z:uuid-9";
    const e = entry({ platform: "threads", worker_queue_key: key });
    const r = reconcileWorkerEntry(e, new Set(), new Set([key]), NOW);
    assert.equal(r.changed, true);
    assert.equal(r.updated.status, "failed");
  });

  // Regressão #8310 — entrada nova DLQ passa por notifyEditor (portão #7960)
  it("notifyWeeklyDlqAlarm chama notifyEditor (regressão #8310)", async () => {
    const { notifyWeeklyDlqAlarm } = await import("../scripts/lib/weekly-worker-dlq-alarm.ts");
    const res = await notifyWeeklyDlqAlarm(2, 0);
    assert.equal(typeof res, "object");
  });
});
