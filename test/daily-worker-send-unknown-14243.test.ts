/**
 * test/daily-worker-send-unknown-14243.test.ts (#14243)
 *
 * O Worker `linkedin-cron` responde 409 `send_unknown` ao enqueue idempotente
 * quando o disparo anterior da mesma chave terminou ambíguo (o post pode
 * estar no ar; `idempotentConflict` em `workers/linkedin-cron/src/index.ts`).
 * Antes do fix, `enqueueDailyWorkerPost` só reconhecia `already_fired` e
 * `fire_in_progress`: o `send_unknown` caía na regra "4xx prova que nada foi
 * gravado", propagava como erro comum e Instagram/Threads gravavam `failed`
 * — convidando o editor a repostar à mão e duplicar.
 *
 * Worker falso via `globalThis.fetch` (sem rede), no formato de
 * `daily-worker-idempotency-14010-14011.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DailyWorkerSendUnknownError,
  dailyWorkerEnqueueFailure,
  dailyWorkerQueueIdempotencyKey,
  enqueueDailyWorkerPost,
  isWorkerSendUnknownConflict,
} from "../scripts/lib/daily-worker-enqueue.ts";
import { WorkerQueueError } from "../scripts/lib/worker-queue-client.ts";
import { decideResumeOrRetry } from "../scripts/lib/social-retry.ts";
import { decideThreadsDispatch } from "../scripts/publish-threads.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const AT = "2026-11-27T21:00:00.000Z";

/** Corpo literal que o Worker devolve (`idempotentConflict`, index.ts). */
function conflictBody(error: string, key = "queue:2026-11-27T21:00:00.000Z:instagram-daily:261127:d1:main") {
  return JSON.stringify({
    error,
    message: "o disparo deste pedido (idempotency_key) terminou ambíguo — o post pode ter saído ou não, e foi pra DLQ.",
    key,
  });
}

/** Worker falso: todo `POST /queue` responde 409 com `error`; conta os POSTs e as leituras da fila. */
function fakeWorker409(error: string) {
  let queueCalls = 0;
  let listCalls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request) => {
    const url = String(u);
    if (url.endsWith("/list")) {
      listCalls++;
      return new Response(JSON.stringify({ count: 0, items: [] }), { status: 200 });
    }
    if (url.endsWith("/queue")) {
      queueCalls++;
      return new Response(conflictBody(error), { status: 409 });
    }
    throw new Error(`fetch inesperado: ${url}`);
  }) as typeof fetch;
  return {
    queueCalls: () => queueCalls,
    listCalls: () => listCalls,
    restore: () => (globalThis.fetch = saved),
  };
}

function payload(key: string, channel: "instagram" | "threads" = "instagram") {
  return {
    idempotency_key: key,
    text: "Legenda do D1",
    image_url: channel === "instagram" ? "https://img.test/d1_4x5.jpg" : null,
    scheduled_at: AT,
    destaque: "d1",
    channel,
  };
}

describe("#14243 409 send_unknown do Worker no enqueue diário", () => {
  it("lança DailyWorkerSendUnknownError (não o 4xx comum), sem consultar a fila nem repetir o POST", async () => {
    const w = fakeWorker409("send_unknown");
    try {
      const key = dailyWorkerQueueIdempotencyKey("instagram", "261127", "d1");
      const err = await enqueueDailyWorkerPost("https://worker.test", "tok", payload(key), {
        logPrefix: "test",
        lookupOptions: { backoffMs: 0 },
        log: () => {},
      }).then(
        () => assert.fail("409 send_unknown não é sucesso"),
        (e: unknown) => e,
      );
      assert.ok(err instanceof DailyWorkerSendUnknownError, `esperava DailyWorkerSendUnknownError, veio ${String(err)}`);
      assert.equal(err.idempotencyKey, key);
      assert.equal(err.key, "queue:2026-11-27T21:00:00.000Z:instagram-daily:261127:d1:main");
      assert.match(err.message, /^send_unknown:/);
      assert.match(err.message, /Confira o perfil antes de repostar/);
      assert.equal(w.queueCalls(), 1, "409 não é retentado pelo cliente");
      assert.equal(w.listCalls(), 0, "409 send_unknown não consulta a fila");
    } finally {
      w.restore();
    }
  });

  it("o publisher grava send_unknown (nunca failed) com a mensagem de conferência e a key do Worker", async () => {
    const w = fakeWorker409("send_unknown");
    try {
      for (const channel of ["instagram", "threads"] as const) {
        const key = dailyWorkerQueueIdempotencyKey(channel, "261127", "d1");
        const err = await enqueueDailyWorkerPost("https://worker.test", "tok", payload(key, channel), {
          logPrefix: "test",
          log: () => {},
        }).catch((e: unknown) => e);
        const failure = dailyWorkerEnqueueFailure(err);
        assert.equal(failure.status, "send_unknown", `${channel}: 409 send_unknown virou ${failure.status}`);
        assert.match(failure.reason, /pode estar no ar/);
        assert.match(failure.reason, /Confira o perfil/);
        assert.ok(failure.worker_queue_key, `${channel}: key do Worker perdida`);
      }
    } finally {
      w.restore();
    }
  });

  it("re-run da Etapa 5 não reposta cego: a retomada pula a entry send_unknown (Instagram e Threads)", async () => {
    const w = fakeWorker409("send_unknown");
    try {
      const key = dailyWorkerQueueIdempotencyKey("instagram", "261127", "d1");
      const err = await enqueueDailyWorkerPost("https://worker.test", "tok", payload(key), {
        logPrefix: "test",
        log: () => {},
      }).catch((e: unknown) => e);
      const failure = dailyWorkerEnqueueFailure(err);
      for (const platform of ["instagram", "threads"] as const) {
        const entry: PostEntry = { platform, destaque: "d1", url: null, scheduled_at: null, ...failure };
        const ig = decideResumeOrRetry("d1", [entry], { skipExisting: true, retryIds: null });
        assert.equal(ig.action, "skip-existing", `${platform}: a retomada repostaria um send_unknown`);
        const th = decideThreadsDispatch("d1", entry, { skipExisting: true, retryIds: null });
        assert.equal(th.action, "skip-existing");
      }
      // Controle: com `failed` (o comportamento antigo), a retomada repostava.
      const failedEntry: PostEntry = { platform: "instagram", destaque: "d1", url: null, scheduled_at: null, status: "failed", reason: "x" };
      assert.equal(decideResumeOrRetry("d1", [failedEntry], { skipExisting: true, retryIds: null }).action, "dispatch");
    } finally {
      w.restore();
    }
  });

  it("409 already_fired e fire_in_progress continuam sucesso (nada novo, sem lookup)", async () => {
    for (const error of ["already_fired", "fire_in_progress"]) {
      const w = fakeWorker409(error);
      try {
        const key = dailyWorkerQueueIdempotencyKey("instagram", "261127", "d1");
        const res = await enqueueDailyWorkerPost("https://worker.test", "tok", payload(key), {
          logPrefix: "test",
          log: () => {},
        });
        assert.deepEqual(res, { key: "queue:2026-11-27T21:00:00.000Z:instagram-daily:261127:d1:main", recovered: "already_fired" });
        assert.equal(w.listCalls(), 0);
      } finally {
        w.restore();
      }
    }
  });

  it("4xx de validação e 409 ilegível seguem failed", () => {
    assert.equal(dailyWorkerEnqueueFailure(new WorkerQueueError(400, JSON.stringify({ error: "bad" }))).status, "failed");
    assert.equal(isWorkerSendUnknownConflict(new WorkerQueueError(409, "not json")), false);
    assert.equal(isWorkerSendUnknownConflict(new WorkerQueueError(400, conflictBody("send_unknown"))), false);
    assert.equal(isWorkerSendUnknownConflict(new WorkerQueueError(409, conflictBody("send_unknown"))), true);
    assert.equal(dailyWorkerEnqueueFailure(new Error("timeout")).status, "failed");
  });

  it("os dois publishers gravam a falha do enqueue pelo helper, nunca status failed fixo", () => {
    for (const file of ["../scripts/publish-instagram.ts", "../scripts/publish-threads.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      const start = src.indexOf("await enqueueDailyWorkerPost(workerUrl, workerToken, {");
      assert.ok(start > 0, `${file}: enqueue não encontrado`);
      const tail = src.slice(start);
      const catchBlock = tail.slice(tail.indexOf("} catch (e: any) {"), tail.indexOf("continue;"));
      assert.match(catchBlock, /dailyWorkerEnqueueFailure\(e\)/, `${file}: catch do enqueue sem o helper do #14243`);
      assert.doesNotMatch(catchBlock, /status: "failed"/, `${file}: catch do enqueue ainda grava failed fixo`);
    }
  });
});
