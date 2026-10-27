/**
 * #11238 — dois achados do review da PR #11233 (#11215):
 *
 * 1. O 409 do `/cancel {if_not_claiming}` devolvia só `{fired:true}` também
 *    quando o DO terminou num envio ambíguo (`send_unknown`, #11106), e o
 *    enqueue reportava `already_fired`. Script ou editor tomavam isso como
 *    prova de que o post saiu e não republicavam um post que pode ter se
 *    perdido. Agora o body leva `send_unknown` e o cliente tem motivo próprio.
 * 2. `/arm`, `/claim`, `tryClaim()` e `/cancel` checavam fired/ambíguo cada
 *    um do seu jeito (só o `/cancel` olhava `send_unknown`). Agora todos usam
 *    `isFiredOrAmbiguous()` — `send_unknown` sem `fired` não re-arma nem
 *    entrega claim.
 *
 * Fetch da Meta mockado; nenhuma chamada real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { doConflictReason, doFireConflict, type Env } from "../src/index.ts";
import { LinkedInScheduler, firedOrAmbiguous, isFiredOrAmbiguous } from "../src/durable-object.ts";

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

const newDo = () => {
  const state = new MockState();
  return { state, s: new LinkedInScheduler(state as unknown as DurableObjectState) };
};

const DUE = new Date(Date.now() - 60_000).toISOString();
const LATER = new Date(Date.now() - 30_000).toISOString();
const post = (over: Record<string, unknown> = {}) => ({
  text: "Texto velho",
  image_url: null,
  scheduled_at: DUE,
  destaque: "d1",
  channel: "threads",
  idempotency_key: "threads-261027-d1-11238",
  ...over,
});

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
    THREADS_USER_ID: "threads-user",
    THREADS_ACCESS_TOKEN: "threads-token",
    LINKEDIN_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init?: RequestInit) => get(id.name).scheduler.fetch(new Request(url, init)),
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

/** Graph do Threads com o publish em 503 — o alarm termina em `send_unknown`. */
function mockThreads503() {
  const g = { publishes: 0 };
  globalThis.fetch = (async (url: string | Request) => {
    const u = typeof url === "string" ? url : url.url;
    if (u.endsWith("/threads_publish")) {
      g.publishes++;
      return new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 });
    }
    if (u.endsWith("/threads")) return new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
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

describe("#11238 isFiredOrAmbiguous — critério único", () => {
  it("vazio → null; fired → fired; send_unknown (com ou sem fired) → send_unknown", async () => {
    const st = new MockStorage();
    assert.equal(await firedOrAmbiguous(st), null);
    assert.equal(await isFiredOrAmbiguous(st), false);

    await st.put("fired", true);
    assert.deepEqual(await firedOrAmbiguous(st), { kind: "fired" });
    assert.equal(await isFiredOrAmbiguous(st), true);

    await st.put("send_unknown", "send_unknown: timeout");
    assert.deepEqual(await firedOrAmbiguous(st), { kind: "send_unknown", reason: "send_unknown: timeout" });

    st.store.delete("fired");
    assert.deepEqual(await firedOrAmbiguous(st), { kind: "send_unknown", reason: "send_unknown: timeout" });
    assert.equal(await isFiredOrAmbiguous(st), true);
  });

  it("fired=false explícito não conta como disparado", async () => {
    const st = new MockStorage();
    await st.put("fired", false);
    assert.equal(await isFiredOrAmbiguous(st), false);
  });
});

describe("#11238 DO: send_unknown sem fired é terminal em /arm, /claim e tryClaim", () => {
  it("/arm → 409 com send_unknown, nada armado", async () => {
    const { state, s } = newDo();
    await state.storage.put("send_unknown", "send_unknown: timeout");
    const res = await s.fetch(new Request("https://do/arm", {
      method: "POST",
      body: JSON.stringify({ scheduledAtMs: Date.now() + 60_000, key: "k", entry: { text: "x" }, webhookUrl: "https://make.test" }),
    }));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { armed?: boolean; fired?: boolean; send_unknown?: string };
    assert.equal(body.armed, false);
    assert.equal(body.fired, true);
    assert.equal(body.send_unknown, "send_unknown: timeout");
    assert.equal(state.storage.store.has("payload"), false);
  });

  it("/arm com fired só → 409 sem send_unknown (motivo already_fired)", async () => {
    const { state, s } = newDo();
    await state.storage.put("fired", true);
    const res = await s.fetch(new Request("https://do/arm", {
      method: "POST",
      body: JSON.stringify({ scheduledAtMs: Date.now() + 60_000, key: "k", entry: { text: "x" }, webhookUrl: "https://make.test" }),
    }));
    assert.equal(res.status, 409);
    assert.equal(await doConflictReason(res), "already_fired");
  });

  it("/claim → claimed:false e tryClaim() → false", async () => {
    const { state, s } = newDo();
    await state.storage.put("send_unknown", "send_unknown: timeout");
    const res = await s.fetch(new Request("https://do/claim", { method: "POST" }));
    assert.equal(((await res.json()) as { claimed: boolean }).claimed, false);
    assert.equal(await s.tryClaim(), false);
    assert.equal(state.storage.store.has("claiming"), false);
  });
});

describe("#11238 DO: 409 do /cancel distingue send_unknown de fired", () => {
  const cancel = () => new Request("https://do/cancel", { method: "POST", body: JSON.stringify({ if_not_claiming: true }) });

  it("send_unknown + fired → body com send_unknown e fired:true (compat)", async () => {
    const { state, s } = newDo();
    await state.storage.put("fired", true);
    await state.storage.put("send_unknown", "send_unknown: timeout");
    const res = await s.fetch(cancel());
    assert.equal(res.status, 409);
    const body = (await res.clone().json()) as { cancelled?: boolean; fired?: boolean; send_unknown?: string };
    assert.equal(body.cancelled, false);
    assert.equal(body.fired, true);
    assert.equal(body.send_unknown, "send_unknown: timeout");
    assert.equal(await doConflictReason(res), "send_unknown");
  });

  it("só fired → sem send_unknown no body → already_fired", async () => {
    const { state, s } = newDo();
    await state.storage.put("fired", true);
    const res = await s.fetch(cancel());
    assert.equal(res.status, 409);
    assert.equal(await doConflictReason(res), "already_fired");
  });
});

describe("#11238 cliente: motivo do conflito", () => {
  const r = (body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 409 });

  it("doConflictReason: send_unknown > fired > claiming; corpo ilegível = fire_in_progress", async () => {
    assert.equal(await doConflictReason(r({ fired: true, send_unknown: "send_unknown: x" })), "send_unknown");
    assert.equal(await doConflictReason(r({ fired: true })), "already_fired");
    assert.equal(await doConflictReason(r({ claiming: true })), "fire_in_progress");
    assert.equal(await doConflictReason(r("não é json")), "fire_in_progress");
    // `/arm` passa `already_fired` como fallback (409 sem `claiming`, #10992).
    assert.equal(await doConflictReason(r({ claiming: false }), "already_fired"), "already_fired");
    assert.equal(await doConflictReason(r({ claiming: true }), "already_fired"), "fire_in_progress");
    assert.equal(await doConflictReason(r({ send_unknown: "send_unknown: x" }), "already_fired"), "send_unknown");
  });

  it("doFireConflict: send_unknown vence fired e inFlight", () => {
    assert.equal(doFireConflict(null), null);
    assert.equal(doFireConflict({ fired: false, inFlight: false, sendUnknown: null }), null);
    assert.equal(doFireConflict({ fired: false, inFlight: true, sendUnknown: null }), "fire_in_progress");
    assert.equal(doFireConflict({ fired: true, inFlight: true, sendUnknown: null }), "already_fired");
    assert.equal(doFireConflict({ fired: true, inFlight: false, sendUnknown: "send_unknown: x" }), "send_unknown");
  });
});

describe("#11238 enqueue: DO em send_unknown nunca vira already_fired", () => {
  async function ambiguousKey() {
    const g = mockThreads503();
    const ctx = mkEnv();
    const { key } = (await (await enqueue(ctx.env, post())).json()) as { key: string };
    await ctx.get(key).scheduler.alarm();
    assert.match(String(ctx.get(key).state.storage.store.get("send_unknown")), /^send_unknown: /);
    return { ...ctx, key, g };
  }

  it("conteúdo mudado → 409 send_unknown, KV intacto", async () => {
    const { env, key, store, g } = await ambiguousKey();
    const res = await enqueue(env, post({ text: "Texto novo" }));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string; key?: string; message?: string };
    assert.equal(body.error, "send_unknown");
    assert.equal(body.key, key);
    assert.match(body.message ?? "", /ambíguo/);
    assert.equal((JSON.parse(store.get(key)!) as { text: string }).text, "Texto velho");
    assert.equal(g.publishes, 1);
  });

  it("horário mudado → 409 send_unknown com a key anterior", async () => {
    const { env, key } = await ambiguousKey();
    const res = await enqueue(env, post({ scheduled_at: LATER }));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string; key?: string };
    assert.equal(body.error, "send_unknown");
    assert.equal(body.key, key);
  });

  it("duplicata exata → 200 duplicate expõe send_unknown além de fired", async () => {
    const { env } = await ambiguousKey();
    const res = await enqueue(env, post());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { duplicate?: boolean; fired?: boolean; send_unknown?: string };
    assert.equal(body.duplicate, true);
    assert.equal(body.fired, true);
    assert.match(body.send_unknown ?? "", /^send_unknown: /);
  });
});
