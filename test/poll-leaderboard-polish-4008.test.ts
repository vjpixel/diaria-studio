/**
 * test/poll-leaderboard-polish-4008.test.ts (#4008)
 *
 * Polimento do ranking/navegação do "É IA?" web — itens 1, 2, 4, 5, 6, 7 da
 * issue (item 3, critério de desempate, é decisão editorial fora de escopo
 * desta rodada — ver comentário na issue #4008).
 *
 *   1. maskEmail trunca o local-part (unit tests em poll-batch-3118.test.ts,
 *      já atualizados) — aqui cobrimos a INTEGRAÇÃO: o HTML do leaderboard
 *      de fato usa a versão truncada, não o e-mail quase completo.
 *   2. Cauda de 0/N sai da listagem — abaixo cobre a integração completa
 *      (unit tests de `partitionLeaderboardForDisplay` em
 *      leaderboard-rank.test.ts).
 *   4. Cabeçalho "Leitor(a)" → "Jogador(a)".
 *   6. Badges de memória no arquivo (`/jogar/arquivo`) via /jogar/seq-state.
 *   7. Rodapé da sequência ganha link pro arquivo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleLeaderboardByMonth } from "../workers/poll/src/leaderboard-routes.ts";
import { renderJogarArchiveHtml, renderJogarSequencePageHtml } from "../workers/poll/src/jogar.ts";
import type { Env } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return {
    POLL: makeTrackedKv(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
}

describe("leaderboard HTML — cabeçalho 'Jogador(a)' (#4008 item 4)", () => {
  it("cabeçalho não usa mais 'Leitor(a)' — inclui o jogador web", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:a@x.com": JSON.stringify({ total: 4, correct: 3, nickname: "Ana" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    assert.match(html, /<th>Jogador\(a\)<\/th>/);
    assert.doesNotMatch(html, /Leitor\(a\)/);
  });
});

describe("leaderboard HTML — email mascarado truncado (#4008 item 1, integração)", () => {
  it("entry sem nickname aparece com local-part truncado, não o e-mail quase inteiro", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:wutrecht@example.com": JSON.stringify({ total: 5, correct: 4, nickname: null }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    assert.match(html, /wut…@\*\*\*/);
    assert.doesNotMatch(html, /wutrecht@\*\*\*/, "local-part completo não deve mais aparecer");
  });
});

describe("leaderboard HTML — cauda de 0/N some da listagem (#4008 item 2, integração)", () => {
  it("entries abaixo do mínimo de tentativas somem da tabela e viram agregado '+ N jogadores'", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:ana@x.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
      "score-by-month:2020-01:bob@x.com": JSON.stringify({ total: 4, correct: 2, nickname: "Bob" }),
      "score-by-month:2020-01:zero1@x.com": JSON.stringify({ total: 1, correct: 0, nickname: null }),
      "score-by-month:2020-01:zero2@x.com": JSON.stringify({ total: 2, correct: 0, nickname: null }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    assert.match(html, /Ana/);
    assert.match(html, /Bob/);
    assert.doesNotMatch(html, /zero1@\*\*\*|zer…@\*\*\*/, "entry com 1 tentativa não deve aparecer linha-a-linha");
    assert.match(html, /\+ 2 jogadores esse mês/, "cauda vira agregado de prova social");
  });

  it("se NINGUÉM atinge o mínimo, mostra todo mundo (fallback anti-leaderboard-vazio) e omite o agregado", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:zero1@x.com": JSON.stringify({ total: 1, correct: 0, nickname: "Zero1" }),
      "score-by-month:2020-01:zero2@x.com": JSON.stringify({ total: 1, correct: 1, nickname: "Zero2" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    assert.match(html, /Zero1/);
    assert.match(html, /Zero2/);
    assert.doesNotMatch(html, /\+ \d+ jogador/, "sem corte aplicado — não mostra agregado");
  });
});

describe("renderJogarArchiveHtml — badges de memória (#4008 item 6)", () => {
  it("cada edição vira um placeholder de badge '—' com data-badge, preenchido via /jogar/seq-state", () => {
    const html = renderJogarArchiveHtml(["260615", "260101"], "2026");
    assert.match(html, /data-badge="260615">—<\/span>/);
    assert.match(html, /data-badge="260101">—<\/span>/);
    assert.match(html, /\/jogar\/seq-state\?email=/, "script deve chamar o endpoint de estado por edição");
    assert.match(html, /eia_web_token/, "script deve ler o token anônimo já usado pela sequência");
  });

  it("lista vazia — script de badges não quebra (early return, sem editions)", () => {
    const html = renderJogarArchiveHtml([], "2026");
    assert.match(html, /Nenhuma edição disponível/i);
  });

  it("anti-spoiler: badges nunca revelam A/B, só ✓/✗/— via JS", () => {
    const html = renderJogarArchiveHtml(["260101"], "2026");
    assert.doesNotMatch(html, />A<|>B</);
  });
});

describe("renderJogarSequencePageHtml — rodapé linka pro arquivo (#4008 item 7)", () => {
  it("footer da sequência (tela padrão/final) ganha 'Jogar edições passadas' → /jogar/arquivo", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, /<a href="\/jogar\/arquivo">Jogar edições passadas<\/a>/);
  });

  it("continua linkando 'Ver ranking' (não substituído, só complementado)", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, />Ver ranking<\/a>/);
  });
});
