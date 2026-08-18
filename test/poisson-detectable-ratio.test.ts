/**
 * Teste da lógica pura do teste exato condicional pra duas taxas de Poisson
 * (issue #5651). Cobre casos com valor esperado conhecido/verificável contra
 * tabela estatística padrão (documentado por caso) e propriedades que
 * qualquer implementação correta precisa satisfazer (soma de densidade a 1,
 * monotonicidade do poder/da razão detectável).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  poissonPmfArray,
  binomialPmfArray,
  equalTailedBinomialCriticalRegion,
  poissonTwoRatePower,
  minDetectableRatio,
} from "../scripts/lib/poisson-detectable-ratio.ts";

describe("poissonPmfArray", () => {
  it("soma ~1 quando maxK cobre a massa da distribuição", () => {
    const pmf = poissonPmfArray(200, 88);
    const total = pmf.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `soma ${total} deveria ser ~1`);
  });

  it("pmf(0; lambda) = exp(-lambda) — definição direta", () => {
    const pmf = poissonPmfArray(5, 3.2);
    assert.ok(Math.abs(pmf[0] - Math.exp(-3.2)) < 1e-12);
  });

  it("rejeita maxK negativo e lambda <= 0", () => {
    assert.throws(() => poissonPmfArray(-1, 1));
    assert.throws(() => poissonPmfArray(5, 0));
    assert.throws(() => poissonPmfArray(5, -1));
  });
});

describe("binomialPmfArray", () => {
  it("soma ~1 pra n moderado", () => {
    const pmf = binomialPmfArray(88, 0.4);
    const total = pmf.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `soma ${total} deveria ser ~1`);
  });

  it("caso conhecido: Binomial(2, 0.5) = [0.25, 0.5, 0.25]", () => {
    const pmf = binomialPmfArray(2, 0.5);
    assert.ok(Math.abs(pmf[0] - 0.25) < 1e-12);
    assert.ok(Math.abs(pmf[1] - 0.5) < 1e-12);
    assert.ok(Math.abs(pmf[2] - 0.25) < 1e-12);
  });

  it("caso conhecido: Binomial(3, 1/3) — coeficientes binomiais C(3,k)", () => {
    // C(3,0)=1, C(3,1)=3, C(3,2)=3, C(3,3)=1 vezes (1/3)^k*(2/3)^(3-k)
    const pmf = binomialPmfArray(3, 1 / 3);
    const expected = [8 / 27, 12 / 27, 6 / 27, 1 / 27];
    for (let k = 0; k <= 3; k++) {
      assert.ok(Math.abs(pmf[k] - expected[k]) < 1e-9, `k=${k}: ${pmf[k]} vs ${expected[k]}`);
    }
  });

  it("rejeita p fora de (0,1) e n negativo", () => {
    assert.throws(() => binomialPmfArray(5, 0));
    assert.throws(() => binomialPmfArray(5, 1));
    assert.throws(() => binomialPmfArray(-1, 0.5));
  });
});

describe("equalTailedBinomialCriticalRegion", () => {
  it(
    "n=20, alpha=0,05 -> lower=5 — valor clássico de tabela do teste do sinal " +
      "(sign test, bicaudal, n=20, α=0,05: região crítica k<=5 ou k>=15; ex: " +
      "Conover, Practical Nonparametric Statistics, tabela do teste do sinal)",
    () => {
      const region = equalTailedBinomialCriticalRegion(20, 0.05);
      assert.equal(region.lower, 5);
      assert.equal(region.upper, 15);
    },
  );

  it("simetria: upper = n - lower sempre", () => {
    for (const n of [1, 2, 10, 37, 88, 150]) {
      const region = equalTailedBinomialCriticalRegion(n, 0.05);
      assert.equal(region.upper, n - region.lower);
    }
  });

  it("cada cauda tem massa <= alpha/2 (nunca estoura o nível pedido)", () => {
    const n = 40;
    const alpha = 0.05;
    const region = equalTailedBinomialCriticalRegion(n, alpha);
    const pmf = binomialPmfArray(n, 0.5);
    const lowerMass = pmf.slice(0, region.lower + 1).reduce((a, b) => a + b, 0);
    assert.ok(lowerMass <= alpha / 2 + 1e-12, `cauda inferior ${lowerMass} deveria ser <= ${alpha / 2}`);
  });

  it("n pequeno demais pro alpha -> lower=-1 (região vazia, nunca rejeita)", () => {
    // Binomial(1, 0.5): pmf(0)=0.5 > alpha/2 pra qualquer alpha < 1 razoável.
    const region = equalTailedBinomialCriticalRegion(1, 0.05);
    assert.equal(region.lower, -1);
    assert.equal(region.upper, 2); // n - (-1) = n+1, inatingível (k <= n sempre)
  });

  it("alpha mais apertado (Bonferroni) nunca dá região crítica MAIOR que alpha solto", () => {
    const n = 88;
    const loose = equalTailedBinomialCriticalRegion(n, 0.05);
    const strict = equalTailedBinomialCriticalRegion(n, 0.0167);
    assert.ok(strict.lower <= loose.lower, "região crítica mais apertada deveria ter lower <= a solta");
  });
});

describe("poissonTwoRatePower", () => {
  it("ratio=1 (H0 verdadeira) -> poder ~ alpha (taxa de falso positivo, não de detecção)", () => {
    const power = poissonTwoRatePower(88, 1, 0.05);
    // Com discretização, o "tipo I" exato fica abaixo de alpha (equal-tailed
    // conservador) — deve ser positivo mas bem menor que qualquer poder alvo real.
    assert.ok(power > 0 && power < 0.1, `poder sob H0 (${power}) deveria ficar perto do nível, não perto de 1`);
  });

  it("poder cresce com a razão (mais fácil detectar efeito maior)", () => {
    const p1 = poissonTwoRatePower(88, 1.2, 0.05);
    const p2 = poissonTwoRatePower(88, 1.6, 0.05);
    const p3 = poissonTwoRatePower(88, 2.5, 0.05);
    assert.ok(p1 < p2, `${p1} deveria ser < ${p2}`);
    assert.ok(p2 < p3, `${p2} deveria ser < ${p3}`);
  });

  it("poder cresce com n0 pra uma razão fixa (mais dado = mais fácil detectar)", () => {
    const small = poissonTwoRatePower(30, 1.6, 0.05);
    const large = poissonTwoRatePower(300, 1.6, 0.05);
    assert.ok(small < large, `${small} deveria ser < ${large}`);
  });

  it("rejeita n0 <= 0 e ratio < 1", () => {
    assert.throws(() => poissonTwoRatePower(0, 1.5, 0.05));
    assert.throws(() => poissonTwoRatePower(88, 0.9, 0.05));
  });
});

describe("minDetectableRatio", () => {
  it("resultado bate com poissonTwoRatePower — poder no ratio devolvido é ~targetPower", () => {
    const n0 = 88;
    const alpha = 0.05;
    const targetPower = 0.8;
    const ratio = minDetectableRatio(n0, alpha, targetPower);
    const achieved = poissonTwoRatePower(n0, ratio, alpha);
    assert.ok(Math.abs(achieved - targetPower) < 0.01, `poder atingido ${achieved} deveria ser ~${targetPower}`);
  });

  it("razão mínima detectável DIMINUI conforme n0 aumenta (mais dado detecta efeitos menores)", () => {
    const r59 = minDetectableRatio(59, 0.05, 0.8);
    const r88 = minDetectableRatio(88, 0.05, 0.8);
    const r117 = minDetectableRatio(117, 0.05, 0.8);
    assert.ok(r59 > r88, `${r59} deveria ser > ${r88}`);
    assert.ok(r88 > r117, `${r88} deveria ser > ${r117}`);
  });

  it("alpha corrigido por Bonferroni (mais apertado) exige razão MAIOR que alpha par-a-par", () => {
    const n0 = 88;
    const parAPar = minDetectableRatio(n0, 0.05, 0.8);
    const bonferroni = minDetectableRatio(n0, 0.0167, 0.8);
    assert.ok(bonferroni > parAPar, `Bonferroni (${bonferroni}) deveria exigir razão maior que par-a-par (${parAPar})`);
  });

  it("aproxima a fórmula assintótica de Wald pra n0 grande (checagem cruzada de método)", () => {
    // Fórmula clássica de tamanho de amostra/razão detectável pra duas taxas
    // de Poisson via log-rate-ratio (aproximação normal — ex: Zar,
    // Biostatistical Analysis, cap. de comparação de taxas de Poisson):
    //   ln(ratio) = (z_{alpha/2} + z_power) * sqrt(2/n0)
    // Válida como aproximação assintótica (n0 grande) do teste exato —
    // usada aqui só pra cross-check de magnitude, não como fonte de verdade
    // (o teste exato é o método canônico deste módulo).
    const n0 = 400;
    const alpha = 0.05;
    const power = 0.8;
    const zAlphaHalf = 1.959964; // qnorm(0.975)
    const zPower = 0.841621; // qnorm(0.8)
    const waldRatio = Math.exp((zAlphaHalf + zPower) * Math.sqrt(2 / n0));

    const exactRatio = minDetectableRatio(n0, alpha, power, { tolerance: 1e-3 });
    const relDiff = Math.abs(exactRatio - waldRatio) / (waldRatio - 1);
    assert.ok(
      relDiff < 0.1,
      `razão exata ${exactRatio} deveria ficar perto (< 10% de erro relativo no efeito) da aproximação de Wald ${waldRatio}`,
    );
  });

  it("lança quando maxRatio é baixo demais pro poder pedido", () => {
    assert.throws(() => minDetectableRatio(5, 0.0001, 0.99, { maxRatio: 1.01 }));
  });

  it("rejeita targetPower fora de (0,1)", () => {
    assert.throws(() => minDetectableRatio(88, 0.05, 0));
    assert.throws(() => minDetectableRatio(88, 0.05, 1));
  });
});
