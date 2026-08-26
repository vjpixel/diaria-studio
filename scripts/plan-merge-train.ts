#!/usr/bin/env npx tsx
/**
 * plan-merge-train.ts (#6300)
 *
 * CLI de PLANEJAMENTO (read-only, sem mutação de git/gh) pro trem de merge
 * — ver `scripts/lib/merge-train.ts` pro miolo puro e o cabeçalho daquele
 * arquivo pro racional completo. A EXECUÇÃO viva (merge em cadeia de
 * integração, PR-trem, polling de CI, merge sob lock) mora em
 * `scripts/run-merge-train.ts` — autorizada pelo editor em 26/08/2026 (ver
 * cabeçalho de `scripts/lib/merge-train.ts`); este script continua
 * existindo como o passo SÓ-LEITURA (mostra o plano sem executar nada),
 * útil pra inspecionar antes de rodar o executor de verdade.
 *
 * Uso:
 *   npx tsx scripts/plan-merge-train.ts --prs 6340,6341,6345
 *   npx tsx scripts/plan-merge-train.ts --prs 6340,6341,6345 --max-batch-size 3
 *   npx tsx scripts/plan-merge-train.ts --open   # descobre PRs abertos com Gate 2 condição 1 verde
 *
 * Exit codes:
 *   0 = plano impresso (mesmo que resulte em 0 PRs elegíveis — não é erro)
 *   1 = `gh` indisponível ou falhou pra pelo menos 1 PR (fail-hard — um
 *       plano parcial por PR que falhou silenciosamente é pior que nenhum
 *       plano, #738: fail-fast, nunca stall/degradar em silêncio)
 *   2 = uso inválido (nem --prs nem --open; --prs vazio ou com token
 *       inválido; --max-batch-size inválido)
 */

import { isMainModule, parseArgs, getIntArg } from "./lib/cli-args.ts";
import { composeTrainBatches, worstCaseCiRuns, type TrainCandidate } from "./lib/merge-train.ts";
import { filesForPr, discoverOpenPrs, parsePrsArg } from "./lib/merge-train-discovery.ts";

const DEFAULT_MAX_BATCH_SIZE = 3; // "K não deve ser grande. Começar em 3." — issue #6300

export function printPlan(candidates: TrainCandidate[], maxBatchSize: number): string {
  const batches = composeTrainBatches(candidates, maxBatchSize);
  const lines: string[] = [];
  lines.push(`plan-merge-train: ${candidates.length} PR(s) candidato(s), maxBatchSize=${maxBatchSize}`);
  lines.push(`${batches.length} lote(s) composto(s):`);
  for (const [i, batch] of batches.entries()) {
    const label = batch.prs.length === 1 ? "singleton (caminho de hoje, sem trem)" : `trem de ${batch.prs.length}`;
    lines.push(`  lote ${i + 1} [${label}]: PRs ${batch.prs.map((n) => `#${n}`).join(", ")}`);
  }
  const runsHoje = candidates.length;
  const runsComTrem = batches.length; // 1 run por lote no caminho feliz (sem vermelho)
  lines.push(
    `runs de CI: ${runsHoje} hoje (1 por PR) → ${runsComTrem} com o trem, caminho feliz` +
      ` (pior caso por lote de tamanho N: worstCaseCiRuns(N), ver scripts/lib/merge-train.ts)`,
  );
  const worstTotal = batches.reduce((sum, b) => sum + worstCaseCiRuns(b.prs.length), 0);
  lines.push(`pior caso total (todo lote vermelho até o piso): ${worstTotal} runs`);
  return lines.join("\n");
}

async function main() {
  const cwd = process.cwd();
  const argv = process.argv.slice(2);
  const { values, flags } = parseArgs(argv);

  let maxBatchSize: number;
  try {
    // getIntArg LANÇA em input inválido/não-inteiro (em vez de devolver
    // NaN) — é exatamente a garantia que faltava aqui (achado do fleet
    // review, PR #6361: `Number("abc")` → NaN → `NaN < 1` é `false` em
    // JS → o teto K ficava DESLIGADO em silêncio, todo candidato caía no
    // mesmo lote sem limite).
    maxBatchSize = getIntArg(argv, "max-batch-size", { min: 1 }) ?? DEFAULT_MAX_BATCH_SIZE;
  } catch (err) {
    console.error(`plan-merge-train: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }

  let prNumbers: number[];
  if (values.prs) {
    try {
      prNumbers = parsePrsArg(values.prs);
    } catch (err) {
      console.error(`plan-merge-train: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
      return;
    }
    if (prNumbers.length === 0) {
      console.error("plan-merge-train: --prs precisa de ao menos 1 número válido (ex: --prs 100,101)");
      process.exit(2);
      return;
    }
  } else if (flags.has("open")) {
    try {
      prNumbers = discoverOpenPrs(cwd, "plan-merge-train");
    } catch (err) {
      console.error(`plan-merge-train: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
  } else {
    console.error("plan-merge-train: passe --prs N,M,... ou --open (descobre PRs abertos)");
    process.exit(2);
    return;
  }

  if (prNumbers.length === 0) {
    console.log("plan-merge-train: nenhum PR candidato — nada a planejar.");
    process.exit(0);
    return;
  }

  // Acumula falhas por PR em vez de abortar na 1ª (achado do fleet review,
  // PR #6361): se 2 PRs da lista já fecharam/mergearam mid-sessão — cenário
  // real numa máquina com sessões overnight/develop concorrentes mergeando
  // — o operador via só o 1º erro, corrigia, rerodava, e só então via o 2º.
  const candidates: TrainCandidate[] = [];
  const failures: string[] = [];
  for (const pr of prNumbers) {
    try {
      candidates.push({ pr, files: filesForPr(pr, cwd) });
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`plan-merge-train: ${f}`);
    process.exit(1);
    return;
  }

  console.log(printPlan(candidates, maxBatchSize));
}

if (isMainModule(import.meta.url)) {
  main();
}
