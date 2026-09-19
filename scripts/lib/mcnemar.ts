/**
 * mcnemar.ts (#8413 — Fase 0 do epic #8412)
 *
 * Teste de McNemar pra comparar dois classificadores sobre o MESMO gabarito
 * (par a par, cada item classificado por A e por B contra o rótulo verdade).
 * Usa a tabela 2x2 de discordância (A certo/B errado vs. A errado/B certo) —
 * mesma estatística citada no #8211 (p=0,008 no gabarito n=22).
 *
 * Aproximação chi-quadrado com correção de continuidade de Yates (padrão
 * pra n pequeno-moderado, evita inflar significância). Quando `b + c < 25`
 * (célula pequena), o exato (distribuição binomial) é mais confiável — este
 * módulo expõe os dois, o chamador escolhe qual reportar.
 */

export interface McNemarInput {
  /** Nº de itens em que A acertou e B errou. */
  aCorrectBWrong: number;
  /** Nº de itens em que A errou e B acertou. */
  aWrongBCorrect: number;
}

export interface McNemarResult {
  b: number;
  c: number;
  /** Estatística qui-quadrado com correção de Yates. NaN se b+c===0 (sem discordância — teste não se aplica). */
  chiSquare: number;
  /** p-valor aproximado (1 grau de liberdade), via chi-quadrado com Yates. */
  pValueChiSquare: number;
  /** p-valor exato (teste binomial bicaudal) — mais confiável pra b+c pequeno. */
  pValueExact: number;
}

/** Regularized incomplete gamma function complement — usado pra CDF da chi-quadrado (1 gl = erro function). */
function chiSquarePValue1Dof(chiSq: number): number {
  if (!Number.isFinite(chiSq) || chiSq < 0) return 1;
  // Para 1 grau de liberdade, P(X > x) = erfc(sqrt(x/2))
  return erfc(Math.sqrt(chiSq / 2));
}

/** Complementary error function — aproximação numérica (Abramowitz & Stegun 7.1.26). */
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return y * Math.exp(-x * x);
}

function binomialCoefficient(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

/** P-valor exato bicaudal do teste binomial de McNemar: sob H0, b ~ Binomial(b+c, 0.5). */
function exactBinomialTwoTailed(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let p = 0;
  for (let i = 0; i <= k; i++) {
    p += binomialCoefficient(n, i) * 0.5 ** n;
  }
  return Math.min(1, 2 * p);
}

export function mcnemarTest(input: McNemarInput): McNemarResult {
  const { aCorrectBWrong: b, aWrongBCorrect: c } = input;
  if (b + c === 0) {
    return { b, c, chiSquare: NaN, pValueChiSquare: 1, pValueExact: 1 };
  }
  const chiSquare = (Math.abs(b - c) - 1) ** 2 / (b + c);
  return {
    b,
    c,
    chiSquare,
    pValueChiSquare: chiSquarePValue1Dof(chiSquare),
    pValueExact: exactBinomialTwoTailed(b, c),
  };
}
