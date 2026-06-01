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

import { describe, it, expect } from "vitest";
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
    expect(html).toContain(`href="${LB}/2026-06"`);
    expect(html).toContain("Acompanhe a leaderboard de Junho");
    expect(html).toContain("🏆");
  });

  it("sem líderes e sem slug → string vazia (back-compat)", () => {
    expect(renderLeaderboardTop1Row(baseEia(), STYLE)).toBe("");
    expect(
      renderLeaderboardTop1Row(baseEia({ leaderboardPeriod: "Junho" }), STYLE),
    ).toBe("");
  });

  it("com líderes + slug → cabeçalho 'Liderança' é link pra /leaderboard/{slug}", () => {
    const html = renderLeaderboardTop1Row(
      baseEia({
        leaderboardPodium: [{ nickname: "Davyd", rank: 1 }],
        leaderboardPeriod: "Maio",
        leaderboardPeriodSlug: "2026-05",
      }),
      STYLE,
    );
    expect(html).toContain(`href="${LB}/2026-05"`);
    expect(html).toContain(">Liderança de Maio</a>");
    expect(html).toContain("Davyd");
  });

  it("com líderes sem slug → cabeçalho em <strong> (back-compat, sem link)", () => {
    const html = renderLeaderboardTop1Row(
      baseEia({
        leaderboardPodium: [{ nickname: "Davyd", rank: 1 }],
        leaderboardPeriod: "Maio",
      }),
      STYLE,
    );
    expect(html).not.toContain("/leaderboard/");
    expect(html).toContain("<strong>Liderança de Maio</strong>");
    expect(html).toContain("Davyd");
  });
});
