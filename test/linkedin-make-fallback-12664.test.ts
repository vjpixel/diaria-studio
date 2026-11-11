/**
 * test/linkedin-make-fallback-12664.test.ts (#12664)
 *
 * O degrau de imagem única do LinkedIn da diária cai no Make (post imediato,
 * #887) quando a fila do Worker responde 5xx ou expira. Se o Worker já tinha
 * gravado a entry, saíam dois posts: o do Make agora e o da fila no horário.
 *
 * O Worker falso grava a entry e perde a resposta (ou recusa sem gravar), e
 * responde `GET /list` como o real (`{ count, items: [{ key, idempotency_key, ... }] }`).
 * Contamos as chamadas ao Make: cada uma é um post público na hora.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchEntry, type DispatchContext, type DispatchInput } from "../scripts/publish-linkedin.ts";
import { findWorkerQueueEntryByIdempotencyKey } from "../scripts/lib/worker-queue-client.ts";

const KEY = "linkedin-daily:260999:d1:main";

function input(over: Partial<DispatchInput> = {}): DispatchInput {
  return {
    destaque: "d1",
    subtype: "main",
    text: "Post agendado",
    imageUrl: "https://img.test/d1_4x5.jpg",
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    webhookTarget: "diaria",
    action: "post",
    // Vai direto ao degrau da imagem única, com a chave da diária (#12661).
    linkedInDocument: { status: "skip", reason: "opt_out" },
    ...over,
  };
}

function ctx(dir: string): DispatchContext {
  return {
    publishedPath: join(dir, "06-social-published.json"),
    webhookUrl: "https://hook.test/diaria",
    workerUrl: "https://worker.test",
    workerToken: "test-tok",
    useWorkerForScheduled: true,
    editionDate: "260999",
    rootDir: dir,
    queueLookup: { backoffMs: 0 },
  };
}

/** POST /queue: grava e perde a resposta, ou recusa com 503 sem gravar. */
type QueueBehavior = "write_then_timeout" | "503";
/** GET /list: o que a fila mostra (`lag` = ainda não lista a entry gravada). */
type ListBehavior = "ok" | "lag" | "500";

function fakeWorker(queue: QueueBehavior, list: ListBehavior[]) {
  const entries = new Map<string, Record<string, unknown>>();
  let makeCalls = 0;
  let listCalls = 0;
  let queueCalls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    if (url.endsWith("/list")) {
      const b = list[Math.min(listCalls, list.length - 1)];
      listCalls++;
      if (b === "500") return new Response("kv down", { status: 500 });
      const items = b === "lag" ? [] : [...entries].map(([key, e]) => ({ key, ...e }));
      return new Response(JSON.stringify({ count: items.length, items }), { status: 200 });
    }
    if (url.endsWith("/queue")) {
      queueCalls++;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (queue === "503") return new Response("upstream", { status: 503 });
      const idem = typeof body.idempotency_key === "string" ? body.idempotency_key : `random-${queueCalls}`;
      entries.set(`queue:2026-11-11T12:00:00.000Z:${idem}`, body);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    makeCalls++;
    return new Response(JSON.stringify({ accepted: true, request_id: "make-req" }), { status: 200 });
  }) as typeof fetch;
  return {
    entries,
    makeCalls: () => makeCalls,
    listCalls: () => listCalls,
    restore: () => (globalThis.fetch = saved),
  };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "linkedin-make-12664-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#12664 fallback Make do degrau de imagem única", () => {
  it("Worker gravou e expirou: a entry está na fila, agendado sem Make", async () => {
    const w = fakeWorker("write_then_timeout", ["ok"]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input(), ctx(dir));
        assert.equal(w.makeCalls(), 0, "o Make publicaria por cima da entry da fila");
        assert.equal(w.entries.size, 1);
        assert.equal(entry.status, "scheduled");
        assert.equal(entry.worker_queue_key, `queue:2026-11-11T12:00:00.000Z:${KEY}`);
        assert.equal(entry.fallback_used, undefined);
        assert.equal(entry.format, "single_image");
      });
    } finally {
      w.restore();
    }
  });

  it("lag do KV: a 1ª leitura não lista, a 2ª acha — sem Make", async () => {
    const w = fakeWorker("write_then_timeout", ["lag", "ok"]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input(), ctx(dir));
        assert.equal(w.listCalls(), 2);
        assert.equal(w.makeCalls(), 0);
        assert.equal(entry.status, "scheduled");
      });
    } finally {
      w.restore();
    }
  });

  it("503 sem gravar e a chave ausente em todas as leituras: cai no Make (#887)", async () => {
    const w = fakeWorker("503", ["ok"]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input(), ctx(dir));
        assert.equal(w.listCalls(), 3, "lê a fila 3 vezes antes de concluir ausência");
        assert.equal(w.makeCalls(), 1);
        assert.equal(entry.fallback_used, true);
        assert.equal(entry.status, "draft");
      });
    } finally {
      w.restore();
    }
  });

  it("fila ilegível depois do timeout: failed, sem Make por cima", async () => {
    const w = fakeWorker("write_then_timeout", ["500"]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input(), ctx(dir));
        assert.equal(w.makeCalls(), 0);
        assert.equal(entry.status, "failed");
        assert.match(String(entry.reason), /#12664/);
      });
    } finally {
      w.restore();
    }
  });

  it("post sem chave (sem plano de documento): fallback Make de sempre, sem ler a fila", async () => {
    const w = fakeWorker("503", ["ok"]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input({ linkedInDocument: undefined }), ctx(dir));
        assert.equal(w.listCalls(), 0);
        assert.equal(w.makeCalls(), 1);
        assert.equal(entry.fallback_used, true);
      });
    } finally {
      w.restore();
    }
  });
});

describe("findWorkerQueueEntryByIdempotencyKey", () => {
  it("corpo sem items é erro, nunca ausência", async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ count: 0 }), { status: 200 })) as typeof fetch;
    try {
      const r = await findWorkerQueueEntryByIdempotencyKey("https://worker.test", "t", KEY, { backoffMs: 0 });
      assert.equal(r.status, "error");
    } finally {
      globalThis.fetch = saved;
    }
  });

  it("rede caída é erro, nunca ausência", async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    try {
      const r = await findWorkerQueueEntryByIdempotencyKey("https://worker.test", "t", KEY, { backoffMs: 0 });
      assert.equal(r.status, "error");
    } finally {
      globalThis.fetch = saved;
    }
  });
});
