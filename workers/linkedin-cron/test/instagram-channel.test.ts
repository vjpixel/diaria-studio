/**
 * instagram-channel.test.ts (#3817)
 *
 * Testa o canal Instagram no Worker `diaria-linkedin-cron`, generalizado pra
 * agendar via Graph API direta (sem Make) além do LinkedIn — ver
 * `src/dispatch.ts` (fireQueueEntry, fireInstagram, resolveInstagramCreds).
 *
 * Cobertura:
 *   - backward-compat: entry sem `channel` continua indo pro webhook Make
 *     (o mais importante — protege o LinkedIn em produção, que nunca teve
 *     esse campo antes do #3817)
 *   - happy path Instagram: POST /media (image_url+caption) → POST /media_publish
 *     (creation_id), na ordem certa, via fireDueItems (cron path)
 *   - erro da Graph API alimenta o MESMO mecanismo de retry_count/DLQ do LinkedIn
 *   - credenciais Instagram ausentes → DLQ direto, sem tentar nenhum fetch
 *   - handleEnqueue: validação de `channel` + `image_url` obrigatório pro Instagram
 *   - handleEnqueue: captura de credenciais Instagram no DO arm payload
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
import { fireQueueEntry, resolveInstagramCreds } from "../src/dispatch.ts";
import { LinkedInScheduler, type DoStoredPayload } from "../src/durable-object.ts";

// ── In-memory KV mock (mesmo padrão de test/index.test.ts) ─────────────────

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

// ── #3817 backward-compat: entry sem channel (o teste mais importante) ─────

describe("#3817 backward-compat: entry sem `channel` continua indo pro webhook Make", () => {
  let fetchCalls: string[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
  });

  it("fireDueItems (cron): entry sem channel dispara MAKE_WEBHOOK_URL, NUNCA graph.facebook.com", async () => {
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      fetchCalls.push(u);
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const { env, kv } = mkEnv();
    const past = new Date(Date.now() - 60_000).toISOString();
    // channel OMITIDO de propósito — simula entry já em produção no KV antes do #3817.
    const entry: QueueEntry = {
      text: "post legacy",
      image_url: null,
      scheduled_at: past,
      destaque: "d1",
      created_at: past,
      retry_count: 0,
    };
    kv.store.set(buildQueueKey(past, "uuid-legacy-nochannel"), JSON.stringify(entry));

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0], "https://make.test/diaria");
      assert.ok(!fetchCalls.some((u) => u.includes("graph.facebook.com")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fireQueueEntry (unit): entry sem channel resolve pra linkedin e ignora config.instagram", async () => {
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
        // instagram presente mas não deve ser usado — entry não pediu esse canal
        instagram: { igUserId: "acc", accessToken: "tok", apiVersion: "v25.0" },
      });
      assert.deepEqual(outcome, { status: "fired" });
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0], "https://make.test/diaria");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── #3817 Instagram happy path: /media → /media_publish ─────────────────────

describe("#3817 Instagram: sequência /media → /media_publish com os parâmetros certos", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("cron dispara channel=instagram: cria container (image_url+caption) e publica (creation_id) na ordem certa", async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = [];
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      const body =
        init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
      calls.push({ url: u, method: init?.method, body });
      if (u.endsWith("/media_publish")) {
        return new Response(JSON.stringify({ id: "17896453961137500" }), { status: 200 });
      }
      if (u.includes("status_code")) {
        return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
      }
      if (u.endsWith("/media")) {
        return new Response(JSON.stringify({ id: "container-123" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { env, kv } = mkEnv({
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "17841422721183309",
      INSTAGRAM_ACCESS_TOKEN: "test-token",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-ig-happy");
    const entry: QueueEntry = {
      text: "Legenda do post #ia",
      image_url: "https://poll.diaria.workers.dev/img/img-260722-04-d1-1x1.jpg",
      scheduled_at: past,
      destaque: "d1",
      created_at: past,
      retry_count: 0,
      channel: "instagram",
    };
    kv.store.set(key, JSON.stringify(entry));

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      assert.equal(result.dlq, 0);
      assert.equal(result.errors, 0);

      const mediaCall = calls.find((c) => c.url.endsWith("/media") && c.method === "POST");
      assert.ok(mediaCall, "deve ter chamado POST .../media");
      assert.match(mediaCall!.body, /image_url=/, "container deve levar image_url");
      assert.match(mediaCall!.body, /caption=/, "container deve levar caption");

      const publishCall = calls.find((c) => c.url.endsWith("/media_publish"));
      assert.ok(publishCall, "deve ter chamado POST .../media_publish");
      assert.match(
        publishCall!.body,
        /creation_id=container-123/,
        "publish deve usar o creation_id retornado pelo passo 1",
      );

      // Item disparado com sucesso → removido do KV (mesmo invariante do LinkedIn)
      assert.equal(kv.store.has(key), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("image_url ausente no entry → falha sem tentar nenhum fetch (Graph API exige imagem)", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "sem imagem",
      image_url: null,
      scheduled_at: new Date().toISOString(),
      destaque: "d1",
      created_at: new Date().toISOString(),
      channel: "instagram",
    };
    try {
      const outcome = await fireQueueEntry(entry, {
        webhookUrl: "https://make.test/diaria",
        instagram: { igUserId: "acc", accessToken: "tok", apiVersion: "v25.0" },
      });
      assert.equal(outcome.status, "dlq");
      assert.match(outcome.reason, /image_url/);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── #3817 Instagram: erro da Graph API alimenta retry/DLQ ───────────────────

describe("#3817 Instagram: erro da Graph API alimenta o mesmo retry_count/DLQ do LinkedIn", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("falha em /media (HTTP 500) incrementa retry_count — não vai pra DLQ na 1ª falha", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 500 })) as typeof fetch;

    const { env, kv } = mkEnv({
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "acc",
      INSTAGRAM_ACCESS_TOKEN: "tok",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-ig-fail-1");
    const entry: QueueEntry = {
      text: "t",
      image_url: "https://x.test/img.jpg",
      scheduled_at: past,
      destaque: "d1",
      created_at: past,
      retry_count: 0,
      channel: "instagram",
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

  it(`após ${MAX_RETRIES} falhas consecutivas da Graph API, vai pra dlq: (mesma mecânica do #880/#894)`, async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 })) as typeof fetch;

    const { env, kv } = mkEnv({
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "acc",
      INSTAGRAM_ACCESS_TOKEN: "tok",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-ig-fail-dlq");
    const entry: QueueEntry = {
      text: "t",
      image_url: "https://x.test/img.jpg",
      scheduled_at: past,
      destaque: "d2",
      created_at: past,
      retry_count: 0,
      channel: "instagram",
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

  it("falha em /media_publish (após /media OK) também é retriable, não dlq direto", async () => {
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.endsWith("/media_publish")) {
        return new Response(JSON.stringify({ error: { message: "Media ID is not available" } }), {
          status: 400,
        });
      }
      if (u.includes("status_code")) {
        return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
      }
      if (u.endsWith("/media")) {
        return new Response(JSON.stringify({ id: "container-xyz" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { env, kv } = mkEnv({
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "acc",
      INSTAGRAM_ACCESS_TOKEN: "tok",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-ig-publish-fail");
    const entry: QueueEntry = {
      text: "t",
      image_url: "https://x.test/img.jpg",
      scheduled_at: past,
      destaque: "d3",
      created_at: past,
      retry_count: 0,
      channel: "instagram",
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

// ── #3817 Instagram: credenciais ausentes → DLQ direto ──────────────────────

describe("#3817 Instagram: credenciais ausentes → DLQ direto, sem tentar fetch", () => {
  it("channel=instagram sem INSTAGRAM_BUSINESS_ACCOUNT_ID/ACCESS_TOKEN → DLQ imediato", async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const { env, kv } = mkEnv(); // sem INSTAGRAM_* no env
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-ig-nocreds");
    const entry: QueueEntry = {
      text: "t",
      image_url: "https://x.test/img.jpg",
      scheduled_at: past,
      destaque: "d3",
      created_at: past,
      retry_count: 0,
      channel: "instagram",
    };
    kv.store.set(key, JSON.stringify(entry));

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.dlq, 1);
      assert.equal(fetchCalled, false, "não deve tentar Graph API sem credenciais");
      const dlqKeys = Array.from(kv.store.keys()).filter((k) => k.startsWith("dlq:"));
      assert.equal(dlqKeys.length, 1);
      assert.equal(kv.store.has(key), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolveInstagramCreds: undefined quando falta qualquer uma das 2 credenciais obrigatórias", () => {
    assert.equal(resolveInstagramCreds({ INSTAGRAM_ACCESS_TOKEN: "x" } as Env), undefined);
    assert.equal(resolveInstagramCreds({ INSTAGRAM_BUSINESS_ACCOUNT_ID: "y" } as Env), undefined);
    assert.equal(resolveInstagramCreds({} as Env), undefined);
  });

  it("resolveInstagramCreds: default apiVersion v25.0 quando INSTAGRAM_API_VERSION ausente", () => {
    const creds = resolveInstagramCreds({
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "y",
      INSTAGRAM_ACCESS_TOKEN: "x",
    } as Env);
    assert.deepEqual(creds, { igUserId: "y", accessToken: "x", apiVersion: "v25.0" });
  });

  it("resolveInstagramCreds: honra INSTAGRAM_API_VERSION customizado", () => {
    const creds = resolveInstagramCreds({
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "y",
      INSTAGRAM_ACCESS_TOKEN: "x",
      INSTAGRAM_API_VERSION: "v99.0",
    } as Env);
    assert.equal(creds?.apiVersion, "v99.0");
  });
});

// ── #3817 handleEnqueue: validação de channel + image_url obrigatório ──────

describe("#3817 handleEnqueue: validação de channel + image_url obrigatório pro Instagram", () => {
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

  it("rejeita channel=instagram sem image_url", async () => {
    const { env } = mkEnv();
    const body = { text: "x", scheduled_at: "2026-12-01T12:00:00Z", destaque: "d1", channel: "instagram" };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /image_url/);
  });

  it("aceita channel=instagram com image_url e persiste channel na entry", async () => {
    const { env, kv } = mkEnv();
    const body = {
      text: "Legenda",
      image_url: "https://x.test/img.jpg",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "instagram",
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
    assert.equal(parsed.channel, "instagram");
  });

  it("backward-compat: entry sem channel não grava o campo (omitido, não null/undefined explícito)", async () => {
    const { env, kv } = mkEnv();
    const body = { text: "legacy", scheduled_at: "2026-12-01T12:00:00Z", destaque: "d2" };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    const data = (await res.json()) as { key: string };
    const parsed = JSON.parse(kv.store.get(data.key) as string) as QueueEntry;
    assert.equal(parsed.channel, undefined);
    assert.ok(!("channel" in parsed), "campo channel não deve nem existir na entry legacy");
  });
});

// ── #3817 handleEnqueue: captura credenciais Instagram no DO arm payload ────

describe("#3817 handleEnqueue: captura credenciais Instagram no DO arm payload", () => {
  it("channel=instagram + env com credenciais → armPayload.instagram presente", async () => {
    const { env } = mkEnv({ INSTAGRAM_BUSINESS_ACCOUNT_ID: "acc", INSTAGRAM_ACCESS_TOKEN: "tok" });
    const { namespace, armPayloads } = mkCapturingDONamespace();
    (env as Env).LINKEDIN_SCHEDULER = namespace;

    const body = {
      text: "Legenda",
      image_url: "https://x.test/img.jpg",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "instagram",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    assert.equal(armPayloads.length, 1);
    assert.deepEqual(armPayloads[0].instagram, { igUserId: "acc", accessToken: "tok", apiVersion: "v25.0" });
  });

  it("credenciais ausentes no env → armPayload.instagram OMITIDO (não fica undefined explícito)", async () => {
    const { env } = mkEnv(); // sem INSTAGRAM_*
    const { namespace, armPayloads } = mkCapturingDONamespace();
    (env as Env).LINKEDIN_SCHEDULER = namespace;

    const body = {
      text: "Legenda",
      image_url: "https://x.test/img.jpg",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      channel: "instagram",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    assert.equal(armPayloads.length, 1);
    assert.ok(!("instagram" in armPayloads[0]));
  });
});

// ── #3817 alarm() (Durable Object): mesmo fireQueueEntry compartilhado ─────

describe("#3817 alarm(): dispara Instagram via fireQueueEntry (mesmo caminho do cron)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("alarm() com payload.instagram configurado publica via Graph API e seta fired=true", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      calls.push(u);
      if (u.endsWith("/media_publish")) {
        return new Response(JSON.stringify({ id: "media-1" }), { status: 200 });
      }
      if (u.includes("status_code")) {
        return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
      }
      if (u.endsWith("/media")) {
        return new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const state = new SimpleDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const payload: DoStoredPayload = {
      key: "queue:test:uuid-ig-alarm",
      entry: {
        text: "Legenda",
        image_url: "https://x.test/img.jpg",
        scheduled_at: new Date().toISOString(),
        destaque: "d1",
        created_at: new Date().toISOString(),
        channel: "instagram",
      },
      webhookUrl: "https://make.test/diaria", // sempre presente (mesmo padrão do enqueue), ignorado pro instagram
      instagram: { igUserId: "acc", accessToken: "tok", apiVersion: "v25.0" },
    };
    await state.storage.put("payload", payload);

    try {
      await scheduler.alarm();
      const fired = await state.storage.get<boolean>("fired");
      assert.equal(fired, true);
      assert.ok(calls.some((c) => c.endsWith("/media")));
      assert.ok(calls.some((c) => c.endsWith("/media_publish")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("alarm() com channel=instagram mas SEM payload.instagram: libera claim sem chamar fetch (cron fará DLQ)", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const state = new SimpleDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const payload: DoStoredPayload = {
      key: "queue:test:uuid-ig-nocreds-alarm",
      entry: {
        text: "Legenda",
        image_url: "https://x.test/img.jpg",
        scheduled_at: new Date().toISOString(),
        destaque: "d2",
        created_at: new Date().toISOString(),
        channel: "instagram",
      },
      webhookUrl: "https://make.test/diaria",
      // instagram OMITIDO — simula deploy sem secrets configurados
    };
    await state.storage.put("payload", payload);

    try {
      await scheduler.alarm();
      assert.equal(fetchCalled, false, "não deve tentar Graph API sem credenciais no payload");
      const fired = await state.storage.get<boolean>("fired");
      assert.equal(fired, undefined);
      const claiming = await state.storage.get<boolean>("claiming");
      assert.equal(claiming, undefined, "claim deve ter sido liberado");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("alarm() com entry sem channel (legacy) continua indo pro Make — mesmo comportamento pré-#3817", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      calls.push(u);
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const state = new SimpleDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const payload: DoStoredPayload = {
      key: "queue:test:uuid-legacy-alarm",
      entry: {
        text: "post legacy",
        image_url: null,
        scheduled_at: new Date().toISOString(),
        destaque: "d1",
        created_at: new Date().toISOString(),
        // channel OMITIDO de propósito
      },
      webhookUrl: "https://make.test/diaria",
    };
    await state.storage.put("payload", payload);

    try {
      await scheduler.alarm();
      const fired = await state.storage.get<boolean>("fired");
      assert.equal(fired, true);
      assert.deepEqual(calls, ["https://make.test/diaria"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
