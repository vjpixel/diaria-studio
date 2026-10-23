/**
 * #11026 — o #11024 descarta o container de Reels guardado (#10922) dentro do
 * `/arm` do DO. Mas o `handleEnqueue` grava a entry nova no KV ANTES do `/arm`
 * e trata a falha dele como não fatal ("cron fallback active"): com o `/arm`
 * falhando, o container antigo ficava no DO e o cron o recebia do `/claim`,
 * publicando o Reels com o vídeo/legenda velhos.
 *
 * O fix limpa o container no DO (`POST /reels-container {reels_container:null}`)
 * antes do KV put, no caminho `replaced` com conteúdo mudado; se a limpeza
 * falha, o enqueue responde 503 sem gravar nada.
 *
 * Tudo com mocks (KV em memória, DO real sobre storage em memória, Graph API
 * falsa, falhas injetadas no stub do DO) — nada ao vivo.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { type Env, __test__ } from "../src/index.ts";
import { LinkedInScheduler } from "../src/durable-object.ts";

class MockStorage {
  store = new Map<string, unknown>();
  async get<T>(k: string): Promise<T | undefined> {
    return this.store.get(k) as T | undefined;
  }
  async put(k: string, v: unknown): Promise<void> {
    this.store.set(k, v);
  }
  async delete(k: string): Promise<void> {
    this.store.delete(k);
  }
  async deleteAll(): Promise<void> {
    this.store.clear();
  }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}
class MockState {
  storage = new MockStorage();
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

class MockKV {
  store = new Map<string, string>();
  puts: string[] = [];
  async get(k: string) {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.puts.push(k);
    this.store.set(k, v);
  }
  async delete(k: string) {
    this.store.delete(k);
  }
  async list(o: { prefix?: string }) {
    const names = [...this.store.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort();
    return { keys: names.map((name) => ({ name })), list_complete: true };
  }
}

/** Como uma chamada ao DO falha: resposta 500 ou exceção (DO indisponível). */
type FailMode = "status" | "throw";

function mkEnv() {
  const kv = new MockKV();
  const schedulers = new Map<string, { scheduler: LinkedInScheduler; state: MockState }>();
  /** Pathnames do DO (ex.: "/arm") que falham, e como. */
  const failing = new Map<string, FailMode>();
  const calls: string[] = [];
  const kvPut = kv.put.bind(kv);
  kv.put = async (k: string, v: string) => {
    calls.push(`kv.put:${k}`);
    return kvPut(k, v);
  };
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
          return get(id.name).scheduler.fetch(new Request(url, init));
        },
      }),
    },
  } as unknown as Env;
  return { env, kv, get, failing, calls };
}

function enqueue(env: Env, payload: Record<string, unknown>): Promise<Response> {
  const req = new Request("https://w.test/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
    body: JSON.stringify(payload),
  });
  return workerDefault.fetch(req, env) as Promise<Response>;
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
  collaborators: ["diar.ia.br"],
  idempotency_key: "shorts-instagram-261022-vjpixel",
  ...over,
});

interface Graph {
  status: string;
  containersCreated: number;
  createBodies: string[];
  polledIds: string[];
  publishedContainers: string[];
}

function mockGraph(status: string): Graph {
  const g: Graph = { status, containersCreated: 0, createBodies: [], polledIds: [], publishedContainers: [] };
  globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.url;
    if (/\/media\?fields=/.test(u)) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (u.endsWith("/media_publish")) {
      g.publishedContainers.push(new URLSearchParams(String(init?.body ?? "")).get("creation_id") ?? "?");
      return new Response(JSON.stringify({ id: "reel-media" }), { status: 200 });
    }
    if (u.includes("status_code")) {
      g.polledIds.push(u.split("/").pop()!.split("?")[0]);
      return new Response(JSON.stringify({ status_code: g.status }), { status: 200 });
    }
    if (/\/media(\?|$)/.test(u)) {
      g.containersCreated++;
      g.createBodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ id: `container-${g.containersCreated}` }), { status: 200 });
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

/** 1º enqueue + alarm cujo poll estoura: o DO fica com `container-1` guardado. */
async function failWithStoredContainer() {
  const ctx = mkEnv();
  const g = mockGraph("IN_PROGRESS");
  const first = await enqueue(ctx.env, reels());
  assert.equal(first.status, 202);
  const { key } = (await first.json()) as { key: string };
  const { scheduler, state } = ctx.get(key);
  await scheduler.alarm();
  assert.equal((state.storage.store.get("reels_container") as { id: string }).id, "container-1", "pré-condição: container guardado");
  return { ...ctx, g, key, scheduler, state };
}

describe("#11026 legenda nova com o /arm falhando: o cron não retoma o container antigo", () => {
  for (const mode of ["status", "throw"] as const) {
    it(`/arm falha (${mode}) → enqueue 202 alarm_armed:false; fireDueItems cria container novo e publica a legenda nova`, async () => {
      const { env, kv, g, key, state, failing } = await failWithStoredContainer();
      failing.set("/arm", mode);

      const again = await enqueue(env, reels({ text: "Legenda nova" }));
      assert.equal(again.status, 202);
      const body = (await again.json()) as { replaced?: boolean; alarm_armed?: boolean };
      assert.equal(body.replaced, true);
      assert.equal(body.alarm_armed, false, "pré-condição: o /arm falhou");
      assert.equal(state.storage.store.has("reels_container"), false, "container antigo descartado antes do KV put");

      const pollsBefore = g.polledIds.length;
      g.status = "FINISHED";
      await __test__.fireDueItems(env);
      assert.equal(kv.store.has(key), false, "publicado → sai da fila");
      assert.ok(!g.polledIds.slice(pollsBefore).includes("container-1"), "nunca retoma o container antigo");
      assert.ok(!g.publishedContainers.includes("container-1"), "nunca publica o container antigo");
      assert.deepEqual(g.publishedContainers, ["container-2"]);
      assert.match(decodeURIComponent(g.createBodies[1].replace(/\+/g, " ")), /Legenda nova/);
    });
  }

  it("a limpeza acontece ANTES do KV put da entry nova (fecha a janela put→/arm)", async () => {
    const { env, calls, key } = await failWithStoredContainer();
    calls.length = 0;
    const again = await enqueue(env, reels({ text: "Legenda nova" }));
    assert.equal(again.status, 202);
    const clear = calls.indexOf("/reels-container");
    const put = calls.indexOf(`kv.put:${key}`);
    assert.ok(clear >= 0 && put >= 0, `chamadas: ${calls.join(", ")}`);
    assert.ok(clear < put, "limpeza antes do put");
    assert.ok(put < calls.indexOf("/arm"), "put antes do /arm (ordem do enqueue preservada)");
  });
});

describe("#11026 a limpeza falha → 503 sem gravar a entry nova", () => {
  for (const mode of ["status", "throw"] as const) {
    it(`/reels-container falha (${mode}) → 503 reels_container_clear_failed; KV mantém a entry anterior e o /arm não roda`, async () => {
      const { env, kv, key, state, failing, calls } = await failWithStoredContainer();
      const before = kv.store.get(key);
      failing.set("/reels-container", mode);
      calls.length = 0;
      kv.puts.length = 0;

      const again = await enqueue(env, reels({ text: "Legenda nova" }));
      assert.equal(again.status, 503);
      const body = (await again.json()) as { error?: string; key?: string };
      assert.equal(body.error, "reels_container_clear_failed");
      assert.equal(body.key, key);
      assert.equal(kv.puts.includes(key), false, "a entry nova não foi gravada");
      assert.equal(kv.store.get(key), before, "a entry anterior segue intacta");
      assert.ok(!calls.includes("/arm"), "não re-arma o DO");
      assert.equal(JSON.parse(kv.store.get(key)!).text, "Legenda velha");
      assert.ok(state.storage.store.has("payload"));
    });
  }
});

describe("#11026 não toca o container fora do caminho de conteúdo mudado", () => {
  it("re-enqueue idêntico (duplicata) não chama /reels-container e preserva o container (#10922)", async () => {
    const { env, state, calls } = await failWithStoredContainer();
    calls.length = 0;
    const again = await enqueue(env, reels());
    assert.equal(again.status, 200);
    assert.ok(!calls.includes("/reels-container"));
    assert.equal((state.storage.store.get("reels_container") as { id: string }).id, "container-1");
  });

  it("1º enqueue (sem entry anterior) não chama /reels-container", async () => {
    const { env, calls } = mkEnv();
    mockGraph("FINISHED");
    const res = await enqueue(env, reels());
    assert.equal(res.status, 202);
    assert.ok(!calls.includes("/reels-container"));
  });
});
