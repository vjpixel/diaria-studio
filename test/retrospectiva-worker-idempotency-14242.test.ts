/**
 * test/retrospectiva-worker-idempotency-14242.test.ts (#14242)
 *
 * Os posts da Retrospectiva no Instagram e no Threads iam pra fila do Worker
 * sem `idempotency_key`. O `postToWorkerQueue` repete o POST em 5xx/timeout, e
 * o Worker, sem chave, sorteia um uuid novo a cada POST: um 503 com a entry já
 * gravada virava duas entries e dois posts públicos iguais.
 *
 * Worker falso via `globalThis.fetch` (mesmo formato do de
 * `daily-worker-idempotency-14010-14011.test.ts`): `POST /queue` guarda a entry
 * pela chave (ou por um id novo, sem chave) e pode perder/recusar a resposta;
 * `GET /list` devolve as entries. Sem rede. Contamos as entries no fim: é o
 * número de posts que sairiam.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dispatchRetrospectivaWorkerPost,
  retrospectivaWorkerQueueIdempotencyKey,
  type SocialDispatchInput,
} from "../scripts/publish-retrospectiva-social.ts";
import { postToWorkerQueue, WorkerQueueError, type WorkerQueuePayload } from "../scripts/lib/worker-queue-client.ts";

type PostBehavior = "write_then_503" | "ok" | "503";

/** `first` vale para as `firstN` primeiras chamadas de `POST /queue`; `rest`, para as seguintes. */
function fakeWorker(first: PostBehavior, rest: PostBehavior = first, firstN = 1) {
  const entries = new Map<string, Record<string, unknown>>();
  const postedKeys: Array<string | undefined> = [];
  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    if (url.endsWith("/list")) {
      const items = [...entries].map(([key, e]) => ({ key, ...e }));
      return new Response(JSON.stringify({ count: items.length, items }), { status: 200 });
    }
    if (!url.endsWith("/queue")) throw new Error(`fetch inesperado: ${url}`);
    calls++;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const idem = typeof body.idempotency_key === "string" ? body.idempotency_key : undefined;
    postedKeys.push(idem);
    const b = calls <= firstN ? first : rest;
    if (b === "503") return new Response("upstream", { status: 503 });
    const key = `queue:${String(body.scheduled_at)}:${idem ?? `random-${calls}`}`;
    const duplicate = entries.has(key);
    entries.set(key, body);
    if (b === "write_then_503") return new Response("upstream", { status: 503 });
    return new Response(
      JSON.stringify({ queued: true, key, scheduled_at: body.scheduled_at, destaque: body.destaque, ...(duplicate && { duplicate: true }) }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { entries, postedKeys, restore: () => (globalThis.fetch = saved) };
}

const AT = "2027-01-05T18:00:00.000Z";
const CFG = { cycle: "2612", workerUrl: "https://worker.test", workerToken: "tok" };
const quiet = { log: () => {}, lookupOptions: { backoffMs: 0 } };

function input(historia: "d1" | "d2" | "d3"): SocialDispatchInput {
  const urls = ["capa", "p1", "p2", "p3", "cta"].map((s) => `https://img.test/${historia}-${s}.jpg`);
  return { historia, text: `Post ${historia}`, imageUrls: urls, carouselUrls: urls, scheduledAt: AT };
}

describe("#14242 chave idempotente da Retrospectiva no Instagram e no Threads", () => {
  it("chave fixa por ciclo, história e rede, diferente entre itens, no formato do Worker", () => {
    const keys = (["instagram", "threads"] as const).flatMap((c) =>
      (["d1", "d2", "d3"] as const).map((h) => retrospectivaWorkerQueueIdempotencyKey(c, "2612", h)),
    );
    assert.equal(new Set(keys).size, 6, "3 histórias x 2 redes = 6 posts, 6 chaves");
    for (const k of keys) assert.match(k, /^[A-Za-z0-9._:-]{1,128}$/);
    assert.equal(keys[0], "instagram-retrospectiva:2612:d1:main");
    assert.notEqual(
      retrospectivaWorkerQueueIdempotencyKey("instagram", "2612", "d1"),
      retrospectivaWorkerQueueIdempotencyKey("instagram", "2701", "d1"),
    );
  });

  it("503 com a entry gravada e 200 no retry: as duas tentativas levam a mesma chave, uma entry só", async () => {
    const w = fakeWorker("write_then_503", "ok");
    try {
      const entry = await dispatchRetrospectivaWorkerPost("instagram", input("d1"), CFG, quiet);
      const key = "instagram-retrospectiva:2612:d1:main";
      assert.deepEqual(w.postedKeys, [key, key]);
      assert.equal(w.entries.size, 1, "sem a chave o retry criaria a 2ª entry (2 posts públicos)");
      assert.equal(entry.status, "scheduled");
      assert.equal(entry.worker_queue_key, `queue:${AT}:${key}`);
      assert.equal(entry.platform, "instagram");
    } finally {
      w.restore();
    }
  });

  it("controle: o mesmo cenário sem a chave (payload de antes do fix) deixa 2 entries", async () => {
    const w = fakeWorker("write_then_503", "ok");
    try {
      await postToWorkerQueue(CFG.workerUrl, CFG.workerToken, {
        text: "Post d1",
        image_url: "x",
        image_urls: ["x", "y"],
        scheduled_at: AT,
        destaque: "especial-retrospectiva",
        channel: "instagram",
      }, 2, "test");
      assert.equal(w.entries.size, 2, "o bug do #14242");
    } finally {
      w.restore();
    }
  });

  it("503 nas duas tentativas com a entry gravada: o lookup acha a chave e devolve a entry existente", async () => {
    const w = fakeWorker("write_then_503");
    try {
      const entry = await dispatchRetrospectivaWorkerPost("threads", input("d2"), CFG, quiet);
      assert.equal(w.entries.size, 1);
      assert.equal(entry.status, "scheduled");
      assert.equal(entry.worker_queue_key, `queue:${AT}:threads-retrospectiva:2612:d2:main`);
      assert.equal(entry.platform, "threads");
    } finally {
      w.restore();
    }
  });

  it("re-run do ciclo (falha antes, 200 depois) e as 3 histórias: uma entry por história, nunca duplicada", async () => {
    const w = fakeWorker("write_then_503", "ok", 2);
    try {
      // 1º run: 503 nas 2 tentativas, fila sem a chave na leitura (KV atrasado) = failed.
      await assert.rejects(dispatchRetrospectivaWorkerPost("instagram", input("d1"), CFG, { ...quiet, lookup: async () => ({ status: "absent" }) }), /HTTP 503/);
      for (const h of ["d1", "d2", "d3"] as const) await dispatchRetrospectivaWorkerPost("instagram", input(h), CFG, quiet);
      // Re-run inteiro do ciclo.
      for (const h of ["d1", "d2", "d3"] as const) await dispatchRetrospectivaWorkerPost("instagram", input(h), CFG, quiet);
      assert.equal(w.entries.size, 3, "3 histórias = 3 posts, mesmo depois do re-run");
    } finally {
      w.restore();
    }
  });

  it("Instagram leva image_url (capa); Threads só image_urls", async () => {
    const bodies: WorkerQueuePayload[] = [];
    const post = async (_u: string, _t: string, p: WorkerQueuePayload) => {
      bodies.push(p);
      return { key: `queue:${bodies.length}` };
    };
    await dispatchRetrospectivaWorkerPost("instagram", input("d3"), CFG, { ...quiet, post });
    await dispatchRetrospectivaWorkerPost("threads", input("d3"), CFG, { ...quiet, post });
    assert.equal(bodies[0].image_url, "https://img.test/d3-capa.jpg");
    assert.equal(bodies[1].image_url, null);
    assert.equal(bodies[0].destaque, "especial-retrospectiva");
    assert.equal(bodies[1].idempotency_key, "threads-retrospectiva:2612:d3:main");
  });

  it("409 already_fired: sucesso com a key da entry, sem lookup; 4xx de validação propaga", async () => {
    const fired = await dispatchRetrospectivaWorkerPost("instagram", input("d1"), CFG, {
      ...quiet,
      post: async () => {
        throw new WorkerQueueError(409, JSON.stringify({ error: "already_fired", key: "queue:fired" }));
      },
      lookup: async () => assert.fail("409 não consulta a fila"),
    });
    assert.equal(fired.worker_queue_key, "queue:fired");
    assert.equal(fired.status, "scheduled");

    await assert.rejects(
      dispatchRetrospectivaWorkerPost("instagram", input("d1"), CFG, {
        ...quiet,
        post: async () => {
          throw new WorkerQueueError(400, JSON.stringify({ error: "bad" }));
        },
        lookup: async () => assert.fail("4xx prova que nada foi gravado"),
      }),
      /HTTP 400/,
    );
  });
});
