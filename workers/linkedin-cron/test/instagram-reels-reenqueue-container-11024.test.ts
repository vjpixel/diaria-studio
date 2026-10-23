/**
 * #11024 — reenfileirar um Reels com a mesma `idempotency_key` e conteúdo
 * DIFERENTE (#10917, `replaced: true`) não pode retomar o container de Reels
 * que o DO guardou de uma tentativa anterior (#10922): sairia a legenda/vídeo
 * velhos, no alarm e no cron (que recebe o container do `/claim`).
 *
 * O retry do MESMO conteúdo segue retomando o container (#10922).
 *
 * Tudo com mocks (KV em memória, DO real sobre storage em memória, Graph API
 * falsa) — nada ao vivo.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { type Env, type QueueEntry, __test__ } from "../src/index.ts";
import { LinkedInScheduler, type DoStoredPayload } from "../src/durable-object.ts";

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
  async get(k: string) {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string) {
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

function mkEnv() {
  const kv = new MockKV();
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
        fetch: (url: string, init?: RequestInit) => get(id.name).scheduler.fetch(new Request(url, init)),
      }),
    },
  } as unknown as Env;
  return { env, kv, get };
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
  /** Corpo (form) de cada criação de container — leva a legenda e o video_url. */
  createBodies: string[];
  /** Ids de container consultados no poll de status. */
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
  // O poll do alarm usa o orçamento de produção (36 × 5 s): zera a espera.
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

describe("#11024 re-enqueue com conteúdo diferente descarta o container guardado", () => {
  it("alarm: legenda nova → cria container NOVO com a legenda nova e nunca consulta o container antigo (cenário da issue)", async () => {
    const { env, g, key, scheduler, state } = await failWithStoredContainer();

    const again = await enqueue(env, reels({ text: "Legenda nova" }));
    assert.equal(again.status, 202);
    assert.equal(((await again.json()) as { replaced?: boolean }).replaced, true);
    assert.equal(state.storage.store.has("reels_container"), false, "o /arm apagou o container da tentativa anterior");

    const pollsBefore = g.polledIds.length;
    g.status = "FINISHED";
    await scheduler.alarm();
    assert.equal(g.containersCreated, 2, "cria um container novo");
    assert.ok(!g.polledIds.slice(pollsBefore).includes("container-1"), "nunca retoma o container antigo");
    assert.deepEqual(g.publishedContainers, ["container-2"]);
    assert.match(decodeURIComponent(g.createBodies[1].replace(/\+/g, " ")), /Legenda nova/);
    assert.equal(state.storage.store.get("fired"), true);
    assert.ok(key);
  });

  it("alarm: video_url novo (mesma legenda) também descarta o container antigo", async () => {
    const { env, g, scheduler, state } = await failWithStoredContainer();
    const again = await enqueue(env, reels({ video_url: "https://eia.diar.ia.br/video/261022-short-v2.mp4" }));
    assert.equal(again.status, 202);
    assert.equal(state.storage.store.has("reels_container"), false);
    g.status = "FINISHED";
    await scheduler.alarm();
    assert.deepEqual(g.publishedContainers, ["container-2"]);
  });

  it("cron: o /claim não devolve o container antigo; fireDueItems cria outro e publica a legenda nova", async () => {
    const { env, kv, g, key } = await failWithStoredContainer();
    const again = await enqueue(env, reels({ text: "Legenda nova" }));
    assert.equal(again.status, 202);

    const pollsBefore = g.polledIds.length;
    g.status = "FINISHED";
    await __test__.fireDueItems(env);
    assert.equal(kv.store.has(key), false, "publicado → sai da fila");
    assert.ok(!g.polledIds.slice(pollsBefore).includes("container-1"), "nunca retoma o container antigo");
    assert.deepEqual(g.publishedContainers, ["container-2"]);
    assert.match(decodeURIComponent(g.createBodies[1].replace(/\+/g, " ")), /Legenda nova/);
  });
});

describe("#11024 o retry do MESMO conteúdo segue retomando o container (#10922)", () => {
  it("re-enqueue idêntico = duplicata (não passa pelo /arm); o alarm seguinte retoma container-1", async () => {
    const { env, g, scheduler, state } = await failWithStoredContainer();

    const again = await enqueue(env, reels());
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { duplicate?: boolean }).duplicate, true);
    assert.equal((state.storage.store.get("reels_container") as { id: string }).id, "container-1");

    g.status = "FINISHED";
    await scheduler.alarm();
    assert.equal(g.containersCreated, 1, "nunca cria um 2º container");
    assert.deepEqual(g.publishedContainers, ["container-1"]);
  });

  it("/arm com o mesmo conteúdo (re-arm do mesmo item, ex.: /rearm) preserva o container", async () => {
    const { state, scheduler } = await failWithStoredContainer();
    const prev = state.storage.store.get("payload") as DoStoredPayload;
    const res = await scheduler.fetch(
      new Request("https://do/arm", {
        method: "POST",
        body: JSON.stringify({ ...prev, entry: { ...prev.entry, retry_count: 3 } as QueueEntry, scheduledAtMs: Date.now() + 60_000 }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal((state.storage.store.get("reels_container") as { id: string }).id, "container-1");
  });

  it("/arm sem payload anterior descarta um container órfão", async () => {
    const state = new MockState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("reels_container", { id: "orphan", created_at: new Date().toISOString() });
    const payload: DoStoredPayload = {
      key: "queue:1:abc",
      entry: { text: "x", image_url: null, scheduled_at: DUE, destaque: "shorts", created_at: DUE, retry_count: 0 },
      webhookUrl: "https://make.test/diaria",
    };
    await scheduler.fetch(new Request("https://do/arm", { method: "POST", body: JSON.stringify({ ...payload, scheduledAtMs: Date.now() }) }));
    assert.equal(state.storage.store.has("reels_container"), false);
  });
});
