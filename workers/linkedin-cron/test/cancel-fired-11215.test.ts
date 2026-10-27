/**
 * #11215 — o `/cancel {if_not_claiming}` (#11107) só recusava com claim em
 * andamento. Se o DO já tinha disparado (`fired=true`) ou terminado ambíguo
 * (`send_unknown`, #11106) entre o `/status` do enqueue e o cancel, o
 * `deleteAll()` apagava esses marcadores, a reserva (#11133) era gravada e o
 * `/arm` seguinte armava o conteúdo novo: dois posts no mesmo slot.
 *
 * Fetch da Meta mockado; nenhuma chamada real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { type Env, type QueueEntry } from "../src/index.ts";
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
const LATER = new Date(Date.now() - 30_000).toISOString();
const post = (over: Record<string, unknown> = {}) => ({
  text: "Texto velho",
  image_url: null,
  scheduled_at: DUE,
  destaque: "d1",
  channel: "threads",
  idempotency_key: "threads-261027-d1",
  ...over,
});

function mkEnv(onCall?: (path: string, name: string) => Promise<void>) {
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
          if (onCall) await onCall(new URL(url).pathname, id.name);
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

/** Graph do Threads: registra o texto de cada container e cada publish. */
function mockThreads(mode: "ok" | "503" = "ok") {
  const g = { containers: [] as string[], publishes: 0 };
  globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.url;
    if (u.endsWith("/threads_publish")) {
      g.publishes++;
      if (mode === "503") return new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 });
      return new Response(JSON.stringify({ id: `media-${g.publishes}` }), { status: 200 });
    }
    if (u.endsWith("/threads")) {
      g.containers.push(new URLSearchParams(String(init?.body ?? "")).get("text") ?? "?");
      return new Response(JSON.stringify({ id: `container-${g.containers.length}` }), { status: 200 });
    }
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

const cancelIfNotClaiming = (extra: Record<string, unknown> = {}) =>
  new Request("https://do/cancel", { method: "POST", body: JSON.stringify({ if_not_claiming: true, ...extra }) });

describe("#11215 /cancel if_not_claiming não apaga DO que já disparou", () => {
  it("fired=true → 409 {fired:true} e storage intacto (nem reserva gravada)", async () => {
    const state = new MockState();
    const s = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("fired", true);

    const res = await s.fetch(cancelIfNotClaiming({ replacement_token: "tok", replacement_entry: { text: "novo" } }));
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { fired?: boolean }).fired, true);
    assert.equal(state.storage.store.get("fired"), true);
    assert.equal(state.storage.store.has("replacement_token"), false);
    assert.equal(state.storage.store.has("claiming"), false);
  });

  it("send_unknown sem fired → 409 e o marcador sobrevive", async () => {
    const state = new MockState();
    const s = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("send_unknown", "send_unknown: timeout");

    const res = await s.fetch(cancelIfNotClaiming());
    assert.equal(res.status, 409);
    assert.equal(state.storage.store.get("send_unknown"), "send_unknown: timeout");
  });

  it("sem o body (cancel incondicional) segue apagando tudo", async () => {
    const state = new MockState();
    const s = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("fired", true);
    const res = await s.fetch(new Request("https://do/cancel", { method: "POST" }));
    assert.equal(res.status, 200);
    assert.equal(state.storage.store.size, 0);
  });
});

describe("#11215 enqueue: o fire completo entre /status e /cancel não duplica o post", () => {
  for (const mode of ["ok", "503"] as const) {
    // #11238 — envio ambíguo (503) tem motivo próprio: `already_fired` era prova falsa de publicação.
    const expected = mode === "503" ? "send_unknown" : "already_fired";
    it(`conteúdo mudado, alarm dispara (${mode}) no meio → 409 ${expected}, nada novo armado`, async () => {
      const g = mockThreads(mode);
      let race = false;
      // eslint-disable-next-line prefer-const
      let ctx: ReturnType<typeof mkEnv>;
      let key = "";
      ctx = mkEnv(async (path, name) => {
        if (race && path === "/cancel" && name === key) {
          race = false;
          await ctx.get(key).scheduler.alarm();
        }
      });
      ({ key } = (await (await enqueue(ctx.env, post())).json()) as { key: string });
      race = true;
      const res = await enqueue(ctx.env, post({ text: "Texto novo" }));
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { error?: string }).error, expected);

      const storage = ctx.get(key).state.storage.store;
      assert.equal(storage.get("fired"), true, "fired sobrevive ao cancel");
      if (mode === "503") assert.match(String(storage.get("send_unknown")), /^send_unknown: /);
      assert.equal(storage.has("replacement_token"), false, "reserva não gravada");
      assert.equal((JSON.parse(ctx.store.get(key)!) as QueueEntry).text, "Texto velho", "KV não recebeu o conteúdo novo");

      await ctx.get(key).scheduler.alarm();
      assert.equal(g.publishes, 1, "só o post original saiu");
      assert.deepEqual(g.containers, ["Texto velho"]);
    });
  }

  it("horário mudado, a key anterior dispara entre /status e /cancel → 409 already_fired", async () => {
    const g = mockThreads();
    let race = false;
    // eslint-disable-next-line prefer-const
    let ctx: ReturnType<typeof mkEnv>;
    let key = "";
    ctx = mkEnv(async (path, name) => {
      if (race && path === "/cancel" && name === key) {
        race = false;
        await ctx.get(key).scheduler.alarm();
      }
    });
    ({ key } = (await (await enqueue(ctx.env, post())).json()) as { key: string });
    race = true;
    const res = await enqueue(ctx.env, post({ scheduled_at: LATER }));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string; key?: string };
    assert.equal(body.error, "already_fired");
    assert.equal(body.key, key);
    assert.equal(ctx.get(key).state.storage.store.get("fired"), true);
    assert.equal(g.publishes, 1);
  });
});
