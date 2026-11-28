/**
 * #14344 — no caminho de retries esgotados do cron, a entry ia pra DLQ e só
 * depois o `/mark-dlq` era chamado, com o retorno ignorado. Se outra volta já
 * tinha publicado (DO `fired`, 409 do #14301), a DLQ mostrava falha de um post
 * que saiu. Agora a marcação vem antes do move e o retorno decide, igual ao
 * outcome `dlq` do `fireQueueEntry`: `fired` → KV limpo, sem DLQ;
 * `send_unknown` → DLQ com o motivo ambíguo; entry trocada por re-enqueue de
 * recuperação (#14241) → não move nem apaga a entry nova.
 * Graph da Meta mockada; nenhuma chamada real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { MAX_RETRIES, type Env, type QueueEntry, __test__ } from "../src/index.ts";
import { LinkedInScheduler, type DoStoredPayload } from "../src/durable-object.ts";

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

async function enqueue(env: Env): Promise<string> {
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
      }),
    }),
    env,
  ) as Response;
  assert.equal(res.status, 202, await res.clone().text());
  return ((await res.json()) as { key: string }).key;
}

/**
 * Graph sempre 500 (falha retriable). Na volta `onRound` (1-based), antes de
 * responder, roda `sideEffect` — o que outra volta fez enquanto o cron
 * esperava a Graph.
 */
function mockGraph500(onRound: number, sideEffect: () => Promise<void>) {
  const g = { round: 0, publishes: 0 };
  globalThis.fetch = (async (url: string | Request) => {
    const u = typeof url === "string" ? url : url.url;
    if (u.endsWith("/media_publish")) {
      g.publishes++;
      return new Response(JSON.stringify({ id: "ig-media" }), { status: 200 });
    }
    if (u.endsWith("/media")) {
      if (g.round === onRound) await sideEffect();
      return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: 500 });
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

/** Roda as voltas do cron até a última (a que esgota os retries). */
async function runRounds(env: Env, g: { round: number }) {
  let last = { fired: 0, errors: 0, dlq: 0 };
  for (let i = 1; i <= MAX_RETRIES; i++) {
    g.round = i;
    last = await __test__.fireDueItems(env);
  }
  return last;
}

describe("#14344 retries esgotados conferem o /mark-dlq antes de mover pra DLQ", () => {
  it("outra volta já publicou (DO fired): KV limpo, nada na DLQ, conta como fired", async () => {
    const { env, store, get } = mkEnv();
    const key = await enqueue(env);
    const doStore = get(key).state.storage.store;
    const g = mockGraph500(MAX_RETRIES, async () => {
      // O claim do cron venceu e o alarm retomou e publicou.
      doStore.set("fired", true);
      doStore.delete("payload");
      doStore.delete("claiming");
      doStore.delete("claimed_at");
      doStore.delete("claim_token");
    });

    const r = await runRounds(env, g);
    assert.equal(r.dlq, 0, "antes do fix: 1 (a DLQ mostrava falha de um post publicado)");
    assert.equal(r.fired, 1);
    assert.equal(store.has(key), false, "KV limpo");
    assert.equal(dlqEntries(store).length, 0, "post publicado não vai pra DLQ");
    assert.equal(doStore.has("dlq_reason"), false, "nunca fired + dlq_reason juntos");
  });

  it("outra volta terminou ambígua (send_unknown): DLQ com o motivo ambíguo, não com a falha do cron", async () => {
    const { env, store, get } = mkEnv();
    const key = await enqueue(env);
    const doStore = get(key).state.storage.store;
    const g = mockGraph500(MAX_RETRIES, async () => {
      doStore.set("send_unknown", "[send_unknown] publish timeout");
      doStore.set("fired", true);
      doStore.delete("payload");
      doStore.delete("claiming");
      doStore.delete("claimed_at");
      doStore.delete("claim_token");
    });

    const r = await runRounds(env, g);
    assert.equal(r.dlq, 1);
    assert.equal(store.has(key), false);
    const dlq = dlqEntries(store);
    assert.equal(dlq.length, 1);
    assert.equal(dlq[0].last_error, "[send_unknown] publish timeout");
  });

  it("re-enqueue de recuperação re-armou o DO com a entry nova: não move nem apaga a entry nova", async () => {
    const { env, store, get } = mkEnv();
    const key = await enqueue(env);
    const doStore = get(key).state.storage.store;
    let fresh: QueueEntry | null = null;
    const g = mockGraph500(MAX_RETRIES, async () => {
      // Fluxo do #14241 com o claim do cron vencido: cancel + KV put + arm.
      doStore.set("claimed_at", 0);
      const armed = doStore.get("payload") as DoStoredPayload;
      fresh = { ...armed.entry, created_at: new Date(Date.now() + 1000).toISOString(), retry_count: 0 };
      const stub = env.LINKEDIN_SCHEDULER.get(env.LINKEDIN_SCHEDULER.idFromName(key));
      const cancel = await stub.fetch("https://do/cancel", { method: "POST", body: JSON.stringify({ if_not_claiming: true }) });
      assert.equal(cancel.status, 200);
      await env.LINKEDIN_QUEUE.put(key, JSON.stringify(fresh));
      const arm = await stub.fetch("https://do/arm", { method: "POST", body: JSON.stringify({ ...armed, entry: fresh, scheduledAtMs: Date.now() }) });
      assert.equal(arm.status, 200);
    });

    const r = await runRounds(env, g);
    assert.equal(r.dlq, 0);
    assert.equal(dlqEntries(store).length, 0);
    assert.equal(store.get(key), JSON.stringify(fresh), "entry nova intacta no KV");
    assert.equal(doStore.has("dlq_reason"), false, "DO da recuperação não envenenado");
    assert.equal(doStore.has("payload"), true);
  });

  it("caso normal intacto: retries esgotados sem concorrência → DLQ com retry_count e last_error, DO marcado", async () => {
    const { env, store, get } = mkEnv();
    const key = await enqueue(env);
    const g = mockGraph500(-1, async () => {});
    const r = await runRounds(env, g);
    assert.equal(r.dlq, 1);
    assert.equal(store.has(key), false);
    const dlq = dlqEntries(store);
    assert.equal(dlq.length, 1);
    assert.equal(dlq[0].retry_count, MAX_RETRIES);
    assert.match(dlq[0].last_error ?? "", /500|temporarily/);
    const doStore = get(key).state.storage.store;
    assert.ok(typeof doStore.get("dlq_reason") === "string");
    assert.equal(doStore.has("payload"), false);
    assert.equal(doStore.has("claiming"), false);
  });
});
