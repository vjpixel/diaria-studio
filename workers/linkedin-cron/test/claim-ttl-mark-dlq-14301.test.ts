/**
 * #14301 — dois buracos que dependem do claim do DO vencer pelo TTL
 * (`CLAIM_TTL_MS`, 300 s) com um disparo ainda em curso.
 *
 * 1. Teto de tempo antes do publish. O #14219 pôs `CAROUSEL_PREPUBLISH_DEADLINE_MS`
 *    só no carrossel; a imagem única do Threads chamava o poll sem teto (pior
 *    caso ~378 s) e o documento/carrossel do LinkedIn não tinha teto nenhum.
 *    Com o claim vencido, outra volta disparava e o post saía 2 vezes.
 * 2. `/mark-dlq` marcava o DO sempre (o token só decidia o release), fora de
 *    `blockConcurrencyWhile`. Um `/mark-dlq` tardio depois de uma recuperação
 *    (`/cancel` + KV put + `/arm`) gravava o `dlq_reason` antigo e apagava o
 *    payload novo: a volta seguinte movia a entry nova pra DLQ sem disparar.
 *    Com o post já publicado, deixava `fired` e `dlq_reason` juntos.
 *
 * Graph da Meta e APIs do LinkedIn mockadas; nenhuma chamada real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { CLAIM_TTL_MS, FETCH_TIMEOUT_MS, type Env, type QueueEntry, __test__ } from "../src/index.ts";
import { LinkedInScheduler, type DoStoredPayload } from "../src/durable-object.ts";
import { CAROUSEL_PREPUBLISH_DEADLINE_MS, fireQueueEntry } from "../src/dispatch.ts";

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

let originalFetch: typeof fetch;
let realSetTimeout: typeof setTimeout;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  realSetTimeout = globalThis.setTimeout;
  // Os sleeps entre polls viram 0 ms; o tempo que conta é o do fetch mockado.
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = realSetTimeout;
});

const wait = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
const urlOf = (url: string | Request) => (typeof url === "string" ? url : url.url);

// ── 1. Teto de tempo antes do publish ───────────────────────────────────────

describe("#14301 item 1 — teto antes do publish fora do carrossel da Meta", () => {
  it("o teto + o publish cabem no TTL do claim (folga para o 1º comentário/consulta)", () => {
    assert.ok(CAROUSEL_PREPUBLISH_DEADLINE_MS + 2 * FETCH_TIMEOUT_MS < CLAIM_TTL_MS);
  });

  it("Threads imagem única com a Graph lenta: para no teto, não publica e não gasta as 10 tentativas", async () => {
    const g = { polls: 0, publishes: 0 };
    globalThis.fetch = (async (url: string | Request) => {
      const u = urlOf(url);
      if (u.endsWith("/threads_publish")) {
        g.publishes++;
        return new Response(JSON.stringify({ id: "th-1" }), { status: 200 });
      }
      if (u.includes("fields=status")) {
        g.polls++;
        await wait(15);
        return new Response(JSON.stringify({ status: "IN_PROGRESS" }), { status: 200 });
      }
      if (u.endsWith("/threads")) return new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const entry: QueueEntry = {
      text: "Legenda",
      image_url: "https://x.test/capa.jpg",
      scheduled_at: new Date().toISOString(),
      destaque: "d1",
      created_at: new Date().toISOString(),
      channel: "threads",
    };
    const outcome = await fireQueueEntry(entry, {
      webhookUrl: "https://make.test/diaria",
      threads: { userId: "th-user", accessToken: "th-token", apiVersion: "v1.0" },
      carouselDeadlineMs: 40,
    });
    assert.equal(outcome.status, "failed", "teto estourado antes do publish: nada saiu, retriable");
    assert.match((outcome as { reason: string }).reason, /teto total/);
    assert.equal(g.publishes, 0);
    assert.ok(g.polls < 10, `sem teto o poll ia até as 10 tentativas (fez ${g.polls})`);
  });

  /** APIs do LinkedIn: `slowMs` atrasa os passos antes do post. */
  function mockLinkedIn(slowMs: number) {
    const g = { posts: 0, inits: 0, puts: 0 };
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = urlOf(url);
      if (u.endsWith("/rest/posts")) {
        g.posts++;
        return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:1" } });
      }
      await wait(slowMs);
      if (u.includes("action=initializeUpload")) {
        g.inits++;
        const kind = u.includes("/rest/documents") ? "document" : "image";
        return new Response(
          JSON.stringify({ value: { uploadUrl: `https://up.test/${g.inits}`, [kind]: `urn:li:${kind}:${g.inits}` } }),
          { status: 200 },
        );
      }
      if (init?.method === "PUT") {
        g.puts++;
        return new Response("", { status: 201 });
      }
      if (u.endsWith(".pdf")) return new Response("%PDF-1.4 fake", { status: 200 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;
    return g;
  }

  const LINKEDIN = { accessToken: "li-token", authorUrn: "urn:li:organization:1", apiVersion: "202611" };
  const IMAGES = ["https://x.test/1.jpg", "https://x.test/2.jpg", "https://x.test/3.jpg"];

  it("LinkedIn carrossel com upload lento: dlq no teto, sem POST /rest/posts", async () => {
    const g = mockLinkedIn(15);
    const outcome = await fireQueueEntry(
      { text: "t", image_url: null, image_urls: IMAGES, scheduled_at: "", destaque: "d1", created_at: "" },
      { webhookUrl: "https://make.test/diaria", linkedin: LINKEDIN, carouselDeadlineMs: 40 },
    );
    assert.equal(outcome.status, "dlq");
    assert.match((outcome as { reason: string }).reason, /teto de .* antes do publish/);
    assert.equal(g.posts, 0, "nada publicado");
  });

  it("LinkedIn documento lento: o teto vale para o documento e para o fallback juntos — dlq, nenhum post", async () => {
    const g = mockLinkedIn(15);
    const outcome = await fireQueueEntry(
      {
        text: "t",
        image_url: null,
        image_urls: IMAGES,
        document_url: "https://x.test/doc.pdf",
        document_title: "Doc",
        scheduled_at: "",
        destaque: "d1",
        created_at: "",
      },
      { webhookUrl: "https://make.test/diaria", linkedin: LINKEDIN, carouselDeadlineMs: 25 },
    );
    assert.equal(outcome.status, "dlq");
    assert.match((outcome as { reason: string }).reason, /teto de/);
    assert.equal(g.posts, 0, "nem o documento nem o carrossel de fallback saem");
  });

  it("caminhos rápidos seguem publicando (teto não morde o caso normal)", async () => {
    const g = mockLinkedIn(0);
    const outcome = await fireQueueEntry(
      { text: "t", image_url: null, image_urls: IMAGES, document_url: "https://x.test/doc.pdf", document_title: "Doc", scheduled_at: "", destaque: "d1", created_at: "" },
      { webhookUrl: "https://make.test/diaria", linkedin: LINKEDIN },
    );
    assert.equal(outcome.status, "fired");
    assert.equal(g.posts, 1);
  });
});

// ── 2. /mark-dlq só com o token do dono ou com a mesma entry ────────────────

const ENTRY_A: QueueEntry = {
  text: "Legenda", image_url: null, image_urls: ["https://x.test/1.jpg", "https://x.test/2.jpg"],
  scheduled_at: "2026-11-27T12:00:00.000Z", destaque: "d1", created_at: "2026-11-27T10:00:00.000Z", channel: "instagram",
};
/** Recuperação (#14241): mesmo conteúdo, outro enqueue (`created_at` novo). */
const ENTRY_B: QueueEntry = { ...ENTRY_A, created_at: "2026-11-27T11:00:00.000Z" };

function mkDo() {
  const state = new MockState();
  const s = new LinkedInScheduler(state as unknown as DurableObjectState);
  const markDlq = async (body: Record<string, unknown>) => {
    const res = await s.fetch(new Request("https://do/mark-dlq", { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { state, s, store: state.storage.store, markDlq };
}

describe("#14301 item 2 — /mark-dlq não envenena o DO", () => {
  it("tardio, sem claim, com o DO já re-armado com a entry da recuperação: recusa (replaced)", async () => {
    const { store, markDlq } = mkDo();
    store.set("payload", { key: "k", entry: ENTRY_B } as Partial<DoStoredPayload>);
    const r = await markDlq({ reason: "carrossel antigo falhou", claim_token: null, entry: ENTRY_A });
    assert.equal(r.status, 409);
    assert.equal(r.body.refused, "replaced");
    assert.equal(store.has("dlq_reason"), false);
    assert.equal(store.has("payload"), true, "payload novo intacto");
  });

  it("claim vencido pelo TTL e não retomado: o token deste cron ainda é o gravado → marca e libera", async () => {
    const { store, markDlq } = mkDo();
    store.set("payload", { key: "k", entry: ENTRY_A });
    store.set("claiming", true);
    store.set("claimed_at", Date.now() - CLAIM_TTL_MS - 1000);
    store.set("claim_token", "tok-cron");
    const r = await markDlq({ reason: "x", claim_token: "tok-cron", entry: ENTRY_A });
    assert.equal(r.status, 200);
    assert.equal(r.body.released, true);
    assert.equal(store.get("dlq_reason"), "x");
    assert.equal(store.has("claiming"), false);
  });

  it("fallback sem DO (token null), sem claim, mesma entry armada: marca (alarm tardio não refaz)", async () => {
    const { store, markDlq } = mkDo();
    store.set("payload", { key: "k", entry: { ...ENTRY_A, retry_count: 0 } });
    const r = await markDlq({ reason: "x", claim_token: null, entry: { ...ENTRY_A, retry_count: 4 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.released, false);
    assert.equal(store.get("dlq_reason"), "x");
    assert.equal(store.has("payload"), false);
  });

  it("sem claim e sem `entry` no body, com payload armado: recusa (não sabe se é a mesma)", async () => {
    const { store, markDlq } = mkDo();
    store.set("payload", { key: "k", entry: ENTRY_A });
    const r = await markDlq({ reason: "x", claim_token: null });
    assert.equal(r.status, 409);
    assert.equal(r.body.refused, "replaced");
    assert.equal(store.has("dlq_reason"), false);
  });

  it("reserva de substituição viva (cancel com replacement_token): recusa (claiming)", async () => {
    const { store, markDlq } = mkDo();
    store.set("replacement_token", "rep");
    store.set("replacement_entry", ENTRY_B);
    store.set("claiming", true);
    store.set("claimed_at", Date.now());
    const r = await markDlq({ reason: "x", claim_token: null, entry: ENTRY_A });
    assert.equal(r.status, 409);
    assert.equal(r.body.refused, "claiming");
    assert.equal(store.get("replacement_entry"), ENTRY_B);
  });

  it("DO já publicado por outra volta: recusa (fired) — nunca `fired` + `dlq_reason` juntos", async () => {
    const { store, markDlq } = mkDo();
    store.set("fired", true);
    const r = await markDlq({ reason: "x", claim_token: "tok", entry: ENTRY_A });
    assert.equal(r.status, 409);
    assert.equal(r.body.refused, "fired");
    assert.equal(store.has("dlq_reason"), false);
  });

  it("DO com envio ambíguo: recusa e devolve o motivo", async () => {
    const { store, markDlq } = mkDo();
    store.set("send_unknown", "[send_unknown] publish timeout");
    store.set("fired", true);
    const r = await markDlq({ reason: "x", claim_token: "tok", entry: ENTRY_A });
    assert.equal(r.status, 409);
    assert.equal(r.body.refused, "send_unknown");
    assert.equal(r.body.send_unknown, "[send_unknown] publish timeout");
    assert.equal(store.has("dlq_reason"), false);
  });
});

// ── Cenário fim a fim da issue ──────────────────────────────────────────────

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
    LINKEDIN_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init?: RequestInit) => get(id.name).scheduler.fetch(new Request(url, init)),
      }),
    },
  } as unknown as Env;
  return { env, store, get };
}

describe("#14301 fim a fim — claim vence no meio do carrossel e uma recuperação re-arma o DO", () => {
  it("o /mark-dlq tardio é recusado e a entry nova dispara na volta seguinte (antes: ia pra DLQ sem disparar)", async () => {
    const { env, store, get } = mkEnv();
    const res = await workerDefault.fetch(
      new Request("https://w.test/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
        body: JSON.stringify({ text: "Legenda", image_url: null, image_urls: CAROUSEL, scheduled_at: DUE, destaque: "d1", channel: "instagram" }),
      }),
      env,
    ) as Response;
    assert.equal(res.status, 202, await res.clone().text());
    const key = ((await res.json()) as { key: string }).key;
    const doStore = get(key).state.storage.store;

    const g = { children: 0, publishes: 0, failChild: true, recovered: false };
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = urlOf(url);
      const body = String(init?.body ?? "");
      if (u.endsWith("/media_publish")) {
        g.publishes++;
        return new Response(JSON.stringify({ id: `ig-media-${g.publishes}` }), { status: 200 });
      }
      if (u.includes("fields=status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
      if (u.endsWith("/media") && body.includes("is_carousel_item=true")) {
        g.children++;
        if (g.failChild && g.children === 2) {
          // Enquanto o cron ainda espera a Graph: o claim dele vence pelo TTL e
          // uma recuperação limpa o DO, grava a entry nova (mesmo conteúdo,
          // outro enqueue) e re-arma — o fluxo do #14241.
          doStore.set("claimed_at", Date.now() - CLAIM_TTL_MS - 1000);
          const armed = doStore.get("payload") as DoStoredPayload;
          const fresh: QueueEntry = { ...armed.entry, created_at: new Date(Date.now() + 1000).toISOString() };
          const stub = env.LINKEDIN_SCHEDULER.get(env.LINKEDIN_SCHEDULER.idFromName(key));
          const cancel = await stub.fetch("https://do/cancel", { method: "POST", body: JSON.stringify({ if_not_claiming: true }) });
          assert.equal(cancel.status, 200, "claim vencido não segura o cancel");
          await env.LINKEDIN_QUEUE.put(key, JSON.stringify(fresh));
          const arm = await stub.fetch("https://do/arm", { method: "POST", body: JSON.stringify({ ...armed, entry: fresh, scheduledAtMs: Date.now() }) });
          assert.equal(arm.status, 200);
          g.recovered = true;
          return new Response(JSON.stringify({ error: { message: "Invalid image" } }), { status: 400 });
        }
      }
      if (u.endsWith("/media")) return new Response(JSON.stringify({ id: `container-${g.children}` }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const r1 = await __test__.fireDueItems(env);
    assert.equal(g.recovered, true);
    assert.equal(r1.dlq, 0, "a entry nova não vai pra DLQ");
    assert.equal(doStore.has("dlq_reason"), false, "DO não envenenado pelo /mark-dlq tardio");
    assert.equal(doStore.has("payload"), true, "payload da recuperação intacto");
    assert.equal(store.has(key), true, "entry nova continua no KV");

    g.failChild = false;
    const r2 = await __test__.fireDueItems(env);
    assert.equal(r2.fired, 1, "a volta seguinte dispara a entry nova");
    assert.equal(g.publishes, 1);
    assert.equal([...store.keys()].filter((k) => k.startsWith("dlq:")).length, 0);
  });

  it("variante: outra volta já publicou (DO fired) e o cron de claim vencido termina em dlq → KV limpo, não vai pra DLQ", async () => {
    const { env, store, get } = mkEnv();
    const res = await workerDefault.fetch(
      new Request("https://w.test/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
        body: JSON.stringify({ text: "Legenda", image_url: null, image_urls: CAROUSEL, scheduled_at: DUE, destaque: "d1", channel: "instagram" }),
      }),
      env,
    ) as Response;
    const key = ((await res.json()) as { key: string }).key;
    const doStore = get(key).state.storage.store;

    let children = 0;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = urlOf(url);
      if (u.endsWith("/media") && String(init?.body ?? "").includes("is_carousel_item=true")) {
        children++;
        if (children === 2) {
          // O claim venceu e o alarm retomou e publicou (`fired` no DO).
          doStore.set("fired", true);
          doStore.delete("payload");
          doStore.delete("claiming");
          doStore.delete("claimed_at");
          doStore.delete("claim_token");
          return new Response(JSON.stringify({ error: { message: "timeout" } }), { status: 400 });
        }
        return new Response(JSON.stringify({ id: `c-${children}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
    }) as typeof fetch;

    const r = await __test__.fireDueItems(env);
    assert.equal(r.dlq, 0);
    assert.equal(doStore.has("dlq_reason"), false, "nunca fired + dlq_reason juntos");
    assert.equal(store.has(key), false, "KV limpo");
    assert.equal([...store.keys()].filter((k) => k.startsWith("dlq:")).length, 0, "post publicado não vai pra DLQ");
  });
});
