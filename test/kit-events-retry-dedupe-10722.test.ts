/**
 * #10722 — retry do webhook do Kit não pode contar o mesmo evento 2 vezes.
 *
 * O corpo do webhook do Kit não tem id de evento; cada tentativa ganha chave
 * própria no KV (horário + sufixo aleatório). A ingestão deduplica por janela
 * (`KIT_WEBHOOK_RETRY_DEDUPE_MS`): mesmo assinante + tipo + URL perto de um
 * evento já ingerido = retry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleRequest, type Env, type EventsKv } from "../workers/kit-events/src/index.ts";
import {
  ensureSubscriber,
  getKitWebhookEventsForSubscriber,
  openDiariaSubscribersDb,
} from "../scripts/lib/diaria-subscribers-db.ts";
import {
  fetchKitWebhookEvents,
  ingestKitWebhookEvents,
  KIT_WEBHOOK_RETRY_DEDUPE_MS,
} from "../scripts/lib/kit-webhook-events-ingest.ts";
import type { KitWebhookEventRecord } from "../scripts/lib/kit-webhook-events-contract.ts";

const SECRET = "s".repeat(32);
const READ_TOKEN = "r".repeat(32);
const BASE = "https://kit-events.example.workers.dev";

class FakeKv implements EventsKv {
  store = new Map<string, { value: string; metadata?: unknown }>();
  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    this.store.set(key, { value, metadata: options?.metadata });
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async list(options: { prefix: string; cursor?: string }) {
    const names = [...this.store.keys()].filter((k) => k.startsWith(options.prefix)).sort();
    return {
      keys: names.map((name) => ({ name, metadata: this.store.get(name)?.metadata })),
      list_complete: true,
    };
  }
}

const env = (kv: FakeKv): Env => ({ KIT_EVENTS: kv, KIT_WEBHOOK_SECRET: SECRET, EVENTS_READ_TOKEN: READ_TOKEN });
let n = 0;
const deps = (iso: string) => ({ now: () => new Date(iso), randomSuffix: () => `r${++n}` });
const body = (id: number) =>
  JSON.stringify({ subscriber: { id, email_address: "pessoa@exemplo.com", state: "cancelled" } });
const deliver = (kv: FakeKv, path: string, id: number, iso: string) =>
  handleRequest(new Request(`${BASE}${path}`, { method: "POST", body: body(id) }), env(kv), deps(iso));

function freshDb() {
  return openDiariaSubscribersDb(join(mkdtempSync(join(tmpdir(), "kit-retry-10722-")), "store.db"));
}

async function readAll(kv: FakeKv): Promise<KitWebhookEventRecord[]> {
  const workerFetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handleRequest(new Request(input as string, init), env(kv))) as typeof fetch;
  const r = await fetchKitWebhookEvents(BASE, READ_TOKEN, null, workerFetch);
  assert.ok(r.ok);
  return r.ok ? r.events : [];
}

const rec = (over: Partial<KitWebhookEventRecord>): KitWebhookEventRecord => ({
  key: "ev:2026-10-21T10:00:00.000Z:123:unsubscribe:aa",
  type: "unsubscribe",
  kit_subscriber_id: "123",
  email: "pessoa@exemplo.com",
  state: "cancelled",
  url: null,
  received_at: "2026-10-21T10:00:00.000Z",
  ...over,
});

describe("#10722 retry do webhook do Kit", () => {
  it("duas entregas do mesmo evento pelo Worker: 2 chaves no KV, 1 registro no store", async () => {
    const kv = new FakeKv();
    const path = `/webhook/${SECRET}/unsubscribe`;
    assert.equal((await deliver(kv, path, 123, "2026-10-21T10:00:00.000Z")).status, 200);
    assert.equal((await deliver(kv, path, 123, "2026-10-21T10:02:30.000Z")).status, 200);
    assert.equal(kv.store.size, 2, "o KV guarda as duas tentativas");

    const db = freshDb();
    const id = ensureSubscriber(db, "kit", "123", "pessoa@exemplo.com");
    const result = ingestKitWebhookEvents(db, await readAll(kv));
    assert.deepEqual(result, { newEvents: 1, alreadyKnown: 0, retryDuplicates: 1 });
    const timeline = getKitWebhookEventsForSubscriber(db, id);
    assert.deepEqual(timeline.map((t) => t.received_at), ["2026-10-21T10:00:00.000Z"]);

    // Reingestão da mesma janela (margem incremental) segue idempotente.
    assert.deepEqual(ingestKitWebhookEvents(db, await readAll(kv)), {
      newEvents: 0,
      alreadyKnown: 1,
      retryDuplicates: 1,
    });
    assert.equal(getKitWebhookEventsForSubscriber(db, id).length, 1);
  });

  it("eventos distintos: 2 registros (tipo, assinante ou URL diferentes)", async () => {
    const kv = new FakeKv();
    await deliver(kv, `/webhook/${SECRET}/unsubscribe`, 123, "2026-10-21T10:00:00.000Z");
    await deliver(kv, `/webhook/${SECRET}/bounce`, 123, "2026-10-21T10:00:05.000Z");
    await deliver(kv, `/webhook/${SECRET}/unsubscribe`, 456, "2026-10-21T10:00:05.000Z");
    await deliver(kv, `/webhook/${SECRET}/click?url=${encodeURIComponent("https://a.example")}`, 123, "2026-10-21T10:01:00.000Z");
    await deliver(kv, `/webhook/${SECRET}/click?url=${encodeURIComponent("https://b.example")}`, 123, "2026-10-21T10:01:00.000Z");

    const db = freshDb();
    const result = ingestKitWebhookEvents(db, await readAll(kv));
    assert.deepEqual(result, { newEvents: 5, alreadyKnown: 0, retryDuplicates: 0 });
  });

  it("mesmo evento fora da janela conta de novo", () => {
    const db = freshDb();
    const later = new Date(Date.parse("2026-10-21T10:00:00.000Z") + KIT_WEBHOOK_RETRY_DEDUPE_MS + 1000).toISOString();
    const result = ingestKitWebhookEvents(db, [
      rec({}),
      rec({ key: `ev:${later}:123:unsubscribe:bb`, received_at: later }),
    ]);
    assert.deepEqual(result, { newEvents: 2, alreadyKnown: 0, retryDuplicates: 0 });
  });

  it("retry entre ingestões, em qualquer ordem de chegada, fica 1 registro", () => {
    // A tentativa POSTERIOR chega primeiro (listagem eventualmente consistente
    // do KV); a anterior aparece só na ingestão seguinte.
    const db = freshDb();
    const id = ensureSubscriber(db, "kit", "123", "pessoa@exemplo.com");
    const second = rec({ key: "ev:2026-10-21T10:05:00.000Z:123:unsubscribe:bb", received_at: "2026-10-21T10:05:00.000Z" });
    assert.deepEqual(ingestKitWebhookEvents(db, [second]), { newEvents: 1, alreadyKnown: 0, retryDuplicates: 0 });
    assert.deepEqual(ingestKitWebhookEvents(db, [rec({}), second]), {
      newEvents: 0,
      alreadyKnown: 1,
      retryDuplicates: 1,
    });
    assert.equal(getKitWebhookEventsForSubscriber(db, id).length, 1);
  });

  it("dentro de um lote fica a 1ª tentativa, mesmo fora de ordem na entrada", () => {
    const db = freshDb();
    const id = ensureSubscriber(db, "kit", "123", "pessoa@exemplo.com");
    const second = rec({ key: "ev:2026-10-21T10:05:00.000Z:123:unsubscribe:bb", received_at: "2026-10-21T10:05:00.000Z" });
    ingestKitWebhookEvents(db, [second, rec({})]);
    assert.deepEqual(
      getKitWebhookEventsForSubscriber(db, id).map((t) => t.received_at),
      ["2026-10-21T10:00:00.000Z"],
    );
  });
});

describe("#10747 evento de outro tipo no meio desfaz o retry", () => {
  const ev = (type: KitWebhookEventRecord["type"], iso: string, suffix: string) =>
    rec({ key: `ev:${iso}:123:${type}:${suffix}`, type, received_at: iso, state: type === "activate" ? "active" : "cancelled" });
  const a1 = ev("activate", "2026-10-21T10:00:00.000Z", "a1");
  const u = ev("unsubscribe", "2026-10-21T10:10:00.000Z", "u");
  const a2 = ev("activate", "2026-10-21T10:20:00.000Z", "a2");

  it("activate → unsubscribe → activate em 20 min no mesmo lote: 3 registros", () => {
    const db = freshDb();
    const id = ensureSubscriber(db, "kit", "123", "pessoa@exemplo.com");
    assert.deepEqual(ingestKitWebhookEvents(db, [a1, u, a2]), { newEvents: 3, alreadyKnown: 0, retryDuplicates: 0 });
    assert.deepEqual(
      getKitWebhookEventsForSubscriber(db, id).map((t) => t.type),
      ["activate", "unsubscribe", "activate"],
    );
  });

  it("mesma sequência em 3 ingestões separadas: 3 registros", () => {
    const db = freshDb();
    ingestKitWebhookEvents(db, [a1]);
    ingestKitWebhookEvents(db, [u]);
    assert.deepEqual(ingestKitWebhookEvents(db, [a2]), { newEvents: 1, alreadyKnown: 0, retryDuplicates: 0 });
  });

  it("o activate posterior chega antes; o do meio e o anterior só depois: 3 registros", () => {
    const db = freshDb();
    ingestKitWebhookEvents(db, [a2]);
    assert.deepEqual(ingestKitWebhookEvents(db, [a1, u]), { newEvents: 2, alreadyKnown: 0, retryDuplicates: 0 });
  });

  it("outro tipo FORA do intervalo entre os dois não impede o retry", () => {
    const db = freshDb();
    const before = ev("unsubscribe", "2026-10-21T09:55:00.000Z", "u0");
    const retry = ev("activate", "2026-10-21T10:02:00.000Z", "a1r");
    assert.deepEqual(ingestKitWebhookEvents(db, [before, a1, retry]), {
      newEvents: 2,
      alreadyKnown: 0,
      retryDuplicates: 1,
    });
  });

  it("outro tipo de OUTRO assinante no meio não impede o retry", () => {
    const db = freshDb();
    const other = rec({ key: "ev:2026-10-21T10:01:00.000Z:456:unsubscribe:x", kit_subscriber_id: "456", received_at: "2026-10-21T10:01:00.000Z" });
    const retry = ev("activate", "2026-10-21T10:02:00.000Z", "a1r");
    assert.deepEqual(ingestKitWebhookEvents(db, [a1, other, retry]), {
      newEvents: 2,
      alreadyKnown: 0,
      retryDuplicates: 1,
    });
  });
});
