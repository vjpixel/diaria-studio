/**
 * test/brevo-diaria-score-4266.test.ts (#4266, reescrito no #4476 item 1;
 * threshold de supressão corrigido pra n>=3 e o input passou a exigir 2
 * conjuntos de contadores — instantâneo/maduro — no self-review pós-merge)
 *
 * Fórmula de saída (promoção/supressão) do canal Brevo próprio do editor —
 * taxa de abertura com piso mínimo de amostra, assimétrica entre promoção
 * (n>=2, taxa>=50%, contadores INSTANTÂNEOS) e supressão (n>=3, taxa<=20%,
 * contadores MADUROS — só envios >=48h). Cobre as bordas EXATAS dos dois
 * thresholds, os casos abaixo do piso de amostra que NUNCA agem mesmo com a
 * taxa já batendo o threshold (#633 exige regressão nos limites, não só no
 * "meio" da faixa), e os casos onde instant≠mature divergem (a divergência
 * é o comportamento inteiro da janela de maturação).
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
  type BrevoDiariaRateInput,
} from "../scripts/lib/shared/brevo-diaria-score.ts";

/** Atalho pra testes de threshold "puro" onde instant e mature são o MESMO
 * conjunto de contadores — a maioria dos testes de borda não se importa com
 * a distinção instant/mature, só com o threshold em si. */
function same(opens_count: number, sends_count: number): { instant: BrevoDiariaRateInput; mature: BrevoDiariaRateInput } {
  const counts = { opens_count, sends_count };
  return { instant: counts, mature: counts };
}

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

describe("classifyBrevoDiariaAction — promoção (#4476 item 1, sempre via instant)", () => {
  it(`sends_count=${BREVO_DIARIA_PROMOTE_MIN_SENDS}, openRate=${BREVO_DIARIA_PROMOTE_MIN_OPEN_RATE} (bordas exatas) → promote_to_beehiiv`, () => {
    assert.equal(
      classifyBrevoDiariaAction(same(1, 2)),
      "promote_to_beehiiv",
      "2 enviados/1 aberto = 50% exato, piso de amostra 2 exato",
    );
  });

  it("sends_count=1 (1 abaixo do piso), openRate=100% → keep (NÃO promove mesmo com taxa perfeita)", () => {
    assert.equal(
      classifyBrevoDiariaAction(same(1, 1)),
      "keep",
      "amostra insuficiente sempre vence, mesmo com taxa acima do threshold",
    );
  });

  it("sends_count=2, openRate=49% (1 abaixo do threshold) → keep", () => {
    assert.equal(classifyBrevoDiariaAction(same(49, 100)), "keep");
  });

  it("amostra grande, taxa bem acima do threshold → promote_to_beehiiv", () => {
    assert.equal(classifyBrevoDiariaAction(same(9, 10)), "promote_to_beehiiv");
  });

  it("promoção usa SÓ o `instant` — `mature` fraco/zero não impede a promoção", () => {
    assert.equal(
      classifyBrevoDiariaAction({ instant: { opens_count: 3, sends_count: 3 }, mature: { opens_count: 0, sends_count: 0 } }),
      "promote_to_beehiiv",
      "3/3 instantâneo = 100%, promove mesmo sem NENHUM envio maduro ainda",
    );
  });
});

describe("classifyBrevoDiariaAction — supressão (#4476 item 1, revisado pra n>=3; sempre via mature)", () => {
  it(`sends_count=${BREVO_DIARIA_SUPPRESS_MIN_SENDS} (piso de amostra exato), openRate=0% → suppress`, () => {
    assert.equal(
      classifyBrevoDiariaAction(same(0, BREVO_DIARIA_SUPPRESS_MIN_SENDS)),
      "suppress",
      "3 enviados/0 abertos = 0%, piso de amostra 3 exato",
    );
  });

  it(`sends_count=5, openRate=${BREVO_DIARIA_SUPPRESS_MAX_OPEN_RATE * 100}% (borda EXATA do threshold de taxa) → suppress`, () => {
    assert.equal(
      classifyBrevoDiariaAction(same(1, 5)),
      "suppress",
      "5 enviados/1 aberto = 20% exato — n=3 não permite atingir 20% exato com inteiros, usa n=5 só pra esta borda",
    );
  });

  it("sends_count=2 (1 abaixo do piso), openRate=0% → keep (NÃO suprime mesmo com taxa péssima)", () => {
    assert.equal(
      classifyBrevoDiariaAction(same(0, 2)),
      "keep",
      "amostra insuficiente sempre vence, mesmo com taxa abaixo do threshold",
    );
  });

  it("sends_count=5, openRate=21% (1 acima do threshold) → keep", () => {
    assert.equal(classifyBrevoDiariaAction(same(21, 100)), "keep");
  });

  it("amostra grande, taxa bem abaixo do threshold → suppress", () => {
    assert.equal(classifyBrevoDiariaAction(same(1, 20)), "suppress");
  });

  it("nunca aberto, amostra suficiente (n=3) → suppress (openRate=0%)", () => {
    assert.equal(classifyBrevoDiariaAction(same(0, 3)), "suppress");
  });

  it("supressão usa SÓ o `mature` — `instant` alto (envios recentes) não impede a supressão se mature já qualifica", () => {
    assert.equal(
      classifyBrevoDiariaAction({ instant: { opens_count: 0, sends_count: 10 }, mature: { opens_count: 0, sends_count: 3 } }),
      "suppress",
      "3 envios MADUROS, 0 abertos → suprime, mesmo com 10 envios instantâneos no total (7 ainda imaturos)",
    );
  });

  it("mature abaixo do piso (só 2 envios maduros) → keep, mesmo com instant já grande e openRate=0%", () => {
    assert.equal(
      classifyBrevoDiariaAction({ instant: { opens_count: 0, sends_count: 10 }, mature: { opens_count: 0, sends_count: 2 } }),
      "keep",
      "janela de maturação: só 2 dos 10 envios já têm >=48h — piso de supressão (n>=3) não é atingido ainda",
    );
  });
});

describe("classifyBrevoDiariaAction — meio da faixa e zero atividade (#4476)", () => {
  it("openRate entre os dois thresholds, amostra suficiente pros dois → keep", () => {
    assert.equal(classifyBrevoDiariaAction(same(3, 10)), "keep"); // 30%
  });

  it("sem envios (0/0) → keep (nenhum piso de amostra atingido)", () => {
    assert.equal(classifyBrevoDiariaAction(same(0, 0)), "keep");
  });

  it("promoção e supressão são mutuamente exclusivas dentro do MESMO conjunto de contadores — nenhum input classifica como as duas", () => {
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
