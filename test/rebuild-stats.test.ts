import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeStatsFromVotes,
  statsEqual,
  type VoteRecord,
} from "../scripts/rebuild-stats.ts";

describe("computeStatsFromVotes (#1757)", () => {
  it("reconstrói o caso real 260602 (7 votos: 3 A + 4 B, gabarito B → 4 corretos)", () => {
    const votes: VoteRecord[] = [
      { choice: "A", correct: false },
      { choice: "A", correct: false },
      { choice: "A", correct: false },
      { choice: "B", correct: true },
      { choice: "B", correct: true },
      { choice: "B", correct: true },
      { choice: "B", correct: true },
    ];
    assert.deepEqual(computeStatsFromVotes(votes), {
      total: 7,
      voted_a: 3,
      voted_b: 4,
      correct_count: 4,
    });
  });

  it("reconstrói o caso real 260601 (8 votos todos A, gabarito A → 8 corretos)", () => {
    const votes: VoteRecord[] = Array.from({ length: 8 }, () => ({
      choice: "A" as const,
      correct: true,
    }));
    assert.deepEqual(computeStatsFromVotes(votes), {
      total: 8,
      voted_a: 8,
      voted_b: 0,
      correct_count: 8,
    });
  });

  it("votos antes do gabarito (correct: null) somam em total mas NÃO em correct_count", () => {
    const votes: VoteRecord[] = [
      { choice: "A", correct: null },
      { choice: "B", correct: null },
      { choice: "B", correct: true },
    ];
    assert.deepEqual(computeStatsFromVotes(votes), {
      total: 3,
      voted_a: 1,
      voted_b: 2,
      correct_count: 1,
    });
  });

  it("lista vazia → todos zeros", () => {
    assert.deepEqual(computeStatsFromVotes([]), {
      total: 0,
      voted_a: 0,
      voted_b: 0,
      correct_count: 0,
    });
  });

  it("detecta o drift: counter inflado != rebuilt das vote keys reais", () => {
    // O bug #1757: counter ficou em 14 (votos de teste deletados) mas só há 8 reais.
    const inflated = { total: 14, voted_a: 11, voted_b: 3, correct_count: 11 };
    const realVotes: VoteRecord[] = Array.from({ length: 8 }, () => ({
      choice: "A" as const,
      correct: true,
    }));
    const rebuilt = computeStatsFromVotes(realVotes);
    assert.equal(statsEqual(inflated, rebuilt), false, "drift deve ser detectado");
    assert.equal(rebuilt.total, 8);
  });
});

describe("statsEqual (#1757)", () => {
  it("igual quando todos os campos batem", () => {
    const a = { total: 7, voted_a: 3, voted_b: 4, correct_count: 4 };
    const b = { total: 7, voted_a: 3, voted_b: 4, correct_count: 4 };
    assert.equal(statsEqual(a, b), true);
  });

  it("diferente quando qualquer campo diverge", () => {
    const base = { total: 7, voted_a: 3, voted_b: 4, correct_count: 4 };
    assert.equal(statsEqual(base, { ...base, total: 9 }), false);
    assert.equal(statsEqual(base, { ...base, correct_count: 4 - 1 }), false);
  });
});
