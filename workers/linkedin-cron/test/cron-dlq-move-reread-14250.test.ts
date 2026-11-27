/**
 * #14250 — o cron lia o `dlq_reason` do DO (no `/status`, ou gravado por ele
 * via `/mark-dlq`) e só depois movia a entry do KV pra DLQ, sem reler. Nesse
 * intervalo o re-enqueue de recuperação (#14241: `/cancel` que limpa o
 * `dlq_reason`, KV put da entry nova, `/arm`) podia rodar inteiro e responder
 * 202; o `KV.delete` do cron apagava a entry nova e gravava uma DLQ com o
 * motivo velho. DO armado sem entry: se o alarm falhasse, ninguém repetia.
 *
 * Fix: `dlqMoveStale` relê o `dlq_reason` no DO e o valor da chave no KV logo
 * antes do move; divergiu → não move. Os testes injetam o re-enqueue
 * exatamente na janela (logo depois da leitura que o cron usa pra decidir).
 * Graph da Meta mockada; nenhuma chamada real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { type Env, type QueueEntry, __test__ } from "../src/index.ts";
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
const IDEM = "instagram-daily:261128:d1";

/**
 * `hook(path, res)` roda depois de cada fetch ao DO e antes de a resposta
 * voltar a quem chamou: é ali que o teste injeta o re-enqueue concorrente.
 */
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
  const ctl: { hook: ((path: string, body: string) => Promise<void>) | null } = { hook: null };
  const env = {
    LINKEDIN_QUEUE: kv as unknown as KVNamespace,
    DIARIA_TOKEN: "secret-token",
    MAKE_WEBHOOK_URL: "https://make.test/diaria",
    INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig-user",
    INSTAGRAM_ACCESS_TOKEN: "ig-token",
    LINKEDIN_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init?: RequestInit) => {
          const res = await get(id.name).scheduler.fetch(new Request(url, init));
          const hook = ctl.hook;
          if (hook) {
            const body = await res.clone().text();
            await hook(new URL(url).pathname, body);
          }
          return res;
        },
      }),
    },
  } as unknown as Env;
  return { env, store, get, ctl };
}

async function enqueue(env: Env): Promise<{ key: string; body: Record<string, unknown> }> {
  const res = await workerDefault.fetch(
    new Request("https://w.test/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
      body: JSON.stringify({
        text: "Legenda do destaque",
        image_urls: CAROUSEL,
        scheduled_at: DUE,
        destaque: "d1",
        channel: "instagram",
        idempotency_key: IDEM,
      }),
    }),
    env,
  ) as Response;
  assert.equal(res.status, 202, await res.clone().text());
  const body = (await res.json()) as Record<string, unknown> & { key: string };
  return { key: body.key, body };
}

/** Graph do Instagram: `failChild` faz o 2º filho do carrossel falhar (dlq). */
function mockGraph() {
  const g = { mediaPosts: 0, children: 0, publishes: 0, failChild: true };
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
      if (body.includes("is_carousel_item=true")) {
        g.children++;
        if (g.failChild && g.children === 2) {
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

describe("#14250 o cron relê o DO e o KV antes de mover pra DLQ", () => {
  it("dlq do alarm: re-enqueue entre o /status do cron e o move → a entry nova fica no KV e publica", async () => {
    const g = mockGraph();
    const { env, store, get, ctl } = mkEnv();
    const { key } = await enqueue(env);
    await get(key).scheduler.alarm();
    assert.ok(get(key).state.storage.store.has("dlq_reason"), "pré-condição: alarm gravou dlq_reason");
    assert.equal(store.has(key), true, "pré-condição: entry ainda no KV");

    // Na 1ª leitura de /status do cron (com dlq_reason), o editor re-roda o enqueue.
    let injected = 0;
    ctl.hook = async (path, body) => {
      if (injected > 0 || path !== "/status") return;
      if (!(JSON.parse(body) as { dlq_reason?: unknown }).dlq_reason) return;
      injected++;
      ctl.hook = null;
      g.failChild = false;
      const again = await enqueue(env);
      assert.equal(again.body.alarm_armed, true, "o enqueue respondeu 202 armado");
    };

    const r1 = await __test__.fireDueItems(env);
    assert.equal(injected, 1, "o re-enqueue caiu na janela");
    assert.equal(r1.dlq, 0, "não move pra DLQ com o motivo velho");
    assert.equal(store.has(key), true, "a entry nova NÃO foi apagada");
    assert.equal(dlqEntries(store).length, 0, "nenhuma DLQ enganosa");
    assert.equal(get(key).state.storage.store.has("payload"), true, "DO armado com o payload novo");

    const r2 = await __test__.fireDueItems(env);
    assert.equal(r2.fired, 1);
    assert.equal(g.publishes, 1, "publica uma vez");
    assert.equal(store.has(key), false);
  });

  it("dlq do cron: re-enqueue logo depois do /mark-dlq → a entry nova fica no KV e publica", async () => {
    const g = mockGraph();
    const { env, store, get, ctl } = mkEnv();
    const { key } = await enqueue(env);

    let injected = 0;
    ctl.hook = async (path) => {
      if (injected > 0 || path !== "/mark-dlq") return;
      injected++;
      ctl.hook = null;
      g.failChild = false;
      const again = await enqueue(env);
      assert.equal(again.body.alarm_armed, true);
    };

    const r1 = await __test__.fireDueItems(env);
    assert.equal(injected, 1, "o re-enqueue caiu na janela");
    assert.equal(r1.dlq, 0);
    assert.equal(store.has(key), true, "a entry nova NÃO foi apagada");
    assert.equal(dlqEntries(store).length, 0);
    assert.equal(get(key).state.storage.store.has("dlq_reason"), false, "o re-enqueue limpou o dlq_reason");

    const r2 = await __test__.fireDueItems(env);
    assert.equal(r2.fired, 1);
    assert.equal(g.publishes, 1, "publica uma vez");
  });

  it("sem re-enqueue concorrente, dlq do alarm segue movido pra DLQ (#14218)", async () => {
    mockGraph();
    const { env, store, get } = mkEnv();
    const { key } = await enqueue(env);
    await get(key).scheduler.alarm();
    const r = await __test__.fireDueItems(env);
    assert.equal(r.dlq, 1);
    assert.equal(store.has(key), false);
    assert.equal(dlqEntries(store).length, 1);
  });

  it("sem re-enqueue concorrente, dlq do cron segue movido pra DLQ (#14230)", async () => {
    mockGraph();
    const { env, store, get } = mkEnv();
    const { key } = await enqueue(env);
    const r = await __test__.fireDueItems(env);
    assert.equal(r.dlq, 1);
    assert.equal(store.has(key), false);
    assert.equal(dlqEntries(store).length, 1);
    assert.ok(get(key).state.storage.store.has("dlq_reason"));
  });

  it("entry do KV mudou sem o DO perceber (só a parte do KV) → não move", async () => {
    mockGraph();
    const { env, store, get, ctl } = mkEnv();
    const { key } = await enqueue(env);
    await get(key).scheduler.alarm();

    const changed = JSON.stringify({ ...(JSON.parse(store.get(key)!) as QueueEntry), text: "outra legenda" });
    let statusReads = 0;
    ctl.hook = async (path) => {
      if (path !== "/status") return;
      statusReads++;
      if (statusReads === 1) store.set(key, changed);
    };
    const r = await __test__.fireDueItems(env);
    assert.equal(r.dlq, 0);
    assert.equal(store.get(key), changed, "a entry gravada depois da leitura do cron fica");
    assert.equal(dlqEntries(store).length, 0);
  });
});
