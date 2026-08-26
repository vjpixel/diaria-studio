#!/usr/bin/env npx tsx
/**
 * plan-merge-train.ts (#6300)
 *
 * CLI de PLANEJAMENTO (read-only, sem mutação de git/gh) pro trem de merge
 * — ver `scripts/lib/merge-train.ts` pro miolo puro e o cabeçalho daquele
 * arquivo pro racional completo e pro que fica FORA de escopo aqui.
 *
 * O que este script faz: dado um conjunto de PRs abertos que já passaram
 * na condição 1 do Gate 2 (`scripts/check-pr-checks-gate.ts` — CI verde no
 * próprio PR), busca os arquivos tocados por cada um (`gh pr diff --name-only`)
 * e compõe os lotes não-colidentes (`composeTrainBatches`), imprimindo o
 * plano — nunca executa rebase, nunca dispara CI, nunca mergeia.
 *
 * A EXECUÇÃO do plano (rebase em cadeia, 1 run de CI sobre o topo, merge em
 * sequência sob `merge-lock-acquire`) é orquestração viva que muda o
 * comportamento de merge de TODA sessão autônoma concorrente — fica fora
 * deste script até rodar sob o Gate B de blast-radius (cat. D,
 * `.claude/skills/diaria-develop/SKILL.md`) com o editor revisando o
 * diff-walkthrough. Este script é o passo seguro que PODE rodar sozinho:
 * mostra o que o trem faria, sem fazer.
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
 *   2 = uso inválido (nem --prs nem --open, ou --prs vazio)
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { composeTrainBatches, worstCaseCiRuns, type TrainCandidate } from "./lib/merge-train.ts";

const DEFAULT_MAX_BATCH_SIZE = 3; // "K não deve ser grande. Começar em 3." — issue #6300

function runGh(args: string[], cwd: string): { ok: boolean; stdout: string; error?: string } {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return { ok: false, stdout: "", error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, stdout: "", error: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
  }
  return { ok: true, stdout: result.stdout };
}

/** Lista arquivos tocados por um PR, via `gh pr diff N --name-only`. */
function filesForPr(prNumber: number, cwd: string): string[] {
  const res = runGh(["pr", "diff", String(prNumber), "--name-only"], cwd);
  if (!res.ok) {
    throw new Error(`gh pr diff --name-only falhou pro PR #${prNumber}: ${res.error}`);
  }
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Descoberta de PRs candidatos quando `--open` é passado em vez de `--prs`
 * explícito: todo PR aberto cujo Gate 2 condição 1 (`evaluatePrChecksGate`)
 * é `"pass"`. Não checa a condição 2 (threads resolvidas) — isso exige
 * `gh api graphql`, fora do escopo deste planejador read-only; quem for
 * EXECUTAR o trem revalida as duas condições de novo antes de mergear
 * qualquer PR individual, mesmo padrão do Gate 2 de sempre.
 */
function discoverOpenPrs(cwd: string): number[] {
  const res = runGh(["pr", "list", "--state", "open", "--json", "number"], cwd);
  if (!res.ok) {
    throw new Error(`gh pr list falhou: ${res.error}`);
  }
  const parsed: unknown = JSON.parse(res.stdout);
  if (!Array.isArray(parsed)) throw new Error("gh pr list devolveu formato inesperado (não é array)");
  return parsed
    .map((p) => (typeof p === "object" && p !== null && "number" in p ? Number((p as { number: unknown }).number) : NaN))
    .filter((n) => Number.isFinite(n));
}

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
  const { values, flags } = parseArgs(process.argv.slice(2));
  const maxBatchSize = values["max-batch-size"] ? Number(values["max-batch-size"]) : DEFAULT_MAX_BATCH_SIZE;

  let prNumbers: number[];
  if (values.prs) {
    prNumbers = values.prs
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    if (prNumbers.length === 0) {
      console.error("plan-merge-train: --prs precisa de ao menos 1 número válido (ex: --prs 100,101)");
      process.exit(2);
    }
  } else if (flags.has("open")) {
    try {
      prNumbers = discoverOpenPrs(cwd);
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

  const candidates: TrainCandidate[] = [];
  for (const pr of prNumbers) {
    try {
      candidates.push({ pr, files: filesForPr(pr, cwd) });
    } catch (err) {
      console.error(`plan-merge-train: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
  }

  console.log(printPlan(candidates, maxBatchSize));
}

if (isMainModule(import.meta.url)) {
  main();
}
