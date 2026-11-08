/**
 * linkedin-page-repost-comment-11121-10983.test.ts
 *
 * Repost da página (#11121) e comentário como página (#10983) pela API direta
 * do LinkedIn — `fireQueueEntry` em `dispatch.ts` e a validação no enqueue
 * (`validatePageApiFields`, `index.ts`).
 *
 * Regressão principal: antes, o Worker só aceitava `action=post|comment` e o
 * `comment` com `webhook_target` "diaria" ia sempre pra DLQ (o Make não
 * comenta). Sem os segredos da página no Worker, o enqueue recusa com
 * `linkedin_creds_missing` — o caller segue no caminho guiado/manual.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fireQueueEntry, pickPagePostNear, type LinkedInCreds } from "../src/dispatch.ts";
import workerDefault, { type Env, type QueueEntry } from "../src/index.ts";

const CREDS: LinkedInCreds = {
  accessToken: "test-li-token",
  authorUrn: "urn:li:organization:110742958",
  apiVersion: "202609",
};
const PROFILE_POST = "urn:li:share:7390000000000000001";

type Call = { url: string; method: string; headers: Headers; body: string };
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(route: (url: string, method: string) => Response | "throw"): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" });
    const r = route(url, method);
    if (r === "throw") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    return r;
  }) as typeof fetch;
  return calls;
}

const jsonRes = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const config = (withCreds = true) => ({ webhookUrl: "https://make.test/hook", ...(withCreds ? { linkedin: CREDS } : {}) });

function entry(extra: Partial<QueueEntry>): QueueEntry {
  return {
    text: "",
    image_url: null,
    scheduled_at: "2026-11-09T18:00:00.000Z",
    destaque: "shorts",
    created_at: "2026-11-09T10:00:00.000Z",
    ...extra,
  };
}

describe("#11121 repost da página", () => {
  it("POST /rest/posts com reshareContext.parent e author = página → fired", async () => {
    const calls = installFetch(() => new Response("", { status: 201 }));
    const out = await fireQueueEntry(entry({ action: "repost", target_post_urn: PROFILE_POST }), config());
    assert.deepEqual(out, { status: "fired" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.linkedin.com/rest/posts");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("Authorization"), "Bearer test-li-token");
    assert.equal(calls[0].headers.get("LinkedIn-Version"), "202609");
    const body = JSON.parse(calls[0].body);
    assert.equal(body.author, CREDS.authorUrn);
    assert.deepEqual(body.reshareContext, { parent: PROFILE_POST });
    assert.equal(body.commentary, "");
    assert.equal(body.lifecycleState, "PUBLISHED");
    assert.equal(body.content, undefined);
  });

  it("4xx → dlq; 5xx → send_unknown; timeout → send_unknown (nunca refaz)", async () => {
    installFetch(() => new Response("forbidden", { status: 403 }));
    assert.equal((await fireQueueEntry(entry({ action: "repost", target_post_urn: PROFILE_POST }), config())).status, "dlq");
    installFetch(() => new Response("oops", { status: 502 }));
    const u = await fireQueueEntry(entry({ action: "repost", target_post_urn: PROFILE_POST }), config());
    assert.equal(u.status, "send_unknown");
    assert.match((u as { reason: string }).reason, /^send_unknown:/);
    installFetch(() => "throw");
    assert.equal((await fireQueueEntry(entry({ action: "repost", target_post_urn: PROFILE_POST }), config())).status, "send_unknown");
  });

  it("sem credencial → dlq sem nenhum fetch (nunca cai no Make)", async () => {
    const calls = installFetch(() => new Response("", { status: 200 }));
    const out = await fireQueueEntry(entry({ action: "repost", target_post_urn: PROFILE_POST }), config(false));
    assert.equal(out.status, "dlq");
    assert.match((out as { reason: string }).reason, /#8816/);
    assert.equal(calls.length, 0);
  });
});

describe("#10983 comentário como página", () => {
  const D1_AT = "2026-11-09T20:00:00.000Z";
  const D1_MS = Date.parse(D1_AT);

  it("com target_post_urn → POST /rest/socialActions/{urn}/comments com actor = página", async () => {
    const calls = installFetch(() => new Response("", { status: 201 }));
    const out = await fireQueueEntry(
      entry({ action: "comment", destaque: "d1", parent_destaque: "d1", text: "Assista no YouTube: https://youtu.be/abcdefghijk", target_post_urn: "urn:li:share:42" }),
      config(),
    );
    assert.deepEqual(out, { status: "fired" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.linkedin.com/rest/socialActions/${encodeURIComponent("urn:li:share:42")}/comments`);
    const body = JSON.parse(calls[0].body);
    assert.deepEqual(body, {
      actor: CREDS.authorUrn,
      object: "urn:li:share:42",
      message: { text: "Assista no YouTube: https://youtu.be/abcdefghijk" },
    });
  });

  it("com parent_scheduled_at → acha o post da página mais perto do horário e comenta nele", async () => {
    const calls = installFetch((url, method) => {
      if (method === "GET" && url.startsWith("https://api.linkedin.com/rest/posts?")) {
        return jsonRes(200, {
          elements: [
            { id: "urn:li:share:900", publishedAt: D1_MS + 4 * 3600_000, lifecycleState: "PUBLISHED" }, // fora da janela
            { id: "urn:li:share:901", publishedAt: D1_MS + 60_000, lifecycleState: "PUBLISHED", reshareContext: { parent: "x" } }, // repost
            { id: "urn:li:ugcPost:902", publishedAt: D1_MS + 90_000, lifecycleState: "PUBLISHED" }, // o D1
            { id: "urn:li:share:903", publishedAt: D1_MS - 2 * 3600_000, lifecycleState: "PUBLISHED" }, // antes da janela
          ],
        });
      }
      return new Response("", { status: 201 });
    });
    const out = await fireQueueEntry(
      entry({ action: "comment", destaque: "d1", parent_destaque: "d1", text: "link", parent_scheduled_at: D1_AT }),
      config(),
    );
    assert.deepEqual(out, { status: "fired" });
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /q=author/);
    assert.ok(calls[0].url.includes(`author=${encodeURIComponent(CREDS.authorUrn)}`));
    assert.equal(calls[0].headers.get("X-RestLi-Method"), "FINDER");
    assert.equal(calls[1].url, `https://api.linkedin.com/rest/socialActions/${encodeURIComponent("urn:li:ugcPost:902")}/comments`);
  });

  it("post ainda não publicado (nada na janela) → failed retentável, sem comentar", async () => {
    const calls = installFetch(() => jsonRes(200, { elements: [] }));
    const out = await fireQueueEntry(entry({ action: "comment", destaque: "d1", text: "link", parent_scheduled_at: D1_AT }), config());
    assert.equal(out.status, "failed");
    assert.equal(calls.length, 1);
  });

  it("busca recusada (403, sem r_organization_social) → dlq", async () => {
    installFetch(() => new Response("denied", { status: 403 }));
    const out = await fireQueueEntry(entry({ action: "comment", destaque: "d1", text: "link", parent_scheduled_at: D1_AT }), config());
    assert.equal(out.status, "dlq");
  });

  it("comentário 5xx → send_unknown (pode ter saído)", async () => {
    installFetch(() => new Response("bad gateway", { status: 502 }));
    const out = await fireQueueEntry(entry({ action: "comment", destaque: "d1", text: "link", target_post_urn: "urn:li:share:42" }), config());
    assert.equal(out.status, "send_unknown");
  });

  it("comment 'diaria' SEM alvo segue o caminho antigo: dlq sem fetch", async () => {
    const calls = installFetch(() => new Response("", { status: 200 }));
    const out = await fireQueueEntry(entry({ action: "comment", destaque: "d1", text: "x" }), config());
    assert.equal(out.status, "dlq");
    assert.match((out as { reason: string }).reason, /pixel/);
    assert.equal(calls.length, 0);
  });

  it("pickPagePostNear: só post original, publicado, dentro da janela; o mais próximo vence", () => {
    assert.equal(pickPagePostNear(undefined, D1_MS), null);
    assert.equal(
      pickPagePostNear(
        [
          { id: "urn:li:share:1", createdAt: D1_MS + 20 * 60_000 },
          { id: "urn:li:share:2", createdAt: D1_MS - 5 * 60_000 },
          { id: "urn:li:share:3", createdAt: D1_MS + 60_000, lifecycleState: "DRAFT" },
          { id: "urn:li:organization:4", createdAt: D1_MS },
        ],
        D1_MS,
      ),
      "urn:li:share:2",
    );
  });
});

// ── enqueue ────────────────────────────────────────────────────────────────

class MockKV {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list(opts: { prefix?: string }) {
    const names = [...this.store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
    return { keys: names.map((name) => ({ name })), list_complete: true as const };
  }
}

function mkEnv(withCreds: boolean): { env: Env; kv: MockKV } {
  const kv = new MockKV();
  const env: Env = {
    LINKEDIN_QUEUE: kv as unknown as KVNamespace,
    DIARIA_TOKEN: "secret-token",
    MAKE_WEBHOOK_URL: "https://make.test/webhook",
    ...(withCreds ? { LINKEDIN_ACCESS_TOKEN: "li-token", LINKEDIN_AUTHOR_URN: "urn:li:organization:110742958" } : {}),
  } as Env;
  return { env, kv };
}

function enqueue(env: Env, body: unknown): Promise<Response> {
  return workerDefault.fetch(
    new Request("https://w.test/queue", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-Diaria-Token": "secret-token" },
    }),
    env,
  );
}

const REPOST = { text: "", scheduled_at: "2026-12-05T18:00:00Z", destaque: "shorts", channel: "linkedin", action: "repost", target_post_urn: PROFILE_POST };
const COMMENT = {
  text: "Assista no YouTube: https://youtu.be/abcdefghijk",
  scheduled_at: "2026-12-05T20:05:00Z",
  destaque: "d1",
  parent_destaque: "d1",
  channel: "linkedin",
  action: "comment",
  webhook_target: "diaria",
  parent_scheduled_at: "2026-12-05T20:00:00Z",
};

describe("#11121/#10983 enqueue", () => {
  it("repost com texto vazio é aceito (202) e grava o alvo", async () => {
    const { env, kv } = mkEnv(true);
    const res = await enqueue(env, REPOST);
    assert.equal(res.status, 202);
    const saved = JSON.parse([...kv.store.values()][0]) as QueueEntry;
    assert.equal(saved.action, "repost");
    assert.equal(saved.target_post_urn, PROFILE_POST);
    assert.equal(saved.text, "");
  });

  it("comentário como página é aceito (202) com parent_scheduled_at", async () => {
    const { env, kv } = mkEnv(true);
    const res = await enqueue(env, COMMENT);
    assert.equal(res.status, 202);
    const saved = JSON.parse([...kv.store.values()][0]) as QueueEntry;
    assert.equal(saved.parent_scheduled_at, COMMENT.parent_scheduled_at);
  });

  it("sem os segredos da página → 400 linkedin_creds_missing, nada gravado (guiado/manual preservado)", async () => {
    for (const body of [REPOST, COMMENT]) {
      const { env, kv } = mkEnv(false);
      const res = await enqueue(env, body);
      assert.equal(res.status, 400);
      const data = (await res.json()) as { code?: string };
      assert.equal(data.code, "linkedin_creds_missing");
      assert.equal(kv.store.size, 0);
    }
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["repost sem alvo", { ...REPOST, target_post_urn: undefined }],
    ["repost com URN que não é post", { ...REPOST, target_post_urn: "urn:li:organization:1" }],
    ["repost com imagem", { ...REPOST, image_url: "https://x.test/a.jpg" }],
    ["repost pelo pixel", { ...REPOST, webhook_target: "pixel" }],
    ["repost no instagram", { ...REPOST, channel: "instagram" }],
    ["alvo em post comum", { ...REPOST, action: "post", text: "oi" }],
    ["parent_scheduled_at inválido", { ...COMMENT, parent_scheduled_at: "ontem" }],
    ["repost com texto ausente", { ...REPOST, text: undefined }],
  ];
  for (const [label, body] of invalid) {
    it(`recusa: ${label}`, async () => {
      const { env, kv } = mkEnv(true);
      const res = await enqueue(env, body);
      assert.equal(res.status, 400, label);
      assert.equal(kv.store.size, 0);
    });
  }

  it("comment 'diaria' sem alvo segue aceito como antes (o disparo cai no guard antigo)", async () => {
    const { env } = mkEnv(false);
    const { parent_scheduled_at: _drop, ...legacy } = COMMENT;
    const res = await enqueue(env, legacy);
    assert.equal(res.status, 202);
  });
});
