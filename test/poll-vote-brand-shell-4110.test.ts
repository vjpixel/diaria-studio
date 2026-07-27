/**
 * test/poll-vote-brand-shell-4110.test.ts (#4110)
 *
 * Achado ao vivo (editor, 260727): a página `/vote` (votePageHtml, index.ts)
 * era a única superfície pública do worker `poll` sem o shell mínimo de
 * identidade de marca (kicker "É IA?" + régua teal + rodapé) que
 * leaderboard/arquivo/arquivo-vote (leaderboard-routes.ts) já têm desde o
 * #3113 — inclusive nas telas de ERRO (link inválido, escolha inválida),
 * que reusam a mesma `votePageHtml`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { votePageHtml } from "../workers/poll/src/index.ts";

describe("votePageHtml — shell de marca (#4110)", () => {
  it("resultado normal de voto tem kicker + régua + rodapé de marca", () => {
    const html = votePageHtml("Você acertou!", true, null, null, null, "diaria");
    assert.match(html, /<p class="kicker">É IA\?<\/p>/);
    assert.match(html, /<hr class="rule">/);
    assert.match(html, /<footer class="brand-footer">/);
  });

  it("tela de erro (link inválido/escolha inválida) reusa a MESMA votePageHtml — shell também aparece", () => {
    const html = votePageHtml("Escolha inválida.", false, null, null, null, "diaria");
    assert.match(html, /<p class="kicker">É IA\?<\/p>/);
    assert.match(html, /<hr class="rule">/);
    assert.match(html, /<footer class="brand-footer">/);
  });

  it("brand clarice também recebe o shell (rodapé credita Diar.ia, não Clarice — comportamento pré-existente de renderBrandFooter)", () => {
    const html = votePageHtml("Você acertou!", true, null, null, null, "clarice");
    assert.match(html, /<p class="kicker">É IA\?<\/p>/);
    assert.match(html, /<footer class="brand-footer">.*diar\.ia\.br|Diar\.ia/s);
  });
});
