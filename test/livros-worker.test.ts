/**
 * test/livros-worker.test.ts (#4558 Parte C)
 *
 * `workers/livros` era um Worker de static assets PURO (sem `main`) até o
 * #4558 Parte C — ganhou um script mínimo só pra logar o Referer de
 * assistente de IA (`scripts/lib/shared/ai-referrer-log.ts`) e delegar pro
 * MESMO `env.ASSETS` de sempre. Este teste cobre: (1) o fetch handler em
 * si — loga quando o Referer bate, não loga quando não bate, sempre delega
 * pro ASSETS (comportamento público inalterado); (2) o `wrangler.toml` tem
 * `main` + `run_worker_first` corretos — sem isso o script nunca roda,
 * mesmo invariante já coberto por `test/cursos-worker-first.test.ts` pro
 * worker irmão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../workers/livros/src/index.ts";
import type { Env } from "../workers/livros/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = resolve(ROOT, "workers/livros/wrangler.toml");

function fakeEnv(): { env: Env; calls: Request[] } {
  const calls: Request[] = [];
  const env: Env = {
    ASSETS: {
      // @ts-expect-error — só o método `fetch` importa pro teste.
      fetch: async (req: Request) => {
        calls.push(req);
        return new Response("<html>fake asset</html>", { status: 200 });
      },
    },
  };
  return { env, calls };
}

describe("workers/livros fetch handler (#4558 Parte C)", () => {
  it("sem Referer de assistente de IA — não loga, delega pro ASSETS normalmente", async () => {
    const { env, calls } = fakeEnv();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      const res = await worker.fetch(new Request("https://livros.diar.ia.br/"), env);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1, "sempre delega pro ASSETS");
      assert.equal(logs.length, 0, "sem Referer de IA, não loga nada");
    } finally {
      console.log = originalLog;
    }
  });

  it("com Referer de um assistente de IA conhecido — loga E delega pro ASSETS (comportamento público inalterado)", async () => {
    const { env, calls } = fakeEnv();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      const req = new Request("https://livros.diar.ia.br/", {
        headers: { Referer: "https://chatgpt.com/c/abc" },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1, "conteúdo continua vindo do ASSETS");
      assert.equal(logs.length, 1);
      const parsed = JSON.parse(logs[0]);
      assert.equal(parsed.event, "ai_referrer_hit");
      assert.equal(parsed.worker, "livros");
      assert.equal(parsed.host, "chatgpt.com");
      assert.equal(parsed.path, "/");
    } finally {
      console.log = originalLog;
    }
  });

  it("Referer de origem NÃO relacionada a IA — não loga", async () => {
    const { env, calls } = fakeEnv();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      const req = new Request("https://livros.diar.ia.br/", {
        headers: { Referer: "https://www.google.com/search?q=livros+ia" },
      });
      await worker.fetch(req, env);
      assert.equal(calls.length, 1);
      assert.equal(logs.length, 0);
    } finally {
      console.log = originalLog;
    }
  });

  it("nunca lança mesmo se o Referer for malformado", async () => {
    const { env } = fakeEnv();
    const req = new Request("https://livros.diar.ia.br/", { headers: { Referer: "não é url" } });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
  });
});

describe("workers/livros: script roda antes do asset (#4558 Parte C)", () => {
  const toml = readFileSync(WRANGLER, "utf8");

  it("declara `main` (sanity — sem isso o invariante abaixo não se aplica)", () => {
    assert.match(toml, /^\s*main\s*=\s*"src\/index\.ts"/m);
  });

  it("`run_worker_first = true` cobre todo path (mesmo invariante de workers/cursos, #4052 follow-up)", () => {
    const assetsSection = (() => {
      const lines = toml.split(/\r?\n/);
      const start = lines.findIndex((l) => l.trim() === "[assets]");
      if (start < 0) return "";
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((l) => /^\s*\[/.test(l));
      return (end < 0 ? rest : rest.slice(0, end)).join("\n");
    })();
    assert.match(assetsSection, /run_worker_first\s*=\s*true/, "sem run_worker_first=true, o asset ganha do script e o log de Referer nunca roda");
  });
});
