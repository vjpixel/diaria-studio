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
import { renderEIA } from "../scripts/lib/newsletter-render-html.ts";

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
    assert.match(html, /Acompanhe o ranking de Junho/);
    assert.match(html, /🏆/);
  });

  it("sem líderes e sem slug → string vazia (back-compat)", () => {
    assert.equal(renderLeaderboardTop1Row(baseEia(), STYLE), "");
    assert.equal(
      renderLeaderboardTop1Row(baseEia({ leaderboardPeriod: "Junho" }), STYLE),
      "",
    );
  });

  it("com líderes + slug → 'Veja o ranking completo' linka /leaderboard/{slug} (#9236)", () => {
    const html = renderLeaderboardTop1Row(
      baseEia({
        leaderboardPodium: [{ nickname: "Davyd", rank: 1 }],
        leaderboardPeriod: "Maio",
        leaderboardPeriodSlug: "2026-05",
      }),
      STYLE,
    );
    assert.match(html, new RegExp(`href="${LB}/2026-05"`));
    assert.match(html, />Veja o ranking completo<\/a>/);
    assert.match(html, /<strong>🎉 Os campeões do É IA\? em maio:<\/strong>/);
    assert.match(html, /🥇 Davyd/);
  });

  it("com líderes sem slug → bloco sem link de ranking (back-compat)", () => {
    const html = renderLeaderboardTop1Row(
      baseEia({
        leaderboardPodium: [{ nickname: "Davyd", rank: 1 }],
        leaderboardPeriod: "Maio",
      }),
      STYLE,
    );
    assert.doesNotMatch(html, /\/leaderboard\//);
    assert.doesNotMatch(html, /Veja o ranking completo/);
    assert.match(html, /<strong>🎉 Os campeões do É IA\? em maio:<\/strong>/);
    assert.match(html, /🥇 Davyd/);
  });

  it("pódio com 3 → 🥇/🥈/🥉 na ordem por acertos (#1646 → #9236)", () => {
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
    assert.match(html, /🥇 Bruna Quevedo<\/p>\s*<p[^>]*>🥈 Joshu<\/p>\s*<p[^>]*>🥉 Ana Cândida<\/p>/);
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

describe("renderEIA — bloco de campeões no box do É IA? sem duplicar link de ranking (#9236)", () => {
  const PODIUM = [
    { nickname: "Bruna Quevedo", rank: 1 },
    { nickname: "Robin", rank: 2 },
    { nickname: "perli…@***", rank: 3 },
  ];

  it("pódio + slug → bloco completo, 1 só link de ranking (o do mês), sem a linha compacta", () => {
    const html = renderEIA(
      baseEia({ leaderboardPodium: PODIUM, leaderboardPeriod: "Setembro", leaderboardPeriodSlug: "2026-09" }),
    );
    assert.match(html, /🎉 Os campeões do É IA\? em setembro:/);
    assert.match(html, /🥇 Bruna Quevedo/);
    assert.match(html, /🥈 Robin/);
    assert.match(html, /🥉 perli…@\*\*\*/);
    assert.equal((html.match(/Veja o ranking completo/g) ?? []).length, 1);
    assert.match(html, new RegExp(`href="${LB}/2026-09"`));
    assert.doesNotMatch(html, /Veja o ranking de quem mais acerta/, "link persistente suprimido quando o bloco já linka o ranking");
    assert.doesNotMatch(html, /Vencedores/, "linha compacta antiga não volta");
  });

  it("pódio sem slug → bloco sem link próprio; link persistente continua", () => {
    const html = renderEIA(baseEia({ leaderboardPodium: PODIUM, leaderboardPeriod: "Setembro" }));
    assert.match(html, /🎉 Os campeões do É IA\? em setembro:/);
    assert.doesNotMatch(html, /Veja o ranking completo/);
    assert.match(html, /Veja o ranking de quem mais acerta/);
  });

  it("na janela com fetch falho (pódio vazio + slug) → só o convite linka o ranking, persistente suprimido", () => {
    const html = renderEIA(baseEia({ leaderboardPodium: [], leaderboardPeriodSlug: "2026-09" }));
    assert.match(html, /Acompanhe o ranking do mês/);
    assert.doesNotMatch(html, /Veja o ranking de quem mais acerta/);
  });

  it("fora da janela das 3 primeiras edições (JSON vazio) → sem bloco, link persistente presente", () => {
    const html = renderEIA(baseEia({ leaderboardPodium: [], leaderboardPeriodSlug: "" }));
    assert.doesNotMatch(html, /Os campeões do É IA\?/);
    assert.match(html, /Veja o ranking de quem mais acerta/);
  });
});
