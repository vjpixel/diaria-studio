/**
 * make-webhook-auth.test.ts (#3903)
 *
 * Testa o header `x-make-apikey` opcional adicionado ao POST do webhook
 * Make.com (`src/dispatch.ts::fireLinkedIn`, compartilhado entre o cron path
 * (`fire.ts`) e o alarm path (`durable-object.ts`)) — reativa o
 * `authenticationMethod` que o scenario Make ANTERIOR (2270381) já tinha
 * configurado. Migração incremental: `MAKE_WEBHOOK_API_KEY` ausente = POST
 * sai sem o header (comportamento pré-existente), nunca com header vazio.
 *
 * Cobertura:
 *   - fireQueueEntry (unit): apiKey presente/ausente, target diaria e pixel
 *   - fireDueItems (cron path, via env.MAKE_WEBHOOK_API_KEY): header end-to-end
 *   - handleEnqueue: captura de MAKE_WEBHOOK_API_KEY no DO arm payload
 *   - alarm() (Durable Object): payload.webhookApiKey chega no header do fetch
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, {
  buildQueueKey,
  __test__,
  type Env,
  type QueueEntry,
} from "../src/index.ts";
import { fireQueueEntry } from "../src/dispatch.ts";
import { LinkedInScheduler, type DoStoredPayload } from "../src/durable-object.ts";

// ── In-memory KV mock (mesmo padrão de test/index.test.ts) ─────────────────

type KVValue = string;
class MockKV {
  store = new Map<string, KVValue>();
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(opts: { prefix?: string }): Promise<{ keys: { name: string }[]; list_complete: true }> {
    const prefix = opts.prefix ?? "";
    const names = Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
    names.sort();
    return { keys: names.map((name) => ({ name })), list_complete: true };
  }
}

function mkEnv(overrides: Partial<Env> = {}): { env: Env; kv: MockKV } {
  const kv = new MockKV();
  const env = {
    LINKEDIN_QUEUE: kv as unknown as KVNamespace,
    DIARIA_TOKEN: "secret-token",
    MAKE_WEBHOOK_URL: "https://make.test/diaria",
    ...overrides,
  } as Env;
  return { env, kv };
}

function authedRequest(url: string, init?: RequestInit, token = "secret-token"): Request {
  const headers = new Headers(init?.headers);
  headers.set("X-Diaria-Token", token);
  return new Request(url, { ...init, headers });
}

// ── Minimal DO storage mock pra testes de alarm() isolados (sem concorrência) ──

class SimpleDOStorage {
  store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.store.has(key) ? (this.store.get(key) as T) : undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.store.clear();
  }
  async setAlarm(_ms: number): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}
class SimpleDOState {
  storage = new SimpleDOStorage();
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

// ── DO namespace mock que só captura o body de POST /arm ────────────────────

function mkCapturingDONamespace(): {
  namespace: DurableObjectNamespace;
  armPayloads: Array<DoStoredPayload & { scheduledAtMs: number }>;
} {
  const armPayloads: Array<DoStoredPayload & { scheduledAtMs: number }> = [];
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name, name, equals: () => false }),
    get: (_id: { name: string }) => ({
      fetch: async (url: string | Request, init?: RequestInit) => {
        const u = typeof url === "string" ? url : url.url;
        if (u.endsWith("/arm") && init?.body) {
          armPayloads.push(JSON.parse(init.body as string));
        }
        return new Response(JSON.stringify({ armed: true }), { status: 200 });
      },
    }),
    idFromString: (id: string) => ({ toString: () => id, name: id, equals: () => false }),
    newUniqueId: () => ({ toString: () => "unique", name: "unique", equals: () => false }),
    jurisdiction: () => namespace,
  } as unknown as DurableObjectNamespace;
  return { namespace, armPayloads };
}

// ── fireQueueEntry (unit) ────────────────────────────────────────────────────

describe("#3903 fireQueueEntry: header x-make-apikey no POST ao webhook Make", () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedHeaders: HeadersInit | undefined;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedHeaders = undefined;
  });

  function mkEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
    return {
      text: "x",
      image_url: null,
      scheduled_at: new Date().toISOString(),
      destaque: "d1",
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("apiKey presente: header x-make-apikey vai no fetch (target=diaria)", async () => {
    globalThis.fetch = (async (_url: string | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const outcome = await fireQueueEntry(mkEntry(), {
        webhookUrl: "https://make.test/diaria",
        apiKey: "wk-secret-1",
      });
      assert.deepEqual(outcome, { status: "fired" });
      const headers = capturedHeaders as Record<string, string>;
      assert.equal(headers["x-make-apikey"], "wk-secret-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("apiKey ausente: header x-make-apikey NÃO vai no fetch", async () => {
    globalThis.fetch = (async (_url: string | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      await fireQueueEntry(mkEntry(), { webhookUrl: "https://make.test/diaria" });
      const headers = capturedHeaders as Record<string, string>;
      assert.equal("x-make-apikey" in headers, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("apiKey presente + webhook_target=pixel: header também vai na URL do pixel", async () => {
    globalThis.fetch = (async (_url: string | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const outcome = await fireQueueEntry(
        mkEntry({ webhook_target: "pixel", action: "comment", parent_destaque: "d1" }),
        {
          webhookUrl: "https://make.test/diaria",
          pixelWebhookUrl: "https://make.test/pixel",
          apiKey: "wk-secret-pixel",
        },
      );
      assert.deepEqual(outcome, { status: "fired" });
      const headers = capturedHeaders as Record<string, string>;
      assert.equal(headers["x-make-apikey"], "wk-secret-pixel");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── fireDueItems (cron path) — header end-to-end via env ────────────────────

describe("#3903 fireDueItems (cron): env.MAKE_WEBHOOK_API_KEY chega no header do POST", () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedHeaders: HeadersInit | undefined;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedHeaders = undefined;
  });

  it("MAKE_WEBHOOK_API_KEY setado no env → header presente", async () => {
    globalThis.fetch = (async (_url: string | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const { env, kv } = mkEnv({ MAKE_WEBHOOK_API_KEY: "env-secret-key" });
    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "post",
      image_url: null,
      scheduled_at: past,
      destaque: "d1",
      created_at: past,
      retry_count: 0,
    };
    kv.store.set(buildQueueKey(past, "uuid-apikey-present"), JSON.stringify(entry));
    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      const headers = capturedHeaders as Record<string, string>;
      assert.equal(headers["x-make-apikey"], "env-secret-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("MAKE_WEBHOOK_API_KEY ausente do env → header omitido (comportamento pré-#3903)", async () => {
    globalThis.fetch = (async (_url: string | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const { env, kv } = mkEnv(); // sem MAKE_WEBHOOK_API_KEY
    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "post",
      image_url: null,
      scheduled_at: past,
      destaque: "d2",
      created_at: past,
      retry_count: 0,
    };
    kv.store.set(buildQueueKey(past, "uuid-apikey-absent"), JSON.stringify(entry));
    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      const headers = capturedHeaders as Record<string, string>;
      assert.equal("x-make-apikey" in headers, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── handleEnqueue: captura MAKE_WEBHOOK_API_KEY no DO arm payload ───────────

describe("#3903 handleEnqueue: captura MAKE_WEBHOOK_API_KEY no DO arm payload", () => {
  it("env com MAKE_WEBHOOK_API_KEY → armPayload.webhookApiKey presente", async () => {
    const { env } = mkEnv({ MAKE_WEBHOOK_API_KEY: "enqueue-secret" });
    const { namespace, armPayloads } = mkCapturingDONamespace();
    (env as Env).LINKEDIN_SCHEDULER = namespace;

    const body = {
      text: "Post",
      image_url: null,
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    assert.equal(armPayloads.length, 1);
    assert.equal(armPayloads[0].webhookApiKey, "enqueue-secret");
  });

  it("env sem MAKE_WEBHOOK_API_KEY → armPayload.webhookApiKey OMITIDO (não undefined explícito)", async () => {
    const { env } = mkEnv(); // sem MAKE_WEBHOOK_API_KEY
    const { namespace, armPayloads } = mkCapturingDONamespace();
    (env as Env).LINKEDIN_SCHEDULER = namespace;

    const body = {
      text: "Post",
      image_url: null,
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    assert.equal(armPayloads.length, 1);
    assert.ok(!("webhookApiKey" in armPayloads[0]));
  });
});

// ── alarm() (Durable Object): payload.webhookApiKey chega no header ────────

describe("#3903 alarm(): payload.webhookApiKey chega no header x-make-apikey do fetch", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("payload com webhookApiKey → header presente no POST disparado pelo alarm", async () => {
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (_url: string | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const state = new SimpleDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const payload: DoStoredPayload = {
      key: "queue:test:uuid-alarm-apikey",
      entry: {
        text: "post",
        image_url: null,
        scheduled_at: new Date().toISOString(),
        destaque: "d1",
        created_at: new Date().toISOString(),
      },
      webhookUrl: "https://make.test/diaria",
      webhookApiKey: "alarm-secret",
    };
    await state.storage.put("payload", payload);

    try {
      await scheduler.alarm();
      const fired = await state.storage.get<boolean>("fired");
      assert.equal(fired, true);
      const headers = capturedHeaders as Record<string, string>;
      assert.equal(headers["x-make-apikey"], "alarm-secret");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("payload SEM webhookApiKey → header omitido (backward-compat, legacy DO payload)", async () => {
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (_url: string | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const state = new SimpleDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const payload: DoStoredPayload = {
      key: "queue:test:uuid-alarm-noapikey",
      entry: {
        text: "post",
        image_url: null,
        scheduled_at: new Date().toISOString(),
        destaque: "d2",
        created_at: new Date().toISOString(),
      },
      webhookUrl: "https://make.test/diaria",
      // webhookApiKey OMITIDO de propósito — simula DO armado antes do #3903
    };
    await state.storage.put("payload", payload);

    try {
      await scheduler.alarm();
      const fired = await state.storage.get<boolean>("fired");
      assert.equal(fired, true);
      const headers = capturedHeaders as Record<string, string>;
      assert.equal("x-make-apikey" in headers, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
