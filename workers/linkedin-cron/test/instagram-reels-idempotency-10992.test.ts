/**
 * #10992 — três buracos no enqueue idempotente / dedup de Reels:
 *   1. 202 sem efeito depois do disparo: o DO da key guarda `fired=true`, o
 *      re-POST regravava, re-armava e respondia 202 `alarm_armed: true`, mas
 *      `tryClaim()` recusava e nada saía (idem `replaced: true` na janela entre
 *      o alarm e a limpeza do cron).
 *   2. Chave sem horário: a queue key leva o `scheduled_at`, então o mesmo
 *      pedido em outro slot criava 2ª entry/DO e saíam 2 Reels.
 *   3. Limite de taxa da Graph (códigos 4/17/32/613, HTTP 400/403) caía em
 *      "pode publicar" sem a busca prévia.
 *
 * DO REAL (`LinkedInScheduler` sobre storage em memória), KV em memória e
 * Graph falsa — nada ao vivo.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { type Env, type QueueEntry, idempotencyIndexName, idempotentQueueUuid } from "../src/index.ts";
import { __test__ } from "../src/index.ts";
import { LinkedInScheduler, type DoStoredPayload } from "../src/durable-object.ts";
import { fireQueueEntry, findPublishedReel, isGraphTransientError, type FireConfig } from "../src/dispatch.ts";

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
    this.store.clear();
  }
  async setAlarm(ms: number): Promise<void> {
    this.alarmMs = ms;
  }
  async deleteAlarm(): Promise<void> {
    this.alarmMs = null;
  }
}

class MockDOState {
  storage = new MockDOStorage();
  private q: Promise<unknown> = Promise.resolve();
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.q.then(() => fn());
    this.q = next.then(() => undefined, () => undefined);
    return next;
  }
}

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(opts: { prefix?: string }): Promise<{ keys: { name: string }[]; list_complete: true }> {
    const names = [...this.store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
    return { keys: names.map((name) => ({ name })), list_complete: true };
  }
}

function mkEnv() {
  const kv = new MockKV();
  const dos = new Map<string, { scheduler: LinkedInScheduler; state: MockDOState }>();
  const getOrCreate = (name: string) => {
    if (!dos.has(name)) {
      const state = new MockDOState();
      dos.set(name, { state, scheduler: new LinkedInScheduler(state as unknown as DurableObjectState) });
    }
    return dos.get(name)!;
  };
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string | Request, init?: RequestInit) =>
        getOrCreate(id.name).scheduler.fetch(typeof url === "string" ? new Request(url, init) : url),
    }),
  };
  const env = {
    LINKEDIN_QUEUE: kv as unknown as KVNamespace,
    LINKEDIN_SCHEDULER: ns as unknown as DurableObjectNamespace,
    DIARIA_TOKEN: "secret-token",
    MAKE_WEBHOOK_URL: "https://make.test/diaria",
    INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig-diaria",
    INSTAGRAM_ACCESS_TOKEN: "token-diaria",
    INSTAGRAM_VJPIXEL_ACCOUNT_ID: "ig-vjpixel",
    INSTAGRAM_VJPIXEL_ACCESS_TOKEN: "token-vjpixel",
  } as Env;
  return { env, kv, dos, getOrCreate };
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

const DUE = new Date(Date.now() - 60_000).toISOString();
const LATER_1 = new Date(Date.now() + 3 * 3_600_000).toISOString();
const LATER_2 = new Date(Date.now() + 5 * 3_600_000).toISOString();
const IDEM = "shorts-instagram-261022-vjpixel";
const reels = (over: Record<string, unknown> = {}) => ({
  text: "O vídeo de hoje",
  scheduled_at: DUE,
  destaque: "shorts",
  channel: "instagram",
  media_type: "REELS",
  video_url: "https://eia.diar.ia.br/video/261022-short.mp4",
  ig_account: "vjpixel",
  idempotency_key: IDEM,
  ...over,
});

/** Graph falsa: conta publishes; lista de mídias vazia (ou resposta forçada). */
function mockGraph(mediaList?: () => Response) {
  let publishes = 0;
  let containers = 0;
  globalThis.fetch = (async (url: string | Request) => {
    const u = typeof url === "string" ? url : url.url;
    if (/\/media\?fields=/.test(u)) return mediaList ? mediaList() : new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (u.endsWith("/media_publish")) {
      publishes++;
      return new Response(JSON.stringify({ id: `reel-${publishes}` }), { status: 200 });
    }
    if (u.includes("status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
    if (/\/media(\?|$)/.test(u)) {
      containers++;
      return new Response(JSON.stringify({ id: `container-${containers}` }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { publishes: () => publishes, containers: () => containers };
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("#10992 item 1 — re-POST depois do disparo não responde 202 sem efeito", () => {
  it("disparo pelo cron (KV limpo) + mesmo pedido de novo → 409 already_fired, nada re-armado", async () => {
    const { env, kv, getOrCreate } = mkEnv();
    const graph = mockGraph();
    const first = await enqueue(env, reels());
    assert.equal(first.status, 202);
    const { key } = (await first.json()) as { key: string };
    await __test__.fireDueItems(env);
    assert.equal(graph.publishes(), 1);
    assert.equal(kv.store.has(key), false, "cron limpou a entry");

    const again = await enqueue(env, reels());
    assert.equal(again.status, 409, "antes: 202 alarm_armed:true para algo que nunca sai");
    const body = (await again.json()) as { error: string; key: string };
    assert.equal(body.error, "already_fired");
    assert.equal(body.key, key);
    assert.equal(kv.store.has(key), false, "nada regravado");
    assert.equal(getOrCreate(key).state.storage.store.has("payload"), false, "DO não recebeu payload novo");
  });

  it("janela alarm→cron: legenda nova com o DO já disparado → 409, não `replaced: true`", async () => {
    const { env, kv, getOrCreate } = mkEnv();
    const graph = mockGraph();
    const first = await enqueue(env, reels({ scheduled_at: LATER_1 }));
    const { key } = (await first.json()) as { key: string };
    await getOrCreate(key).scheduler.alarm(); // o alarm dispara; a entry segue no KV até o cron
    assert.equal(graph.publishes(), 1);
    assert.ok(kv.store.has(key));

    const again = await enqueue(env, reels({ scheduled_at: LATER_1, text: "Legenda corrigida" }));
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, "already_fired");
  });

  it("retry exato com a entry ainda no KV e DO disparado → 200 duplicate com fired:true", async () => {
    const { env, getOrCreate } = mkEnv();
    mockGraph();
    const first = await enqueue(env, reels({ scheduled_at: LATER_1 }));
    const { key } = (await first.json()) as { key: string };
    await getOrCreate(key).scheduler.alarm();
    const again = await enqueue(env, reels({ scheduled_at: LATER_1 }));
    assert.equal(again.status, 200);
    const body = (await again.json()) as { duplicate?: boolean; fired?: boolean };
    assert.equal(body.duplicate, true);
    assert.equal(body.fired, true);
  });

  it("disparo em andamento (claim vivo) + conteúdo novo → 409 fire_in_progress", async () => {
    const { env, getOrCreate } = mkEnv();
    const first = await enqueue(env, reels({ scheduled_at: LATER_1 }));
    const { key } = (await first.json()) as { key: string };
    const st = getOrCreate(key).state.storage;
    await st.put("claiming", true);
    await st.put("claimed_at", Date.now());
    const again = await enqueue(env, reels({ scheduled_at: LATER_1, text: "Outra" }));
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, "fire_in_progress");
  });

  for (const claiming of [true, false]) {
    it(`#11044 — /arm 409 (claiming=${claiming}) restaura KV e retry não é duplicate`, async () => {
      const { env, kv, getOrCreate } = mkEnv();
      const first = await enqueue(env, reels({ scheduled_at: LATER_1 }));
      const { key } = await first.json() as { key: string };
      const previousRaw = kv.store.get(key);
      const scheduler = getOrCreate(key).scheduler;
      const original = scheduler.fetch.bind(scheduler);
      scheduler.fetch = async (request: Request) => {
        if (new URL(request.url).pathname === "/arm") {
          assert.equal(JSON.parse(kv.store.get(key)!).text, "Legenda corrigida");
          await getOrCreate(key).state.storage.put(claiming ? "claiming" : "fired", true);
          if (claiming) await getOrCreate(key).state.storage.put("claimed_at", Date.now());
          return new Response(JSON.stringify({ claiming }), { status: 409 });
        }
        return original(request);
      };
      const changed = reels({ scheduled_at: LATER_1, text: "Legenda corrigida" });
      const conflict = await enqueue(env, changed);
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json() as { error: string }).error, claiming ? "fire_in_progress" : "already_fired");
      assert.equal(kv.store.get(key), previousRaw);
      const retry = await enqueue(env, changed);
      assert.equal(retry.status, 409);
      assert.equal((await retry.json() as { duplicate?: boolean }).duplicate, undefined);
      assert.equal(kv.store.get(key), previousRaw);
    });
  }

  it("#11044 — /arm 409 sem entry anterior remove o put rejeitado", async () => {
    const { env, kv } = mkEnv();
    env.LINKEDIN_SCHEDULER = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (url: string) => new Response(
          JSON.stringify(url.endsWith("/arm") ? { claiming: true } : {}),
          { status: url.endsWith("/arm") ? 409 : 200 },
        ),
      }),
    } as unknown as DurableObjectNamespace;
    const response = await enqueue(env, reels({ scheduled_at: LATER_1 }));
    assert.equal(response.status, 409);
    assert.equal([...kv.store.keys()].filter((key) => key.startsWith("queue:")).length, 0);
  });

  it("DO: /arm em DO já disparado devolve 409 e não re-arma (2ª linha, atômica)", async () => {
    const state = new MockDOState();
    const scheduler = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("fired", true);
    const payload: DoStoredPayload & { scheduledAtMs: number } = {
      scheduledAtMs: Date.now() + 60_000,
      key: "queue:2026-12-01T17:00:00.000Z:x",
      entry: { text: "t", image_url: null, scheduled_at: "2026-12-01T17:00:00.000Z", destaque: "d1", created_at: "x", retry_count: 0 },
      webhookUrl: "https://make.test/webhook",
    };
    const res = await scheduler.fetch(new Request("https://do/arm", { method: "POST", body: JSON.stringify(payload) }));
    assert.equal(res.status, 409);
    assert.equal(state.storage.alarmMs, null);
    assert.equal(state.storage.store.has("payload"), false);
  });

  it("enqueue sem idempotency_key segue igual (202)", async () => {
    const { env } = mkEnv();
    const { idempotency_key: _drop, ...plain } = reels({ scheduled_at: LATER_1 });
    void _drop;
    const res = await enqueue(env, plain);
    assert.equal(res.status, 202);
  });
});

describe("#10992 item 2 — mesmo pedido em outro horário substitui a entry anterior", () => {
  it("re-execução com outro slot e legenda corrigida → 1 entry, DO antigo cancelado, 1 Reels só", async () => {
    const { env, kv, getOrCreate } = mkEnv();
    const first = await enqueue(env, reels({ scheduled_at: LATER_1 }));
    const k1 = ((await first.json()) as { key: string }).key;

    const second = await enqueue(env, reels({ scheduled_at: LATER_2, text: "Legenda corrigida" }));
    assert.equal(second.status, 202);
    const body = (await second.json()) as { key: string; replaced?: boolean; previous_key?: string };
    assert.notEqual(body.key, k1);
    assert.equal(body.replaced, true);
    assert.equal(body.previous_key, k1);
    assert.deepEqual([...kv.store.keys()].filter((k) => k.startsWith("queue:")), [body.key], "só a entry nova na fila");
    assert.equal(getOrCreate(k1).state.storage.alarmMs, null, "alarm antigo cancelado");
    assert.equal(getOrCreate(k1).state.storage.store.has("payload"), false);

    const graph = mockGraph();
    await getOrCreate(k1).scheduler.alarm(); // alarm antigo que já estava na fila do CF
    await getOrCreate(body.key).scheduler.alarm();
    assert.equal(graph.publishes(), 1, "antes: 2 Reels (um por key/DO)");
  });

  it("o índice aponta a key atual", async () => {
    const { env, getOrCreate } = mkEnv();
    const res = await enqueue(env, reels({ scheduled_at: LATER_1 }));
    const { key } = (await res.json()) as { key: string };
    const indexName = idempotencyIndexName(await idempotentQueueUuid(IDEM));
    assert.equal(getOrCreate(indexName).state.storage.store.get("idem_queue_key"), key);
  });

  it("horário anterior já disparado → 409 already_fired com a key anterior, nada novo na fila", async () => {
    const { env, kv } = mkEnv();
    const graph = mockGraph();
    const first = await enqueue(env, reels());
    const k1 = ((await first.json()) as { key: string }).key;
    await __test__.fireDueItems(env);
    assert.equal(graph.publishes(), 1);

    const again = await enqueue(env, reels({ scheduled_at: LATER_2 }));
    assert.equal(again.status, 409);
    const body = (await again.json()) as { error: string; key: string };
    assert.equal(body.error, "already_fired");
    assert.equal(body.key, k1);
    assert.equal([...kv.store.keys()].filter((k) => k.startsWith("queue:")).length, 0);
  });
});

describe("#10992 item 3 — limite de taxa da Graph é transitório", () => {
  const config: FireConfig = {
    webhookUrl: "https://make.test/diaria",
    instagram: { igUserId: "ig-diaria", accessToken: "token-diaria", apiVersion: "v25.0" },
    reelsPollIntervalMs: 0,
  };
  const entry: QueueEntry = {
    text: "O vídeo de hoje",
    image_url: null,
    scheduled_at: DUE,
    destaque: "shorts",
    created_at: DUE,
    retry_count: 1,
    channel: "instagram",
    media_type: "REELS",
    video_url: "https://eia.diar.ia.br/video/261022-short.mp4",
  };

  for (const [status, code] of [[400, 4], [403, 17], [400, 32], [400, 613], [403, 80002]] as const) {
    it(`busca de dedup com HTTP ${status} code ${code} → failed, sem container nem publish`, async () => {
      const graph = mockGraph(
        () => new Response(JSON.stringify({ error: { message: "rate limit", code } }), { status }),
      );
      const out = await fireQueueEntry(entry, config);
      assert.equal(out.status, "failed", "antes: publicava sem a busca prévia");
      assert.match((out as { reason: string }).reason, /dedup inconclusivo/);
      assert.equal(graph.containers(), 0);
      assert.equal(graph.publishes(), 0);
    });
  }

  it("recusa definitiva (403 code 10, sem permissão) segue publicando como antes", async () => {
    const graph = mockGraph(() => new Response(JSON.stringify({ error: { message: "(#10) permission", code: 10 } }), { status: 403 }));
    const out = await fireQueueEntry(entry, config);
    assert.deepEqual(out, { status: "fired" });
    assert.equal(graph.publishes(), 1);
  });

  it("findPublishedReel marca is_transient:true como transitório", async () => {
    mockGraph(() => new Response(JSON.stringify({ error: { message: "x", code: 2, is_transient: true } }), { status: 400 }));
    const r = await findPublishedReel("https://graph.facebook.com/v25.0", config.instagram!, "x", 0);
    assert.deepEqual(r.kind === "unverifiable" && r.transient, true);
  });

  it("isGraphTransientError", () => {
    assert.equal(isGraphTransientError({ code: 4 }), true);
    assert.equal(isGraphTransientError({ code: 80014 }), true);
    assert.equal(isGraphTransientError({ code: 80015 }), false);
    assert.equal(isGraphTransientError({ code: 190 }), false);
    assert.equal(isGraphTransientError(undefined), false);
  });
});
