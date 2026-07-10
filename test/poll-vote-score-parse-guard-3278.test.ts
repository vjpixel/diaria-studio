/**
 * test/poll-vote-score-parse-guard-3278.test.ts
 *
 * Regressão para #3278 (achado de code-review consolidado overnight 260710).
 *
 * `buildAlreadyVotedResponse()` (`workers/poll/src/vote.ts`) guarda
 * `JSON.parse(existingFromKv)` com try/catch (endurecido em #3118 item 4) —
 * mas deixava `JSON.parse(prevScoreRaw)` (2 linhas abaixo, mesma classe de
 * dado: blob JSON gravado em KV via `env.POLL.put(scoreKey, ...)`)
 * DESGUARDADO. `index.ts`'s `fetch()` não tem try/catch de topo nem
 * `passThroughOnException()` — um throw não capturado aqui vira 500 pro
 * leitor que só está reabrindo o link de "já votou" (nem sequer é um voto
 * novo sendo lançado) quando `score:{email}` está corrompido no KV.
 *
 * Fix: mesmo padrão do parse irmão — try/catch, log estruturado, fallback
 * para "sem score" (nickname form reoferecido, igual ao caso em que
 * score:{email} nunca foi gravado).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAlreadyVotedResponse } from "../workers/poll/src/vote.ts";
import type { Env } from "../workers/poll/src/index.ts";
import workerDefault from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

function scoreOnlyEnv(scoreRaw: string | null = null): Env {
  return {
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
    POLL: { get: async () => scoreRaw } as unknown as KVNamespace,
  } as unknown as Env;
}

describe("buildAlreadyVotedResponse — guard de JSON.parse(prevScoreRaw) corrompido (#3278)", () => {
  it("score:{email} corrompido não lança — cai no fallback 'sem score' (200, não 500)", async () => {
    let res: Response;
    try {
      res = await buildAlreadyVotedResponse(
        scoreOnlyEnv("{not valid json"),
        "diaria",
        "260701",
        "user@x.com",
        JSON.stringify({ choice: "A" }),
      );
    } catch (e) {
      assert.fail(`não deve lançar em score:{email} corrompido: ${String(e)}`);
      return;
    }
    assert.equal(res.status, 200);
  });

  it("score:{email} corrompido → trata como 'sem score' e reoferece o form de nickname", async () => {
    const res = await buildAlreadyVotedResponse(
      scoreOnlyEnv("{not valid json"),
      "diaria",
      "260701",
      "user@x.com",
      JSON.stringify({ choice: "A" }),
    );
    const html = await res.text();
    assert.match(
      html,
      /action="\/set-name"/,
      "corrompido deve se comportar como score ausente (oferece form) — pior caso é reoferecer, nunca 500",
    );
  });

  it("score:{email} válido com nickname → NÃO reoferece o form (comportamento pré-existente inalterado)", async () => {
    const res = await buildAlreadyVotedResponse(
      scoreOnlyEnv(JSON.stringify({ total: 3, nickname: "Já Tenho" })),
      "diaria",
      "260701",
      "user@x.com",
      JSON.stringify({ choice: "A" }),
    );
    const html = await res.text();
    assert.doesNotMatch(html, /action="\/set-name"/);
  });

  it("score:{email} ausente (null) → mesmo fallback do corrompido (oferece form, 200)", async () => {
    const res = await buildAlreadyVotedResponse(
      scoreOnlyEnv(null),
      "diaria",
      "260701",
      "user@x.com",
      JSON.stringify({ choice: "A" }),
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /action="\/set-name"/);
  });
});

describe("integração — reabrir link de voto duplicado com score:{email} corrompido não derruba o request (#3278)", () => {
  it("existingFromKv válido + score:{email} corrompido no fallback KV (sem VOTE_DEDUP) → 200 'já votou', não 500", async () => {
    const kv = makeTrackedKv({
      "vote:260701:corrupt-score@x.com": JSON.stringify({ choice: "A", ts: new Date().toISOString(), correct: null }),
      "score:corrupt-score@x.com": "{not valid json at all",
    });
    const env = makePollEnv(kv); // sem VOTE_DEDUP → fallback KV (mesmo caminho do #3118 item 4)
    const url = new URL("https://poll.diaria.workers.dev/vote");
    url.searchParams.set("email", "corrupt-score@x.com");
    url.searchParams.set("edition", "260701");
    url.searchParams.set("choice", "A");
    const res = await workerDefault.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "score:{email} corrompido não deve derrubar o leitor que reabre o link com 500");
    const html = await res.text();
    assert.match(html, /já votou/i);
  });
});
