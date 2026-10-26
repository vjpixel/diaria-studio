/**
 * test/verify-social-worker-send-unknown-11129.test.ts (#11129)
 *
 * Post do Threads (ou Instagram/LinkedIn) agendado na fila do Worker que cai
 * em envio ambíguo: o Worker move pra DLQ com `last_error` começando por
 * `send_unknown:` (#11106) e o store local seguia `scheduled`. Dois defeitos:
 *
 *   1. a DLQ não reusa a key da fila (`buildDlqKey`: `queue:{iso}:{uuid}` →
 *      `dlq:{scheduled_at}:{uuid}`), e o reconciliador comparava a key
 *      inteira — a entry não casava com a fila nem "com a DLQ" e virava
 *      `published` de ALTA confiança;
 *   2. mesmo casando, virava `failed` (que se refaz), nunca `send_unknown`.
 *
 * Sem rede: `verifyWorkerDispatch` recebe um `fetchJson` stub.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDlqIndex,
  DLQ_REASON_PLACEHOLDER,
  reconcileWorkerEntry,
  verifyWorkerDispatch,
  workerKeyId,
  type FetchJsonFn,
  type PostEntry,
  type SocialPublished,
} from "../scripts/verify-social-worker-dispatch.ts";
import { analyzePrevSocial, formatPrevSocialSummary } from "../scripts/lib/prev-social-status.ts";

const NOW = new Date("2026-10-26T12:00:00Z");
const QUEUE_KEY = "queue:2026-10-26T09:00:00.000Z:2f1c0e9a-1111-4222-8333-444455556666";
// Forma real do Worker (buildDlqKey): prefixo trocado, scheduled_at da entry, mesmo uuid.
const DLQ_KEY = "dlq:2026-10-26T09:00:00Z:2f1c0e9a-1111-4222-8333-444455556666";

function entry(overrides: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "threads",
    destaque: "d2",
    url: null,
    status: "scheduled",
    scheduled_at: "2026-10-26T09:00:00Z",
    worker_queue_key: QUEUE_KEY,
    ...overrides,
  } as PostEntry;
}

describe("#11129 — DLQ casa pelo uuid, não pela key inteira", () => {
  it("workerKeyId devolve o trecho depois do último ':' (schema novo e legacy)", () => {
    assert.equal(workerKeyId(QUEUE_KEY), workerKeyId(DLQ_KEY));
    assert.equal(workerKeyId("queue:abc"), "abc");
    assert.equal(workerKeyId("dlq:2026-10-26T09:00:00Z:abc"), "abc");
  });

  it("entry na DLQ com key real dlq:{sched}:{uuid} NÃO vira published", async () => {
    const published: SocialPublished = { posts: [entry()] };
    const fetchJson: FetchJsonFn = async (url) => {
      if (url.endsWith("/list")) return { count: 0, items: [] };
      if (url.endsWith("/dlq")) return { count: 1, items: [{ key: DLQ_KEY, last_error: "graph 400: invalid media" }] };
      throw new Error(url);
    };
    const { updated, changes } = await verifyWorkerDispatch(published, "https://w.example", "tok", fetchJson, NOW, { maxAttempts: 1 });
    assert.equal(changes, 1);
    assert.equal(updated.posts[0].status, "failed");
    assert.equal(updated.posts[0].failure_reason, "worker_dlq: graph 400: invalid media");
    assert.equal(updated.posts[0].worker_dlq_key, DLQ_KEY);
  });
});

describe("#11129 — last_error send_unknown: vira send_unknown, não failed", () => {
  it("threads agendado que o Worker marcou como envio ambíguo", () => {
    const dlq = buildDlqIndex([{ key: DLQ_KEY, last_error: "send_unknown: threads_publish timeout (container 123)" }]);
    const r = reconcileWorkerEntry(entry(), new Set(), dlq, NOW);
    assert.equal(r.changed, true);
    assert.equal(r.updated.status, "send_unknown");
    assert.equal(r.updated.failure_reason, "send_unknown: threads_publish timeout (container 123)");
    assert.match(r.updated.verification_note as string, /worker_send_unknown/);
    assert.equal(r.updated.published_at, undefined);
  });

  it("DLQ antiga sem last_error segue failed com o texto genérico", () => {
    const r = reconcileWorkerEntry(entry(), new Set(), buildDlqIndex([{ key: DLQ_KEY }]), NOW);
    assert.equal(r.updated.status, "failed");
    assert.equal(r.updated.failure_reason, DLQ_REASON_PLACEHOLDER);
  });

  it("entry já send_unknown local não é tocada de novo", () => {
    const e = entry({ status: "send_unknown" });
    const r = reconcileWorkerEntry(e, new Set(), buildDlqIndex([{ key: DLQ_KEY, last_error: "send_unknown: x" }]), NOW);
    assert.equal(r.changed, false);
  });

  it("o check 0l (analyzePrevSocial) acusa o send_unknown reconciliado", () => {
    const r = reconcileWorkerEntry(entry(), new Set(), buildDlqIndex([{ key: DLQ_KEY, last_error: "send_unknown: 5xx" }]), NOW);
    const report = analyzePrevSocial([r.updated], NOW);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].reason, "send-unknown");
    assert.match(formatPrevSocialSummary(report, "261026") ?? "", /threads\/d2 \(envio ambíguo/);
  });
});
