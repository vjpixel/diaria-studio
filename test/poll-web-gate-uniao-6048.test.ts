/**
 * test/poll-web-gate-uniao-6048.test.ts (#6048)
 *
 * Cobre o WIRING real de `checkWebSubscriberDetailed` — as três fontes
 * (KV, Beehiiv, Kit) consultadas de verdade, com `fetch` stubado.
 *
 * O buraco que isto fecha: até esta mudança, `verifySubscriberViaKitByEmail`
 * existia e **não tinha caller nenhum** (registrado no review da PR #6082).
 * Ou seja, quem cadastrou pelos funis já migrados pro Kit (#6127/#6131)
 * votava como não-assinante — a função certa existia e ninguém a chamava.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkWebSubscriber, checkWebSubscriberDetailed } from "../workers/poll/src/web-gate.ts";
import type { Env } from "../workers/poll/src/index.ts";

const originalFetch = globalThis.fetch;

/** Respostas por host, pra cada teste escolher o cenário. */
let beehiivResponder: () => Response;
let kitResponder: () => Response;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  beehiivResponder = () => jsonRes({ data: { status: "inactive" } });
  kitResponder = () => jsonRes({ subscribers: [] });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("beehiiv")) return beehiivResponder();
    if (url.includes("kit.com")) return kitResponder();
    throw new Error(`fetch inesperado: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** KV falso: `presentes` são as chaves que existem (⇒ "active"). */
function fakeKv(presentes: Set<string>): Env["SUBSCRIBERS_KV"] {
  return {
    get: async (key: string) => (presentes.has(key) ? "1" : null),
  } as unknown as Env["SUBSCRIBERS_KV"];
}

function envCom(over: Partial<Env> = {}): Env {
  return {
    BEEHIIV_API_KEY: "bk",
    BEEHIIV_PUBLICATION_ID: "pub_1",
    KIT_API_KEY: "kk",
    ...over,
  } as unknown as Env;
}

describe("#6048 checkWebSubscriberDetailed — o Kit finalmente tem caller", () => {
  it("assinante SÓ no Kit ⇒ active (antes disto, votava como não-assinante)", async () => {
    kitResponder = () => jsonRes({ subscribers: [{ state: "active" }] });
    const o = await checkWebSubscriberDetailed(envCom(), "novo@exemplo.com");
    assert.equal(o.state, "active");
    assert.equal(o.activeSource, "kit");
  });

  it("assinante SÓ na Beehiiv ⇒ active (os 585 importados continuam valendo)", async () => {
    beehiivResponder = () => jsonRes({ data: { status: "active" } });
    const o = await checkWebSubscriberDetailed(envCom(), "legado@exemplo.com");
    assert.equal(o.state, "active");
    assert.equal(o.activeSource, "beehiiv");
  });

  it("em nenhuma das duas ⇒ não é active", async () => {
    const o = await checkWebSubscriberDetailed(envCom(), "ninguem@exemplo.com");
    assert.notEqual(o.state, "active");
  });

  it("consulta o Kit MESMO quando a Beehiiv já respondeu active — sem curto-circuito", async () => {
    // Curto-circuitar esconderia fonte quebrada justamente quando tudo
    // pareceu funcionar.
    let kitChamado = false;
    beehiivResponder = () => jsonRes({ data: { status: "active" } });
    kitResponder = () => {
      kitChamado = true;
      return jsonRes({ subscribers: [] });
    };
    await checkWebSubscriberDetailed(envCom(), "x@exemplo.com");
    assert.equal(kitChamado, true, "o Kit precisa ser consultado mesmo assim");
  });

  it("sem KIT_API_KEY, a fonte kit nem entra na lista", async () => {
    const o = await checkWebSubscriberDetailed(envCom({ KIT_API_KEY: undefined }), "x@exemplo.com");
    assert.equal(
      o.results.some((r) => r.source === "kit"),
      false,
    );
  });
});

describe("#6048 o invariante no wiring: fonte quebrada não vira não-assinante", () => {
  it("Beehiiv 500 + Kit vazio ⇒ verification_failed, NÃO unknown", async () => {
    beehiivResponder = () => jsonRes({}, 500);
    const o = await checkWebSubscriberDetailed(envCom(), "x@exemplo.com");
    assert.equal(o.state, "verification_failed");
    assert.deepEqual(o.failedSources, ["beehiiv"]);
  });

  it("Kit 401 (key rotacionada) + Beehiiv inactive ⇒ verification_failed", async () => {
    // A fonte cega podia ser justamente a dele — sob partição por origem,
    // cada pessoa vive numa base só.
    beehiivResponder = () => jsonRes({ data: { status: "inactive" } });
    kitResponder = () => jsonRes({ errors: ["unauthorized"] }, 401);
    const o = await checkWebSubscriberDetailed(envCom(), "x@exemplo.com");
    assert.equal(o.state, "verification_failed");
    assert.deepEqual(o.failedSources, ["kit"]);
  });

  it("as duas fora do ar ⇒ ambas listadas em failedSources", async () => {
    beehiivResponder = () => jsonRes({}, 503);
    kitResponder = () => jsonRes({}, 503);
    const o = await checkWebSubscriberDetailed(envCom(), "x@exemplo.com");
    assert.equal(o.state, "verification_failed");
    assert.deepEqual(o.failedSources.sort(), ["beehiiv", "kit"]);
  });

  it("falha NÃO derruba um active vindo de outra fonte", async () => {
    beehiivResponder = () => jsonRes({}, 500);
    kitResponder = () => jsonRes({ subscribers: [{ state: "active" }] });
    const o = await checkWebSubscriberDetailed(envCom(), "x@exemplo.com");
    assert.equal(o.state, "active");
    assert.deepEqual(o.failedSources, ["beehiiv"], "mas a degradação continua visível");
  });
});

describe("#6048 checkWebSubscriber — contrato binário preservado", () => {
  it("active em qualquer fonte ⇒ \"active\"", async () => {
    kitResponder = () => jsonRes({ subscribers: [{ state: "active" }] });
    assert.equal(await checkWebSubscriber(envCom(), "x@exemplo.com"), "active");
  });

  it("verification_failed ⇒ \"not_active\" (fallback seguro do #4052 preservado)", async () => {
    // O gate segue binário de propósito: o form de cadastro inline cobre o
    // caso. A distinção existe pra quem LOGA, não pra mudar o gate.
    beehiivResponder = () => jsonRes({}, 500);
    assert.equal(await checkWebSubscriber(envCom(), "x@exemplo.com"), "not_active");
  });

  it("KV com a chave ⇒ active sem depender de nenhuma API", async () => {
    const { subscriberKvKey } = await import("../scripts/lib/shared/subscriber-verify.ts");
    const email = "kv@exemplo.com";
    const kv = fakeKv(new Set([await subscriberKvKey(email)]));
    assert.equal(await checkWebSubscriber(envCom({ SUBSCRIBERS_KV: kv }), email), "active");
  });
});
