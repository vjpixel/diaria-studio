/**
 * leaderboard-month-url.test.ts (#1345 followup, edição 260601)
 *
 * Testa o link do bloco de leaderboard pra URL histórica mensal
 * `/leaderboard/{YYYY-MM}` em renderLeaderboardTop1Row.
 *
 * Decisão editorial (260601): cada mês tem leaderboard própria numa URL
 * permanente (preserva histórico). O bloco "🏆 Liderança de {mês}" linka
 * pra essa URL; na 1ª edição do mês (sem vencedor ainda) mostra um
 * convite linkado em vez de omitir o bloco.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderLeaderboardTop1Row, type EIA } from "../scripts/render-newsletter-html.ts";

const STYLE = "font-family:sans-serif;";
const LB = "https://poll.diaria.workers.dev/leaderboard";

function baseEia(overrides: Partial<EIA> = {}): EIA {
  return {
    credit: "Foto teste",
    imageA: "01-eia-A.jpg",
    imageB: "01-eia-B.jpg",
    edition: "260601",
    ...overrides,
  };
}

describe("renderLeaderboardTop1Row — link mensal (#1345)", () => {
  it("sem líderes mas com slug → convite linkado pra /leaderboard/{slug}", () => {
    const html = renderLeaderboardTop1Row(
      baseEia({ leaderboardPeriod: "Junho", leaderboardPeriodSlug: "2026-06" }),
      STYLE,
    );
    assert.match(html, new RegExp(`href="${LB}/2026-06"`));
    assert.match(html, /Acompanhe a leaderboard de Junho/);
    assert.match(html, /🏆/);
  });

  it("sem líderes e sem slug → string vazia (back-compat)", () => {
    assert.equal(renderLeaderboardTop1Row(baseEia(), STYLE), "");
    assert.equal(
      renderLeaderboardTop1Row(baseEia({ leaderboardPeriod: "Junho" }), STYLE),
      "",
    );
  });

  it("com líderes + slug → cabeçalho 'Vencedores' é link pra /leaderboard/{slug}", () => {
    const html = renderLeaderboardTop1Row(
      baseEia({
        leaderboardPodium: [{ nickname: "Davyd", rank: 1 }],
        leaderboardPeriod: "Maio",
        leaderboardPeriodSlug: "2026-05",
      }),
      STYLE,
    );
    assert.match(html, new RegExp(`href="${LB}/2026-05"`));
    assert.match(html, />Vencedores de Maio<\/a>/);
    assert.match(html, /Davyd/);
  });

  it("com líderes sem slug → cabeçalho em <strong> (back-compat, sem link)", () => {
    const html = renderLeaderboardTop1Row(
      baseEia({
        leaderboardPodium: [{ nickname: "Davyd", rank: 1 }],
        leaderboardPeriod: "Maio",
      }),
      STYLE,
    );
    assert.doesNotMatch(html, /\/leaderboard\//);
    assert.match(html, /<strong>Vencedores de Maio<\/strong>/);
    assert.match(html, /Davyd/);
  });

  it("pódio com 3 → posições ordinais '1º X, 2º Y, 3º Z' por acertos (#1646)", () => {
    const html = renderLeaderboardTop1Row(
      baseEia({
        leaderboardPodium: [
          { nickname: "Bruna Quevedo", rank: 1 },
          { nickname: "Joshu", rank: 2 },
          { nickname: "Ana Cândida", rank: 3 },
        ],
        leaderboardPeriod: "Maio",
        leaderboardPeriodSlug: "2026-05",
      }),
      STYLE,
    );
    assert.match(html, /1º Bruna Quevedo, 2º Joshu, 3º Ana Cândida/);
    // sem percentuais no texto (#1646)
    assert.doesNotMatch(html, /%/);
  });
});
