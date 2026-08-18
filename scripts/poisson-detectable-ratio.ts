/**
 * CLI — menor razão entre duas taxas de Poisson ainda detectável com poder
 * estatístico dado, pelo teste exato condicional (ver docstring de
 * `scripts/lib/poisson-detectable-ratio.ts` pro método). Escrito pra
 * recalcular as células "razão detectável" da §1.2 do protocolo do teste
 * 2608 (issue #5651) — antes disto elas vieram de interpolação linear entre
 * duas linhas da tabela, não do mesmo método Poisson exato do resto dela.
 *
 * ```bash
 * npx tsx scripts/poisson-detectable-ratio.ts --n 88 --alpha 0.05 --power 0.8
 * npx tsx scripts/poisson-detectable-ratio.ts --n 88 --alpha 0.0167 --power 0.8
 * npx tsx scripts/poisson-detectable-ratio.ts --n 88 --alpha 0.05 --power 0.8 --json
 * ```
 *
 * `--n` (contagem esperada por braço sob H0/referência) é obrigatório.
 * `--alpha` default 0,05 (bicaudal). `--power` default 0,8.
 *
 * Puramente cálculo local — nenhuma chamada de rede/API.
 */

import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { minDetectableRatio, poissonTwoRatePower } from "./lib/poisson-detectable-ratio.ts";

function parseRequiredFloat(argv: string[], key: string, opts: { example: string }): number {
  const raw = getStringArg(argv, key, opts);
  if (raw === undefined) {
    throw new Error(`--${key} é obrigatório (ex: --${key} ${opts.example}).`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${key} deve ser um número, recebido "${raw}".`);
  }
  return value;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const json = argv.includes("--json");
  let n0: number;
  let alpha: number;
  let power: number;
  try {
    n0 = parseRequiredFloat(argv, "n", { example: "88" });
    const alphaRaw = getStringArg(argv, "alpha", { example: "0.05" });
    alpha = alphaRaw === undefined ? 0.05 : Number(alphaRaw);
    const powerRaw = getStringArg(argv, "power", { example: "0.8" });
    power = powerRaw === undefined ? 0.8 : Number(powerRaw);
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
      throw new Error(`--alpha deve estar em (0,1), recebido "${alphaRaw}".`);
    }
    if (!Number.isFinite(power) || power <= 0 || power >= 1) {
      throw new Error(`--power deve estar em (0,1), recebido "${powerRaw}".`);
    }
    if (n0 <= 0) {
      throw new Error(`--n deve ser > 0, recebido ${n0}.`);
    }
  } catch (err) {
    console.error(`erro: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let ratio: number;
  try {
    ratio = minDetectableRatio(n0, alpha, power);
  } catch (err) {
    console.error(`erro: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const achievedPower = poissonTwoRatePower(n0, ratio, alpha);

  if (json) {
    console.log(JSON.stringify({ n0, alpha, targetPower: power, ratio, achievedPower }, null, 2));
  } else {
    console.log(
      `n0=${n0} · alpha=${alpha} (bicaudal) · poder alvo=${(power * 100).toFixed(0)}% -> ` +
        `razão mínima detectável ≈ ${ratio.toFixed(3)}× (poder atingido ${(achievedPower * 100).toFixed(1)}%)`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
