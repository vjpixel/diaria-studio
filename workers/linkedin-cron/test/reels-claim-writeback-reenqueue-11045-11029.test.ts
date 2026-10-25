/**
 * #11045 — no caminho de falha do cron (`fireDueItems`), o claim era liberado
 * ANTES do write-back do container no DO e do re-put da entry no KV. Um enqueue
 * com conteúdo mudado podia rodar inteiro nessa janela e o write-back devolvia
 * container e entry ANTIGOS por cima do conteúdo novo. Agora o claim só é
 * liberado depois dos dois write-backs (um enqueue concorrente leva 409
 * `fire_in_progress` enquanto o claim está segurado).
 *
 * #11029 — re-enqueue com conteúdo mudado ANTES do 1º disparo (sem container)
 * com o `/arm` falhando deixava o payload antigo armado no DO. Agora o enqueue
 * chama `/cancel` (payload + container + alarm) antes do KV put.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { type Env, __test__ } from "../src/index.ts";
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
const reels = (over: Record<string, unknown> = {}) => ({
  text: "Legenda velha",
  scheduled_at: DUE,
  destaque: "shorts",
  channel: "instagram",
  media_type: "REELS",
  video_url: "https://eia.diar.ia.br/video/261022-short.mp4",
  ig_account: "vjpixel",
  idempotency_key: "shorts-instagram-261022-vjpixel",
  ...over,
});

function mkEnv(onCall?: (path: string) => Promise<void>) {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const failing = new Map<string, "status" | "throw">();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { calls.push(`kv.put:${k}`); store.set(k, v); },
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
    INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig-diaria",
    INSTAGRAM_ACCESS_TOKEN: "token-diaria",
    INSTAGRAM_VJPIXEL_ACCOUNT_ID: "ig-vjpixel",
    INSTAGRAM_VJPIXEL_ACCESS_TOKEN: "token-vjpixel",
    LINKEDIN_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname;
          calls.push(path);
          const mode = failing.get(path);
          if (mode === "throw") throw new Error(`DO ${path} indisponível (injetado)`);
          if (mode === "status") return new Response("boom", { status: 500 });
          if (onCall) await onCall(path);
          return get(id.name).scheduler.fetch(new Request(url, init));
        },
      }),
    },
  } as unknown as Env;
  return { env, store, calls, get, failing };
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

function mockGraph(status = "IN_PROGRESS") {
  const g = { created: [] as string[], published: [] as string[] };
  globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.url;
    if (/\/media\?fields=/.test(u)) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (u.endsWith("/media_publish")) {
      g.published.push(new URLSearchParams(String(init?.body ?? "")).get("creation_id") ?? "?");
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    }
    if (u.includes("status_code")) return new Response(JSON.stringify({ status_code: status }), { status: 200 });
    if (/\/media(\?|$)/.test(u)) {
      g.created.push(decodeURIComponent(String(init?.body ?? "").replace(/\+/g, " ")));
      return new Response(JSON.stringify({ id: `container-${g.created.length}` }), { status: 200 });
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

describe("#11045 cron com disparo falho: release-claim só depois do write-back", () => {
  it("ordem: /reels-container e kv.put da entry antes do /release-claim", async () => {
    mockGraph();
    const { env, calls } = mkEnv();
    const first = await enqueue(env, reels());
    const { key } = (await first.json()) as { key: string };
    calls.length = 0;
    await __test__.fireDueItems(env);
    const container = calls.indexOf("/reels-container");
    const put = calls.indexOf(`kv.put:${key}`);
    const release = calls.lastIndexOf("/release-claim");
    assert.ok(container >= 0 && put >= 0 && release >= 0, `chamadas: ${calls.join(", ")}`);
    assert.ok(container < release, "container devolvido ao DO antes de liberar o claim");
    assert.ok(put < release, "entry regravada no KV antes de liberar o claim");
  });

  it("enqueue com conteúdo mudado durante o write-back leva 409 e nada é misturado", async () => {
    mockGraph();
    let injected: Response | null = null;
    let armed = false;
    // eslint-disable-next-line prefer-const
    let ctx: ReturnType<typeof mkEnv>;
    ctx = mkEnv(async (path) => {
      if (armed && path === "/reels-container" && injected === null) {
        injected = await enqueue(ctx.env, reels({ text: "Legenda nova" }));
      }
    });
    const first = await enqueue(ctx.env, reels());
    const { key } = (await first.json()) as { key: string };
    armed = true;
    await __test__.fireDueItems(ctx.env);
    assert.ok(injected, "enqueue concorrente rodou");
    assert.equal((injected as Response).status, 409);
    assert.equal(((await (injected as Response).json()) as { error?: string }).error, "fire_in_progress");
    assert.equal(JSON.parse(ctx.store.get(key)!).text, "Legenda velha", "o enqueue foi recusado: a entry do KV é a do cron");
    // Claim liberado ao final: um enqueue novo agora passa e descarta o container antigo.
    const after = await enqueue(ctx.env, reels({ text: "Legenda nova" }));
    assert.equal(after.status, 202);
    assert.equal(JSON.parse(ctx.store.get(key)!).text, "Legenda nova");
    assert.equal(ctx.get(key).state.storage.store.has("reels_container"), false);
  });
});

describe("#11029 re-enqueue com conteúdo mudado antes do 1º disparo e /arm falhando", () => {
  for (const mode of ["status", "throw"] as const) {
    it(`/arm falha (${mode}) → o alarm não publica o payload antigo; o cron publica o conteúdo novo do KV`, async () => {
      const g = mockGraph("FINISHED");
      const ctx = mkEnv();
      const first = await enqueue(ctx.env, reels());
      assert.equal(first.status, 202);
      const { key } = (await first.json()) as { key: string };
      const { scheduler, state } = ctx.get(key);
      assert.ok(state.storage.store.has("payload"), "pré-condição: DO armado com o payload antigo");
      assert.equal(state.storage.store.has("reels_container"), false, "pré-condição: ainda sem container");

      ctx.failing.set("/arm", mode);
      const again = await enqueue(ctx.env, reels({ text: "Legenda nova" }));
      assert.equal(again.status, 202);
      assert.equal(((await again.json()) as { alarm_armed?: boolean }).alarm_armed, false);
      assert.equal(state.storage.store.has("payload"), false, "payload antigo descartado do DO");

      await scheduler.alarm();
      assert.equal(g.created.length, 0, "o alarm não tem o que publicar");

      await __test__.fireDueItems(ctx.env);
      assert.equal(ctx.store.has(key), false, "publicado → sai da fila");
      assert.equal(g.created.length, 1);
      assert.match(g.created[0], /Legenda nova/);
      assert.ok(!g.created.some((b) => /Legenda velha/.test(b)), "a legenda velha nunca é publicada");
    });
  }
});
