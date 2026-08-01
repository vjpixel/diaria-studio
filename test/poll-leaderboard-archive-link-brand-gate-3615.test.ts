/**
 * test/poll-leaderboard-archive-link-brand-gate-3615.test.ts (#3615)
 *
 * Regressão: `GET /leaderboard` (renderLeaderboardHtml, leaderboard-routes.ts)
 * mostrava "Votar em edições passadas" (link pro arquivo) incondicionalmente
 * pra TODOS os brands — o #3578 só corrigiu esse mesmo gate na página de VOTO
 * (votePageHtml, index.ts), rota separada. Diária (e web, #3589) não têm mais
 * acesso ao arquivo em nenhuma superfície; só clarice/mensal mantém.
 *
 * Item 2 (feedback do editor, mesma sessão): "Ver ranking anual" também não
 * faz sentido pra diária/web — o leaderboard delas é MENSAL por design
 * (`BRAND_INFO[brand].leaderboardPeriod === "month"`), não existe um
 * "ranking anual" real pra linkar. Só clarice (`leaderboardPeriod === "year"`)
 * mantém esse link. Quando NENHUM dos dois links (anual/arquivo) se aplica, o
 * `<p class="nav">` inteiro some da página (não fica um parágrafo vazio).
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
});

describe("renderLeaderboardHtml — link de ranking anual gated por leaderboardPeriod (#3615 item 2)", () => {
  it("brand diária NÃO mostra 'Ver ranking anual' (leaderboard é mensal)", async () => {
    const html = await fetchHtml("/leaderboard");
    assert.doesNotMatch(html, /Ver ranking anual/, "diária não deveria ter link de ranking anual");
  });

  it("brand web NÃO mostra 'Ver ranking anual' (leaderboard é mensal)", async () => {
    const html = await fetchHtml("/leaderboard?brand=web");
    assert.doesNotMatch(html, /Ver ranking anual/, "web não deveria ter link de ranking anual");
  });

  // #4049 item 1: `GET /leaderboard?brand=clarice` (sem `?brand=` diária)
  // dispatcha direto pra `handleLeaderboardByYear` (index.ts — leaderboardPeriod
  // "year" pula `handleLeaderboard`/`handleLeaderboardByMonth` por completo),
  // então esta é SEMPRE a própria view anual (periodKind "year") — nunca
  // existiu, na prática, uma view "mensal" de clarice reachable que pudesse
  // linkar PRA a anual. A asserção original deste teste (mantida até #4049)
  // codificava exatamente o self-link bug do #4049: "Ver ranking anual"
  // apontando pra própria URL canônica da página em que o leitor já está.
  // Corrigido aqui; guarda de regressão dedicada em
  // test/poll-leaderboard-annual-self-link-4049.test.ts.
  it("brand clarice NÃO mostra 'Ver ranking anual' em /leaderboard (já é a view anual, #4049)", async () => {
    const html = await fetchHtml("/leaderboard?brand=clarice");
    assert.doesNotMatch(html, /Ver ranking anual/, "clarice não deveria self-linkar pro ranking anual na própria página anual");
  });

  it("diária: <p class=\"nav\"> inteiro some quando não há nenhum link a oferecer", async () => {
    const html = await fetchHtml("/leaderboard");
    assert.doesNotMatch(html, /<p class="nav">/, "não deveria sobrar um parágrafo de nav vazio pra diária");
  });

  it("clarice: link de arquivo presente como botão próprio, fora de <p class=\"nav\"> (#4049: sem o self-link anual; #4420: tratamento visual de botão)", async () => {
    const html = await fetchHtml("/leaderboard?brand=clarice");
    // #4420: "Votar em edições passadas" saiu de dentro de `<p class="nav">`
    // — agora é um botão próprio (`.archive-cta`/`.archive-btn`), mesmo
    // tratamento visual do equivalente em /vote (não "dois pesos visuais
    // pro mesmo lugar"). `/leaderboard?brand=clarice` dispatcha direto pra
    // handleLeaderboardByYear (leaderboard-routes.ts, leaderboardPeriod
    // "year" no router de index.ts) — a própria view anual, onde "Ver
    // ranking anual" não se aplica (#4049,
    // self-link) — sem NENHUM outro conteúdo de nav sobrando, `<p
    // class="nav">` fica de fora por completo (mesmo padrão do teste
    // #4049 acima).
    assert.match(html, /class="archive-cta"[^>]*>\s*<a class="archive-btn"[^>]*>Votar em edições passadas<\/a>/s);
    assert.doesNotMatch(html, /<p class="nav">/, "sem 'Ver ranking anual' sobrando (já é a view anual), nav não deveria renderizar vazio");
  });
});
