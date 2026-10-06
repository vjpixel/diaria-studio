/** maintenance.test.ts (#9569) — refresh do token Threads + alarme de DLQ. */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import workerDefault, {
  maybeRefreshThreadsToken,
  withRefreshedThreadsToken,
  alertNewDlqEntries,
  shouldSweepDlq,
  THREADS_TOKEN_KV_KEY,
  DLQ_ALERT_KV_KEY,
  type Env,
} from "../src/index.ts";

class MockKV {
  store = new Map<string, string>();
  listCalls: string[] = [];
  async get(k: string) { return this.store.get(k) ?? null; }
  async put(k: string, v: string) { this.store.set(k, v); }
  async delete(k: string) { this.store.delete(k); }
  async list(o: { prefix?: string }) {
    this.listCalls.push(o.prefix ?? "");
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
    assert.match(calls[0].url, /refresh_access_token\?grant_type=th_refresh_token$/);
    assert.equal((calls[0].init?.headers as any).Authorization, "Bearer OLD");
    assert.equal((await withRefreshedThreadsToken(mkEnv())).THREADS_ACCESS_TOKEN, "NEW");
  });
  it("não renova de novo antes de 30 dias", async () => {
    await maybeRefreshThreadsToken(mkEnv(), 1_000);
    calls.length = 0;
    assert.equal(await maybeRefreshThreadsToken(mkEnv(), 1_000 + 29 * 86400_000), "skipped");
    assert.equal(calls.length, 0);
    assert.equal(await maybeRefreshThreadsToken(mkEnv(), 1_000 + 31 * 86400_000), "refreshed");
    assert.equal((calls[0].init?.headers as any).Authorization, "Bearer NEW");
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
    assert.equal((calls.at(-1)!.init?.headers as any).Authorization, "Bearer MANUAL");
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

// #9618 — regressão: (1) varredura de DLQ não pode rodar em todo cron */5
// (dobrava o KV list/dia); (2) refresh do Threads falhando persistentemente alerta.
describe("#9618 — gate da varredura de DLQ", () => {
  const at = (iso: string) => Date.parse(iso);
  it("shouldSweepDlq: só no topo da hora ou quando houve DLQ neste disparo", () => {
    assert.equal(shouldSweepDlq(at("2026-10-05T12:00:00Z"), 0), true);
    assert.equal(shouldSweepDlq(at("2026-10-05T12:05:00Z"), 0), false);
    assert.equal(shouldSweepDlq(at("2026-10-05T12:55:00Z"), 0), false);
    assert.equal(shouldSweepDlq(at("2026-10-05T12:35:00Z"), 1), true);
    assert.equal(shouldSweepDlq(NaN, 0), true); // fail-open
  });
  it("um dia de cron */5 lista dlq: ~24x, não 288x", () => {
    const start = at("2026-10-05T00:00:00Z");
    let sweeps = 0;
    for (let i = 0; i < 288; i++) if (shouldSweepDlq(start + i * 5 * 60_000, 0)) sweeps++;
    assert.equal(sweeps, 24);
  });
  const runCron = async (env: Env, scheduledTime: number) => {
    let p: Promise<unknown> = Promise.resolve();
    await workerDefault.scheduled({ scheduledTime } as any, env, { waitUntil: (x: Promise<unknown>) => { p = x; } } as any);
    await p;
  };
  it("scheduled fora do topo da hora (sem DLQ no disparo) NÃO lista dlq:", async () => {
    const env = mkEnv({ THREADS_ACCESS_TOKEN: undefined, LINKEDIN_SCHEDULER: {} as any });
    await runCron(env, at("2026-10-05T12:10:00Z"));
    assert.deepEqual(kv.listCalls.filter((p) => p === "dlq:"), []);
    assert.deepEqual(kv.listCalls, ["queue:"]);
  });
  it("scheduled no topo da hora lista dlq: e avisa", async () => {
    await kv.put("dlq:2026-10-02T17:30:00.000Z:u", JSON.stringify({ channel: "threads", destaque: "d1", last_error: "x" }));
    const env = mkEnv({ THREADS_ACCESS_TOKEN: undefined, ALERT_WEBHOOK_URL: "https://hook.test/x", LINKEDIN_SCHEDULER: {} as any });
    await runCron(env, at("2026-10-05T13:00:00Z"));
    assert.equal(kv.listCalls.filter((p) => p === "dlq:").length, 1);
    assert.ok(calls.some((c) => c.url === "https://hook.test/x"));
  });
});

describe("#9618 — alerta de refresh do Threads falhando", () => {
  const DAY = 86_400_000;
  const fail = () => { respond = (u) => u.includes("hook") ? new Response("ok") : new Response(JSON.stringify({ error: { message: "scope revogado" } }), { status: 400 }); };
  const hookCalls = () => calls.filter((c) => c.url === "https://hook.test/x");
  it("falha com token novo não alerta; falha com token > 45d alerta (1x/dia)", async () => {
    const env = mkEnv({ ALERT_WEBHOOK_URL: "https://hook.test/x" });
    const t0 = 1_000_000;
    assert.equal(await maybeRefreshThreadsToken(env, t0), "refreshed");
    fail();
    assert.equal(await maybeRefreshThreadsToken(env, t0 + 31 * DAY), "failed");
    assert.equal(hookCalls().length, 0);
    assert.equal(await maybeRefreshThreadsToken(env, t0 + 46 * DAY), "failed");
    assert.equal(hookCalls().length, 1);
    assert.match(String(hookCalls()[0].init!.body), /46 dias/);
    assert.match(String(hookCalls()[0].init!.body), /scope revogado/);
    assert.doesNotMatch(String(hookCalls()[0].init!.body), /NEW|OLD/); // nunca vaza o token
    // 6h depois: falha de novo, mas não re-alerta antes de 24h
    assert.equal(await maybeRefreshThreadsToken(env, t0 + 46 * DAY + 7 * 3600_000), "failed");
    assert.equal(hookCalls().length, 1);
    assert.equal(await maybeRefreshThreadsToken(env, t0 + 47 * DAY + 1), "failed");
    assert.equal(hookCalls().length, 2);
  });
  it("nunca renovou: idade conta desde a semeadura", async () => {
    fail();
    const env = mkEnv({ ALERT_WEBHOOK_URL: "https://hook.test/x" });
    const t0 = 5_000_000;
    assert.equal(await maybeRefreshThreadsToken(env, t0), "failed");
    assert.equal(hookCalls().length, 0); // refreshed_at no epoch não pode contar como "velho"
    assert.equal(await maybeRefreshThreadsToken(env, t0 + 46 * DAY), "failed");
    assert.equal(hookCalls().length, 1);
  });
  it("#9758: registro legado (pré-#9618, sem seeded_at, nunca renovou) alerta já na falha e não zera a idade", async () => {
    fail();
    const env = mkEnv({ ALERT_WEBHOOK_URL: "https://hook.test/x" });
    // Fingerprint do secret "OLD" casando: semeia um registro novo e depois
    // remove seeded_at, reproduzindo exatamente o formato gravado pelo #9569.
    const t0 = 5_000_000;
    await maybeRefreshThreadsToken(env, t0);
    assert.equal(hookCalls().length, 0);
    const legacy = JSON.parse(kv.store.get(THREADS_TOKEN_KV_KEY)!);
    delete legacy.seeded_at;
    legacy.next_attempt_at = new Date(0).toISOString();
    kv.store.set(THREADS_TOKEN_KV_KEY, JSON.stringify(legacy));

    const t1 = t0 + 40 * DAY;
    assert.equal(await maybeRefreshThreadsToken(env, t1), "failed");
    assert.equal(hookCalls().length, 1, "idade desconhecida tem de alertar já, não esperar 45d a partir de agora");
    assert.match(String(hookCalls()[0].init!.body), /idade desconhecida/);
    const rec = JSON.parse(kv.store.get(THREADS_TOKEN_KV_KEY)!);
    assert.equal(rec.seeded_at, undefined, "falha não pode gravar seeded_at = now num registro legado");
    // Dedup diário continua valendo.
    assert.equal(await maybeRefreshThreadsToken(env, t1 + 7 * 3600_000), "failed");
    assert.equal(hookCalls().length, 1);
    assert.equal(await maybeRefreshThreadsToken(env, t1 + DAY + 1), "failed");
    assert.equal(hookCalls().length, 2);
  });
  it("webhook falhou: não marca como avisado e re-tenta na próxima falha", async () => {
    const env = mkEnv({ ALERT_WEBHOOK_URL: "https://hook.test/x" });
    const t0 = 1_000_000;
    await maybeRefreshThreadsToken(env, t0);
    respond = () => new Response("no", { status: 500 });
    await maybeRefreshThreadsToken(env, t0 + 46 * DAY);
    assert.equal(hookCalls().length, 1);
    const rec = JSON.parse(kv.store.get(THREADS_TOKEN_KV_KEY)!);
    assert.equal(rec.stale_alerted_at, undefined);
    assert.equal(rec.access_token, "NEW"); // token preservado
    await maybeRefreshThreadsToken(env, t0 + 46 * DAY + 7 * 3600_000);
    assert.equal(hookCalls().length, 2);
  });
  it("renovação bem-sucedida zera o estado de alerta", async () => {
    const env = mkEnv({ ALERT_WEBHOOK_URL: "https://hook.test/x" });
    const t0 = 1_000_000;
    await maybeRefreshThreadsToken(env, t0);
    fail();
    await maybeRefreshThreadsToken(env, t0 + 46 * DAY);
    respond = () => new Response(JSON.stringify({ access_token: "NEWER" }), { status: 200 });
    assert.equal(await maybeRefreshThreadsToken(env, t0 + 47 * DAY), "refreshed");
    const rec = JSON.parse(kv.store.get(THREADS_TOKEN_KV_KEY)!);
    assert.equal(rec.stale_alerted_at, undefined);
  });
});
