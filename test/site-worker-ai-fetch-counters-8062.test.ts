/**
 * test/site-worker-ai-fetch-counters-8062.test.ts (#8062)
 *
 * `workers/site` (apex diar.ia.br, home + /p/{slug}, 263 URLs no GSC) era o
 * único dos 4 Workers públicos sem NENHUMA instrumentação de bot/referrer
 * de IA — `workers/arquivo`, `workers/livros` e `workers/cursos` já
 * chamavam `matchAiReferrerHost`/`logAiReferrerHit` (e `arquivo` também
 * `matchAiFetchBot`/`incrementAiFetchCounter`). Este teste trava a mesma
 * instrumentação no fetch handler de `workers/site`, com o campo de
 * superfície `"site"` (nunca "arquivo"/"livros"/"cursos") pra distinguir a
 * origem do hit — mesmo racional de `test/ai-fetch-counters.test.ts`
 * (#8062: "arquivo" vs "site" nunca colidem no mesmo (bot, dia)).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";
import { aiFetchBotCounterKey, aiFetchReferrerCounterKey } from "../scripts/lib/shared/ai-fetch-counters.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = resolve(ROOT, "workers", "site", "wrangler.toml");

function makeFakeKv(): { kv: KVNamespace; puts: Record<string, string> } {
  const puts: Record<string, string> = {};
  const kv = {
    get: async (key: string) => puts[key] ?? null,
    put: async (key: string, value: string) => {
      puts[key] = value;
    },
    delete: async () => {},
  } as unknown as KVNamespace;
  return { kv, puts };
}

function fakeEnv(kv: KVNamespace): Env {
  return {
    ASSETS: {
      fetch: async () => new Response("<html>fake asset</html>", { status: 200 }),
    } as unknown as Env["ASSETS"],
    POLL: { get: async () => null },
    CURSOS_SUBSCRIBERS: kv,
  };
}

describe("workers/site — instrumentação de bot/referrer de IA (#8062)", () => {
  it("User-Agent de bot nomeado (ex: OAI-SearchBot) incrementa o contador com surface='site'", async () => {
    const { kv, puts } = makeFakeKv();
    const env = fakeEnv(kv);
    const req = new Request("https://diar.ia.br/", {
      headers: { "User-Agent": "OAI-SearchBot/1.0; +https://openai.com/searchbot" },
    });
    await worker.fetch(req, env);
    const day = new Date().toISOString().slice(0, 10);
    const key = aiFetchBotCounterKey("OAI-SearchBot", day, "site");
    assert.equal(puts[key], "1");
  });

  it("Referer de assistente (ex: claude.ai) incrementa o contador com surface='site'", async () => {
    const { kv, puts } = makeFakeKv();
    const env = fakeEnv(kv);
    const req = new Request("https://diar.ia.br/p/algum-post", { headers: { Referer: "https://claude.ai/chat/abc" } });
    await worker.fetch(req, env);
    const day = new Date().toISOString().slice(0, 10);
    const key = aiFetchReferrerCounterKey("claude.ai", day, "site");
    assert.equal(puts[key], "1");
  });

  it("as chaves de 'site' nunca colidem com as de 'arquivo' no mesmo (bot, dia)", async () => {
    const { kv, puts } = makeFakeKv();
    const env = fakeEnv(kv);
    const req = new Request("https://diar.ia.br/", { headers: { "User-Agent": "Googlebot/2.1" } });
    await worker.fetch(req, env);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(puts[aiFetchBotCounterKey("Googlebot", day, "site")], "1");
    assert.equal(puts[aiFetchBotCounterKey("Googlebot", day, "arquivo")], undefined);
  });

  it("User-Agent/Referer comuns (sem bot/assistente conhecido) não escrevem nada no KV", async () => {
    const { kv, puts } = makeFakeKv();
    const env = fakeEnv(kv);
    const req = new Request("https://diar.ia.br/", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0" },
    });
    await worker.fetch(req, env);
    assert.equal(Object.keys(puts).length, 0);
  });

  it("KV ausente (binding não propagado) não derruba a resposta — fail-soft", async () => {
    const env: Env = {
      ASSETS: {
        fetch: async () => new Response("ok", { status: 200 }),
      } as unknown as Env["ASSETS"],
      POLL: { get: async () => null },
      // CURSOS_SUBSCRIBERS deliberadamente ausente.
    };
    const req = new Request("https://diar.ia.br/", { headers: { "User-Agent": "Googlebot/2.1" } });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
  });
});

describe("wrangler.toml — binding CURSOS_SUBSCRIBERS (#8062)", () => {
  const toml = readFileSync(WRANGLER, "utf8");

  it("declara o binding CURSOS_SUBSCRIBERS com o MESMO id de workers/arquivo", () => {
    assert.match(toml, /binding\s*=\s*"CURSOS_SUBSCRIBERS"/);
    assert.match(toml, /id\s*=\s*"a3415c3bf4b840d6975dbac290b99153"/);
  });
});
