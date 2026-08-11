/**
 * test/ai-fetch-counters.test.ts (#4902)
 *
 * Cobre `scripts/lib/shared/ai-fetch-counters.ts` — casamento de User-Agent
 * contra os 8 UAs de recuperação nomeados + incremento de contador KV
 * fail-soft (por bot e por host de Referer).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_FETCH_BOTS,
  matchAiFetchBot,
  aiFetchBotCounterKey,
  aiFetchReferrerCounterKey,
  incrementAiFetchCounter,
} from "../scripts/lib/shared/ai-fetch-counters.ts";

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

describe("AI_FETCH_BOTS", () => {
  test("tem exatamente os 8 UAs nomeados na issue #4902", () => {
    assert.deepEqual([...AI_FETCH_BOTS].sort(), [
      "ChatGPT-User",
      "Claude-SearchBot",
      "Claude-User",
      "Googlebot",
      "OAI-SearchBot",
      "Perplexity-User",
      "PerplexityBot",
      "bingbot",
    ]);
  });
});

describe("matchAiFetchBot", () => {
  test("casa cada um dos 8 UAs nomeados (substring, dentro de uma UA string real)", () => {
    assert.equal(matchAiFetchBot("OAI-SearchBot/1.0; +https://openai.com/searchbot"), "OAI-SearchBot");
    assert.equal(matchAiFetchBot("Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)"), "ChatGPT-User");
    assert.equal(matchAiFetchBot("Claude-User/1.0"), "Claude-User");
    assert.equal(matchAiFetchBot("Claude-SearchBot/1.0"), "Claude-SearchBot");
    assert.equal(matchAiFetchBot("Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/bot)"), "PerplexityBot");
    assert.equal(matchAiFetchBot("Perplexity-User/1.0"), "Perplexity-User");
    assert.equal(matchAiFetchBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), "Googlebot");
    assert.equal(matchAiFetchBot("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"), "bingbot");
  });

  test("é case-insensitive", () => {
    assert.equal(matchAiFetchBot("oai-searchbot/1.0"), "OAI-SearchBot");
    assert.equal(matchAiFetchBot("GOOGLEBOT/2.1"), "Googlebot");
  });

  test("GPTBot (UA de TREINO, não de recuperação) não casa como OAI-SearchBot nem nenhum outro", () => {
    assert.equal(matchAiFetchBot("GPTBot/1.1"), null);
    assert.equal(matchAiFetchBot("Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)"), null);
  });

  test("ClaudeBot (UA de TREINO) não casa como Claude-User nem Claude-SearchBot", () => {
    assert.equal(matchAiFetchBot("ClaudeBot/1.0"), null);
    assert.equal(matchAiFetchBot("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"), null);
  });

  test("outros UAs de treino/irrelevantes não casam com nada", () => {
    assert.equal(matchAiFetchBot("CCBot/2.0"), null);
    assert.equal(matchAiFetchBot("Google-Extended"), null);
    assert.equal(matchAiFetchBot("Bytespider"), null);
    assert.equal(matchAiFetchBot("Amazonbot/0.1"), null);
    assert.equal(matchAiFetchBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"), null);
  });

  test("retorna null (nunca lança) pra User-Agent ausente/vazio", () => {
    assert.equal(matchAiFetchBot(null), null);
    assert.equal(matchAiFetchBot(undefined), null);
    assert.equal(matchAiFetchBot(""), null);
  });
});

describe("aiFetchBotCounterKey / aiFetchReferrerCounterKey", () => {
  test("chave por (bot, dia) — sem path/query", () => {
    assert.equal(aiFetchBotCounterKey("Googlebot", "2026-08-11"), "counter:ai-fetch:bot:Googlebot:2026-08-11");
  });

  test("chave por (host referrer, dia) — namespace distinto da chave por bot", () => {
    const key = aiFetchReferrerCounterKey("claude.ai", "2026-08-11");
    assert.equal(key, "counter:ai-fetch:referrer:claude.ai:2026-08-11");
    assert.notEqual(key, aiFetchBotCounterKey("Googlebot", "2026-08-11"));
  });

  test("bots/dias distintos produzem chaves distintas (sem colisão)", () => {
    const a = aiFetchBotCounterKey("Googlebot", "2026-08-11");
    const b = aiFetchBotCounterKey("Googlebot", "2026-08-12");
    const c = aiFetchBotCounterKey("bingbot", "2026-08-11");
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.notEqual(b, c);
  });
});

describe("incrementAiFetchCounter", () => {
  test("chave ausente → cria com valor '1'", async () => {
    const kv = makeMapKV();
    const key = aiFetchBotCounterKey("Googlebot", "2026-08-11");
    await incrementAiFetchCounter(kv, key);
    assert.equal(await kv.get(key), "1");
  });

  test("chave existente → soma 1 ao valor atual", async () => {
    const key = aiFetchBotCounterKey("bingbot", "2026-08-11");
    const kv = makeMapKV({ [key]: "7" });
    await incrementAiFetchCounter(kv, key);
    assert.equal(await kv.get(key), "8");
  });

  test("valor corrompido (não-numérico) no KV → trata como 0, não lança", async () => {
    const key = aiFetchBotCounterKey("OAI-SearchBot", "2026-08-11");
    const kv = makeMapKV({ [key]: "lixo" });
    await incrementAiFetchCounter(kv, key);
    assert.equal(await kv.get(key), "1");
  });

  test("kv undefined (binding ausente) → NO-OP silencioso, não lança", async () => {
    await assert.doesNotReject(incrementAiFetchCounter(undefined, aiFetchBotCounterKey("Googlebot", "2026-08-11")));
  });

  test("KV.get lançando exceção → fail-soft, nunca propaga", async () => {
    const explodingKv = {
      get: async () => {
        throw new Error("KV indisponível");
      },
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace;
    await assert.doesNotReject(incrementAiFetchCounter(explodingKv, aiFetchBotCounterKey("Googlebot", "2026-08-11")));
  });

  test("KV.put lançando exceção → fail-soft, nunca propaga", async () => {
    const explodingKv = {
      get: async () => null,
      put: async () => {
        throw new Error("KV indisponível");
      },
      delete: async () => {},
    } as unknown as KVNamespace;
    await assert.doesNotReject(incrementAiFetchCounter(explodingKv, aiFetchBotCounterKey("Googlebot", "2026-08-11")));
  });

  test("contadores de bots distintos não se cruzam", async () => {
    const kv = makeMapKV();
    const keyGoogle = aiFetchBotCounterKey("Googlebot", "2026-08-11");
    const keyBing = aiFetchBotCounterKey("bingbot", "2026-08-11");
    await incrementAiFetchCounter(kv, keyGoogle);
    await incrementAiFetchCounter(kv, keyGoogle);
    await incrementAiFetchCounter(kv, keyBing);
    assert.equal(await kv.get(keyGoogle), "2");
    assert.equal(await kv.get(keyBing), "1");
  });
});
