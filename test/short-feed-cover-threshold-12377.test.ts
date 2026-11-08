/**
 * test/short-feed-cover-threshold-12377.test.ts (#12377 item 4)
 *
 * `FEED_COVER_MATCH_MAX_DISTANCE` foi calibrado no #12100 contra `oar2.jpg` e
 * `maxresdefault.jpg`. Depois que o verificador passou a ler o `sardefault.jpg`
 * (#12251), o limiar foi remedido em 08/11/2026 contra o `sardefault` real de
 * 10 Shorts, com o dHash do próprio verificador. Os números abaixo são essa
 * medição (detalhe no docblock da constante e no comentário da #12377).
 *
 * Sem rede: o teste trava o limiar entre as duas pontas medidas. Quem mudar o
 * limiar remede e atualiza as pontas aqui.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FEED_COVER_MATCH_MAX_DISTANCE } from "../scripts/lib/diaria/short-feed-cover-check.ts";

/** `sardefault` x capa local: tem de dar "capa". */
const MEASURED_MATCH: Record<string, number> = {
  "4Sdq1thhSAA x 261030 capa": 0.004,
  "K3GqRK5gFds x 261022 capa": 0.012,
  "X4j2u-WxFvk x 261023 capa-D (a aplicada)": 0.008,
  // Margem mais apertada: o arquivo canônico é outra variante do mesmo desenho.
  "X4j2u-WxFvk x 261023 capa canônica": 0.176,
  "uIwtuFBqGkg x 261029 capa-still": 0.02,
  "5jX3X0sgMtg x 261103 capa": 0.0,
  "BQkZjUGWTDQ x 261104 capa": 0.02,
  "5CZ0zFFJ4RM x 261105 capa": 0.016,
};

/** `sardefault` x frame automático do mesmo Short, ou x capa de outra edição: tem de dar "frame-automatico". */
const MEASURED_NON_MATCH: Record<string, number> = {
  "27q1xuvBUc4 x oar2 (menor frame)": 0.266,
  "K3GqRK5gFds x oar2": 0.305,
  "UYllsanoQqw x oar2": 0.32,
  "X4j2u-WxFvk x oar2": 0.344,
  "4Sdq1thhSAA x oar2": 0.352,
  "WEAmxrYpr1E x oar2": 0.469,
  "uIwtuFBqGkg x oar2": 0.477,
  "5jX3X0sgMtg x 261105 capa (outra edição mais próxima)": 0.371,
};

describe("FEED_COVER_MATCH_MAX_DISTANCE contra o sardefault real (#12377)", () => {
  it("todo par 'capa' medido fica dentro do limiar", () => {
    for (const [pair, d] of Object.entries(MEASURED_MATCH)) {
      assert.ok(d <= FEED_COVER_MATCH_MAX_DISTANCE, `${pair}: ${d} > ${FEED_COVER_MATCH_MAX_DISTANCE}`);
    }
  });

  it("todo par 'frame'/'outra edição' medido fica fora do limiar", () => {
    for (const [pair, d] of Object.entries(MEASURED_NON_MATCH)) {
      assert.ok(d > FEED_COVER_MATCH_MAX_DISTANCE, `${pair}: ${d} <= ${FEED_COVER_MATCH_MAX_DISTANCE}`);
    }
  });

  it("o limiar segue 0,2, entre a maior distância 'capa' (0,176) e a menor 'frame' (0,266)", () => {
    assert.equal(FEED_COVER_MATCH_MAX_DISTANCE, 0.2);
    assert.equal(Math.max(...Object.values(MEASURED_MATCH)), 0.176);
    assert.equal(Math.min(...Object.values(MEASURED_NON_MATCH)), 0.266);
  });
});
