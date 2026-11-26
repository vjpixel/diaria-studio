/**
 * test/poll-identify-sync-idempotent-14222.test.ts (#14222)
 *
 * Regressão: o re-sync silencioso do `/jogar/identify` (`name === ""`, uma
 * chamada por rodada jogada, com o MESMO token anônimo) somava o
 * `score:{anonEmail}` INTEIRO a cada vez. Com o anônimo crescendo 1, 2, 3, 4 o
 * `score:{email}` saía 1, 3, 6, 10 (e o mesmo no `score-by-month:`). A
 * migração agora é idempotente: só o delta desde a última migração do par
 * entra (`identify-migrated:{email}:{anonEmail}`, aditivo).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import {
  anonDeltaSinceMigrated,
  handleJogarIdentify,
  identifyMigratedKey,
} from "../workers/poll/src/identify.ts";
import type { Env } from "../workers/poll/src/index.ts";

const ANON = "22222222-2222-4222-8222-222222222222@web.eia.diaria.local";
const EMAIL = "jogador@x.com";
const EDITION = "261126";
const MONTH = "2026-11";

function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return {
    POLL: makeTrackedKv(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
}

let ipCounter = 0;
async function identify(env: Env, name: string, edition: string = EDITION): Promise<Response> {
  // IP distinto por chamada: o teste mede o merge, não o rate limit por IP.
  ipCounter += 1;
  return handleJogarIdentify(
    new Request("https://poll.test/jogar/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.0.0.${ipCounter}` },
      body: JSON.stringify({ name, email: EMAIL, anonEmail: ANON, optin: false, edition }),
    }),
    env,
  );
}

/** Simula `handleVote` creditando mais uma rodada ao token anônimo. */
function setAnon(env: Env & { POLL: ReturnType<typeof makeTrackedKv> }, total: number, correct: number): void {
  env.POLL._map.set(`score:${ANON}`, JSON.stringify({ total, correct, streak: correct, last_edition: EDITION }));
  env.POLL._map.set(
    `score-by-month:${MONTH}:${ANON}`,
    JSON.stringify({ total, correct, last_edition: EDITION, nickname: null, last_vote_ts: `2026-11-26T10:0${total}:00.000Z` }),
  );
}

async function emailScores(env: Env & { POLL: ReturnType<typeof makeTrackedKv> }) {
  const g = JSON.parse((await env.POLL.get(`score:${EMAIL}`))!);
  const m = JSON.parse((await env.POLL.get(`score-by-month:${MONTH}:${EMAIL}`))!);
  return { g, m };
}

describe("anonDeltaSinceMigrated (#14222, pure)", () => {
  it("sem marcador: devolve o anônimo inteiro (1ª migração)", () => {
    const a = { total: 5, correct: 3, streak: 2, last_edition: "261126" };
    assert.deepEqual(anonDeltaSinceMigrated(a, null), a);
  });

  it("com marcador: só a diferença, preservando os campos que não são contadores", () => {
    const a = { total: 4, correct: 3, streak: 3, last_edition: "261126" };
    assert.deepEqual(anonDeltaSinceMigrated(a, { total: 3, correct: 2 }), { total: 1, correct: 1, streak: 3, last_edition: "261126" });
  });

  it("anônimo menor que o já migrado (purge): delta zero, nunca negativo", () => {
    assert.deepEqual(anonDeltaSinceMigrated({ total: 1, correct: 0 }, { total: 5, correct: 4 }), { total: 0, correct: 0 });
  });

  it("incoming null: null", () => {
    assert.equal(anonDeltaSinceMigrated(null, { total: 1, correct: 1 }), null);
  });
});

describe("POST /jogar/identify: re-sync silencioso é idempotente (#14222)", () => {
  it("cenário da issue: anônimo 1, 2, 3, 4 dá score:{email} 1, 2, 3, 4 (global e mensal)", async () => {
    const env = makeEnv();
    setAnon(env, 1, 1);
    assert.equal((await identify(env, "Jogador")).status, 200);
    const seen: Array<[number, number]> = [];
    let s = await emailScores(env);
    seen.push([s.g.total, s.m.total]);

    for (let round = 2; round <= 4; round++) {
      setAnon(env, round, round - 1);
      assert.equal((await identify(env, "")).status, 200);
      s = await emailScores(env);
      seen.push([s.g.total, s.m.total]);
    }

    assert.deepEqual(seen, [[1, 1], [2, 2], [3, 3], [4, 4]], "antes do fix: 1, 3, 6, 10");
    assert.equal(s.g.correct, 3);
    assert.equal(s.m.correct, 3);
    assert.equal(s.g.nickname, "Jogador", "re-sync silencioso preserva o nickname");
    assert.equal(s.m.last_vote_ts, "2026-11-26T10:04:00.000Z", "last_vote_ts segue o voto mais recente");
  });

  it("sync repetido sem rodada nova (recarregar a página) não muda nada", async () => {
    const env = makeEnv();
    setAnon(env, 3, 2);
    await identify(env, "Jogador");
    const before = await emailScores(env);
    for (let i = 0; i < 5; i++) await identify(env, "");
    const after = await emailScores(env);
    assert.equal(after.g.total, before.g.total);
    assert.equal(after.g.correct, before.g.correct);
    assert.equal(after.m.total, before.m.total);
    assert.equal(after.m.correct, before.m.correct);
    assert.equal(after.g.total, 3);
  });

  it("1ª identificação com score anônimo prévio migra o total uma vez e grava o marcador do par", async () => {
    const env = makeEnv();
    setAnon(env, 7, 5);
    await identify(env, "Jogador");
    const s = await emailScores(env);
    assert.equal(s.g.total, 7);
    assert.equal(s.g.correct, 5);
    assert.equal(s.m.total, 7);
    assert.deepEqual(JSON.parse((await env.POLL.get(identifyMigratedKey(EMAIL, ANON)))!), { total: 7, correct: 5 });
    assert.deepEqual(JSON.parse((await env.POLL.get(identifyMigratedKey(EMAIL, ANON, MONTH)))!), { total: 7, correct: 5 });
  });

  it("score:{email} pré-existente de outra origem soma com o anônimo uma vez só", async () => {
    const env = makeEnv({
      [`score:${EMAIL}`]: JSON.stringify({ total: 10, correct: 8, streak: 3, last_edition: "261120", nickname: "Ana" }),
    });
    setAnon(env, 1, 1);
    await identify(env, "");
    await identify(env, "");
    setAnon(env, 2, 2);
    await identify(env, "");
    const g = JSON.parse((await env.POLL.get(`score:${EMAIL}`))!);
    assert.equal(g.total, 12);
    assert.equal(g.correct, 10);
    assert.equal(g.nickname, "Ana");
  });

  it("virada de mês: o marcador mensal é por mês, a 1ª rodada do mês novo entra inteira", async () => {
    const env = makeEnv();
    setAnon(env, 2, 2);
    await identify(env, "Jogador");
    // Mês novo: anônimo global segue cumulativo (3), o mensal de dezembro começa em 1.
    env.POLL._map.set(`score:${ANON}`, JSON.stringify({ total: 3, correct: 3, streak: 3, last_edition: "261201" }));
    env.POLL._map.set(
      `score-by-month:2026-12:${ANON}`,
      JSON.stringify({ total: 1, correct: 1, last_edition: "261201", nickname: null }),
    );
    await identify(env, "", "261201");
    await identify(env, "", "261201");
    const g = JSON.parse((await env.POLL.get(`score:${EMAIL}`))!);
    const dec = JSON.parse((await env.POLL.get(`score-by-month:2026-12:${EMAIL}`))!);
    const nov = JSON.parse((await env.POLL.get(`score-by-month:${MONTH}:${EMAIL}`))!);
    assert.equal(g.total, 3);
    assert.equal(dec.total, 1);
    assert.equal(nov.total, 2, "novembro intocado");
  });
});
