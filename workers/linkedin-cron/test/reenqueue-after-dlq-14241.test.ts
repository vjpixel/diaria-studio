/**
 * #14241 — o `dlq_reason` gravado no DO (#14218 pelo alarm, #14230 pelo cron)
 * só saía com o `/cancel`. A chave idempotente é fixa por edição e destaque
 * (#14010, `instagram-daily:AAMMDD:d1`), então re-rodar a Etapa 5 depois de
 * uma DLQ cai no MESMO DO: o enqueue respondia 202 `alarm_armed`, o
 * `tryClaim` recusava todo claim e o cron mandava a entry nova pra DLQ com o
 * motivo antigo, sem disparar. O post sumia sem aviso.
 *
 * Fix: o enqueue idempotente trata `dlq_reason` como pedido explícito de
 * recuperação e limpa o DO (`/cancel` condicional) antes do KV put e do
 * `/arm`. O `/arm` em si segue sem apagar `dlq_reason`: um re-arm do payload
 * antigo (`/rearm`) ou um alarm tardio continuam sem refazer (#14218/#14230).
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
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const CAROUSEL = ["https://x.test/1.jpg", "https://x.test/2.jpg", "https://x.test/3.jpg"];
const IDEM = "instagram-daily:261127:d1";

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

async function enqueueRaw(env: Env, over: Record<string, unknown> = {}): Promise<Response> {
  return await workerDefault.fetch(
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
        ...over,
      }),
    }),
    env,
  ) as Response;
}

async function enqueue(env: Env, over: Record<string, unknown> = {}): Promise<{ key: string; body: Record<string, unknown> }> {
  const res = await enqueueRaw(env, over);
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

describe("#14241 re-enqueue com a mesma chave idempotente depois de uma DLQ", () => {
  it("dlq decidido pelo cron → re-enqueue (mesma chave e horário) publica UMA vez, sem DLQ nova", async () => {
    const g = mockGraph();
    const { env, store, get } = mkEnv();
    const { key } = await enqueue(env);

    const r1 = await __test__.fireDueItems(env);
    assert.equal(r1.dlq, 1);
    assert.equal(store.has(key), false, "1ª tentativa saiu da fila pra DLQ");
    assert.ok(get(key).state.storage.store.has("dlq_reason"), "pré-condição: DO com dlq_reason");

    g.failChild = false;
    const again = await enqueue(env);
    assert.equal(again.key, key, "mesma chave idempotente e horário caem na mesma key/DO");
    assert.equal(again.body.alarm_armed, true);
    const storage = get(key).state.storage.store;
    assert.equal(storage.has("dlq_reason"), false, "o re-enqueue limpou o dlq_reason antigo");
    assert.equal(storage.has("payload"), true, "payload novo armado");
    assert.equal(storage.has("claiming"), false, "reserva do replacement liberada");

    const r2 = await __test__.fireDueItems(env);
    assert.equal(r2.dlq, 0, "não vai pra DLQ com o motivo antigo");
    assert.equal(r2.fired, 1);
    assert.equal(g.publishes, 1, "publica uma vez");
    assert.equal(dlqEntries(store).length, 1, "só a DLQ da 1ª tentativa");

    await get(key).scheduler.alarm();
    assert.equal(g.publishes, 1, "o alarm depois do cron não publica de novo");
  });

  it("dlq decidido pelo alarm, cron já moveu → re-enqueue; o alarm publica UMA vez e o cron não refaz", async () => {
    const g = mockGraph();
    const { env, store, get } = mkEnv();
    const { key } = await enqueue(env);

    await get(key).scheduler.alarm();
    assert.ok(get(key).state.storage.store.has("dlq_reason"), "pré-condição: alarm gravou dlq_reason");
    const r1 = await __test__.fireDueItems(env);
    assert.equal(r1.dlq, 1);
    assert.equal(store.has(key), false);

    g.failChild = false;
    await enqueue(env);
    await get(key).scheduler.alarm();
    assert.equal(g.publishes, 1, "o alarm publica o re-enqueue");
    const r2 = await __test__.fireDueItems(env);
    assert.equal(r2.dlq, 0);
    assert.equal(g.publishes, 1, "uma vez só: o cron vê fired no DO e só limpa o KV");
    assert.equal(store.has(key), false);
  });

  it("dlq do alarm com a entry ainda no KV: re-enqueue igual não é `duplicate`, re-arma e publica uma vez", async () => {
    const g = mockGraph();
    const { env, store, get } = mkEnv();
    const { key } = await enqueue(env);
    await get(key).scheduler.alarm();
    assert.equal(store.has(key), true, "pré-condição: o cron ainda não moveu a entry");

    g.failChild = false;
    const again = await enqueue(env);
    assert.equal(again.body.duplicate, undefined);
    assert.equal(get(key).state.storage.store.has("dlq_reason"), false);

    const r = await __test__.fireDueItems(env);
    assert.equal(r.dlq, 0);
    assert.equal(r.fired, 1);
    assert.equal(g.publishes, 1);
    assert.equal(dlqEntries(store).length, 0);
  });

  it("#14218/#14230 seguem protegidos: re-arm do payload antigo e alarm tardio não refazem", async () => {
    const g = mockGraph();
    const { env, store, get } = mkEnv();
    const { key } = await enqueue(env, { scheduled_at: FUTURE });

    // Alarm (adiantado no teste) termina em dlq; a entry segue no KV até o cron.
    await get(key).scheduler.alarm();
    const storage = get(key).state.storage.store;
    const reason = storage.get("dlq_reason");
    assert.ok(typeof reason === "string" && reason !== "");
    g.failChild = false;

    // `/rearm` re-arma a partir do KV (o mesmo payload antigo): não limpa o dlq.
    const rearm = await workerDefault.fetch(
      new Request("https://w.test/rearm", { method: "POST", headers: { "X-Diaria-Token": "secret-token" } }),
      env,
    ) as Response;
    assert.equal(rearm.status, 200, await rearm.clone().text());
    assert.equal(storage.get("dlq_reason"), reason, "/rearm não apaga o dlq_reason");

    // `/arm` direto com o payload antigo idem.
    const entry = JSON.parse(store.get(key)!) as QueueEntry;
    await get(key).scheduler.fetch(new Request("https://do/arm", {
      method: "POST",
      body: JSON.stringify({ key, entry, webhookUrl: "https://make.test/diaria", scheduledAtMs: Date.now() }),
    }));
    assert.equal(storage.get("dlq_reason"), reason, "/arm não apaga o dlq_reason");

    const mediaBefore = g.mediaPosts;
    await get(key).scheduler.alarm();
    assert.equal(g.mediaPosts, mediaBefore, "alarm tardio não recria o carrossel antigo");
    assert.equal(g.publishes, 0, "nada publicado");
  });
});
