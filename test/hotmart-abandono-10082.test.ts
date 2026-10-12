/**
 * test/hotmart-abandono-10082.test.ts (#10082)
 *
 * Webhook de abandono de carrinho da Hotmart (`PURCHASE_OUT_OF_SHOPPING_CART`)
 * no Worker `site`: hottok inválido ou ausente é recusado; um payload no
 * formato da doc da Hotmart gera um registro SEM nome, e-mail, telefone nem
 * IP (nem no KV, nem na resposta, nem no log); a leitura autenticada devolve
 * os registros do período e sobrevive a registros ruins.
 *
 * O payload é montado a partir da doc 2.0.0 (campos id, creation_date, event,
 * version, data.affiliate, data.product, data.buyer, data.offer,
 * data.checkout_country, mais data.buyer_ip dos exemplos). Não é uma entrega
 * capturada: conferir com a primeira entrega real no histórico do webhook.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildAbandonoRecord,
  abandonoKvKey,
  brtDay,
  cleanToken,
  resolvePeriodo,
  parseAbandonoRecord,
  fitsKvMetadata,
  ABANDONO_KV_PREFIX,
  ABANDONOS_MAX_DIAS,
  HOTMART_WEBHOOK_PATH,
  HOTMART_ABANDONOS_PATH,
  type AbandonoRecord,
} from "../scripts/lib/shared/hotmart-abandono.ts";
import { secretMatches } from "../scripts/lib/shared/secret-compare.ts";
import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";

const HOTTOK = "hottok-de-teste";
const READ_TOKEN = "token-de-leitura";
const NOW = Date.UTC(2026, 9, 12, 15, 0);
const HASH = "ab".repeat(32);

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
      buyer: { name: "Fulana de Tal", email: "fulana@example.com", phone: "5511999998888", document: "12345678900" },
      offer: { code: "o8hknz2x" },
      checkout_country: { name: "Brasil", iso: "BR" },
      campo_pessoal_novo: "segredo-pessoal",
      ...((overrides.data as object) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "data")),
  };
}

/** Dados pessoais do payload e o nome do produto (que também não é gravado). */
const NAO_GRAVAR = [
  "Fulana",
  "fulana@example.com",
  "5511999998888",
  "200.100.50.25",
  "12345678900",
  "segredo-pessoal",
  "Crie conteúdo",
];

function build(payload: unknown, now = NOW) {
  return buildAbandonoRecord(payload, now, HASH);
}

type Stored = { value: string; metadata: unknown; ttl?: number };

/** KV falso com as regras do real que importam aqui: metadata até 1024
 * bytes e listagem paginada (de 1 em 1, para exercitar o cursor). */
function fakeKv() {
  const store = new Map<string, Stored>();
  const kv = {
    store,
    failList: false,
    async put(key: string, value: string, opts?: { metadata?: unknown; expirationTtl?: number }) {
      if (opts?.metadata !== undefined && new TextEncoder().encode(JSON.stringify(opts.metadata)).length > 1024) {
        throw new Error("metadata too large");
      }
      store.set(key, { value, metadata: opts?.metadata, ttl: opts?.expirationTtl });
    },
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async list(opts: { prefix?: string; cursor?: string }) {
      if (kv.failList) throw new Error("kv fora");
      const names = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const done = start + 1 >= names.length;
      return {
        keys: names.slice(start, start + 1).map((name) => ({ name, metadata: store.get(name)?.metadata ?? null })),
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

function webhook(body: unknown, hottok: string | null = HOTTOK, path = HOTMART_WEBHOOK_PATH): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (hottok !== null) headers["X-HOTMART-HOTTOK"] = hottok;
  return new Request(`https://diar.ia.br${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Captura todo log do Worker: nenhum pode levar dado pessoal nem o hottok.
let logs: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  logs = [];
  for (const k of ["log", "warn", "error"] as const) console[k] = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
});
afterEach(() => {
  Object.assign(console, original);
  const all = logs.join("\n");
  for (const p of [...NAO_GRAVAR, HOTTOK]) assert.ok(!all.includes(p), `log com dado que não pode sair: ${p}`);
});

describe("#10082 buildAbandonoRecord", () => {
  it("payload no formato da doc vira registro só com os campos da allowlist", () => {
    const r = build(hotmartPayload());
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.record, {
      v: 1,
      evento_id: "9a2c8f2e-1b7d-4c1e-9f0a-1234567890ab",
      criado_em: "2026-10-12T02:30:00.000Z",
      criado_em_origem: "hotmart",
      dia: "2026-10-11",
      produto_id: 8576469,
      oferta: "o8hknz2x",
      src: null,
      sck: null,
      afiliado: false,
    });
    const json = JSON.stringify(r.record);
    for (const p of NAO_GRAVAR) assert.ok(!json.includes(p), `registro contém: ${p}`);
  });

  it("lê src/sck de data.purchase.origin, de data.origin e de data", () => {
    for (const data of [{ purchase: { origin: { src: "meta", sck: "lp-d-AD99" } } }, { origin: { src: "meta", sck: "lp-d-AD99" } }, { src: "meta", sck: "lp-d-AD99" }]) {
      const r = build(hotmartPayload({ data }));
      assert.ok(r.ok);
      if (!r.ok) return;
      assert.equal(r.record.src, "meta");
      assert.equal(r.record.sck, "lp-d-AD99");
    }
  });

  it("creation_date fora da faixa, em segundos, em texto ou ausente nunca lança", () => {
    const casos: Array<[unknown, string, "hotmart" | "recebimento"]> = [
      [1e20, new Date(NOW).toISOString(), "recebimento"],
      [-1e20, new Date(NOW).toISOString(), "recebimento"],
      [1760236200, new Date(NOW).toISOString(), "recebimento"], // segundos
      [String(Date.UTC(2026, 9, 12, 10)), "2026-10-12T10:00:00.000Z", "hotmart"],
      [undefined, new Date(NOW).toISOString(), "recebimento"],
      [NOW + 5 * 86400000, new Date(NOW).toISOString(), "recebimento"], // futuro distante
    ];
    for (const [creation_date, esperado, origem] of casos) {
      const r = build(hotmartPayload({ creation_date }));
      assert.ok(r.ok, String(creation_date));
      if (!r.ok) return;
      assert.equal(r.record.criado_em, esperado, String(creation_date));
      assert.equal(r.record.criado_em_origem, origem, String(creation_date));
    }
  });

  it("produto_id aceita número ou texto numérico; o resto vira null", () => {
    const comoTexto = build(hotmartPayload({ data: { product: { id: "8576469" } } }));
    assert.ok(comoTexto.ok && comoTexto.record.produto_id === 8576469);
    const lixo = build(hotmartPayload({ data: { product: { id: "abc" } } }));
    assert.ok(lixo.ok && lixo.record.produto_id === null);
  });

  it("outro evento → not_abandono; corpo que não é objeto → invalid_payload", () => {
    assert.deepEqual(build({ event: "PURCHASE_APPROVED", data: {} }), { ok: false, reason: "not_abandono" });
    assert.deepEqual(build("x"), { ok: false, reason: "invalid_payload" });
    assert.deepEqual(build([1]), { ok: false, reason: "invalid_payload" });
  });

  it("sem id utilizável, o id vem do hash do corpo (reenvio idêntico cai na mesma chave)", () => {
    for (const id of [undefined, "", "abc/../:x y", "fulana@example.com"]) {
      const r = build(hotmartPayload({ id }));
      assert.ok(r.ok);
      if (!r.ok) return;
      assert.equal(r.record.evento_id, `sem-id-${HASH.slice(0, 32)}`);
      assert.equal(abandonoKvKey(r.record), `${ABANDONO_KV_PREFIX}2026-10-11:sem-id-${HASH.slice(0, 32)}`);
    }
  });
});

describe("#10082 cleanToken (src/sck/oferta)", () => {
  it("aceita códigos usuais", () => {
    for (const v of ["meta", "diaria", "lp-d-AD99", "lp-guia", "o8hknz2x", "utm:x_1.2"]) assert.equal(cleanToken(v), v);
  });

  it("descarta e-mail (inclusive %40 e @ depois do corte), telefone, documento, espaço e caractere de controle", () => {
    const casos = [
      "fulana@example.com",
      "fulana%40example.com",
      "x".repeat(95) + "fulana@example.com",
      "5511999998888",
      "123.456.789-00",
      "Fulana de Tal",
      "\u0001".repeat(150),
      "字".repeat(100),
      "",
    ];
    for (const v of casos) assert.equal(cleanToken(v), null, JSON.stringify(v).slice(0, 40));
  });

  it("corta em 100 caracteres", () => {
    assert.equal(cleanToken("a".repeat(150))?.length, 100);
  });

  it("pior caso aceito cabe na metadata do KV", () => {
    const r = build(hotmartPayload({ id: "i".repeat(100), data: { offer: { code: "o".repeat(80) }, origin: { src: "s".repeat(300), sck: "k".repeat(300) } } }));
    assert.ok(r.ok);
    if (r.ok) assert.ok(fitsKvMetadata(r.record));
  });
});

describe("#10082 brtDay / resolvePeriodo / secretMatches / parseAbandonoRecord", () => {
  it("brtDay usa o dia de Brasília (UTC-3)", () => {
    assert.equal(brtDay(Date.UTC(2026, 9, 12, 2, 59)), "2026-10-11");
    assert.equal(brtDay(Date.UTC(2026, 9, 12, 3, 0)), "2026-10-12");
  });

  it("resolvePeriodo: dias inclusivos; um só parâmetro vale um dia; padrão hoje; erros com motivo", () => {
    assert.deepEqual(resolvePeriodo("2026-10-10", "2026-10-12", NOW), {
      ok: true,
      de: "2026-10-10",
      ate: "2026-10-12",
      dias: ["2026-10-10", "2026-10-11", "2026-10-12"],
    });
    assert.deepEqual(resolvePeriodo(null, null, NOW), { ok: true, de: "2026-10-12", ate: "2026-10-12", dias: ["2026-10-12"] });
    assert.deepEqual(resolvePeriodo(null, "2026-10-01", NOW), { ok: true, de: "2026-10-01", ate: "2026-10-01", dias: ["2026-10-01"] });
    assert.deepEqual(resolvePeriodo("2026-02-31", null, NOW), { ok: false, reason: "invalid_date" });
    assert.deepEqual(resolvePeriodo("12/10/2026", null, NOW), { ok: false, reason: "bad_format" });
    assert.deepEqual(resolvePeriodo("2026-10-12", "2026-10-10", NOW), { ok: false, reason: "range_inverted" });
    const dia = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString().slice(0, 10);
    assert.equal(resolvePeriodo("2026-01-01", dia(ABANDONOS_MAX_DIAS - 1), NOW).ok, true);
    assert.deepEqual(resolvePeriodo("2026-01-01", dia(ABANDONOS_MAX_DIAS), NOW), { ok: false, reason: "range_too_long" });
  });

  it("secretMatches é fail-closed", async () => {
    assert.equal(await secretMatches("a", "a"), true);
    assert.equal(await secretMatches("a", "b"), false);
    assert.equal(await secretMatches("", ""), false);
    assert.equal(await secretMatches("a", undefined), false);
    assert.equal(await secretMatches(null, "a"), false);
  });

  it("parseAbandonoRecord recusa o que não tem forma de registro", () => {
    assert.equal(parseAbandonoRecord(null), null);
    assert.equal(parseAbandonoRecord("x"), null);
    assert.equal(parseAbandonoRecord({ evento_id: "a", dia: "2026-10-11" }), null);
    assert.equal(parseAbandonoRecord({ evento_id: "a", criado_em: "ontem", dia: "2026-10-11" }), null);
    assert.ok(parseAbandonoRecord({ evento_id: "a", criado_em: "2026-10-11T12:00:00.000Z", dia: "2026-10-11" }));
  });
});

describe("#10082 POST /webhooks/hotmart", () => {
  it("hottok inválido → 401 e nada gravado", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook(hotmartPayload(), "errado"), envWith(kv));
    assert.equal(res.status, 401);
    assert.equal(kv.store.size, 0);
  });

  it("sem cabeçalho de hottok → 401, e a autenticação vem antes de ler o corpo", async () => {
    const kv = fakeKv();
    assert.equal((await worker.fetch(webhook(hotmartPayload(), null), envWith(kv))).status, 401);
    assert.equal((await worker.fetch(webhook("{ não é json", "errado"), envWith(kv))).status, 401);
    assert.equal(kv.store.size, 0);
  });

  it("segredo HOTMART_HOTTOK não configurado → 503, mesmo com cabeçalho vazio", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook(hotmartPayload(), ""), envWith(kv, { HOTMART_HOTTOK: undefined }));
    assert.equal(res.status, 503);
    assert.equal(kv.store.size, 0);
  });

  it("payload no formato da doc → 200 e um registro sem dados pessoais, com TTL e metadata", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook(hotmartPayload()), envWith(kv));
    assert.equal(res.status, 200);
    assert.equal(kv.store.size, 1);
    const [key, stored] = [...kv.store.entries()][0];
    assert.equal(key, `${ABANDONO_KV_PREFIX}2026-10-11:9a2c8f2e-1b7d-4c1e-9f0a-1234567890ab`);
    for (const text of [key, stored.value, JSON.stringify(stored.metadata), await res.text()]) {
      for (const p of NAO_GRAVAR) assert.ok(!text.includes(p), `gravou ou devolveu: ${p}`);
    }
    assert.deepEqual(stored.metadata, JSON.parse(stored.value));
    assert.ok(stored.ttl && stored.ttl > 0);
  });

  it("aceita o caminho com barra final", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook(hotmartPayload(), HOTTOK, `${HOTMART_WEBHOOK_PATH}/`), envWith(kv));
    assert.equal(res.status, 200);
    assert.equal(kv.store.size, 1);
  });

  it("origem com dado pessoal não chega ao KV", async () => {
    const kv = fakeKv();
    await worker.fetch(webhook(hotmartPayload({ data: { origin: { src: "fulana@example.com", sck: "5511999998888" } } })), envWith(kv));
    const stored = [...kv.store.values()][0];
    assert.equal(JSON.parse(stored.value).src, null);
    assert.equal(JSON.parse(stored.value).sck, null);
  });

  it("reenvio do mesmo evento não duplica, com ou sem id", async () => {
    const kv = fakeKv();
    await worker.fetch(webhook(hotmartPayload()), envWith(kv));
    await worker.fetch(webhook(hotmartPayload()), envWith(kv));
    const semId = hotmartPayload({ id: undefined });
    await worker.fetch(webhook(semId), envWith(kv));
    await worker.fetch(webhook(semId), envWith(kv));
    assert.equal(kv.store.size, 2);
  });

  it("outro evento da Hotmart → 200 ignorado, nada gravado, aviso no log", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook({ event: "PURCHASE_APPROVED", version: "2.0.0", data: {} }), envWith(kv));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ignored: true });
    assert.equal(kv.store.size, 0);
    assert.ok(logs.some((l) => l.includes("evento ignorado: PURCHASE_APPROVED")));
  });

  it("JSON inválido ou corpo sem forma → 400; KV indisponível → 503; falha ao gravar → 500 (a Hotmart reenvia)", async () => {
    assert.equal((await worker.fetch(webhook("{ x"), envWith(fakeKv()))).status, 400);
    assert.equal((await worker.fetch(webhook([1, 2]), envWith(fakeKv()))).status, 400);
    assert.equal((await worker.fetch(webhook(hotmartPayload()), envWith(undefined))).status, 503);
    const broken = fakeKv();
    broken.put = async () => {
      throw new Error("kv fora");
    };
    assert.equal((await worker.fetch(webhook(hotmartPayload()), envWith(broken))).status, 500);
  });

  it("GET no caminho do webhook não é tratado pela rota (cai nos assets)", async () => {
    let assetCalls = 0;
    const env = envWith(fakeKv(), {
      ASSETS: { fetch: async () => (assetCalls++, new Response("asset", { status: 404 })) } as unknown as Env["ASSETS"],
    });
    await worker.fetch(new Request(`https://diar.ia.br${HOTMART_WEBHOOK_PATH}`), env);
    assert.equal(assetCalls, 1);
  });
});

describe("#10082 GET /hotmart/abandonos", () => {
  async function seeded() {
    const kv = fakeKv();
    const env = envWith(kv);
    await worker.fetch(webhook(hotmartPayload()), env); // 2026-10-11
    await worker.fetch(
      webhook(hotmartPayload({ id: "evento-2", creation_date: Date.UTC(2026, 9, 12, 15, 0), data: { origin: { src: "meta", sck: "lp-d-AD99" } } })),
      env,
    ); // 2026-10-12
    await worker.fetch(webhook(hotmartPayload({ id: "evento-3", creation_date: Date.UTC(2026, 9, 12, 16, 0) })), env); // 2026-10-12
    await worker.fetch(webhook(hotmartPayload({ id: "evento-4", creation_date: Date.UTC(2026, 9, 9, 16, 0) })), env); // fora do período
    return { kv, env };
  }

  function read(query: string, token: string | null = READ_TOKEN): Request {
    const headers: Record<string, string> = {};
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return new Request(`https://diar.ia.br${HOTMART_ABANDONOS_PATH}${query}`, { headers });
  }

  it("com token devolve os registros do período, em ordem, sem dados pessoais", async () => {
    const { env } = await seeded();
    const res = await worker.fetch(read("?de=2026-10-11&ate=2026-10-12"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const text = await res.text();
    const body = JSON.parse(text) as { de: string; ate: string; total: number; registros: AbandonoRecord[]; ignorados: string[] };
    assert.equal(body.de, "2026-10-11");
    assert.equal(body.ate, "2026-10-12");
    assert.equal(body.total, 3);
    assert.deepEqual(
      body.registros.map((r) => r.evento_id),
      ["9a2c8f2e-1b7d-4c1e-9f0a-1234567890ab", "evento-2", "evento-3"],
    );
    assert.equal(body.registros[1].src, "meta");
    assert.deepEqual(body.ignorados, []);
    for (const p of NAO_GRAVAR) assert.ok(!text.includes(p));
  });

  it("token errado, ausente ou o hottok → 401; token não configurado → 503", async () => {
    const { env } = await seeded();
    assert.equal((await worker.fetch(read("?de=2026-10-11", "errado"), env)).status, 401);
    assert.equal((await worker.fetch(read("?de=2026-10-11", null), env)).status, 401);
    assert.equal((await worker.fetch(read("?de=2026-10-11", HOTTOK), env)).status, 401);
    assert.equal((await worker.fetch(read("?de=2026-10-11"), { ...env, HOTMART_ABANDONOS_TOKEN: undefined })).status, 503);
  });

  it("período inválido → 400 com motivo", async () => {
    const { env } = await seeded();
    const res = await worker.fetch(read("?de=ontem"), env);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "bad_format");
  });

  it("registro sem metadata é lido pelo valor; valor corrompido ou sem forma é pulado e listado", async () => {
    const kv = fakeKv();
    await kv.put(`${ABANDONO_KV_PREFIX}2026-10-11:manual`, JSON.stringify({ evento_id: "manual", criado_em: "2026-10-11T12:00:00.000Z", dia: "2026-10-11" }));
    await kv.put(`${ABANDONO_KV_PREFIX}2026-10-11:corrompido`, "{ não é json");
    await kv.put(`${ABANDONO_KV_PREFIX}2026-10-11:sem-data`, JSON.stringify({ evento_id: "x" }));
    const res = await worker.fetch(read("?de=2026-10-11"), envWith(kv));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { total: number; ignorados: string[] };
    assert.equal(body.total, 1);
    assert.deepEqual(body.ignorados.sort(), [`${ABANDONO_KV_PREFIX}2026-10-11:corrompido`, `${ABANDONO_KV_PREFIX}2026-10-11:sem-data`]);
  });

  it("falha do KV na leitura → 502 em JSON", async () => {
    const { kv, env } = await seeded();
    kv.failList = true;
    const res = await worker.fetch(read("?de=2026-10-11"), env);
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: string }).error, "storage_error");
  });
});
