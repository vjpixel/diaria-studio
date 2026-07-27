/**
 * test/poll-admin-correct-brand-format-guard-4157.test.ts (#4157)
 *
 * `handleAdminCorrect` (POST /admin/correct) grava `correct:{edition}` — o
 * gabarito, chave CRUA/compartilhada entre brands (#4038/#4118). O `?brand=`
 * existia, entre outras razões, pra isolar o gabarito da MENSAL (brand
 * `clarice`, ciclo `YYMM-MM`) do da DIÁRIA (identificador `AAMMDD`) — mas o
 * #4038 tornou a escrita incondicionalmente crua sem repor esse isolamento.
 *
 * CENÁRIO DE FALHA (issue #4157): `close-poll.ts --brand clarice --edition
 * 260531 --answer B` — forma que o script ainda aceita e documenta (AAMMDD
 * legado do ciclo mensal, ver `legacyMonthlyEditionForCycle("2605-06") ===
 * "260531"`) — grava `correct:260531`, que também É a chave do gabarito da
 * edição DIÁRIA de 31/05. O backfill de scores roda só sobre
 * `clarice:vote:260531:*`, deixando `vote:260531:*` (diária) pontuado contra
 * o gabarito errado sem nenhum sinal de erro.
 *
 * FIX: guard em `handleAdminCorrect` (depois da verificação de HMAC) —
 * rejeita com 400 quando `AAMMDD_RE.test(edition)` E o brand é anual
 * (`BRAND_INFO[brand].leaderboardPeriod === "year"`, hoje só `clarice`).
 * Guard vale SÓ pra ESCRITA aqui — a leitura de gabaritos legados sob AAMMDD
 * (`correct:{AAMMDD}` como fallback de ciclo, `getSummedEditionStats`/
 * `legacyMonthlyEditionForCycle`, já coberta em
 * poll-stats-legacy-cycle-3261.test.ts) não é tocada — o último teste deste
 * arquivo confirma isso explicitamente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { hmacSign, type Env } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

async function postAdminCorrect(
  env: Env,
  edition: string,
  answer: string,
  brand?: string,
): Promise<Response> {
  const sig = await hmacSign(env.ADMIN_SECRET, `${brand ?? "diaria"}:${edition}:${answer}`);
  const brandQ = brand ? `&brand=${brand}` : "";
  const req = new Request(
    `https://poll.test/admin/correct?edition=${edition}&answer=${answer}&sig=${encodeURIComponent(sig)}${brandQ}`,
    { method: "POST" },
  );
  return worker.fetch(req, env, {} as ExecutionContext);
}

describe("handleAdminCorrect — guard de isolação brand×formato (#4157)", () => {
  it("--brand clarice --edition {AAMMDD} é recusado com erro claro (400), correct:{edition} NÃO é escrito", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const res = await postAdminCorrect(env, "260531", "B", "clarice");
    assert.equal(res.status, 400, "combinação clarice (anual) + AAMMDD deve ser rejeitada");
    const body = await res.json() as { error?: string };
    assert.match(body.error ?? "", /AAMMDD|formato|ciclo/i, "erro deve explicar o problema de formato, não um 500/403 genérico");
    assert.equal(await kv.get("correct:260531"), null, "gabarito da diária de 31/05 não deve ser sobrescrito");
  });

  it("--brand clarice --edition {YYMM-MM} continua funcionando (200), grava correct:{ciclo}", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const res = await postAdminCorrect(env, "2605-06", "B", "clarice");
    assert.equal(res.status, 200, "formato de ciclo é o caminho correto pra brand anual — não deve ser bloqueado");
    assert.equal(await kv.get("correct:2605-06"), "B");
  });

  it("--brand diaria --edition {AAMMDD} continua funcionando (200) — caso normal, não afetado pelo guard", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const res = await postAdminCorrect(env, "260531", "B"); // sem --brand === diaria (leaderboardPeriod "month")
    assert.equal(res.status, 200);
    assert.equal(await kv.get("correct:260531"), "B");
  });

  it("--brand web --edition {AAMMDD} continua funcionando (200) — web também é 'month', não 'year'", async () => {
    // #3516: brand "web" (jogo standalone) também usa AAMMDD e leaderboardPeriod
    // "month" — o guard é sobre leaderboardPeriod==="year", não uma allowlist
    // de brand hardcoded, então "web" não deve ser afetado.
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const res = await postAdminCorrect(env, "260531", "A", "web");
    assert.equal(res.status, 200);
    assert.equal(await kv.get("correct:260531"), "A");
  });

  it("guard roda DEPOIS da verificação de sig — sig inválido continua 403, não vaza pra 400 do guard", async () => {
    const kv = makeTrackedKv();
    const env = makePollEnv(kv);
    const badSig = await hmacSign("wrong-secret", "clarice:260531:B");
    const req = new Request(
      `https://poll.test/admin/correct?edition=260531&answer=B&sig=${badSig}&brand=clarice`,
      { method: "POST" },
    );
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    assert.equal(res.status, 403, "sig inválido deve continuar 403 (autenticação antes do guard de formato)");
  });

  it("leitura de gabarito legado clarice sob AAMMDD continua funcionando — guard é só de ESCRITA", async () => {
    // Reproduz o fallback já coberto em poll-stats-legacy-cycle-3261.test.ts:
    // um voto do ciclo 2605-06 gravado ANTES do cutover #2115 só existe sob a
    // chave AAMMDD legada (260531) — correct:{AAMMDD} é a chave CRUA (#4118),
    // nunca escrita pelo guard novo (que só existe em handleAdminCorrect).
    const kv = makeTrackedKv({
      "clarice:stats:260531": JSON.stringify({ total: 32, voted_a: 14, voted_b: 18, correct_count: 18 }),
      "correct:260531": "B",
    });
    const env = makePollEnv(kv);
    const res = await worker.fetch(
      new Request("https://poll.test/stats?edition=2605-06&brand=clarice"),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { correct_answer: string | null; total: number };
    assert.equal(body.correct_answer, "B", "leitura do gabarito legado sob AAMMDD não deve ser afetada pelo guard de escrita");
    assert.equal(body.total, 32);
  });
});
