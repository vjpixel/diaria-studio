/**
 * test/hotmart-vendas-10734.test.ts (#10734)
 *
 * Webhook de vendas da Hotmart (aprovada/cancelada/reembolsada/chargeback) no
 * Worker `site`, na mesma URL e com o mesmo hottok do abandono (#10082):
 * hottok inválido é recusado; o registro grava valor líquido (comissão
 * PRODUCER), produto, oferta, src/sck e o HASH do e-mail, sem nome, e-mail em
 * claro, telefone, documento nem IP (nem no KV, nem na resposta, nem no log);
 * reenvio do mesmo evento não duplica; a leitura autenticada deduplica e
 * soma o saldo líquido.
 *
 * O payload é SINTÉTICO, montado a partir da doc 2.0.0 do webhook de compra
 * (id, creation_date, event, version, data.product, data.buyer,
 * data.commissions, data.purchase.{transaction,price,offer,origin},
 * data.affiliates). Não é uma entrega capturada: conferir com a primeira
 * entrega real no histórico do webhook.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildVendaRecord,
  vendaKvKey,
  parseVendaRecord,
  lerVendas,
  saldoLiquido,
  sinalReceita,
  cleanValor,
  normalizeBuyerEmail,
  isVendaEvent,
  vendaFitsKvMetadata,
  VENDA_KV_PREFIX,
  HOTMART_VENDAS_PATH,
  type VendaRecord,
} from "../scripts/lib/shared/hotmart-vendas.ts";
import { HOTMART_WEBHOOK_PATH } from "../scripts/lib/shared/hotmart-abandono.ts";
import { sha256Hex } from "../scripts/lib/shared/subscriber-verify.ts";
import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";

const HOTTOK = "hottok-de-teste";
const VENDAS_TOKEN = "token-de-vendas";
const ABANDONOS_TOKEN = "token-de-abandonos";
const NOW = Date.UTC(2026, 9, 21, 15, 0);
const HASH = "cd".repeat(32);
const EMAIL = "Comprador.Teste@Example.com";

function vendaPayload(event = "PURCHASE_APPROVED", overrides: { data?: Record<string, unknown>; purchase?: Record<string, unknown>; root?: Record<string, unknown> } = {}) {
  return {
    id: "1f0e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
    creation_date: Date.UTC(2026, 9, 21, 2, 30), // 21/10 02h30 UTC = 20/10 23h30 em Brasília
    event,
    version: "2.0.0",
    data: {
      product: { id: 8576469, ucode: "abc-123", name: "Curso Secreto de Teste" },
      affiliates: [],
      buyer: { email: ` ${EMAIL} `, name: "Beltrano Comprador", checkout_phone: "5511988887777", document: "98765432100" },
      producer: { name: "Produtor Nome" },
      commissions: [
        { value: 14.95, source: "MARKETPLACE", currency_value: "BRL" },
        { value: 135.05, source: "PRODUCER", currency_value: "BRL" },
      ],
      purchase: {
        transaction: "HP16015479281022",
        status: "APPROVED",
        approved_date: Date.UTC(2026, 9, 21, 2, 29),
        price: { value: 150, currency_value: "BRL" },
        full_price: { value: 150, currency_value: "BRL" },
        offer: { code: "o8hknz2x", coupon_code: "CUPOMSECRETO" },
        origin: { src: "meta", sck: "lp-d-AD99", xcod: "xcod-qualquer" },
        payment: { type: "CREDIT_CARD", installments_number: 1 },
        buyer_ip: "200.100.50.26",
        ...(overrides.purchase ?? {}),
      },
      campo_pessoal_novo: "segredo-pessoal-venda",
      ...(overrides.data ?? {}),
    },
    ...(overrides.root ?? {}),
  };
}

const NAO_GRAVAR = [
  "Beltrano",
  "comprador.teste@example.com",
  EMAIL,
  "5511988887777",
  "98765432100",
  "200.100.50.26",
  "segredo-pessoal-venda",
  "Curso Secreto",
  "Produtor Nome",
  "CUPOMSECRETO",
];

type Stored = { value: string; metadata: unknown; ttl?: number };

function fakeKv() {
  const store = new Map<string, Stored>();
  const kv = {
    store,
    failPut: false,
    async put(key: string, value: string, opts?: { metadata?: unknown; expirationTtl?: number }) {
      if (kv.failPut) throw new Error("kv fora");
      if (opts?.metadata !== undefined && new TextEncoder().encode(JSON.stringify(opts.metadata)).length > 1024) throw new Error("metadata too large");
      store.set(key, { value, metadata: opts?.metadata, ttl: opts?.expirationTtl });
    },
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async list(opts: { prefix?: string; cursor?: string }) {
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
    HOTMART_ABANDONOS_TOKEN: ABANDONOS_TOKEN,
    HOTMART_VENDAS_TOKEN: VENDAS_TOKEN,
    ...overrides,
  };
}

function webhook(body: unknown, hottok: string | null = HOTTOK): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (hottok !== null) headers["X-HOTMART-HOTTOK"] = hottok;
  return new Request(`https://diar.ia.br${HOTMART_WEBHOOK_PATH}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function leitura(qs: string, token: string | null = VENDAS_TOKEN): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://diar.ia.br${HOTMART_VENDAS_PATH}${qs}`, { headers });
}

let logs: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  logs = [];
  for (const k of ["log", "warn", "error"] as const) console[k] = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
});
afterEach(async () => {
  Object.assign(console, original);
  const all = logs.join("\n");
  const emailHash = await sha256Hex(EMAIL);
  for (const p of [...NAO_GRAVAR, HOTTOK, VENDAS_TOKEN, emailHash]) assert.ok(!all.includes(p), `log com dado que não pode sair: ${p}`);
});

describe("#10734 buildVendaRecord", () => {
  it("payload no formato da doc vira registro só com a allowlist, e-mail como hash", async () => {
    const r = await buildVendaRecord(vendaPayload(), NOW, HASH);
    assert.ok(r.ok);
    if (!r.ok) return;
    const emailHash = await sha256Hex("comprador.teste@example.com");
    assert.deepEqual(r.record, {
      v: 1,
      evento: "aprovada",
      evento_id: "1f0e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
      transacao: "HP16015479281022",
      criado_em: "2026-10-21T02:30:00.000Z",
      criado_em_origem: "hotmart",
      dia: "2026-10-20",
      produto_id: 8576469,
      oferta: "o8hknz2x",
      valor_liquido: 135.05,
      moeda_liquido: "BRL",
      valor_bruto: 150,
      moeda_bruto: "BRL",
      email_hash: emailHash,
      src: "meta",
      sck: "lp-d-AD99",
      afiliado: false,
    });
    const json = JSON.stringify(r.record);
    for (const p of NAO_GRAVAR) assert.ok(!json.includes(p), `registro contém: ${p}`);
    assert.ok(vendaFitsKvMetadata(r.record));
  });

  it("hash do e-mail é o mesmo do KV de assinantes (normalizado), para o cruzamento futuro", async () => {
    const a = await buildVendaRecord(vendaPayload("PURCHASE_APPROVED", { data: { buyer: { email: "X@Y.COM" } } }), NOW, HASH);
    const b = await buildVendaRecord(vendaPayload("PURCHASE_APPROVED", { data: { buyer: { email: "  x@y.com" } } }), NOW, HASH);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.equal(a.record.email_hash, b.record.email_hash);
    assert.equal(a.record.email_hash, await sha256Hex("x@y.com"));
    assert.match(a.record.email_hash ?? "", /^[0-9a-f]{64}$/);
  });

  it("e-mail ausente ou sem forma de e-mail → email_hash null", async () => {
    for (const email of [undefined, "", "sem-arroba", 123, "a b@c.com"]) {
      const r = await buildVendaRecord(vendaPayload("PURCHASE_APPROVED", { data: { buyer: { email } } }), NOW, HASH);
      assert.ok(r.ok && r.record.email_hash === null, String(email));
    }
  });

  it("mapeia os 4 eventos de venda e recusa os demais", async () => {
    const esperado = { PURCHASE_APPROVED: "aprovada", PURCHASE_CANCELED: "cancelada", PURCHASE_REFUNDED: "reembolsada", PURCHASE_CHARGEBACK: "chargeback" };
    for (const [ev, nome] of Object.entries(esperado)) {
      const r = await buildVendaRecord(vendaPayload(ev), NOW, HASH);
      assert.ok(r.ok && r.record.evento === nome, ev);
    }
    for (const ev of ["PURCHASE_COMPLETE", "PURCHASE_BILLET_PRINTED", "PURCHASE_OUT_OF_SHOPPING_CART", "toString", "__proto__", undefined]) {
      assert.equal(isVendaEvent(ev), false, String(ev));
      assert.deepEqual(await buildVendaRecord({ event: ev, data: {} }, NOW, HASH), { ok: false, reason: "not_venda" });
    }
    assert.deepEqual(await buildVendaRecord("x", NOW, HASH), { ok: false, reason: "invalid_payload" });
    assert.deepEqual(await buildVendaRecord([1], NOW, HASH), { ok: false, reason: "invalid_payload" });
  });

  it("sem comissão PRODUCER (ou com valor/moeda incoerente) o líquido é null, nunca estimado do bruto", async () => {
    const casos: unknown[] = [
      undefined,
      [],
      [{ value: 14.95, source: "MARKETPLACE", currency_value: "BRL" }],
      [{ value: "abc", source: "PRODUCER", currency_value: "BRL" }],
      [{ value: -5, source: "PRODUCER", currency_value: "BRL" }],
      [
        { value: 10, source: "PRODUCER", currency_value: "BRL" },
        { value: 10, source: "PRODUCER", currency_value: "USD" },
      ],
    ];
    for (const commissions of casos) {
      const r = await buildVendaRecord(vendaPayload("PURCHASE_APPROVED", { data: { commissions } }), NOW, HASH);
      assert.ok(r.ok && r.record.valor_liquido === null, JSON.stringify(commissions));
      if (r.ok) assert.equal(r.record.valor_bruto, 150);
    }
    const duas = await buildVendaRecord(
      vendaPayload("PURCHASE_APPROVED", {
        data: {
          commissions: [
            { value: 10.1, source: "PRODUCER", currency_value: "BRL" },
            { value: 0.2, source: "PRODUCER", currency_value: "BRL" },
          ],
        },
      }),
      NOW,
      HASH,
    );
    assert.ok(duas.ok && duas.record.valor_liquido === 10.3 && duas.record.moeda_liquido === "BRL");
  });

  it("sem id nem transação usa o hash do corpo; src/sck com cara de e-mail/telefone são descartados", async () => {
    const r = await buildVendaRecord(
      vendaPayload("PURCHASE_APPROVED", { root: { id: undefined }, purchase: { transaction: undefined, origin: { src: "fulano@x.com", sck: "5511999998888" } } }),
      NOW,
      HASH,
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.record.evento_id, `sem-id-${HASH.slice(0, 32)}`);
    assert.equal(r.record.transacao, `sem-transacao-${HASH.slice(0, 32)}`);
    assert.equal(r.record.src, null);
    assert.equal(r.record.sck, null);
  });

  it("transação com caractere fora do formato (texto livre, injeção de chave) cai no hash do corpo", async () => {
    const r = await buildVendaRecord(vendaPayload("PURCHASE_APPROVED", { purchase: { transaction: "HP1:hotmart:abandono:x" } }), NOW, HASH);
    assert.ok(r.ok && r.record.transacao.startsWith("sem-transacao-"));
  });

  it("afiliado = lista de afiliados não vazia; ausente → null", async () => {
    const com = await buildVendaRecord(vendaPayload("PURCHASE_APPROVED", { data: { affiliates: [{ affiliate_code: "Q1", name: "Afiliado Nome" }] } }), NOW, HASH);
    assert.ok(com.ok && com.record.afiliado === true);
    if (com.ok) assert.ok(!JSON.stringify(com.record).includes("Afiliado Nome"));
    const sem = await buildVendaRecord(vendaPayload("PURCHASE_APPROVED", { data: { affiliates: undefined } }), NOW, HASH);
    assert.ok(sem.ok && sem.record.afiliado === null);
  });

  it("cleanValor arredonda a centavos e recusa lixo", () => {
    assert.equal(cleanValor(135.054), 135.05);
    assert.equal(cleanValor("97.5"), 97.5);
    for (const v of [-1, NaN, Infinity, "1e3", "abc", null, 1e12]) assert.equal(cleanValor(v), null, String(v));
  });

  it("normalizeBuyerEmail só aceita forma de e-mail", () => {
    assert.equal(normalizeBuyerEmail(" A@B.co "), "a@b.co");
    assert.equal(normalizeBuyerEmail("a@b"), null);
  });
});

describe("#10734 chave, parse e saldo", () => {
  async function rec(event: string, transaction: string, creation: number, liquido = 100): Promise<VendaRecord> {
    const r = await buildVendaRecord(
      vendaPayload(event, { root: { id: `ev-${event}-${transaction}`, creation_date: creation }, purchase: { transaction }, data: { commissions: [{ value: liquido, source: "PRODUCER", currency_value: "BRL" }] } }),
      NOW,
      HASH,
    );
    assert.ok(r.ok);
    return (r as { ok: true; record: VendaRecord }).record;
  }

  it("chave = prefixo + dia + transação + evento: aprovação e reembolso da mesma compra não colidem", async () => {
    const a = await rec("PURCHASE_APPROVED", "HP1", Date.UTC(2026, 9, 20, 12));
    const r = await rec("PURCHASE_REFUNDED", "HP1", Date.UTC(2026, 9, 20, 13));
    assert.equal(vendaKvKey(a), `${VENDA_KV_PREFIX}2026-10-20:HP1:aprovada`);
    assert.notEqual(vendaKvKey(a), vendaKvKey(r));
  });

  it("parseVendaRecord devolve só a allowlist e recusa forma inválida", async () => {
    const a = await rec("PURCHASE_APPROVED", "HP1", Date.UTC(2026, 9, 20, 12));
    assert.deepEqual(parseVendaRecord({ ...a, email: "vazou@x.com" }), a);
    assert.equal(parseVendaRecord({ ...a, evento: "outro" }), null);
    assert.equal(parseVendaRecord({ ...a, dia: "20/10" }), null);
    assert.equal(parseVendaRecord(null), null);
    assert.equal(parseVendaRecord({ ...a, email_hash: "nao-e-hash" })?.email_hash, null);
  });

  it("sinalReceita: aprovada soma, reembolso/chargeback subtraem, cancelada não mexe", () => {
    assert.equal(sinalReceita("aprovada"), 1);
    assert.equal(sinalReceita("reembolsada"), -1);
    assert.equal(sinalReceita("chargeback"), -1);
    assert.equal(sinalReceita("cancelada"), 0);
  });

  it("saldoLiquido soma por moeda e conta eventos sem líquido (piso)", async () => {
    const regs = [
      await rec("PURCHASE_APPROVED", "HP1", Date.UTC(2026, 9, 20, 12), 100),
      await rec("PURCHASE_APPROVED", "HP2", Date.UTC(2026, 9, 20, 12), 50.5),
      await rec("PURCHASE_REFUNDED", "HP2", Date.UTC(2026, 9, 20, 14), 50.5),
      await rec("PURCHASE_CANCELED", "HP3", Date.UTC(2026, 9, 20, 12), 999),
      { ...(await rec("PURCHASE_APPROVED", "HP4", Date.UTC(2026, 9, 20, 12))), valor_liquido: null },
    ];
    assert.deepEqual(saldoLiquido(regs), { porMoeda: [{ moeda: "BRL", liquido: 100, aprovadas: 2, estornos: 1 }], semValorLiquido: 1 });
  });

  it("lerVendas deduplica transação + evento (fica o mais antigo) e pula registro inválido", async () => {
    const kv = fakeKv();
    const a1 = await rec("PURCHASE_APPROVED", "HP1", Date.UTC(2026, 9, 20, 12));
    const a1Dup = { ...a1, dia: "2026-10-21", criado_em: "2026-10-21T13:00:00.000Z", criado_em_origem: "recebimento" as const };
    await kv.put(vendaKvKey(a1), JSON.stringify(a1), { metadata: a1 });
    await kv.put(vendaKvKey(a1Dup), JSON.stringify(a1Dup)); // sem metadata: lê o valor
    await kv.put(`${VENDA_KV_PREFIX}2026-10-20:lixo:aprovada`, "{x");
    const lidas = await lerVendas(kv, ["2026-10-20", "2026-10-21"]);
    assert.equal(lidas.registros.length, 1);
    assert.equal(lidas.registros[0].criado_em, a1.criado_em);
    assert.equal(lidas.duplicados, 1);
    assert.deepEqual(lidas.ignorados, [`${VENDA_KV_PREFIX}2026-10-20:lixo:aprovada`]);
  });
});

describe("#10734 Worker site: webhook de venda", () => {
  it("hottok ausente ou diferente → 401 e nada gravado; sem segredo configurado → 503", async () => {
    const kv = fakeKv();
    assert.equal((await worker.fetch(webhook(vendaPayload(), null), envWith(kv))).status, 401);
    assert.equal((await worker.fetch(webhook(vendaPayload(), "errado"), envWith(kv))).status, 401);
    assert.equal((await worker.fetch(webhook(vendaPayload()), envWith(kv, { HOTMART_HOTTOK: undefined }))).status, 503);
    assert.equal(kv.store.size, 0);
  });

  it("compra aprovada → 200, gravada com metadata e TTL, sem dado pessoal no KV nem na resposta", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook(vendaPayload()), envWith(kv));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.deepEqual(JSON.parse(body), { ok: true });
    const key = `${VENDA_KV_PREFIX}2026-10-20:HP16015479281022:aprovada`;
    const stored = kv.store.get(key);
    assert.ok(stored, `chave ${key} não gravada`);
    assert.ok(stored.ttl && stored.ttl > 0);
    assert.deepEqual(stored.metadata, JSON.parse(stored.value));
    for (const p of NAO_GRAVAR) assert.ok(!stored.value.includes(p) && !body.includes(p), `vazou: ${p}`);
    assert.ok(logs.some((l) => l.includes(`venda gravada ${key}`)));
  });

  it("reenvio do mesmo evento não duplica; reembolso da mesma compra grava ao lado", async () => {
    const kv = fakeKv();
    await worker.fetch(webhook(vendaPayload()), envWith(kv));
    await worker.fetch(webhook(vendaPayload()), envWith(kv));
    assert.equal(kv.store.size, 1);
    await worker.fetch(webhook(vendaPayload("PURCHASE_REFUNDED", { root: { id: "outro-evento", creation_date: Date.UTC(2026, 9, 21, 12) } })), envWith(kv));
    assert.equal(kv.store.size, 2);
  });

  it("KV indisponível → 503; falha ao gravar → 500 (a Hotmart reenvia)", async () => {
    assert.equal((await worker.fetch(webhook(vendaPayload()), envWith(undefined))).status, 503);
    const broken = fakeKv();
    broken.failPut = true;
    assert.equal((await worker.fetch(webhook(vendaPayload()), envWith(broken))).status, 500);
  });

  it("abandono continua indo para o prefixo do abandono", async () => {
    const kv = fakeKv();
    const res = await worker.fetch(webhook({ id: "ab-1", creation_date: Date.UTC(2026, 9, 21, 12), event: "PURCHASE_OUT_OF_SHOPPING_CART", version: "2.0.0", data: {} }), envWith(kv));
    assert.equal(res.status, 200);
    assert.deepEqual([...kv.store.keys()], ["hotmart:abandono:2026-10-21:ab-1"]);
  });
});

describe("#10734 Worker site: GET /hotmart/vendas", () => {
  it("token ausente/errado → 401; token dos abandonos não abre as vendas; sem segredo → 503", async () => {
    const kv = fakeKv();
    assert.equal((await worker.fetch(leitura("?de=2026-10-20"), envWith(kv, { HOTMART_VENDAS_TOKEN: undefined }))).status, 503);
    assert.equal((await worker.fetch(leitura("?de=2026-10-20", null), envWith(kv))).status, 401);
    assert.equal((await worker.fetch(leitura("?de=2026-10-20", "errado"), envWith(kv))).status, 401);
    assert.equal((await worker.fetch(leitura("?de=2026-10-20", ABANDONOS_TOKEN), envWith(kv))).status, 401);
  });

  it("devolve registros deduplicados e o saldo líquido do período", async () => {
    const kv = fakeKv();
    await worker.fetch(webhook(vendaPayload()), envWith(kv));
    await worker.fetch(webhook(vendaPayload("PURCHASE_REFUNDED", { root: { id: "ev-reemb", creation_date: Date.UTC(2026, 9, 21, 12) } })), envWith(kv));
    const res = await worker.fetch(leitura("?de=2026-10-20&ate=2026-10-21"), envWith(kv));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { total: number; saldo: unknown; duplicados: number; registros: VendaRecord[] };
    assert.equal(body.total, 2);
    assert.deepEqual(body.saldo, { porMoeda: [{ moeda: "BRL", liquido: 0, aprovadas: 1, estornos: 1 }], semValorLiquido: 0 });
    assert.equal(body.duplicados, 0);
    assert.deepEqual(
      body.registros.map((r) => r.evento),
      ["aprovada", "reembolsada"],
    );
  });

  it("período inválido → 400", async () => {
    assert.equal((await worker.fetch(leitura("?de=2026-02-31"), envWith(fakeKv()))).status, 400);
  });
});
