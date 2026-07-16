/**
 * test/poll-leaderboard-archive-link-brand-gate-3615.test.ts (#3615)
 *
 * Regressão: `GET /leaderboard` (renderLeaderboardHtml, leaderboard-routes.ts)
 * mostrava "Votar em edições passadas" (link pro arquivo) incondicionalmente
 * pra TODOS os brands — o #3578 só corrigiu esse mesmo gate na página de VOTO
 * (votePageHtml, index.ts), rota separada. Diária (e web, #3589) não têm mais
 * acesso ao arquivo em nenhuma superfície; só clarice/mensal mantém.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerDefault from "../workers/poll/src/index.ts";
import type { Env } from "../workers/poll/src/index.ts";

function makeKv(): KVNamespace {
  const data: Record<string, string> = {};
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Object.keys(data)
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function makeEnv(): Env {
  return {
    POLL: makeKv(),
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

async function fetchHtml(path: string): Promise<string> {
  const req = new Request(`https://poll.diaria.workers.dev${path}`);
  const res = await workerDefault.fetch(req, makeEnv(), {} as ExecutionContext);
  assert.equal(res.status, 200, `esperava 200 para ${path}, recebeu ${res.status}`);
  return res.text();
}

describe("renderLeaderboardHtml — link de arquivo gated por brand (#3615)", () => {
  it("brand diária (default, sem ?brand=) NÃO mostra link de arquivo", async () => {
    const html = await fetchHtml("/leaderboard");
    assert.doesNotMatch(html, /Votar em edições passadas/, "diária não deveria linkar pro arquivo");
    assert.doesNotMatch(html, /\/leaderboard\/\d{4}\/arquivo/, "diária não deveria ter href de arquivo");
  });

  it("brand web NÃO mostra link de arquivo (consistente com #3589)", async () => {
    const html = await fetchHtml("/leaderboard?brand=web");
    assert.doesNotMatch(html, /Votar em edições passadas/, "web não deveria linkar pro arquivo");
  });

  it("brand clarice MANTÉM o link de arquivo", async () => {
    const html = await fetchHtml("/leaderboard?brand=clarice");
    assert.match(html, /Votar em edições passadas/, "clarice deveria manter o link de arquivo");
    assert.match(html, /\/leaderboard\/\d{4}\/arquivo\?brand=clarice/, "clarice deveria ter href de arquivo com brand");
  });

  it("diária mantém 'Ver ranking anual' mesmo sem o link de arquivo", async () => {
    const html = await fetchHtml("/leaderboard");
    assert.match(html, /Ver ranking anual de \d{4}/, "ranking anual não deveria sumir");
  });
});
