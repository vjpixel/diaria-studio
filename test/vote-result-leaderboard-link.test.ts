/**
 * test/vote-result-leaderboard-link.test.ts (edição 260601)
 *
 * O link "Ver leaderboard" na página de resultado do voto deve apontar pra
 * leaderboard do MÊS DA EDIÇÃO (/leaderboard/{YYYY-MM}), não pra /leaderboard
 * (que delega pro mês corrente). Bug 260601: leitor vota na edição de junho
 * mas o link mostrava a leaderboard de maio (mês corrente na data do envio).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { votePageHtml } from "../workers/poll/src/index.ts";

describe("votePageHtml — link da leaderboard (260601)", () => {
  it("com leaderboardSlug → link aponta pra /leaderboard/{slug}", () => {
    const html = votePageHtml("Acertou!", true, null, null, "2026-06");
    assert.match(html, /href="\/leaderboard\/2026-06"/);
    assert.doesNotMatch(html, /href="\/leaderboard">/);
  });

  it("sem leaderboardSlug → fallback pra /leaderboard (back-compat)", () => {
    const html = votePageHtml("Link inválido.", false);
    assert.match(html, /href="\/leaderboard">/);
    assert.doesNotMatch(html, /\/leaderboard\/20/);
  });

  it("slug null explícito → fallback pra /leaderboard", () => {
    const html = votePageHtml("Já votou.", false, null, null, null);
    assert.match(html, /href="\/leaderboard">/);
  });
});
