/**
 * test/apoiar-counters-7915.test.ts (#7915)
 *
 * Cobertura dedicada de `scripts/lib/shared/apoiar-counters.ts`, no mesmo
 * molde de `test/ai-fetch-counters.test.ts` (`incrementAiFetchCounter`) —
 * exercita diretamente o `try/catch` de `incrementApoiarCounter` (o que faz
 * a afirmação "fail-soft por construção" da docstring ser verificável, não
 * só prosa) e o caminho "soma 1 ao valor atual", que os testes de nível
 * Worker em `site-worker-apoiar-7915.test.ts` não alcançam (lá, todo
 * request é isolado — nunca duas chamadas na mesma chave dentro do teste).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { apoiarClickCounterKey, incrementApoiarCounter } from "../scripts/lib/shared/apoiar-counters.ts";

function makeMapKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

describe("apoiarClickCounterKey", () => {
  test("formato estável — 1 chave cumulativa por dia (#8498: a chave de view saiu)", () => {
    assert.equal(apoiarClickCounterKey("2026-09-15"), "counter:apoiar:click:2026-09-15");
  });
});

describe("incrementApoiarCounter", () => {
  test("chave ausente → cria com valor '1'", async () => {
    const kv = makeMapKV();
    const key = apoiarClickCounterKey("2026-09-15");
    await incrementApoiarCounter(kv, key);
    assert.equal(await kv.get(key), "1");
  });

  test("chave existente → soma 1 ao valor atual", async () => {
    const key = apoiarClickCounterKey("2026-09-15");
    const kv = makeMapKV({ [key]: "4" });
    await incrementApoiarCounter(kv, key);
    assert.equal(await kv.get(key), "5");
  });

  test("valor corrompido (não-numérico) no KV → trata como 0, não lança", async () => {
    const key = apoiarClickCounterKey("2026-09-15");
    const kv = makeMapKV({ [key]: "lixo" });
    await incrementApoiarCounter(kv, key);
    assert.equal(await kv.get(key), "1");
  });

  test("kv undefined (binding ausente) → NO-OP silencioso, não lança", async () => {
    await assert.doesNotReject(incrementApoiarCounter(undefined, apoiarClickCounterKey("2026-09-15")));
  });

  test("KV.get lançando exceção → fail-soft, nunca propaga (exercita o try/catch real, não só o guard de kv ausente)", async () => {
    const explodingKv = {
      get: async () => {
        throw new Error("KV indisponível");
      },
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace;
    await assert.doesNotReject(incrementApoiarCounter(explodingKv, apoiarClickCounterKey("2026-09-15")));
  });

  test("KV.put lançando exceção → fail-soft, nunca propaga", async () => {
    const explodingKv = {
      get: async () => null,
      put: async () => {
        throw new Error("KV indisponível");
      },
      delete: async () => {},
    } as unknown as KVNamespace;
    await assert.doesNotReject(incrementApoiarCounter(explodingKv, apoiarClickCounterKey("2026-09-15")));
  });

  test("dias distintos não se cruzam sob incrementos repetidos", async () => {
    const kv = makeMapKV();
    const day1 = apoiarClickCounterKey("2026-09-15");
    const day2 = apoiarClickCounterKey("2026-09-16");
    await incrementApoiarCounter(kv, day1);
    await incrementApoiarCounter(kv, day1);
    await incrementApoiarCounter(kv, day2);
    assert.equal(await kv.get(day1), "2");
    assert.equal(await kv.get(day2), "1");
  });
});
