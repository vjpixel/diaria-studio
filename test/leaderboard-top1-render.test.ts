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

  it("single leader (rank 1 só): apenas o nome", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [{ nickname: "Alice", rank: 1 }],
        leaderboardPeriod: "Maio",
      }),
      PSTYLE,
    );
    assert.match(r, />🏆 <strong>Liderança de Maio:<\/strong> Alice<\/p>/);
    assert.doesNotMatch(r, /100%/);
  });

  it("2 leitores no podium: 'X e Y'", () => {
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
    assert.match(r, /Alice e Bob/);
  });

  it("3 leitores no podium (1+1+1): 'X, Y e Z' na ordem", () => {
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
    assert.match(r, /Alice, Bob e Carol/);
  });

  it("3 empatados em rank 1: lista todos os 3 na mesma ordem", () => {
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
    assert.match(r, /Davyd, Luisao P e Vanessa/);
  });

  it("5 leitores no podium (2 ouros + 1 prata + 2 bronzes): lista todos em ordem", () => {
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
    assert.match(r, /Alice, Bob, Carol, Dave e Eve/);
  });

  it("período ausente: omite ' de {mês}'", () => {
    const r = renderLeaderboardTop1Row(
      makeEia({
        leaderboardPodium: [{ nickname: "Alice", rank: 1 }],
      }),
      PSTYLE,
    );
    assert.match(r, /Liderança:/);
    assert.doesNotMatch(r, /Liderança de/);
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
