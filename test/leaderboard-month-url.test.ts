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
import {
  renderLeaderboardTop1Row,
  renderLeaderboardLinkRow,
  type EIA,
} from "../scripts/render-newsletter-html.ts";

const STYLE = "font-family:sans-serif;";
const LB = "https://eia.diar.ia.br/leaderboard"; // #3701: domínio de marca (era poll.diaria.workers.dev)

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

describe("renderLeaderboardLinkRow — link persistente (#1970)", () => {
  it("sempre emite link pra raiz /leaderboard (sem slug do mês)", () => {
    const html = renderLeaderboardLinkRow(STYLE);
    assert.match(html, new RegExp(`href="${LB}"`));
    // raiz, não /leaderboard/{slug} (link estático, sem depender do mês)
    assert.doesNotMatch(html, /\/leaderboard\/\d/);
    assert.match(html, /Veja o ranking de quem mais acerta/);
    assert.match(html, /target="_blank"/);
  });

  it("independe de pódio/slug — toda edição renderiza igual", () => {
    // O ponto do #1970: o link NÃO depende de leaderboardPeriod/Podium (1ª-do-mês).
    assert.equal(renderLeaderboardLinkRow(STYLE), renderLeaderboardLinkRow(STYLE));
    // Edição NÃO-1ª-do-mês (sem líderes, sem slug): renderLeaderboardTop1Row é
    // "" mas o link persistente AINDA aparece — complementares no renderEIA.
    assert.equal(renderLeaderboardTop1Row(baseEia(), STYLE), "");
    assert.notEqual(renderLeaderboardLinkRow(STYLE), "");
  });
});
