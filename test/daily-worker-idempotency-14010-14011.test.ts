/**
 * test/daily-worker-idempotency-14010-14011.test.ts (#14010, #14011)
 *
 * #14010 — Instagram e Threads diários (`--schedule`) enfileiravam no Worker
 * sem `idempotency_key`. Retry do POST depois de uma resposta perdida virava
 * duas entries (uuid aleatório no Worker) e dois posts públicos; 503 nas duas
 * tentativas com a entry gravada virava `failed`, e o re-run enfileirava de
 * novo por cima.
 *
 * #14011 — no LinkedIn, o `comment_diaria` (e o `comment_pixel`) saíam sem
 * chave: o lookup da fila do #12664 era pulado e o fallback Make publicava o
 * comentário na hora. O 4º post (USE MELHOR, `um`) ganhou chave com o plano
 * de documento do #13847; o teste trava que ele segue com ela.
 *
 * Worker falso via `globalThis.fetch`, no formato do de
 * `linkedin-make-fallback-12664.test.ts`: `POST /queue` grava a entry pela
 * chave (ou por uuid aleatório, sem chave) e perde/recusa a resposta;
 * `GET /list` devolve as entries. Sem rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dailyWorkerQueueIdempotencyKey,
  dailyWorkerQueueNamespace,
  enqueueDailyWorkerPost,
} from "../scripts/lib/daily-worker-enqueue.ts";
import { WorkerQueueError } from "../scripts/lib/worker-queue-client.ts";
import { linkedInDailyIdempotencyKey } from "../scripts/lib/linkedin-daily-document.ts";
import {
  dispatchEntry,
  useMelhorLinkedInDispatchInput,
  type DispatchContext,
  type DispatchInput,
} from "../scripts/publish-linkedin.ts";

/**
 * `first`: o que a 1ª tentativa do POST faz. `rest`: as seguintes.
 * - `write_then_timeout`: grava a entry e perde a resposta.
 * - `write_then_503`: grava a entry e responde 503.
 * - `ok`: grava (ou acha pela chave) e responde 200.
 */
type PostBehavior = "write_then_timeout" | "write_then_503" | "ok" | "503";

function fakeWorker(first: PostBehavior, rest: PostBehavior = first) {
  const entries = new Map<string, Record<string, unknown>>();
  const postedKeys: Array<string | undefined> = [];
  let makeCalls = 0;
  let queueCalls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    if (url.endsWith("/list")) {
      const items = [...entries].map(([key, e]) => ({ key, ...e }));
      return new Response(JSON.stringify({ count: items.length, items }), { status: 200 });
    }
    if (url.endsWith("/queue")) {
      queueCalls++;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const idem = typeof body.idempotency_key === "string" ? body.idempotency_key : undefined;
      postedKeys.push(idem);
      const b = queueCalls === 1 ? first : rest;
      if (b === "503") return new Response("upstream", { status: 503 });
      // Sem chave, o Worker sorteia um uuid novo a cada POST (index.ts:1040).
      const key = `queue:${String(body.scheduled_at)}:${idem ?? `random-${queueCalls}`}`;
      const duplicate = entries.has(key);
      entries.set(key, body);
      if (b === "write_then_timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (b === "write_then_503") return new Response("upstream", { status: 503 });
      return new Response(
        JSON.stringify({ queued: true, key, scheduled_at: body.scheduled_at, destaque: body.destaque, ...(duplicate && { duplicate: true }) }),
        { status: 200 },
      );
    }
    makeCalls++;
    return new Response(JSON.stringify({ accepted: true, request_id: "make-req" }), { status: 200 });
  }) as typeof fetch;
  return {
    entries,
    postedKeys,
    makeCalls: () => makeCalls,
    restore: () => (globalThis.fetch = saved),
  };
}

const AT = "2026-11-27T21:00:00.000Z";

function igPayload(key: string) {
  return {
    idempotency_key: key,
    text: "Legenda do D1",
    image_url: "https://img.test/d1_4x5.jpg",
    scheduled_at: AT,
    destaque: "d1",
    channel: "instagram" as const,
  };
}

describe("#14010 chave idempotente dos posts diários de Instagram e Threads", () => {
  it("chave fixa por canal, edição e destaque; teste e anual em namespace próprio", () => {
    assert.equal(dailyWorkerQueueIdempotencyKey("instagram", "261127", "d1"), "instagram-daily:261127:d1:main");
    assert.equal(dailyWorkerQueueIdempotencyKey("threads", "261127", "um"), "threads-daily:261127:um:main");
    assert.equal(
      dailyWorkerQueueIdempotencyKey("instagram", "261127", "d1", { isTest: true }),
      "instagram-daily-test:261127:d1:main",
    );
    // Instagram e Threads do mesmo destaque são posts diferentes.
    assert.notEqual(
      dailyWorkerQueueIdempotencyKey("instagram", "261127", "d1"),
      dailyWorkerQueueIdempotencyKey("threads", "261127", "d1"),
    );
    // Lote da anual no mesmo AAMMDD não pode cair na chave da diária (#12584 item 5).
    const annual = dailyWorkerQueueIdempotencyKey("instagram", "261127", "d1", {
      editionDir: "/repo/data/annual/2026-aniversario/social/261127/",
    });
    assert.equal(annual, "instagram-annual-2026-aniversario:261127:d1:main");
    assert.equal(dailyWorkerQueueNamespace("threads", "C:\\repo\\data\\editions\\2611\\261127"), "threads-daily");
  });

  it("timeout depois do commit e 200 no retry: as duas tentativas levam a mesma chave, uma entry só", async () => {
    const w = fakeWorker("write_then_timeout", "ok");
    try {
      const key = dailyWorkerQueueIdempotencyKey("instagram", "261127", "d1");
      const res = await enqueueDailyWorkerPost("https://worker.test", "tok", igPayload(key), {
        logPrefix: "test",
        log: () => {},
      });
      assert.deepEqual(w.postedKeys, [key, key]);
      assert.equal(w.entries.size, 1, "a 2ª tentativa criaria uma 2ª entry, 2 posts públicos");
      assert.equal(res.key, `queue:${AT}:${key}`);
    } finally {
      w.restore();
    }
  });

  it("503 nas duas tentativas com a entry gravada: o lookup acha a chave, não vira failed", async () => {
    const w = fakeWorker("write_then_503");
    try {
      const key = dailyWorkerQueueIdempotencyKey("threads", "261127", "d2");
      const res = await enqueueDailyWorkerPost(
        "https://worker.test",
        "tok",
        { ...igPayload(key), destaque: "d2", channel: "threads", image_url: null },
        { logPrefix: "test", lookupOptions: { backoffMs: 0 }, log: () => {} },
      );
      assert.equal(res.recovered, "queue_lookup");
      assert.equal(res.key, `queue:${AT}:${key}`);
      assert.equal(w.entries.size, 1);
    } finally {
      w.restore();
    }
  });

  it("503 sem gravar e a chave ausente da fila: propaga (o publisher grava failed; re-run cai na mesma chave)", async () => {
    const w = fakeWorker("503");
    try {
      const key = dailyWorkerQueueIdempotencyKey("instagram", "261127", "d3");
      await assert.rejects(
        enqueueDailyWorkerPost("https://worker.test", "tok", igPayload(key), {
          logPrefix: "test",
          lookupOptions: { backoffMs: 0 },
          log: () => {},
        }),
        /Worker queue HTTP 503/,
      );
    } finally {
      w.restore();
    }
  });

  it("409 already_fired da chave: sucesso, nada novo; 4xx de validação propaga sem lookup", async () => {
    const key = dailyWorkerQueueIdempotencyKey("instagram", "261127", "d1");
    const fired = await enqueueDailyWorkerPost("https://worker.test", "tok", igPayload(key), {
      logPrefix: "test",
      log: () => {},
      post: async () => {
        throw new WorkerQueueError(409, JSON.stringify({ error: "already_fired", key: "queue:x:y" }));
      },
      lookup: async () => assert.fail("409 não consulta a fila"),
    });
    assert.deepEqual(fired, { key: "queue:x:y", recovered: "already_fired" });

    await assert.rejects(
      enqueueDailyWorkerPost("https://worker.test", "tok", igPayload(key), {
        logPrefix: "test",
        log: () => {},
        post: async () => {
          throw new WorkerQueueError(400, JSON.stringify({ error: "bad" }));
        },
        lookup: async () => assert.fail("4xx de validação prova que nada foi gravado"),
      }),
      /HTTP 400/,
    );
  });

  it("fila ilegível depois da falha: propaga avisando que o post pode estar na fila", async () => {
    const key = dailyWorkerQueueIdempotencyKey("threads", "261127", "d1");
    await assert.rejects(
      enqueueDailyWorkerPost("https://worker.test", "tok", igPayload(key), {
        logPrefix: "test",
        log: () => {},
        post: async () => {
          throw new Error("timeout");
        },
        lookup: async () => ({ status: "error", error: "kv down" }),
      }),
      /fila do Worker ilegível.*pode estar na fila/,
    );
  });

  it("os dois publishers enfileiram pelo helper idempotente, com a chave do próprio canal", () => {
    for (const [file, ch] of [
      ["../scripts/publish-instagram.ts", "instagram"],
      ["../scripts/publish-threads.ts", "threads"],
    ] as const) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.match(src, /await enqueueDailyWorkerPost\(workerUrl, workerToken, \{/, `${file}: enqueue sem o helper`);
      assert.ok(
        src.includes(`idempotency_key: dailyWorkerQueueIdempotencyKey("${ch}", editionDate, d, { isTest, editionDir })`),
        `${file}: POST /queue sem idempotency_key do canal`,
      );
      assert.doesNotMatch(src, /await postToWorkerQueue\(workerUrl, workerToken, \{/, `${file}: sobrou enqueue sem chave`);
    }
  });
});

// ── #14011 LinkedIn: comentários e 4º post ──────────────────────────────────

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

const FUTURE = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

function commentInput(over: Partial<DispatchInput> = {}): DispatchInput {
  return {
    destaque: "d1",
    subtype: "comment_diaria",
    text: "Comentário da diar.ia.br",
    imageUrl: null,
    scheduledAt: FUTURE(),
    webhookTarget: "diaria",
    action: "comment",
    parentDestaque: "d1",
    ...over,
  };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "daily-idem-14011-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#14011 LinkedIn: comment_diaria e 4º post com idempotency_key", () => {
  it("chave do comentário é distinta da do post principal do mesmo destaque", () => {
    const main = linkedInDailyIdempotencyKey("260999", "d1");
    const cd = linkedInDailyIdempotencyKey("260999", "d1", { slot: "comment_diaria" });
    const cp = linkedInDailyIdempotencyKey("260999", "d1", { slot: "comment_pixel" });
    assert.equal(main, "linkedin-daily:260999:d1:main");
    assert.equal(cd, "linkedin-daily:260999:d1:comment_diaria");
    assert.equal(new Set([main, cd, cp]).size, 3);
  });

  it("comment_diaria: Worker grava e responde 503 — POST com chave, lookup acha, sem Make", async () => {
    const w = fakeWorker("write_then_503");
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(commentInput(), ctx(dir));
        const key = "linkedin-daily:260999:d1:comment_diaria";
        assert.deepEqual(w.postedKeys, [key, key]);
        assert.equal(w.makeCalls(), 0, "o Make publicaria o comentário na hora, por cima do agendado");
        assert.equal(w.entries.size, 1);
        assert.equal(entry.status, "scheduled");
        assert.ok(String(entry.worker_queue_key).endsWith(key));
        assert.equal(entry.fallback_used, undefined);
      });
    } finally {
      w.restore();
    }
  });

  it("comment_pixel também leva chave própria (retry não duplica a entry)", async () => {
    const w = fakeWorker("write_then_timeout", "ok");
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(
          commentInput({ subtype: "comment_pixel", webhookTarget: "pixel" }),
          ctx(dir),
        );
        assert.deepEqual(w.postedKeys, [
          "linkedin-daily:260999:d1:comment_pixel",
          "linkedin-daily:260999:d1:comment_pixel",
        ]);
        assert.equal(w.entries.size, 1);
        assert.equal(entry.status, "scheduled");
      });
    } finally {
      w.restore();
    }
  });

  it("4º post (um), mesmo com documento em opt-out: POST com chave, lookup acha, sem Make", async () => {
    const w = fakeWorker("write_then_503");
    try {
      await withDir(async (dir) => {
        const input = useMelhorLinkedInDispatchInput({
          built: { text: "USE MELHOR", imageUrl: "https://img.test/um.jpg", carouselUrls: null },
          scheduledAt: FUTURE(),
          optOut: true,
          captionTitle: "Use melhor",
          editionDir: dir,
          editionDate: "260999",
          upload: async () => assert.fail("opt-out não gera PDF"),
        });
        const entry = await dispatchEntry(input, ctx(dir));
        const key = "linkedin-daily:260999:um:main";
        assert.deepEqual(w.postedKeys, [key, key]);
        assert.equal(w.makeCalls(), 0);
        assert.equal(entry.status, "scheduled");
      });
    } finally {
      w.restore();
    }
  });
});
