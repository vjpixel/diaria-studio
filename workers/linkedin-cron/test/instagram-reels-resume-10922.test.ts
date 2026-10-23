/**
 * instagram-reels-resume-10922.test.ts (#10922)
 *
 * O vertical diário chegou a 275 MB (261022). Se a Meta levasse mais que o teto
 * do poll (190 s) pra processar, cada retry da fila criava um container NOVO e
 * recomeçava o processamento do zero — o Reels terminava na DLQ sem publicar.
 * Agora a falha devolve o container em uso (`reelsContainer`), o caller grava
 * em `entry.reels_container` (cron: KV + DO; alarm: storage do DO) e a volta
 * seguinte retoma o MESMO container.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { type Env, type QueueEntry, __test__ } from "../src/index.ts";
import {
  fireQueueEntry,
  pickReelsContainer,
  resumableReelsContainer,
  REELS_CONTAINER_RESUME_MAX_AGE_MS,
  type FireConfig,
} from "../src/dispatch.ts";
import { LinkedInScheduler, type DoStoredPayload } from "../src/durable-object.ts";

const CREDS = { igUserId: "ig-diaria", accessToken: "token-diaria", apiVersion: "v25.0" };
const config: FireConfig = { webhookUrl: "https://make.test/diaria", instagram: CREDS, reelsPollIntervalMs: 0, reelsPollDeadlineMs: 50 };

function reelsEntry(over: Partial<QueueEntry> = {}): QueueEntry {
  const past = new Date(Date.now() - 60_000).toISOString();
  return {
    text: "O vídeo de hoje",
    image_url: null,
    scheduled_at: past,
    destaque: "shorts",
    created_at: past,
    retry_count: 0,
    channel: "instagram",
    media_type: "REELS",
    video_url: "https://eia.diar.ia.br/video/261022-short.mp4",
    ...over,
  };
}

interface Graph {
  /** Polls de status até o container `container-1` ficar FINISHED (processamento lento). */
  pollsUntilFinished: number;
  /** Status forçado do container (sobrepõe o processamento). */
  forcedStatus?: string;
  /** #10954 — HTTP de erro forçado na consulta de status de um container (id → status). */
  statusHttpError?: Record<string, number>;
  publishFails: boolean;
  containersCreated: number;
  polls: number;
  publishedContainers: string[];
}

function mockGraph(over: Partial<Graph> = {}): Graph {
  const g: Graph = { pollsUntilFinished: 1, publishFails: false, containersCreated: 0, polls: 0, publishedContainers: [], ...over };
  globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.url;
    if (/\/media\?fields=/.test(u)) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (u.endsWith("/media_publish")) {
      if (g.publishFails) return new Response(JSON.stringify({ error: { message: "temporário" } }), { status: 500 });
      g.publishedContainers.push(new URLSearchParams(String(init?.body ?? "")).get("creation_id") ?? "?");
      return new Response(JSON.stringify({ id: "reel-media" }), { status: 200 });
    }
    if (u.includes("status_code")) {
      g.polls++;
      const id = u.split("/").pop()!.split("?")[0];
      const httpError = g.statusHttpError?.[id];
      if (httpError) {
        return new Response(JSON.stringify({ error: { message: "Unsupported get request. Object does not exist" } }), { status: httpError });
      }
      const code = g.forcedStatus ?? (g.polls >= g.pollsUntilFinished ? "FINISHED" : "IN_PROGRESS");
      return new Response(JSON.stringify({ status_code: code }), { status: 200 });
    }
    if (u.endsWith("/media")) {
      g.containersCreated++;
      return new Response(JSON.stringify({ id: `container-${g.containersCreated}` }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return g;
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("#10922 fireQueueEntry: retoma o container entre voltas", () => {
  it("poll estourado devolve o container; a volta seguinte retoma o MESMO, sem criar outro (cenário da issue)", async () => {
    // Processamento lento: só fica FINISHED no 1000º poll — nunca dentro de 1 volta.
    const g = mockGraph({ pollsUntilFinished: 1_000_000 });
    const first = await fireQueueEntry(reelsEntry(), config);
    assert.equal(first.status, "failed");
    const ref = (first as { reelsContainer?: { id: string; created_at: string } }).reelsContainer;
    assert.equal(ref?.id, "container-1", "a falha devolve o container em uso");
    assert.ok(!Number.isNaN(Date.parse(ref!.created_at)));

    g.pollsUntilFinished = g.polls + 1; // a Meta termina durante a 2ª volta
    const second = await fireQueueEntry(reelsEntry({ reels_container: ref, retry_count: 1 }), config);
    assert.deepEqual(second, { status: "fired" });
    assert.equal(g.containersCreated, 1, "nunca cria um 2º container");
    assert.deepEqual(g.publishedContainers, ["container-1"]);
  });

  it("media_publish que falha mantém o container FINISHED pra próxima volta só publicar", async () => {
    const g = mockGraph({ publishFails: true });
    const first = await fireQueueEntry(reelsEntry(), config);
    assert.equal(first.status, "failed");
    const ref = (first as { reelsContainer?: { id: string; created_at: string } }).reelsContainer;
    assert.equal(ref?.id, "container-1");
    g.publishFails = false;
    const second = await fireQueueEntry(reelsEntry({ reels_container: ref }), config);
    assert.deepEqual(second, { status: "fired" });
    assert.equal(g.containersCreated, 1);
  });

  it("container retomado EXPIRED → failed sem container (a próxima volta cria outro), nunca DLQ", async () => {
    const g = mockGraph({ forcedStatus: "EXPIRED" });
    const out = await fireQueueEntry(reelsEntry({ reels_container: { id: "old-container", created_at: new Date().toISOString() } }), config);
    assert.equal(out.status, "failed");
    assert.equal((out as { reelsContainer?: unknown }).reelsContainer, undefined);
    assert.equal(g.containersCreated, 0);
  });

  it("#10954: container retomado que a Graph recusa com 4xx → failed sem container; a volta seguinte cria outro e publica", async () => {
    const g = mockGraph({ statusHttpError: { "old-container": 400 } });
    const resumedRef = { id: "old-container", created_at: new Date().toISOString() };
    const first = await fireQueueEntry(reelsEntry({ reels_container: resumedRef, retry_count: 1 }), config);
    assert.equal(first.status, "failed", "nunca DLQ: o vídeo ainda serve");
    assert.equal((first as { reelsContainer?: unknown }).reelsContainer, undefined, "descarta o container recusado");
    assert.equal(g.containersCreated, 0);

    const second = await fireQueueEntry(reelsEntry({ retry_count: 2 }), config);
    assert.deepEqual(second, { status: "fired" });
    assert.equal(g.containersCreated, 1, "a volta seguinte cria um container novo");
    assert.deepEqual(g.publishedContainers, ["container-1"]);
  });

  it("#10954: 429 no container retomado segue transitório e mantém o container", async () => {
    mockGraph({ statusHttpError: { "old-container": 429 } });
    const resumedRef = { id: "old-container", created_at: new Date().toISOString() };
    const out = await fireQueueEntry(reelsEntry({ reels_container: resumedRef }), config);
    assert.equal(out.status, "failed");
    assert.equal((out as { reelsContainer?: { id: string } }).reelsContainer?.id, "old-container");
  });

  it("#10954: 4xx num container recém-criado segue transitório (só o retomado é descartado)", async () => {
    mockGraph({ statusHttpError: { "container-1": 400 } });
    const out = await fireQueueEntry(reelsEntry(), config);
    assert.equal(out.status, "failed");
    assert.equal((out as { reelsContainer?: { id: string } }).reelsContainer?.id, "container-1");
  });

  it("container retomado ERROR → DLQ (o arquivo não serve)", async () => {
    mockGraph({ forcedStatus: "ERROR" });
    const out = await fireQueueEntry(reelsEntry({ reels_container: { id: "old-container", created_at: new Date().toISOString() } }), config);
    assert.equal(out.status, "dlq");
  });

  it("container velho demais é ignorado e a volta cria outro", async () => {
    const g = mockGraph();
    const old = new Date(Date.now() - REELS_CONTAINER_RESUME_MAX_AGE_MS - 60_000).toISOString();
    const out = await fireQueueEntry(reelsEntry({ reels_container: { id: "old-container", created_at: old } }), config);
    assert.deepEqual(out, { status: "fired" });
    assert.equal(g.containersCreated, 1);
    assert.deepEqual(g.publishedContainers, ["container-1"]);
  });
});

describe("#10922 resumableReelsContainer / pickReelsContainer", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  it("aceita só id seguro + data legível dentro da janela", () => {
    assert.deepEqual(resumableReelsContainer({ id: "178", created_at: "2026-10-23T11:00:00Z" }, now), { id: "178", created_at: "2026-10-23T11:00:00Z" });
    assert.equal(resumableReelsContainer({ id: "a/b", created_at: "2026-10-23T11:00:00Z" }, now), null);
    assert.equal(resumableReelsContainer({ id: "178", created_at: "lixo" }, now), null);
    assert.equal(resumableReelsContainer({ id: "178", created_at: "2026-10-22T12:00:00Z" }, now), null, "24 h: expirado");
    assert.equal(resumableReelsContainer(null, now), null);
  });
  it("entre KV e DO, o container mais recente vence", () => {
    const a = { id: "1", created_at: "2026-10-23T10:00:00Z" };
    const b = { id: "2", created_at: "2026-10-23T11:00:00Z" };
    assert.deepEqual(pickReelsContainer(a, b, now), b);
    assert.deepEqual(pickReelsContainer(b, a, now), b);
    assert.deepEqual(pickReelsContainer(undefined, a, now), a);
    assert.equal(pickReelsContainer(undefined, null, now), null);
  });
});

// ── caminhos reais de gravação: cron (KV + DO) e alarm (storage do DO) ──

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
    return { keys: [...this.store.keys()].filter((k) => k.startsWith(o.prefix ?? "")).map((name) => ({ name })), list_complete: true };
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
    DIARIA_TOKEN: "t",
    MAKE_WEBHOOK_URL: "https://make.test/diaria",
    INSTAGRAM_BUSINESS_ACCOUNT_ID: CREDS.igUserId,
    INSTAGRAM_ACCESS_TOKEN: CREDS.accessToken,
    LINKEDIN_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: (url: string, init?: RequestInit) => get(id.name).scheduler.fetch(new Request(url, init)),
      }),
    },
  } as unknown as Env;
  return { env, kv, get };
}

describe("#10922 cron (fireDueItems): o container sobrevive no KV e no DO", () => {
  it("1ª volta estoura o poll → entry do KV ganha reels_container; 2ª volta retoma e publica o mesmo", async () => {
    // fireDueItems usa o orçamento de produção (36 polls × 5 s): o container
    // nunca termina na 1ª volta e o setTimeout zerado esgota as tentativas rápido.
    const g = mockGraph({ forcedStatus: "IN_PROGRESS" });
    const { env, kv, get } = mkEnv();
    const key = "queue:1:abc";
    kv.store.set(key, JSON.stringify(reelsEntry()));
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      await __test__.fireDueItems(env);
      const after1 = JSON.parse(kv.store.get(key)!) as QueueEntry;
      assert.equal(after1.retry_count, 1);
      assert.equal(after1.reels_container?.id, "container-1", "o KV guarda o container");
      assert.equal((get(key).state.storage.store.get("reels_container") as { id: string }).id, "container-1", "o DO também");

      g.forcedStatus = "FINISHED";
      await __test__.fireDueItems(env);
      assert.equal(kv.store.has(key), false, "publicado → sai da fila");
      assert.equal(g.containersCreated, 1, "nunca recria o container");
      assert.deepEqual(g.publishedContainers, ["container-1"]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe("#10922 alarm do DO: guarda o container e entrega no /claim", () => {
  it("alarm com poll estourado grava reels_container; o /claim seguinte devolve ele", async () => {
    mockGraph({ forcedStatus: "IN_PROGRESS" });
    const state = new MockState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const payload: DoStoredPayload = { key: "queue:1:abc", entry: reelsEntry(), webhookUrl: "https://make.test/diaria", instagram: CREDS };
    await state.storage.put("payload", payload);
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      await scheduler.alarm();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.equal((state.storage.store.get("reels_container") as { id: string }).id, "container-1");
    assert.equal(state.storage.store.get("claiming"), undefined, "claim liberado");
    const res = await scheduler.fetch(new Request("https://do/claim", { method: "POST" }));
    const body = (await res.json()) as { claimed: boolean; reels_container?: { id: string } };
    assert.equal(body.claimed, true);
    assert.equal(body.reels_container?.id, "container-1");
  });

  it("POST /reels-container com null apaga o container guardado", async () => {
    const state = new MockState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("reels_container", { id: "x", created_at: new Date().toISOString() });
    await scheduler.fetch(new Request("https://do/reels-container", { method: "POST", body: JSON.stringify({ reels_container: null }) }));
    assert.equal(state.storage.store.has("reels_container"), false);
  });
});
