/**
 * scripts/lib/logistic-regression.ts (#7990, Camada 2 da #7972 — regressão de
 * verdade, deferida da Fase 2/#7976)
 *
 * Regressão logística multivariada com regularização L2, ajustada por
 * gradiente descendente em batch — puro, determinístico (sem `Math.random`,
 * sem dependência externa), usado por `calibrate-scoring-weights.ts` pra
 * aprender um coeficiente por feature booleana candidata a partir dos
 * eventos rotulados de `analyze-destaque-overrides.ts`.
 *
 * Por que gradiente descendente em vez de forma fechada (Newton-Raphson/
 * IRLS): o design pede "≤15 coeficientes" — escala pequena o bastante pra
 * gradiente descendente convergir de forma confiável e determinística sem
 * inversão de matriz (que precisaria de uma lib de álgebra linear, contra o
 * princípio do projeto de não adicionar dependência nova pra scripts
 * internos quando um algoritmo simples resolve). Regularização L2 aplicada
 * só aos coeficientes, nunca ao intercepto (convenção padrão — o intercepto
 * captura a taxa base, não deve encolher em direção a 0).
 */

/**
 * Default MEDIDO contra o corpus real (105 edições, 11/09/2026), não
 * escolhido a priori — as features candidatas são indicadores 0/1
 * NÃO padronizados (nunca centralizados/escalados pra variância 1), então
 * o coeficiente log-odds "natural" de um efeito real vive tipicamente na
 * faixa -0.5..+0.5. Com `l2=1.0` (a 1ª tentativa), o gradiente descendente
 * convergia sempre pra um coeficiente ~15-60× menor que o MLE não-
 * regularizado (`has_official_link`: -0.3462 sem regularização → -0.0060
 * com `l2=1.0`, mesmo dataset, mesmas iterações) — regularização forte o
 * bastante pra apagar qualquer sinal real antes de chegar no gate de
 * pontos (`round(coef * pointsPerLogOdds)` sempre dava 0). `l2=0.01`
 * encolhe de forma real mas preserva magnitude suficiente pra um efeito
 * genuíno sobreviver (mesmo teste: coeficiente -0.2324, ~67% do MLE não-
 * regularizado) — ainda protege contra overfitting em feature com pouca
 * variância, só não elimina o sinal por construção. Documentado como
 * trade-off explícito no relatório final da #7972 (decisão sem pergunta
 * ao editor por não afetar leitor/produção — puramente estatístico,
 * critério 4 de "Perguntar é exceção" não se aplica: a resposta não muda
 * o QUE é proposto, só garante que algo seja proposto quando há sinal).
 */
const DEFAULT_L2 = 0.01;
const DEFAULT_LEARNING_RATE = 0.1;
const DEFAULT_MAX_ITERATIONS = 8000;
/** Norma do gradiente abaixo da qual consideramos convergido — parada antecipada, não só o teto de iterações. */
const DEFAULT_TOLERANCE = 1e-7;

export interface LogisticRegressionOptions {
  /** Força da regularização L2 sobre os coeficientes (não o intercepto). */
  l2?: number;
  learningRate?: number;
  maxIterations?: number;
  /** Norma do gradiente (intercepto + coeficientes) abaixo da qual para antes do teto de iterações. */
  tolerance?: number;
}

export interface LogisticRegressionResult {
  intercept: number;
  /** Paralelo às colunas de `X` (mesma ordem que o chamador passou). `readonly` — resultado de fit é um snapshot, não deve ser mutado por quem consome (achado de review do #7990, type-design). */
  coefficients: readonly number[];
  iterations: number;
  /** `true` se parou por convergência (norma do gradiente < tolerance), `false` se esgotou `maxIterations`. */
  converged: boolean;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Ajusta intercepto + 1 coeficiente por coluna de `X` prevendo `y` (rótulo
 * binário 0/1) via gradiente descendente em batch com penalidade L2.
 * `X[i]` e `y[i]` devem ter o mesmo índice `i` (linha i = evento i).
 *
 * Lança se `X`/`y` tiverem tamanhos diferentes, se `X` estiver vazio, ou se
 * alguma linha de `X` tiver número de colunas diferente das demais — nunca
 * ajusta silenciosamente sobre dado malformado (mesma disciplina fail-hard
 * dos demais módulos desta camada, ex: `calibration-evidence-report.ts`).
 */
export function fitL2LogisticRegression(
  X: ReadonlyArray<ReadonlyArray<number>>,
  y: ReadonlyArray<number>,
  opts: LogisticRegressionOptions = {},
): LogisticRegressionResult {
  if (X.length !== y.length) {
    throw new Error(`fitL2LogisticRegression: X tem ${X.length} linhas, y tem ${y.length} — precisam ser iguais.`);
  }
  if (X.length === 0) {
    throw new Error("fitL2LogisticRegression: nenhuma linha de treino (X vazio) — não há o que ajustar.");
  }
  const numFeatures = X[0].length;
  for (let i = 0; i < X.length; i++) {
    if (X[i].length !== numFeatures) {
      throw new Error(`fitL2LogisticRegression: linha ${i} tem ${X[i].length} colunas, esperado ${numFeatures} (mesmo de X[0]).`);
    }
  }
  // Achado de review do #7990 (silent-failure-hunter, P3): rótulo fora de
  // {0,1} produz um fit numericamente "válido" mas semanticamente sem
  // sentido, sem nenhum erro — mesma disciplina fail-hard das checagens de
  // forma acima.
  for (let i = 0; i < y.length; i++) {
    if (y[i] !== 0 && y[i] !== 1) {
      throw new Error(`fitL2LogisticRegression: y[${i}] = ${y[i]} — rótulo precisa ser 0 ou 1 (binário).`);
    }
  }

  const { l2 = DEFAULT_L2, learningRate = DEFAULT_LEARNING_RATE, maxIterations = DEFAULT_MAX_ITERATIONS, tolerance = DEFAULT_TOLERANCE } = opts;
  // Achado de review do #7990 (silent-failure-hunter, P3): `maxIterations<=0`
  // ou `learningRate<=0` produzia um resultado "sem efeito" (coeficientes em
  // 0, `converged:false`) indistinguível de "não convergiu depois de
  // trabalho real" — nunca sinalizava "nunca rodou de verdade".
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`fitL2LogisticRegression: maxIterations precisa ser um inteiro >= 1, recebido ${maxIterations}.`);
  }
  if (!(learningRate > 0)) {
    throw new Error(`fitL2LogisticRegression: learningRate precisa ser > 0, recebido ${learningRate}.`);
  }

  let intercept = 0;
  const coefficients = new Array(numFeatures).fill(0);
  const n = X.length;
  let iterations = 0;
  let converged = false;

  for (; iterations < maxIterations; iterations++) {
    let gradIntercept = 0;
    const gradCoef = new Array(numFeatures).fill(0);

    for (let i = 0; i < n; i++) {
      let z = intercept;
      for (let j = 0; j < numFeatures; j++) z += X[i][j] * coefficients[j];
      const p = sigmoid(z);
      const err = p - y[i];
      gradIntercept += err;
      for (let j = 0; j < numFeatures; j++) gradCoef[j] += err * X[i][j];
    }

    gradIntercept /= n;
    for (let j = 0; j < numFeatures; j++) {
      gradCoef[j] = gradCoef[j] / n + l2 * coefficients[j];
    }

    intercept -= learningRate * gradIntercept;
    let gradNormSq = gradIntercept * gradIntercept;
    for (let j = 0; j < numFeatures; j++) {
      coefficients[j] -= learningRate * gradCoef[j];
      gradNormSq += gradCoef[j] * gradCoef[j];
    }

    if (Math.sqrt(gradNormSq) < tolerance) {
      converged = true;
      iterations++; // conta esta iteração antes de sair, pro número refletir quantas rodaram de fato
      break;
    }
  }

  // Achado de review do #7990 (silent-failure-hunter, P2): divergência
  // (NaN/Infinity) fica indistinguível de "não convergiu em tempo" sem esta
  // checagem — `Math.sqrt(NaN) < tolerance` é `false`, o loop esgota
  // `maxIterations` e devolveria um resultado com coeficientes NaN que
  // nenhum consumidor downstream (ex: `Math.round(NaN * x) === 0` é falso)
  // detecta como inválido. Lança em vez de devolver lixo silencioso — mesma
  // disciplina fail-hard das checagens de forma acima.
  if (!Number.isFinite(intercept) || !coefficients.every(Number.isFinite)) {
    throw new Error(
      `fitL2LogisticRegression: fit divergiu (intercepto=${intercept}, coeficientes=[${coefficients.join(", ")}]) — resultado não-finito após ${iterations} iterações. Tente learningRate menor ou l2 maior.`,
    );
  }

  return { intercept, coefficients, iterations, converged };
}

/** Probabilidade prevista pra 1 linha `x` (mesma ordem de colunas do fit). */
export function predictProbability(x: ReadonlyArray<number>, fit: LogisticRegressionResult): number {
  let z = fit.intercept;
  for (let j = 0; j < x.length; j++) z += x[j] * fit.coefficients[j];
  return sigmoid(z);
}
