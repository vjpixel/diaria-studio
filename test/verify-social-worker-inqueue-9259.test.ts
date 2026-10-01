/**
 * #9259 — publish-artigo-especial-linkedin.ts logava "0 entrada(s)
 * confirmada(s) na fila" logo após agendar: o número era `changes`
 * (transições disparado/DLQ), não a contagem de entries presentes na fila.
 * Uma entry recém-enfileirada (ainda na fila) é sempre `changes: 0`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  verifyWorkerDispatch,
  formatVerifySummary,
  type SocialPublished,
  type FetchJsonFn,
} from "../scripts/verify-social-worker-dispatch.ts";

describe("verifyWorkerDispatch.inQueue (#9259)", () => {
  // Formato que publish-artigo-especial-linkedin.ts grava em linkedin-published.json.
  const published: SocialPublished = {
    posts: [
      {
        platform: "linkedin",
        destaque: "especial-pagina",
        url: null,
        status: "scheduled",
        scheduled_at: "2026-10-01T12:00:00Z",
        worker_queue_key: "queue:2026-10-01T12:00:00.000Z:abc",
        route: "worker_queue",
      },
    ],
  };
  const fetchJson: FetchJsonFn = async (url: string) => {
    if (url.endsWith("/list")) return { count: 1, items: [{ key: "queue:2026-10-01T12:00:00.000Z:abc" }] };
    if (url.endsWith("/dlq")) return { count: 0, items: [] };
    throw new Error(`unexpected url ${url}`);
  };

  it("entry recém-enfileirada conta como confirmada na fila (inQueue=1, changes=0)", async () => {
    const r = await verifyWorkerDispatch(published, "https://w.example", "tok", fetchJson, new Date("2026-09-30T20:00:00Z"));
    assert.equal(r.changes, 0);
    assert.equal(r.inQueue, 1);
    assert.equal(r.updated.posts[0].status, "scheduled");
  });

  it("o resumo reporta inQueue como confirmadas, não changes", () => {
    assert.equal(formatVerifySummary({ changes: 0, inQueue: 1 }), "1 entrada(s) confirmada(s) na fila; 0 reconciliada(s) (disparada/DLQ).");
    assert.match(formatVerifySummary({ changes: 2 }), /^\? entrada/);
  });
});
