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
  buildDlqKey,
  isLegacyKey,
  MAX_RETRIES,
  MAX_TEXT_LENGTH,
  MAX_URL_LENGTH,
  FETCH_TIMEOUT_MS,
  DLQ_TTL_SECONDS,
  CLAIM_TTL_MS,
  LinkedInScheduler,
  __test__,
  type Env,
  type QueueEntry,
  type DoStoredPayload,
} from "../src/index.ts";

// ── In-memory DO storage mock ──────────────────────────────────────────────

/**
 * Mock DurableObjectStorage para testar LinkedInScheduler.
 * Simula get/put/delete/deleteAll/setAlarm/deleteAlarm/blockConcurrencyWhile.
 */
class MockDOStorage {
  store = new Map<string, unknown>();
  alarmMs: number | null = null;

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
    // (#2219 bug 7 fix) CF real NÃO cancela alarm em deleteAll — apenas limpa o
    // storage. O alarm continua agendado e pode disparar após deleteAll.
    // Para cancelar o alarm, o código deve chamar deleteAlarm() explicitamente.
    // O mock anterior zerava alarmMs aqui, tornando o teste de /cancel
    // um falso positivo: passava mesmo sem chamar deleteAlarm().
    this.store.clear();
    // alarmMs NÃO é zerado aqui — use deleteAlarm() pra isso.
  }
  async setAlarm(scheduledMs: number): Promise<void> {
    this.alarmMs = scheduledMs;
  }
  async deleteAlarm(): Promise<void> {
    this.alarmMs = null;
  }
}

class MockDOState {
  storage: MockDOStorage;
  // (#2219 bug 4) Fila serializada para blockConcurrencyWhile.
  // O DO real usa o event loop do isolate para serializar — chamadas ao storage
  // dentro de blockConcurrencyWhile são atômicas contra outras operações concorrentes.
  // O mock anterior era `return fn()` (sem fila), o que permitia interleaving e
  // tornava os testes de claim/idempotência falsos positivos (não provavam serialização).
  private _queue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.storage = new MockDOStorage();
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    // Encadeia na fila existente: garante que fn() só roda quando a op anterior terminar.
    // Nota: capturamos `this._queue` antes do assignment pra que o encadeamento
    // seja correto mesmo quando `blockConcurrencyWhile` é chamado várias vezes
    // "simultaneamente" (cada Promise.then é scheduled, não executado imediatamente).
    const next = this._queue.then(() => fn());
    // Atualiza a fila sem propagar exceções para o próximo item na fila:
    // se fn() lança, o próximo op ainda deve conseguir executar.
    this._queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** Cria um mock DurableObjectNamespace onde cada stub é um LinkedInScheduler com MockDOState. */
function mkMockDONamespace(): {
  namespace: DurableObjectNamespace;
  stubs: Map<string, { scheduler: LinkedInScheduler; state: MockDOState }>;
} {
  const stubs = new Map<string, { scheduler: LinkedInScheduler; state: MockDOState }>();

  function getOrCreate(name: string) {
    if (!stubs.has(name)) {
      const state = new MockDOState();
      const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
      stubs.set(name, { scheduler, state });
    }
    return stubs.get(name)!;
  }

  const namespace = {
    idFromName: (name: string) => ({ toString: () => name, name, equals: () => false }),
    get: (id: { name: string }) => {
      const { scheduler } = getOrCreate(id.name);
      return {
        fetch: async (url: string | Request, init?: RequestInit) => {
          const req = typeof url === "string" ? new Request(url, init) : url;
          return scheduler.fetch(req);
        },
      };
    },
    idFromString: (id: string) => ({ toString: () => id, name: id, equals: () => false }),
    newUniqueId: () => ({ toString: () => "unique", name: "unique", equals: () => false }),
    jurisdiction: () => namespace,
  } as unknown as DurableObjectNamespace;

  return { namespace, stubs };
}

/** Cria env com LINKEDIN_SCHEDULER mock. */
function mkEnvWithDO(token = "secret-token", webhook = "https://make.test/webhook"): {
  env: Env;
  kv: MockKV;
  doNamespace: ReturnType<typeof mkMockDONamespace>;
} {
  const kv = new MockKV();
  const doNamespace = mkMockDONamespace();
  const env: Env = {
    LINKEDIN_QUEUE: kv as unknown as KVNamespace,
    DIARIA_TOKEN: token,
    MAKE_WEBHOOK_URL: webhook,
    LINKEDIN_SCHEDULER: doNamespace.namespace,
  };
  return { env, kv, doNamespace };
}

// ── In-memory KV mock ──────────────────────────────────────────────────────

type KVValue = string;
type PutOptions = { expirationTtl?: number };
class MockKV {
  store = new Map<string, KVValue>();
  // #894 — captura opções passadas em `put` (expirationTtl) por key, pra
  // tests poderem verificar que TTL é aplicado em `dlq:` puts.
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
  it("DLQ_TTL_SECONDS = 30 dias", () => {
    assert.equal(DLQ_TTL_SECONDS, 30 * 24 * 3600);
  });
});

// Cron config: */5. Histórico (#1146 → PR #1167 → revert):
// - #1146 observou lag de 10-15min em 2026-05-12 (Cloudflare cron SLA "~5min")
// - PR #1167 mudou pra */3 como mitigação parcial
// - Decisão 2026-05-12 (revert): voltar pra */5 pra preservar margem KV list
//   (free tier 1k/day; */3 = 480/day = ~50%, */5 = 288/day = ~30%).
// Real fix = #1168 (Durable Object alarms — item-specific, zero polling).
describe("Cron config", () => {
  it("wrangler.toml usa */5 (cron a cada 5min)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const wranglerPath = resolve(here, "../wrangler.toml");
    const toml = readFileSync(wranglerPath, "utf8");
    assert.match(
      toml,
      /crons\s*=\s*\[\s*"\*\/5 \* \* \* \*"\s*\]/,
      `wrangler.toml deve ter cron "*/5 * * * *"`,
    );
  });
});

// ── #894 P1-A — DLQ atomic move + #894 P1-B — DLQ TTL ─────────────────────

describe("#894 P1-A DLQ move usa expirationTtl + reusa UUID", () => {
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });

  it("dlq put recebe expirationTtl = DLQ_TTL_SECONDS (30 dias)", async () => {
    const { env, kv } = mkEnv();
    const key = buildQueueKey("2020-01-01T00:00:00.000Z", "uuid-ttl-1");
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

    globalThis.fetch = async () => new Response("err", { status: 500 });
    for (let i = 0; i < MAX_RETRIES; i++) {
      await __test__.fireDueItems(env);
    }
    globalThis.fetch = savedFetch;

    const dlqKeys = Array.from(kv.store.keys()).filter(k => k.startsWith("dlq:"));
    assert.equal(dlqKeys.length, 1);
    const opts = kv.putOptions.get(dlqKeys[0]);
    assert.ok(opts, `esperava putOptions pra ${dlqKeys[0]}`);
    assert.equal(opts.expirationTtl, DLQ_TTL_SECONDS);
  });

  it("dlq key reusa UUID original (rastreabilidade queue ↔ dlq)", async () => {
    const { env, kv } = mkEnv();
    const originalUuid = "deadbeef-1234-5678-9abc-def012345678";
    const key = buildQueueKey("2020-01-01T00:00:00.000Z", originalUuid);
    kv.store.set(
      key,
      JSON.stringify({
        text: "t",
        image_url: null,
        scheduled_at: "2020-01-01T00:00:00.000Z",
        destaque: "d2",
        created_at: "2020-01-01T00:00:00.000Z",
        retry_count: 0,
      } satisfies QueueEntry),
    );

    globalThis.fetch = async () => new Response("err", { status: 500 });
    for (let i = 0; i < MAX_RETRIES; i++) {
      await __test__.fireDueItems(env);
    }
    globalThis.fetch = savedFetch;

    const dlqKeys = Array.from(kv.store.keys()).filter(k => k.startsWith("dlq:"));
    assert.equal(dlqKeys.length, 1);
    // dlq:<iso>:<uuid> — uuid deve ser o original
    assert.ok(
      dlqKeys[0].endsWith(`:${originalUuid}`),
      `dlq key ${dlqKeys[0]} não termina com uuid original ${originalUuid}`,
    );
  });

  it("buildDlqKey: schema novo preserva iso + uuid", () => {
    const dlqKey = buildDlqKey(
      "queue:2026-01-01T00:00:00.000Z:abc-uuid",
      "2026-01-01T00:00:00.000Z",
    );
    assert.equal(dlqKey, "dlq:2026-01-01T00:00:00.000Z:abc-uuid");
  });

  it("buildDlqKey: schema legacy usa scheduled_at + uuid legacy", () => {
    const dlqKey = buildDlqKey("queue:legacy-uuid-only", "2026-05-01T12:00:00.000Z");
    assert.equal(dlqKey, "dlq:2026-05-01T12:00:00.000Z:legacy-uuid-only");
  });
});

// ── #894 P2-A — isLegacyKey via regex robusta ─────────────────────────────

describe("#894 P2-A isLegacyKey regex", () => {
  it("schema novo (queue:<iso>:<uuid>) retorna false", () => {
    assert.equal(
      isLegacyKey("queue:2026-01-01T00:00:00.000Z:abc-123-def"),
      false,
    );
    assert.equal(
      isLegacyKey("queue:2026-12-31T23:59:59Z:deadbeef-0000-0000-0000-000000000000"),
      false,
    );
  });

  it("schema legacy (queue:<uuid> sem timestamp) retorna true", () => {
    assert.equal(isLegacyKey("queue:abc-uuid-only"), true);
    assert.equal(isLegacyKey("queue:deadbeef-1234-5678-9abc-def012345678"), true);
  });

  it("malformed: queue: vazio retorna true (não bate regex novo)", () => {
    assert.equal(isLegacyKey("queue:"), true);
  });

  it("malformed: queue: com chars não-hex no uuid retorna true (não bate regex novo)", () => {
    // Regex exige [\da-fA-F-] no UUID — strings com `g` ou outros chars não batem
    assert.equal(isLegacyKey("queue:2026-01-01T00:00:00.000Z:not-a-uuid-zzz"), true);
  });

  it("non-queue prefix retorna false (sem startsWith queue:)", () => {
    assert.equal(isLegacyKey("dlq:abc"), false);
    assert.equal(isLegacyKey("random-key"), false);
  });
});

// ── #894 P2-B — DELETE /dlq/:key endpoint ─────────────────────────────────

describe("#894 P2-B DELETE /dlq/:key endpoint", () => {
  it("auth required: sem token retorna 401", async () => {
    const { env, kv } = mkEnv("real-token");
    kv.store.set(
      "dlq:2020-01-01T00:00:00.000Z:abc",
      JSON.stringify({
        text: "t",
        image_url: null,
        scheduled_at: "2020-01-01T00:00:00.000Z",
        destaque: "d1",
        created_at: "2020-01-01T00:00:00.000Z",
        retry_count: MAX_RETRIES,
      } satisfies QueueEntry),
    );
    const req = new Request("https://w.test/dlq/dlq:2020-01-01T00:00:00.000Z:abc", {
      method: "DELETE",
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 401);
    // Item ainda existe
    assert.ok(kv.store.has("dlq:2020-01-01T00:00:00.000Z:abc"));
  });

  it("auth required: token errado retorna 401", async () => {
    const { env } = mkEnv("real-token");
    const req = authedRequest(
      "https://w.test/dlq/dlq:abc",
      { method: "DELETE" },
      "wrong-token",
    );
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 401);
  });

  it("auth ok: deleta key correta e retorna 200", async () => {
    const { env, kv } = mkEnv();
    const key = "dlq:2020-01-01T00:00:00.000Z:to-delete";
    kv.store.set(
      key,
      JSON.stringify({
        text: "t",
        image_url: null,
        scheduled_at: "2020-01-01T00:00:00.000Z",
        destaque: "d3",
        created_at: "2020-01-01T00:00:00.000Z",
        retry_count: MAX_RETRIES,
      } satisfies QueueEntry),
    );
    // Adicionar mais 1 entry pra confirmar que só a key alvo foi deletada
    const otherKey = "dlq:2020-02-02T00:00:00.000Z:keep-me";
    kv.store.set(otherKey, JSON.stringify({ text: "k" }));

    const req = authedRequest(`https://w.test/dlq/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { deleted: boolean; key: string };
    assert.equal(data.deleted, true);
    assert.equal(data.key, key);
    // Key alvo removida; outra continua
    assert.equal(kv.store.has(key), false);
    assert.equal(kv.store.has(otherKey), true);
  });

  it("404 se key não existe", async () => {
    const { env } = mkEnv();
    const req = authedRequest(
      "https://w.test/dlq/dlq:does-not-exist",
      { method: "DELETE" },
    );
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 404);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /not found/);
  });

  it("400 se key não começa com 'dlq:' (proteção contra DELETE em queue:)", async () => {
    const { env, kv } = mkEnv();
    // Pré-povoa um queue: pra confirmar que não é deletado
    const queueKey = buildQueueKey("2020-01-01T00:00:00.000Z", "protected");
    kv.store.set(queueKey, JSON.stringify({ text: "t" }));

    const req = authedRequest(
      `https://w.test/dlq/${encodeURIComponent(queueKey)}`,
      { method: "DELETE" },
    );
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    // queue: entry intacta
    assert.ok(kv.store.has(queueKey));
  });
});

// ── #919 — verify-after-put em handleEnqueue ───────────────────────────────

describe("#919 handleEnqueue verify-after-put (silent fail prevention)", () => {
  it("retorna 500 quando KV.put 'succeeds' mas read-back retorna null", async () => {
    const { env, kv } = mkEnv();
    // Mock: put faz nada mas reporta sucesso, get retorna null
    kv.put = async (_key: string, _value: string) => {
      // Simula put bem-sucedido sem persistir
    };
    kv.get = async (_key: string) => null;

    const body = {
      text: "post",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 500);
    const data = (await res.json()) as { error: string; message: string };
    assert.equal(data.error, "kv_put_verify_failed");
    assert.match(data.message, /silent fail/);
  });

  it("retorna 202 quando KV.put + read-back funcionam (caminho feliz)", async () => {
    const { env, kv } = mkEnv();
    const body = {
      text: "post",
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
    const data = (await res.json()) as { queued: boolean; key: string };
    assert.equal(data.queued, true);
    assert.ok(data.key.startsWith("queue:"));
    assert.equal(kv.store.size, 1);
  });

  it("verify-after-put: put real + get real (smoke do mock)", async () => {
    // Confirma que mock KV é consistente: o que put grava, get retorna.
    const { env, kv } = mkEnv();
    const body = {
      text: "consistency",
      scheduled_at: "2027-01-01T00:00:00Z",
      destaque: "d3",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);
    // Confirma que a entry foi efetivamente armazenada
    const data = (await res.json()) as { key: string };
    const stored = kv.store.get(data.key);
    assert.ok(stored, "entry deveria estar no KV após 202");
    const parsed = JSON.parse(stored as string) as QueueEntry;
    assert.equal(parsed.text, "consistency");
    assert.equal(parsed.destaque, "d3");
  });
});

// ── #595 — webhook_target + action routing pra comments ────────────────────

describe("#595 enqueue: validação de webhook_target/action/parent_destaque", () => {
  it("aceita webhook_target=diaria + action=post (caso default)", async () => {
    const { env, kv } = mkEnv();
    const body = {
      text: "main post",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      webhook_target: "diaria",
      action: "post",
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
    assert.equal(parsed.webhook_target, "diaria");
    assert.equal(parsed.action, "post");
  });

  it("aceita webhook_target=pixel + action=comment + parent_destaque", async () => {
    const { env, kv } = mkEnv();
    const body = {
      text: "Pixel comment",
      scheduled_at: "2026-12-01T12:08:00Z",
      destaque: "d1",
      webhook_target: "pixel",
      action: "comment",
      parent_destaque: "d1",
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
    assert.equal(parsed.webhook_target, "pixel");
    assert.equal(parsed.action, "comment");
    assert.equal(parsed.parent_destaque, "d1");
  });

  it("rejeita webhook_target=pixel + action=post (combinação inválida)", async () => {
    const { env } = mkEnv();
    const body = {
      text: "x",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      webhook_target: "pixel",
      action: "post",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /pixel.*comment/);
  });

  it("rejeita webhook_target inválido", async () => {
    const { env } = mkEnv();
    const body = {
      text: "x",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      webhook_target: "bogus",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /webhook_target/);
  });

  it("rejeita parent_destaque inválido (não d1/d2/d3)", async () => {
    const { env } = mkEnv();
    const body = {
      text: "x",
      scheduled_at: "2026-12-01T12:00:00Z",
      destaque: "d1",
      action: "comment",
      parent_destaque: "d99",
    };
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    const data = (await res.json()) as { error: string };
    assert.match(data.error, /parent_destaque/);
  });

  it("backward-compat: entry sem webhook_target/action funciona como antes", async () => {
    const { env, kv } = mkEnv();
    const body = {
      text: "legacy",
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
    const data = (await res.json()) as { key: string };
    const parsed = JSON.parse(kv.store.get(data.key) as string) as QueueEntry;
    assert.equal(parsed.webhook_target, undefined);
    assert.equal(parsed.action, undefined);
  });
});

describe("#595 fireDueItems: routing por webhook_target", () => {
  // Mock fetch global pra capturar URL alvo + payload
  let fetchCalls: Array<{ url: string; body: unknown }>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.url;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      fetchCalls.push({ url: u, body });
      return new Response("", { status: 200 });
    }) as typeof fetch;
  });

  function restore() { globalThis.fetch = originalFetch; }

  it("entry sem webhook_target → MAKE_WEBHOOK_URL (backward-compat)", async () => {
    const { env, kv } = mkEnv("tok", "https://make.test/diaria");
    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "legacy", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
    };
    kv.store.set(buildQueueKey(past, "uuid-leg"), JSON.stringify(entry));
    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, "https://make.test/diaria");
      const fb = fetchCalls[0].body as { action?: string; destaque: string };
      assert.equal(fb.action, "post"); // default forward
      assert.equal(fb.destaque, "d1");
    } finally { restore(); }
  });

  it("webhook_target=pixel → MAKE_PIXEL_WEBHOOK_URL", async () => {
    const { env, kv } = mkEnv("tok", "https://make.test/diaria");
    (env as Env).MAKE_PIXEL_WEBHOOK_URL = "https://make.test/pixel";
    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "Pixel comment", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
      webhook_target: "pixel", action: "comment", parent_destaque: "d1",
    };
    kv.store.set(buildQueueKey(past, "uuid-pix"), JSON.stringify(entry));
    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, "https://make.test/pixel");
      const fb = fetchCalls[0].body as { action: string; parent_destaque: string };
      assert.equal(fb.action, "comment");
      assert.equal(fb.parent_destaque, "d1");
    } finally { restore(); }
  });

  it("webhook_target=pixel sem MAKE_PIXEL_WEBHOOK_URL configurado → DLQ direto", async () => {
    const { env, kv } = mkEnv("tok", "https://make.test/diaria");
    // MAKE_PIXEL_WEBHOOK_URL ausente intencionalmente
    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-pix-noenv");
    const entry: QueueEntry = {
      text: "Pixel comment", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
      webhook_target: "pixel", action: "comment",
    };
    kv.store.set(queueKey, JSON.stringify(entry));
    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.dlq, 1);
      assert.equal(fetchCalls.length, 0); // não tentou nenhum webhook
      // Entry movida pra dlq:
      const dlqKeys = Array.from(kv.store.keys()).filter(k => k.startsWith("dlq:"));
      assert.equal(dlqKeys.length, 1);
      // Original removida
      assert.equal(kv.store.has(queueKey), false);
    } finally { restore(); }
  });

  it("webhook_target=diaria + action=comment → MAKE_WEBHOOK_URL com action=comment", async () => {
    const { env, kv } = mkEnv("tok", "https://make.test/diaria");
    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "Diar.ia comment", image_url: null, scheduled_at: past,
      destaque: "d2", created_at: past, retry_count: 0,
      webhook_target: "diaria", action: "comment", parent_destaque: "d2",
    };
    kv.store.set(buildQueueKey(past, "uuid-com"), JSON.stringify(entry));
    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      assert.equal(fetchCalls[0].url, "https://make.test/diaria");
      const fb = fetchCalls[0].body as { action: string };
      assert.equal(fb.action, "comment");
    } finally { restore(); }
  });
});

// ── #1058 — DELETE /queue/:key endpoint ────────────────────────────────────

describe("#1058 DELETE /queue/:key endpoint (cleanup pós-/diaria-test)", () => {
  it("auth required: sem token retorna 401", async () => {
    const { env, kv } = mkEnv("real-token");
    const key = "queue:2026-05-20T12:00:00.000Z:test-uuid";
    kv.store.set(key, JSON.stringify({
      text: "test", image_url: null, scheduled_at: "2026-05-20T12:00:00.000Z",
      destaque: "d1", created_at: "2026-05-10T00:00:00.000Z",
    } satisfies QueueEntry));
    const req = new Request(`https://w.test/queue/${encodeURIComponent(key)}`, { method: "DELETE" });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 401);
    assert.ok(kv.store.has(key), "entry must remain when unauthorized");
  });

  it("auth ok: deleta key e retorna 200", async () => {
    const { env, kv } = mkEnv();
    const key = "queue:2026-05-20T12:00:00.000Z:to-delete";
    kv.store.set(key, JSON.stringify({
      text: "test", image_url: null, scheduled_at: "2026-05-20T12:00:00.000Z",
      destaque: "d2", created_at: "2026-05-10T00:00:00.000Z",
    } satisfies QueueEntry));
    const otherKey = "queue:2026-05-20T15:00:00.000Z:keep-me";
    kv.store.set(otherKey, JSON.stringify({ text: "keep" }));
    const req = authedRequest(`https://w.test/queue/${encodeURIComponent(key)}`, { method: "DELETE" });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { deleted: boolean; key: string };
    assert.equal(data.deleted, true);
    assert.equal(data.key, key);
    assert.equal(kv.store.has(key), false, "deleted key must be gone");
    assert.ok(kv.store.has(otherKey), "other keys must remain");
  });

  it("404 se key não existe", async () => {
    const { env } = mkEnv();
    const req = authedRequest(
      `https://w.test/queue/${encodeURIComponent("queue:does-not-exist:uuid")}`,
      { method: "DELETE" },
    );
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 404);
  });

  it("400 se key não começa com 'queue:' (proteção contra DELETE em dlq:)", async () => {
    const { env } = mkEnv();
    const req = authedRequest(
      `https://w.test/queue/${encodeURIComponent("dlq:wrong-prefix")}`,
      { method: "DELETE" },
    );
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
  });
});

// ── #1168 — LinkedInScheduler Durable Object ───────────────────────────────

describe("#1168 LinkedInScheduler DO: /arm cria alarm no scheduledAtMs", () => {
  it("POST /arm persiste payload e agenda alarm", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const futureMs = Date.now() + 60_000;
    const entry: QueueEntry = {
      text: "test post",
      image_url: null,
      scheduled_at: new Date(futureMs).toISOString(),
      destaque: "d1",
      created_at: new Date().toISOString(),
      retry_count: 0,
    };
    const payload: DoStoredPayload & { scheduledAtMs: number } = {
      scheduledAtMs: futureMs,
      key: "queue:2026-12-01T17:00:00.000Z:test-uuid",
      entry,
      webhookUrl: "https://make.test/webhook",
    };

    const req = new Request("https://do/arm", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });
    const res = await scheduler.fetch(req);
    assert.equal(res.status, 200);

    const data = await res.json() as { armed: boolean; scheduledAtMs: number };
    assert.equal(data.armed, true);
    assert.equal(data.scheduledAtMs, futureMs);

    // Verifica que o alarm foi agendado e o payload persistido
    assert.equal(state.storage.alarmMs, futureMs, "alarm deve estar no scheduledAtMs");
    const stored = await state.storage.get<DoStoredPayload>("payload");
    assert.ok(stored, "payload deve estar em storage");
    assert.equal(stored.key, payload.key);
    assert.equal(stored.entry.text, "test post");
    assert.equal(stored.webhookUrl, "https://make.test/webhook");
  });

  it("POST /cancel limpa storage e cancela alarm", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    // Arm first
    state.storage.alarmMs = Date.now() + 60_000;
    state.storage.store.set("payload", { key: "k", entry: {}, webhookUrl: "x" });

    const req = new Request("https://do/cancel", { method: "POST" });
    const res = await scheduler.fetch(req);
    assert.equal(res.status, 200);
    assert.equal(state.storage.alarmMs, null, "alarm deve estar cancelado");
    assert.equal(state.storage.store.size, 0, "storage deve estar vazio");
  });

  it("GET /status retorna fired=false antes de alarm()", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const req = new Request("https://do/status", { method: "GET" });
    const res = await scheduler.fetch(req);
    assert.equal(res.status, 200);
    const data = await res.json() as { fired: boolean };
    assert.equal(data.fired, false);
  });

  it("GET /status retorna fired=true após alarm() bem-sucedido", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "test", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
    };
    // Pré-popula storage como se /arm tivesse sido chamado
    await state.storage.put("payload", {
      key: "queue:past-key",
      entry,
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    // Mock fetch pra simular sucesso
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      await scheduler.alarm();
    } finally {
      globalThis.fetch = savedFetch;
    }

    const req = new Request("https://do/status", { method: "GET" });
    const res = await scheduler.fetch(req);
    const data = await res.json() as { fired: boolean };
    assert.equal(data.fired, true, "fired deve ser true após alarm() bem-sucedido");
  });
});

describe("#1168 LinkedInScheduler DO: alarm() dispara webhook e é idempotente", () => {
  it("alarm() dispara webhook Make com payload correto", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "LinkedIn post",
      image_url: "https://img.example.com/x.jpg",
      scheduled_at: past,
      destaque: "d2",
      created_at: past,
      retry_count: 0,
      webhook_target: "diaria",
      action: "post",
    };
    await state.storage.put("payload", {
      key: "queue:2026-12-01T17:00:00.000Z:uuid-alarm",
      entry,
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    let capturedBody: unknown;
    let capturedUrl: string = "";
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.url;
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      await scheduler.alarm();
    } finally {
      globalThis.fetch = savedFetch;
    }

    assert.equal(capturedUrl, "https://make.test/webhook");
    const body = capturedBody as Record<string, unknown>;
    assert.equal(body.text, "LinkedIn post");
    assert.equal(body.destaque, "d2");
    assert.equal(body.action, "post");
    assert.equal(body.image_url, "https://img.example.com/x.jpg");
  });

  it("alarm() idempotência: 2ª invocação com fired=true não re-dispara webhook", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "post", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
    };
    await state.storage.put("payload", {
      key: "queue:test-key",
      entry,
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);
    // Pré-seta fired=true (simula que o alarm já rodou 1x)
    await state.storage.put("fired", true);

    let fetchCalls = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      await scheduler.alarm();
    } finally {
      globalThis.fetch = savedFetch;
    }

    assert.equal(fetchCalls, 0, "não deve disparar webhook quando fired=true (idempotência)");
  });

  it("alarm() sem payload em storage: não lança exception", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    // Nenhum payload em storage
    await assert.doesNotReject(() => scheduler.alarm());
  });

  it("alarm() com webhook_target=pixel usa pixelWebhookUrl", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "Pixel comment", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
      webhook_target: "pixel", action: "comment", parent_destaque: "d1",
    };
    await state.storage.put("payload", {
      key: "queue:test-pixel",
      entry,
      webhookUrl: "https://make.test/diaria",
      pixelWebhookUrl: "https://make.test/pixel",
    } satisfies DoStoredPayload);

    let capturedUrl = "";
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | Request) => {
      capturedUrl = typeof url === "string" ? url : url.url;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      await scheduler.alarm();
    } finally {
      globalThis.fetch = savedFetch;
    }

    assert.equal(capturedUrl, "https://make.test/pixel", "deve usar pixelWebhookUrl pra target=pixel");
  });

  it("alarm() falha de webhook: libera fired flag, cron pode tentar novamente", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "post", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
    };
    await state.storage.put("payload", {
      key: "queue:test-fail",
      entry,
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("err", { status: 500 });

    try {
      await scheduler.alarm();
    } finally {
      globalThis.fetch = savedFetch;
    }

    const fired = await state.storage.get<boolean>("fired");
    assert.equal(fired, undefined, "fired deve ser undefined (liberado) após falha do webhook");
  });
});

describe("#1168 handleEnqueue: arma DO alarm após KV put", () => {
  it("enqueue com DO disponível: arm é chamado e alarm_armed=true na resposta", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO();
    const future = new Date(Date.now() + 3600_000).toISOString();

    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify({ text: "post", scheduled_at: future, destaque: "d1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 202);

    const data = await res.json() as { queued: boolean; key: string; alarm_armed: boolean };
    assert.equal(data.queued, true);
    assert.equal(data.alarm_armed, true, "alarm_armed deve ser true quando DO está disponível");
    assert.equal(kv.store.size, 1);

    // Verificar que o DO stub foi chamado e tem o alarm agendado
    const doKey = data.key;
    const doEntry = doNamespace.stubs.get(doKey);
    assert.ok(doEntry, `DO stub deve existir para key=${doKey}`);
    assert.ok(doEntry.state.storage.alarmMs !== null, "alarm deve estar agendado no DO");
    // alarm deve estar no futuro (dentro de 1 hora + margem)
    assert.ok(
      doEntry.state.storage.alarmMs! > Date.now(),
      "alarm deve estar no futuro",
    );
  });

  it("enqueue sem DO disponível (binding ausente): retorna 202 com alarm_armed=false", async () => {
    // Simula env sem LINKEDIN_SCHEDULER (binding ausente pré-deploy)
    const kv = new MockKV();
    const env: Env = {
      LINKEDIN_QUEUE: kv as unknown as KVNamespace,
      DIARIA_TOKEN: "secret-token",
      MAKE_WEBHOOK_URL: "https://make.test/webhook",
      // LINKEDIN_SCHEDULER ausente — TS permitido via cast
      LINKEDIN_SCHEDULER: null as unknown as DurableObjectNamespace,
    };

    const future = new Date(Date.now() + 3600_000).toISOString();
    const req = authedRequest("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify({ text: "post", scheduled_at: future, destaque: "d2" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await workerDefault.fetch(req, env);
    // Deve ainda retornar 202 — DO failure é non-fatal
    assert.equal(res.status, 202);
    const data = await res.json() as { queued: boolean; alarm_armed: boolean };
    assert.equal(data.queued, true);
    assert.equal(data.alarm_armed, false, "alarm_armed=false quando DO não disponível");
    assert.equal(kv.store.size, 1, "item deve estar no KV mesmo sem DO");
  });
});

describe("#1168 fireDueItems: idempotência com DO alarm (não re-dispara se fired)", () => {
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => { savedFetch = globalThis.fetch; });

  it("item com DO fired=true: cron deleta KV sem re-disparar webhook", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO();

    // Pré-popula KV com item maduro
    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-do-fired");
    const entry: QueueEntry = {
      text: "t", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    // Simula DO que já disparou: seta fired=true no storage do DO stub
    const doStub = doNamespace.stubs.get(queueKey) ?? (() => {
      const state = new MockDOState();
      const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
      doNamespace.stubs.set(queueKey, { scheduler, state });
      return { scheduler, state };
    })();
    await doStub.state.storage.put("fired", true);

    // Adiciona o stub ao namespace mock — necessário pro fireDueItems consultar
    // O mkMockDONamespace.get() já usa getOrCreate(name) onde name = id.name
    // Para este teste, precisamos que o DO namespace retorne o stub correto.
    // Visto que o namespace mock usa Map, pré-registramos o stub acima.
    doNamespace.stubs.set(queueKey, doStub);

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(fetchCalls, 0, "webhook não deve ser chamado pois DO já disparou");
      assert.equal(result.fired, 1, "fired++ mesmo quando é cleanup de DO");
      assert.equal(kv.store.has(queueKey), false, "KV entry deve ser deletada pelo cron cleanup");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("item com DO fired=false: cron dispara webhook normalmente (fallback)", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO();

    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-do-not-fired");
    const entry: QueueEntry = {
      text: "t", image_url: null, scheduled_at: past,
      destaque: "d2", created_at: past, retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    // DO existe mas fired=false (não disparou ainda)
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    doNamespace.stubs.set(queueKey, { scheduler, state });
    // fired=false (default — não precisa setar)

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(fetchCalls, 1, "webhook deve ser chamado pelo cron fallback");
      assert.equal(result.fired, 1);
      assert.equal(kv.store.has(queueKey), false, "KV entry deletada após fire");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe("#1168 POST /rearm: re-arma DO alarms pra items KV legacy", () => {
  it("arma DO pra item futuro existente no KV", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO();

    const future = new Date(Date.now() + 3600_000).toISOString();
    const queueKey = buildQueueKey(future, "uuid-legacy");
    const entry: QueueEntry = {
      text: "t", image_url: null, scheduled_at: future,
      destaque: "d1", created_at: new Date().toISOString(), retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    const req = authedRequest("https://w.test/rearm", { method: "POST" });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 200);

    const data = await res.json() as { rearmed: number; skipped_past: number; failed: number };
    assert.equal(data.rearmed, 1);
    assert.equal(data.skipped_past, 0);
    assert.equal(data.failed, 0);

    // DO deve ter alarm agendado
    const doEntry = doNamespace.stubs.get(queueKey);
    assert.ok(doEntry, "DO stub deve existir para o item re-armado");
    assert.ok(doEntry.state.storage.alarmMs !== null, "alarm deve estar agendado");
    assert.ok(doEntry.state.storage.alarmMs! > Date.now(), "alarm deve estar no futuro");
  });

  it("pula item já vencido (passado) — deixa pro cron fallback", async () => {
    const { env, kv } = mkEnvWithDO();

    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-past");
    const entry: QueueEntry = {
      text: "t", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    const req = authedRequest("https://w.test/rearm", { method: "POST" });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 200);

    const data = await res.json() as { rearmed: number; skipped_past: number };
    assert.equal(data.rearmed, 0);
    assert.equal(data.skipped_past, 1, "item passado deve ser skipped_past");
  });

  it("requer auth: sem token retorna 401", async () => {
    const { env } = mkEnvWithDO("real-token");
    const req = new Request("https://w.test/rearm", { method: "POST" });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 401);
  });

  it("idempotente: re-arm de item já armado sobrescreve alarm (sem erro)", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO();

    const future = new Date(Date.now() + 3600_000).toISOString();
    const queueKey = buildQueueKey(future, "uuid-rearm-twice");
    const entry: QueueEntry = {
      text: "t", image_url: null, scheduled_at: future,
      destaque: "d2", created_at: new Date().toISOString(), retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    const req1 = authedRequest("https://w.test/rearm", { method: "POST" });
    const req2 = authedRequest("https://w.test/rearm", { method: "POST" });

    const res1 = await workerDefault.fetch(req1, env);
    const res2 = await workerDefault.fetch(req2, env);

    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);

    const data1 = await res1.json() as { rearmed: number };
    const data2 = await res2.json() as { rearmed: number };
    assert.equal(data1.rearmed, 1);
    assert.equal(data2.rearmed, 1, "re-arm idempotente — conta como rearmed mesmo na 2ª chamada");

    // DO stub deve ter alarm (setAlarm foi chamado 2x — ok, sobrescreve)
    const doEntry = doNamespace.stubs.get(queueKey);
    assert.ok(doEntry?.state.storage.alarmMs !== null, "alarm deve estar agendado após 2 rearms");
  });
});

describe("#1168 compat: item KV legacy ainda processado pelo cron fallback", () => {
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => { savedFetch = globalThis.fetch; });

  it("item KV sem DO alarm: cron dispara normalmente (idempotência não bloqueia)", async () => {
    // Simula env sem LINKEDIN_SCHEDULER (ou DO que não encontra o item)
    const kv = new MockKV();
    // Usa DO namespace que sempre retorna status.fired=false (DO vazio pra chave nova)
    const doNamespace = mkMockDONamespace();
    const env: Env = {
      LINKEDIN_QUEUE: kv as unknown as KVNamespace,
      DIARIA_TOKEN: "secret-token",
      MAKE_WEBHOOK_URL: "https://make.test/webhook",
      LINKEDIN_SCHEDULER: doNamespace.namespace,
    };

    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-legacy-cron");
    const entry: QueueEntry = {
      text: "legacy", image_url: null, scheduled_at: past,
      destaque: "d3", created_at: past, retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1, "cron deve disparar item legacy KV");
      assert.equal(kv.store.has(queueKey), false, "KV entry deletada após fire");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── #2219 — Bug 1: DELETE /queue cancela alarm do DO ─────────────────────────

describe("#2219 Bug 1: DELETE /queue/:key cancela alarm do DO", () => {
  it("DELETE cancela o alarm do DO (prevents cancelled-item-posts)", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO();

    // Arm DO alarm pra simular item enfileirado normalmente
    const future = new Date(Date.now() + 3600_000).toISOString();
    const queueKey = buildQueueKey(future, "uuid-cancel-test");
    const entry: QueueEntry = {
      text: "post que deve ser cancelado",
      image_url: null,
      scheduled_at: future,
      destaque: "d1",
      created_at: new Date().toISOString(),
      retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    // Simula DO com alarm armado
    const doState = new MockDOState();
    const doScheduler = new LinkedInScheduler(doState as unknown as DurableObjectState);
    doNamespace.stubs.set(queueKey, { scheduler: doScheduler, state: doState });
    doState.storage.alarmMs = Date.now() + 3600_000;
    await doState.storage.put("payload", {
      key: queueKey,
      entry,
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    // Verifica que alarm está armado antes do DELETE
    assert.ok(doState.storage.alarmMs !== null, "alarm deve estar armado antes do DELETE");
    assert.ok(doState.storage.store.has("payload"), "payload deve existir antes do DELETE");

    // Executar DELETE /queue/:key
    const req = authedRequest(
      `https://w.test/queue/${encodeURIComponent(queueKey)}`,
      { method: "DELETE" },
    );
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 200);

    const data = await res.json() as { deleted: boolean; key: string; do_alarm_cancelled: boolean };
    assert.equal(data.deleted, true, "KV entry deve ser deletada");
    assert.equal(data.key, queueKey);
    assert.equal(data.do_alarm_cancelled, true, "DO alarm deve ser cancelado");

    // Verificar que KV foi deletada
    assert.equal(kv.store.has(queueKey), false, "entry não deve estar no KV após DELETE");

    // Verificar que o alarm foi cancelado no DO (alarmMs = null e storage vazio)
    assert.equal(doState.storage.alarmMs, null, "DO alarm deve estar cancelado (alarmMs=null)");
    assert.equal(doState.storage.store.size, 0, "DO storage deve estar vazio após cancel");
  });

  it("DELETE sem DO disponível: deleta KV mesmo assim (non-fatal DO failure)", async () => {
    // Env com LINKEDIN_SCHEDULER que lança exception (simulate binding ausente)
    const kv = new MockKV();
    const env: Env = {
      LINKEDIN_QUEUE: kv as unknown as KVNamespace,
      DIARIA_TOKEN: "secret-token",
      MAKE_WEBHOOK_URL: "https://make.test/webhook",
      LINKEDIN_SCHEDULER: {
        idFromName: () => { throw new Error("binding unavailable"); },
        get: () => { throw new Error("binding unavailable"); },
        idFromString: () => { throw new Error("binding unavailable"); },
        newUniqueId: () => { throw new Error("binding unavailable"); },
        jurisdiction: () => { throw new Error("binding unavailable"); },
      } as unknown as DurableObjectNamespace,
    };

    const queueKey = "queue:2026-12-01T17:00:00.000Z:uuid-no-do";
    kv.store.set(queueKey, JSON.stringify({
      text: "t", image_url: null, scheduled_at: "2026-12-01T17:00:00.000Z",
      destaque: "d1", created_at: new Date().toISOString(),
    } satisfies QueueEntry));

    const req = authedRequest(
      `https://w.test/queue/${encodeURIComponent(queueKey)}`,
      { method: "DELETE" },
    );
    const res = await workerDefault.fetch(req, env);
    // Deve retornar 200 mesmo com DO indisponível (non-fatal)
    assert.equal(res.status, 200);
    const data = await res.json() as { deleted: boolean; do_alarm_cancelled: boolean };
    assert.equal(data.deleted, true, "KV entry deve ser deletada mesmo sem DO");
    assert.equal(data.do_alarm_cancelled, false, "do_alarm_cancelled=false quando DO indisponível");
    assert.equal(kv.store.has(queueKey), false, "KV entry removida");
  });
});

// ── #2219 — Bug 2: Claim atômico (cron↔alarm exactly-once) ──────────────────

describe("#2219 Bug 2: claim atômico — exatamente 1 post quando cron+alarm concorrem", () => {
  it("POST /claim: 1º caller ganha (claimed=true), 2º caller perde (claimed=false)", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    // Primeiro claim
    const res1 = await scheduler.fetch(new Request("https://do/claim", { method: "POST" }));
    assert.equal(res1.status, 200);
    const data1 = await res1.json() as { claimed: boolean };
    assert.equal(data1.claimed, true, "1º caller deve ganhar o claim");
    assert.equal(state.storage.store.get("claiming"), true, "claiming=true após 1º claim");

    // Segundo claim (simula cron ou alarm concorrente)
    const res2 = await scheduler.fetch(new Request("https://do/claim", { method: "POST" }));
    assert.equal(res2.status, 200);
    const data2 = await res2.json() as { claimed: boolean };
    assert.equal(data2.claimed, false, "2º caller deve perder o claim (claiming já existe)");
  });

  it("POST /claim: perde se fired=true (alarm já completou com sucesso)", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("fired", true);

    const res = await scheduler.fetch(new Request("https://do/claim", { method: "POST" }));
    const data = await res.json() as { claimed: boolean };
    assert.equal(data.claimed, false, "deve perder claim quando fired=true (já disparou)");
  });

  it("concorrência alarm-ganha: alarm() enviado primeiro — alarm posta, cron pula", async () => {
    // (#2219 bug 5 fix) Testa o interleaving onde ALARM ganha o claim primeiro.
    // Promise.all([alarm(), claim()]) → alarm() é index 0, submete /claim primeiro
    // via blockConcurrencyWhile → alarm ganha, posta; cron perde o claim.
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "exactly once post - alarm wins",
      image_url: null,
      scheduled_at: past,
      destaque: "d1",
      created_at: past,
      retry_count: 0,
    };
    await state.storage.put("payload", {
      key: "queue:test-concurrent-alarm-wins",
      entry,
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    let webhookCallCount = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      webhookCallCount++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      // alarm() primeiro → alarm ganha o claim (via /claim interno)
      const [, claimResult] = await Promise.all([
        scheduler.alarm(),
        scheduler.fetch(new Request("https://do/claim", { method: "POST" }))
          .then(r => r.json() as Promise<{ claimed: boolean }>),
      ]);

      // Alarm ganhou → postou 1x; cron perdeu o claim (claimed=false)
      assert.equal(webhookCallCount, 1, `webhook deve ser chamado 1x (alarm ganhou), foi ${webhookCallCount}x`);
      assert.equal(claimResult.claimed, false, "cron deve perder o claim quando alarm foi primeiro");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("concorrência cron-ganha: cron enviado primeiro — alarm pula, cron posta", async () => {
    // (#2219 bug 5 fix) Testa o interleaving onde CRON ganha o claim primeiro.
    // Cron chama /claim ANTES de alarm() iniciar → cron ganha, alarm vê claimed=false e para.
    // Para garantir que cron ganha, chamamos /claim diretamente antes de alarm().
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "exactly once post - cron wins",
      image_url: null,
      scheduled_at: past,
      destaque: "d2",
      created_at: past,
      retry_count: 0,
    };
    await state.storage.put("payload", {
      key: "queue:test-concurrent-cron-wins",
      entry,
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    let webhookCallCount = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      webhookCallCount++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      // Cron ganha o claim primeiro (síncrono antes de alarm())
      const cronClaimRes = await scheduler.fetch(new Request("https://do/claim", { method: "POST" }));
      const cronClaimData = await cronClaimRes.json() as { claimed: boolean };
      assert.equal(cronClaimData.claimed, true, "cron deve ganhar o claim quando vai primeiro");

      // Agora alarm() tenta — deve perder (cron já tem o claim)
      await scheduler.alarm();

      // Alarm não deve ter postado (cron tem o claim)
      assert.equal(webhookCallCount, 0, `alarm não deve postar quando cron tem o claim, foi ${webhookCallCount}x`);

      // Cron "posta" (simulado) e libera o claim
      await scheduler.fetch(new Request("https://do/status-set-fired", { method: "POST" }));
      // fired=true agora, claiming=undefined

      const firedRes = await scheduler.fetch(new Request("https://do/status", { method: "GET" }));
      const firedData = await firedRes.json() as { fired: boolean };
      assert.equal(firedData.fired, true, "fired=true após cron sinalizar sucesso");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("concorrência cron+alarm (Promise.all): exatamente 1 webhook disparado independente da ordem", async () => {
    // Testa que em qualquer ordem de execução, apenas 1 post ocorre.
    // MockDOState.blockConcurrencyWhile serializa de verdade — o 1º a entrar na fila ganha.
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "exactly once post",
      image_url: null,
      scheduled_at: past,
      destaque: "d1",
      created_at: past,
      retry_count: 0,
    };
    await state.storage.put("payload", {
      key: "queue:test-concurrent",
      entry,
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    let webhookCallCount = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      webhookCallCount++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      // Dispara alarm() e /claim (simula cron) concorrentemente via Promise.all.
      // Com blockConcurrencyWhile real (fila), apenas 1 deve ganhar o claim e postar.
      const [alarmResult, claimResult] = await Promise.all([
        scheduler.alarm(),
        scheduler.fetch(new Request("https://do/claim", { method: "POST" }))
          .then(r => r.json() as Promise<{ claimed: boolean }>),
      ]);

      // Um ganhou, o outro perdeu — total de webhooks = 1 (exatamente-uma-vez)
      // alarm() = void; se alarm ganhou o claim, ele postou; se cron ganhou, ele teria postado
      // (neste teste não simulamos o cron postar, apenas verificamos o claim)
      const _ = alarmResult; // alarm() returns void
      const claimWon = claimResult.claimed;

      // O webhook deve ter sido chamado exatamente 1 vez:
      // - Se alarm() ganhou o claim (via /claim interno) → alarm() postou
      // - Se cron ganhou (via Promise.all do /claim externo) → alarm() perdeu, não postou
      // Total sempre = 1
      assert.equal(
        webhookCallCount, 1,
        `webhook deve ser chamado exatamente 1x, foi chamado ${webhookCallCount}x. ` +
        `claimWon(cron)=${claimWon}`,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("MockDOState.blockConcurrencyWhile serializa (não executa concorrentemente)", async () => {
    // Valida o mock diretamente: 2 operações "concorrentes" devem executar em sequência.
    const state = new MockDOState();
    const executionOrder: number[] = [];
    let insideFirst = false;

    // Simulamos 2 operações que checariam se a 1ª terminou antes de iniciar a 2ª
    const op1 = state.blockConcurrencyWhile(async () => {
      insideFirst = true;
      executionOrder.push(1);
      // Yield pra dar chance de interleaving se não serializar
      await Promise.resolve();
      await Promise.resolve();
      executionOrder.push(1); // deve aparecer antes do 2
      insideFirst = false;
      return "done1";
    });

    const op2 = state.blockConcurrencyWhile(async () => {
      executionOrder.push(2);
      assert.equal(insideFirst, false, "op2 não deve rodar enquanto op1 está em execução");
      return "done2";
    });

    const [r1, r2] = await Promise.all([op1, op2]);
    assert.equal(r1, "done1");
    assert.equal(r2, "done2");
    // Se serializa: [1,1,2]. Se não serializa (race): poderia ser [1,2,1].
    assert.deepEqual(executionOrder, [1, 1, 2], "blockConcurrencyWhile deve serializar execuções");
  });
});

// ── #2219 — Bug 3: Two-phase state (item-loss telemetria) ───────────────────

describe("#2219 Bug 3: two-phase state — item não perdido em crash mid-flight", () => {
  it("alarm() sucesso: claiming → fired (2 fases, NOT claiming+fired simultaneamente)", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "two-phase post",
      image_url: null,
      scheduled_at: past,
      destaque: "d2",
      created_at: past,
      retry_count: 0,
    };
    await state.storage.put("payload", {
      key: "queue:two-phase-key",
      entry,
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      await scheduler.alarm();
    } finally {
      globalThis.fetch = savedFetch;
    }

    // Após sucesso: fired=true, claiming removido (2ª fase concluída)
    const fired = await state.storage.get<boolean>("fired");
    const claiming = await state.storage.get<boolean>("claiming");
    assert.equal(fired, true, "fired deve ser true após sucesso do webhook");
    assert.equal(claiming, undefined, "claiming deve ser removido após sucesso (transição completa)");
  });

  it("alarm() falha de webhook: claiming removido (cron pode re-tentar), fired NÃO setado", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "test", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
    };
    await state.storage.put("payload", {
      key: "queue:fail-key",
      entry,
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("err", { status: 500 });
    try {
      await scheduler.alarm();
    } finally {
      globalThis.fetch = savedFetch;
    }

    // Após falha: fired NÃO deve ser setado (cron pode re-disparar via KV)
    const fired = await state.storage.get<boolean>("fired");
    const claiming = await state.storage.get<boolean>("claiming");
    assert.equal(fired, undefined, "fired NÃO deve ser setado após falha (evita item-loss)");
    assert.equal(claiming, undefined, "claiming deve ser liberado após falha (cron pode re-tentar)");
  });

  it("alarm() crash mid-flight: claiming=true, fired=undefined → item recuperável", async () => {
    // Simula crash mid-flight: claiming foi setado mas o webhook nem chegou a rodar.
    // (Neste cenário, o alarm() terminou de setar claiming mas não chegou ao fetch.)
    // Verificamos que o estado `claiming=true, fired=undefined` é detectável pelo cron
    // via /status, que retorna fired=false → cron pode investigar/re-tentar.
    const state = new MockDOState();

    // Simula estado pós-crash: claiming=true mas fired não existe
    await state.storage.put("claiming", true);

    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const statusRes = await scheduler.fetch(new Request("https://do/status", { method: "GET" }));
    const statusData = await statusRes.json() as { fired: boolean };

    // Cron pode detectar: fired=false → investigar se claiming=true → telemetria
    assert.equal(statusData.fired, false, "fired=false em crash mid-flight (item recuperável)");
    // claiming permanece para detecção de item-loss via monitoramento
    assert.equal(state.storage.store.get("claiming"), true, "claiming=true indica crash mid-flight");
  });

  it("POST /status-set-fired: cron sinaliza sucesso ao DO (seta fired, limpa claiming)", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    // Simula state pós-claim do cron (cron ganhou o claim)
    await state.storage.put("claiming", true);

    const res = await scheduler.fetch(
      new Request("https://do/status-set-fired", { method: "POST" }),
    );
    assert.equal(res.status, 200);

    const fired = await state.storage.get<boolean>("fired");
    const claiming = await state.storage.get<boolean>("claiming");
    assert.equal(fired, true, "fired=true após cron sinalizar sucesso");
    assert.equal(claiming, undefined, "claiming removido após cron sinalizar sucesso");
  });

  it("POST /release-claim: cron libera claim após falha (próximo retry pode tentar)", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("claiming", true);

    const res = await scheduler.fetch(
      new Request("https://do/release-claim", { method: "POST" }),
    );
    assert.equal(res.status, 200);

    const claiming = await state.storage.get<boolean>("claiming");
    assert.equal(claiming, undefined, "claiming=undefined após release (próximo caller pode clamar)");
  });
});

// ── #2219 — Bug 4: Mock serializa blockConcurrencyWhile ──────────────────────

describe("#2219 Bug 4: MockDOState.blockConcurrencyWhile serializa (não é no-op)", () => {
  it("múltiplas operações concorrentes executam em série (não paralelo)", async () => {
    const state = new MockDOState();
    const results: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const ops = Array.from({ length: 5 }, (_, i) =>
      state.blockConcurrencyWhile(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        results.push(`start-${i}`);
        await Promise.resolve(); // yield
        results.push(`end-${i}`);
        concurrent--;
        return i;
      }),
    );

    const values = await Promise.all(ops);

    // Todas devem completar com os valores corretos
    assert.deepEqual(values.sort(), [0, 1, 2, 3, 4]);
    // Com serialização real, no máximo 1 operação roda de cada vez
    assert.equal(maxConcurrent, 1, `max concurrent deve ser 1, foi ${maxConcurrent} (sem serialização)`);
    // Cada start deve ser seguido pelo seu end antes do próximo start
    for (let i = 0; i < 5; i++) {
      const startIdx = results.indexOf(`start-${i}`);
      const endIdx = results.indexOf(`end-${i}`);
      assert.ok(
        startIdx >= 0 && endIdx === startIdx + 1,
        `start-${i} deve ser seguido imediatamente por end-${i} (serialização), mas results=${JSON.stringify(results)}`,
      );
    }
  });

  it("blockConcurrencyWhile retorna o valor correto", async () => {
    const state = new MockDOState();
    const result = await state.blockConcurrencyWhile(async () => 42);
    assert.equal(result, 42);
  });

  it("blockConcurrencyWhile propaga exception sem bloquear fila", async () => {
    const state = new MockDOState();
    // Primeiro op lança exception
    const p1 = state.blockConcurrencyWhile(async () => {
      throw new Error("test error");
    });
    // Segundo op deve conseguir executar mesmo após exception do 1º
    const p2 = state.blockConcurrencyWhile(async () => "ok");

    await assert.rejects(p1, /test error/);
    const r2 = await p2;
    assert.equal(r2, "ok", "fila deve continuar após exception");
  });
});

// ── #2219 Bug 1 fix: DLQ-pixel path libera claim antes de continue ────────────

describe("#2219 Bug 1 fix: DLQ-pixel path libera claim no DO antes de ir pra DLQ", () => {
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => { savedFetch = globalThis.fetch; });

  it("fireDueItems: pixel sem env var → DLQ + DO claim liberado (não fica preso)", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO("tok", "https://make.test/diaria");
    // MAKE_PIXEL_WEBHOOK_URL ausente

    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-dlq-claim-test");
    const entry: QueueEntry = {
      text: "pixel comment", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
      webhook_target: "pixel", action: "comment",
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    // Pré-registrar DO stub pra poder inspecionar o estado após fireDueItems
    const doState = new MockDOState();
    const doScheduler = new LinkedInScheduler(doState as unknown as DurableObjectState);
    doNamespace.stubs.set(queueKey, { scheduler: doScheduler, state: doState });

    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.dlq, 1, "deve ir pra DLQ");

      // DO claim deve estar liberado após o DLQ path (Bug 1 fix)
      const claiming = await doState.storage.get<boolean>("claiming");
      assert.equal(claiming, undefined, "claiming deve ser undefined após DLQ path — não travado");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── #2219 Bug 2 fix: Claim TTL evita lock permanente ─────────────────────────

describe("#2219 Bug 2 fix: claim TTL — claim expirado pode ser re-claimado", () => {
  it("CLAIM_TTL_MS é 5 minutos (sanity)", () => {
    assert.equal(CLAIM_TTL_MS, 5 * 60 * 1000);
  });

  it("claim expirado (claimed_at antigo): novo caller consegue re-clamar", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    // Simula claim expirado: claiming=true mas claimed_at está no passado (> TTL)
    await state.storage.put("claiming", true);
    await state.storage.put("claimed_at", Date.now() - CLAIM_TTL_MS - 1000); // 1s após TTL

    const res = await scheduler.fetch(new Request("https://do/claim", { method: "POST" }));
    const data = await res.json() as { claimed: boolean };
    assert.equal(data.claimed, true, "claim expirado deve poder ser re-claimado (crash recovery)");
  });

  it("claim não-expirado (claimed_at recente): segundo caller NÃO consegue clamar", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    // Claim recente — dentro do TTL
    await state.storage.put("claiming", true);
    await state.storage.put("claimed_at", Date.now() - 30_000); // 30s atrás (< 5min TTL)

    const res = await scheduler.fetch(new Request("https://do/claim", { method: "POST" }));
    const data = await res.json() as { claimed: boolean };
    assert.equal(data.claimed, false, "claim recente NÃO deve ser re-claimado (normal competing caller)");
  });

  it("/release-claim remove claimed_at junto com claiming", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("claiming", true);
    await state.storage.put("claimed_at", Date.now());

    await scheduler.fetch(new Request("https://do/release-claim", { method: "POST" }));

    assert.equal(await state.storage.get("claiming"), undefined, "claiming deve ser undefined após release");
    assert.equal(await state.storage.get("claimed_at"), undefined, "claimed_at deve ser undefined após release");
  });
});

// ── #2219 Bug 3 fix: DELETE /queue cancela DO antes de deletar KV ────────────

describe("#2219 Bug 3 fix: DELETE /queue cancela DO ANTES de deletar KV", () => {
  it("DO alarm cancelado antes da KV delete (janela eliminada)", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO();

    const future = new Date(Date.now() + 3600_000).toISOString();
    const queueKey = buildQueueKey(future, "uuid-order-test");
    const entry: QueueEntry = {
      text: "post a cancelar", image_url: null, scheduled_at: future,
      destaque: "d1", created_at: new Date().toISOString(), retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    // Instrumentar DO pra capturar a ordem das operações
    const operationOrder: string[] = [];
    const doState = new MockDOState();
    const doScheduler = new LinkedInScheduler(doState as unknown as DurableObjectState);

    // Wrap do fetch do scheduler pra capturar a ordem
    const origFetch = doScheduler.fetch.bind(doScheduler);
    doScheduler.fetch = async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/cancel") {
        operationOrder.push("do_cancel");
      }
      return origFetch(req);
    };

    // Wrap do KV.delete pra capturar ordem
    const origDelete = kv.delete.bind(kv);
    kv.delete = async (key: string) => {
      operationOrder.push("kv_delete");
      return origDelete(key);
    };

    doState.storage.alarmMs = Date.now() + 3600_000;
    await doState.storage.put("payload", { key: queueKey, entry, webhookUrl: "x" } satisfies DoStoredPayload);
    doNamespace.stubs.set(queueKey, { scheduler: doScheduler, state: doState });

    const req = authedRequest(`https://w.test/queue/${encodeURIComponent(queueKey)}`, { method: "DELETE" });
    await workerDefault.fetch(req, env);

    // Ordem correta: DO cancel ANTES de KV delete
    assert.deepEqual(operationOrder, ["do_cancel", "kv_delete"],
      `Ordem incorreta: esperava ["do_cancel", "kv_delete"], recebeu ${JSON.stringify(operationOrder)}`);
  });
});

// ── #2219 Bug 4 fix (migrado pra #2230 bug 3): alarm() usa tryClaim() direto ──
// Antes: alarm() chamava this.fetch('/claim') e precisava checar claimRes.ok antes de .json().
// Agora (#2230 bug 3 fix): alarm() chama tryClaim() diretamente — sem self-fetch, sem risco
// de non-JSON response. O teste de /claim endpoint via fetch externo ainda exercita POST /claim.

describe("#2219 Bug 4 fix: alarm() para sem postar quando claim não pode ser ganho", () => {
  it("alarm() para sem postar quando tryClaim() retorna false (cron ganhou antes)", async () => {
    // (#2230 bug 3 fix) O cenário original era: alarm() fazia self-fetch /claim que retornava 503.
    // Agora alarm() usa tryClaim() direto. Testamos o invariante equivalente: se o cron ganhou
    // o claim antes, alarm() deve parar sem postar.
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    // Cron ganhou o claim — claiming=true, claimed_at recente
    await state.storage.put("claiming", true);
    await state.storage.put("claimed_at", Date.now());

    const past = new Date(Date.now() - 60_000).toISOString();
    await state.storage.put("payload", {
      key: "queue:test-claim-lost",
      entry: { text: "t", image_url: null, scheduled_at: past, destaque: "d1", created_at: past, retry_count: 0 },
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    let webhookCalled = false;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      webhookCalled = true;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      await scheduler.alarm();
    } finally {
      globalThis.fetch = savedFetch;
    }

    assert.equal(webhookCalled, false, "webhook não deve ser chamado quando cron já tem o claim");
  });
});

// ── #2219 Bug 6 fix: GET /status expõe campo claiming ────────────────────────

describe("#2219 Bug 6 fix: GET /status expõe claiming + claimed_at (telemetria)", () => {
  it("GET /status retorna claiming=false quando não há claim ativo", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const res = await scheduler.fetch(new Request("https://do/status", { method: "GET" }));
    const data = await res.json() as { fired: boolean; claiming: boolean; claimed_at: number | null };
    assert.equal(data.fired, false);
    assert.equal(data.claiming, false, "claiming deve ser false quando não há claim");
    assert.equal(data.claimed_at, null, "claimed_at deve ser null quando não há claim");
  });

  it("GET /status retorna claiming=true + claimed_at em crash mid-flight", async () => {
    const state = new MockDOState();
    const now = Date.now();
    await state.storage.put("claiming", true);
    await state.storage.put("claimed_at", now);

    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    const res = await scheduler.fetch(new Request("https://do/status", { method: "GET" }));
    const data = await res.json() as { fired: boolean; claiming: boolean; claimed_at: number | null };
    assert.equal(data.claiming, true, "claiming=true indica crash mid-flight detectável");
    assert.equal(data.claimed_at, now, "claimed_at deve ser retornado para telemetria de TTL");
  });
});

// ── #2219 Bug 7 fix: MockDOStorage.deleteAll não zera alarmMs ────────────────

describe("#2219 Bug 7 fix: MockDOStorage.deleteAll() NÃO cancela alarm (igual CF real)", () => {
  it("deleteAll limpa store mas NÃO zera alarmMs", async () => {
    const storage = new MockDOStorage();
    await storage.put("key1", "value1");
    await storage.put("key2", "value2");
    storage.alarmMs = Date.now() + 3600_000;

    await storage.deleteAll();

    assert.equal(storage.store.size, 0, "store deve estar vazio após deleteAll");
    assert.ok(storage.alarmMs !== null, "alarmMs NÃO deve ser zerado por deleteAll (CF real mantém alarm)");
  });

  it("deleteAlarm() zera alarmMs (explícito, como CF real)", async () => {
    const storage = new MockDOStorage();
    storage.alarmMs = Date.now() + 3600_000;
    await storage.deleteAlarm();
    assert.equal(storage.alarmMs, null, "deleteAlarm() deve zerar alarmMs");
  });

  it("/cancel chama deleteAlarm() + deleteAll() — ambos limpos", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    state.storage.alarmMs = Date.now() + 3600_000;
    await state.storage.put("payload", { key: "k" } as unknown as DoStoredPayload);
    await state.storage.put("claiming", true);

    await scheduler.fetch(new Request("https://do/cancel", { method: "POST" }));

    // deleteAlarm() deve ter sido chamado (alarmMs = null)
    assert.equal(state.storage.alarmMs, null, "/cancel deve cancelar alarm via deleteAlarm()");
    // deleteAll() deve ter limpado o store
    assert.equal(state.storage.store.size, 0, "/cancel deve limpar storage via deleteAll()");
  });
});

// ── #2219 Bug 8 fix: integração claim gate em fireDueItems com DO ────────────

describe("#2219 Bug 8 fix: fireDueItems exercita /claim gate quando DO disponível", () => {
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => { savedFetch = globalThis.fetch; });

  it("fireDueItems: DO disponível, cron ganha claim, posta 1x e seta fired", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO("tok", "https://make.test/webhook");

    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-claim-integration");
    const entry: QueueEntry = {
      text: "integration test", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    // Pré-registrar DO stub para inspeção pós-fire
    const doState = new MockDOState();
    const doScheduler = new LinkedInScheduler(doState as unknown as DurableObjectState);
    doNamespace.stubs.set(queueKey, { scheduler: doScheduler, state: doState });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1, "item deve ser disparado");
      assert.equal(fetchCalls, 1, "webhook deve ser chamado 1x");
      assert.equal(kv.store.has(queueKey), false, "KV entry deve ser deletada após fire");

      // DO deve ter fired=true após cron disparar com sucesso (status-set-fired)
      const fired = await doState.storage.get<boolean>("fired");
      assert.equal(fired, true, "DO deve ter fired=true após cron disparar com sucesso");

      // DO claiming deve estar limpo
      const claiming = await doState.storage.get<boolean>("claiming");
      assert.equal(claiming, undefined, "claiming deve ser undefined após fire bem-sucedido");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("fireDueItems: DO disponível, alarm ganhou claim antes do cron — cron pula", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO("tok", "https://make.test/webhook");

    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-claim-alarm-won");
    const entry: QueueEntry = {
      text: "alarm already claimed", image_url: null, scheduled_at: past,
      destaque: "d2", created_at: past, retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    // Simula alarm que já ganhou o claim (claiming=true, fired=false ainda)
    const doState = new MockDOState();
    const doScheduler = new LinkedInScheduler(doState as unknown as DurableObjectState);
    await doState.storage.put("claiming", true);
    await doState.storage.put("claimed_at", Date.now()); // claim recente, não expirado
    doNamespace.stubs.set(queueKey, { scheduler: doScheduler, state: doState });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await __test__.fireDueItems(env);
      // Cron não deve postar (alarm tem o claim)
      assert.equal(fetchCalls, 0, "cron não deve postar quando alarm tem o claim");
      // fired=0 porque cron pulou; mas o item ainda está no KV (será limpo quando alarm setar fired=true)
      assert.equal(result.fired, 0, "cron não conta como fired quando perdeu o claim");
      assert.equal(kv.store.has(queueKey), true, "KV entry deve permanecer — alarm ainda vai postar");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── #2230 — Bug 1: fired durável + payload limpo após alarm fire bem-sucedido ──

describe("#2230 Bug 1: alarm() sucesso → fired durável + payload deletado (sem double-post via TTL)", () => {
  it("alarm() sucesso: fired=true + payload deletado do storage — alarm re-entry pula", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "should post once",
      image_url: null,
      scheduled_at: past,
      destaque: "d1",
      created_at: past,
      retry_count: 0,
    };
    await state.storage.put("payload", {
      key: "queue:test-fired-durable",
      entry,
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    let webhookCalls = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      webhookCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      // 1ª invocação — deve postar
      await scheduler.alarm();
      assert.equal(webhookCalls, 1, "1ª invocação deve postar");

      // Verificar que fired=true E payload foi deletado
      const fired = await state.storage.get<boolean>("fired");
      const payload = await state.storage.get<DoStoredPayload>("payload");
      assert.equal(fired, true, "fired deve ser true após sucesso");
      assert.equal(payload, undefined, "payload deve ser deletado após sucesso (#2230 bug 1 fix)");

      // 2ª invocação (simula alarm re-disparado via TTL expiry + claim re-claimado):
      // tryClaim() retorna false pq fired=true — não deve re-postar
      await scheduler.alarm();
      assert.equal(webhookCalls, 1, "2ª invocação NÃO deve re-postar — fired=true bloqueia claim (#2230 bug 1)");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("alarm() sucesso: mesmo que tryClaim TTL-expire e re-claime, payload ausente evita post", async () => {
    // Simula o cenário mais extremo do bug 1:
    // alarm() postou, mas fired=true não foi salvo (storage error simulado).
    // Se payload ainda estiver em storage E claiming tiver expirado (TTL), alarm pode re-clamar.
    // Fix: payload deletado → alarm re-entry aborta cedo (payload missing = cancelled/OK).
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    const entry: QueueEntry = {
      text: "double-post test", image_url: null, scheduled_at: past,
      destaque: "d2", created_at: past, retry_count: 0,
    };

    // Estado pós-fix: fired=true (persistiu), payload=undefined (deletado)
    await state.storage.put("fired", true);
    // payload NOT stored — simula que foi deletado

    let webhookCalls = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      webhookCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      await scheduler.alarm();
      assert.equal(webhookCalls, 0, "não deve postar quando fired=true (payload também não está)");
    } finally {
      globalThis.fetch = savedFetch;
    }
    void entry; // suppress unused warning
  });

  it("alarm() sucesso: cron pós-fire vê fired=true + payload ausente via /status, deleta KV sem re-fire", async () => {
    // Valida o fluxo end-to-end: alarm dispara, cron vê fired=true, limpa KV sem re-postar.
    const { env, kv, doNamespace } = mkEnvWithDO("tok", "https://make.test/webhook");

    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-fired-durable-cron");
    const entry: QueueEntry = {
      text: "fired by alarm", image_url: null, scheduled_at: past,
      destaque: "d3", created_at: past, retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    // Simula DO após alarm() bem-sucedido: fired=true, payload=undefined
    const doState = new MockDOState();
    const doScheduler = new LinkedInScheduler(doState as unknown as DurableObjectState);
    await doState.storage.put("fired", true);
    // payload NÃO armazenado (deletado pelo alarm fix)
    doNamespace.stubs.set(queueKey, { scheduler: doScheduler, state: doState });

    let webhookCalls = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      webhookCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(webhookCalls, 0, "cron NÃO deve re-postar — DO reporta fired=true");
      assert.equal(result.fired, 1, "cron conta como fired para estatísticas (cleanup)");
      assert.equal(kv.store.has(queueKey), false, "KV entry deletada pelo cron cleanup");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── #2230 — Bug 2: delete garantido (retry + tombstone) ──────────────────────

describe("#2230 Bug 2: handleQueueDelete — delete garantido (retry + tombstone)", () => {
  it("KV.delete falha → tombstone gravado → cron NÃO dispara item cancelado", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO();

    const future = new Date(Date.now() + 3600_000).toISOString();
    const queueKey = buildQueueKey(future, "uuid-kv-delete-fails");
    const entry: QueueEntry = {
      text: "should not post after delete",
      image_url: null,
      scheduled_at: future,
      destaque: "d1",
      created_at: new Date().toISOString(),
      retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    // DO armado
    const doState = new MockDOState();
    const doScheduler = new LinkedInScheduler(doState as unknown as DurableObjectState);
    doState.storage.alarmMs = Date.now() + 3600_000;
    await doState.storage.put("payload", { key: queueKey, entry, webhookUrl: "x" } satisfies DoStoredPayload);
    doNamespace.stubs.set(queueKey, { scheduler: doScheduler, state: doState });

    // Mock KV.delete para sempre falhar
    const origDelete = kv.delete.bind(kv);
    let deleteAttempts = 0;
    kv.delete = async (_key: string) => {
      deleteAttempts++;
      throw new Error("KV transitório indisponível");
    };

    const req = authedRequest(`https://w.test/queue/${encodeURIComponent(queueKey)}`, { method: "DELETE" });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 200);

    const data = await res.json() as { deleted: boolean; kv_deleted: boolean; do_alarm_cancelled: boolean };
    assert.equal(data.deleted, true, "response deve indicar deleted=true mesmo com kv_delete falha");
    assert.equal(data.kv_deleted, false, "kv_deleted=false pq KV.delete falhou");
    assert.equal(data.do_alarm_cancelled, true, "DO alarm deve ter sido cancelado");

    // Tombstone deve estar no KV (item com cancelled=true)
    const raw = kv.store.get(queueKey);
    assert.ok(raw, "tombstone deve existir no KV após KV.delete falhar");
    const tombstone = JSON.parse(raw as string) as QueueEntry & { cancelled?: boolean };
    assert.equal(tombstone.cancelled, true, "tombstone deve ter cancelled=true (#2230 bug 2 fix)");

    // Restaurar KV.delete normal
    kv.delete = origDelete;

    // Agora simular o cron processando: item tombstone deve ser PULADO sem postar
    // (colocar scheduled_at no passado para que o cron o processe)
    const pastEntry = { ...tombstone, scheduled_at: new Date(Date.now() - 60_000).toISOString(), cancelled: true };
    const pastKey = buildQueueKey(pastEntry.scheduled_at, "uuid-kv-delete-fails");
    kv.store.delete(queueKey);
    kv.store.set(pastKey, JSON.stringify(pastEntry));

    // (#2235 fix F5) DO para o pastKey deve começar sem payload (novo DO stub criado automaticamente).
    // Pré-registrar um DO stub para o pastKey pra verificar que /cancel foi chamado.
    const doStatePast = new MockDOState();
    const doSchedulerPast = new LinkedInScheduler(doStatePast as unknown as DurableObjectState);
    // Simula um DO que pode ter sido re-armado (com payload presente) — cron deve chamá-lo com /cancel
    await doStatePast.storage.put("payload", { key: pastKey, entry, webhookUrl: "x" } satisfies DoStoredPayload);
    doStatePast.storage.alarmMs = Date.now() + 3600_000;
    doNamespace.stubs.set(pastKey, { scheduler: doSchedulerPast, state: doStatePast });

    let webhookCalls = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      webhookCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      await __test__.fireDueItems(env);
      assert.equal(webhookCalls, 0, "cron NÃO deve postar item com tombstone cancelled=true");
      assert.equal(kv.store.has(pastKey), false, "tombstone deve ser deletado pelo cron (cleanup)");
      // (#2235 fix F5) DO /cancel deve ter sido chamado — payload + alarm limpos
      assert.equal(doStatePast.storage.alarmMs, null, "DO alarm deve ser cancelado ao limpar tombstone (#2235 fix F5)");
      assert.equal(await doStatePast.storage.get("payload"), undefined, "DO payload deve ser limpo ao limpar tombstone (#2235 fix F5)");
    } finally {
      globalThis.fetch = savedFetch;
    }

    void deleteAttempts; // used for instrumentation
  });

  it("KV.delete sucede na 1ª tentativa: kv_deleted=true na resposta", async () => {
    const { env, kv, doNamespace } = mkEnvWithDO();

    const future = new Date(Date.now() + 3600_000).toISOString();
    const queueKey = buildQueueKey(future, "uuid-kv-delete-ok");
    const entry: QueueEntry = {
      text: "normal delete", image_url: null, scheduled_at: future,
      destaque: "d2", created_at: new Date().toISOString(), retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    const doState = new MockDOState();
    const doScheduler = new LinkedInScheduler(doState as unknown as DurableObjectState);
    doNamespace.stubs.set(queueKey, { scheduler: doScheduler, state: doState });

    const req = authedRequest(`https://w.test/queue/${encodeURIComponent(queueKey)}`, { method: "DELETE" });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 200);

    const data = await res.json() as { deleted: boolean; kv_deleted: boolean };
    assert.equal(data.deleted, true);
    assert.equal(data.kv_deleted, true, "kv_deleted=true quando KV.delete sucede normalmente");
    assert.equal(kv.store.has(queueKey), false, "item removido do KV");
  });
});

// ── #2230 — Bug 3: alarm() usa tryClaim() direto (sem self-fetch) ─────────────

describe("#2230 Bug 3: alarm() usa tryClaim() diretamente — sem nested blockConcurrencyWhile", () => {
  it("tryClaim(): 1ª chamada ganha (true), 2ª perde (false) — mesma semântica do /claim", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const result1 = await scheduler.tryClaim();
    assert.equal(result1, true, "1ª chamada a tryClaim() deve ganhar o claim");
    assert.equal(state.storage.store.get("claiming"), true, "claiming=true após tryClaim()");

    const result2 = await scheduler.tryClaim();
    assert.equal(result2, false, "2ª chamada a tryClaim() deve perder (claiming já ativo)");
  });

  it("tryClaim(): retorna false quando fired=true (item já disparado)", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("fired", true);

    const result = await scheduler.tryClaim();
    assert.equal(result, false, "tryClaim() deve retornar false quando fired=true");
  });

  it("tryClaim(): claim expirado (TTL) pode ser re-claimado", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("claiming", true);
    await state.storage.put("claimed_at", Date.now() - CLAIM_TTL_MS - 1000);

    const result = await scheduler.tryClaim();
    assert.equal(result, true, "tryClaim() deve re-clamar quando claim expirou (TTL)");
  });

  it("alarm() não usa self-fetch — chama tryClaim() diretamente (sem nested blockConcurrencyWhile)", async () => {
    // Valida que alarm() chama tryClaim() e não this.fetch('/claim').
    // Se houvesse self-fetch, o alarm seria chamado recursivamente via fetch(),
    // mas o DO runtime de CF pode lançar nesse cenário.
    // No mock, o self-fetch funciona (MockDOState não bloqueia recursão),
    // mas este teste verifica o caminho correto: tryClaim() é chamado 1x por alarm().
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    // Interceptar tryClaim para verificar que é chamado
    let tryClaimCalls = 0;
    const origTryClaim = scheduler.tryClaim.bind(scheduler);
    scheduler.tryClaim = async () => {
      tryClaimCalls++;
      return origTryClaim();
    };

    const past = new Date(Date.now() - 60_000).toISOString();
    await state.storage.put("payload", {
      key: "queue:test-no-self-fetch",
      entry: { text: "t", image_url: null, scheduled_at: past, destaque: "d1", created_at: past, retry_count: 0 },
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      await scheduler.alarm();
    } finally {
      globalThis.fetch = savedFetch;
    }

    assert.equal(tryClaimCalls, 1, "alarm() deve chamar tryClaim() exatamente 1x (sem self-fetch)");
  });

  it("alarm() + cron concorrentes com tryClaim direto: exatamente 1 post (#2230 bug 3 + #2219 bug 2)", async () => {
    // Valida que a mudança de self-fetch → tryClaim() mantém exactly-once:
    // alarm() e cron competem pelo mesmo claim, apenas 1 posta.
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);

    const past = new Date(Date.now() - 60_000).toISOString();
    await state.storage.put("payload", {
      key: "queue:test-tryClaim-concurrent",
      entry: { text: "exactly once", image_url: null, scheduled_at: past, destaque: "d2", created_at: past, retry_count: 0 },
      webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);

    let webhookCalls = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      webhookCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      // alarm() e tryClaim() concorrentes (simula cron+alarm simultâneos)
      const [, claimResult] = await Promise.all([
        scheduler.alarm(),
        scheduler.tryClaim().then(claimed => ({ claimed })),
      ]);

      // Total de webhooks deve ser exatamente 1 (alarm ganhou ou cron teria ganho)
      assert.equal(
        webhookCalls, 1,
        `webhook deve ser chamado exatamente 1x, foi ${webhookCalls}x. claimResult=${JSON.stringify(claimResult)}`,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ── #2235 — cron path: /status-set-fired robusto + handleRearm skip tombstone ──

describe("#2235 cron path: /status-set-fired com retry (sem double-post via alarm TTL)", () => {
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => { savedFetch = globalThis.fetch; });

  it("cron posta + /status-set-fired falha transitória → retry → DO tem fired=true+payload limpo ao final", async () => {
    // Testa que o retry de /status-set-fired funciona: 1ª tentativa falha, 2ª sucede.
    // Garante que o DO fica com fired=true + payload limpo, impedindo re-post via alarm.
    const { env, kv, doNamespace } = mkEnvWithDO("tok", "https://make.test/webhook");

    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-status-set-fired-retry");
    const entry: QueueEntry = {
      text: "post com status-set-fired retry", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: past, retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    // DO pré-registrado pra inspecionar o estado pós-cron
    const doState = new MockDOState();
    // Pré-popula payload como se o alarm tivesse sido armado
    await doState.storage.put("payload", {
      key: queueKey, entry, webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);
    const doScheduler = new LinkedInScheduler(doState as unknown as DurableObjectState);

    // Simula /status-set-fired falhando na 1ª tentativa mas sucedendo na 2ª
    let statusSetFiredCalls = 0;
    const origFetch = doScheduler.fetch.bind(doScheduler);
    doScheduler.fetch = async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/status-set-fired") {
        statusSetFiredCalls++;
        if (statusSetFiredCalls === 1) {
          return new Response(JSON.stringify({ error: "transient" }), { status: 503 });
        }
      }
      return origFetch(req);
    };
    doNamespace.stubs.set(queueKey, { scheduler: doScheduler, state: doState });

    let webhookCalls = 0;
    globalThis.fetch = (async () => {
      webhookCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1, "item deve ser disparado pelo cron");
      assert.equal(webhookCalls, 1, "webhook chamado 1x");
      assert.equal(kv.store.has(queueKey), false, "KV entry deletada após fire");

      // /status-set-fired foi chamado pelo menos 2x (1ª falhou, 2ª sucedeu)
      assert.ok(statusSetFiredCalls >= 2, `status-set-fired deve ter sido retentado (calls=${statusSetFiredCalls})`);

      // DO deve ter fired=true + payload deletado após retry bem-sucedido
      const fired = await doState.storage.get<boolean>("fired");
      const payload = await doState.storage.get<DoStoredPayload>("payload");
      assert.equal(fired, true, "DO deve ter fired=true após retry bem-sucedido");
      assert.equal(payload, undefined, "DO payload deve ser deletado pelo /status-set-fired (#2235 fix)");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("cron posta + /status-set-fired falha persistente → /cancel chamado → alarm re-entry (TTL re-claim) NÃO posta", async () => {
    // (#2235 fix F1 + F2 + F6) Exercita o path do bug confirmado:
    //   1. cron posta (webhook ok), deleta KV
    //   2. /status-set-fired falha 3x → firedSetOk=false
    //   3. Fix: cron chama /cancel best-effort → payload limpo do DO
    //   4. Alarm re-dispara via TTL expiry + claim expirado (claiming=true, claimed_at antigo)
    //   5. alarm() faz tryClaim() → claim expirado → re-clama → lê payload → payload AUSENTE → aborta
    //   6. webhook NÃO é chamado (double-post prevenido)
    //
    // O teste anterior usava `const s = globalThis.fetch` em vez de `savedFetch` do beforeEach
    // (#2235 fix F3 — teardown frágil que podia poluir o fetch da suíte se Test 1 lançasse).
    const { env, kv, doNamespace } = mkEnvWithDO("tok", "https://make.test/webhook");

    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-firedSetOk-false-cancel");
    const entry: QueueEntry = {
      text: "double post guard via cancel", image_url: null, scheduled_at: past,
      destaque: "d2", created_at: past, retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    // DO com payload presente e claim EXPIRADO (claiming=true + claimed_at antigo > CLAIM_TTL_MS)
    // — simula o estado onde alarm disparou parcialmente e travou
    const doState = new MockDOState();
    const doScheduler = new LinkedInScheduler(doState as unknown as DurableObjectState);
    await doState.storage.put("payload", {
      key: queueKey, entry, webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);
    // claiming=true com claimed_at expirado → alarm pode re-clamar via TTL
    await doState.storage.put("claiming", true);
    await doState.storage.put("claimed_at", Date.now() - CLAIM_TTL_MS - 5_000); // 5s além do TTL

    // Simula /status-set-fired falhando SEMPRE (storage persistentemente degradado)
    const origFetch = doScheduler.fetch.bind(doScheduler);
    doScheduler.fetch = async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/status-set-fired") {
        return new Response(JSON.stringify({ error: "storage unavailable" }), { status: 503 });
      }
      return origFetch(req);
    };
    doNamespace.stubs.set(queueKey, { scheduler: doScheduler, state: doState });

    let webhookCalls = 0;
    globalThis.fetch = (async () => {
      webhookCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      // Step 1: cron dispara (cron ganha claim, posta, KV deletado, /status-set-fired falha → /cancel chamado)
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1, "cron deve disparar o item");
      assert.equal(webhookCalls, 1, "webhook chamado 1x pelo cron");
      assert.equal(kv.store.has(queueKey), false, "KV entry deletada após fire");

      // Verificar que /cancel foi chamado (payload deve estar limpo no DO)
      const payloadAfterCron = await doState.storage.get<DoStoredPayload>("payload");
      assert.equal(payloadAfterCron, undefined, "payload deve estar limpo (via /cancel) após /status-set-fired falhar (#2235 fix F1)");

      // Step 2: alarm re-dispara via TTL expiry (claiming=true mas claimed_at antigo → re-claim)
      // Como payload foi limpo, alarm deve abortar sem postar (mesmo que re-claime)
      await doScheduler.alarm();
      assert.equal(webhookCalls, 1, "alarm re-entry NÃO deve re-postar — payload ausente bloqueia (#2235 fix F1)");
    } finally {
      globalThis.fetch = savedFetch; // (#2235 fix F3) usar savedFetch do beforeEach, não `const s` local
    }
  });

  it("cron posta + /status-set-fired sucede → alarm posterior (fired=true) NÃO re-posta", async () => {
    // Fluxo normal do fix: cron posta, /status-set-fired sucede, alarm re-entry pula.
    const { env, kv, doNamespace } = mkEnvWithDO("tok", "https://make.test/webhook");

    const past = new Date(Date.now() - 60_000).toISOString();
    const queueKey = buildQueueKey(past, "uuid-cron-then-alarm-noop");
    const entry: QueueEntry = {
      text: "cron fires, alarm skips", image_url: null, scheduled_at: past,
      destaque: "d3", created_at: past, retry_count: 0,
    };
    kv.store.set(queueKey, JSON.stringify(entry));

    const doState = new MockDOState();
    await doState.storage.put("payload", {
      key: queueKey, entry, webhookUrl: "https://make.test/webhook",
    } satisfies DoStoredPayload);
    const doScheduler = new LinkedInScheduler(doState as unknown as DurableObjectState);
    doNamespace.stubs.set(queueKey, { scheduler: doScheduler, state: doState });

    let webhookCalls = 0;
    globalThis.fetch = (async () => {
      webhookCalls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      // Step 1: cron dispara
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1, "cron deve disparar o item");
      assert.equal(webhookCalls, 1, "1 webhook pra cron");

      // Verificar que DO tem fired=true + payload deletado
      const fired = await doState.storage.get<boolean>("fired");
      const payload = await doState.storage.get<DoStoredPayload>("payload");
      assert.equal(fired, true, "fired=true após cron");
      assert.equal(payload, undefined, "payload deletado pelo /status-set-fired (#2235)");

      // Step 2: alarm re-dispara (simula CF retry ou TTL expiry)
      await doScheduler.alarm();
      assert.equal(webhookCalls, 1, "alarm re-entry NÃO deve re-postar (fired=true) (#2235 double-post guard)");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe("#2235 handleRearm: pula + DELETA entries com tombstone (item cancelado)", () => {
  it("rearm deleta tombstone com cancelled=true — não arma alarm + limpa KV (anti-acúmulo)", async () => {
    // (#2235 fix F4) handleRearm agora DELETA tombstones em vez de só pular.
    // Tombstones com scheduled_at futuro acumulavam no KV porque:
    //   - cron não os processa (ainda não chegou a hora + cancelled=true os pularia ao chegar)
    //   - rearm anterior só pulava sem deletar
    // Fix: rearm detecta cancelled=true + scheduled_at futuro → deleta + conta skipped_tombstone.
    const { env, kv, doNamespace } = mkEnvWithDO();

    // Gravar tombstone: entry com scheduled_at no futuro + cancelled=true
    const future = new Date(Date.now() + 3600_000).toISOString();
    const queueKey = buildQueueKey(future, "uuid-tombstone-rearm");
    const tombstoneEntry: QueueEntry & { cancelled: boolean } = {
      text: "item cancelado", image_url: null, scheduled_at: future,
      destaque: "d1", created_at: new Date().toISOString(), retry_count: 0,
      cancelled: true,
    };
    kv.store.set(queueKey, JSON.stringify(tombstoneEntry));

    // /rearm deve deletar o tombstone + retornar skipped_tombstone=1
    const req = authedRequest("https://w.test/rearm", { method: "POST" });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 200);

    const data = await res.json() as { rearmed: number; skipped_past: number; skipped_tombstone: number; failed: number };
    assert.equal(data.rearmed, 0, "tombstone NÃO deve ser re-armado (#2235 fix)");
    assert.equal(data.skipped_tombstone, 1, "tombstone deve ser contado em skipped_tombstone (F10 observabilidade)");
    assert.equal(data.skipped_past, 0, "tombstone NÃO deve ser contado em skipped_past (separado por F10)");
    assert.equal(data.failed, 0);

    // Tombstone deve ter sido DELETADO do KV (anti-acúmulo fix F4)
    assert.equal(kv.store.has(queueKey), false, "tombstone deve ser deletado pelo rearm (#2235 fix F4)");

    // DO NÃO deve ter alarm agendado pra o tombstone
    const doEntry = doNamespace.stubs.get(queueKey);
    if (doEntry) {
      assert.equal(doEntry.state.storage.alarmMs, null, "alarm NÃO deve ser agendado pra item com tombstone");
    }
    // Se doEntry é undefined (DO nunca foi acessado), também está correto — significa
    // que handleRearm nem tentou armar o DO pra este item.
  });

  it("rearm arma item futuro normal, deleta tombstone no mesmo KV, retorna counters separados", async () => {
    // (#2235 fix F4+F10) Garante que o fix não quebra o caso normal: 1 item válido + 1 tombstone.
    // Espera: rearmed=1, skipped_tombstone=1, tombstone deletado do KV.
    const { env, kv, doNamespace } = mkEnvWithDO();

    // Item válido
    const future1 = new Date(Date.now() + 3600_000).toISOString();
    const key1 = buildQueueKey(future1, "uuid-valid-rearm");
    const validEntry: QueueEntry = {
      text: "post válido", image_url: null, scheduled_at: future1,
      destaque: "d1", created_at: new Date().toISOString(), retry_count: 0,
    };
    kv.store.set(key1, JSON.stringify(validEntry));

    // Tombstone (item cancelado com cancelled=true, também no futuro)
    const future2 = new Date(Date.now() + 7200_000).toISOString();
    const key2 = buildQueueKey(future2, "uuid-tombstone-rearm-2");
    const tombstoneEntry: QueueEntry & { cancelled: boolean } = {
      text: "item cancelado", image_url: null, scheduled_at: future2,
      destaque: "d2", created_at: new Date().toISOString(), retry_count: 0,
      cancelled: true,
    };
    kv.store.set(key2, JSON.stringify(tombstoneEntry));

    const req = authedRequest("https://w.test/rearm", { method: "POST" });
    const res = await workerDefault.fetch(req, env);
    const data = await res.json() as { rearmed: number; skipped_past: number; skipped_tombstone: number };

    // Apenas item válido re-armado; tombstone deletado
    assert.equal(data.rearmed, 1, "apenas 1 item (válido) deve ser re-armado");
    assert.equal(data.skipped_tombstone, 1, "tombstone deve ser contado em skipped_tombstone (não skipped_past)");
    assert.equal(data.skipped_past, 0, "nenhum item passado — só o tombstone (que vai pra skipped_tombstone)");

    // Tombstone deve ter sido DELETADO do KV (anti-acúmulo fix F4)
    assert.equal(kv.store.has(key2), false, "tombstone deve ser deletado pelo rearm (#2235 fix F4)");

    // DO do item válido deve ter alarm
    const doEntry1 = doNamespace.stubs.get(key1);
    assert.ok(doEntry1, "DO do item válido deve existir");
    assert.ok(doEntry1.state.storage.alarmMs !== null, "alarm do item válido deve estar agendado");

    // DO do tombstone NÃO deve ter alarm (ou não foi acessado)
    const doEntry2 = doNamespace.stubs.get(key2);
    if (doEntry2) {
      assert.equal(doEntry2.state.storage.alarmMs, null, "tombstone NÃO deve ter alarm agendado");
    }
  });
});

// ── #2245 — handleRearm: tombstone com scheduled_at PASSADO deve ser deletado ──

describe("#2245 handleRearm: deleta tombstone com scheduled_at passado (além de futuro)", () => {
  it("rearm deleta tombstone com scheduled_at passado — não deixa stale no KV", async () => {
    /**
     * REGRESSÃO #2245 finding 3:
     * handleRearm verificava `scheduledMs <= now` ANTES de checar `entry.cancelled`.
     * Um tombstone com scheduled_at no passado caía em `skippedPast++; continue` —
     * era ignorado SEM ser deletado, acumulando no KV indefinidamente.
     *
     * O cron limpa tombstones PASSADOS quando processa itens que chegam na hora,
     * mas não tem garantia de limpar tombstones cujo scheduled_at já passou E o
     * alarm foi cancelado (o DO alarm nunca disparou — cancelled antes do fire).
     * Esses tombstones passados ficam como lixo permanente no KV.
     *
     * Fix (#2245): verificar `entry.cancelled` ANTES de checar o passado —
     * tombstone passado ou futuro → deletar sempre (skipped_tombstone, não skipped_past).
     */
    const { env, kv } = mkEnvWithDO();

    // Gravar tombstone com scheduled_at NO PASSADO
    const past = new Date(Date.now() - 3600_000).toISOString(); // 1h atrás
    const queueKey = buildQueueKey(past, "uuid-tombstone-past-rearm");
    const tombstonePastEntry: QueueEntry & { cancelled: boolean } = {
      text: "item cancelado passado", image_url: null, scheduled_at: past,
      destaque: "d1", created_at: new Date(Date.now() - 7200_000).toISOString(), retry_count: 0,
      cancelled: true,
    };
    kv.store.set(queueKey, JSON.stringify(tombstonePastEntry));

    // /rearm deve deletar o tombstone passado + retornar skipped_tombstone=1, skipped_past=0
    const req = authedRequest("https://w.test/rearm", { method: "POST" });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 200, "rearm deve retornar 200");

    const data = await res.json() as { rearmed: number; skipped_past: number; skipped_tombstone: number; failed: number };
    assert.equal(data.rearmed, 0, "tombstone passado NÃO deve ser re-armado");
    assert.equal(
      data.skipped_tombstone,
      1,
      "tombstone passado deve ser contado em skipped_tombstone, não skipped_past — got skipped_tombstone=" +
        String(data.skipped_tombstone) + " skipped_past=" + String(data.skipped_past),
    );
    assert.equal(data.skipped_past, 0, "tombstone passado NÃO deve ir para skipped_past");
    assert.equal(data.failed, 0);

    // Tombstone passado deve ter sido DELETADO do KV (fix #2245)
    assert.equal(
      kv.store.has(queueKey),
      false,
      "tombstone passado deve ser deletado pelo rearm (#2245 fix) — antes ficava stale",
    );
  });

  it("rearm: 1 tombstone passado + 1 item passado válido → tombstone deletado, item válido em skipped_past", async () => {
    /**
     * Distingue tombstone passado (→ deletado, skipped_tombstone) de
     * item válido passado sem tombstone (→ skipped_past, deixado para o cron).
     */
    const { env, kv } = mkEnvWithDO();

    // Item passado válido (sem cancelled=true) — deve ser skipped_past, não deletado
    const past1 = new Date(Date.now() - 3600_000).toISOString();
    const keyPast = buildQueueKey(past1, "uuid-past-valid-rearm");
    const pastValidEntry: QueueEntry = {
      text: "item válido passado", image_url: null, scheduled_at: past1,
      destaque: "d2", created_at: new Date(Date.now() - 7200_000).toISOString(), retry_count: 0,
    };
    kv.store.set(keyPast, JSON.stringify(pastValidEntry));

    // Tombstone passado (cancelled=true) — deve ser deletado
    const past2 = new Date(Date.now() - 1800_000).toISOString();
    const keyTombPast = buildQueueKey(past2, "uuid-tombstone-past2-rearm");
    const tombPastEntry: QueueEntry & { cancelled: boolean } = {
      text: "item cancelado passado 2", image_url: null, scheduled_at: past2,
      destaque: "d1", created_at: new Date(Date.now() - 5400_000).toISOString(), retry_count: 0,
      cancelled: true,
    };
    kv.store.set(keyTombPast, JSON.stringify(tombPastEntry));

    const req = authedRequest("https://w.test/rearm", { method: "POST" });
    const res = await workerDefault.fetch(req, env);
    const data = await res.json() as { rearmed: number; skipped_past: number; skipped_tombstone: number; failed: number };

    assert.equal(data.rearmed, 0, "nenhum item deve ser re-armado (ambos no passado)");
    assert.equal(data.skipped_past, 1, "item válido passado → skipped_past=1 (deixado pro cron)");
    assert.equal(data.skipped_tombstone, 1, "tombstone passado → skipped_tombstone=1 (deletado)");
    assert.equal(data.failed, 0);

    // Item válido passado deve PERMANECER no KV (cron vai processar)
    assert.equal(kv.store.has(keyPast), true, "item válido passado deve permanecer no KV para o cron");

    // Tombstone passado deve ter sido DELETADO
    assert.equal(kv.store.has(keyTombPast), false, "tombstone passado deve ser deletado pelo rearm (#2245)");
  });
});
