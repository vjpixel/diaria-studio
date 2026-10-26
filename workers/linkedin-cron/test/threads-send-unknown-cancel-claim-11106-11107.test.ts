/**
 * #11106 — resposta AMBÍGUA do `threads_publish` (timeout/rede, 5xx, 2xx sem id)
 * virava `failed` → `retry_count` → o cron seguinte refazia container + publish
 * e o post saía duplicado. Agora é `send_unknown`: DLQ com `last_error`
 * `send_unknown: ...`, DO marcado como disparado, nunca refeito — pelo cron e
 * pelo alarm (que não escreve no KV: grava o motivo no DO e o cron move).
 *
 * #11107 — duas corridas do conteúdo mudado:
 *   1. `/cancel` ignorava um claim em andamento: o enqueue checava `/status` e
 *      só depois cancelava; se o alarm/cron ganhasse o `/claim` no meio, o
 *      `deleteAll` apagava o `claiming` e o `/arm` seguinte armava o payload novo.
 *   2. O cron disparava a cópia do KV lida ANTES do `/claim`, mesmo que um
 *      re-enqueue completo tivesse trocado o conteúdo nesse meio-tempo.
 *
 * Fetch da Meta mockado; nenhuma chamada real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { type Env, type QueueEntry, __test__ } from "../src/index.ts";
import { LinkedInScheduler } from "../src/durable-object.ts";
import { fireQueueEntry } from "../src/dispatch.ts";

class MockStorage {
  store = new Map<string, unknown>();
  async get<T>(k: string): Promise<T | undefined> { return this.store.get(k) as T | undefined; }
  async put(k: string, v: unknown): Promise<void> { this.store.set(k, v); }
  async delete(k: string): Promise<void> { this.store.delete(k); }
  async deleteAll(): Promise<void> { this.store.clear(); }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}
class MockState {
  storage = new MockStorage();
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
}

const DUE = new Date(Date.now() - 60_000).toISOString();
const post = (over: Record<string, unknown> = {}) => ({
  text: "Texto velho",
  image_url: null,
  scheduled_at: DUE,
  destaque: "d1",
  channel: "threads",
  idempotency_key: "threads-261025-d1",
  ...over,
});

function mkEnv(onCall?: (path: string) => Promise<void>) {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async (o: { prefix?: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().map((name) => ({ name })),
      list_complete: true,
    }),
  };
  const schedulers = new Map<string, { scheduler: LinkedInScheduler; state: MockState }>();
  const get = (name: string) => {
    if (!schedulers.has(name)) {
      const state = new MockState();
      schedulers.set(name, { scheduler: new LinkedInScheduler(state as unknown as DurableObjectState), state });
    }
    return schedulers.get(name)!;
  };
  const env = {
    LINKEDIN_QUEUE: kv as unknown as KVNamespace,
    DIARIA_TOKEN: "secret-token",
    MAKE_WEBHOOK_URL: "https://make.test/diaria",
    THREADS_USER_ID: "threads-user",
    THREADS_ACCESS_TOKEN: "threads-token",
    LINKEDIN_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init?: RequestInit) => {
          if (onCall) await onCall(new URL(url).pathname);
          return get(id.name).scheduler.fetch(new Request(url, init));
        },
      }),
    },
  } as unknown as Env;
  return { env, store, get };
}

function enqueue(env: Env, payload: Record<string, unknown>): Promise<Response> {
  return workerDefault.fetch(
    new Request("https://w.test/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
      body: JSON.stringify(payload),
    }),
    env,
  ) as Promise<Response>;
}

type PublishMode = "ok" | "timeout" | "503" | "200-no-id" | "200-not-json" | "400";

/** Graph do Threads: registra o texto de cada container criado e cada publish. */
function mockThreads(mode: PublishMode = "ok") {
  const g = { containers: [] as string[], publishes: 0 };
  globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.url;
    if (u.endsWith("/threads_publish")) {
      g.publishes++;
      if (mode === "timeout") {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      }
      if (mode === "503") return new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 });
      if (mode === "200-no-id") return new Response("{}", { status: 200 });
      if (mode === "200-not-json") return new Response("<html>", { status: 200 });
      if (mode === "400") return new Response(JSON.stringify({ error: { message: "Media not available" } }), { status: 400 });
      return new Response(JSON.stringify({ id: `media-${g.publishes}` }), { status: 200 });
    }
    if (u.endsWith("/threads")) {
      g.containers.push(new URLSearchParams(String(init?.body ?? "")).get("text") ?? "?");
      return new Response(JSON.stringify({ id: `container-${g.containers.length}` }), { status: 200 });
    }
    // poll de status (caminhos com imagem)
    if (u.includes("fields=status")) return new Response(JSON.stringify({ status: "FINISHED" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return g;
}

let originalFetch: typeof fetch;
let realSetTimeout: typeof setTimeout;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = realSetTimeout;
});

const dlqEntries = (store: Map<string, string>) =>
  [...store.entries()].filter(([k]) => k.startsWith("dlq:")).map(([, v]) => JSON.parse(v) as QueueEntry);

describe("#11106 cron: threads_publish ambíguo não é refeito", () => {
  for (const mode of ["timeout", "503", "200-no-id", "200-not-json"] as const) {
    it(`${mode} → DLQ send_unknown, 1 publish só, mesmo com mais voltas do cron`, async () => {
      const g = mockThreads(mode);
      const { env, store, get } = mkEnv();
      const res = await enqueue(env, post());
      assert.equal(res.status, 202);
      const { key } = (await res.json()) as { key: string };

      const r1 = await __test__.fireDueItems(env);
      assert.equal(r1.dlq, 1);
      assert.equal(store.has(key), false, "sai da fila");
      const dlq = dlqEntries(store);
      assert.equal(dlq.length, 1);
      assert.match(dlq[0].last_error ?? "", /^send_unknown: /);

      await __test__.fireDueItems(env);
      await get(key).scheduler.alarm();
      assert.equal(g.publishes, 1, "nenhuma nova tentativa de publicar");
      assert.equal(get(key).state.storage.store.get("fired"), true, "DO marcado como disparado");
      assert.equal(get(key).state.storage.store.has("payload"), false);
    });
  }

  it("400 no threads_publish continua retriable (nada saiu)", async () => {
    mockThreads("400");
    const { env, store } = mkEnv();
    const { key } = (await (await enqueue(env, post())).json()) as { key: string };
    const r = await __test__.fireDueItems(env);
    assert.equal(r.dlq, 0);
    assert.equal(r.errors, 1);
    assert.equal((JSON.parse(store.get(key)!) as QueueEntry).retry_count, 1);
  });
});

describe("#11106 alarm: threads_publish ambíguo não volta pro cron", () => {
  it("503 no alarm → DO grava send_unknown; o cron move pra DLQ sem refazer", async () => {
    const g = mockThreads("503");
    const { env, store, get } = mkEnv();
    const { key } = (await (await enqueue(env, post())).json()) as { key: string };

    await get(key).scheduler.alarm();
    const storage = get(key).state.storage.store;
    assert.match(String(storage.get("send_unknown")), /^send_unknown: /);
    assert.equal(storage.get("fired"), true);
    assert.equal(storage.has("claiming"), false);

    const r = await __test__.fireDueItems(env);
    assert.equal(r.dlq, 1);
    assert.equal(store.has(key), false);
    assert.match(dlqEntries(store)[0].last_error ?? "", /^send_unknown: /);
    assert.equal(g.publishes, 1, "o cron não refaz o publish");
  });
});

describe("#11106 classificação nos caminhos com imagem", () => {
  const creds = { userId: "u", accessToken: "t", apiVersion: "v1.0" };
  const base = { text: "x", scheduled_at: DUE, destaque: "d1", created_at: DUE, channel: "threads" as const };

  it("imagem única: 2xx sem id → send_unknown; 400 → failed", async () => {
    mockThreads("200-no-id");
    const amb = await fireQueueEntry({ ...base, image_url: null, image_urls: ["https://x/1.jpg"] } as QueueEntry, { webhookUrl: "", threads: creds });
    assert.equal(amb.status, "send_unknown");
    mockThreads("400");
    const def = await fireQueueEntry({ ...base, image_url: null, image_urls: ["https://x/1.jpg"] } as QueueEntry, { webhookUrl: "", threads: creds });
    assert.equal(def.status, "failed");
  });

  it("carrossel: timeout → send_unknown; 400 → dlq (como antes)", async () => {
    const urls = ["https://x/1.jpg", "https://x/2.jpg"];
    mockThreads("timeout");
    const amb = await fireQueueEntry({ ...base, image_url: null, image_urls: urls } as QueueEntry, { webhookUrl: "", threads: creds });
    assert.equal(amb.status, "send_unknown");
    mockThreads("400");
    const def = await fireQueueEntry({ ...base, image_url: null, image_urls: urls } as QueueEntry, { webhookUrl: "", threads: creds });
    assert.equal(def.status, "dlq");
  });
});

describe("#11107 /cancel respeita claim em andamento", () => {
  it("if_not_claiming: 409 com claim válido e nada apagado; sem o body, cancela", async () => {
    const state = new MockState();
    const s = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("payload", { key: "k" });
    const claim = await s.fetch(new Request("https://do/claim", { method: "POST" }));
    assert.equal(((await claim.json()) as { claimed: boolean }).claimed, true);

    const refused = await s.fetch(new Request("https://do/cancel", { method: "POST", body: JSON.stringify({ if_not_claiming: true }) }));
    assert.equal(refused.status, 409);
    assert.equal(state.storage.store.get("claiming"), true);
    assert.ok(state.storage.store.has("payload"));

    const forced = await s.fetch(new Request("https://do/cancel", { method: "POST" }));
    assert.equal(forced.status, 200);
    assert.equal(state.storage.store.size, 0);
  });

  it("enqueue de conteúdo mudado com o claim ganho entre /status e /cancel → 409 fire_in_progress", async () => {
    mockThreads();
    let race = false;
    // eslint-disable-next-line prefer-const
    let ctx: ReturnType<typeof mkEnv>;
    let key = "";
    ctx = mkEnv(async (path) => {
      if (race && path === "/cancel") {
        race = false;
        // O alarm (ou o cron) ganha o claim exatamente aqui.
        const r = await ctx.get(key).scheduler.fetch(new Request("https://do/claim", { method: "POST" }));
        assert.equal(((await r.json()) as { claimed: boolean }).claimed, true);
      }
    });
    ({ key } = (await (await enqueue(ctx.env, post())).json()) as { key: string });
    race = true;
    const res = await enqueue(ctx.env, post({ text: "Texto novo" }));
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error?: string }).error, "fire_in_progress");
    const storage = ctx.get(key).state.storage.store;
    assert.equal(storage.get("claiming"), true, "o claim do disparo em curso sobrevive");
    assert.equal((storage.get("payload") as { entry: QueueEntry }).entry.text, "Texto velho", "payload novo não foi armado");
    assert.equal((JSON.parse(ctx.store.get(key)!) as QueueEntry).text, "Texto velho", "KV não recebeu o conteúdo novo");
  });
});

describe("#11107 cron não dispara a cópia do KV lida antes do claim", () => {
  it("re-enqueue completo entre o get do KV e o /claim → não publica o texto velho", async () => {
    const g = mockThreads();
    let race = false;
    // eslint-disable-next-line prefer-const
    let ctx: ReturnType<typeof mkEnv>;
    ctx = mkEnv(async (path) => {
      if (race && path === "/status") {
        race = false;
        const r = await enqueue(ctx.env, post({ text: "Texto novo" }));
        assert.equal(r.status, 202, "o re-enqueue completa antes do claim do cron");
      }
    });
    const { key } = (await (await enqueue(ctx.env, post())).json()) as { key: string };
    race = true;
    const r1 = await __test__.fireDueItems(ctx.env);
    assert.equal(r1.fired, 0);
    assert.equal(g.containers.length, 0, "a cópia velha não é disparada");
    assert.equal(ctx.get(key).state.storage.store.has("claiming"), false, "claim liberado");
    assert.equal((JSON.parse(ctx.store.get(key)!) as QueueEntry).text, "Texto novo", "a key com o conteúdo novo continua na fila");

    await __test__.fireDueItems(ctx.env);
    assert.deepEqual(g.containers, ["Texto novo"]);
    assert.equal(ctx.store.has(key), false);
  });

  it("KV trocado sem payload novo no DO (só a releitura pega) → não dispara a cópia velha", async () => {
    const g = mockThreads();
    let race = false;
    // eslint-disable-next-line prefer-const
    let ctx: ReturnType<typeof mkEnv>;
    let key = "";
    ctx = mkEnv(async (path) => {
      if (race && path === "/claim") {
        race = false;
        const current = JSON.parse(ctx.store.get(key)!) as QueueEntry;
        ctx.store.set(key, JSON.stringify({ ...current, text: "Texto novo" }));
      }
    });
    ({ key } = (await (await enqueue(ctx.env, post())).json()) as { key: string });
    race = true;
    const r = await __test__.fireDueItems(ctx.env);
    assert.equal(r.fired, 0);
    assert.equal(g.containers.length, 0, "a cópia lida antes do claim não é disparada");
    assert.equal(ctx.get(key).state.storage.store.has("claiming"), false, "claim liberado");
  });

  it("conteúdo igual: dispara normalmente (sem regressão)", async () => {
    const g = mockThreads();
    const { env, store } = mkEnv();
    const { key } = (await (await enqueue(env, post())).json()) as { key: string };
    const r = await __test__.fireDueItems(env);
    assert.equal(r.fired, 1);
    assert.deepEqual(g.containers, ["Texto velho"]);
    assert.equal(store.has(key), false);
  });
});


describe("#11133 reserva do enqueue entre cancel e KV put", () => {
  it("claim após TTL antes do arm preserva o novo, sem rollback para o antigo", async () => {
    const g = mockThreads();
    const ctx = mkEnv();
    const { key } = await (await enqueue(ctx.env, post())).json() as { key: string };
    const originalPut = ctx.env.LINKEDIN_QUEUE.put.bind(ctx.env.LINKEDIN_QUEUE);
    let race = true;
    ctx.env.LINKEDIN_QUEUE.put = (async (k: string, value: string) => {
      await originalPut(k, value);
      if (race && k === key) {
        race = false;
        ctx.get(key).state.storage.store.set("claimed_at", 0);
        // O claim substitui a reserva vencida; a liberação atrasada do dono
        // não pode liberar este claim de publicação.
        const token = ctx.get(key).state.storage.store.get("replacement_token");
        const claim = await ctx.get(key).scheduler.fetch(new Request("https://do/claim", { method: "POST" }));
        assert.equal((await claim.json() as { claimed: boolean }).claimed, true);
        await ctx.get(key).scheduler.fetch(new Request("https://do/release-replacement", {
          method: "POST", body: JSON.stringify({ replacement_token: token }),
        }));
        assert.equal(ctx.get(key).state.storage.store.get("claiming"), true);
      }
    }) as KVNamespace["put"];
    const res = await enqueue(ctx.env, post({ text: "Texto novo" }));
    assert.equal(res.status, 409);
    assert.equal((JSON.parse(ctx.store.get(key)!) as QueueEntry).text, "Texto novo");
    await ctx.get(key).scheduler.fetch(new Request("https://do/release-claim", { method: "POST" }));
    await __test__.fireDueItems(ctx.env);
    assert.deepEqual(g.containers, ["Texto novo"]);
  });

  for (const armFails of [false, true]) {
    for (const expired of [false, true]) {
    it(`cron entre cancel e put não dispara nem apaga conteúdo novo (armFails=${armFails}, expired=${expired})`, async () => {
      const g = mockThreads();
      const ctx = mkEnv();
      const { key } = await (await enqueue(ctx.env, post())).json() as { key: string };
      const originalPut = ctx.env.LINKEDIN_QUEUE.put.bind(ctx.env.LINKEDIN_QUEUE);
      let race = true;
      ctx.env.LINKEDIN_QUEUE.put = (async (k: string, value: string) => {
        if (race && k === key) {
          race = false;
          // /cancel já completou; o KV ainda contém a entry velha vencida.
          if (expired) ctx.get(key).state.storage.store.set("claimed_at", 0);
          const r = await __test__.fireDueItems(ctx.env);
          assert.equal(r.fired, 0);
          await ctx.get(key).scheduler.alarm();
          assert.deepEqual(g.containers, []);
        }
        await originalPut(k, value);
      }) as KVNamespace["put"];
      if (armFails) {
        const scheduler = ctx.get(key).scheduler;
        const originalFetch = scheduler.fetch.bind(scheduler);
        scheduler.fetch = async (req: Request) => new URL(req.url).pathname === "/arm"
          ? new Response("unavailable", { status: 503 }) : originalFetch(req);
      }
      const res = await enqueue(ctx.env, post({ text: "Texto novo" }));
      assert.equal(res.status, 202);
      assert.equal((JSON.parse(ctx.store.get(key)!) as QueueEntry).text, "Texto novo");
      assert.equal(ctx.get(key).state.storage.store.has("claiming"), false);
      await __test__.fireDueItems(ctx.env);
      assert.deepEqual(g.containers, ["Texto novo"]);
      assert.equal(ctx.store.has(key), false);
    });
  }
  }
});
