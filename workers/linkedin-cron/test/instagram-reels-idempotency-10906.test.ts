/**
 * #10906 — POST /queue idempotente.
 *
 * Cenário da issue: o Worker grava a entry e arma o DO, mas a resposta HTTP se
 * perde (timeout de 15 s, conexão caída depois do commit). O `postToWorkerQueue`
 * repete o MESMO POST. Antes, cada POST gerava uma key com uuid aleatório: 2
 * entries, 2 DOs, 2 Reels idênticos na conta (o dedup do #10877 não pega, os
 * dois containers ainda estão transcodificando). Com `idempotency_key`, o uuid
 * sai da chave e o 2º POST cai na mesma key.
 *
 * Tudo com mocks (KV em memória, Graph API falsa) — nada ao vivo.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, { type Env, type QueueEntry, idempotentQueueUuid, isLegacyKey, buildDlqKey } from "../src/index.ts";
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

/** DO falso: registra os nomes armados (1 DO por key, `idFromName`). */
function mockScheduler() {
  const armed: string[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string) => {
        const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (url.endsWith("/arm")) {
          armed.push(id.name);
          return ok({ armed: true });
        }
        // DO recém-armado: nada disparado ainda, o cron ganha o claim.
        if (url.endsWith("/status")) return ok({ fired: false, claiming: false, claimed_at: null });
        if (url.endsWith("/claim")) return ok({ claimed: true });
        return ok({ ok: true });
      },
    }),
  };
  return { ns, armed };
}

function mkEnv(): { env: Env; kv: MockKV; armed: string[] } {
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
  ...over,
});

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Graph API falsa: lista de mídias vazia (o dedup #10877 não acha nada), container FINISHED, publish conta. */
function mockGraph(): { publishes: () => number } {
  let publishes = 0;
  globalThis.fetch = (async (url: string | Request) => {
    const u = typeof url === "string" ? url : url.url;
    if (/\/media\?fields=/.test(u)) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (u.endsWith("/media_publish")) {
      publishes++;
      return new Response(JSON.stringify({ id: `reel-${publishes}` }), { status: 200 });
    }
    if (u.includes("status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
    if (u.endsWith("/media")) return new Response(JSON.stringify({ id: "reel-container" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { publishes: () => publishes };
}

describe("#10906 POST /queue idempotente", () => {
  it("2 POSTs iguais com idempotency_key → 1 entry, 1 DO, 1 Reels publicado", async () => {
    const { env, kv, armed } = mkEnv();
    const payload = reels({ idempotency_key: "shorts-instagram-261022-vjpixel" });

    const first = await enqueue(env, payload);
    assert.equal(first.status, 202, await first.clone().text());
    const firstBody = (await first.json()) as { key: string; duplicate?: boolean };
    assert.equal(firstBody.duplicate, undefined);

    // Retry do cliente depois da resposta perdida.
    const second = await enqueue(env, payload);
    assert.equal(second.status, 200, "duplicata: 200, nada novo enfileirado");
    const secondBody = (await second.json()) as { queued: boolean; key: string; duplicate?: boolean };
    assert.equal(secondBody.queued, true, "o cliente trata como sucesso (schema exige queued:true)");
    assert.equal(secondBody.duplicate, true);
    assert.equal(secondBody.key, firstBody.key, "mesma key devolvida");

    assert.equal(kv.store.size, 1, "uma entry só na fila");
    assert.deepEqual(armed, [firstBody.key], "um DO armado só (a duplicata não re-arma)");
    const stored = JSON.parse(kv.store.get(firstBody.key)!) as QueueEntry;
    assert.equal(stored.idempotency_key, "shorts-instagram-261022-vjpixel");

    const graph = mockGraph();
    const result = await __test__.fireDueItems(env);
    assert.equal(result.fired, 1);
    assert.equal(graph.publishes(), 1, "um Reels publicado, não dois");
  });

  it("controle (o bug): sem idempotency_key, 2 POSTs iguais → 2 entries e 2 Reels", async () => {
    const { env, kv } = mkEnv();
    assert.equal((await enqueue(env, reels())).status, 202);
    assert.equal((await enqueue(env, reels())).status, 202);
    assert.equal(kv.store.size, 2);
    const graph = mockGraph();
    await __test__.fireDueItems(env);
    assert.equal(graph.publishes(), 2, "comportamento antigo preservado pra quem não manda a chave");
  });

  it("chaves diferentes (outra conta) → entries diferentes", async () => {
    const { env, kv } = mkEnv();
    await enqueue(env, reels({ idempotency_key: "shorts-instagram-261022-vjpixel" }));
    await enqueue(env, reels({ idempotency_key: "shorts-instagram-261022-diaria", ig_account: "diaria", collaborators: undefined }));
    assert.equal(kv.store.size, 2);
  });

  it("idempotency_key inválida → 400, nada enfileirado", async () => {
    for (const bad of ["", "com espaço", "x".repeat(129), 42]) {
      const { env, kv } = mkEnv();
      const res = await enqueue(env, reels({ idempotency_key: bad }));
      assert.equal(res.status, 400, `esperava 400 para ${JSON.stringify(bad)}`);
      assert.match(((await res.json()) as { error: string }).error, /idempotency_key/);
      assert.equal(kv.store.size, 0);
    }
  });

  it("uuid determinístico no formato de uuid: key segue no schema novo e o DLQ preserva o segmento", async () => {
    const a = await idempotentQueueUuid("shorts-instagram-261022-vjpixel");
    assert.equal(a, await idempotentQueueUuid("shorts-instagram-261022-vjpixel"));
    assert.notEqual(a, await idempotentQueueUuid("shorts-instagram-261022-diaria"));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const key = `queue:2026-10-22T15:00:00.000Z:${a}`;
    assert.equal(isLegacyKey(key), false);
    assert.equal(buildDlqKey(key, "2026-10-22T15:00:00.000Z"), `dlq:2026-10-22T15:00:00.000Z:${a}`);
  });
});
