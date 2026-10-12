/**
 * #10082: webhook de abandono de carrinho da Hotmart — hottok inválido é
 * recusado; payload de exemplo gera registro sem dado pessoal; leitura exige bearer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";
import { extractAbandon, hottokMatches } from "../scripts/lib/shared/hotmart-abandon.ts";

const PAYLOAD = {
  id: "abc",
  event: "PURCHASE_OUT_OF_SHOPPING_CART",
  version: "2.0.0",
  creation_date: 1760270400000,
  data: {
    buyer_ip: "200.1.2.3",
    buyer: { name: "Fulana de Tal", email: "fulana@example.com", phone: "11999999999" },
    product: { id: 8576469, name: "Ingresso" },
    offer: { code: "xyz123" },
    checkout_country: { name: "Brasil", iso: "BR" },
    purchase: { origin: { src: "meta", sck: "ad42" } },
  },
};

function setup(overrides: Partial<Env> = {}) {
  const store: Record<string, string> = {};
  const kv = {
    put: async (k: string, v: string) => { store[k] = v; },
    get: async (k: string) => store[k] ?? null,
    list: async ({ prefix }: { prefix: string }) => ({
      keys: Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  } as unknown as KVNamespace;
  const env = {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Env["ASSETS"],
    POLL: { get: async () => null },
    CURSOS_SUBSCRIBERS: kv,
    HOTMART_HOTTOK: "s3cret",
    HOTMART_READ_TOKEN: "readtok",
    ...overrides,
  } as Env;
  return { env, store };
}

const post = (headers: Record<string, string>, body: unknown) =>
  new Request("https://diar.ia.br/hotmart/abandono", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

describe("hotmart abandon (#10082)", () => {
  it("hottok inválido ou ausente é recusado e nada é gravado", async () => {
    const { env, store } = setup();
    assert.equal((await worker.fetch(post({ "X-HOTMART-HOTTOK": "errado" }, PAYLOAD), env)).status, 401);
    assert.equal((await worker.fetch(post({}, PAYLOAD), env)).status, 401);
    assert.equal(Object.keys(store).length, 0);
  });

  it("sem segredo configurado recusa mesmo com hottok", async () => {
    const { env } = setup({ HOTMART_HOTTOK: undefined });
    assert.equal((await worker.fetch(post({ "X-HOTMART-HOTTOK": "x" }, PAYLOAD), env)).status, 401);
    assert.equal(hottokMatches("", ""), false);
  });

  it("payload real gera registro sem dados pessoais", async () => {
    const { env, store } = setup();
    const res = await worker.fetch(post({ "X-HOTMART-HOTTOK": "s3cret" }, PAYLOAD), env);
    assert.equal(res.status, 204);
    const vals = Object.values(store);
    assert.equal(vals.length, 1);
    const rec = JSON.parse(vals[0]);
    assert.deepEqual(rec, {
      at: "2025-10-12T12:00:00.000Z",
      product_id: "8576469",
      offer_code: "xyz123",
      src: "meta",
      sck: "ad42",
    });
    for (const pii of ["Fulana", "fulana@example.com", "11999999999", "200.1.2.3"]) {
      assert.ok(!vals[0].includes(pii), `PII vazou: ${pii}`);
    }
  });

  it("outro evento não grava", async () => {
    const { env, store } = setup();
    const res = await worker.fetch(post({ "X-HOTMART-HOTTOK": "s3cret" }, { ...PAYLOAD, event: "PURCHASE_APPROVED" }), env);
    assert.equal(res.status, 204);
    assert.equal(Object.keys(store).length, 0);
    assert.equal(extractAbandon({ event: "PURCHASE_APPROVED" }), null);
  });

  it("leitura exige bearer e filtra por período", async () => {
    const { env } = setup();
    await worker.fetch(post({ "X-HOTMART-HOTTOK": "s3cret" }, PAYLOAD), env);
    const url = "https://diar.ia.br/hotmart/abandonos?from=2025-10-12&to=2025-10-12";
    assert.equal((await worker.fetch(new Request(url), env)).status, 401);
    const ok = await worker.fetch(new Request(url, { headers: { Authorization: "Bearer readtok" } }), env);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as { count: number }).count, 1);
    const empty = await worker.fetch(
      new Request(url.replace(/2025-10-12/g, "2025-10-13"), { headers: { Authorization: "Bearer readtok" } }), env);
    assert.equal((await empty.json() as { count: number }).count, 0);
  });
});
