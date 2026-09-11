/**
 * test/logistic-regression.test.ts (#7990)
 *
 * Cobre scripts/lib/logistic-regression.ts — regressão logística L2 pura,
 * mesmo padrão de efeito plantado forte/fraco de
 * test/calibration-power-report.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fitL2LogisticRegression, predictProbability } from "../scripts/lib/logistic-regression.ts";

describe("fitL2LogisticRegression (#7990)", () => {
  it("lança se X e y tiverem tamanhos diferentes", () => {
    assert.throws(() => fitL2LogisticRegression([[1], [0]], [1]), /X tem 2 linhas, y tem 1/);
  });

  it("lança se X estiver vazio", () => {
    assert.throws(() => fitL2LogisticRegression([], []), /nenhuma linha de treino/);
  });

  it("lança se alguma linha tiver número de colunas diferente das demais", () => {
    assert.throws(() => fitL2LogisticRegression([[1, 0], [1]], [1, 0]), /linha 1 tem 1 colunas, esperado 2/);
  });

  it("efeito FORTE e consistente (feature=1 sempre kept, feature=0 sempre não): coeficiente grande e positivo, converge", () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 200; i++) {
      X.push([1]);
      y.push(1);
      X.push([0]);
      y.push(0);
    }
    const fit = fitL2LogisticRegression(X, y, { l2: 0.01 });
    assert.ok(fit.converged, "deveria convergir antes do teto de iterações");
    assert.ok(fit.coefficients[0] > 3, `coeficiente deveria ser bem positivo (separação quase perfeita), foi ${fit.coefficients[0]}`);
    assert.ok(predictProbability([1], fit) > 0.9, "P(kept|feature=1) deveria ser alta");
    assert.ok(predictProbability([0], fit) < 0.1, "P(kept|feature=0) deveria ser baixa");
  });

  it("efeito FRACO/nulo (feature independente de kept): coeficiente perto de 0", () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 400; i++) {
      X.push([i % 2]);
      y.push(Math.floor(i / 2) % 2); // alterna independentemente de X
    }
    const fit = fitL2LogisticRegression(X, y, { l2: 0.01 });
    assert.ok(Math.abs(fit.coefficients[0]) < 0.3, `coeficiente deveria ficar perto de 0 sem sinal real, foi ${fit.coefficients[0]}`);
  });

  it("regularização L2 mais forte encolhe o coeficiente pro mesmo dataset (efeito real, não bug)", () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 300; i++) {
      X.push([1]);
      y.push(i < 260 ? 1 : 0); // 86.7% kept quando feature=1
      X.push([0]);
      y.push(i < 200 ? 1 : 0); // 66.7% kept quando feature=0
    }
    const weak = fitL2LogisticRegression(X, y, { l2: 0.001 });
    const strong = fitL2LogisticRegression(X, y, { l2: 1.0 });
    assert.ok(
      Math.abs(strong.coefficients[0]) < Math.abs(weak.coefficients[0]),
      `l2 mais forte deveria encolher mais o coeficiente: fraco=${weak.coefficients[0]} forte=${strong.coefficients[0]}`,
    );
  });

  it("multivariado: 2 colunas, cada uma com efeito independente, coeficientes distintos e no sinal certo", () => {
    const X: number[][] = [];
    const y: number[] = [];
    // feature 0 forte e positiva, feature 1 fraca e negativa
    for (let i = 0; i < 150; i++) {
      X.push([1, 0]);
      y.push(1);
      X.push([0, 1]);
      y.push(i % 4 === 0 ? 1 : 0); // kept raro quando só feature 1
      X.push([0, 0]);
      y.push(i % 2);
    }
    const fit = fitL2LogisticRegression(X, y, { l2: 0.01 });
    assert.equal(fit.coefficients.length, 2);
    assert.ok(fit.coefficients[0] > 0, "feature 0 (forte, positiva) deveria ter coeficiente positivo");
    assert.ok(fit.coefficients[1] < fit.coefficients[0], "feature 1 (fraca) deveria pesar menos que feature 0");
  });

  it("determinístico: mesma entrada produz exatamente o mesmo resultado 2x seguidas", () => {
    const X = [[1, 0], [0, 1], [1, 1], [0, 0]];
    const y = [1, 0, 1, 0];
    const a = fitL2LogisticRegression(X, y);
    const b = fitL2LogisticRegression(X, y);
    assert.deepEqual(a, b);
  });
});

describe("predictProbability (#7990)", () => {
  it("retorna 0.5 quando intercepto e coeficientes são 0", () => {
    const fit = { intercept: 0, coefficients: [0, 0], iterations: 0, converged: true };
    assert.equal(predictProbability([1, 1], fit), 0.5);
  });
});
