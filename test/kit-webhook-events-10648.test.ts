/**
 * #10648 — eventos por assinante do Kit via webhook (Worker kit-events + KV)
 * e leitura integrada ao diaria-subscribers-db.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildKitEventKey,
  isAuthorizedEventsReadRequest,
  isKitWebhookEventRecord,
  isValidWebhookSecret,
  KIT_WEBHOOK_EVENT_TYPES,
  KIT_WEBHOOK_ROUTES,
  parseKitWebhookPayload,
  receivedAtFromKey,
  type KitWebhookEventRecord,
} from "../scripts/lib/kit-webhook-events-contract.ts";
import { handleRequest, type Env, type EventsKv } from "../workers/kit-events/src/index.ts";
import {
  ensureSubscriber,
  findSubscriberIdsByEmail,
  getKitWebhookEventsForSubscriber,
  getLatestKitWebhookEventReceivedAt,
  openDiariaSubscribersDb,
  recordKitWebhookEvent,
} from "../scripts/lib/diaria-subscribers-db.ts";
import { resolveIdentitiesByEmail } from "../scripts/lib/diaria-subscribers-identity-resolve.ts";
import {
  computeIncrementalSince,
  fetchKitWebhookEvents,
  ingestKitWebhookEvents,
  KIT_WEBHOOK_SINCE_SAFETY_MS,
} from "../scripts/lib/kit-webhook-events-ingest.ts";
import { main as ingestMain } from "../scripts/diaria-subscribers-ingest-kit-webhooks.ts";

const SECRET = "s".repeat(32);
const READ_TOKEN = "r".repeat(32);
const ROOT = resolve(import.meta.dirname, "..");

/** KV em memória com a semântica que o Worker usa (list ordenado por chave). */
class FakeKv implements EventsKv {
  store = new Map<string, { value: string; metadata?: unknown }>();
  failPut = false;
  listed: string[] = [];
  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    if (this.failPut) throw new Error("kv down");
    this.store.set(key, { value, metadata: options?.metadata });
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async list(options: { prefix: string; cursor?: string }) {
    const names = [...this.store.keys()].filter((k) => k.startsWith(options.prefix)).sort();
    // Paginação de 2 em 2 pra exercitar o cursor.
    const start = options.cursor ? Number(options.cursor) : 0;
    const page = names.slice(start, start + 2);
    this.listed.push(...page);
    const next = start + 2;
    return {
      keys: page.map((name) => ({ name, metadata: this.store.get(name)?.metadata })),
      list_complete: next >= names.length,
      cursor: next >= names.length ? undefined : String(next),
    };
  }
}

function env(kv?: FakeKv): Env {
  return { KIT_EVENTS: kv, KIT_WEBHOOK_SECRET: SECRET, EVENTS_READ_TOKEN: READ_TOKEN };
}

let tick = 0;
function deps(iso: string) {
  return { now: () => new Date(iso), randomSuffix: () => `x${++tick}` };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://kit-events.example.workers.dev${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function listReq(query = "", token = READ_TOKEN): Request {
  return new Request(`https://kit-events.example.workers.dev/api/eventos${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

const sub = (id: number, email = "Pessoa@Exemplo.com") => ({
  subscriber: { id, first_name: "P", email_address: email, state: "cancelled", created_at: "2026-09-01T00:00:00Z", fields: {} },
});

describe("contrato", () => {
  it("cada tipo tem um evento Kit mapeado", () => {
    for (const t of KIT_WEBHOOK_EVENT_TYPES) assert.match(KIT_WEBHOOK_ROUTES[t], /^subscriber\./);
    assert.equal(KIT_WEBHOOK_ROUTES.unsubscribe, "subscriber.subscriber_unsubscribe");
    assert.equal(KIT_WEBHOOK_ROUTES.click, "subscriber.link_click");
  });

  it("chave lista por horário em ordem cronológica e devolve o horário", () => {
    const k = buildKitEventKey("123", "2026-10-20T22:55:01.000Z", "unsubscribe", "ab");
    assert.equal(k, "ev:2026-10-20T22:55:01.000Z:123:unsubscribe:ab");
    assert.equal(receivedAtFromKey(k), "2026-10-20T22:55:01.000Z");
    assert.equal(receivedAtFromKey("ev:123:lixo"), null);
    assert.equal(receivedAtFromKey("outra:123"), null);
  });

  it("parse exige subscriber.id e normaliza e-mail", () => {
    const ok = parseKitWebhookPayload(sub(42), null);
    assert.deepEqual(ok, { ok: true, subscriberId: "42", email: "pessoa@exemplo.com", state: "cancelled", url: null });
    assert.deepEqual(parseKitWebhookPayload({ subscriber: { email_address: "a@b.c" } }, null), {
      ok: false,
      error: "missing_subscriber_id",
    });
    assert.equal(parseKitWebhookPayload(null, null).ok, false);
    assert.equal(parseKitWebhookPayload([], null).ok, false);
    assert.equal(parseKitWebhookPayload({ subscriber: { id: -1 } }, null).ok, false);
    const q = parseKitWebhookPayload(sub(7), "https://x.y/z");
    assert.equal(q.ok && q.url, "https://x.y/z");
  });

  it("segredo e token: falha fechado sem env ou com env curta", () => {
    assert.equal(isValidWebhookSecret(SECRET, SECRET), true);
    assert.equal(isValidWebhookSecret(SECRET.slice(1) + "t", SECRET), false);
    assert.equal(isValidWebhookSecret("", ""), false);
    assert.equal(isValidWebhookSecret("curto", "curto"), false);
    assert.equal(isValidWebhookSecret(SECRET, undefined), false);
    assert.equal(isAuthorizedEventsReadRequest(`Bearer ${READ_TOKEN}`, READ_TOKEN), true);
    assert.equal(isAuthorizedEventsReadRequest(READ_TOKEN, READ_TOKEN), false);
    assert.equal(isAuthorizedEventsReadRequest(`Bearer ${READ_TOKEN}`, undefined), false);
  });
});

describe("Worker kit-events", () => {
  it("grava cancelamento com horário e chave por horário", async () => {
    const kv = new FakeKv();
    const res = await handleRequest(post(`/webhook/${SECRET}/unsubscribe`, sub(123)), env(kv), deps("2026-10-20T22:55:01.000Z"));
    assert.equal(res.status, 200);
    assert.equal(kv.store.size, 1);
    const [key, entry] = [...kv.store.entries()][0];
    assert.match(key, /^ev:2026-10-20T22:55:01\.000Z:123:unsubscribe:/);
    const rec = JSON.parse(entry.value) as KitWebhookEventRecord;
    assert.equal(rec.type, "unsubscribe");
    assert.equal(rec.email, "pessoa@exemplo.com");
    assert.equal(rec.received_at, "2026-10-20T22:55:01.000Z");
    assert.deepEqual(entry.metadata, rec);
    // Sem PII além do e-mail: nome e campos customizados não são guardados.
    assert.equal(entry.value.includes("first_name"), false);
  });

  it("clique guarda a URL do ?url= do endpoint registrado", async () => {
    const kv = new FakeKv();
    const link = "https://diar.ia.br/p/x?utm_source=kit";
    await handleRequest(post(`/webhook/${SECRET}/click?url=${encodeURIComponent(link)}`, sub(5)), env(kv), deps("2026-10-20T10:00:00.000Z"));
    const rec = JSON.parse([...kv.store.values()][0].value) as KitWebhookEventRecord;
    assert.equal(rec.url, link);
  });

  it("segredo errado ou ausente na env: 404 e nada gravado", async () => {
    const kv = new FakeKv();
    assert.equal((await handleRequest(post(`/webhook/${"z".repeat(32)}/unsubscribe`, sub(1)), env(kv))).status, 404);
    assert.equal(
      (await handleRequest(post(`/webhook/${SECRET}/unsubscribe`, sub(1)), { KIT_EVENTS: kv })).status,
      404,
    );
    assert.equal((await handleRequest(post(`/webhook/%E0%A4%A/unsubscribe`, sub(1)), env(kv))).status, 404);
    assert.equal(kv.store.size, 0);
  });

  it("sem KV: 503 not_configured; tipo desconhecido: 404; corpo inválido: 400", async () => {
    assert.equal((await handleRequest(post(`/webhook/${SECRET}/unsubscribe`, sub(1)), env())).status, 503);
    const kv = new FakeKv();
    assert.equal((await handleRequest(post(`/webhook/${SECRET}/open`, sub(1)), env(kv))).status, 404);
    assert.equal((await handleRequest(post(`/webhook/${SECRET}/bounce`, "não é json"), env(kv))).status, 400);
    assert.equal((await handleRequest(post(`/webhook/${SECRET}/bounce`, { subscriber: {} }), env(kv))).status, 400);
    assert.equal(kv.store.size, 0);
  });

  it("falha do KV vira 503 (o Kit repete), nunca 200", async () => {
    const kv = new FakeKv();
    kv.failPut = true;
    assert.equal((await handleRequest(post(`/webhook/${SECRET}/unsubscribe`, sub(1)), env(kv))).status, 503);
  });

  it("leitura exige token, filtra por since/assinante, pagina e ordena", async () => {
    const kv = new FakeKv();
    await handleRequest(post(`/webhook/${SECRET}/click`, sub(9)), env(kv), deps("2026-10-20T08:00:00.000Z"));
    await handleRequest(post(`/webhook/${SECRET}/unsubscribe`, sub(9)), env(kv), deps("2026-10-20T22:55:01.000Z"));
    await handleRequest(post(`/webhook/${SECRET}/bounce`, sub(10)), env(kv), deps("2026-10-19T12:00:00.000Z"));

    assert.equal((await handleRequest(listReq("", "errado".repeat(6)), env(kv))).status, 401);
    assert.equal((await handleRequest(listReq("?since=lixo"), env(kv))).status, 400);

    const all = (await (await handleRequest(listReq(), env(kv))).json()) as { events: KitWebhookEventRecord[] };
    assert.deepEqual(
      all.events.map((e) => e.received_at),
      ["2026-10-19T12:00:00.000Z", "2026-10-20T08:00:00.000Z", "2026-10-20T22:55:01.000Z"],
    );

    kv.listed = [];
    const since = (await (await handleRequest(listReq("?since=2026-10-20T00:00:00Z"), env(kv))).json()) as {
      events: KitWebhookEventRecord[];
    };
    assert.equal(since.events.length, 2);
    assert.equal(kv.listed.length, 2);
    assert.ok(kv.listed.every((key) => !key.includes("2026-10-19")));
    assert.equal(new Set(kv.listed).size, kv.listed.length);
    const exact = await (await handleRequest(listReq("?since=2026-10-20T22:55:01Z&subscriber=9"), env(kv))).json() as { events: KitWebhookEventRecord[] };
    assert.equal(exact.events.length, 1);


    const one = (await (await handleRequest(listReq("?subscriber=10"), env(kv))).json()) as { events: KitWebhookEventRecord[] };
    assert.deepEqual(one.events.map((e) => e.type), ["bounce"]);
  });

  it("#10723: since não lista histórico, inclui o corte e pagina prefixos entre anos", async () => {
    const kv = new FakeKv();
    const times = [
      "2024-01-01T00:00:00.000Z",
      "2026-12-31T23:59:59.998Z",
      "2026-12-31T23:59:59.999Z",
      "2027-01-01T00:00:00.000Z",
      "2027-01-01T00:00:00.001Z",
      "2027-01-01T00:00:00.002Z",
    ];
    for (const time of times) {
      await handleRequest(post(`/webhook/${SECRET}/click`, sub(9)), env(kv), deps(time));
    }
    const result = await (await handleRequest(
      listReq("?since=2026-12-31T23:59:59.999Z"), env(kv),
    )).json() as { events: KitWebhookEventRecord[] };
    assert.deepEqual(result.events.map((e) => e.received_at), times.slice(2));
    assert.equal(kv.listed.length, 4);
    assert.equal(new Set(kv.listed).size, 4);
    assert.ok(kv.listed.every((key) => key >= "ev:2026-12-31T23:59:59.999Z"));
  });

  it("URL longa demais pra metadata: leitura busca o valor", async () => {
    const kv = new FakeKv();
    const link = `https://diar.ia.br/${"a".repeat(1500)}`;
    await handleRequest(post(`/webhook/${SECRET}/click?url=${encodeURIComponent(link)}`, sub(3)), env(kv), deps("2026-10-20T10:00:00.000Z"));
    assert.equal([...kv.store.values()][0].metadata, undefined);
    const body = (await (await handleRequest(listReq(), env(kv))).json()) as { events: KitWebhookEventRecord[] };
    assert.equal(body.events[0].url, link);
  });
});

describe("integração com diaria-subscribers-db", () => {
  function freshDb() {
    const dir = mkdtempSync(join(tmpdir(), "kit-webhooks-10648-"));
    return openDiariaSubscribersDb(join(dir, "store.db"));
  }

  const ev = (over: Partial<KitWebhookEventRecord> = {}): KitWebhookEventRecord => ({
    key: "ev:2026-10-20T22:55:01.000Z:123:unsubscribe:ab",
    type: "unsubscribe",
    kit_subscriber_id: "123",
    email: "pessoa@exemplo.com",
    state: "cancelled",
    url: null,
    received_at: "2026-10-20T22:55:01.000Z",
    ...over,
  });

  it("cai no mesmo subscriber do roster do Kit e é idempotente", () => {
    const db = freshDb();
    const rosterId = ensureSubscriber(db, "kit", "123", "pessoa@exemplo.com");
    const first = ingestKitWebhookEvents(db, [ev(), ev({ key: "ev:123:2026-10-20T08:00:00.000Z:click:cd", type: "click", url: "https://x", received_at: "2026-10-20T08:00:00.000Z" })]);
    assert.deepEqual(first, { newEvents: 2, alreadyKnown: 0, retryDuplicates: 0 });
    assert.deepEqual(ingestKitWebhookEvents(db, [ev()]), { newEvents: 0, alreadyKnown: 1, retryDuplicates: 0 });

    assert.deepEqual(findSubscriberIdsByEmail(db, "pessoa@exemplo.com"), [rosterId]);
    const timeline = getKitWebhookEventsForSubscriber(db, rosterId);
    assert.deepEqual(timeline.map((t) => [t.type, t.received_at]), [
      ["click", "2026-10-20T08:00:00.000Z"],
      ["unsubscribe", "2026-10-20T22:55:01.000Z"],
    ]);
    // Não duplica o eixo de métricas: nada entra em `event`.
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM event").get() as { n: number }).n, 0);
    assert.equal(getLatestKitWebhookEventReceivedAt(db), "2026-10-20T22:55:01.000Z");
  });

  it("corpo sem e-mail resolve pelo id do Kit, sem criar 2ª pessoa", () => {
    const db = freshDb();
    const rosterId = ensureSubscriber(db, "kit", "123", "pessoa@exemplo.com");
    const { subscriberId } = recordKitWebhookEvent(db, ev({ email: null }));
    assert.equal(subscriberId, rosterId);
  });

  it("e-mail trocado no Kit resolve pelo id do Kit, sem criar 2ª pessoa (#10717)", () => {
    const db = freshDb();
    const rosterId = ensureSubscriber(db, "kit", "123", "pessoa@exemplo.com");
    const before = (db.prepare("SELECT COUNT(*) AS n FROM subscriber").get() as { n: number }).n;
    const { subscriberId, inserted } = recordKitWebhookEvent(db, ev({ email: "Novo@Exemplo.com" }));
    assert.equal(inserted, true);
    assert.equal(subscriberId, rosterId);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM subscriber").get() as { n: number }).n, before);
    const kitAliases = db
      .prepare("SELECT DISTINCT subscriber_id FROM identity_alias WHERE platform = 'kit' AND external_id = '123'")
      .all() as Array<{ subscriber_id: number }>;
    assert.deepEqual(kitAliases.map((r) => r.subscriber_id), [rosterId]);
    const [row] = getKitWebhookEventsForSubscriber(db, rosterId);
    assert.equal(row.email, "novo@exemplo.com");
    // Idempotência pela chave segue valendo.
    assert.equal(recordKitWebhookEvent(db, ev({ email: "novo@exemplo.com" })).inserted, false);
  });

  it("id do Kit ainda desconhecido: cria pelo find-or-create de sempre", () => {
    const db = freshDb();
    const { subscriberId } = recordKitWebhookEvent(db, ev({ kit_subscriber_id: "999", email: "outra@exemplo.com" }));
    assert.equal(subscriberId, ensureSubscriber(db, "kit", "999", "outra@exemplo.com"));
  });

  it("merge de identidade carrega a linha do tempo junto", () => {
    const db = freshDb();
    const beehiivId = ensureSubscriber(db, "beehiiv", "b-1", "pessoa@exemplo.com");
    const kitId = ensureSubscriber(db, "kit", "123", "pessoa@exemplo.com");
    recordKitWebhookEvent(db, ev());
    resolveIdentitiesByEmail(db);
    const [canonical] = findSubscriberIdsByEmail(db, "pessoa@exemplo.com");
    assert.ok(canonical === beehiivId || canonical === kitId);
    assert.equal(getKitWebhookEventsForSubscriber(db, canonical).length, 1);
  });

  it("since incremental com margem; tabela vazia pede tudo", () => {
    assert.equal(computeIncrementalSince(null), null);
    assert.equal(
      computeIncrementalSince("2026-10-20T22:55:01.000Z"),
      new Date(Date.parse("2026-10-20T22:55:01.000Z") - KIT_WEBHOOK_SINCE_SAFETY_MS).toISOString(),
    );
  });

  it("fetch descarta registros fora do contrato e reporta erro HTTP", async () => {
    const good = ev();
    const okFetch = (async () =>
      new Response(JSON.stringify({ events: [good, { key: "x" }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await fetchKitWebhookEvents("https://w.example", READ_TOKEN, null, okFetch);
    assert.ok(r.ok);
    assert.equal(r.ok && r.events.length, 1);
    assert.equal(r.ok && r.malformed, 1);
    assert.equal(isKitWebhookEventRecord({ ...good, type: "open" }), false);

    const failFetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const f = await fetchKitWebhookEvents("https://w.example", READ_TOKEN, null, failFetch);
    assert.equal(f.ok, false);
  });

  it("CLI ponta a ponta contra o Worker (KV falso) e sem config sai 0", async () => {
    const kv = new FakeKv();
    await handleRequest(post(`/webhook/${SECRET}/unsubscribe`, sub(77, "x@y.com")), env(kv), deps("2026-10-20T22:55:01.000Z"));
    const workerFetch = (async (input: string | URL | Request, init?: RequestInit) =>
      handleRequest(new Request(input as string, init), env(kv))) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "kit-webhooks-cli-10648-"));
    const dbPath = join(dir, "diaria-subscribers", "store.db");
    const envVars = { KIT_EVENTS_URL: "https://kit-events.example.workers.dev", KIT_EVENTS_READ_TOKEN: READ_TOKEN };
    assert.equal(await ingestMain(["--db", dbPath, "--write"], workerFetch, envVars), 0);
    const db = openDiariaSubscribersDb(dbPath);
    const [id] = findSubscriberIdsByEmail(db, "x@y.com");
    assert.deepEqual(getKitWebhookEventsForSubscriber(db, id).map((e) => e.type), ["unsubscribe"]);
    db.close();

    assert.equal(await ingestMain(["--db", dbPath], workerFetch, {}), 0);
  });
});

describe("deploy", () => {
  it("workflow redeploya quando o contrato compartilhado muda", () => {
    const yml = readFileSync(resolve(ROOT, ".github/workflows/deploy-kit-events.yml"), "utf8");
    assert.match(yml, /'workers\/kit-events\/\*\*'/);
    assert.match(yml, /'scripts\/lib\/kit-webhook-events-contract\.ts'/);
  });
});

describe("escritor único e task agendada (#10746)", () => {
  const envVars = { KIT_EVENTS_URL: "https://kit-events.example.workers.dev", KIT_EVENTS_READ_TOKEN: READ_TOKEN };
  const workerWith = async (kv: FakeKv) => {
    await handleRequest(post(`/webhook/${SECRET}/unsubscribe`, sub(78, "w@y.com")), env(kv), deps("2026-10-21T10:00:00.000Z"));
    return (async (input: string | URL | Request, init?: RequestInit) =>
      handleRequest(new Request(input as string, init), env(kv))) as typeof fetch;
  };

  it("sem --write só lê: não grava no banco", async () => {
    const fetchW = await workerWith(new FakeKv());
    const dir = mkdtempSync(join(tmpdir(), "kit-webhooks-nowrite-"));
    const dbPath = join(dir, "diaria-subscribers", "store.db");
    assert.equal(await ingestMain(["--db", dbPath], fetchW, envVars), 0);
    const db = openDiariaSubscribersDb(dbPath);
    assert.deepEqual(findSubscriberIdsByEmail(db, "w@y.com"), []);
    db.close();
  });

  it("cópia de conflito do OneDrive ao lado do banco aborta a escrita", async () => {
    const fetchW = await workerWith(new FakeKv());
    const dir = mkdtempSync(join(tmpdir(), "kit-webhooks-conflict-"));
    const dbDir = join(dir, "diaria-subscribers");
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, "store-Neo.db"), "");
    assert.equal(await ingestMain(["--db", join(dbDir, "store.db"), "--write"], fetchW, envVars), 1);
  });

  it("Diaria-Kit-Roster-Ingest roda a ingestão dos webhooks com --write", () => {
    const task = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Kit-Roster-Ingest");
    assert.ok(task);
    const step = task.steps.find((s) => s.script === "scripts/diaria-subscribers-ingest-kit-webhooks.ts");
    assert.ok(step, "passo de webhooks ausente da task");
    assert.deepEqual(step.args, ["--write"]);
  });
});
