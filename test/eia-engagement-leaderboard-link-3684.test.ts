/**
 * test/eia-engagement-leaderboard-link-3684.test.ts (#3684)
 *
 * Regressão (#633) para o link "Ver →" da aba Engajamento (É IA?) do
 * clarice-dashboard — feature adicionado no #3676/#3680.
 *
 * Bug: o link era montado com o ciclo CRU `YYMM-MM` (ex: "2606-07") na rota
 * `/leaderboard/{...}` do poll worker. Mas o leaderboard da Clarice é ANUAL
 * por ano-CALENDÁRIO (`BRAND_INFO.clarice.leaderboardPeriod === "year"` +
 * `handleLeaderboardByYear`, que valida `/^\d{4}$/` E 2000–2099). O ciclo
 * "2606-07" tem `2606` como YYMM (não YYYY), então a rota resolvia o "ano"
 * 2606 → "Ano inválido. Use formato YYYY (ex: 2026)." O botão não funcionava.
 *
 * Fix: `clariceCycleLeaderboardYear` converte o ciclo YYMM-MM no ano-calendário
 * (`20 + YY(conteúdo)`), e o link aponta para `/leaderboard/{YYYY}?brand=clarice`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  clariceCycleLeaderboardYear,
  renderEiaEngagementSection,
} from "../workers/brevo-dashboard/src/sections-kv.ts";
import type { EiaEngagementSummary } from "../workers/brevo-dashboard/src/types.ts";

describe("clariceCycleLeaderboardYear (#3684)", () => {
  test("ciclo YYMM-MM → ano-calendário YYYY (o YY do conteúdo vira 20YY)", () => {
    assert.equal(clariceCycleLeaderboardYear("2606-07"), "2026");
    assert.equal(clariceCycleLeaderboardYear("2605-06"), "2026");
    // conteúdo dez/2026, envio jan/2027 — ano do CONTEÚDO (mesmo bucket do
    // snapshot mensal via editionToMonthSlug) continua 2026.
    assert.equal(clariceCycleLeaderboardYear("2612-01"), "2026");
    assert.equal(clariceCycleLeaderboardYear("2501-02"), "2025");
  });

  test("NUNCA devolve o ciclo cru nem o YYMM como se fosse ano", () => {
    const y = clariceCycleLeaderboardYear("2606-07");
    assert.notEqual(y, "2606"); // o bug original
    assert.notEqual(y, "2606-07");
    assert.match(y!, /^\d{4}$/); // formato exigido por handleLeaderboardByYear
  });

  test("null para formatos inválidos ou não-ciclo", () => {
    assert.equal(clariceCycleLeaderboardYear("2600-07"), null); // mês conteúdo 00
    assert.equal(clariceCycleLeaderboardYear("2613-07"), null); // mês conteúdo 13
    assert.equal(clariceCycleLeaderboardYear("260718"), null); // AAMMDD diário
    assert.equal(clariceCycleLeaderboardYear("2026-05-01"), null);
    assert.equal(clariceCycleLeaderboardYear(""), null);
  });
});

describe("renderEiaEngagementSection — link Ver → (#3684)", () => {
  const summary: EiaEngagementSummary = {
    updated_at: "2026-07-19T19:37:00.000Z",
    editions: [
      { edition: "2606-07", total_votes: 31, voted_a: 17, voted_b: 14, pct_correct: 55, correct_choice: "a" },
      { edition: "2605-06", total_votes: 32, voted_a: 18, voted_b: 14, pct_correct: 56, correct_choice: "b" },
    ],
  };

  test("aponta para /leaderboard/{YYYY}?brand=clarice, não para o ciclo cru", () => {
    const html = renderEiaEngagementSection(summary);
    assert.ok(
      html.includes("/leaderboard/2026?brand=clarice"),
      "deve linkar o ano-calendário 2026",
    );
    // as duas regressões concretas do bug reportado (URL vista pelo editor):
    assert.ok(!html.includes("/leaderboard/2606-07"), "não pode vazar o ciclo cru");
    assert.ok(!html.includes("/leaderboard/2606?"), "não pode vazar o YYMM como ano");
  });
});
