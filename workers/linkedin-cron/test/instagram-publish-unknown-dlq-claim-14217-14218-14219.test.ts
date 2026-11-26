/**
 * Regressões de 3 duplicações de post público no Worker `diaria-linkedin-cron`
 * (achadas na caça a bugs #14142). Graph da Meta mockada; nenhuma chamada real.
 *
 * #14217 — Instagram de imagem única: o `/media_publish` que falha só na
 * resposta (timeout, 5xx, 2xx sem id, corpo ilegível) virava `failed`, o
 * retry criava outro container e publicava de novo. Agora é `send_unknown`
 * (DLQ sem refazer), ou `fired` se o container já está `PUBLISHED`.
 *
 * #14218 — `dlq` no alarm do DO só liberava o claim: o cron via `fired=false`,
 * ganhava o claim e redisparava o carrossel inteiro. Agora o alarm grava
 * `dlq_reason` e o cron move a entry pra DLQ sem redisparar; a resposta
 * ambígua do publish do carrossel passa a ser `send_unknown`.
 *
 * #14219 — `/release-claim` apagava o claim de quem fosse (o dono de um claim
 * vencido pelo TTL apagava o de quem o retomou), e o poll do carrossel não
 * tinha teto de tempo abaixo do TTL de 5 min do claim.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { CLAIM_TTL_MS, FETCH_TIMEOUT_MS, type Env, type QueueEntry, __test__ } from "../src/index.ts";
import { LinkedInScheduler } from "../src/durable-object.ts";
import {
  CAROUSEL_PREPUBLISH_DEADLINE_MS,
  REELS_VERIFY_FETCH_TIMEOUT_MS,
  fireQueueEntry,
} from "../src/dispatch.ts";

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
const CAROUSEL = ["https://x.test/1.jpg", "https://x.test/2.jpg", "https://x.test/3.jpg"];

function mkEnv() {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
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
    INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig-user",
    INSTAGRAM_ACCESS_TOKEN: "ig-token",
    THREADS_USER_ID: "threads-user",
    THREADS_ACCESS_TOKEN: "threads-token",
    LINKEDIN_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init?: RequestInit) => get(id.name).scheduler.fetch(new Request(url, init)),
      }),
    },
  } as unknown as Env;
  return { env, store, get };
}

async function enqueue(env: Env, over: Record<string, unknown> = {}): Promise<string> {
  const res = await workerDefault.fetch(
    new Request("https://w.test/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
      body: JSON.stringify({
        text: "Legenda do destaque",
        image_url: "https://x.test/capa.jpg",
        scheduled_at: DUE,
        destaque: "d1",
        channel: "instagram",
        ...over,
      }),
    }),
    env,
  ) as Response;
  assert.equal(res.status, 202, await res.clone().text());
  return ((await res.json()) as { key: string }).key;
}

type PublishMode = "ok" | "timeout" | "502" | "200-no-id" | "200-not-json" | "400";

/**
 * Graph do Instagram: conta containers criados (filhos e pai) e chamadas de
 * publish. `published` = o que o `?fields=status_code` do container devolve
 * depois do publish (a Meta pode ter publicado com a resposta perdida).
 */
function mockGraph(opts: { publish?: PublishMode; containerStatus?: string; childFailAt?: number } = {}) {
  const g = { mediaPosts: 0, children: 0, publishes: 0 };
  globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.url;
    const body = String(init?.body ?? "");
    if (u.endsWith("/media_publish")) {
      g.publishes++;
      switch (opts.publish ?? "ok") {
        case "timeout": {
          const e = new Error("The operation was aborted due to timeout");
          e.name = "TimeoutError";
          throw e;
        }
        case "502": return new Response("<html>Bad Gateway</html>", { status: 502 });
        case "200-no-id": return new Response("{}", { status: 200 });
        case "200-not-json": return new Response("<html>", { status: 200 });
        case "400": return new Response(JSON.stringify({ error: { message: "Media ID is not available" } }), { status: 400 });
        default: return new Response(JSON.stringify({ id: `ig-media-${g.publishes}` }), { status: 200 });
      }
    }
    if (u.includes("fields=status_code")) {
      const status = g.publishes > 0 ? (opts.containerStatus ?? "FINISHED") : "FINISHED";
      return new Response(JSON.stringify({ status_code: status }), { status: 200 });
    }
    if (u.endsWith("/media")) {
      g.mediaPosts++;
      if (body.includes("is_carousel_item=true")) {
        g.children++;
        if (opts.childFailAt === g.children) {
          return new Response(JSON.stringify({ error: { message: "Invalid image" } }), { status: 400 });
        }
      }
      return new Response(JSON.stringify({ id: `container-${g.mediaPosts}` }), { status: 200 });
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

const dlqEntries = (store: Map<string, string>) =>
  [...store.entries()].filter(([k]) => k.startsWith("dlq:")).map(([, v]) => JSON.parse(v) as QueueEntry);

// ── #14217 ────────────────────────────────────────────────────────────────

describe("#14217 Instagram imagem única: media_publish ambíguo não é republicado", () => {
  for (const mode of ["timeout", "502", "200-no-id", "200-not-json"] as const) {
    it(`cron: ${mode} → DLQ send_unknown, 1 container e 1 publish só, mesmo com mais voltas`, async () => {
      const g = mockGraph({ publish: mode });
      const { env, store, get } = mkEnv();
      const key = await enqueue(env);

      const r1 = await __test__.fireDueItems(env);
      assert.equal(r1.dlq, 1);
      assert.equal(r1.errors, 0, "não entra no retry_count");
      assert.equal(store.has(key), false, "sai da fila");
      const dlq = dlqEntries(store);
      assert.equal(dlq.length, 1);
      assert.match(dlq[0].last_error ?? "", /^send_unknown: Instagram \/media_publish/);

      await __test__.fireDueItems(env);
      await get(key).scheduler.alarm();
      assert.equal(g.publishes, 1, "nenhuma 2ª chamada de publish");
      assert.equal(g.mediaPosts, 1, "nenhum container novo");
    });
  }

  it("alarm: timeout → DO send_unknown; o cron move pra DLQ sem refazer", async () => {
    const g = mockGraph({ publish: "timeout" });
    const { env, store, get } = mkEnv();
    const key = await enqueue(env);

    await get(key).scheduler.alarm();
    assert.match(String(get(key).state.storage.store.get("send_unknown")), /^send_unknown: /);

    const r = await __test__.fireDueItems(env);
    assert.equal(r.dlq, 1);
    assert.equal(store.has(key), false);
    assert.equal(g.publishes, 1);
    assert.equal(g.mediaPosts, 1);
  });

  it("ambíguo com o container PUBLISHED → fired, sem DLQ e sem republicar", async () => {
    const g = mockGraph({ publish: "502", containerStatus: "PUBLISHED" });
    const { env, store } = mkEnv();
    const key = await enqueue(env);

    const r = await __test__.fireDueItems(env);
    assert.equal(r.fired, 1);
    assert.equal(r.dlq, 0);
    assert.equal(store.has(key), false);
    assert.equal(dlqEntries(store).length, 0);
    await __test__.fireDueItems(env);
    assert.equal(g.publishes, 1);
  });

  it("400 definitivo no publish segue failed retriable (nada saiu)", async () => {
    mockGraph({ publish: "400" });
    const { env, store } = mkEnv();
    const key = await enqueue(env);
    const r = await __test__.fireDueItems(env);
    assert.equal(r.dlq, 0);
    assert.equal(r.errors, 1);
    assert.equal((JSON.parse(store.get(key)!) as QueueEntry).retry_count, 1);
  });

  it("caminho feliz intacto: fired com o id da mídia", async () => {
    const g = mockGraph();
    const out = await fireQueueEntry(
      { text: "x", image_url: "https://x.test/a.jpg", scheduled_at: DUE, destaque: "d1", created_at: DUE, retry_count: 0, channel: "instagram" },
      { webhookUrl: "", instagram: { igUserId: "u", accessToken: "t", apiVersion: "v1" } },
    );
    assert.equal(out.status, "fired");
    assert.equal(out.postId, "ig-media-1");
    assert.equal(g.publishes, 1);
  });
});

// ── #14218 ────────────────────────────────────────────────────────────────

describe("#14218 dlq no alarm não é redisparado pelo cron", () => {
  it("filho do carrossel falha no alarm → DO grava dlq_reason; o cron move pra DLQ sem recriar containers", async () => {
    const g = mockGraph({ childFailAt: 2 });
    const { env, store, get } = mkEnv();
    const key = await enqueue(env, { image_url: null, image_urls: CAROUSEL });

    await get(key).scheduler.alarm();
    const storage = get(key).state.storage.store;
    assert.match(String(storage.get("dlq_reason")), /child container 2\/3/);
    assert.equal(storage.has("claiming"), false, "claim liberado");
    assert.equal(storage.has("payload"), false, "payload apagado: alarm re-entrante não tem o que postar");
    const mediaAfterAlarm = g.mediaPosts;

    const r = await __test__.fireDueItems(env);
    assert.equal(r.dlq, 1);
    assert.equal(r.fired, 0);
    assert.equal(store.has(key), false);
    assert.match(dlqEntries(store)[0].last_error ?? "", /child container 2\/3/);
    assert.equal(g.mediaPosts, mediaAfterAlarm, "o cron não recria nenhum container");
    assert.equal(g.publishes, 0);

    // DO com dlq_reason recusa claim (alarm repetido e /claim).
    await get(key).scheduler.alarm();
    const claim = await get(key).scheduler.fetch(new Request("https://do/claim", { method: "POST" }));
    assert.equal(((await claim.json()) as { claimed: boolean }).claimed, false);
    assert.equal(g.mediaPosts, mediaAfterAlarm);
  });

  for (const mode of ["timeout", "502", "200-no-id"] as const) {
    it(`publish do carrossel ${mode} no alarm → send_unknown; o cron não roda o carrossel de novo`, async () => {
      const g = mockGraph({ publish: mode });
      const { env, store, get } = mkEnv();
      const key = await enqueue(env, { image_url: null, image_urls: CAROUSEL });

      await get(key).scheduler.alarm();
      assert.match(String(get(key).state.storage.store.get("send_unknown")), /^send_unknown: Instagram carrossel: media_publish/);
      assert.equal(g.mediaPosts, 4, "3 filhos + 1 pai");

      const r = await __test__.fireDueItems(env);
      assert.equal(r.dlq, 1);
      assert.equal(store.has(key), false);
      assert.equal(g.publishes, 1, "publish do pai uma vez só");
      assert.equal(g.mediaPosts, 4, "nenhum container novo (o carrossel não é refeito)");
    });
  }

  it("publish do carrossel com 400 segue dlq (nada saiu) e também não é redisparado", async () => {
    const g = mockGraph({ publish: "400" });
    const { env, store, get } = mkEnv();
    const key = await enqueue(env, { image_url: null, image_urls: CAROUSEL });
    await get(key).scheduler.alarm();
    assert.ok(get(key).state.storage.store.has("dlq_reason"));
    await __test__.fireDueItems(env);
    assert.equal(store.has(key), false);
    assert.equal(g.publishes, 1);
    assert.equal(g.mediaPosts, 4);
  });
});

// ── #14219 ────────────────────────────────────────────────────────────────

describe("#14219 /release-claim só libera o claim do próprio dono", () => {
  async function claim(s: LinkedInScheduler): Promise<{ claimed: boolean; claim_token?: string }> {
    const res = await s.fetch(new Request("https://do/claim", { method: "POST" }));
    return (await res.json()) as { claimed: boolean; claim_token?: string };
  }
  const release = (s: LinkedInScheduler, body?: unknown) =>
    s.fetch(new Request("https://do/release-claim", { method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) }));

  it("token do claim vencido não apaga o claim novo; sem token também não; o token certo libera", async () => {
    const state = new MockState();
    const s = new LinkedInScheduler(state as unknown as DurableObjectState);
    await state.storage.put("payload", { key: "k" });

    const a = await claim(s);
    assert.equal(a.claimed, true);
    assert.ok(a.claim_token);
    state.storage.store.set("claimed_at", Date.now() - CLAIM_TTL_MS - 1000); // A passou do TTL
    const b = await claim(s);
    assert.equal(b.claimed, true, "B retoma o claim vencido");
    assert.notEqual(b.claim_token, a.claim_token);

    const resA = await release(s, { claim_token: a.claim_token });
    assert.equal(((await resA.json()) as { released: boolean }).released, false);
    assert.equal(state.storage.store.get("claiming"), true, "o release atrasado de A não apaga o claim de B");
    assert.equal((await claim(s)).claimed, false, "C não ganha o claim enquanto B roda");

    await release(s);
    assert.equal(state.storage.store.get("claiming"), true, "release sem token não libera nada");

    const resB = await release(s, { claim_token: b.claim_token });
    assert.equal(((await resB.json()) as { released: boolean }).released, true);
    assert.equal(state.storage.store.has("claiming"), false);
    assert.equal(state.storage.store.has("claim_token"), false);
  });

  it("alarm cujo claim venceu e foi retomado pelo cron não libera o claim do cron ao falhar", async () => {
    const { env, get } = mkEnv();
    const key = await enqueue(env);
    const { scheduler, state } = get(key);
    let takeover: { claimed: boolean; claim_token?: string } | null = null;
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.endsWith("/media") && takeover === null) {
        // Durante o disparo do alarm o claim dele vence e o cron o retoma.
        state.storage.store.set("claimed_at", Date.now() - CLAIM_TTL_MS - 1000);
        takeover = await claim(scheduler);
        return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await scheduler.alarm();
    assert.equal(takeover?.claimed, true);
    assert.equal(state.storage.store.get("claiming"), true, "o claim do cron continua de pé");
    assert.equal(state.storage.store.get("claim_token"), takeover?.claim_token);
  });

  it("cron que perde o claim no meio não apaga o claim de quem o retomou", async () => {
    const { env, get, store } = mkEnv();
    const key = await enqueue(env);
    const { scheduler, state } = get(key);
    let thief: { claimed: boolean; claim_token?: string } | null = null;
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.endsWith("/media") && thief === null) {
        state.storage.store.set("claimed_at", Date.now() - CLAIM_TTL_MS - 1000);
        thief = await claim(scheduler);
        return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const r = await __test__.fireDueItems(env);
    assert.equal(r.errors, 1, "o disparo do cron falhou e foi pro retry");
    assert.equal(thief?.claimed, true);
    assert.equal(state.storage.store.get("claiming"), true, "o release do cron não apaga o claim alheio");
    assert.equal(state.storage.store.get("claim_token"), thief?.claim_token);
    assert.equal((JSON.parse(store.get(key)!) as QueueEntry).retry_count, 1);
  });
});

describe("#14219 teto de tempo do carrossel antes do publish", () => {
  it("o disparo inteiro do carrossel cabe no TTL do claim", () => {
    // pré-publish + publish + (consulta do container OU 1º comentário)
    const worst = CAROUSEL_PREPUBLISH_DEADLINE_MS + FETCH_TIMEOUT_MS + Math.max(REELS_VERIFY_FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MS);
    assert.ok(worst < CLAIM_TTL_MS, `${worst} ms >= CLAIM_TTL_MS ${CLAIM_TTL_MS} ms`);
  });

  /** Poll lento e sempre IN_PROGRESS: só o teto encerra o carrossel. */
  function slowInProgress(field: "status_code" | "status") {
    const g = { publishes: 0, polls: 0 };
    globalThis.fetch = (async (url: string | Request) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.endsWith("/media_publish") || u.endsWith("/threads_publish")) {
        g.publishes++;
        return new Response(JSON.stringify({ id: "p" }), { status: 200 });
      }
      if (u.includes("fields=status")) {
        g.polls++;
        await new Promise((r) => realSetTimeout(r, 25));
        return new Response(JSON.stringify({ [field]: "IN_PROGRESS" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "c" }), { status: 200 });
    }) as typeof fetch;
    return g;
  }
  const base = { text: "x", image_url: null, image_urls: CAROUSEL, scheduled_at: DUE, destaque: "d1", created_at: DUE, retry_count: 0 };

  it("Instagram: estourar o teto → dlq com o motivo, sem publish", async () => {
    const g = slowInProgress("status_code");
    const out = await fireQueueEntry(
      { ...base, channel: "instagram" } as QueueEntry,
      { webhookUrl: "", instagram: { igUserId: "u", accessToken: "t", apiVersion: "v1" }, carouselDeadlineMs: 60 },
    );
    assert.equal(out.status, "dlq");
    assert.match((out as { reason: string }).reason, /teto/);
    assert.equal(g.publishes, 0);
    assert.ok(g.polls < 10, `o teto corta o poll antes das 10 tentativas (polls=${g.polls})`);
  });

  it("Threads: estourar o teto → dlq com o motivo, sem publish", async () => {
    const g = slowInProgress("status");
    const out = await fireQueueEntry(
      { ...base, channel: "threads" } as QueueEntry,
      { webhookUrl: "", threads: { userId: "u", accessToken: "t", apiVersion: "v1.0" }, carouselDeadlineMs: 60 },
    );
    assert.equal(out.status, "dlq");
    assert.match((out as { reason: string }).reason, /teto/);
    assert.equal(g.publishes, 0);
    assert.ok(g.polls < 10, `o teto corta o poll antes das 10 tentativas (polls=${g.polls})`);
  });

  it("teto já estourado antes do 1º filho → dlq sem chamada nenhuma à Graph", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const out = await fireQueueEntry(
      { ...base, channel: "instagram" } as QueueEntry,
      { webhookUrl: "", instagram: { igUserId: "u", accessToken: "t", apiVersion: "v1" }, carouselDeadlineMs: 0 },
    );
    assert.equal(out.status, "dlq");
    assert.match((out as { reason: string }).reason, /child container 1\/3: teto/);
    assert.equal(calls, 0);
  });
});
