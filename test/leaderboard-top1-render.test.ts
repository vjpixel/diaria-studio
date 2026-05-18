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

describe("renderLeaderboardTop1Row (#1160)", () => {
  it("retorna '' quando leaderboard ausente", () => {
    const r = renderLeaderboardTop1Row(makeEia({}), PSTYLE);
    assert.equal(r, "");
  });

  it("retorna '' quando top1 array vazio", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({ leaderboardTop1: [], leaderboardPeriod: "Maio" }),
      PSTYLE,
    );
    assert.equal(r, "");
  });

  it("single leader: só o nickname (sem pct)", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardTop1: [{ nickname: "Alice", pct: 100, correct: 12, total: 12 }],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /Liderança de Maio/);
    assert.match(r, />🏆 <strong>Liderança de Maio:<\/strong> Alice<\/p>/);
    assert.doesNotMatch(r, /100%/);
    assert.doesNotMatch(r, /12\/12/);
  });

  it("tie de 2: 'X e Y' sem pct", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardTop1: [
          { nickname: "Alice", pct: 100, correct: 5, total: 5 },
          { nickname: "Bob", pct: 100, correct: 5, total: 5 },
        ],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /Alice e Bob/);
    assert.doesNotMatch(r, /100%/);
  });

  it("tie de 3: 'X, Y e Z' sem pct", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardTop1: [
          { nickname: "Alice", pct: 100, correct: 5, total: 5 },
          { nickname: "Bob", pct: 100, correct: 5, total: 5 },
          { nickname: "Carol", pct: 100, correct: 5, total: 5 },
        ],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /Alice, Bob e Carol/);
    assert.doesNotMatch(r, /100%/);
  });

  it("tie de 4-5: lista todos os nomes sem pct", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardTop1: Array.from({ length: 5 }, (_, i) => ({
          nickname: `User${i}`,
          pct: 100,
          correct: 1,
          total: 1,
        })),
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /User0, User1, User2, User3 e User4/);
    assert.doesNotMatch(r, /100%/);
    assert.doesNotMatch(r, /empatados/);
  });

  it("tie de 6+: fallback 'N leitores empatados' (sem listar nomes)", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardTop1: Array.from({ length: 8 }, (_, i) => ({
          nickname: `User${i}`,
          pct: 100,
          correct: 1,
          total: 1,
        })),
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, /8 leitores empatados/);
    assert.doesNotMatch(r, /User0/);
    assert.doesNotMatch(r, /100%/);
  });

  it("período ausente: omite ' de {mês}'", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardTop1: [{ nickname: "Alice", pct: 75, correct: 3, total: 4 }],
      }),
      PSTYLE,
    );
    assert.match(r, /Liderança:/);
    assert.doesNotMatch(r, /Liderança de/);
  });

  it("HTML escape em nickname com caracteres especiais", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardTop1: [{ nickname: "<script>", pct: 100, correct: 1, total: 1 }],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    // esc() converte < > → &lt; &gt;
    assert.match(r, /&lt;script&gt;/);
    assert.doesNotMatch(r, /<script>/i);
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
