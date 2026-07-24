/**
 * test/poll-eia-pct-3977.test.ts (#3977)
 *
 * Percentual de acertos:
 *   1. Tela final da sequência web (`showFinal()`, jogar.ts): "Você acertou X
 *      de Y (Z%)!" — `formatSeqFinalScore` (TS puro) + seu gêmeo JS embutido
 *      no `<script>` de `renderJogarSequencePageHtml`.
 *   2. Coluna "%" no leaderboard HTML — `renderLeaderboardHtml` (via
 *      `handleLeaderboardByMonth`), a partir do `pct` já calculado por
 *      `rankEntries`/`scoreByMonthEntriesToLeaderboard`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSeqFinalScore, renderJogarSequencePageHtml } from "../workers/poll/src/jogar.ts";
import { handleLeaderboardByMonth, scoreByMonthEntriesToLeaderboard } from "../workers/poll/src/leaderboard-routes.ts";
import type { Env } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

describe("formatSeqFinalScore (#3977, pure)", () => {
  it("acerto parcial: percentual arredondado", () => {
    assert.equal(formatSeqFinalScore(3, 4), "Você acertou 3 de 4 (75%)!");
  });

  it("acerto total: 100%", () => {
    assert.equal(formatSeqFinalScore(5, 5), "Você acertou 5 de 5 (100%)!");
  });

  it("zero acertos: 0%", () => {
    assert.equal(formatSeqFinalScore(0, 5), "Você acertou 0 de 5 (0%)!");
  });

  it("arredondamento: 1/3 → 33%, não 33.33...%", () => {
    assert.equal(formatSeqFinalScore(1, 3), "Você acertou 1 de 3 (33%)!");
  });

  it("total <= 0 (edge case defensivo): sem percentual, não divide por zero", () => {
    assert.equal(formatSeqFinalScore(0, 0), "Você acertou 0 de 0!");
  });
});

describe("renderJogarSequencePageHtml — gêmeo JS de formatSeqFinalScore no showFinal (#3977)", () => {
  it("script calcula e exibe o percentual no texto do placar final", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, /"Você acertou " \+ score \+ " de " \+ total \+ " \(" \+ pct \+ "%\)!"/);
    assert.match(html, /var pct = total > 0 \? Math\.round\(\(score \/ total\) \* 100\) : 0;/);
  });
});

// ── coluna % no leaderboard HTML ─────────────────────────────────────────────

function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return {
    POLL: makeTrackedKv(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
}

describe("leaderboard HTML — coluna % (#3977)", () => {
  it("cabeçalho tem coluna '%' e cada linha mostra o pct calculado", async () => {
    const env = makeEnv({
      "score-by-month:2020-01:a@x.com": JSON.stringify({ total: 4, correct: 3, last_edition: "200110", nickname: "Ana" }),
    });
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    // #4008 item 4: cabeçalho "Leitor(a)" → "Jogador(a)" — inclui o jogador web.
    assert.match(html, /<th>#<\/th><th>Jogador\(a\)<\/th><th>Acertos<\/th><th>%<\/th>/);
    assert.match(html, /<td>3\/4<\/td>\s*<td>75%<\/td>/);
  });

  it("estado vazio: colspan atualizado pra 4 colunas", async () => {
    const env = makeEnv();
    const res = await handleLeaderboardByMonth("2020-01", env, "diaria");
    const html = await res.text();
    assert.match(html, /colspan=4/);
  });
});

describe("scoreByMonthEntriesToLeaderboard expõe pct (#3977, já calculado — só faltava chegar no template)", () => {
  it("pct correto pra cada entry", () => {
    const ranked = scoreByMonthEntriesToLeaderboard([
      { email: "a@x.com", nickname: "A", correct: 3, total: 4 },
      { email: "b@x.com", nickname: "B", correct: 0, total: 0 },
    ]);
    assert.equal(ranked[0].pct, 75);
    assert.equal(ranked[1].pct, 0, "total 0 → pct 0 (sem divisão por zero)");
  });
});
