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
 *   2. Cauda de 0/N sai da listagem — REVERTIDO por #4122 (decisão do editor
 *      260727): o corte fazia o self-highlight (#4029) mentir pra quem jogou
 *      1-2x e nunca acertou ("você ainda não aparece" — falso, só faltava
 *      tentativa suficiente pra ser LISTADO). Editor optou por "todo mundo
 *      se vê no ranking" — ver describe abaixo, atualizado (não duplicado)
 *      pra travar a reversão. Unit tests de `partitionLeaderboardForDisplay`
 *      (a função pura, ainda parametrizável) continuam em leaderboard-rank.test.ts.
 *   4. Cabeçalho "Leitor(a)" → "Jogador(a)".
 *   6. Badges de memória no arquivo (`/jogar/arquivo`) via /jogar/seq-state.
 *   7. Rodapé da sequência ganha link pro arquivo — REVERTIDO por #4030
 *      item 1 (MESMO dia, 260724): o editor jogou a versão deployada e
 *      pediu pra tirar o link de novo. O describe abaixo foi atualizado
 *      (não duplicado) pra travar a remoção — ver header de jogar.ts.
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

describe("leaderboard HTML — cauda de 0/N NÃO some mais da listagem (#4008 item 2, REVERTIDO por #4122)", () => {
  it("entries abaixo do antigo mínimo de tentativas continuam listadas linha-a-linha, sem agregado '+ N jogadores'", async () => {
    // #4122 (decisão do editor 260727): reversão deliberada do #4008 item 2 —
    // o corte fazia o self-highlight mentir pra quem jogou pouco. Fixture
    // idêntico ao teste pré-reversão, asserção invertida.
    const env = makeEnv({
      "score-by-month:2020-01:ana@x.com": JSON.stringify({ total: 5, correct: 4, nickname: "Ana" }),
      "score-by-month:2020-01:bob@x.com": JSON.stringify({ total: 4, correct: 2, nickname: "Bob" }),
      "score-by-month:2020-01:zero1@x.com": JSON.stringify({ total: 1, correct: 0, nickname: "Zero1" }),
      "score-by-month:2020-01:zero2@x.com": JSON.stringify({ total: 2, correct: 0, nickname: "Zero2" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    assert.match(html, /Ana/);
    assert.match(html, /Bob/);
    assert.match(html, /Zero1/, "entry com 1 tentativa deve aparecer linha-a-linha (corte revertido)");
    assert.match(html, /Zero2/, "entry com 2 tentativas deve aparecer linha-a-linha (corte revertido)");
    assert.doesNotMatch(html, /\+ \d+ jogador/, "agregado '+ N jogadores' foi removido junto com o corte");
  });

  it("se todo mundo tem baixo engajamento, mostra todo mundo igual antes (nunca houve regressão nesse caso)", async () => {
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

describe("leaderboard HTML — dense-rank sem buraco de medalha, cenário A/B/C/D da issue #4122", () => {
  it("A/B empatados no ouro, C sozinho na prata com poucas tentativas, D no bronze — todos visíveis, medalhas 🥇🥇🥈🥉 sem buraco", async () => {
    // Fixture idêntico ao reproduzido na issue #4122: A(5,10) e B(5,10)
    // empatados, C(4,2) — antes da reversão do corte de cauda, C sumia da
    // listagem por ter só 2 tentativas (< MIN_ATTEMPTS_FOR_LEADERBOARD_LISTING
    // = 3) e o pódio exibido virava 🥇🥇🥉 (a prata "sumia"). Com a reversão
    // (#4122, decisão do editor 260727) C nunca é escondido — o cenário do
    // buraco de medalha fica estruturalmente impossível no caminho de
    // exibição (só o cap de 500 ainda corta, protegido pelo re-rank denso).
    const env = makeEnv({
      "score-by-month:2020-01:a@x.com": JSON.stringify({ total: 10, correct: 5, nickname: "Aaa" }),
      "score-by-month:2020-01:b@x.com": JSON.stringify({ total: 10, correct: 5, nickname: "Bbb" }),
      "score-by-month:2020-01:c@x.com": JSON.stringify({ total: 2, correct: 4, nickname: "Ccc" }),
      "score-by-month:2020-01:d@x.com": JSON.stringify({ total: 8, correct: 3, nickname: "Ddd" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    assert.match(html, /Aaa/);
    assert.match(html, /Bbb/);
    assert.match(html, /Ccc/, "C não é mais escondido — não há mais corte de cauda");
    assert.match(html, /Ddd/);
    // Ordem de aparição no <tbody> deve refletir 🥇🥇🥈🥉 (sem "3." aparecer pra C).
    const rowsHtml = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    const medals = [...rowsHtml.matchAll(/<td>([^<]+)<\/td>/g)].filter((_, i) => i % 4 === 0).map((m) => m[1]);
    assert.deepEqual(medals, ["🥇", "🥇", "🥈", "🥉"]);
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

describe("renderJogarSequencePageHtml — rodapé linka pro arquivo (#4008 item 7, revertido por #4030 item 1)", () => {
  it("footer da sequência NÃO tem mais 'Jogar edições passadas' → /jogar/arquivo (editor reverteu no mesmo dia 260724, ver test/poll-jogar-sequence-3589.test.ts)", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.doesNotMatch(html, /<a href="\/jogar\/arquivo">Jogar edições passadas<\/a>/);
  });

  it("continua linkando 'Ver ranking' (nunca foi tocado por nenhuma das 3 idas-e-vindas)", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, />Ver ranking<\/a>/);
  });
});
