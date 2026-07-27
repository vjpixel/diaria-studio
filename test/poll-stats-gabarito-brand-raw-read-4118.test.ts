/**
 * test/poll-stats-gabarito-brand-raw-read-4118.test.ts (#4118)
 *
 * BUG: `handleStats`/`fetchEditionStatsAndCorrect` (workers/poll/src/vote.ts)
 * liam o gabarito `correct:{edition}` via o env BRANDED (`bEnv`, passado por
 * `routeRequest` em index.ts — `handleStats(url, bEnv, brand)`). Para
 * brand="web"/"clarice" isso resolvia `web:correct:{edition}`/
 * `clarice:correct:{edition}` — chaves que NUNCA são escritas: `/admin/correct`
 * (fixado no #4038) sempre grava a chave CRUA `correct:{edition}`, fato
 * público brand-independente (mesma decisão de `handleVote`, #3600).
 * Resultado: `/stats?edition=X&brand=clarice` (e `web`) sempre devolvia
 * `correct_answer: null`, mesmo com o gabarito já fechado.
 *
 * Confirmado ao vivo (probe contra o worker de produção, ver issue #4118):
 *   POST /admin/correct?edition=2606-07&brand=clarice → 200, grava correct:2606-07 (cru)
 *   GET  /stats?edition=2606-07&brand=clarice          → correct_answer: null   ← bug
 *   GET  /stats?edition=2606-07                        → correct_answer: "B"
 *
 * IMPACTO REAL: `scripts/close-poll.ts` faz `GET /stats?edition=X&brand=Y`
 * como sanity check pós-escrita e dá `process.exit(1)` ("FATAL: sanity check
 * falhou") quando `correct_answer !== answer` — ou seja, `close-poll.ts
 * --brand clarice`/`--brand web` ABORTAVA achando que a escrita tinha
 * falhado (a escrita estava correta; só a LEITURA de volta é que lia o
 * namespace errado), e o marker de Stage 5 nunca era gravado. Também fazia
 * `build-poll-eia-data.ts` gravar `correct_choice: null`, zerando a aba
 * Engajamento da dashboard pra qualquer edição não-diária.
 *
 * FIX: `fetchEditionStatsAndCorrect`/`getSummedEditionStats`/`handleStats`
 * ganharam um parâmetro final `rawEnv` (default = env, preserva compat com
 * chamadas de teste legadas com env único) — só o READ de `correct:{edition}`
 * usa `rawEnv`; `stats:{edition}` (espelho do DO `{brand}:{edition}`, esse
 * SIM por-brand) continua via `env` (branded). `index.ts` passa o `env` cru
 * como 4º arg em `routeRequest` (`handleStats(url, bEnv, brand, env)`).
 *
 * Este teste cobre os 3 brands (diaria/web/clarice) lendo o MESMO gabarito
 * cru — via o worker inteiro (`workerDefault.fetch`), não `handleStats`
 * diretamente, pra exercitar o wiring real de `bEnv`/`env` em index.ts (o
 * bug só se manifesta nesse wiring). Com `brand="diaria"` (prefixo vazio),
 * cru===branded — por isso o bug ficava invisível em qualquer teste que só
 * exercitasse esse brand; a cobertura aqui é deliberadamente ancorada em
 * `clarice`/`web`, não só `diaria`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerDefault, { brandedNamespace } from "../workers/poll/src/index.ts";
import { handleStats } from "../workers/poll/src/vote.ts";
import { brandKvPrefix } from "../workers/poll/src/lib.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

function statsUrl(edition: string, brand?: string): URL {
  const url = new URL("https://poll.diaria.workers.dev/stats");
  url.searchParams.set("edition", edition);
  if (brand) url.searchParams.set("brand", brand);
  return url;
}

async function stats(kv: ReturnType<typeof makeTrackedKv>, edition: string, brand?: string) {
  const env = makePollEnv(kv);
  return workerDefault.fetch(new Request(statsUrl(edition, brand).toString()), env);
}

describe("handleStats via /stats — gabarito correct:{edition} é lido CRU (brand-independente) (#4118)", () => {
  it("brand=clarice: correct_answer vem do gabarito cru, não null", async () => {
    const kv = makeTrackedKv({
      "clarice:stats:2606-07": JSON.stringify({ total: 10, voted_a: 4, voted_b: 6, correct_count: 6 }),
      "correct:2606-07": "B", // CRU — nunca "clarice:correct:2606-07"
    });

    const res = await stats(kv, "2606-07", "clarice");
    assert.equal(res.status, 200);
    const body = await res.json() as { correct_answer: string | null; total: number };
    assert.equal(body.correct_answer, "B", "ANTES do fix isso retornava null — lia clarice:correct:2606-07 (nunca escrita)");
    assert.equal(body.total, 10);

    // Confirma que a chave branded nunca precisou existir.
    assert.equal(await kv.get("clarice:correct:2606-07"), null, "clarice:correct:{edition} nunca deve ser escrito nem necessário pro /stats");
  });

  it("brand=web: mesmo gabarito cru resolve correct_answer corretamente", async () => {
    const kv = makeTrackedKv({
      "web:stats:260601": JSON.stringify({ total: 3, voted_a: 1, voted_b: 2, correct_count: 2 }),
      "correct:260601": "A", // CRU — nunca "web:correct:260601"
    });

    const res = await stats(kv, "260601", "web");
    assert.equal(res.status, 200);
    const body = await res.json() as { correct_answer: string | null };
    assert.equal(body.correct_answer, "A", "ANTES do fix isso retornava null — lia web:correct:260601 (nunca escrita)");
  });

  it("brand=diaria (default, sem regressão): continua lendo o gabarito normalmente — prefixo é '' então cru===branded", async () => {
    const kv = makeTrackedKv({
      "stats:260602": JSON.stringify({ total: 5, voted_a: 2, voted_b: 3, correct_count: 3 }),
      "correct:260602": "B",
    });

    const res = await stats(kv, "260602");
    assert.equal(res.status, 200);
    const body = await res.json() as { correct_answer: string | null };
    assert.equal(body.correct_answer, "B", "diaria não deve regredir — brandKvPrefix('diaria') === '' já lia a chave crua antes do fix");
  });

  it("os 3 brands compartilham o MESMO gabarito cru — 1 close-poll.ts serve diaria+web+clarice simultaneamente", async () => {
    const kv = makeTrackedKv({
      "stats:260603": JSON.stringify({ total: 1, voted_a: 1, voted_b: 0, correct_count: 1 }),
      "web:stats:260603": JSON.stringify({ total: 1, voted_a: 0, voted_b: 1, correct_count: 0 }),
      "clarice:stats:260603": JSON.stringify({ total: 2, voted_a: 1, voted_b: 1, correct_count: 1 }),
      "correct:260603": "A",
    });

    for (const brand of ["diaria", "web", "clarice"] as const) {
      const res = brand === "diaria" ? await stats(kv, "260603") : await stats(kv, "260603", brand);
      assert.equal(res.status, 200, `${brand}: status 200`);
      const body = await res.json() as { correct_answer: string | null };
      assert.equal(body.correct_answer, "A", `${brand}: deve ler o mesmo gabarito cru correct:260603`);
    }
  });

  it("chamada direta a handleStats reproduz o wiring de index.ts: bEnv (branded) + rawEnv (cru) explícitos — sanity check do close-poll.ts (#4118)", async () => {
    // Reproduz literalmente o que scripts/close-poll.ts faz: grava o gabarito
    // (via env cru, como /admin/correct desde #4038) e em seguida confere
    // GET /stats?edition=X&brand=Y — se correct_answer !== answer, o script
    // aborta com "FATAL: sanity check falhou". Aqui construímos `bEnv`
    // (branded, via `brandedNamespace`+`brandKvPrefix` — o MESMO wrapper que
    // `routeRequest` usa em index.ts) e o `env` cru separadamente, replicando
    // o wiring real (`handleStats(url, bEnv, brand, env)`). ANTES do fix,
    // passar só `bEnv` (sem 4º arg) fazia o read de `correct:{edition}` cair
    // no default `rawEnv = env` = bEnv → lia `clarice:correct:2607-08`
    // (nunca escrita) → correct_answer null → "FATAL" espúrio.
    const kv = makeTrackedKv({ "correct:2607-08": "B" }); // CRU — nunca "clarice:correct:2607-08"
    const rawEnv = makePollEnv(kv);
    const bEnv = { ...rawEnv, POLL: brandedNamespace(rawEnv.POLL, brandKvPrefix("clarice")) };

    const res = await handleStats(new URL("https://poll.diaria.workers.dev/stats?edition=2607-08&brand=clarice"), bEnv, "clarice", rawEnv);
    const body = await res.json() as { correct_answer: string | null };
    assert.equal(body.correct_answer, "B", "handleStats(url, bEnv, brand, rawEnv) deve ler o gabarito cru mesmo com bEnv branded");
  });
});
