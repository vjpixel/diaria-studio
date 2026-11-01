/**
 * instagram-first-comment-11724.test.ts (#11724)
 *
 * O 4º post (USE MELHOR) no Instagram ganha um comentário com o permalink da
 * edição, publicado pelo Worker logo depois do `media_publish`
 * (`entry.first_comment`). Fail-soft: falha do comentário nunca muda o
 * outcome (o post já saiu; refazer o disparo duplicaria o post).
 *
 * Mesmo padrão de mocks de test/instagram-carousel.test.ts.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import workerDefault, {
  buildQueueKey,
  MAX_FIRST_COMMENT_LENGTH,
  validateFirstComment,
  __test__,
  type Env,
  type QueueEntry,
} from "../src/index.ts";

class MockKV {
  store = new Map<string, string>();
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
    const names = Array.from(this.store.keys()).filter((k) => k.startsWith(prefix)).sort();
    return { keys: names.map((name) => ({ name })), list_complete: true };
  }
}

function mkEnv(): { env: Env; kv: MockKV } {
  const kv = new MockKV();
  const env = {
    LINKEDIN_QUEUE: kv as unknown as KVNamespace,
    DIARIA_TOKEN: "secret-token",
    MAKE_WEBHOOK_URL: "https://make.test/diaria",
    INSTAGRAM_BUSINESS_ACCOUNT_ID: "17841422721183309",
    INSTAGRAM_ACCESS_TOKEN: "test-token",
  } as Env;
  return { env, kv };
}

function bodyOf(init: RequestInit | undefined): string {
  return init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
}

const COMMENT = "Edição completa: https://diar.ia.br/p/x?utm_source=instagram";

function entryFor(past: string, extra: Partial<QueueEntry>): QueueEntry {
  return {
    text: "Legenda do USE MELHOR",
    image_url: "https://poll.diaria.workers.dev/img/um-cover.jpg",
    scheduled_at: past,
    destaque: "um",
    created_at: past,
    retry_count: 0,
    channel: "instagram",
    ...extra,
  };
}

type Call = { url: string; method?: string; body: string; headers?: Record<string, string> };

function mockGraph(calls: Call[], commentResponse: () => Response | Promise<Response>): typeof fetch {
  let child = 0;
  return (async (url: string | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.url;
    const body = bodyOf(init);
    calls.push({ url: u, method: init?.method, body, headers: init?.headers as Record<string, string> | undefined });
    if (u.endsWith("/comments")) return commentResponse();
    if (u.endsWith("/media_publish")) return new Response(JSON.stringify({ id: "published-media-id" }), { status: 200 });
    if (u.includes("status_code")) return new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
    if (u.endsWith("/media") && body.includes("media_type=CAROUSEL")) {
      return new Response(JSON.stringify({ id: "parent-container" }), { status: 200 });
    }
    if (u.endsWith("/media")) return new Response(JSON.stringify({ id: `container-${++child}` }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

describe("#11724 Worker: comentário com o permalink depois do media_publish", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("imagem única: comenta no id publicado, com o token no header", async () => {
    const calls: Call[] = [];
    globalThis.fetch = mockGraph(calls, () => new Response(JSON.stringify({ id: "comment-id" }), { status: 200 }));
    const { env, kv } = mkEnv();
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = buildQueueKey(past, "uuid-um-single");
    kv.store.set(key, JSON.stringify(entryFor(past, { first_comment: COMMENT })));
    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      const comment = calls.find((c) => c.url.endsWith("/comments"));
      assert.ok(comment, "deve comentar");
      assert.match(comment!.url, /\/published-media-id\/comments$/);
      assert.equal(new URLSearchParams(comment!.body).get("message"), COMMENT);
      assert.ok(!comment!.url.includes("test-token") && !comment!.body.includes("test-token"), "token fora da URL/corpo (#7779)");
      assert.equal(comment!.headers?.Authorization, "Bearer test-token");
      const publishIdx = calls.findIndex((c) => c.url.endsWith("/media_publish"));
      assert.ok(publishIdx < calls.indexOf(comment!), "comentário vem depois do media_publish");
      assert.equal(kv.store.has(key), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("carrossel: comenta depois do media_publish do pai", async () => {
    const calls: Call[] = [];
    globalThis.fetch = mockGraph(calls, () => new Response(JSON.stringify({ id: "comment-id" }), { status: 200 }));
    const { env, kv } = mkEnv();
    const past = new Date(Date.now() - 60_000).toISOString();
    kv.store.set(
      buildQueueKey(past, "uuid-um-carousel"),
      JSON.stringify(entryFor(past, { first_comment: COMMENT, image_urls: ["https://x.test/a.jpg", "https://x.test/b.jpg"] })),
    );
    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      assert.equal(calls.filter((c) => c.url.endsWith("/comments")).length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falha do comentário (403 sem permissão, ou rede) NÃO derruba o post: segue fired, sem retry", async () => {
    const failures: Array<() => Response> = [
      () => new Response(JSON.stringify({ error: { message: "(#10) Application does not have permission for this action" } }), { status: 403 }),
      () => {
        throw new Error("rede caiu");
      },
    ];
    for (const fail of failures) {
      const calls: Call[] = [];
      globalThis.fetch = mockGraph(calls, fail);
      const { env, kv } = mkEnv();
      const past = new Date(Date.now() - 60_000).toISOString();
      const key = buildQueueKey(past, "uuid-um-fail");
      kv.store.set(key, JSON.stringify(entryFor(past, { first_comment: COMMENT })));
      try {
        const result = await __test__.fireDueItems(env);
        assert.equal(result.fired, 1);
        assert.equal(result.dlq, 0);
        assert.equal(result.errors, 0);
        assert.equal(kv.store.has(key), false, "item disparado sai da fila (nada a re-tentar)");
        assert.equal(calls.filter((c) => c.url.endsWith("/media_publish")).length, 1, "post publicado uma vez só");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  it("sem first_comment: nenhum /comments (destaques seguem como antes)", async () => {
    const calls: Call[] = [];
    globalThis.fetch = mockGraph(calls, () => new Response("{}", { status: 200 }));
    const { env, kv } = mkEnv();
    const past = new Date(Date.now() - 60_000).toISOString();
    kv.store.set(buildQueueKey(past, "uuid-d1"), JSON.stringify(entryFor(past, { destaque: "d1" })));
    try {
      const result = await __test__.fireDueItems(env);
      assert.equal(result.fired, 1);
      assert.equal(calls.filter((c) => c.url.endsWith("/comments")).length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("#11724 enqueue: validação de first_comment", () => {
  it("validateFirstComment aceita texto em post de imagem do Instagram", () => {
    assert.equal(validateFirstComment({ channel: "instagram", first_comment: COMMENT }), null);
    assert.equal(validateFirstComment({ channel: "linkedin" }), null);
  });

  it("rejeita vazio, longo demais, canal errado e Reels", () => {
    assert.match(validateFirstComment({ channel: "instagram", first_comment: "  " }) ?? "", /non-empty/);
    assert.match(
      validateFirstComment({ channel: "instagram", first_comment: "x".repeat(MAX_FIRST_COMMENT_LENGTH + 1) }) ?? "",
      /exceeds/,
    );
    assert.match(validateFirstComment({ channel: "threads", first_comment: COMMENT }) ?? "", /instagram/);
    assert.match(validateFirstComment({ channel: "instagram", media_type: "REELS", first_comment: COMMENT }) ?? "", /REELS/);
  });

  it("POST /queue com first_comment em canal errado volta 400", async () => {
    const { env } = mkEnv();
    const req = new Request("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify({ text: "x", scheduled_at: "2026-12-01T12:00:00Z", destaque: "um", channel: "threads", first_comment: COMMENT }),
      headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
    });
    const res = await workerDefault.fetch(req, env);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /first_comment/);
  });
});
