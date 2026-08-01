/**
 * test/poll-vote-archive-brand-format-guard-4435.test.ts (#4435)
 *
 * `handleArchiveVotePage` (GET /leaderboard/{YYYY}/arquivo/{edition}) e
 * `handleVote` (GET /vote) usam `isValidVoteEditionFormat` (lib.ts) pra
 * validar `edition` — mas essa função só checa FORMATO (AAMMDD ou ciclo
 * `YYMM-MM`, #4419), nunca FORMATO×MARCA. `BRAND_INFO[brand].leaderboardPeriod`
 * é quem decide se uma marca opera em ciclo mensal (`"year"`, só `clarice`
 * hoje) ou não (`"month"`, diaria/web) — e nenhum dos 2 handlers checava essa
 * combinação antes deste fix.
 *
 * CENÁRIO DE FALHA (achado pr-test-analyzer do review pré-merge do #4419,
 * verificado ao vivo pelo revisor): `handleArchiveVotePage("2026", "2605-06",
 * env, "diaria")` respondia 200 — renderizava a página de voto com branding
 * "Diar.ia" mas descrevendo "leaderboard anual" (que a diaria não tem, o
 * período dela é "month"). Um `GET /vote?...&edition=2605-06&choice=A`
 * subsequente sem `brand=` (default diaria) também passava pelo pipeline de
 * voto completo, gravando `vote:2605-06:{email}` — chave que não deveria
 * existir pra essa marca.
 *
 * FIX (espelha o guard de ESCRITA #4157 em handleAdminCorrect/index.ts, ver
 * test/poll-admin-correct-brand-format-guard-4157.test.ts): ambos os
 * handlers agora rejeitam a combinação `CYCLE_EDITION_RE.test(edition) &&
 * BRAND_INFO[brand].leaderboardPeriod !== "year"` — `handleArchiveVotePage`
 * com 404 (mesma resposta de "edição não existe" já usada pra formato/ano
 * inválido), `handleVote` com 400 (mesma resposta de "parâmetros ausentes"
 * já usada pra formato inválido). O caminho inverso (AAMMDD pra brand anual —
 * marcador legado do cutover #2115) continua aceito de propósito — os 2
 * últimos testes deste arquivo confirmam isso explicitamente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/poll/src/index.ts";
import { handleArchiveVotePage, handleVote } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

describe("handleArchiveVotePage — guard de isolação brand×formato (#4435)", () => {
  it("ciclo (YYMM-MM) + brand diaria (default, sem ?brand=) é recusado com 404", async () => {
    const kv = makeTrackedKv({ "correct:2605-06": "A" }); // gabarito presente — isola o guard, não o caso "sem gabarito"
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.test/leaderboard/2026/arquivo/2605-06"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 404, "brand diaria (leaderboardPeriod month) não deve aceitar formato de ciclo");
  });

  it("ciclo (YYMM-MM) + brand=web explícito é recusado com 404 (web também é 'month')", async () => {
    const kv = makeTrackedKv({ "correct:2605-06": "A" });
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.test/leaderboard/2026/arquivo/2605-06?brand=web"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 404, "guard é sobre leaderboardPeriod, não allowlist de brand — 'web' também deve ser bloqueado");
  });

  it("chamada direta com brand='diaria' e edition de ciclo → 404 (mesmo com gabarito gravado)", async () => {
    const env = makePollEnv(makeTrackedKv({ "correct:2605-06": "A" }));
    const res = await handleArchiveVotePage("2026", "2605-06", env, "diaria");
    assert.equal(res.status, 404);
  });

  it("ciclo (YYMM-MM) + brand=clarice continua funcionando (200) — caminho legítimo, não afetado pelo guard", async () => {
    const kv = makeTrackedKv({ "correct:2605-06": "A" });
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.test/leaderboard/2026/arquivo/2605-06?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200, "clarice (leaderboardPeriod year) é o único brand que usa formato de ciclo — não deve ser bloqueado");
  });

  it("AAMMDD (marcador legado) + brand=clarice continua funcionando (200) — caminho inverso NÃO é bloqueado", async () => {
    // #4419: um ciclo pré-cutover (#2115) pode ter o gabarito só sob a chave
    // legada AAMMDD — handleArchiveVotePage aceita esse marcador legado
    // normalmente pra brand anual. O guard novo é assimétrico de propósito:
    // só rejeita ciclo-pra-marca-mensal, nunca AAMMDD-pra-marca-anual.
    const kv = makeTrackedKv({ "correct:260531": "B" });
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.test/leaderboard/2026/arquivo/260531?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200, "AAMMDD legado pra brand anual é o caminho legítimo pré-existente — guard não deve tocar nele");
  });
});

describe("handleVote — guard de isolação brand×formato (#4435)", () => {
  it("GET /vote com edition de ciclo, sem ?brand= (default diaria) → 400, nenhuma chave 'vote:' gravada", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.test/vote?email=leitor@example.com&edition=2605-06&choice=A"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 400, "brand diaria (leaderboardPeriod month) não deve aceitar edition em formato de ciclo");
    assert.equal(await kv.get("vote:2605-06:leitor@example.com"), null, "voto não deve ser gravado sob um namespace que não deveria existir pra essa marca");
  });

  it("GET /vote com edition de ciclo, brand=web explícito → 400 (web também é 'month')", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.test/vote?email=leitor@example.com&edition=2605-06&choice=A&brand=web"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 400);
  });

  it("chamada direta de handleVote com brand='diaria' e edition de ciclo → 400", async () => {
    const env = makePollEnv(makeTrackedKv());
    const url = new URL("https://poll.test/vote?email=leitor@example.com&edition=2605-06&choice=A");
    const res = await handleVote(url, env, "diaria", env);
    assert.equal(res.status, 400);
  });

  it("GET /vote com edition de ciclo, brand=clarice continua funcionando (200) — caminho legítimo, não afetado pelo guard", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.test/vote?email=leitor@example.com&edition=2605-06&choice=A&brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200, "clarice (leaderboardPeriod year) é o único brand que usa formato de ciclo — não deve ser bloqueado");
    assert.ok(await kv.get("clarice:vote:2605-06:leitor@example.com"), "voto deve ser gravado normalmente sob o namespace branded da clarice");
  });

  it("GET /vote com edition AAMMDD (marcador legado), brand=clarice continua funcionando (200) — caminho inverso não é bloqueado", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.test/vote?email=leitor@example.com&edition=260531&choice=A&brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200, "AAMMDD pra brand anual é o caminho legado pré-existente — guard não deve tocar nele");
  });

  it("GET /vote com edition AAMMDD, brand diaria (caso normal) continua funcionando (200) — regressão", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.test/vote?email=leitor@example.com&edition=260531&choice=A"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
  });
});
