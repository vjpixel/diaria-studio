/**
 * test/reativar-alarm-counters-4551.test.ts (#4551)
 *
 * Cobre `scripts/lib/shared/reativar-alarm-counters.ts` (o helper de
 * incremento de contador KV — espelho de `cursos-alarm-counters.ts`, #4382)
 * e a integração em `checkNativeUnsubscribePending` (`workers/reativar/src/index.ts`):
 * cada um dos 3 motivos de fail-open incrementa o contador certo, sem
 * quebrar o comportamento pré-existente do guard (mesma garantia central de
 * `test/cursos-alarm-counters.test.ts` — `incrementReativarAlarmCounter`
 * NUNCA lança, e é NO-OP quando o binding KV está ausente).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { REATIVAR_ALARM_COUNTER_KEYS, incrementReativarAlarmCounter } from "../scripts/lib/shared/reativar-alarm-counters.ts";
import { checkNativeUnsubscribePending, type Env } from "../workers/reativar/src/index.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    _map: m,
  } as unknown as KVNamespace & { _map: Map<string, string> };
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("REATIVAR_ALARM_COUNTER_KEYS — 4 chaves distintas, todas com o prefixo counter:reativar-alarm:fail-open:", () => {
  test("4 chaves, sem colisão", () => {
    const keys = Object.values(REATIVAR_ALARM_COUNTER_KEYS);
    assert.equal(keys.length, 4);
    assert.equal(new Set(keys).size, 4, "as 4 chaves precisam ser distintas");
    for (const k of keys) assert.match(k, /^counter:reativar-alarm:fail-open:/);
  });
});

describe("incrementReativarAlarmCounter — mecânica de incremento (espelha incrementKvCounter, #4382)", () => {
  test("binding ausente (undefined) → NO-OP silencioso, nunca lança", async () => {
    await assert.doesNotReject(incrementReativarAlarmCounter(undefined, REATIVAR_ALARM_COUNTER_KEYS.noApiKey));
  });

  test("chave ausente → cria com valor '1'", async () => {
    const kv = makeMapKV();
    await incrementReativarAlarmCounter(kv, REATIVAR_ALARM_COUNTER_KEYS.noApiKey);
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.noApiKey), "1");
  });

  test("chave existente → soma 1 ao valor atual", async () => {
    const kv = makeMapKV({ [REATIVAR_ALARM_COUNTER_KEYS.httpError]: "7" });
    await incrementReativarAlarmCounter(kv, REATIVAR_ALARM_COUNTER_KEYS.httpError);
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.httpError), "8");
  });

  test("valor corrompido no KV (não-numérico) → trata como 0, não lança", async () => {
    const kv = makeMapKV({ [REATIVAR_ALARM_COUNTER_KEYS.networkError]: "lixo" });
    await incrementReativarAlarmCounter(kv, REATIVAR_ALARM_COUNTER_KEYS.networkError);
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.networkError), "1");
  });

  test("contadores independentes não se cruzam", async () => {
    const kv = makeMapKV();
    await incrementReativarAlarmCounter(kv, REATIVAR_ALARM_COUNTER_KEYS.noApiKey);
    await incrementReativarAlarmCounter(kv, REATIVAR_ALARM_COUNTER_KEYS.httpError);
    await incrementReativarAlarmCounter(kv, REATIVAR_ALARM_COUNTER_KEYS.httpError);
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.noApiKey), "1");
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.httpError), "2");
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.httpErrorAuthDenied), null);
  });

  test("KV.get lançando exceção → fail-soft, nunca propaga", async () => {
    const explodingKv = {
      get: async () => {
        throw new Error("KV indisponível");
      },
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace;
    await assert.doesNotReject(incrementReativarAlarmCounter(explodingKv, REATIVAR_ALARM_COUNTER_KEYS.noApiKey));
  });

  test("KV.put lançando exceção → fail-soft, nunca propaga", async () => {
    const explodingKv = {
      get: async () => null,
      put: async () => {
        throw new Error("KV indisponível");
      },
      delete: async () => {},
    } as unknown as KVNamespace;
    await assert.doesNotReject(incrementReativarAlarmCounter(explodingKv, REATIVAR_ALARM_COUNTER_KEYS.httpError));
  });
});

describe("checkNativeUnsubscribePending — cada fail-open incrementa o contador certo (#4551)", () => {
  test("BREVO_DIARIA_API_KEY ausente → incrementa noApiKey, nenhum outro contador", async () => {
    const kv = makeMapKV();
    const env: Env = { REATIVAR_ALARM: kv };
    const fetchImpl = (async () => jsonRes(200, { emailBlacklisted: true })) as typeof fetch;
    const result = await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { status: "unknown", reason: "no_api_key" });
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.noApiKey), "1");
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.httpError), null);
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.networkError), null);
  });

  test("erro HTTP 5xx → incrementa httpError, NÃO incrementa httpErrorAuthDenied", async () => {
    const kv = makeMapKV();
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key", REATIVAR_ALARM: kv };
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const result = await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { status: "unknown", reason: "http_error" });
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.httpError), "1");
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.httpErrorAuthDenied), null);
  });

  test("401 → incrementa httpError E httpErrorAuthDenied (sub-contagem aditiva)", async () => {
    const kv = makeMapKV();
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key_revogada", REATIVAR_ALARM: kv };
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    const result = await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { status: "unknown", reason: "http_error" });
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.httpError), "1");
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.httpErrorAuthDenied), "1");
  });

  test("403 → incrementa httpError E httpErrorAuthDenied", async () => {
    const kv = makeMapKV();
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key", REATIVAR_ALARM: kv };
    const fetchImpl = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    const result = await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { status: "unknown", reason: "http_error" });
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.httpError), "1");
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.httpErrorAuthDenied), "1");
  });

  test("exceção de rede → incrementa networkError", async () => {
    const kv = makeMapKV();
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key", REATIVAR_ALARM: kv };
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { status: "unknown", reason: "network_error" });
    assert.equal(await kv.get(REATIVAR_ALARM_COUNTER_KEYS.networkError), "1");
  });

  test("caminho de sucesso (emailBlacklisted:false) → nenhum contador incrementado", async () => {
    const kv = makeMapKV();
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key", REATIVAR_ALARM: kv };
    const fetchImpl = (async () => jsonRes(200, { emailBlacklisted: false })) as typeof fetch;
    const result = await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { status: "confirmed_not_pending" });
    for (const key of Object.values(REATIVAR_ALARM_COUNTER_KEYS)) {
      assert.equal(await kv.get(key), null);
    }
  });

  test("binding REATIVAR_ALARM ausente (não declarado ainda) → guard continua funcionando normalmente, sem lançar", async () => {
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key" }; // sem REATIVAR_ALARM
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const result = await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { status: "unknown", reason: "http_error" });
  });
});
