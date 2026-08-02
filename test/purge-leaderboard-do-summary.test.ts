/**
 * test/purge-leaderboard-do-summary.test.ts (#4477, achado 1 do fleet review
 * #4383)
 *
 * `main()` de `scripts/purge-leaderboard.ts` fala com `wrangler` de verdade
 * via `execFileSync` — não é testável fim-a-fim sem mock pesado. A lógica de
 * agregação (loop de resultados por identidade → decisão de
 * `process.exitCode`) foi extraída pra `scripts/lib/purge-leaderboard-do-
 * summary.ts` (`summarizePurgeDoResults`), pura e testável sem rede/wrangler.
 *
 * BUG que este teste cobre: antes do #4477, a purga do storage do DO
 * ScoreCounter por identidade só produzia um `console.error` isolado —
 * nenhuma agregação, `process.exitCode` nunca setado, mesmo com falha
 * PARCIAL (algumas identidades OK, uma falhou). O script sempre terminava
 * com a linha "done" de sucesso incondicional. `test/purge-leaderboard-do-
 * 4474.test.ts` já cobre a lib pura de fetch (`purgeScoreCounterDo`) e o
 * endpoint isoladamente — este arquivo cobre especificamente a agregação de
 * MÚLTIPLAS identidades com falha parcial, que nenhum teste existente tocava.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { summarizePurgeDoResults, type PurgeDoStepResult } from "../scripts/lib/purge-leaderboard-do-summary.ts";

describe("summarizePurgeDoResults (#4477 achado 1)", () => {
  it("todas as identidades OK → failures vazio, shouldFailExitCode=false", () => {
    const results: PurgeDoStepResult[] = [
      { email: "a@x.com", ok: true },
      { email: "b@x.com", ok: true },
      { email: "c@x.com", ok: true },
    ];
    const summary = summarizePurgeDoResults(results);
    assert.deepEqual(summary.failures, []);
    assert.equal(summary.shouldFailExitCode, false);
  });

  it("mistura de sucesso+falha (falha PARCIAL, o cenário central do achado) → failures lista só os que falharam, shouldFailExitCode=true", () => {
    const results: PurgeDoStepResult[] = [
      { email: "ok1@x.com", ok: true },
      { email: "falhou@x.com", ok: false },
      { email: "ok2@x.com", ok: true },
    ];
    const summary = summarizePurgeDoResults(results);
    assert.deepEqual(summary.failures, ["falhou@x.com"]);
    assert.equal(summary.shouldFailExitCode, true);
  });

  it("TODAS falharam → failures com todos os e-mails, shouldFailExitCode=true", () => {
    const results: PurgeDoStepResult[] = [
      { email: "a@x.com", ok: false },
      { email: "b@x.com", ok: false },
    ];
    const summary = summarizePurgeDoResults(results);
    assert.deepEqual(summary.failures, ["a@x.com", "b@x.com"]);
    assert.equal(summary.shouldFailExitCode, true);
  });

  it("lista vazia (nenhuma identidade no plano) → failures vazio, shouldFailExitCode=false", () => {
    const summary = summarizePurgeDoResults([]);
    assert.deepEqual(summary.failures, []);
    assert.equal(summary.shouldFailExitCode, false);
  });
});
