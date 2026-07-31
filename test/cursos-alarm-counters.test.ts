/**
 * test/cursos-alarm-counters.test.ts (#4382)
 *
 * Cobre `scripts/lib/shared/cursos-alarm-counters.ts` — o helper de
 * incremento de contador KV usado pelo worker `cursos` (`index.ts`,
 * `subscribe.ts`) pra alimentar `scripts/cursos-error-alarm.ts`. Garantia
 * central: `incrementKvCounter` NUNCA lança, mesmo com um KV instável —
 * é uma via lateral de alarme, não pode derrubar o request principal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CURSOS_ALARM_COUNTER_KEYS, incrementKvCounter } from "../scripts/lib/shared/cursos-alarm-counters.ts";

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

test("CURSOS_ALARM_COUNTER_KEYS — 4 chaves distintas, todas com o prefixo counter:cursos-alarm:", () => {
  const keys = Object.values(CURSOS_ALARM_COUNTER_KEYS);
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, 4, "as 4 chaves precisam ser distintas (sem colisão)");
  for (const k of keys) assert.match(k, /^counter:cursos-alarm:/);
});

test("incrementKvCounter — chave ausente → cria com valor '1'", async () => {
  const kv = makeMapKV();
  await incrementKvCounter(kv, CURSOS_ALARM_COUNTER_KEYS.fatalCookieHmacSecretAusente);
  assert.equal(await kv.get(CURSOS_ALARM_COUNTER_KEYS.fatalCookieHmacSecretAusente), "1");
});

test("incrementKvCounter — chave existente → soma 1 ao valor atual", async () => {
  const kv = makeMapKV({ [CURSOS_ALARM_COUNTER_KEYS.emailGateConfirmed]: "41" });
  await incrementKvCounter(kv, CURSOS_ALARM_COUNTER_KEYS.emailGateConfirmed);
  assert.equal(await kv.get(CURSOS_ALARM_COUNTER_KEYS.emailGateConfirmed), "42");
});

test("incrementKvCounter — valor corrompido no KV (não-numérico) → trata como 0, não lança", async () => {
  const kv = makeMapKV({ [CURSOS_ALARM_COUNTER_KEYS.emailGateNotConfirmed]: "lixo" });
  await incrementKvCounter(kv, CURSOS_ALARM_COUNTER_KEYS.emailGateNotConfirmed);
  assert.equal(await kv.get(CURSOS_ALARM_COUNTER_KEYS.emailGateNotConfirmed), "1");
});

test("incrementKvCounter — chamadas sequenciais incrementam corretamente", async () => {
  const kv = makeMapKV();
  await incrementKvCounter(kv, CURSOS_ALARM_COUNTER_KEYS.fatalCadastroBeehiivFalhou);
  await incrementKvCounter(kv, CURSOS_ALARM_COUNTER_KEYS.fatalCadastroBeehiivFalhou);
  await incrementKvCounter(kv, CURSOS_ALARM_COUNTER_KEYS.fatalCadastroBeehiivFalhou);
  assert.equal(await kv.get(CURSOS_ALARM_COUNTER_KEYS.fatalCadastroBeehiivFalhou), "3");
});

test("incrementKvCounter — KV.get lançando exceção → fail-soft, nunca propaga (não derruba o request principal)", async () => {
  const explodingKv = {
    get: async () => {
      throw new Error("KV indisponível");
    },
    put: async () => {},
    delete: async () => {},
  } as unknown as KVNamespace;
  await assert.doesNotReject(incrementKvCounter(explodingKv, CURSOS_ALARM_COUNTER_KEYS.fatalCookieHmacSecretAusente));
});

test("incrementKvCounter — KV.put lançando exceção → fail-soft, nunca propaga", async () => {
  const explodingKv = {
    get: async () => null,
    put: async () => {
      throw new Error("KV indisponível");
    },
    delete: async () => {},
  } as unknown as KVNamespace;
  await assert.doesNotReject(incrementKvCounter(explodingKv, CURSOS_ALARM_COUNTER_KEYS.emailGateConfirmed));
});

test("incrementKvCounter — contadores independentes não se cruzam", async () => {
  const kv = makeMapKV();
  await incrementKvCounter(kv, CURSOS_ALARM_COUNTER_KEYS.fatalCookieHmacSecretAusente);
  await incrementKvCounter(kv, CURSOS_ALARM_COUNTER_KEYS.emailGateConfirmed);
  await incrementKvCounter(kv, CURSOS_ALARM_COUNTER_KEYS.emailGateConfirmed);
  assert.equal(await kv.get(CURSOS_ALARM_COUNTER_KEYS.fatalCookieHmacSecretAusente), "1");
  assert.equal(await kv.get(CURSOS_ALARM_COUNTER_KEYS.emailGateConfirmed), "2");
  assert.equal(await kv.get(CURSOS_ALARM_COUNTER_KEYS.fatalCadastroBeehiivFalhou), null);
});
