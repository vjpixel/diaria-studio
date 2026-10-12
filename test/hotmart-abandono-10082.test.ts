/**
 * test/hotmart-abandono-10082.test.ts (#10082)
 *
 * Webhook de abandono de carrinho da Hotmart (`PURCHASE_OUT_OF_SHOPPING_CART`)
 * no Worker `site`: hottok inválido ou ausente é recusado; o payload de
 * exemplo da Hotmart gera um registro SEM nome, e-mail, telefone nem IP; a
 * leitura autenticada devolve os registros do período.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAbandonoRecord,
  abandonoKvKey,
  brtDay,
  resolvePeriodo,
  secretMatches,
  ABANDONO_KV_PREFIX,
  ABANDONOS_MAX_DIAS,
  HOTMART_WEBHOOK_PATH,
  HOTMART_ABANDONOS_PATH,
} from "../scripts/lib/shared/hotmart-abandono.ts";
import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";

const HOTTOK = "hottok-de-teste";
const READ_TOKEN = "token-de-leitura";

/** Formato do exemplo da doc da Hotmart (webhook 2.0.0, abandono de
 * carrinho), com produto e oferta do ingresso e dados pessoais fictícios. */
function hotmartPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "9a2c8f2e-1b7d-4c1e-9f0a-1234567890ab",
    creation_date: Date.UTC(2026, 9, 12, 2, 30), // 12/10 02h30 UTC = 11/10 23h30 em Brasília
    event: "PURCHASE_OUT_OF_SHOPPING_CART",
    version: "2.0.0",
    data: {
      affiliate: false,
      product: { id: 8576469, name: "Crie conteúdo com identidade usando IA" },
      buyer_ip: "200.100.50.25",
      buyer: { name: "Fulana de Tal", email: "fulana@example.com", phone: "5511999998888" },
      offer: { code: "o8hknz2x" },
      checkout_country: { name: "Brasil", iso: "BR" },
      ...((overrides.data as object) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "data")),
  };
}

const PII = ["Fulana", "fulana@example.com", "5511999998888", "200.100.50.25", "Crie conteúdo"];

type Stored = { value: string; metadata: unknown; ttl?: number };

function fakeKv() {
  const store = new Map<string, Stored>();
  const kv = {
    store,
    async put(key: string, value: string, opts?: { metadata?: unknown; expirationTtl?: number }) {
      store.set(key, { value, metadata: opts?.metadata, ttl: opts?.expirationTtl });
    },
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async list(opts: { prefix?: string; cursor?: string }) {
      const names = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
      // Paginação de 1 em 1 para exercitar o cursor.
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const slice = names.slice(start, start + 1);
      const done = start + 1 >= names.length;
      return {
        keys: slice.map((name) => ({ name, metadata: store.get(name)?.metadata })),
        list_complete: done,
        cursor: done ? undefined : String(start + 1),
      };
    },
  };
  return kv;
}

function envWith(kv: ReturnType<typeof fakeKv> | undefined, overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset", { status: 404 }) } as unknown as Env["ASSETS"],
    POLL: { get: async () => null } as unknown as Env["POLL"],
    CURSOS_SUBSCRIBERS: kv as unknown as KVNamespace,
    HOTMART_HOTTOK: HOTTOK,
    HOTMART_ABANDONOS_TOKEN: READ_TOKEN,
    ...overrides,
  };
}

function webhook(body: unknown, hottok: string | null = HOTTOK): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (hottok !== null) headers["X-HOTMART-HOTTOK"] = hottok;
  return new Request(`https://diar.ia.br${HOTMART_WEBHOOK_PATH}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("#10082 buildAbandonoRecord", () => {
  it("payload de exemplo da Hotmart vira registro só com data, produto, oferta e origem", () => {
    const r = buildAbandonoRecord(hotmartPayload(), 0);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.record, {
      evento_id: "9a2c8f2e-1b7d-4c1e-9f0a-1234567890ab",
      criado_em: "2026-10-12T02:30:00.000Z",
      dia: "2026-10-11",
      produto_id: 8576469,
      oferta: "o8hknz2x",
      src: null,
      sck: null,
      afiliado: false,
    });
    const json = JSON.stringify(r.record);
    for (const p of PII) assert.ok(!json.includes(p), `registro contém dado pessoal: ${p}`);
  });

  it("lê src/sck de data.purchase.origin (formato da compra) e de data.origin", () => {
    const a = buildAbandonoRecord(hotmartPayload({ data: { purchase: { origin: { src: "meta", sck: "lp-d-AD99" } } } }), 0);
    assert.ok(a.ok && a.record.src === "meta" && a.record.sck === "lp-d-AD99");
    const b = buildAbandonoRecord(hotmartPayload({ data: { origin: { src: "diaria", sck: "lp-d" } } }), 0);
    assert.ok(b.ok && b.record.src === "diaria" && b.record.sck === "lp-d");
  });

  it("origem com cara de e-mail é descartada, e campos longos são cortados", () => {
    const r = buildAbandonoRecord(hotmartPayload({ data: { origin: { src: "fulana@example.com", sck: "x".repeat(500) } } }), 0);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.record.src, null);
    assert.equal(r.record.sck?.length, 100);
  });

  it("outro evento → not_abandono; corpo que não é objeto → invalid_payload", () => {
    assert.deepEqual(buildAbandonoRecord({ event: "PURCHASE_APPROVED", data: {} }, 0), { ok: false, reason: "not_abandono" });
    assert.deepEqual(buildAbandonoRecord("x", 0), { ok: false, reason: "invalid_payload" });
    assert.deepEqual(buildAbandonoRecord([1], 0), { ok: false, reason: "invalid_payload" });
  });

  it("sem creation_date usa a hora do recebimento; sem id usa chave derivada; id com caractere estranho é limpo", () => {
    const now = Date.UTC(2026, 9, 12, 15, 0);
    const r = buildAbandonoRecord({ event: "PURCHASE_OUT_OF_SHOPPING_CART", data: {} }, now);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.record.criado_em, new Date(now).toISOString());
    assert.equal(r.record.evento_id, `sem-id-${now}`);
    assert.equal(r.record.produto_id, null);
    const s = buildAbandonoRecord(hotmartPayload({ id: "abc/../:x y" }), 0);
    assert.ok(s.ok && s.record.evento_id === "abc..xy");
    if (s.ok) assert.equal(abandonoKvKey(s.record), `${ABANDONO_KV_PREFIX}2026-10-11:abc..xy`);
  });
});

describe("#10082 brtDay / resolvePeriodo / secretMatches", () => {
  it("brtDay usa o dia de Brasília (UTC-3)", () => {
    assert.equal(brtDay(Date.UTC(2026, 9, 12, 2, 59)), "2026-10-11");
    assert.equal(brtDay(Date.UTC(2026, 9, 12, 3, 0)), "2026-10-12");
  });

  it("resolvePeriodo: dias inclusivos, padrão hoje, datas inválidas e período longo recusados", () => {
    const now = Date.UTC(2026, 9, 12, 12, 0);
    assert.deepEqual(resolvePeriodo("2026-10-10", "2026-10-12", now), { ok: true, dias: ["2026-10-10", "2026-10-11", "2026-10-12"] });
    assert.deepEqual(resolvePeriodo(null, null, now), { ok: true, dias: ["2026-10-12"] });
    assert.equal(resolvePeriodo("2026-02-31", null, now).ok, false);
    assert.equal(resolvePeriodo("12/10/2026", null, now).ok, false);
    assert.equal(resolvePeriodo("2026-10-12", "2026-10-10", now).ok, false);
    assert.equal(resolvePeriodo("2026-01-01", "2026-12-31", now).ok, false);
    const limite = resolvePeriodo("2026-01-01", null, now);
    assert.ok(limite.ok);
    const ultimo = new Date(Date.UTC(2026, 0, 1) + (ABANDONOS_MAX_DIAS - 1) * 86400000).toISOString().slice(0, 10);
    assert.equal(resolvePeriodo("2026-01-01", ultimo, now).ok, true);
  });

  it("secretMatches é fail-closed", async () => {
    assert.equal(await secretMatches("a", "a"), true);
    assert.equal(await secretMatches("a", "b"), false);
    assert.equal(await secretMatches("", ""), false);
    assert.equal(await secretMatches("a", undefined), false);
    assert.equal(await secretMatches(null, "a"), false);
  });
});

describe("#10082 POST /webhooks/hotmart", () => {
  it("hottok inválido → 401 e nada gravado", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook(hotmartPayload(), "errado"), envWith(kv));
    assert.equal(res.status, 401);
    assert.equal(kv.store.size, 0);
  });

  it("sem cabeçalho de hottok → 401", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook(hotmartPayload(), null), envWith(kv));
    assert.equal(res.status, 401);
    assert.equal(kv.store.size, 0);
  });

  it("segredo HOTMART_HOTTOK não configurado → 503, mesmo com cabeçalho vazio", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook(hotmartPayload(), ""), envWith(kv, { HOTMART_HOTTOK: undefined }));
    assert.equal(res.status, 503);
    assert.equal(kv.store.size, 0);
  });

  it("payload real de exemplo → 200 e um registro sem dados pessoais, com TTL", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook(hotmartPayload()), envWith(kv));
    assert.equal(res.status, 200);
    assert.equal(kv.store.size, 1);
    const [key, stored] = [...kv.store.entries()][0];
    assert.equal(key, `${ABANDONO_KV_PREFIX}2026-10-11:9a2c8f2e-1b7d-4c1e-9f0a-1234567890ab`);
    for (const text of [key, stored.value, JSON.stringify(stored.metadata)]) {
      for (const p of PII) assert.ok(!text.includes(p), `gravou dado pessoal: ${p}`);
    }
    assert.deepEqual(stored.metadata, JSON.parse(stored.value));
    assert.ok(new TextEncoder().encode(JSON.stringify(stored.metadata)).length < 1024, "metadata cabe no limite do KV");
    assert.ok(stored.ttl && stored.ttl > 0);
  });

  it("reenvio do mesmo evento não duplica", async () => {
    const kv = fakeKv();
    await worker.fetch(webhook(hotmartPayload()), envWith(kv));
    await worker.fetch(webhook(hotmartPayload()), envWith(kv));
    assert.equal(kv.store.size, 1);
  });

  it("outro evento da Hotmart → 200 ignorado, nada gravado", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook({ event: "PURCHASE_APPROVED", data: {} }), envWith(kv));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: true });
    assert.equal(kv.store.size, 0);
  });

  it("JSON inválido → 400; KV indisponível → 503; falha ao gravar → 500 (a Hotmart reenvia)", async () => {
    assert.equal((await worker.fetch(webhook("{ x"), envWith(fakeKv()))).status, 400);
    assert.equal((await worker.fetch(webhook(hotmartPayload()), envWith(undefined))).status, 503);
    const broken = fakeKv();
    broken.put = async () => {
      throw new Error("kv fora");
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal((await worker.fetch(webhook(hotmartPayload()), envWith(broken))).status, 500);
    } finally {
      console.error = originalError;
    }
  });

  it("GET no caminho do webhook não é tratado pela rota (cai nos assets)", async () => {
    const res = await worker.fetch(new Request(`https://diar.ia.br${HOTMART_WEBHOOK_PATH}`), envWith(fakeKv()));
    assert.equal(res.status, 404);
  });
});

describe("#10082 GET /hotmart/abandonos", () => {
  async function seeded() {
    const kv = fakeKv();
    const env = envWith(kv);
    await worker.fetch(webhook(hotmartPayload()), env); // dia 2026-10-11
    await worker.fetch(
      webhook(hotmartPayload({ id: "evento-2", creation_date: Date.UTC(2026, 9, 12, 15, 0), data: { origin: { src: "meta", sck: "lp-d-AD99" } } })),
      env,
    ); // 2026-10-12
    await worker.fetch(webhook(hotmartPayload({ id: "evento-3", creation_date: Date.UTC(2026, 9, 12, 16, 0) })), env); // 2026-10-12
    await worker.fetch(webhook(hotmartPayload({ id: "evento-4", creation_date: Date.UTC(2026, 9, 14, 16, 0) })), env); // fora
    return env;
  }

  function read(query: string, token: string | null = READ_TOKEN): Request {
    const headers: Record<string, string> = {};
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return new Request(`https://diar.ia.br${HOTMART_ABANDONOS_PATH}${query}`, { headers });
  }

  it("com token devolve os registros do período, em ordem, sem dados pessoais", async () => {
    const env = await seeded();
    const res = await worker.fetch(read("?de=2026-10-11&ate=2026-10-12"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const body = (await res.json()) as { total: number; registros: Array<{ evento_id: string; src: string | null; dia: string }> };
    assert.equal(body.total, 3);
    assert.deepEqual(
      body.registros.map((r) => r.evento_id),
      ["9a2c8f2e-1b7d-4c1e-9f0a-1234567890ab", "evento-2", "evento-3"],
    );
    assert.equal(body.registros[1].src, "meta");
    const text = JSON.stringify(body);
    for (const p of PII) assert.ok(!text.includes(p));
  });

  it("token errado ou ausente → 401; token não configurado → 503", async () => {
    const env = await seeded();
    assert.equal((await worker.fetch(read("?de=2026-10-11", "errado"), env)).status, 401);
    assert.equal((await worker.fetch(read("?de=2026-10-11", null), env)).status, 401);
    // O hottok do webhook não serve como token de leitura.
    assert.equal((await worker.fetch(read("?de=2026-10-11", HOTTOK), env)).status, 401);
    const semToken = { ...env, HOTMART_ABANDONOS_TOKEN: undefined };
    assert.equal((await worker.fetch(read("?de=2026-10-11"), semToken)).status, 503);
  });

  it("período inválido → 400", async () => {
    const env = await seeded();
    assert.equal((await worker.fetch(read("?de=ontem"), env)).status, 400);
  });

  it("registro sem metadata (gravado à mão) é lido pelo valor", async () => {
    const kv = fakeKv();
    await kv.put(`${ABANDONO_KV_PREFIX}2026-10-11:manual`, JSON.stringify({ evento_id: "manual", criado_em: "2026-10-11T12:00:00.000Z" }));
    const res = await worker.fetch(read("?de=2026-10-11"), envWith(kv));
    const body = (await res.json()) as { total: number };
    assert.equal(body.total, 1);
  });
});
