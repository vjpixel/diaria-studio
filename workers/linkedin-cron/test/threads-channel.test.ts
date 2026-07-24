/**
 * threads-channel.test.ts (#3944 Parte B)
 *
 * Testa o canal Threads no Worker `diaria-linkedin-cron`, generalizado pra
 * agendar via Threads API direta (sem Make) além de LinkedIn/Instagram — ver
 * `src/dispatch.ts` (fireQueueEntry, fireThreads, resolveThreadsCreds).
 * Espelha `instagram-channel.test.ts` (#3817) ponto a ponto, com 2 diferenças
 * deliberadas: (a) sem teste de "imagem ausente" (Threads não exige imagem);
 * (b) com teste novo de "texto >500 chars → dlq sem fetch" (chunking agendado
 * não é suportado no Worker — ver doc-comment de fireThreads).
 *
 * Cobertura:
 *   - backward-compat: entry sem `channel` continua indo pro webhook Make
 *   - happy path Threads: POST /threads (media_type=TEXT+text) → POST /threads_publish
 *     (creation_id), na ordem certa, via fireDueItems (cron path)
 *   - guard de tamanho: texto >500 chars vai pra DLQ sem tentar fetch
 *   - erro da Threads API alimenta o MESMO mecanismo de retry_count/DLQ do LinkedIn
 *   - credenciais Threads ausentes → DLQ direto, sem tentar nenhum fetch
 *   - handleEnqueue: validação de `channel` + guard de tamanho no enqueue
 *   - handleEnqueue: captura de credenciais Threads no DO arm payload
 *   - alarm() (Durable Object): mesmo fireQueueEntry compartilhado com o cron
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, {
  buildQueueKey,
  MAX_RETRIES,
  __test__,
  type Env,
  type QueueEntry,
} from "../src/index.ts";
import { fireQueueEntry, resolveThreadsCreds } from "../src/dispatch.ts";
import { LinkedInScheduler, type DoStoredPayload } from "../src/durable-object.ts";

// ── In-memory KV mock (mesmo padrão de test/index.test.ts / instagram-channel.test.ts) ──

type KVValue = string;
type PutOptions = { expirationTtl?: number };
class MockKV {
  store = new Map<string, KVValue>();
  putOptions = new Map<string, PutOptions>();
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  async put(key: string, value: string, options?: PutOptions): Promise<void> {
    this.store.set(key, value);
    if (options) this.putOptions.set(key, options);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.putOptions.delete(key);
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

// ── DO namespace mock que só captura o body de POST /arm (pra testes de enqueue) ──

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

// ── #3944 Parte B backward-compat: entry sem channel (o teste mais importante) ──

describe("#3944 Parte B backward-compat: entry sem `channel` continua indo pro webhook Make", () => {
  let fetchCalls: string[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
  });

  it("fireQueueEntry (unit): entry sem channel resolve pra linkedin e ignora config.threads", async () => {
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      fetchCalls.push(u);
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "x",
      image_url: null,
      scheduled_at: new Date().toISOString(),
      destaque: "d1",
      created_at: new Date().toISOString(),
    };
    try {
      const outcome = await fireQueueEntry(entry, {
        webhookUrl: "https://make.test/diaria",
        // threads presente mas não deve ser usado — entry não pediu esse canal
        threads: { userId: "acc", accessToken: "tok", apiVersion: "v1.0" },
      });
      assert.deepEqual(outcome, { status: "fired" });
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0], "https://make.test/diaria");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── #3944 Parte B Threads happy path: /threads → /threads_publish ──────────

describe("#3944 Parte B Threads: sequência /threads → /threads_publish com os parâmetros certos", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("cron dispara channel=threads: cria container (media_type=TEXT+text) e publica (creation_id) na ordem certa", async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = [];
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      const body =
        init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
      calls.push({ url: u, method: init?.method, body });
      if (u.endsWith("/threads_publish")) {
        return new Response(JSON.stringify({ id: "17896453961137500" }), { status: 200 });
      }
      if (u.endsWith("/threads")) {
        return new Response(JSON.stringify({ id: "container-123" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { env, kv } = mkEnv({
      THREADS_USER_ID: "27020520314294047",
      THREADS_ACCESS_TOKEN: "test-token",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-threads-happy");
    const entry: QueueEntry = {
      text: "Post curto de teste #ia",
      image_url: null,
      scheduled_at: past,
      destaque: "d1",
      created_at: past,
      retry_count: 0,
      channel: "threads",
    };
    kv.store.set(key, JSON.stringify(entry));

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      assert.equal(result.dlq, 0);
      assert.equal(result.errors, 0);

      const containerCall = calls.find((c) => c.url.endsWith("/threads") && c.method === "POST");
      assert.ok(containerCall, "deve ter chamado POST .../threads");
      assert.match(containerCall!.body, /media_type=TEXT/, "container deve levar media_type=TEXT");
      assert.match(containerCall!.body, /text=/, "container deve levar text");

      const publishCall = calls.find((c) => c.url.endsWith("/threads_publish"));
      assert.ok(publishCall, "deve ter chamado POST .../threads_publish");
      assert.match(
        publishCall!.body,
        /creation_id=container-123/,
        "publish deve usar o creation_id retornado pelo passo 1",
      );

      // Item disparado com sucesso → removido do KV (mesmo invariante do LinkedIn/Instagram)
      assert.equal(kv.store.has(key), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("texto >500 chars → dlq direto, sem tentar nenhum fetch (chunking agendado não suportado)", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "x".repeat(501),
      image_url: null,
      scheduled_at: new Date().toISOString(),
      destaque: "d1",
      created_at: new Date().toISOString(),
      channel: "threads",
    };
    try {
      const outcome = await fireQueueEntry(entry, {
        webhookUrl: "https://make.test/diaria",
        threads: { userId: "acc", accessToken: "tok", apiVersion: "v1.0" },
      });
      assert.equal(outcome.status, "dlq");
      assert.match(outcome.reason, /500 chars/);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── #3944 Parte B Threads: erro da API alimenta retry/DLQ ───────────────────

describe("#3944 Parte B Threads: erro da Threads API alimenta o mesmo retry_count/DLQ do LinkedIn", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("falha em /threads (HTTP 500) incrementa retry_count — não vai pra DLQ na 1ª falha", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 500 })) as typeof fetch;

    const { env, kv } = mkEnv({
      THREADS_USER_ID: "acc",
      THREADS_ACCESS_TOKEN: "tok",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-threads-fail-1");
    const entry: QueueEntry = {
      text: "t",
      image_url: null,
      scheduled_at: past,
      destaque: "d1",
      created_at: past,
      retry_count: 0,
      channel: "threads",
    };
    kv.store.set(key, JSON.stringify(entry));

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 0);
      assert.equal(result.dlq, 0);
      assert.equal(result.errors, 1);
      const updated = JSON.parse(kv.store.get(key) as string) as QueueEntry;
      assert.equal(updated.retry_count, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it(`após ${MAX_RETRIES} falhas consecutivas da Threads API, vai pra dlq: (mesma mecânica do #880/#894)`, async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 })) as typeof fetch;

    const { env, kv } = mkEnv({
      THREADS_USER_ID: "acc",
      THREADS_ACCESS_TOKEN: "tok",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-threads-fail-dlq");
    const entry: QueueEntry = {
      text: "t",
      image_url: null,
      scheduled_at: past,
      destaque: "d2",
      created_at: past,
      retry_count: 0,
      channel: "threads",
    };
    kv.store.set(key, JSON.stringify(entry));

    try {
      for (let i = 0; i < MAX_RETRIES; i++) {
        await __test__.fireDueItems(env);
      }
      assert.equal(kv.store.has(key), false);
      const dlqKeys = Array.from(kv.store.keys()).filter((k) => k.startsWith("dlq:"));
      assert.equal(dlqKeys.length, 1);
      const dlqEntry = JSON.parse(kv.store.get(dlqKeys[0]) as string) as QueueEntry;
      assert.equal(dlqEntry.destaque, "d2");
      assert.equal(dlqEntry.retry_count, MAX_RETRIES);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falha em /threads_publish (após /threads OK) também é retriable, não dlq direto", async () => {
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.endsWith("/threads_publish")) {
        return new Response(JSON.stringify({ error: { message: "Media not available" } }), {
          status: 400,
        });
      }
      if (u.endsWith("/threads")) {
        return new Response(JSON.stringify({ id: "container-xyz" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { env, kv } = mkEnv({
      THREADS_USER_ID: "acc",
      THREADS_ACCESS_TOKEN: "tok",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-threads-publish-fail");
    const entry: QueueEntry = {
      text: "t",
      image_url: null,
      scheduled_at: past,
      destaque: "d3",
      created_at: past,
      retry_count: 0,
      channel: "threads",
    };
    kv.store.set(key, JSON.stringify(entry));

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 0);
      assert.equal(result.dlq, 0);
      assert.equal(result.errors, 1);
      const updated = JSON.parse(kv.store.get(key) as string) as QueueEntry;
      assert.equal(updated.retry_count, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── #3944 Parte B Threads: credenciais ausentes → DLQ direto ────────────────

describe("#3944 Parte B Threads: credenciais ausentes → DLQ direto, sem tentar fetch", () => {
  it("channel=threads sem THREADS_ACCESS_TOKEN/THREADS_USER_ID → DLQ imediato", async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const { env, kv } = mkEnv(); // sem THREADS_* no env
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-threads-nocreds");
    const entry: QueueEntry = {
      text: "t",
      image_url: null,
      scheduled_at: past,
      destaque: "d3",
      created_at: past,
      retry_count: 0,
      channel: "threads",
    };
    kv.store.set(key, JSON.stringify(entry));

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.dlq, 1);
      assert.equal(fetchCalled, false, "não deve tentar Threads API sem credenciais");
      const dlqKeys = Array.from(kv.store.keys()).filter((k) => k.startsWith("dlq:"));
      assert.equal(dlqKeys.length, 1);
      assert.equal(kv.store.has(key), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolveThreadsCreds: undefined quando falta qualquer uma das 2 credenciais obrigatórias", () => {
    assert.equal(resolveThreadsCreds({ THREADS_ACCESS_TOKEN: "x" } as Env), undefined);
    assert.equal(resolveThreadsCreds({ THREADS_USER_ID: "y" } as Env), undefined);
    assert.equal(resolveThreadsCreds({} as Env), undefined);
  });

  it("resolveThreadsCreds: default apiVersion v1.0 quando THREADS_API_VERSION ausente", () => {
    const creds = resolveThreadsCreds({
      THREADS_USER_ID: "y",
      THREADS_ACCESS_TOKEN: "x",
    } as Env);
    assert.deepEqual(creds, { userId: "y", accessToken: "x", apiVersion: "v1.0" });
  });

  it("resolveThreadsCreds: honra THREADS_API_VERSION customizado", () => {
    const creds = resolveThreadsCreds({
      THREADS_USER_ID: "y",
      THREADS_ACCESS_TOKEN: "x",
      THREADS_API_VERSION: "v99.0",
    } as Env);
    assert.equal(creds?.apiVersion, "v99.0");
  });
});

// ── #3944 Parte B handleEnqueue: validação de channel + guard de tamanho ────

describe("#3944 Parte B handleEnqueue: validação de channel + guard de tamanho pro Threads", () => {
  it("rejeita channel inválido", async () => {
    const { env } = mkEnv();
    const body = { text: "x", scheduled_at: "2026-12-01T12:00:00Z", destaque: "d1", channel: "twitter" };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /channel/);
  });

  it("rejeita channel=threads com texto >500 chars", async () => {
    const { env } = mkEnv();
    const body = {
      text: "x".repeat(501),
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "threads",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /500 chars/);
  });

  it("aceita channel=threads com texto ≤500 chars, sem exigir image_url, e persiste channel na entry", async () => {
    const { env, kv } = mkEnv();
    const body = {
      text: "Post curto",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "threads",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    const data = (await res.json()) as { key: string };
    const parsed = JSON.parse(kv.store.get(data.key) as string) as QueueEntry;
    assert.equal(parsed.channel, "threads");
  });
});

// ── #3944 Parte B handleEnqueue: captura credenciais Threads no DO arm payload ──

describe("#3944 Parte B handleEnqueue: captura credenciais Threads no DO arm payload", () => {
  it("channel=threads + env com credenciais → armPayload.threads presente", async () => {
    const { env } = mkEnv({ THREADS_USER_ID: "acc", THREADS_ACCESS_TOKEN: "tok" });
    const { namespace, armPayloads } = mkCapturingDONamespace();
    (env as Env).LINKEDIN_SCHEDULER = namespace;

    const body = {
      text: "Post curto",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "threads",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    assert.equal(armPayloads.length, 1);
    assert.deepEqual(armPayloads[0].threads, { userId: "acc", accessToken: "tok", apiVersion: "v1.0" });
  });

  it("credenciais ausentes no env → armPayload.threads OMITIDO (não fica undefined explícito)", async () => {
    const { env } = mkEnv(); // sem THREADS_*
    const { namespace, armPayloads } = mkCapturingDONamespace();
    (env as Env).LINKEDIN_SCHEDULER = namespace;

    const body = {
      text: "Post curto",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "threads",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    assert.equal(armPayloads.length, 1);
    assert.ok(!("threads" in armPayloads[0]));
  });
});

// ── #3944 Parte B alarm() (Durable Object): mesmo fireQueueEntry compartilhado ──

describe("#3944 Parte B alarm(): dispara Threads via fireQueueEntry (mesmo caminho do cron)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("alarm() com payload.threads configurado publica via Threads API e seta fired=true", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      calls.push(u);
      if (u.endsWith("/threads_publish")) {
        return new Response(JSON.stringify({ id: "media-1" }), { status: 200 });
      }
      if (u.endsWith("/threads")) {
        return new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const state = new SimpleDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const payload: DoStoredPayload = {
      key: "queue:test:uuid-threads-alarm",
      entry: {
        text: "Post curto",
        image_url: null,
        scheduled_at: new Date().toISOString(),
        destaque: "d1",
        created_at: new Date().toISOString(),
        channel: "threads",
      },
      webhookUrl: "https://make.test/diaria", // sempre presente (mesmo padrão do enqueue), ignorado pro threads
      threads: { userId: "acc", accessToken: "tok", apiVersion: "v1.0" },
    };
    await state.storage.put("payload", payload);

    try {
      await scheduler.alarm();
      const fired = await state.storage.get<boolean>("fired");
      assert.equal(fired, true);
      assert.ok(calls.some((c) => c.endsWith("/threads")));
      assert.ok(calls.some((c) => c.endsWith("/threads_publish")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("alarm() com channel=threads mas SEM payload.threads: libera claim sem chamar fetch (cron fará DLQ)", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const state = new SimpleDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const payload: DoStoredPayload = {
      key: "queue:test:uuid-threads-nocreds-alarm",
      entry: {
        text: "Post curto",
        image_url: null,
        scheduled_at: new Date().toISOString(),
        destaque: "d2",
        created_at: new Date().toISOString(),
        channel: "threads",
      },
      webhookUrl: "https://make.test/diaria",
      // threads OMITIDO — simula deploy sem secrets configurados
    };
    await state.storage.put("payload", payload);

    try {
      await scheduler.alarm();
      assert.equal(fetchCalled, false, "não deve tentar Threads API sem credenciais no payload");
      const fired = await state.storage.get<boolean>("fired");
      assert.equal(fired, undefined);
      const claiming = await state.storage.get<boolean>("claiming");
      assert.equal(claiming, undefined, "claim deve ter sido liberado");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
