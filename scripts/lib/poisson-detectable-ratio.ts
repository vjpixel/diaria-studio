/**
 * Menor razão detectável entre duas taxas de Poisson independentes, pelo
 * teste exato condicional (o mesmo método de `poisson.test()` de duas
 * amostras do R; ver Gu, Ng, Tang & Schucany 2008, "Testing the Ratio of Two
 * Poisson Rates", pro tratamento padrão) — issue #5651.
 *
 * ## Método
 *
 * Sejam `X1 ~ Poisson(λ1)` e `X2 ~ Poisson(λ2)` independentes, com
 * `λ1 = n0` (contagem esperada do braço de referência) e `λ2 = n0 * ratio`.
 * Pela propriedade de superposição de Poissons independentes,
 * `N = X1 + X2 ~ Poisson(λ1 + λ2) = Poisson(n0 * (1 + ratio))`, e
 * condicionado em `N`, `X1 | N ~ Binomial(N, p = λ1/(λ1+λ2) = 1/(1+ratio))`.
 * Isso reduz "duas taxas de Poisson são iguais?" a "essa fração binomial é
 * 0,5?" — um teste exato binomial bicaudal "equal-tailed" em `X1 | N`, com
 * H0 em `p = 0,5` (ratio = 1).
 *
 * O poder do teste pra uma razão `ratio` é obtido marginalizando sobre a
 * distribuição (também exata) de `N` sob H1 — nenhuma aproximação normal em
 * ponto nenhum da cadeia, por isso "Poisson exato".
 *
 * Toda função aqui é pura (sem I/O) e testável com `node:test`.
 */

/** Região crítica bicaudal de um teste exato binomial contra `p = 0,5`. */
export interface CriticalRegion {
  /** Rejeita H0 se X <= lower. `-1` quando nenhum k satisfaz o nível (n
   *  pequeno demais pro alpha pedido — a cauda inferior fica vazia). */
  lower: number;
  /** Rejeita H0 se X >= upper. Por simetria, `upper = n - lower` (`n+1`
   *  quando `lower === -1`, o que nunca é atingível — região vazia). */
  upper: number;
}

/**
 * Densidade de Poisson(λ) em `k = 0..maxK`.
 *
 * A recorrência (`pmf[k] = pmf[k-1] * λ / k`) evita fatorial/exponencial
 * isolado gigante, mas rodar a MULTIPLICAÇÃO em espaço linear tem uma
 * armadilha: pra λ grande (> ~708, onde `exp(-λ)` já estoura o menor double
 * representável), `pmf[0]` vira exatamente `0`, e como `0 * qualquer coisa
 * = 0`, a recorrência linear fica presa em zero pro resto do vetor — mesmo
 * nos `k` perto da moda, onde a densidade real está longe de zero (achado
 * pelo teste de `poissonTwoRatePower` com n0 grande, #5651). A recorrência
 * roda em ESPAÇO LOG (`logPmf[k] = logPmf[k-1] + ln(λ) - ln(k)`, que nunca
 * "estoura" porque soma/subtrai em vez de multiplicar) e só exponencia no
 * fim — cada `k` fica correto independente dos vizinhos, e um valor que
 * realmente deveria arredondar pra `0` (cauda extrema) ainda arredonda,
 * sem contaminar os `k` que não deveriam.
 */
export function poissonPmfArray(maxK: number, lambda: number): number[] {
  if (maxK < 0) throw new Error(`maxK deve ser >= 0, recebido ${maxK}`);
  if (!(lambda > 0)) throw new Error(`lambda deve ser > 0, recebido ${lambda}`);
  const logLambda = Math.log(lambda);
  const logPmf = new Array<number>(maxK + 1);
  logPmf[0] = -lambda;
  for (let k = 1; k <= maxK; k++) {
    logPmf[k] = logPmf[k - 1] + logLambda - Math.log(k);
  }
  return logPmf.map(Math.exp);
}

/**
 * Densidade de Binomial(n, p) em `k = 0..n`. Mesma armadilha e mesma
 * correção de `poissonPmfArray`: `(1-p)^n` pode estourar o menor double
 * representável pra `n` grande (o cross-check de `minDetectableRatio` contra
 * a aproximação de Wald usa `n0` na casa do milhar, e `poissonTwoRatePower`
 * cresce `N` proporcionalmente) — a recorrência roda em espaço log
 * (`logPmf[k] = logPmf[k-1] + ln((n-k+1)/k) + ln(p/(1-p))`) e só exponencia
 * no fim.
 */
export function binomialPmfArray(n: number, p: number): number[] {
  if (n < 0) throw new Error(`n deve ser >= 0, recebido ${n}`);
  if (!(p > 0) || !(p < 1)) throw new Error(`p deve estar em (0,1), recebido ${p}`);
  const logOdds = Math.log(p) - Math.log(1 - p);
  const logPmf = new Array<number>(n + 1);
  logPmf[0] = n * Math.log(1 - p);
  for (let k = 1; k <= n; k++) {
    logPmf[k] = logPmf[k - 1] + Math.log((n - k + 1) / k) + logOdds;
  }
  return logPmf.map(Math.exp);
}

/**
 * Região crítica exata "equal-tailed" (cada cauda com massa <= alpha/2) de
 * um teste bicaudal contra `p = 0,5` em Binomial(n, 0,5). Explora a simetria
 * de `p = 0,5` (`pmf[k] = pmf[n-k]`) — só varre a cauda inferior e espelha
 * pra superior, em vez de duas varreduras.
 *
 * @pure
 */
export function equalTailedBinomialCriticalRegion(n: number, alpha: number): CriticalRegion {
  if (n < 0) throw new Error(`n deve ser >= 0, recebido ${n}`);
  if (!(alpha > 0) || !(alpha < 1)) throw new Error(`alpha deve estar em (0,1), recebido ${alpha}`);
  const half = alpha / 2;
  const pmf = binomialPmfArray(n, 0.5);
  let cum = 0;
  let lower = -1;
  for (let k = 0; k <= n; k++) {
    cum += pmf[k];
    if (cum <= half) {
      lower = k;
    } else {
      break;
    }
  }
  return { lower, upper: n - lower };
}

/**
 * Poder exato do teste condicional (comparação de duas taxas de Poisson,
 * ver docstring do módulo) pra uma razão `ratio = λ2/λ1 >= 1`, com
 * `λ1 = n0` fixo. Marginaliza sobre `N` (que sob H1 é `Poisson(n0*(1+ratio))`)
 * até `opts.maxN` (default: cauda com massa desprezível — média + 12 desvios
 * + folga).
 *
 * @pure
 */
export function poissonTwoRatePower(
  n0: number,
  ratio: number,
  alpha: number,
  opts: { maxN?: number } = {},
): number {
  if (!(n0 > 0)) throw new Error(`n0 deve ser > 0, recebido ${n0}`);
  if (!(ratio >= 1)) throw new Error(`ratio deve ser >= 1, recebido ${ratio}`);
  const meanN = n0 * (1 + ratio);
  const maxN = opts.maxN ?? Math.ceil(meanN + 12 * Math.sqrt(meanN) + 50);
  const nPmf = poissonPmfArray(maxN, meanN);
  const p = 1 / (1 + ratio);

  let power = 0;
  for (let N = 1; N <= maxN; N++) {
    const region = equalTailedBinomialCriticalRegion(N, alpha);
    // Região vazia (n pequeno demais pro alpha) -> nunca rejeita nesse N.
    if (region.lower < 0 && region.upper > N) continue;
    const bpmf = binomialPmfArray(N, p);
    let rejectProb = 0;
    for (let k = 0; k <= region.lower; k++) rejectProb += bpmf[k];
    for (let k = region.upper; k <= N; k++) rejectProb += bpmf[k];
    power += nPmf[N] * rejectProb;
  }
  return power;
}

/**
 * Menor `ratio >= 1` cujo poder (`poissonTwoRatePower`) atinge `targetPower`
 * no nível `alpha` — busca binária, já que o poder é monótono crescente em
 * `ratio` (razão maior = mais fácil de detectar).
 *
 * @throws se `poissonTwoRatePower` no teto `opts.maxRatio` (default 5) ainda
 *   não atinge `targetPower` — sinal de que o teto está baixo demais pro
 *   `n0`/`alpha`/`targetPower` pedidos, nunca retorna um valor sem sentido
 *   por padrão.
 */
export function minDetectableRatio(
  n0: number,
  alpha: number,
  targetPower: number,
  opts: { tolerance?: number; maxRatio?: number; maxN?: number } = {},
): number {
  if (!(targetPower > 0) || !(targetPower < 1)) {
    throw new Error(`targetPower deve estar em (0,1), recebido ${targetPower}`);
  }
  const tolerance = opts.tolerance ?? 1e-4;
  const maxRatio = opts.maxRatio ?? 5;

  let lo = 1 + 1e-6;
  let hi = maxRatio;
  const hiPower = poissonTwoRatePower(n0, hi, alpha, { maxN: opts.maxN });
  if (hiPower < targetPower) {
    throw new Error(
      `razão detectável não encontrada até maxRatio=${maxRatio} (poder ${(hiPower * 100).toFixed(1)}% < ` +
        `${(targetPower * 100).toFixed(0)}%) — aumente opts.maxRatio.`,
    );
  }

  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2;
    const midPower = poissonTwoRatePower(n0, mid, alpha, { maxN: opts.maxN });
    if (midPower >= targetPower) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}
