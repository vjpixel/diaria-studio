/**
 * test/linkedin-single-image-409-12802.test.ts (#12802)
 *
 * O degrau de imagem única da diária manda `idempotency_key` (#12664). Se o
 * Worker responde 409 `already_fired`/`fire_in_progress`, o post desta chave já
 * saiu ou está saindo: é sucesso, como nos degraus documento/carrossel. Antes o
 * `isClientError` lia o 409 como 4xx de validação e a entry virava `failed`,
 * empurrando o editor a repostar à mão (post duplicado).
 *
 * Worker falso responde o 409 no formato do real (`{ error, key, message }`).
 * Contamos as chamadas ao Make: cada uma é um post público na hora.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchEntry, type DispatchContext, type DispatchInput } from "../scripts/publish-linkedin.ts";

const FIRED_KEY = "queue:2026-11-11T12:00:00.000Z:linkedin-daily:260999:d1:main";

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

function fakeWorker409(error: string) {
  let makeCalls = 0;
  let listCalls = 0;
  const bodies: Array<Record<string, unknown>> = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    if (url.endsWith("/list")) {
      listCalls++;
      return new Response(JSON.stringify({ count: 0, items: [] }), { status: 200 });
    }
    if (url.endsWith("/queue")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          message: "entry desta idempotency_key já disparou ou está disparando; nada novo enfileirado. ".repeat(5),
          error,
          key: FIRED_KEY,
        }),
        { status: 409 },
      );
    }
    makeCalls++;
    return new Response(JSON.stringify({ accepted: true, request_id: "make-req" }), { status: 200 });
  }) as typeof fetch;
  return {
    bodies,
    makeCalls: () => makeCalls,
    listCalls: () => listCalls,
    restore: () => (globalThis.fetch = saved),
  };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "linkedin-409-12802-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#12802 409 idempotente no degrau de imagem única", () => {
  for (const error of ["already_fired", "fire_in_progress"]) {
    it(`409 ${error}: scheduled com a key da entry, sem Make`, async () => {
      const w = fakeWorker409(error);
      try {
        await withDir(async (dir) => {
          const entry = await dispatchEntry(input(), ctx(dir));
          assert.equal(w.bodies[0]?.idempotency_key, "linkedin-daily:260999:d1:main");
          assert.equal(entry.status, "scheduled", String(entry.reason));
          assert.equal(entry.worker_queue_key, FIRED_KEY);
          assert.equal(entry.format, "single_image");
          assert.equal(entry.fallback_used, undefined);
          assert.equal(w.makeCalls(), 0, "o Make publicaria por cima do post já disparado");
          assert.equal(w.listCalls(), 0);
        });
      } finally {
        w.restore();
      }
    });
  }

  it("409 send_unknown (disparo ambíguo): failed, sem Make", async () => {
    const w = fakeWorker409("send_unknown");
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input(), ctx(dir));
        assert.equal(entry.status, "failed");
        assert.equal(w.makeCalls(), 0);
      });
    } finally {
      w.restore();
    }
  });

  it("409 already_fired num post sem chave idempotente: segue failed (4xx), sem Make", async () => {
    const w = fakeWorker409("already_fired");
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input({ linkedInDocument: undefined }), ctx(dir));
        assert.equal(w.bodies[0]?.idempotency_key, undefined);
        assert.equal(entry.status, "failed");
        assert.match(String(entry.reason), /Worker 4xx/);
        assert.equal(w.makeCalls(), 0);
      });
    } finally {
      w.restore();
    }
  });
});
