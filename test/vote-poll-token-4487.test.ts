/**
 * test/vote-poll-token-4487.test.ts (#4487)
 *
 * Cobertura do fix "token opaco nos links de voto do É IA?" — item de maior
 * impacto do critério de pronto da #4487 ("dado errado entrando no
 * leaderboard, não só clareza"). Confere que `handleVote` (workers/poll/src/vote.ts)
 * resolve `{token}@vote.eia.diaria.local` de volta pro e-mail real via KV
 * ANTES de qualquer lógica de score/dedup/nickname — e que o e-mail cru
 * continua funcionando (backward compat, ninguém perde streak/score na
 * transição).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/poll/src/index.ts";
import { handleVote } from "../workers/poll/src/index.ts";
import { computePollToken, pollTokenKvKey, VOTE_TOKEN_DOMAIN } from "../workers/poll/src/poll-token.ts";
import { makeTrackedKv, readKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

const SECRET = "test-secret"; // mesmo default de makePollEnv
const EDITION = "260801";
const REAL_EMAIL = "leitor@example.com";

describe("#4487 — handleVote resolve token opaco de voto via KV", () => {
  it("GET /vote com email={token}@vote.eia.diaria.local resolvido no KV grava o voto sob o E-MAIL REAL", async () => {
    const token = await computePollToken(SECRET, REAL_EMAIL);
    const kv = makeTrackedKv({ [pollTokenKvKey(token)]: REAL_EMAIL });
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${token}@${VOTE_TOKEN_DOMAIN}&edition=${EDITION}&choice=A`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const voteRaw = await readKv(kv, `vote:${EDITION}:${REAL_EMAIL}`);
    const vote = JSON.parse(voteRaw);
    assert.equal(vote.choice, "A");
    // Nenhum registro deveria existir sob o pseudo-email — a identidade real
    // é sempre a chave canônica a partir da resolução.
    assert.equal(await kv.get(`vote:${EDITION}:${token}@${VOTE_TOKEN_DOMAIN}`), null);
  });

  it("token sem entrada no KV (nunca injetado / secret rotacionado) → 400, nenhum voto gravado", async () => {
    const bogusToken = "0".repeat(24);
    const kv = makeTrackedKv(); // KV vazio — token não resolve
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${bogusToken}@${VOTE_TOKEN_DOMAIN}&edition=${EDITION}&choice=A`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 400, "token não-resolvido deve falhar fail-closed, nunca fail-open pra um email arbitrário");
    assert.equal(kv.puts.some((p) => p.key.startsWith("vote:")), false, "nenhum voto deve ser gravado com token não-resolvido");
  });

  it("e-mail cru continua funcionando normalmente (regressão — não quebra quem ainda não foi migrado / esp brevo)", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${REAL_EMAIL}&edition=${EDITION}&choice=B`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const voteRaw = await readKv(kv, `vote:${EDITION}:${REAL_EMAIL}`);
    assert.equal(JSON.parse(voteRaw).choice, "B");
  });

  it("preserva score/streak existente do assinante — voto via token atualiza o MESMO score:{email}, não cria um registro novo sob o token", async () => {
    const token = await computePollToken(SECRET, REAL_EMAIL);
    const existingScore = JSON.stringify({ correct: 5, total: 7, streak: 3, nickname: "Leitor Fiel" });
    const kv = makeTrackedKv({
      [pollTokenKvKey(token)]: REAL_EMAIL,
      [`score:${REAL_EMAIL}`]: existingScore,
    });
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${token}@${VOTE_TOKEN_DOMAIN}&edition=${EDITION}&choice=A`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const scoreAfterRaw = await readKv(kv, `score:${REAL_EMAIL}`);
    const scoreAfter = JSON.parse(scoreAfterRaw);
    assert.equal(scoreAfter.total, 8, "total incrementado no MESMO registro (histórico preservado, não resetado)");
    assert.equal(scoreAfter.nickname, "Leitor Fiel", "nickname pré-existente sobrevive à resolução do token");
    assert.equal(await kv.get(`score:${token}@${VOTE_TOKEN_DOMAIN}`), null, "nenhum registro paralelo deve existir sob o pseudo-email");
  });

  it("chamada direta de handleVote (sem passar pelo router) também resolve o token", async () => {
    const token = await computePollToken(SECRET, REAL_EMAIL);
    const kv = makeTrackedKv({ [pollTokenKvKey(token)]: REAL_EMAIL });
    const env = makePollEnv(kv);
    const url = new URL(`https://poll.test/vote?email=${token}@${VOTE_TOKEN_DOMAIN}&edition=${EDITION}&choice=A`);
    const res = await handleVote(url, env, "diaria", env);
    assert.equal(res.status, 200);
    assert.ok(await kv.get(`vote:${EDITION}:${REAL_EMAIL}`));
  });

  it("guard do domínio anônimo web (#3976/#4011) continua intocado — token válido sob vote.eia.diaria.local nunca é confundido com web.eia.diaria.local", async () => {
    // Um pseudo-email do brand web (domínio DIFERENTE) continua exigindo
    // isValidWebToken/brand==="web" — este teste garante que o novo domínio
    // reservado não abriu um buraco no guard existente do outro domínio.
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=not-a-real-uuid@web.eia.diaria.local&edition=${EDITION}&choice=A`),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 400, "domínio anônimo web com token malformado continua rejeitado pelo guard #3976/#4011");
  });
});
