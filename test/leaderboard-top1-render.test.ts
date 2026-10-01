import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderLeaderboardTop1Row, type EIA } from "../scripts/render-newsletter-html.ts";
import { editionToMonthSlug } from "../scripts/fetch-leaderboard-top1.ts";

const PSTYLE = "font:0;"; // dummy, só pra passar pro renderer

function makeEia(overrides: Partial<EIA>): EIA {
  return {
    credit: "credit",
    imageA: "a.jpg",
    imageB: "b.jpg",
    edition: "260518",
    ...overrides,
  };
}

describe("renderLeaderboardTop1Row (#1160 followup — podium ranks 1-3)", () => {
  it("retorna '' quando leaderboard ausente", () => {
    const r = renderLeaderboardTop1Row(makeEia({}), PSTYLE);
    assert.equal(r, "");
  });

  it("retorna '' quando podium array vazio", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({ leaderboardPodium: [], leaderboardPeriod: "Maio" }),
      PSTYLE,
    );
    assert.equal(r, "");
  });

  it("single leader (rank 1 só): posição ordinal + nome", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [{ nickname: "Alice", rank: 1 }],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, />Os campeões do É IA\? em maio:<\/p>/);
    assert.match(r, />🥇 Alice<\/p>/);
    assert.doesNotMatch(r, /100%/);
  });

  it("2 leitores no podium: '1º X, 2º Y'", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [
          { nickname: "Alice", rank: 1 },
          { nickname: "Bob", rank: 2 },
        ],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /🥇 Alice<\/p>\s*<p[^>]*>🥈 Bob<\/p>/);
  });

  it("3 leitores no podium (1,2,3): '1º X, 2º Y, 3º Z' na ordem", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [
          { nickname: "Alice", rank: 1 },
          { nickname: "Bob", rank: 2 },
          { nickname: "Carol", rank: 3 },
        ],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /🥇 Alice<\/p>\s*<p[^>]*>🥈 Bob<\/p>\s*<p[^>]*>🥉 Carol<\/p>/);
  });

  it("3 empatados em rank 1: cada um marcado 1º na mesma ordem", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [
          { nickname: "Davyd", rank: 1 },
          { nickname: "Luisao P", rank: 1 },
          { nickname: "Vanessa", rank: 1 },
        ],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /🥇 Davyd<\/p>\s*<p[^>]*>🥇 Luisao P<\/p>\s*<p[^>]*>🥇 Vanessa<\/p>/);
    assert.doesNotMatch(r, /🥈|🥉/);
  });

  it("5 leitores no podium (2 ouros + 1 prata + 2 bronzes): ordinais em ordem", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [
          { nickname: "Alice", rank: 1 },
          { nickname: "Bob", rank: 1 },
          { nickname: "Carol", rank: 2 },
          { nickname: "Dave", rank: 3 },
          { nickname: "Eve", rank: 3 },
        ],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /🥇 Alice<\/p>\s*<p[^>]*>🥇 Bob<\/p>\s*<p[^>]*>🥈 Carol<\/p>\s*<p[^>]*>🥉 Dave<\/p>\s*<p[^>]*>🥉 Eve<\/p>/);
  });

  it("período ausente: omite ' em {mês}'", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [{ nickname: "Alice", rank: 1 }],
      }),
      PSTYLE,
    );
    assert.match(r, />Os campeões do É IA\?:<\/p>/);
    assert.doesNotMatch(r, /É IA\? em /);
  });

  it("HTML escape em nickname com caracteres especiais", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [{ nickname: "<script>", rank: 1 }],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /&lt;script&gt;/);
    assert.doesNotMatch(r, /<script>/i);
  });

  it("back-compat: cai em leaderboardTop1 quando podium ausente", () => {
    // Arquivo legacy sem campo podium
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardTop1: [{ nickname: "Legacy", pct: 100, correct: 1, total: 1 }],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /Legacy/);
  });
});

describe("editionToMonthSlug — script duplicate (#1160 mirror)", () => {
  it("AAMMDD → YYYY-MM", () => {
    assert.equal(editionToMonthSlug("260518"), "2026-05");
    assert.equal(editionToMonthSlug("251201"), "2025-12");
  });

  it("inválido → null", () => {
    assert.equal(editionToMonthSlug("invalid"), null);
    assert.equal(editionToMonthSlug("261301"), null);
    assert.equal(editionToMonthSlug(""), null);
  });
});

describe("renderLeaderboardTop1Row — pódio no visual do callout de campeões (#9236)", () => {
  const eia = makeEia({
    leaderboardPodium: [
      { nickname: "Alice", rank: 1 },
      { nickname: "Bob", rank: 2 },
      { nickname: "Carol", rank: 3 },
      { nickname: "Dave", rank: 4 },
    ],
    leaderboardPeriod: "Setembro",
    leaderboardPeriodSlug: "2026-09",
  });
  const r = renderLeaderboardTop1Row(eia, PSTYLE);

  it("título serif em negrito com o mês em minúsculas", () => {
    const m = r.match(/<p style="([^"]+)">Os campeões do É IA\? em setembro:<\/p>/);
    assert.ok(m, r);
    assert.match(m![1], /font-weight:bold/);
    assert.match(m![1], /serif/);
  });

  it("uma linha por colocado com medalha; rank > 3 cai em ordinal", () => {
    assert.match(r, /<p style="font:0;">🥇 Alice<\/p>/);
    assert.match(r, /<p style="font:0;">🥈 Bob<\/p>/);
    assert.match(r, /<p style="font:0;">🥉 Carol<\/p>/);
    assert.match(r, /<p style="font:0;">4º Dave<\/p>/);
  });

  it("link 'Veja o ranking completo' para /leaderboard/{slug}, após os colocados", () => {
    assert.match(r, /href="[^"]*\/leaderboard\/2026-09"[^>]*>Veja o ranking completo<\/a>/);
    assert.ok(r.indexOf("Veja o ranking completo") > r.indexOf("4º Dave"));
  });

  it("não usa mais a linha compacta antiga", () => {
    assert.doesNotMatch(r, /🏆|Vencedores/);
  });
});
