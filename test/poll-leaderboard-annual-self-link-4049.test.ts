/**
 * test/poll-leaderboard-annual-self-link-4049.test.ts (#4049 item 1)
 *
 * Regressão: `GET /leaderboard/{YYYY}?brand=clarice` (handleLeaderboardByYear,
 * leaderboard-routes.ts) mostrava "Ver ranking anual de {YYYY}" — mas essa
 * página JÁ É o ranking anual. O gate do #3615 checava só a marca
 * (`BRAND_INFO[brand].leaderboardPeriod === "year"`), nunca o `periodKind` da
 * view atual, então o link virava um self-link: o href era byte-a-byte o
 * `canonicalPath` (leaderboardHref(brand, yearStr)) da própria página.
 *
 * Fix: o gate ganhou `periodKind !== "year"` — o link só aparece na view
 * MENSAL (`handleLeaderboardByMonth`, periodKind "month" default), nunca na
 * anual. `navHtml` continua renderizando `<p class="nav">` com "Votar em
 * edições passadas" (arquivo) mesmo quando só esse link sobra — a paragraph
 * só some quando NENHUM dos dois links (#3615) se aplica.
 *
 * Nota sobre o último teste desta suíte: hoje NENHUMA rota do worker entrega
 * `handleLeaderboardByMonth` pra um brand com `leaderboardPeriod === "year"`
 * (clarice) — `GET /leaderboard` já dispatcha direto pra
 * `handleLeaderboardByYear` quando `leaderboardPeriod === "year"` (index.ts),
 * e `GET /leaderboard/{YYYY-MM}` faz 302 pra `/leaderboard/{YYYY}` nesse caso
 * (#2114b). Então o branch "mensal com link anual" é exercido chamando
 * `handleLeaderboardByMonth` diretamente (bypassando o router) — cobre a
 * lógica pura do gate sem depender de uma rota hoje inalcançável.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerDefault from "../workers/poll/src/index.ts";
import { handleLeaderboardByMonth } from "../workers/poll/src/leaderboard-routes.ts";
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

describe("handleLeaderboardByYear — sem self-link 'Ver ranking anual' (#4049 item 1)", () => {
  it("GET /leaderboard/{YYYY}?brand=clarice NÃO contém 'Ver ranking anual'", async () => {
    const html = await fetchHtml("/leaderboard/2026?brand=clarice");
    assert.doesNotMatch(html, /Ver ranking anual/, "a view anual não deveria linkar pra si mesma");
  });

  it("GET /leaderboard/{YYYY}?brand=clarice: nenhum href aponta pra própria URL canônica", async () => {
    const html = await fetchHtml("/leaderboard/2026?brand=clarice");
    // canonicalPath usado por handleLeaderboardByYear = leaderboardHref(brand, yearStr)
    assert.doesNotMatch(
      html,
      /<a href="\/leaderboard\/2026\?brand=clarice">/,
      "nenhum link deveria apontar pra própria URL canônica da página",
    );
  });

  it("GET /leaderboard/{YYYY}?brand=clarice: link de arquivo continua presente (regressão do #3615)", async () => {
    const html = await fetchHtml("/leaderboard/2026?brand=clarice");
    assert.match(html, /Votar em edições passadas/, "o link de arquivo não deveria ter sido removido");
    assert.match(html, /<p class="nav">/, "o parágrafo de nav deve continuar existindo com o link de arquivo");
  });

  it("handleLeaderboardByMonth(brand=clarice) AINDA contém 'Ver ranking anual de {YYYY}' — guarda contra remover o branch inteiro", async () => {
    const res = await handleLeaderboardByMonth("2026-07", makeEnv(), "clarice");
    const html = await res.text();
    assert.match(html, /Ver ranking anual de \d{4}/, "a view mensal (periodKind default) deveria continuar linkando pro ranking anual");
  });
});
