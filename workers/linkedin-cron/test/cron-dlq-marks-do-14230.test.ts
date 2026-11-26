/**
 * #14230 — o desfecho `dlq` decidido pelo CRON (outcome `dlq` de
 * `fireQueueEntry` ou retries esgotados) só liberava o claim do DO: o DO
 * ficava com o `payload` e sem `dlq_reason`, e um alarm que disparasse depois
 * refazia o post (no carrossel do Instagram, uma 2ª cópia). Agora o cron chama
 * `/mark-dlq`, a mesma marcação do `dlq` do alarm (#14218, `markDlq`).
 * Graph da Meta mockada; nenhuma chamada real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { MAX_RETRIES, type Env, type QueueEntry, __test__ } from "../src/index.ts";
import { LinkedInScheduler } from "../src/durable-object.ts";

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
const CAROUSEL = ["https://x.test/1.jpg", "https://x.test/2.jpg", "https://x.test/3.jpg"];

function mkEnv() {
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
    INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig-user",
    INSTAGRAM_ACCESS_TOKEN: "ig-token",
    LINKEDIN_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init?: RequestInit) => get(id.name).scheduler.fetch(new Request(url, init)),
      }),
    },
  } as unknown as Env;
  return { env, store, get };
}

async function enqueue(env: Env, over: Record<string, unknown> = {}): Promise<string> {
  const res = await workerDefault.fetch(
    new Request("https://w.test/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
      body: JSON.stringify({
        text: "Legenda do destaque",
        image_url: "https://x.test/capa.jpg",
        scheduled_at: DUE,
        destaque: "d1",
        channel: "instagram",
        ...over,
      }),
    }),
    env,
  ) as Response;
  assert.equal(res.status, 202, await res.clone().text());
  return ((await res.json()) as { key: string }).key;
}

/** Graph do Instagram: conta containers (filhos e pai) e publishes. */
function mockGraph(opts: { childFailAt?: number; mediaStatus?: number } = {}) {
  const g = { mediaPosts: 0, children: 0, publishes: 0 };
  globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.url;
    const body = String(init?.body ?? "");
    if (u.endsWith("/media_publish")) {
      g.publishes++;
      return new Response(JSON.stringify({ id: `ig-media-${g.publishes}` }), { status: 200 });
    }
    if (u.includes("fields=status_code")) {
      return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
    }
    if (u.endsWith("/media")) {
      g.mediaPosts++;
      if (opts.mediaStatus) {
        return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: opts.mediaStatus });
      }
      if (body.includes("is_carousel_item=true")) {
        g.children++;
        if (opts.childFailAt === g.children) {
          return new Response(JSON.stringify({ error: { message: "Invalid image" } }), { status: 400 });
        }
      }
      return new Response(JSON.stringify({ id: `container-${g.mediaPosts}` }), { status: 200 });
    }
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

describe("#14230 dlq decidido pelo cron marca o DO como o alarm faz", () => {
  it("carrossel: filho falha no cron → DO com dlq_reason, sem payload; alarm tardio não refaz nada", async () => {
    const g = mockGraph({ childFailAt: 2 });
    const { env, store, get } = mkEnv();
    const key = await enqueue(env, { image_url: null, image_urls: CAROUSEL });

    const r = await __test__.fireDueItems(env);
    assert.equal(r.dlq, 1);
    assert.equal(store.has(key), false, "sai da fila");
    assert.match(dlqEntries(store)[0].last_error ?? "", /child container 2\/3/);

    const storage = get(key).state.storage.store;
    assert.match(String(storage.get("dlq_reason")), /child container 2\/3/, "dlq_reason gravado no DO");
    assert.equal(storage.has("payload"), false, "payload apagado: alarm não tem o que postar");
    assert.equal(storage.has("claiming"), false, "claim do cron liberado");
    assert.equal(storage.has("claim_token"), false);

    const mediaAfterCron = g.mediaPosts;
    await get(key).scheduler.alarm();
    assert.equal(g.mediaPosts, mediaAfterCron, "o alarm tardio não recria nenhum container");
    assert.equal(g.publishes, 0, "nada publicado");

    const claim = await get(key).scheduler.fetch(new Request("https://do/claim", { method: "POST" }));
    assert.equal(((await claim.json()) as { claimed: boolean }).claimed, false, "/claim recusa com dlq_reason");
  });

  it(`retries esgotados (${MAX_RETRIES}) no cron → DO marcado; alarm tardio não refaz`, async () => {
    const g = mockGraph({ mediaStatus: 500 });
    const { env, store, get } = mkEnv();
    const key = await enqueue(env);

    for (let i = 0; i < MAX_RETRIES; i++) await __test__.fireDueItems(env);
    assert.equal(store.has(key), false, "sai da fila");
    assert.equal(dlqEntries(store).length, 1);

    const storage = get(key).state.storage.store;
    assert.ok(typeof storage.get("dlq_reason") === "string" && storage.get("dlq_reason") !== "", "dlq_reason gravado");
    assert.equal(storage.has("payload"), false);
    assert.equal(storage.has("claiming"), false);

    const calls = g.mediaPosts;
    await get(key).scheduler.alarm();
    assert.equal(g.mediaPosts, calls, "o alarm tardio não chama a Graph");
    assert.equal(g.publishes, 0);
  });

  it("retry ainda não esgotado: DO sem dlq_reason e com payload (o alarm/cron segue podendo tentar)", async () => {
    mockGraph({ mediaStatus: 500 });
    const { env, store, get } = mkEnv();
    const key = await enqueue(env);
    const r = await __test__.fireDueItems(env);
    assert.equal(r.errors, 1);
    assert.equal(store.has(key), true);
    const storage = get(key).state.storage.store;
    assert.equal(storage.has("dlq_reason"), false);
    assert.equal(storage.has("payload"), true);
    assert.equal(storage.has("claiming"), false, "claim liberado depois das escritas (#11045)");
  });

  it("caminho feliz intacto: fired, sem dlq_reason", async () => {
    const g = mockGraph();
    const { env, store, get } = mkEnv();
    const key = await enqueue(env);
    const r = await __test__.fireDueItems(env);
    assert.equal(r.fired, 1);
    assert.equal(r.dlq, 0);
    assert.equal(store.has(key), false);
    const storage = get(key).state.storage.store;
    assert.equal(storage.get("fired"), true);
    assert.equal(storage.has("dlq_reason"), false);
    assert.equal(g.publishes, 1);
  });

  it("/mark-dlq sem reason → 400, nada gravado", async () => {
    const state = new MockState();
    const s = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("payload", { key: "k" });
    const res = await s.fetch(new Request("https://do/mark-dlq", { method: "POST", body: JSON.stringify({}) }));
    assert.equal(res.status, 400);
    assert.equal(state.storage.store.has("dlq_reason"), false);
    assert.equal(state.storage.store.has("payload"), true);
  });

  it("/mark-dlq com token alheio marca o DO mas não libera o claim de outro", async () => {
    const state = new MockState();
    const s = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("payload", { key: "k" });
    const claim = (await (await s.fetch(new Request("https://do/claim", { method: "POST" }))).json()) as { claim_token: string };
    const res = await s.fetch(new Request("https://do/mark-dlq", {
      method: "POST",
      body: JSON.stringify({ reason: "x", claim_token: "outro" }),
    }));
    assert.equal(((await res.json()) as { released: boolean }).released, false);
    assert.equal(state.storage.store.get("dlq_reason"), "x");
    assert.equal(state.storage.store.has("payload"), false);
    assert.equal(state.storage.store.get("claim_token"), claim.claim_token, "claim do dono intacto");
  });
});
