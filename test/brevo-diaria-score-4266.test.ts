/**
 * test/brevo-diaria-score-4266.test.ts (#4266)
 *
 * Fórmula de scoring do canal Brevo próprio do editor (triagem de Pending da
 * Beehiiv) — mesmos fatores abertura/não-abertura do `computePriorityPoints`
 * da Clarice, SEM o bônus `priority_optin` (não aplicável aqui). Cobre os
 * casos exatos de +20/-10 e os dois thresholds (60 / -30), inclusive nas
 * bordas exatas (#633 exige regressão nos limites, não só no "meio" da faixa).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeBrevoDiariaScore,
  classifyBrevoDiariaAction,
  BREVO_DIARIA_PROMOTE_THRESHOLD,
  BREVO_DIARIA_SUPPRESS_THRESHOLD,
} from "../scripts/lib/shared/brevo-diaria-score.ts";

describe("computeBrevoDiariaScore — #4266", () => {
  it("sem envios → 0 (ponto de partida)", () => {
    assert.equal(computeBrevoDiariaScore({ opens_count: 0, sends_count: 0 }), 0);
  });

  it("+20 por email aberto (1 enviado, 1 aberto)", () => {
    assert.equal(computeBrevoDiariaScore({ opens_count: 1, sends_count: 1 }), 20);
  });

  it("-10 por email recebido e não aberto (1 enviado, 0 aberto)", () => {
    assert.equal(computeBrevoDiariaScore({ opens_count: 0, sends_count: 1 }), -10);
  });

  it("3 aberturas + 2 não-aberturas → 60 - 20 = 40", () => {
    assert.equal(computeBrevoDiariaScore({ opens_count: 3, sends_count: 5 }), 40);
  });

  it("NÃO tem bônus priority_optin — só a fatia abertura/não-abertura da fórmula Clarice", () => {
    // 3 aberturas puras (sends == opens): computePriorityPoints da Clarice
    // com priority_optin=false daria o mesmo valor (60) — confirma que a
    // fórmula aqui é a MESMA fatia, sem termo extra.
    assert.equal(computeBrevoDiariaScore({ opens_count: 3, sends_count: 3 }), 60);
  });

  it("aditivo, não corte duro: decai mas não trava em 0", () => {
    assert.equal(computeBrevoDiariaScore({ opens_count: 1, sends_count: 6 }), 20 - 50);
  });
});

describe("classifyBrevoDiariaAction — thresholds (#4266)", () => {
  it(`score == ${BREVO_DIARIA_PROMOTE_THRESHOLD} (borda exata) → promote_to_beehiiv`, () => {
    assert.equal(classifyBrevoDiariaAction(BREVO_DIARIA_PROMOTE_THRESHOLD), "promote_to_beehiiv");
  });

  it(`score == ${BREVO_DIARIA_PROMOTE_THRESHOLD - 1} (1 abaixo da borda) → keep`, () => {
    assert.equal(classifyBrevoDiariaAction(BREVO_DIARIA_PROMOTE_THRESHOLD - 1), "keep");
  });

  it("score muito acima do threshold de promoção → promote_to_beehiiv", () => {
    assert.equal(classifyBrevoDiariaAction(200), "promote_to_beehiiv");
  });

  it(`score == ${BREVO_DIARIA_SUPPRESS_THRESHOLD} (borda exata) → suppress`, () => {
    assert.equal(classifyBrevoDiariaAction(BREVO_DIARIA_SUPPRESS_THRESHOLD), "suppress");
  });

  it(`score == ${BREVO_DIARIA_SUPPRESS_THRESHOLD + 1} (1 acima da borda) → keep`, () => {
    assert.equal(classifyBrevoDiariaAction(BREVO_DIARIA_SUPPRESS_THRESHOLD + 1), "keep");
  });

  it("score muito abaixo do threshold de supressão → suppress", () => {
    assert.equal(classifyBrevoDiariaAction(-500), "suppress");
  });

  it("score 0 (neutro) → keep", () => {
    assert.equal(classifyBrevoDiariaAction(0), "keep");
  });

  it("scores computados via computeBrevoDiariaScore casam com os thresholds documentados", () => {
    // 3 aberturas, 0 não-abertura → 60 → promove
    assert.equal(
      classifyBrevoDiariaAction(computeBrevoDiariaScore({ opens_count: 3, sends_count: 3 })),
      "promote_to_beehiiv",
    );
    // 0 aberturas, 3 não-aberturas → -30 → suprime
    assert.equal(
      classifyBrevoDiariaAction(computeBrevoDiariaScore({ opens_count: 0, sends_count: 3 })),
      "suppress",
    );
    // 1 abertura, 1 não-abertura → 20 - 10 = 10 → mantém
    assert.equal(
      classifyBrevoDiariaAction(computeBrevoDiariaScore({ opens_count: 1, sends_count: 2 })),
      "keep",
    );
  });
});
