/**
 * test/brevo-diaria-score-4266.test.ts (#4266, reescrito no #4476 item 1)
 *
 * Fórmula de saída (promoção/supressão) do canal Brevo próprio do editor —
 * taxa de abertura com piso mínimo de amostra, assimétrica entre promoção
 * (n>=2, taxa>=50%) e supressão (n>=5, taxa<=20%). Cobre as bordas EXATAS
 * dos dois thresholds e — caso mais importante desta reescrita — os casos
 * abaixo do piso de amostra que NUNCA agem mesmo com a taxa já batendo o
 * threshold (#633 exige regressão nos limites, não só no "meio" da faixa).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeBrevoDiariaOpenRate,
  classifyBrevoDiariaAction,
  BREVO_DIARIA_PROMOTE_MIN_SENDS,
  BREVO_DIARIA_PROMOTE_MIN_OPEN_RATE,
  BREVO_DIARIA_SUPPRESS_MIN_SENDS,
  BREVO_DIARIA_SUPPRESS_MAX_OPEN_RATE,
} from "../scripts/lib/shared/brevo-diaria-score.ts";

describe("computeBrevoDiariaOpenRate — #4476", () => {
  it("sem envios → 0 (nunca divide por zero)", () => {
    assert.equal(computeBrevoDiariaOpenRate({ opens_count: 0, sends_count: 0 }), 0);
  });

  it("2 enviados, 1 aberto → 0.5", () => {
    assert.equal(computeBrevoDiariaOpenRate({ opens_count: 1, sends_count: 2 }), 0.5);
  });

  it("5 enviados, 1 aberto → 0.2", () => {
    assert.equal(computeBrevoDiariaOpenRate({ opens_count: 1, sends_count: 5 }), 0.2);
  });

  it("todos abertos → 1", () => {
    assert.equal(computeBrevoDiariaOpenRate({ opens_count: 4, sends_count: 4 }), 1);
  });
});

describe("classifyBrevoDiariaAction — promoção (#4476 item 1)", () => {
  it(`sends_count=${BREVO_DIARIA_PROMOTE_MIN_SENDS}, openRate=${BREVO_DIARIA_PROMOTE_MIN_OPEN_RATE} (bordas exatas) → promote_to_beehiiv`, () => {
    assert.equal(
      classifyBrevoDiariaAction({ opens_count: 1, sends_count: 2 }),
      "promote_to_beehiiv",
      "2 enviados/1 aberto = 50% exato, piso de amostra 2 exato",
    );
  });

  it("sends_count=1 (1 abaixo do piso), openRate=100% → keep (NÃO promove mesmo com taxa perfeita)", () => {
    assert.equal(
      classifyBrevoDiariaAction({ opens_count: 1, sends_count: 1 }),
      "keep",
      "amostra insuficiente sempre vence, mesmo com taxa acima do threshold",
    );
  });

  it("sends_count=2, openRate=49% (1 abaixo do threshold) → keep", () => {
    assert.equal(classifyBrevoDiariaAction({ opens_count: 49, sends_count: 100 }), "keep");
  });

  it("amostra grande, taxa bem acima do threshold → promote_to_beehiiv", () => {
    assert.equal(classifyBrevoDiariaAction({ opens_count: 9, sends_count: 10 }), "promote_to_beehiiv");
  });
});

describe("classifyBrevoDiariaAction — supressão (#4476 item 1)", () => {
  it(`sends_count=${BREVO_DIARIA_SUPPRESS_MIN_SENDS}, openRate=${BREVO_DIARIA_SUPPRESS_MAX_OPEN_RATE} (bordas exatas) → suppress`, () => {
    assert.equal(
      classifyBrevoDiariaAction({ opens_count: 1, sends_count: 5 }),
      "suppress",
      "5 enviados/1 aberto = 20% exato, piso de amostra 5 exato",
    );
  });

  it("sends_count=4 (1 abaixo do piso), openRate=0% → keep (NÃO suprime mesmo com taxa péssima)", () => {
    assert.equal(
      classifyBrevoDiariaAction({ opens_count: 0, sends_count: 4 }),
      "keep",
      "amostra insuficiente sempre vence, mesmo com taxa abaixo do threshold",
    );
  });

  it("sends_count=5, openRate=21% (1 acima do threshold) → keep", () => {
    assert.equal(classifyBrevoDiariaAction({ opens_count: 21, sends_count: 100 }), "keep");
  });

  it("amostra grande, taxa bem abaixo do threshold → suppress", () => {
    assert.equal(classifyBrevoDiariaAction({ opens_count: 1, sends_count: 20 }), "suppress");
  });

  it("nunca aberto, amostra suficiente → suppress (openRate=0%)", () => {
    assert.equal(classifyBrevoDiariaAction({ opens_count: 0, sends_count: 5 }), "suppress");
  });
});

describe("classifyBrevoDiariaAction — meio da faixa e zero atividade (#4476)", () => {
  it("openRate entre os dois thresholds, amostra suficiente pros dois → keep", () => {
    assert.equal(classifyBrevoDiariaAction({ opens_count: 3, sends_count: 10 }), "keep"); // 30%
  });

  it("sem envios (0/0) → keep (nenhum piso de amostra atingido)", () => {
    assert.equal(classifyBrevoDiariaAction({ opens_count: 0, sends_count: 0 }), "keep");
  });

  it("promoção e supressão são mutuamente exclusivas — nenhum input classifica como as duas", () => {
    for (let sends = 0; sends <= 10; sends++) {
      for (let opens = 0; opens <= sends; opens++) {
        const input = { opens_count: opens, sends_count: sends };
        const rate = computeBrevoDiariaOpenRate(input);
        const isPromote = sends >= BREVO_DIARIA_PROMOTE_MIN_SENDS && rate >= BREVO_DIARIA_PROMOTE_MIN_OPEN_RATE;
        const isSuppress = sends >= BREVO_DIARIA_SUPPRESS_MIN_SENDS && rate <= BREVO_DIARIA_SUPPRESS_MAX_OPEN_RATE;
        assert.ok(!(isPromote && isSuppress), `sends=${sends} opens=${opens} não deveria bater os dois thresholds`);
      }
    }
  });
});
