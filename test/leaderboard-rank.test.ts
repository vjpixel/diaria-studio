/**
 * leaderboard-rank.test.ts (#1092, #1256)
 *
 * Testes do helper de ranking do leaderboard do É IA?. Cobre os 4 cenários
 * do issue: sem empate, empate parcial, todos empatados, tiebreaker estável.
 *
 * #1256: migrado de competition rank (1, 1, 3) pra dense rank (1, 1, 2) —
 * empate herda, próximo grupo é só +1 (não pula).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rankEntries,
  medalFor,
  partitionLeaderboardForDisplay,
  MIN_ATTEMPTS_FOR_LEADERBOARD_LISTING,
  type LeaderboardEntry,
} from "../workers/poll/src/leaderboard.ts";

function entry(
  email: string,
  correct: number,
  total: number,
  nickname: string | null = null,
  last_vote_ts?: string,
): LeaderboardEntry {
  return {
    email,
    nickname,
    correct,
    total,
    pct: total > 0 ? Math.round((correct / total) * 100) : 0,
    streak: 0,
    last_vote_ts,
  };
}

describe("rankEntries (#1092)", () => {
  it("sem empate: ranks sequenciais 1, 2, 3", () => {
    const ranked = rankEntries([
      entry("a@x.com", 3, 5),
      entry("b@x.com", 2, 5),
      entry("c@x.com", 1, 5),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 2, 3],
    );
    assert.deepEqual(
      ranked.map((r) => r.medal),
      ["🥇", "🥈", "🥉"],
    );
  });

  it("#1256 empate parcial no topo: 1, 1, 2 (dense rank, não competition)", () => {
    const ranked = rankEntries([
      entry("ana@x.com", 5, 5, "ana"),
      entry("bruno@x.com", 5, 5, "bruno"),
      entry("carla@x.com", 1, 2, "carla"),
    ]);
    // Ana e Bruno empatados em (5, 100%) → ambos rank 1
    // Carla em rank 2 (dense — sem pular)
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 1, 2],
    );
    // Ambos os tops recebem ouro; carla recebe prata (rank 2)
    assert.deepEqual(
      ranked.map((r) => r.medal),
      ["🥇", "🥇", "🥈"],
    );
  });

  it("#1256 empate parcial no meio: 1, 2, 2, 3 (dense rank)", () => {
    const ranked = rankEntries([
      entry("a@x.com", 10, 10, "a"),
      entry("b@x.com", 5, 10, "b"),
      entry("c@x.com", 5, 10, "c"),
      entry("d@x.com", 3, 10, "d"),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 2, 2, 3],
    );
  });

  it("#1256 cenário real (screenshot): 6 empatados em rank 3 → próximo é 4 (não 9)", () => {
    // Reproduz o leaderboard reportado em #1256:
    //   1 pessoa rank 1 (2/3), 1 rank 2 (1/2),
    //   6 rank 3 (1/1) → próximo grupo deve ser rank 4 (não 9)
    //   3 rank 4 (0/1)
    const ranked = rankEntries([
      entry("bruna@x.com", 2, 3, "Bruna"),
      entry("joshu@x.com", 1, 2, "Joshu"),
      entry("edson@x.com", 1, 1, "edsonesilva"),
      entry("fumaca@x.com", 1, 1, "fumaca-cachorro"),
      entry("lucas@x.com", 1, 1, "lucasd11"),
      entry("luisao@x.com", 1, 1, "Luisao P"),
      entry("renato@x.com", 1, 1, "renatobergallo"),
      entry("vanessa@x.com", 1, 1, "Vanessa"),
      entry("celeji@x.com", 0, 1, "celejinha"),
      entry("cristina@x.com", 0, 1, "cristina.moreira"),
      entry("roberto@x.com", 0, 1, "robertoabreu"),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4],
    );
    // Última pessoa do empate-bronze tem medal 🥉; primeiro do próximo grupo é "4."
    assert.equal(ranked[7].medal, "🥉");
    assert.equal(ranked[8].medal, "4.");
  });

  it("todos empatados: 1, 1, 1, 1", () => {
    const ranked = rankEntries([
      entry("a@x.com", 5, 5, "a"),
      entry("b@x.com", 5, 5, "b"),
      entry("c@x.com", 5, 5, "c"),
      entry("d@x.com", 5, 5, "d"),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 1, 1, 1],
    );
  });

  it("tiebreaker estável: alfabético por nickname/email ASC dentro do empate", () => {
    const ranked = rankEntries([
      entry("z@x.com", 5, 5, "zeca"),
      entry("a@x.com", 5, 5, "ana"),
      entry("m@x.com", 5, 5, "marcos"),
    ]);
    // Mesmo rank, mas ordem visual: ana < marcos < zeca (lowercase ASC)
    assert.deepEqual(
      ranked.map((r) => r.nickname),
      ["ana", "marcos", "zeca"],
    );
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 1, 1],
    );
  });

  it("tiebreaker usa email quando nickname é null", () => {
    const ranked = rankEntries([
      entry("zoo@x.com", 5, 5, null),
      entry("alice@x.com", 5, 5, null),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.email),
      ["alice@x.com", "zoo@x.com"],
    );
  });

  it("mesmo pct mas correct diferente NÃO empata (5/5 vs 1/1 ambos 100%)", () => {
    // Ambos têm 100% mas correct diferente — participação diferente.
    // Issue: tie key é (correct, total), não só pct.
    const ranked = rankEntries([
      entry("super@x.com", 5, 5, "super"),
      entry("noob@x.com", 1, 1, "noob"),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 2],
    );
    // Sort: correct DESC → super primeiro
    assert.equal(ranked[0].email, "super@x.com");
  });

  it("mesmo correct, total diferente: mais tentativas vence (#1163)", () => {
    // 2/4 vs 2/2: ambos correct=2. Critério novo (#1163): total DESC
    // (premia participação). Antes era pct DESC (premiava taxa).
    const ranked = rankEntries([
      entry("participa@x.com", 2, 4, "participa"),
      entry("preciso@x.com", 2, 2, "preciso"),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 2],
    );
    assert.equal(ranked[0].email, "participa@x.com");
  });

  it("lista vazia retorna array vazio", () => {
    assert.deepEqual(rankEntries([]), []);
  });

  it("não muta o input array", () => {
    const original: LeaderboardEntry[] = [
      entry("b@x.com", 1, 5, "b"),
      entry("a@x.com", 5, 5, "a"),
    ];
    const beforeOrder = original.map((e) => e.email);
    rankEntries(original);
    const afterOrder = original.map((e) => e.email);
    assert.deepEqual(beforeOrder, afterOrder, "rankEntries não pode mutar o input");
  });
});

describe("rankEntries last_vote_ts tiebreaker (#1383)", () => {
  it("voto mais recente vence empate de (correct, total)", () => {
    // 2 entries idênticas em correct+total, last_vote_ts diferentes
    const ranked = rankEntries([
      entry("alice@x.com", 5, 5, "alice", "2026-05-19T08:00:00Z"),
      entry("bob@x.com", 5, 5, "bob", "2026-05-19T20:00:00Z"), // mais recente
    ]);
    // Bob votou depois → aparece primeiro dentro do empate
    assert.equal(ranked[0].email, "bob@x.com");
    assert.equal(ranked[1].email, "alice@x.com");
    // Mas rank visual é o mesmo (dense rank por correct+total)
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[1].rank, 1);
  });

  it("displayKey ASC ainda é tiebreaker final (timestamps iguais)", () => {
    const ts = "2026-05-19T12:00:00Z";
    const ranked = rankEntries([
      entry("zebra@x.com", 5, 5, "zebra", ts),
      entry("alice@x.com", 5, 5, "alice", ts),
    ]);
    // Mesmo correct+total+ts → ordem alfabética por display
    assert.equal(ranked[0].email, "alice@x.com");
    assert.equal(ranked[1].email, "zebra@x.com");
  });

  it("entry sem last_vote_ts (legacy) cai POR ÚLTIMO no empate", () => {
    // Entries pré-#1383 não tem last_vote_ts. Lexicograficamente "" < qualquer
    // ISO timestamp, então (DESC) entry SEM ts fica DEPOIS de qualquer com ts.
    const ranked = rankEntries([
      entry("legacy@x.com", 3, 5, "legacy"), // sem ts
      entry("new@x.com", 3, 5, "new", "2026-05-19T10:00:00Z"), // com ts
    ]);
    // Quem tem timestamp vence quem não tem (incentiva migração silenciosa)
    assert.equal(ranked[0].email, "new@x.com");
    assert.equal(ranked[1].email, "legacy@x.com");
  });

  it("não afeta entries com correct ou total diferentes", () => {
    // last_vote_ts só importa quando correct+total empata
    const ranked = rankEntries([
      entry("a@x.com", 5, 5, "a", "2026-01-01T00:00:00Z"), // ts antigo, MAIS acertos
      entry("b@x.com", 3, 5, "b", "2026-12-31T23:59:59Z"), // ts recente, MENOS acertos
    ]);
    assert.equal(ranked[0].email, "a@x.com"); // correct=5 vence correct=3
    assert.equal(ranked[1].email, "b@x.com");
  });

  it("ordem dense rank preservada: 3 leitores rank 1, ordenados por ts DESC", () => {
    const ranked = rankEntries([
      entry("first@x.com", 5, 5, "first", "2026-05-01T00:00:00Z"),
      entry("third@x.com", 5, 5, "third", "2026-05-19T00:00:00Z"), // mais recente
      entry("second@x.com", 5, 5, "second", "2026-05-10T00:00:00Z"),
    ]);
    // Todos rank 1 (dense rank), ordem: ts mais recente primeiro
    assert.deepEqual(ranked.map((r) => r.rank), [1, 1, 1]);
    assert.deepEqual(
      ranked.map((r) => r.email),
      ["third@x.com", "second@x.com", "first@x.com"],
    );
  });
});

describe("medalFor (#1092)", () => {
  it("rank 1 → 🥇", () => assert.equal(medalFor(1), "🥇"));
  it("rank 2 → 🥈", () => assert.equal(medalFor(2), "🥈"));
  it("rank 3 → 🥉", () => assert.equal(medalFor(3), "🥉"));
  it("rank 4 → '4.'", () => assert.equal(medalFor(4), "4."));
  it("rank 10 → '10.'", () => assert.equal(medalFor(10), "10."));
});

// ── partitionLeaderboardForDisplay (#4008 item 2) ───────────────────────────

describe("partitionLeaderboardForDisplay (#4008 item 2 — cauda de 0/N)", () => {
  it("esconde entries abaixo do mínimo de tentativas, conta no hiddenCount", () => {
    const ranked = rankEntries([
      entry("a@x.com", 5, 5, "a"),
      entry("b@x.com", 3, 4, "b"),
      entry("c@x.com", 0, 1, "c"), // 1 tentativa — abaixo do mínimo (3)
      entry("d@x.com", 0, 2, "d"), // 2 tentativas — abaixo do mínimo (3)
    ]);
    const { visible, hiddenCount } = partitionLeaderboardForDisplay(ranked);
    assert.deepEqual(visible.map((e) => e.email), ["a@x.com", "b@x.com"]);
    assert.equal(hiddenCount, 2);
  });

  it("respeita o limiar customizado via 2º parâmetro", () => {
    const ranked = rankEntries([
      entry("a@x.com", 2, 2, "a"),
      entry("b@x.com", 1, 1, "b"),
    ]);
    const { visible, hiddenCount } = partitionLeaderboardForDisplay(ranked, 2);
    assert.deepEqual(visible.map((e) => e.email), ["a@x.com"]);
    assert.equal(hiddenCount, 1);
  });

  it("mantém o RANK original das entries visíveis (não renumera após o corte)", () => {
    const ranked = rankEntries([
      entry("a@x.com", 5, 5, "a"),
      entry("b@x.com", 0, 1, "b"), // cai fora — abre um "buraco" no rank visível
      entry("c@x.com", 3, 4, "c"),
    ]);
    const { visible } = partitionLeaderboardForDisplay(ranked);
    assert.deepEqual(visible.map((e) => e.email), ["a@x.com", "c@x.com"]);
    assert.deepEqual(visible.map((e) => e.rank), [1, 2]); // ranks intactos, sem renumerar
  });

  it("fallback anti-leaderboard-vazio: se NINGUÉM atinge o mínimo, mostra todo mundo (hiddenCount=0)", () => {
    const ranked = rankEntries([
      entry("a@x.com", 1, 1, "a"),
      entry("b@x.com", 0, 2, "b"),
    ]);
    const { visible, hiddenCount } = partitionLeaderboardForDisplay(ranked);
    assert.equal(visible.length, 2, "nenhum corte aplicado — leaderboard vazio seria pior UX");
    assert.equal(hiddenCount, 0);
  });

  it("lista vazia → visible vazio, hiddenCount 0 (sem lançar)", () => {
    const { visible, hiddenCount } = partitionLeaderboardForDisplay([]);
    assert.deepEqual(visible, []);
    assert.equal(hiddenCount, 0);
  });

  it("MIN_ATTEMPTS_FOR_LEADERBOARD_LISTING é o default usado quando minAttempts é omitido", () => {
    const ranked = rankEntries([
      entry("a@x.com", 1, MIN_ATTEMPTS_FOR_LEADERBOARD_LISTING, "a"),
      entry("b@x.com", 0, MIN_ATTEMPTS_FOR_LEADERBOARD_LISTING - 1, "b"),
    ]);
    const { visible, hiddenCount } = partitionLeaderboardForDisplay(ranked);
    assert.deepEqual(visible.map((e) => e.email), ["a@x.com"]);
    assert.equal(hiddenCount, 1);
  });
});
