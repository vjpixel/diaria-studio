/**
 * test/poll-stats-legacy-cycle-3261.test.ts (#3261)
 *
 * BUG: dashboard mensal (aba Engajamento — É IA?) só mostrava o ciclo
 * corrente (`2606-07`) — ciclos anteriores (`2603-04`, `2604-05`, `2605-06`)
 * não apareciam mesmo tendo votos reais confirmados via `/leaderboard`.
 *
 * ROOT CAUSE (confirmado lendo `handleStats` em workers/poll/src/vote.ts):
 * `/stats?edition=X` fazia lookup EXATO por `stats:{X}`/`correct:{X}` — sem
 * NENHUM fallback de formato. O formato de ciclo `YYMM-MM` (ex: `2605-06`)
 * só existe desde #2115 (commit 370fba43, 2026-06-11). Ciclos enviados ANTES
 * do cutover gravaram seus votos sob o identificador AAMMDD LEGADO
 * (`eiaEditionFromYymm` pré-#2115: YY+MM+últimoDiaDoMês do conteúdo) — a
 * ÚNICA forma que existia então. `editionToMonthSlug` (usado pelo leaderboard
 * anual) já normalizava AMBOS os formatos pro mesmo slug de mês; `/stats`
 * não tinha esse fallback.
 *
 * Confirmado ao vivo (260711) via curl contra o worker de produção:
 *   /stats?edition=260531&brand=clarice  → {total:32, voted_a:14, voted_b:18,
 *                                            correct_answer:"B", correct_count:18}
 *   /stats?edition=2605-06&brand=clarice → {total:0, ...}  (mesmos votos, invisíveis)
 * Os 32 votos de "2605-06" (digest de maio, enviado em junho) existem de fato,
 * mas só sob a chave legada `260531` — a fórmula antiga (YY=26, MM=05,
 * últimoDiaDoMês(maio)=31) reproduzida em `legacyMonthlyEditionForCycle`.
 *
 * NOTA DE ESCOPO (achado da investigação, não assumido de antemão): dos 3
 * ciclos citados na issue, só `2605-06` tem votos REALMENTE recuperáveis.
 * `/stats?edition=260430&brand=clarice` (2604-05) e `/stats?edition=260331
 * &brand=clarice` (2603-04) retornam total:0 tanto no formato novo quanto no
 * legado, e `/leaderboard/2026-03.json`/`2026-04.json?brand=clarice` (que
 * agrega por mês de CONTEÚDO, formato-agnóstico) também retornam `entries:
 * []` — zero votos em QUALQUER chave. Consistente com a feature de voto É
 * IA? mensal (commit beb7df9b) ter sido lançada em 2026-05-06, DEPOIS do
 * envio dos digests de março e abril. O fix abaixo generaliza para qualquer
 * ciclo com essa ambiguidade (não hardcoded pros 3 da issue) — cobre
 * `2605-06` de fato, e automaticamente cobriria `2603-04`/`2604-05` também
 * SE eles algum dia tivessem dados sob a chave legada (não têm).
 *
 * FIX: `handleStats` agora consulta, além da `edition` pedida, a chave AAMMDD
 * legada equivalente (quando `edition` é formato de ciclo) via
 * `legacyMonthlyEditionForCycle`, e SOMA os dois resultados
 * (`sumStatsCounterData`) — generaliza para qualquer ciclo futuro com a
 * mesma ambiguidade, sem hardcode.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  legacyMonthlyEditionForCycle,
  editionToMonthSlug,
} from "../workers/poll/src/lib.ts";
import { sumStatsCounterData, handleStats } from "../workers/poll/src/vote.ts";
import type { StatsCounterData } from "../workers/poll/src/stats-counter.ts";
import type { Env } from "../workers/poll/src/index.ts";
import worker from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

// ── 1. legacyMonthlyEditionForCycle — pure ──────────────────────────────────

describe("legacyMonthlyEditionForCycle (#3261)", () => {
  it("2605-06 (digest de maio, enviado em junho) → 260531 (último dia de maio)", () => {
    assert.equal(legacyMonthlyEditionForCycle("2605-06"), "260531");
  });

  it("2604-05 (digest de abril) → 260430 (abril tem 30 dias)", () => {
    assert.equal(legacyMonthlyEditionForCycle("2604-05"), "260430");
  });

  it("2603-04 (digest de março) → 260331 (março tem 31 dias)", () => {
    assert.equal(legacyMonthlyEditionForCycle("2603-04"), "260331");
  });

  it("2606-07 (ciclo corrente, junho) → 260630 (junho tem 30 dias)", () => {
    assert.equal(legacyMonthlyEditionForCycle("2606-07"), "260630");
  });

  it("2612-01 (digest de dezembro, virada de ano) → 261231", () => {
    assert.equal(legacyMonthlyEditionForCycle("2612-01"), "261231");
  });

  it("edition já em formato AAMMDD (diária) → null (não precisa de fallback)", () => {
    assert.equal(legacyMonthlyEditionForCycle("260531"), null);
  });

  it("mês de conteúdo inválido (00 ou >12) → null", () => {
    assert.equal(legacyMonthlyEditionForCycle("2600-01"), null);
    assert.equal(legacyMonthlyEditionForCycle("2613-01"), null);
  });

  it("formato lixo → null", () => {
    assert.equal(legacyMonthlyEditionForCycle(""), null);
    assert.equal(legacyMonthlyEditionForCycle("abc-de"), null);
    assert.equal(legacyMonthlyEditionForCycle("2605-6"), null);
    assert.equal(legacyMonthlyEditionForCycle("26050-6"), null);
  });

  it("consistência com editionToMonthSlug: ciclo e seu legado apontam pro MESMO mês (conteúdo)", () => {
    for (const cycle of ["2603-04", "2604-05", "2605-06", "2606-07"]) {
      const legacy = legacyMonthlyEditionForCycle(cycle);
      assert.ok(legacy, `${cycle} deve ter um legado`);
      assert.equal(
        editionToMonthSlug(cycle),
        editionToMonthSlug(legacy!),
        `${cycle} e seu legado ${legacy} devem mapear pro mesmo slug de mês`,
      );
    }
  });
});

// ── 2. sumStatsCounterData — pure ───────────────────────────────────────────

describe("sumStatsCounterData (#3261)", () => {
  it("soma dois StatsCounterData campo a campo", () => {
    const a: StatsCounterData = { total: 32, voted_a: 14, voted_b: 18, correct_count: 18 };
    const b: StatsCounterData = { total: 12, voted_a: 3, voted_b: 9, correct_count: 9 };
    assert.deepEqual(sumStatsCounterData(a, b), { total: 44, voted_a: 17, voted_b: 27, correct_count: 27 });
  });

  it("b === null → retorna a intacto (edition sem par legado, ou par sem dados)", () => {
    const a: StatsCounterData = { total: 5, voted_a: 2, voted_b: 3, correct_count: 1 };
    assert.deepEqual(sumStatsCounterData(a, null), a);
  });

  it("ambos zero → soma zero (não é falso-positivo)", () => {
    const zero: StatsCounterData = { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };
    assert.deepEqual(sumStatsCounterData(zero, zero), zero);
  });
});

// ── 3. handleStats/router — integração end-to-end (regressão central) ──────

describe("handleStats: /stats?edition={ciclo} também acha votos sob a chave AAMMDD legada (#3261)", () => {
  it("REGRESSÃO EXATA: 32 votos gravados só sob 260531 (legado) aparecem ao consultar 2605-06 (ciclo novo)", async () => {
    // Reproduz o cenário real confirmado em produção (260711): votos do
    // digest de maio (ciclo 2605-06) foram gravados ANTES do cutover #2115
    // — só existem sob a chave legada 260531. env.POLL é o KV CRU (como
    // brandedEnv embrulharia em index.ts) — chaves clarice precisam do
    // prefixo "clarice:" aplicado manualmente no fixture.
    const kv = makeTrackedKv({
      "clarice:stats:260531": JSON.stringify({ total: 32, voted_a: 14, voted_b: 18, correct_count: 18 }),
      "clarice:correct:260531": "B",
      // "clarice:stats:2605-06" propositalmente AUSENTE — é exatamente isso
      // que o bug reproduz (a chave nova nunca foi escrita para este ciclo).
    });
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/stats?edition=2605-06&brand=clarice"),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json() as {
      total: number; voted_a: number; voted_b: number;
      correct_answer: string | null; correct_count: number; correct_pct: number | null;
    };
    assert.equal(body.total, 32, "ANTES do fix isso retornava 0 — os votos existem sob a chave legada 260531");
    assert.equal(body.voted_a, 14);
    assert.equal(body.voted_b, 18);
    assert.equal(body.correct_answer, "B", "gabarito também vem do fallback legado (correct:260531)");
    assert.equal(body.correct_count, 18);
    assert.equal(body.correct_pct, 56, "56% = round(18/32*100)");
  });

  it("votos em AMBAS as chaves (novo + legado) → soma, não escolhe uma só", async () => {
    const kv = makeTrackedKv({
      "clarice:stats:260430": JSON.stringify({ total: 5, voted_a: 2, voted_b: 3, correct_count: 2 }),
      "clarice:stats:2604-05": JSON.stringify({ total: 3, voted_a: 1, voted_b: 2, correct_count: 1 }),
    });
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/stats?edition=2604-05&brand=clarice"),
      env,
    );
    const body = await res.json() as { total: number; voted_a: number; voted_b: number; correct_count: number };
    assert.equal(body.total, 8, "8 = 5 (legado) + 3 (novo) — soma, não substituição");
    assert.equal(body.voted_a, 3);
    assert.equal(body.voted_b, 5);
    assert.equal(body.correct_count, 3);
  });

  it("ciclo genuinamente sem votos em NENHUMA das duas chaves → 0, não erro (2603-04/2604-05 reais)", async () => {
    // Espelha o achado real: 2603-04 e 2604-05 não têm votos sob NENHUM
    // formato (a feature de voto mensal só foi lançada 2026-05-06, depois do
    // envio desses 2 digests) — não é regressão do fix, é ausência real de dados.
    const kv = makeTrackedKv();
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/stats?edition=2603-04&brand=clarice"),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { total: number; correct_pct: number | null };
    assert.equal(body.total, 0);
    assert.equal(body.correct_pct, null);
  });

  it("edition AAMMDD (diária) não é afetado — sem 2ª consulta, comportamento idêntico ao pré-#3261", async () => {
    const kv = makeTrackedKv({
      "stats:260613": JSON.stringify({ total: 7, voted_a: 4, voted_b: 3, correct_count: 5 }),
    });
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/stats?edition=260613"),
      env,
    );
    const body = await res.json() as { total: number; voted_a: number; voted_b: number; correct_count: number };
    assert.equal(body.total, 7);
    assert.equal(body.voted_a, 4);
    assert.equal(body.voted_b, 3);
    assert.equal(body.correct_count, 5);
  });

  it("correct_answer: chave primária tem prioridade sobre a legada quando ambas existem", async () => {
    const kv = makeTrackedKv({
      "clarice:stats:260430": JSON.stringify({ total: 1, voted_a: 1, voted_b: 0, correct_count: 1 }),
      "clarice:correct:260430": "A", // gabarito legado
      "clarice:stats:2604-05": JSON.stringify({ total: 1, voted_a: 0, voted_b: 1, correct_count: 0 }),
      "clarice:correct:2604-05": "B", // gabarito novo — deve vencer
    });
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };

    const res = await worker.fetch(
      new Request("https://poll.diaria.workers.dev/stats?edition=2604-05&brand=clarice"),
      env,
    );
    const body = await res.json() as { correct_answer: string | null };
    assert.equal(body.correct_answer, "B", "chave primária (edition pedida) tem prioridade sobre a legada");
  });

  it("direct import handleStats (sem router) também aplica o fallback — mesma cobertura via chamada direta", async () => {
    const kv = makeTrackedKv({
      "stats:260531": JSON.stringify({ total: 9, voted_a: 4, voted_b: 5, correct_count: 4 }),
    });
    const env: Env = {
      POLL: kv as unknown as KVNamespace,
      POLL_SECRET: "test-secret",
      ADMIN_SECRET: "test-admin-secret",
      ALLOWED_ORIGINS: "*",
    };
    const url = new URL("https://poll.diaria.workers.dev/stats?edition=2605-06");
    const res = await handleStats(url, env, "diaria");
    const body = await res.json() as { total: number };
    // Nota: aqui `env` NÃO está embrulhado por brand (chamada direta a
    // handleStats, não via router) — as chaves batem sem prefixo, como
    // qualquer outra edition normal. Confirma que o fallback funciona
    // independente do brand ser resolvido pelo router ou pelo caller.
    assert.equal(body.total, 9);
  });
});
