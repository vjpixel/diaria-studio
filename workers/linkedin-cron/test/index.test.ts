/**
 * Tests for `workers/linkedin-cron/src/index.ts` — robustness fixes (#879-#883).
 *
 * Cobertura:
 *   - #879 constantTimeEquals — string equality timing-safe
 *   - #882 payload size validation em /queue (text 10k, url 2k)
 *   - #880 dead-letter após MAX_RETRIES, retry_count crescendo
 *   - #883 handleHealth O(1) — só lê primeira key da lista
 *   - #881 fetch timeout — AbortError tratado como falha (incrementa retry)
 *
 * O worker importa `@cloudflare/workers-types` (KVNamespace, ExecutionContext,
 * ScheduledEvent), não os runtimes — então conseguimos importar e testar
 * direto via Node + tsx desde que mockemos KV. Não rodamos o handler scheduled,
 * só `fireDueItems` direto pra checar a lógica de retry/dlq.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, {
  constantTimeEquals,
  buildQueueKey,
  isLegacyKey,
  MAX_RETRIES,
  MAX_TEXT_LENGTH,
  MAX_URL_LENGTH,
  FETCH_TIMEOUT_MS,
  __test__,
  type Env,
  type QueueEntry,
} from "../src/index.ts";

// ── In-memory KV mock ──────────────────────────────────────────────────────

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
    const names = Array.from(this.store.keys()).filter(k => k.startsWith(prefix));
    names.sort(); // KV semantics: lex-sortable
    return { keys: names.map(name => ({ name })), list_complete: true };
  }
}

function mkEnv(token = "secret-token", webhook = "https://make.test/webhook"): { env: Env; kv: MockKV } {
  const kv = new MockKV();
  const env = {
    LINKEDIN_QUEUE: kv as unknown as KVNamespace,
    DIARIA_TOKEN: token,
    MAKE_WEBHOOK_URL: webhook,
  };
  return { env, kv };
}

function authedRequest(url: string, init?: RequestInit, token = "secret-token"): Request {
  const headers = new Headers(init?.headers);
  headers.set("X-Diaria-Token", token);
  return new Request(url, { ...init, headers });
}

// ── #879 — constantTimeEquals ──────────────────────────────────────────────

describe("#879 constantTimeEquals (timing-safe token compare)", () => {
  it("retorna true para strings idênticas", () => {
    assert.equal(constantTimeEquals("abc123", "abc123"), true);
  });

  it("retorna false para strings de mesmo length, conteúdo diferente", () => {
    assert.equal(constantTimeEquals("abc123", "abc124"), false);
    assert.equal(constantTimeEquals("xxxxxx", "yyyyyy"), false);
  });

  it("retorna false para lengths diferentes (early exit, mas nunca true)", () => {
    assert.equal(constantTimeEquals("abc", "abcd"), false);
    assert.equal(constantTimeEquals("", "x"), false);
  });

  it("retorna true para strings vazias", () => {
    assert.equal(constantTimeEquals("", ""), true);
  });

  it("/list com token errado retorna 401 (smoke test do isAuthorized)", async () => {
    const { env } = mkEnv("real-token");
    const req = authedRequest("https://w.test/list", { method: "GET" }, "wrong-token");
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 401);
  });

  it("/list com token correto retorna 200", async () => {
    const { env } = mkEnv("real-token");
    const req = authedRequest("https://w.test/list", { method: "GET" }, "real-token");
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 200);
  });
});

// ── #882 — payload size validation ─────────────────────────────────────────

describe("#882 /queue payload size validation", () => {
  it("text > MAX_TEXT_LENGTH retorna 400", async () => {
    const { env } = mkEnv();
    const body = {
      text: "x".repeat(MAX_TEXT_LENGTH + 1),
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /text exceeds/);
  });

  it("text exatamente em MAX_TEXT_LENGTH passa (limite inclusivo)", async () => {
    const { env, kv } = mkEnv();
    const body = {
      text: "x".repeat(MAX_TEXT_LENGTH),
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
    assert.equal(kv.store.size, 1);
  });

  it("image_url > MAX_URL_LENGTH retorna 400", async () => {
    const { env } = mkEnv();
    const body = {
      text: "ok",
      image_url: "https://example.com/" + "x".repeat(MAX_URL_LENGTH),
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /image_url exceeds/);
  });

  it("payload válido pequeno retorna 202 e grava no KV", async () => {
    const { env, kv } = mkEnv();
    const body = {
      text: "post curtinho",
      image_url: "https://example.com/img.jpg",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d2",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    assert.equal(kv.store.size, 1);
    // Schema novo: queue:{iso}:{uuid}
    const key = Array.from(kv.store.keys())[0];
    assert.ok(key.startsWith("queue:2026-12-01T12:00:00.000Z:"), `key inesperada: ${key}`);
  });
});

// ── #880 — dead-letter retry ───────────────────────────────────────────────

describe("#880 dead-letter retry após MAX_RETRIES", () => {
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });

  it("falha de webhook incrementa retry_count e re-grava no KV", async () => {
    const { env, kv } = mkEnv();
    // Pré-povoamos KV com 1 item maduro
    const key = buildQueueKey("2020-01-01T00:00:00.000Z", "uuid-1");
    const entry: QueueEntry = {
      text: "t",
      image_url: null,
      scheduled_at: "2020-01-01T00:00:00.000Z", // já passou
      destaque: "d1",
      created_at: "2020-01-01T00:00:00.000Z",
      retry_count: 0,
    };
    kv.store.set(key, JSON.stringify(entry));

    globalThis.fetch = async () => new Response("err", { status: 500 });
    const result = await __test__.fireDueItems(env);
    globalThis.fetch = savedFetch;

    assert.equal(result.fired, 0);
    assert.equal(result.dlq, 0);
    assert.equal(result.errors, 1);
    // Item ainda no KV, com retry_count=1
    const raw = kv.store.get(key);
    assert.ok(raw);
    const updated = JSON.parse(raw as string) as QueueEntry;
    assert.equal(updated.retry_count, 1);
  });

  it(`após ${MAX_RETRIES} falhas, vai pra dlq:`, async () => {
    const { env, kv } = mkEnv();
    const key = buildQueueKey("2020-01-01T00:00:00.000Z", "uuid-2");
    const entry: QueueEntry = {
      text: "t",
      image_url: null,
      scheduled_at: "2020-01-01T00:00:00.000Z",
      destaque: "d2",
      created_at: "2020-01-01T00:00:00.000Z",
      retry_count: 0,
    };
    kv.store.set(key, JSON.stringify(entry));

    globalThis.fetch = async () => new Response("err", { status: 500 });

    // Simula MAX_RETRIES rodadas de fireDueItems
    for (let i = 0; i < MAX_RETRIES; i++) {
      await __test__.fireDueItems(env);
    }
    globalThis.fetch = savedFetch;

    // Item original deletado, agora há 1 entry com prefix dlq:
    assert.equal(kv.store.has(key), false);
    const dlqKeys = Array.from(kv.store.keys()).filter(k => k.startsWith("dlq:"));
    assert.equal(dlqKeys.length, 1);
    const dlqRaw = kv.store.get(dlqKeys[0]);
    assert.ok(dlqRaw);
    const dlqEntry = JSON.parse(dlqRaw as string) as QueueEntry;
    assert.equal(dlqEntry.destaque, "d2");
    assert.equal(dlqEntry.retry_count, MAX_RETRIES);
  });

  it("GET /dlq lista items dead-letter (auth required)", async () => {
    const { env, kv } = mkEnv();
    kv.store.set(
      "dlq:abc",
      JSON.stringify({
        text: "morto",
        image_url: null,
        scheduled_at: "2020-01-01T00:00:00.000Z",
        destaque: "d3",
        created_at: "2020-01-01T00:00:00.000Z",
        retry_count: MAX_RETRIES,
      } satisfies QueueEntry),
    );
    const req = authedRequest("https://w.test/dlq", { method: "GET" });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { count: number; items: (QueueEntry & { key: string })[] };
    assert.equal(data.count, 1);
    assert.equal(data.items[0].destaque, "d3");
  });

  it("GET /dlq sem auth retorna 401", async () => {
    const { env } = mkEnv("right");
    const req = new Request("https://w.test/dlq", { method: "GET" });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 401);
  });

  it("sucesso de webhook deleta o item (não vai pra dlq)", async () => {
    const { env, kv } = mkEnv();
    const key = buildQueueKey("2020-01-01T00:00:00.000Z", "uuid-3");
    kv.store.set(
      key,
      JSON.stringify({
        text: "t",
        image_url: null,
        scheduled_at: "2020-01-01T00:00:00.000Z",
        destaque: "d1",
        created_at: "2020-01-01T00:00:00.000Z",
        retry_count: 0,
      } satisfies QueueEntry),
    );
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    const result = await __test__.fireDueItems(env);
    globalThis.fetch = savedFetch;
    assert.equal(result.fired, 1);
    assert.equal(result.dlq, 0);
    assert.equal(kv.store.size, 0);
  });
});

// ── #883 — handleHealth O(1) ───────────────────────────────────────────────

describe("#883 handleHealth O(1) via lex-sortable keys", () => {
  it("schema novo: lê só 1 KV.get pra extrair next_scheduled (não O(n))", async () => {
    const { env, kv } = mkEnv();
    // Inserir 5 items (lex-sortable por scheduled_at)
    for (let i = 0; i < 5; i++) {
      const iso = `2026-${String(i + 1).padStart(2, "0")}-01T00:00:00.000Z`;
      const key = buildQueueKey(iso, `uuid-${i}`);
      kv.store.set(
        key,
        JSON.stringify({
          text: "t",
          image_url: null,
          scheduled_at: iso,
          destaque: "d1",
          created_at: iso,
        } satisfies QueueEntry),
      );
    }
    // Counter de gets pra confirmar que só fez 1 get (não 5)
    let getCount = 0;
    const realGet = kv.get.bind(kv);
    kv.get = async (k: string) => {
      getCount++;
      return realGet(k);
    };

    const res = await workerDefault.fetch(
      new Request("https://w.test/health", { method: "GET" }),
      env,
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      queue_size: number;
      next_scheduled: { scheduled_at: string } | null;
    };
    assert.equal(data.queue_size, 5);
    assert.equal(data.next_scheduled?.scheduled_at, "2026-01-01T00:00:00.000Z");
    assert.equal(getCount, 1, `esperava 1 KV.get, fez ${getCount}`);
  });

  it("schema legacy (queue:{uuid} sem timestamp): faz 1 get pra ler scheduled_at", async () => {
    const { env, kv } = mkEnv();
    kv.store.set(
      "queue:abc-uuid",
      JSON.stringify({
        text: "t",
        image_url: null,
        scheduled_at: "2027-01-01T00:00:00.000Z",
        destaque: "d2",
        created_at: "2027-01-01T00:00:00.000Z",
      } satisfies QueueEntry),
    );
    let getCount = 0;
    const realGet = kv.get.bind(kv);
    kv.get = async (k: string) => {
      getCount++;
      return realGet(k);
    };
    const res = await workerDefault.fetch(
      new Request("https://w.test/health", { method: "GET" }),
      env,
    );
    const data = (await res.json()) as { next_scheduled: { scheduled_at: string } | null };
    assert.equal(data.next_scheduled?.scheduled_at, "2027-01-01T00:00:00.000Z");
    assert.equal(getCount, 1);
  });

  it("fila vazia: next_scheduled = null, zero gets", async () => {
    const { env, kv } = mkEnv();
    let getCount = 0;
    const realGet = kv.get.bind(kv);
    kv.get = async (k: string) => {
      getCount++;
      return realGet(k);
    };
    const res = await workerDefault.fetch(
      new Request("https://w.test/health", { method: "GET" }),
      env,
    );
    const data = (await res.json()) as { queue_size: number; next_scheduled: unknown };
    assert.equal(data.queue_size, 0);
    assert.equal(data.next_scheduled, null);
    assert.equal(getCount, 0);
  });

  it("isLegacyKey: detecta queue:{uuid} vs queue:{iso}:{uuid}", () => {
    assert.equal(isLegacyKey("queue:abc-123"), true);
    assert.equal(isLegacyKey("queue:2026-01-01T00:00:00.000Z:abc-123"), false);
  });
});

// ── #881 — fetch timeout ───────────────────────────────────────────────────

describe("#881 fetch timeout no webhook Make", () => {
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });

  it("AbortError tratado como falha (incrementa retry_count, não vai pra dlq na 1ª)", async () => {
    const { env, kv } = mkEnv();
    const key = buildQueueKey("2020-01-01T00:00:00.000Z", "timeout-1");
    kv.store.set(
      key,
      JSON.stringify({
        text: "t",
        image_url: null,
        scheduled_at: "2020-01-01T00:00:00.000Z",
        destaque: "d1",
        created_at: "2020-01-01T00:00:00.000Z",
        retry_count: 0,
      } satisfies QueueEntry),
    );

    // Mock fetch que joga AbortError
    globalThis.fetch = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };

    const result = await __test__.fireDueItems(env);
    globalThis.fetch = savedFetch;

    assert.equal(result.fired, 0);
    assert.equal(result.errors, 1);
    assert.equal(result.dlq, 0);
    const raw = kv.store.get(key);
    assert.ok(raw);
    const updated = JSON.parse(raw as string) as QueueEntry;
    assert.equal(updated.retry_count, 1);
  });

  it("TimeoutError (alias do AbortError no AbortSignal.timeout) também tratado", async () => {
    const { env, kv } = mkEnv();
    const key = buildQueueKey("2020-01-01T00:00:00.000Z", "timeout-2");
    kv.store.set(
      key,
      JSON.stringify({
        text: "t",
        image_url: null,
        scheduled_at: "2020-01-01T00:00:00.000Z",
        destaque: "d3",
        created_at: "2020-01-01T00:00:00.000Z",
        retry_count: 2,
      } satisfies QueueEntry),
    );

    globalThis.fetch = async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    };

    const result = await __test__.fireDueItems(env);
    globalThis.fetch = savedFetch;

    assert.equal(result.errors, 1);
    const raw = kv.store.get(key);
    const updated = JSON.parse(raw as string) as QueueEntry;
    assert.equal(updated.retry_count, 3);
  });

  it("FETCH_TIMEOUT_MS é 30s (sanity)", () => {
    assert.equal(FETCH_TIMEOUT_MS, 30_000);
  });
});

// ── Sanity: constantes exportadas ─────────────────────────────────────────

describe("Constantes exportadas", () => {
  it("MAX_RETRIES = 5", () => {
    assert.equal(MAX_RETRIES, 5);
  });
  it("MAX_TEXT_LENGTH = 10000", () => {
    assert.equal(MAX_TEXT_LENGTH, 10_000);
  });
  it("MAX_URL_LENGTH = 2000", () => {
    assert.equal(MAX_URL_LENGTH, 2_000);
  });
});
