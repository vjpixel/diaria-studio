/**
 * test/poll-vote-safeparsekv-shape-guard-3355.test.ts
 *
 * Regressão para #3355 (achado de code-review consolidado overnight 260711,
 * mesmo lote do #3350).
 *
 * `safeParseKv<T>` (workers/poll/src/lib.ts) só guarda contra `JSON.parse`
 * que LANÇA (sintaxe inválida) — `T` é apagado em runtime, então um valor de
 * KV que é JSON VÁLIDO mas com shape errado (ex: `{}`, sem os campos
 * numéricos que o tipo declara como obrigatórios) passa incólume pelo
 * `?? {default}` de cada call site (que só entra em ação quando
 * `safeParseKv` retorna `null` — JSON.parse malformado ou chave ausente).
 *
 * Em 3 call sites de `vote.ts` (`updateStatsCounter` fallback KV,
 * `updateScoreByMonth`, `updateScore`) o código fazia `entry.total += 1`
 * (e similares) sem fallback `?? 0`. Se o campo esperado não existisse no
 * objeto parseado, a soma virava `NaN` — `JSON.stringify` serializa `NaN`
 * como `null` ao regravar. O registro "autocura" aritmeticamente no PRÓXIMO
 * voto (`null + 1` coage pra `1` em JS), então o efeito observável é perda
 * SILENCIOSA do contador acumulado (reset pra ~1), nunca um `NaN` que
 * persiste — daí o teste abaixo inspecionar o JSON serializado bruto (não
 * só o valor final, que seria idêntico a um incremento normal a partir de
 * zero) para confirmar que `null` nunca chega a ser escrito.
 *
 * PLAUSIBLE, não CONFIRMED (ver issue): não alcançável hoje via nenhum
 * write-path atual do /vote — requer KV corrompido externamente, edição
 * manual, ou script futuro com bug. Defesa em profundidade.
 *
 * Fix: `?? 0` em todo ponto de aritmética que lê um campo numérico de um
 * objeto vindo de `safeParseKv` nesses 3 call sites.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerDefault from "../workers/poll/src/index.ts";
import { makeTrackedKv, readKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

function voteUrl(email: string, edition: string, choice: "A" | "B"): URL {
  const url = new URL("https://poll.diaria.workers.dev/vote");
  url.searchParams.set("email", email);
  url.searchParams.set("edition", edition);
  url.searchParams.set("choice", choice);
  return url; // sig ausente = merge-tag mode, sem HMAC exigido
}

describe("updateStatsCounter (fallback KV, sem STATS_COUNTER binding) — shape incompleto não produz NaN/null (#3355)", () => {
  it("stats:{edition} = '{}' (JSON válido, campos numéricos ausentes) → total/voted_a/correct_count viram 1/1/1, nunca null", async () => {
    const edition = "260101";
    const kv = makeTrackedKv({
      "stats:260101": "{}", // shape incompleto — nenhum dos 4 campos numéricos presente
    });
    const env = makePollEnv(kv); // sem STATS_COUNTER → fallback KV RMW
    const res = await workerDefault.fetch(
      new Request(voteUrl("shape-guard-stats@x.com", edition, "A").toString()),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);

    const raw = await readKv(kv, "stats:260101");
    assert.doesNotMatch(
      raw,
      /"total":null|"voted_a":null|"voted_b":null|"correct_count":null/,
      `ANTES do fix, campo ausente + "+= 1" produzia NaN → JSON.stringify serializava como null. Raw: ${raw}`,
    );
    const stats = JSON.parse(raw) as { total: number; voted_a: number; voted_b?: number; correct_count?: number };
    assert.equal(stats.total, 1);
    assert.equal(stats.voted_a, 1);
    // voted_b/correct_count nunca são TOCADOS por este voto (choice=A, sem
    // gabarito) — o objeto original ("{}") não tinha essas chaves e o código
    // só as define condicionalmente, então elas ficam ausentes do JSON
    // serializado (não é o bug: `undefined` nunca vira `"null"` no
    // JSON.stringify — só `NaN` vira). Confirma que não viraram NaN/null.
    assert.equal(stats.voted_b, undefined);
    assert.equal(stats.correct_count, undefined);
    assert.equal(Number.isNaN(stats.total), false);
    assert.equal(Number.isNaN(stats.voted_a), false);
  });
});

describe("updateScore — shape incompleto não produz NaN/null no score global (#3355)", () => {
  it("score:{email} sem o campo 'total' (correct/streak presentes) → total vira 1, não null; correct incrementado corretamente", async () => {
    const edition = "260101";
    const email = "shape-guard-score@x.com";
    const kv = makeTrackedKv({
      [`score:${email}`]: JSON.stringify({ correct: 5, streak: 2, last_edition: "251231" }), // 'total' ausente
      [`correct:${edition}`]: "A", // gabarito — voto em A vai bater (correct: true)
    });
    const env = makePollEnv(kv);
    const res = await workerDefault.fetch(
      new Request(voteUrl(email, edition, "A").toString()),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);

    const raw = await readKv(kv, `score:${email}`);
    assert.doesNotMatch(
      raw,
      /"total":null/,
      `ANTES do fix, 'total' ausente + "+= 1" produzia NaN → null serializado. Raw: ${raw}`,
    );
    const score = JSON.parse(raw) as { total: number; correct: number; streak: number };
    assert.equal(score.total, 1, "total ausente tratado como 0, incrementado pra 1 (não NaN/null)");
    assert.equal(score.correct, 6, "correct PRESENTE (5) deve ser preservado e incrementado normalmente — não afetado por total estar ausente");
    assert.equal(score.streak, 3, "streak (comportamento pré-existente, já usava '|| 0') inalterado pelo fix");
  });

  it("score:{email} = '{}' totalmente vazio → nenhum campo numérico vira null", async () => {
    const edition = "260102";
    const email = "shape-guard-score-empty@x.com";
    const kv = makeTrackedKv({
      [`score:${email}`]: "{}",
    });
    const env = makePollEnv(kv);
    const res = await workerDefault.fetch(
      new Request(voteUrl(email, edition, "B").toString()),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);

    const raw = await readKv(kv, `score:${email}`);
    assert.doesNotMatch(raw, /"total":null|"correct":null/, `Raw: ${raw}`);
    const score = JSON.parse(raw) as { total: number };
    assert.equal(score.total, 1);
  });
});

describe("updateScoreByMonth — shape incompleto não produz NaN/null no score-by-month (#3355)", () => {
  it("score-by-month:{mês}:{email} sem 'total'/'correct' → ambos viram 1, não null", async () => {
    const edition = "260101"; // → monthSlug 2026-01
    const email = "shape-guard-month@x.com";
    const kv = makeTrackedKv({
      [`score-by-month:2026-01:${email}`]: JSON.stringify({ last_edition: null, nickname: null }), // sem total/correct
      [`correct:${edition}`]: "A",
    });
    const env = makePollEnv(kv);
    const res = await workerDefault.fetch(
      new Request(voteUrl(email, edition, "A").toString()),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);

    const raw = await readKv(kv, `score-by-month:2026-01:${email}`);
    assert.doesNotMatch(
      raw,
      /"total":null|"correct":null/,
      `ANTES do fix, 'total'/'correct' ausentes + "+= 1" produziam NaN → null serializado. Raw: ${raw}`,
    );
    const entry = JSON.parse(raw) as { total: number; correct: number };
    assert.equal(entry.total, 1);
    assert.equal(entry.correct, 1, "correct=true neste voto (gabarito A, escolha A) — ausente tratado como 0, incrementado pra 1");
  });
});
