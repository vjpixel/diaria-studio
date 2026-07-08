/**
 * test/poll-podium-medal-gate-3113.test.ts (#3113 item 12)
 *
 * Regressão: pódio degenerado no ranking anual do jogo "É IA?". O tiebreak
 * "mais tentativas vence" (#1163) ordena por (correct DESC, total DESC) — com
 * poucas edições/participantes, isso podia dar 🥉 pra alguém com 0 acertos
 * (0/2 rankeia ACIMA de 0/1, e ambos acima de "sem votos"). Gate: medalha
 * (glifo 🥇🥈🥉) exige `correct >= 1`; sem isso, mostra rank numérico ("N.")
 * ou (no caso de `computePodium`) fica de fora do pódio inteiramente, dando
 * lugar ao próximo candidato elegível.
 *
 * Cobre os 3 pontos onde medalha é atribuída: `rankEntries` (leaderboard.ts,
 * usada no HTML de `/leaderboard*`), `computePodium` (o "campeão do mês" da
 * newsletter/callout), e `handleLeaderboardByMonthJson` (endpoint `.json`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankEntries, type LeaderboardEntry } from "../workers/poll/src/leaderboard.ts";
import { computePodium, handleLeaderboardByMonthJson } from "../workers/poll/src/leaderboard-routes.ts";
import type { Env } from "../workers/poll/src/index.ts";

function entry(email: string, correct: number, total: number, nickname: string | null = null): LeaderboardEntry {
  return { email, nickname, correct, total, pct: total > 0 ? Math.round((correct / total) * 100) : 0, streak: 0 };
}

describe("rankEntries — medalha exige correct >= 1 (#3113 item 12)", () => {
  it("0 acertos com mais tentativas (0/2) rankeia acima de 0/1, mas NÃO ganha medalha", () => {
    const ranked = rankEntries([
      entry("zero2@x.com", 0, 2, "zero2"),
      entry("zero1@x.com", 0, 1, "zero1"),
    ]);
    // Ordem preservada (0/2 > 0/1 no critério de participação, #1163).
    assert.equal(ranked[0].email, "zero2@x.com");
    assert.equal(ranked[0].rank, 1);
    // Mas SEM acerto nenhum, rank 1 não ganha 🥇 — vira "1." mesmo.
    assert.equal(ranked[0].medal, "1.");
    assert.equal(ranked[1].medal, "2.");
  });

  it("com pelo menos 1 acerto, medalha normal nos ranks 1-3", () => {
    const ranked = rankEntries([
      entry("um@x.com", 1, 3, "um"),
      entry("dois@x.com", 0, 5, "dois"), // 0 acertos mas MUITAS tentativas
    ]);
    // "um" tem correct=1 > 0 de "dois" → correct DESC vence, "um" fica rank 1.
    assert.equal(ranked[0].email, "um@x.com");
    assert.equal(ranked[0].medal, "🥇");
    assert.equal(ranked[1].email, "dois@x.com");
    assert.equal(ranked[1].medal, "2.", "0 acertos no rank 2 não ganha 🥈");
  });

  it("misto: 1º e 2º com acerto ganham medalha, 3º com 0 acertos não ganha (mesmo em rank 3)", () => {
    const ranked = rankEntries([
      entry("gold@x.com", 3, 3, "gold"),
      entry("silver@x.com", 2, 3, "silver"),
      entry("zero@x.com", 0, 10, "zero"), // rank 3 só por volume de tentativas
    ]);
    assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3]);
    assert.equal(ranked[0].medal, "🥇");
    assert.equal(ranked[1].medal, "🥈");
    assert.equal(ranked[2].medal, "3.", "rank 3 com 0 acertos não é 🥉");
  });

  it("empate em (correct=0, total) some ainda respeita dense rank, mas nenhum ganha medalha", () => {
    const ranked = rankEntries([
      entry("a@x.com", 0, 2, "a"),
      entry("b@x.com", 0, 2, "b"),
    ]);
    assert.deepEqual(ranked.map((r) => r.rank), [1, 1]);
    assert.deepEqual(ranked.map((r) => r.medal), ["1.", "1."]);
  });
});

describe("computePodium — exclui candidatos com 0 acertos do pódio (#3113 item 12)", () => {
  it("candidato com 0 acertos e mais tentativas NÃO aparece no pódio — próximo elegível sobe", () => {
    const podium = computePodium([
      { email: "zero@x.com", nickname: "zero", correct: 0, total: 5 },
      { email: "one@x.com", nickname: "one", correct: 1, total: 1 },
    ]);
    assert.deepEqual(podium, [{ nickname: "one", rank: 1 }]);
  });

  it("só 0-acertos disponíveis → pódio vazio (não degenera pra alguém sem nenhum acerto)", () => {
    const podium = computePodium([
      { email: "a@x.com", nickname: "a", correct: 0, total: 3 },
      { email: "b@x.com", nickname: "b", correct: 0, total: 1 },
    ]);
    assert.deepEqual(podium, []);
  });

  it("3 elegíveis (correct >= 1) preenchem o pódio normalmente", () => {
    const podium = computePodium([
      { email: "g@x.com", nickname: "gold", correct: 3, total: 3 },
      { email: "s@x.com", nickname: "silver", correct: 2, total: 3 },
      { email: "b@x.com", nickname: "bronze", correct: 1, total: 3 },
      { email: "z@x.com", nickname: "zero", correct: 0, total: 10 },
    ]);
    assert.deepEqual(
      podium.map((p) => p.nickname),
      ["gold", "silver", "bronze"],
    );
  });
});

// ── handleLeaderboardByMonthJson — mesmo gate no endpoint .json ────────────

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data: Record<string, string> = { ...seed };
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Object.keys(data).filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function makeEnv(seed: Record<string, string> = {}): Env {
  return { POLL: makeKv(seed), POLL_SECRET: "test-secret", ADMIN_SECRET: "test-admin", ALLOWED_ORIGINS: "*" };
}

describe("handleLeaderboardByMonthJson — mesmo gate de medalha (#3113 item 12)", () => {
  it("entry com 0 acertos em rank <= 3 recebe medal: '' (não emoji)", async () => {
    const snapshot = {
      entries: [
        { email: "zero@x.com", nickname: "zero", correct: 0, total: 5 },
        { email: "one@x.com", nickname: "one", correct: 1, total: 1 },
      ],
      computed_at: new Date().toISOString(),
    };
    const env = makeEnv({ "leaderboard-snapshot:2026-05": JSON.stringify(snapshot) });
    const res = await handleLeaderboardByMonthJson("2026-05", env, "diaria");
    const body = await res.json() as { entries: Array<{ rank: number; medal: string; nickname: string }> };
    const zero = body.entries.find((e) => e.nickname === "zero")!;
    const one = body.entries.find((e) => e.nickname === "one")!;
    assert.equal(one.medal, "🥇");
    assert.equal(zero.medal, "", "0 acertos não deve ter medal, mesmo em rank <= 3");
  });
});
