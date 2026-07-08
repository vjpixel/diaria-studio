/**
 * test/poll-leaderboard-nav-kicker-3108.test.ts (#3108)
 *
 * Regressão para 2 achados da issue #3108:
 *
 *   1. Navegação ausente: `/leaderboard` (e `/leaderboard/{YYYY}` no brand
 *      `clarice`) não linkava pro arquivo retroativo (`/leaderboard/{YYYY}/arquivo`,
 *      #2867) nem pro leaderboard anual — crítico pro brand `clarice`, onde a
 *      visão anual JÁ é a página principal e o arquivo é o mecanismo oficial
 *      de pontuação retroativa. Fix: bloco de nav ANTES da `<table>` (logo
 *      abaixo da sub-copy), nos 2 brands, com os 2 links.
 *
 *   2. Divergência de hierarquia: o kicker "É IA?" aparecia ABAIXO do `<h1>`
 *      no leaderboard principal, mas ACIMA do `<h1>` no arquivo
 *      (`renderArchiveListHtml`). Fix: kicker sempre ACIMA do h1 nas 2 páginas.
 *
 * Decisão do editor (260707): a mudança de sub-copy (2 links: diar.ia.br +
 * Clarice) é EXCLUSIVA do brand `clarice` — cross-promoção só faz sentido na
 * newsletter mensal. O brand `diaria` mantém o texto original inalterado —
 * regressão explícita (falharia se alguém generalizasse a mudança por engano).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerDefault from "../workers/poll/src/index.ts";
import type { Env } from "../workers/poll/src/index.ts";

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data: Record<string, string> = { ...seed };
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
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

function makeEnv(seed: Record<string, string> = {}): Env {
  return {
    POLL: makeKv(seed),
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

async function fetchHtml(path: string, env: Env = makeEnv()): Promise<string> {
  const req = new Request(`https://poll.diaria.workers.dev${path}`);
  const res = await workerDefault.fetch(req, env, {} as ExecutionContext);
  assert.equal(res.status, 200, `esperava 200 para ${path}, recebeu ${res.status}`);
  return res.text();
}

/** Índice do início da tag (1ª ocorrência), -1 se ausente. */
function idx(html: string, needle: string): number {
  return html.indexOf(needle);
}

describe("#3108 — kicker sempre ACIMA do h1 (unificado entre leaderboard e arquivo)", () => {
  it("GET /leaderboard (brand diaria): kicker antes do h1", async () => {
    const html = await fetchHtml("/leaderboard");
    const kickerIdx = idx(html, '<p class="kicker">');
    const h1Idx = idx(html, "<h1>");
    assert.ok(kickerIdx >= 0 && h1Idx >= 0, "kicker e h1 devem existir");
    assert.ok(kickerIdx < h1Idx, "kicker deve vir ANTES do h1");
  });

  it("GET /leaderboard/2026?brand=clarice (visão anual): kicker antes do h1", async () => {
    const html = await fetchHtml("/leaderboard/2026?brand=clarice");
    const kickerIdx = idx(html, '<p class="kicker">');
    const h1Idx = idx(html, "<h1>");
    assert.ok(kickerIdx >= 0 && h1Idx >= 0);
    assert.ok(kickerIdx < h1Idx, "kicker deve vir ANTES do h1 também na visão anual");
  });

  it("GET /leaderboard/2026/arquivo: kicker antes do h1 (já era o comportamento correto — guarda de regressão)", async () => {
    const html = await fetchHtml("/leaderboard/2026/arquivo");
    const kickerIdx = idx(html, '<p class="kicker">');
    const h1Idx = idx(html, "<h1>");
    assert.ok(kickerIdx >= 0 && h1Idx >= 0);
    assert.ok(kickerIdx < h1Idx, "arquivo deve continuar com kicker antes do h1");
  });
});

describe("#3108 — navegação (arquivo + anual) ANTES da tabela, nos 2 brands", () => {
  it("GET /leaderboard (brand diaria): nav com os 2 links, posicionada entre sub-copy e <table>", async () => {
    const html = await fetchHtml("/leaderboard");
    const subIdx = idx(html, '<p class="sub">');
    const navIdx = idx(html, '<p class="nav">');
    const tableIdx = idx(html, "<table>");
    assert.ok(subIdx >= 0 && navIdx >= 0 && tableIdx >= 0, "sub, nav e table devem existir");
    assert.ok(subIdx < navIdx, "nav deve vir depois da sub-copy");
    assert.ok(navIdx < tableIdx, "nav deve vir ANTES da <table>");
    assert.match(html, /href="\/leaderboard\/\d{4}">Ver ranking anual de \d{4}<\/a>/);
    assert.match(html, /href="\/leaderboard\/\d{4}\/arquivo">Votar em edições passadas<\/a>/);
  });

  it("GET /leaderboard/2026?brand=clarice: nav preserva ?brand=clarice nos 2 links", async () => {
    const html = await fetchHtml("/leaderboard/2026?brand=clarice");
    const navIdx = idx(html, '<p class="nav">');
    const tableIdx = idx(html, "<table>");
    assert.ok(navIdx >= 0 && navIdx < tableIdx, "nav deve existir e vir antes da table na visão anual (clarice)");
    assert.match(html, /href="\/leaderboard\/2026\?brand=clarice">Ver ranking anual de 2026<\/a>/);
    assert.match(html, /href="\/leaderboard\/2026\/arquivo\?brand=clarice">Votar em edições passadas<\/a>/);
  });

  it("GET /leaderboard/2026-03 (mês específico, diaria): nav aponta pro ano 2026 (não pro mês)", async () => {
    const html = await fetchHtml("/leaderboard/2026-03");
    assert.match(html, /href="\/leaderboard\/2026">Ver ranking anual de 2026<\/a>/);
    assert.match(html, /href="\/leaderboard\/2026\/arquivo">Votar em edições passadas<\/a>/);
  });
});

describe("#3108 — sub-copy: 2 links SÓ no brand clarice; brand diaria INALTERADO", () => {
  it("brand clarice: sub-copy com 2 links (diar.ia.br → beehiiv, Clarice → clarice.ai)", async () => {
    const html = await fetchHtml("/leaderboard/2026?brand=clarice");
    assert.match(
      html,
      /<p class="sub">Quem mais acertou este ano qual imagem foi gerada pela <a href="https:\/\/diaria\.beehiiv\.com">diar\.ia\.br<\/a> na newsletter da <a href="https:\/\/clarice\.ai\/\?via=diaria">Clarice<\/a>\.<\/p>/,
      "sub-copy da clarice deve ter os 2 links exatos: diar.ia.br→beehiiv e Clarice→clarice.ai (shortName, não 'Clarice News' inteiro)",
    );
  });

  it("brand diaria: sub-copy é o texto ORIGINAL, sem os 2 links da clarice (regressão contra generalização acidental)", async () => {
    const html = await fetchHtml("/leaderboard");
    assert.match(
      html,
      /<p class="sub">Quem mais acertou esse mês qual imagem foi gerada por IA na <a href="https:\/\/diar\.ia\.br">Diar\.ia<\/a>\.<\/p>/,
      "sub-copy do brand diaria deve permanecer EXATAMENTE como antes",
    );
    assert.doesNotMatch(html, /diaria\.beehiiv\.com/, "brand diaria não deve ganhar o link cross-promo da clarice");
    assert.doesNotMatch(html, /newsletter da/, "brand diaria não deve ganhar a frase 'newsletter da X' da clarice");
  });
});
