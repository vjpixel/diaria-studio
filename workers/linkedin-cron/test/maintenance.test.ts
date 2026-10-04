/** maintenance.test.ts (#9569) — refresh do token Threads + alarme de DLQ. */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import workerDefault, {
  maybeRefreshThreadsToken,
  withRefreshedThreadsToken,
  alertNewDlqEntries,
  THREADS_TOKEN_KV_KEY,
  DLQ_ALERT_KV_KEY,
  type Env,
} from "../src/index.ts";

class MockKV {
  store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async put(k: string, v: string) { this.store.set(k, v); }
  async delete(k: string) { this.store.delete(k); }
  async list(o: { prefix?: string }) {
    const names = [...this.store.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort();
    return { keys: names.map((name) => ({ name })), list_complete: true as const };
  }
}

let kv: MockKV;
let calls: { url: string; init?: RequestInit }[];
let respond: (url: string) => Response;
const realFetch = globalThis.fetch;
const mkEnv = (extra: Partial<Env> = {}) =>
  ({ LINKEDIN_QUEUE: kv, DIARIA_TOKEN: "t", THREADS_ACCESS_TOKEN: "OLD", THREADS_USER_ID: "1", ...extra }) as unknown as Env;

beforeEach(() => {
  kv = new MockKV();
  calls = [];
  respond = () => new Response(JSON.stringify({ access_token: "NEW" }), { status: 200 });
  globalThis.fetch = (async (u: any, init?: RequestInit) => { calls.push({ url: String(u), init }); return respond(String(u)); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("threads token refresh", () => {
  it("renova, grava no KV e sobrepõe o secret", async () => {
    assert.equal(await maybeRefreshThreadsToken(mkEnv(), 1_000), "refreshed");
    assert.match(calls[0].url, /refresh_access_token\?grant_type=th_refresh_token&access_token=OLD/);
    assert.equal((await withRefreshedThreadsToken(mkEnv())).THREADS_ACCESS_TOKEN, "NEW");
  });
  it("não renova de novo antes de 30 dias", async () => {
    await maybeRefreshThreadsToken(mkEnv(), 1_000);
    calls.length = 0;
    assert.equal(await maybeRefreshThreadsToken(mkEnv(), 1_000 + 29 * 86400_000), "skipped");
    assert.equal(calls.length, 0);
    assert.equal(await maybeRefreshThreadsToken(mkEnv(), 1_000 + 31 * 86400_000), "refreshed");
    assert.match(calls[0].url, /access_token=NEW/);
  });
  it("token vencido: falha sem trocar o token e sem inventar fluxo; retenta em 6h", async () => {
    respond = () => new Response(JSON.stringify({ error: { message: "Session has expired" } }), { status: 400 });
    assert.equal(await maybeRefreshThreadsToken(mkEnv(), 1_000), "failed");
    assert.equal((await withRefreshedThreadsToken(mkEnv())).THREADS_ACCESS_TOKEN, "OLD");
    calls.length = 0;
    assert.equal(await maybeRefreshThreadsToken(mkEnv(), 1_000 + 3600_000), "skipped");
  });
  it("secret rotacionado pelo editor descarta o token do KV", async () => {
    await maybeRefreshThreadsToken(mkEnv(), 1_000);
    const env2 = mkEnv({ THREADS_ACCESS_TOKEN: "MANUAL" });
    assert.equal((await withRefreshedThreadsToken(env2)).THREADS_ACCESS_TOKEN, "MANUAL");
    assert.equal(await maybeRefreshThreadsToken(env2, 2_000), "refreshed");
    assert.match(calls.at(-1)!.url, /access_token=MANUAL/);
  });
  it("sem secret Threads: não faz nada", async () => {
    assert.equal(await maybeRefreshThreadsToken(mkEnv({ THREADS_ACCESS_TOKEN: undefined })), "skipped");
    assert.equal(kv.store.has(THREADS_TOKEN_KV_KEY), false);
  });
});

describe("DLQ alert", () => {
  const dlq = (iso: string, ch = "threads") => kv.put(`dlq:${iso}:u`, JSON.stringify({ channel: ch, destaque: "d1", last_error: "token expirado", scheduled_at: iso }));
  it("avisa qualquer canal, avança cursor e não repete", async () => {
    await dlq("2026-10-02T17:30:00.000Z");
    await dlq("2026-10-03T10:00:00.000Z", "instagram");
    const env = mkEnv({ ALERT_WEBHOOK_URL: "https://hook.test/x" });
    assert.deepEqual(await alertNewDlqEntries(env), { new_entries: 2, alerted: true });
    assert.match(String(calls[0].init!.body), /instagram\/d1/);
    assert.deepEqual(await alertNewDlqEntries(env), { new_entries: 0, alerted: false });
    await dlq("2026-10-04T11:00:00.000Z");
    assert.equal((await alertNewDlqEntries(env)).new_entries, 1);
  });
  it("entry que chega tarde com scheduled_at anterior ainda é avisada", async () => {
    const env = mkEnv({ ALERT_WEBHOOK_URL: "https://hook.test/x" });
    await dlq("2026-10-04T10:30:00.000Z");
    await alertNewDlqEntries(env);
    await dlq("2026-10-04T10:00:00.000Z");
    assert.equal((await alertNewDlqEntries(env)).new_entries, 1);
  });
  it("sem webhook: não repete o log na rodada seguinte", async () => {
    await dlq("2026-10-02T17:30:00.000Z");
    await alertNewDlqEntries(mkEnv());
    assert.equal((await alertNewDlqEntries(mkEnv())).new_entries, 0);
  });
  it("webhook falha: cursor não avança (retenta)", async () => {
    await dlq("2026-10-02T17:30:00.000Z");
    respond = () => new Response("no", { status: 500 });
    const env = mkEnv({ ALERT_WEBHOOK_URL: "https://hook.test/x" });
    assert.equal((await alertNewDlqEntries(env)).alerted, false);
    assert.equal(kv.store.has(DLQ_ALERT_KV_KEY), false);
  });
  it("sem webhook (1ª vez): só loga, sem fetch", async () => {
    await dlq("2026-10-02T17:30:00.000Z");
    assert.deepEqual(await alertNewDlqEntries(mkEnv()), { new_entries: 1, alerted: false });
    assert.equal(calls.length, 0);
  });
  it("cron (scheduled) roda refresh + alerta", async () => {
    await dlq("2026-10-02T17:30:00.000Z");
    const env = mkEnv({ ALERT_WEBHOOK_URL: "https://hook.test/x", LINKEDIN_SCHEDULER: {} as any });
    let p: Promise<unknown> = Promise.resolve();
    await workerDefault.scheduled({} as any, env, { waitUntil: (x: Promise<unknown>) => { p = x; } } as any);
    await p;
    assert.ok(calls.some((c) => c.url.includes("refresh_access_token")));
    assert.ok(calls.some((c) => c.url === "https://hook.test/x"));
  });
});
