import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env, type QueueEntry } from "../src/index.ts";
import { fireQueueEntry } from "../src/dispatch.ts";
import { fireDueItems } from "../src/fire.ts";
import { LinkedInScheduler } from "../src/durable-object.ts";
import { recordDispatch } from "../src/dispatch-record.ts";

const entry: QueueEntry = {
  channel: "instagram", text: "private caption", image_url: "https://image.test/private",
  scheduled_at: "2026-11-15T12:00:00Z", created_at: "2026-11-14T12:00:00Z", destaque: "um",
};
function fixture() {
  const data = new Map<string, string>();
  const ttl: number[] = [];
  const kv = {
    get: async (key: string) => data.get(key) ?? null,
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      data.set(key, value); if (options?.expirationTtl) ttl.push(options.expirationTtl);
    },
    delete: async (key: string) => { data.delete(key); },
    list: async ({ prefix }: { prefix: string }) => ({ keys: [...data.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }),
  } as unknown as KVNamespace;
  const env = { LINKEDIN_QUEUE: kv, DIARIA_TOKEN: "auth-secret", MAKE_WEBHOOK_URL: "https://secret-webhook.test", INSTAGRAM_ACCESS_TOKEN: "platform-secret", INSTAGRAM_BUSINESS_ACCOUNT_ID: "account" } as Env;
  return { data, ttl, kv, env };
}

test("#13099 cron persists returned Instagram post/container ID + HTTP status after removing queue", async () => {
  const { data, ttl, env } = fixture();
  data.set("queue:test", JSON.stringify(entry));
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => new Response(JSON.stringify({ id: String(url).includes("media_publish") ? "post-123" : "container-456" }), { status: 200 })) as typeof fetch;
  try {
    assert.equal((await fireDueItems(env)).fired, 1);
    assert.equal(data.has("queue:test"), false);
    const record = JSON.parse(data.get("fired:queue:test")!);
    assert.equal(record.post_id, "post-123");
    assert.equal(record.container_id, "container-456");
    assert.equal(record.http_status, 200);
    assert.equal(record.status, "fired");
    assert.ok(ttl.includes(30 * 86400));
    assert.doesNotMatch(JSON.stringify(record), /private|secret|access_token|webhook/);
  } finally { globalThis.fetch = original; }
});

test("#13099 /fired requires auth and verifies exact platform ID, never just HTTP 200", async () => {
  const { kv, env } = fixture();
  await recordDispatch(kv, "queue:test", entry, { status: "fired", postId: "post-123", httpStatus: 200 });
  const request = (query: string, auth = true) => new Request(`https://worker.test/fired?${query}`, { headers: auth ? { "X-Diaria-Token": "auth-secret" } : {} });
  assert.equal((await worker.fetch(request("edition=261115", false), env)).status, 401);
  assert.equal((await worker.fetch(request(""), env)).status, 400);
  const list = await (await worker.fetch(request("edition=261115"), env)).json() as { items: unknown[] };
  assert.equal(list.items.length, 1);
  const other = await (await worker.fetch(request("edition=261116"), env)).json() as { items: unknown[] };
  assert.equal(other.items.length, 0);
  const original = globalThis.fetch;
  try {
    for (const id of ["different", "post-123"]) {
      globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        assert.equal((init.headers as Record<string, string>).Authorization, "Bearer platform-secret");
        return Response.json({ id });
      }) as typeof fetch;
      const result = await (await worker.fetch(request("key=queue:test&verify=true"), env)).json() as { verification: { verified: boolean } };
      assert.equal(result.verification.verified, id === "post-123");
    }
  } finally { globalThis.fetch = original; }
});

test("#13099 no ID or ambiguous outcome cannot be verified; storage failure does not throw", async () => {
  const { kv, env } = fixture();
  await recordDispatch(kv, "queue:test", entry, { status: "send_unknown", reason: "secret platform response" });
  const res = await worker.fetch(new Request("https://worker.test/fired?key=queue:test&verify=true", { headers: { "X-Diaria-Token": "auth-secret" } }), env);
  const body = await res.json() as { verification: { verified: boolean }; items: unknown[] };
  assert.equal(body.verification.verified, false);
  assert.doesNotMatch(JSON.stringify(body), /secret/);
  await recordDispatch({ put: async () => { throw new Error("storage unavailable"); } } as unknown as KVNamespace, "queue:test", entry, { status: "fired" });
});

test("#13099 direct LinkedIn response captures x-restli-id", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:123" } })) as typeof fetch;
  try {
    const result = await fireQueueEntry({ ...entry, channel: "linkedin", action: "repost", target_post_urn: "urn:li:share:456" }, { webhookUrl: "unused", linkedin: { accessToken: "secret", authorUrn: "urn:li:organization:1", apiVersion: "202609" } });
    assert.equal(result.postId, "urn:li:share:123");
    assert.equal(result.httpStatus, 201);
  } finally { globalThis.fetch = original; }
});


test("#13099 DO alarm retains dispatch record after deleting payload", async () => {
  const { data, env } = fixture();
  const values = new Map<string, unknown>();
  values.set("payload", { key: "queue:alarm", entry, webhookUrl: "unused", instagram: { igUserId: "account", accessToken: "secret", apiVersion: "v25.0" } });
  const state = {
    storage: {
      get: async (k: string) => values.get(k),
      put: async (k: string, v: unknown) => { values.set(k, v); },
      delete: async (k: string) => { values.delete(k); },
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => Response.json({ id: String(url).includes("media_publish") ? "alarm-post" : "alarm-container" })) as typeof fetch;
  try {
    await new LinkedInScheduler(state, env).alarm();
    assert.equal(values.get("fired"), true);
    assert.equal(values.has("payload"), false);
    assert.equal(JSON.parse(data.get("fired:queue:alarm")!).post_id, "alarm-post");
  } finally { globalThis.fetch = original; }
});
