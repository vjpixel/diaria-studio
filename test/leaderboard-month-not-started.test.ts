/**
 * test/leaderboard-month-not-started.test.ts (260601)
 *
 * shouldShowMonthNotStarted: a tela "O leaderboard de {mês} ainda não começou"
 * só aparece pra mês futuro SEM votos. Bug 260601: edição publica dia 1º (junho)
 * mas, na data de envio (31/mai), currentMonthSlugBrt=maio → junho era "futuro"
 * e a página mostrava "ainda não começou" mesmo já tendo votos no bucket de junho.
 *
 * slugCmp = monthSlugCompare(monthSlug, currentSlug):
 *   > 0  mês futuro | 0  mês corrente | < 0  mês passado
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldShowMonthNotStarted } from "../workers/poll/src/index.ts";

describe("shouldShowMonthNotStarted (260601)", () => {
  it("mês futuro SEM votos → true (mostra 'ainda não começou')", () => {
    assert.equal(shouldShowMonthNotStarted(1, 0), true);
  });

  it("mês futuro COM votos → false (renderiza a leaderboard) — bug 260601", () => {
    assert.equal(shouldShowMonthNotStarted(1, 1), false);
    assert.equal(shouldShowMonthNotStarted(1, 42), false);
  });

  it("mês corrente → false (mesmo sem votos, é o mês ativo)", () => {
    assert.equal(shouldShowMonthNotStarted(0, 0), false);
    assert.equal(shouldShowMonthNotStarted(0, 5), false);
  });

  it("mês passado → false (sempre renderiza histórico)", () => {
    assert.equal(shouldShowMonthNotStarted(-1, 0), false);
    assert.equal(shouldShowMonthNotStarted(-1, 10), false);
  });
});
