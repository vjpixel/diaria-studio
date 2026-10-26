/**
 * #11131 — thread multi-chunk que para no meio (chunk 1 no ar, chunk 2 com
 * timeout/5xx no threads_publish). Antes: a entrada virava `send_unknown` com
 * `url: null` e sem o id da raiz, e o `--retry dN` sugerido republicava a
 * thread inteira — a raiz duplicava. Agora o id da raiz vai pro store e o
 * `--retry` recusa refazer até o editor declarar que apagou a raiz.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideThreadsDispatch,
  partialRootMediaId,
  partialThreadRecoveryHint,
  publishTextWithRetry,
  publishThreadChunks,
  ThreadsAmbiguousSendError,
  ThreadsPartialThreadError,
  type ThreadChunkSteps,
} from "../scripts/publish-threads.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Passos fake: o publish do chunk `failAt` (1-based) lança `err`. */
function fakeSteps(failAt: number | null, err: () => Error) {
  const calls: Array<{ text: string; replyToId: string | null }> = [];
  let n = 0;
  const steps: ThreadChunkSteps = {
    createContainer: async (text, replyToId) => {
      calls.push({ text, replyToId });
      return `c${calls.length}`;
    },
    waitReady: async () => {},
    publishContainer: async (containerId) => {
      n += 1;
      if (failAt === n) throw err();
      return `m-${containerId}`;
    },
  };
  return { steps, calls };
}

describe("publishThreadChunks (#11131)", () => {
  it("thread completa: encadeia por reply_to_id e devolve a raiz", async () => {
    const { steps, calls } = fakeSteps(null, () => new Error("x"));
    const root = await publishThreadChunks(["a", "b", "c"], steps);
    assert.equal(root, "m-c1");
    assert.deepEqual(calls.map((c) => c.replyToId), [null, "m-c1", "m-c2"]);
  });

  it("cenário da issue: chunk 2 ambíguo → ThreadsAmbiguousSendError com a raiz", async () => {
    const { steps } = fakeSteps(2, () => new ThreadsAmbiguousSendError("timeout"));
    const err = await publishThreadChunks(["a", "b", "c"], steps).then(
      () => assert.fail("devia lançar"),
      (e) => e,
    );
    assert.ok(err instanceof ThreadsAmbiguousSendError);
    assert.deepEqual(err.partial, { rootMediaId: "m-c1", chunksPublished: 1 });
    assert.match(err.message, /chunk 2\/3/);
  });

  it("chunk 3 falha de vez → ThreadsPartialThreadError com 2 chunks confirmados", async () => {
    const { steps } = fakeSteps(3, () => new Error("HTTP 400"));
    const err = await publishThreadChunks(["a", "b", "c"], steps).then(
      () => assert.fail("devia lançar"),
      (e) => e,
    );
    assert.ok(err instanceof ThreadsPartialThreadError);
    assert.deepEqual(err.partial, { rootMediaId: "m-c1", chunksPublished: 2 });
  });

  it("falha no chunk 1 segue sem partial (nada confirmado no ar)", async () => {
    const { steps } = fakeSteps(1, () => new ThreadsAmbiguousSendError("timeout"));
    const err = await publishThreadChunks(["a", "b"], steps).then(
      () => assert.fail("devia lançar"),
      (e) => e,
    );
    assert.ok(err instanceof ThreadsAmbiguousSendError);
    assert.equal(err.partial, undefined);
  });
});

describe("publishTextWithRetry propaga a raiz parcial (#11131)", () => {
  it("ambíguo no chunk 2 → send_unknown com partial", async () => {
    const out = await publishTextWithRetry(
      async () => {
        throw new ThreadsAmbiguousSendError("chunk 2/2: timeout", { rootMediaId: "r1", chunksPublished: 1 });
      },
      { multiChunk: true, sleep: async () => {} },
    );
    assert.equal(out.kind, "send_unknown");
    assert.deepEqual("partial" in out ? out.partial : undefined, { rootMediaId: "r1", chunksPublished: 1 });
  });

  it("falha definitiva com raiz no ar → failed com partial e SEM nova tentativa, mesmo com maxAttempts > 1", async () => {
    let attempts = 0;
    const out = await publishTextWithRetry(
      async () => {
        attempts += 1;
        throw new ThreadsPartialThreadError("chunk 2/2: HTTP 400", { rootMediaId: "r1", chunksPublished: 1 });
      },
      { multiChunk: false, sleep: async () => {} },
    );
    assert.equal(attempts, 1);
    assert.equal(out.kind, "failed");
    assert.deepEqual("partial" in out ? out.partial : undefined, { rootMediaId: "r1", chunksPublished: 1 });
  });
});

describe("--retry recusa thread parcial (#11131)", () => {
  const partialEntry = (status: PostEntry["status"]): PostEntry => ({
    platform: "threads",
    destaque: "d2",
    url: null,
    status,
    scheduled_at: null,
    threads_partial_root_media_id: "r1",
    threads_chunks_published: 1,
    threads_chunks: 2,
  });

  it("cenário da issue: send_unknown com raiz no ar → --retry d2 recusado (não republica a raiz)", () => {
    const decision = decideThreadsDispatch("d2", partialEntry("send_unknown"), { skipExisting: true, retryIds: new Set(["d2"]) });
    assert.equal(decision.action, "retry-refused-partial");
    assert.equal(decision.action === "retry-refused-partial" && decision.rootMediaId, "r1");
  });

  it("failed com raiz no ar também recusa", () => {
    const decision = decideThreadsDispatch("d2", partialEntry("failed"), { skipExisting: true, retryIds: new Set(["d2"]) });
    assert.equal(decision.action, "retry-refused-partial");
  });

  it("--partial-root-deleted libera o retry", () => {
    const decision = decideThreadsDispatch("d2", partialEntry("send_unknown"), {
      skipExisting: true,
      retryIds: new Set(["d2"]),
      partialRootDeleted: true,
    });
    assert.equal(decision.action, "dispatch");
  });

  it("resume SEM --retry não re-despacha parcial failed nem send_unknown (raiz duplicaria)", () => {
    for (const status of ["failed", "send_unknown"] as const) {
      for (const skipExisting of [true, false]) {
        const decision = decideThreadsDispatch("d2", partialEntry(status), { skipExisting, retryIds: null });
        assert.equal(decision.action, "skip-partial", `${status} skipExisting=${skipExisting}`);
        assert.equal(decision.action === "skip-partial" && decision.rootMediaId, "r1");
      }
    }
    // --partial-root-deleted sem --retry não libera (só tem efeito com --retry).
    assert.equal(
      decideThreadsDispatch("d2", partialEntry("failed"), { skipExisting: true, retryIds: null, partialRootDeleted: true }).action,
      "skip-partial",
    );
  });

  it("parcial failed: --retry + --partial-root-deleted re-despacha", () => {
    const decision = decideThreadsDispatch("d2", partialEntry("failed"), {
      skipExisting: true,
      retryIds: new Set(["d2"]),
      partialRootDeleted: true,
    });
    assert.equal(decision.action, "dispatch");
  });

  it("failed sem raiz gravada segue re-despachado pelo resume (comportamento de sempre)", () => {
    const e: PostEntry = { platform: "threads", destaque: "d2", url: null, status: "failed", scheduled_at: null };
    assert.equal(decideThreadsDispatch("d2", e, { skipExisting: true, retryIds: null }).action, "dispatch");
  });

  it("send_unknown sem raiz gravada segue retentável (#11105 intacto)", () => {
    const e: PostEntry = { platform: "threads", destaque: "d2", url: null, status: "send_unknown", scheduled_at: null };
    assert.equal(partialRootMediaId(e), null);
    assert.equal(decideThreadsDispatch("d2", e, { skipExisting: true, retryIds: new Set(["d2"]) }).action, "dispatch");
  });

  it("a instrução de recuperação não manda rodar --retry puro", () => {
    const hint = partialThreadRecoveryHint("d2", { rootMediaId: "r1", chunksPublished: 1 }, 2);
    assert.match(hint, /r1/);
    assert.match(hint, /1 de 2/);
    assert.match(hint, /NÃO rodar --retry d2 sozinho/);
    assert.match(hint, /--partial-root-deleted/);
  });
});

describe("fiação em publish-threads.ts (#11131)", () => {
  const SRC = readFileSync(resolve(ROOT, "scripts/publish-threads.ts"), "utf8");
  it("a entrada failed/send_unknown grava o id da raiz parcial", () => {
    assert.match(SRC, /threads_partial_root_media_id: outcome\.partial\.rootMediaId/);
  });
  it("main passa --partial-root-deleted pro decideThreadsDispatch e trata retry-refused-partial", () => {
    assert.match(SRC, /decideThreadsDispatch\(d, existingPost, \{ skipExisting, retryIds, partialRootDeleted \}\)/);
    assert.match(SRC, /decision\.action === "retry-refused-partial" \|\| decision\.action === "skip-partial"/);
  });
  it("avisa quando --partial-root-deleted vem sem --retry", () => {
    assert.match(SRC, /if \(partialRootDeleted && !retryIds\) \{\s*console\.warn\([^)]*--partial-root-deleted só tem efeito junto com --retry/);
  });
  it("publishThread encadeia via publishThreadChunks", () => {
    assert.match(SRC, /return publishThreadChunks\(chunks, \{/);
  });
});
