/**
 * #10917 — `idempotency_key` não pode tratar entry cancelada (tombstone) nem
 * conteúdo novo como duplicata.
 *
 * Cenário da issue: o editor cancela o Reels (DELETE /queue), o KV.delete
 * falha e vira tombstone `cancelled:true`; ele reenfileira no mesmo slot (ex.:
 * legenda nova). Antes, o Worker respondia `duplicate: true`, o cron apagava o
 * tombstone e o Reels nunca saía. Com entry viva e legenda nova, a legenda
 * nova era descartada em silêncio.
 *
 * Tudo com mocks (KV em memória, DO e Graph API falsos) — nada ao vivo.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { type Env, type QueueEntry, classifyIdempotentExisting } from "../src/index.ts";
import { __test__ } from "../src/index.ts";

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

/** DO falso: registra cada `/arm` (nome do DO + legenda do payload armado). */
function mockScheduler() {
  const armed: { name: string; text: string }[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: RequestInit) => {
        const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (url.endsWith("/arm")) {
          const p = JSON.parse(String(init?.body)) as { entry: QueueEntry };
          armed.push({ name: id.name, text: p.entry.text });
          return ok({ armed: true });
        }
        if (url.endsWith("/status")) return ok({ fired: false, claiming: false, claimed_at: null });
        if (url.endsWith("/claim")) return ok({ claimed: true });
        return ok({ ok: true });
      },
    }),
  };
  return { ns, armed };
}

function mkEnv() {
  const kv = new MockKV();
  const { ns, armed } = mockScheduler();
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
  return { env, kv, armed };
}

function enqueue(env: Env, payload: Record<string, unknown>): Promise<Response> {
  const req = new Request("https://w.test/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
    body: JSON.stringify(payload),
  });
  return workerDefault.fetch(req, env) as Promise<Response>;
}

// Já vencido: o cron dispara na mesma chamada de fireDueItems.
const DUE = new Date(Date.now() - 60_000).toISOString();
const reels = (over: Record<string, unknown> = {}) => ({
  text: "O vídeo de hoje",
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

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Graph falsa: guarda a URL de cada criação de container e conta os publishes. */
function mockGraph() {
  const containerCalls: string[] = [];
  let publishes = 0;
  globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.url;
    if (/\/media\?fields=/.test(u)) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (u.endsWith("/media_publish")) {
      publishes++;
      return new Response(JSON.stringify({ id: `reel-${publishes}` }), { status: 200 });
    }
    if (u.includes("status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
    if (/\/media(\?|$)/.test(u)) {
      containerCalls.push(`${u} ${String(init?.body ?? "")}`);
      return new Response(JSON.stringify({ id: "reel-container" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { publishes: () => publishes, containerCalls };
}

describe("#10917 reenfileirar com idempotency_key", () => {
  it("entry cancelada (tombstone) + reenfileirar → regrava, re-arma e o Reels sai", async () => {
    const { env, kv, armed } = mkEnv();
    const first = await enqueue(env, reels());
    assert.equal(first.status, 202);
    const { key } = (await first.json()) as { key: string };

    // DELETE /queue cujo KV.delete falhou 3x: sobra o tombstone.
    const tomb = JSON.parse(kv.store.get(key)!) as QueueEntry;
    tomb.cancelled = true;
    kv.store.set(key, JSON.stringify(tomb));

    const again = await enqueue(env, reels());
    assert.equal(again.status, 202, "reenfileirar depois do cancelamento é pedido novo, não duplicata");
    const body = (await again.json()) as { duplicate?: boolean; replaced?: boolean; key: string };
    assert.equal(body.duplicate, undefined);
    assert.equal(body.replaced, true);
    assert.equal(body.key, key);
    const stored = JSON.parse(kv.store.get(key)!) as QueueEntry;
    assert.equal(stored.cancelled, undefined, "tombstone removido da entry");
    assert.equal(armed.length, 2, "DO re-armado");

    const graph = mockGraph();
    const result = await __test__.fireDueItems(env);
    assert.equal(result.fired, 1);
    assert.equal(graph.publishes(), 1, "o Reels reenfileirado é publicado");
  });

  it("entry viva + legenda nova → mesma key, conteúdo novo, um Reels só com a legenda nova", async () => {
    const { env, kv, armed } = mkEnv();
    const first = await enqueue(env, reels());
    const { key } = (await first.json()) as { key: string };

    const again = await enqueue(env, reels({ text: "Legenda nova" }));
    assert.equal(again.status, 202);
    assert.equal(((await again.json()) as { replaced?: boolean }).replaced, true);
    assert.equal(kv.store.size, 1, "continua uma entry só");
    assert.equal((JSON.parse(kv.store.get(key)!) as QueueEntry).text, "Legenda nova");
    assert.deepEqual(armed.map((a) => a.name), [key, key], "mesmo DO, re-armado com o payload novo");
    assert.equal(armed[1].text, "Legenda nova");

    const graph = mockGraph();
    await __test__.fireDueItems(env);
    assert.equal(graph.publishes(), 1, "um Reels só");
    assert.ok(graph.containerCalls.length > 0, "container criado");
    const decoded = graph.containerCalls.map((c) => decodeURIComponent(c.replace(/\+/g, " "))).join("\n");
    assert.match(decoded, /Legenda nova/, "a legenda publicada é a nova");
    assert.doesNotMatch(decoded, /O vídeo de hoje/, "a legenda velha não sai");
  });

  it("mesmo conteúdo, entry viva → segue duplicata (#10906 preservado)", async () => {
    const { env, armed } = mkEnv();
    await enqueue(env, reels());
    const again = await enqueue(env, reels());
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { duplicate?: boolean }).duplicate, true);
    assert.equal(armed.length, 1);
  });
});

describe("#10917 classifyIdempotentExisting", () => {
  const base: QueueEntry = {
    text: "a",
    image_url: null,
    scheduled_at: "2026-10-22T15:00:00.000Z",
    destaque: "shorts",
    created_at: "2026-10-22T10:00:00.000Z",
    retry_count: 0,
  };
  it("campos de estado não contam como mudança de conteúdo", () => {
    const stored = { ...base, created_at: "2026-10-21T00:00:00.000Z", retry_count: 2 };
    assert.equal(classifyIdempotentExisting(JSON.stringify(stored), base), "duplicate");
  });
  it("tombstone vence mesmo com conteúdo igual", () => {
    assert.equal(classifyIdempotentExisting(JSON.stringify({ ...base, cancelled: true }), base), "cancelled");
  });
  it("conteúdo diferente ou entry ilegível → changed", () => {
    assert.equal(classifyIdempotentExisting(JSON.stringify({ ...base, video_url: "https://x/a.mp4" }), base), "changed");
    assert.equal(classifyIdempotentExisting("{não é json", base), "changed");
    assert.equal(classifyIdempotentExisting("null", base), "changed");
  });
});
