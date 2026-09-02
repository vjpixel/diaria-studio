#!/usr/bin/env npx tsx
/**
 * run-merge-train.ts (#6300)
 *
 * CLI de EXECUÇÃO viva do trem de merge — autorizado pelo editor em
 * 26/08/2026 (ver cabeçalho de `scripts/lib/merge-train.ts` pro registro
 * completo da decisão: rollout nas 3 skills, default ativo, 1 commit
 * squash por lote, teste ao vivo autorizado com cautela).
 *
 * Diferente de `scripts/plan-merge-train.ts` (read-only, só mostra o
 * plano), este script MUTA: monta branch de integração, abre PR-trem,
 * espera CI, faz squash-merge sob merge lock, fecha as PRs originais do
 * lote. Ver `scripts/lib/merge-train-live.ts` pra orquestração completa
 * (bisecção em cascata, degradação pro merge solo no piso, timeout de CI
 * tratado como vermelho).
 *
 * `--session-id` é OBRIGATÓRIO e não é auto-injetado (diferente de uma
 * chamada Bash direta desta sessão) — este processo chama
 * `session-registry.ts merge-lock-acquire`/`release` como SUBPROCESSO
 * PRÓPRIO, fora do alcance do hook `inject-session-id.mjs` (que só
 * intercepta chamadas Bash da sessão, não spawns internos deste script).
 * Quem invoca precisa passar o `session_id` da PRÓPRIA sessão explicitamente.
 *
 * Uso:
 *   npx tsx scripts/run-merge-train.ts --session-id <uuid> --kind develop --prs 6340,6341,6345
 *   npx tsx scripts/run-merge-train.ts --session-id <uuid> --kind overnight --open
 *   npx tsx scripts/run-merge-train.ts --session-id <uuid> --kind develop --prs 6340,6341 --max-batch-size 3 --ci-timeout-ms 1800000
 *
 * Exit codes:
 *   0 = todos os PRs candidatos terminaram em `merged`/`solo-merged`
 *   1 = pelo menos 1 terminou `solo-failed`, `lock-blocked` OU
 *       `indeterminate` (falha real de merge, ou lote sem resolução — não
 *       "vermelho de CI", que sempre resolve via bisecção até o piso;
 *       `lock-blocked` é um lote que provou passar junto no CI mas não
 *       conseguiu a janela de merge lock após retries, ou falhou na
 *       revalidação de Gate 2; `indeterminate` (#7064) é um lote cujas 2
 *       execuções de reconfirmação discordaram — assinatura da corrida do
 *       #7060, nunca reprovação — precisa de nova invocação do trem, não
 *       de um fixer — ver `scripts/lib/merge-train-live.ts`)
 *       OU `gh`/preparação falhou antes de processar qualquer lote
 *   2 = uso inválido (--session-id/--kind ausentes; nem --prs nem --open;
 *       --prs vazio/token inválido; --max-batch-size inválido)
 */

import { isMainModule, parseArgs, getIntArg, getStringArg } from "./lib/cli-args.ts";
import { composeTrainBatches, type TrainCandidate, type TrainPrInfo } from "./lib/merge-train.ts";
import { filesForPr, discoverOpenPrs, parsePrsArg } from "./lib/merge-train-discovery.ts";
import { createRealTrainRunner, fetchTrainPrInfo, runMergeTrain, type TrainBatchOutcome } from "./lib/merge-train-live.ts";

const DEFAULT_MAX_BATCH_SIZE = 3; // "K não deve ser grande. Começar em 3." — issue #6300
const VALID_KINDS = ["overnight", "develop", "continuo"] as const;

function printOutcome(o: TrainBatchOutcome): string {
  const prs = o.batch.prs.map((n) => `#${n}`).join(", ");
  return `  [${o.status}] lote ${prs} — ${o.detail}`;
}

async function main() {
  const cwd = process.cwd();
  const argv = process.argv.slice(2);
  const { values, flags } = parseArgs(argv);

  let sessionId: string | undefined;
  let kind: string | undefined;
  let maxBatchSize: number;
  let ciTimeoutMs: number | undefined;
  let ciPollIntervalMs: number | undefined;
  try {
    sessionId = getStringArg(argv, "session-id", { example: "8cfde540-..." });
    kind = getStringArg(argv, "kind", { example: "develop" });
    maxBatchSize = getIntArg(argv, "max-batch-size", { min: 1 }) ?? DEFAULT_MAX_BATCH_SIZE;
    ciTimeoutMs = getIntArg(argv, "ci-timeout-ms", { min: 1000 });
    ciPollIntervalMs = getIntArg(argv, "ci-poll-interval-ms", { min: 1000 });
  } catch (err) {
    console.error(`run-merge-train: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }

  if (!sessionId) {
    console.error("run-merge-train: --session-id é obrigatório (não é auto-injetado — ver cabeçalho do arquivo).");
    process.exit(2);
    return;
  }
  if (!kind || !(VALID_KINDS as readonly string[]).includes(kind)) {
    console.error(`run-merge-train: --kind é obrigatório e precisa ser um de: ${VALID_KINDS.join(", ")}`);
    process.exit(2);
    return;
  }

  let prNumbers: number[];
  if (values.prs) {
    try {
      prNumbers = parsePrsArg(values.prs);
    } catch (err) {
      console.error(`run-merge-train: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
      return;
    }
    if (prNumbers.length === 0) {
      console.error("run-merge-train: --prs precisa de ao menos 1 número válido (ex: --prs 100,101)");
      process.exit(2);
      return;
    }
  } else if (flags.has("open")) {
    try {
      prNumbers = discoverOpenPrs(cwd, "run-merge-train");
    } catch (err) {
      console.error(`run-merge-train: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
  } else {
    console.error("run-merge-train: passe --prs N,M,... ou --open (descobre PRs abertos)");
    process.exit(2);
    return;
  }

  if (prNumbers.length === 0) {
    console.log("run-merge-train: nenhum PR candidato — nada a fazer.");
    process.exit(0);
    return;
  }

  const candidates: TrainCandidate[] = [];
  const prInfos: TrainPrInfo[] = [];
  const runner = createRealTrainRunner(cwd);
  const failures: string[] = [];
  for (const pr of prNumbers) {
    try {
      candidates.push({ pr, files: filesForPr(pr, cwd) });
      prInfos.push(fetchTrainPrInfo(runner, pr));
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`run-merge-train: ${f}`);
    process.exit(1);
    return;
  }

  const batches = composeTrainBatches(candidates, maxBatchSize);
  console.log(`run-merge-train: ${candidates.length} PR(s), ${batches.length} lote(s) composto(s) (kind=${kind}, maxBatchSize=${maxBatchSize})`);

  // Processa os lotes SEQUENCIALMENTE — cada um monta seu próprio worktree
  // isolado (`buildIntegrationBranch`), então não colidiria em paralelo,
  // mas o MERGE de verdade é serializado pelo lock de qualquer forma;
  // rodar sequencial aqui é simplicidade da 1ª versão, não uma exigência
  // de correção (diferente da versão anterior, quando tudo acontecia no
  // checkout principal compartilhado).
  const allOutcomes: TrainBatchOutcome[] = [];
  for (const batch of batches) {
    const batchPrInfos = prInfos.filter((p) => batch.prs.includes(p.pr));
    const outcomes = await runMergeTrain(runner, batch, batchPrInfos, {
      sessionId,
      kind,
      mainCwd: cwd,
      ...(ciTimeoutMs !== undefined ? { ciTimeoutMs } : {}),
      ...(ciPollIntervalMs !== undefined ? { ciPollIntervalMs } : {}),
    });
    allOutcomes.push(...outcomes);
  }

  console.log(`run-merge-train: ${allOutcomes.length} resultado(s):`);
  for (const o of allOutcomes) console.log(printOutcome(o));

  // "abandoned" NUNCA é status final por si só — todo lote abandoned é
  // sempre bissectado e reprocessado até virar um dos status terminais
  // abaixo (registrado no array só como rastro de ONDE a bisecção
  // aconteceu). Falha real = solo-failed (piso da bissecção falhou) OU
  // lock-blocked (lote provou passar mas não conseguiu mergear) OU
  // indeterminate (#7064 — 2 execuções de reconfirmação discordaram; não é
  // "PR com defeito", mas também não é "resolvido" — precisa de nova
  // invocação do trem, então conta pro exit != 0 pelo mesmo motivo que
  // lock-blocked conta: sinaliza trabalho pendente, não bug de código).
  const hasRealFailure = allOutcomes.some((o) => o.status === "solo-failed" || o.status === "lock-blocked" || o.status === "indeterminate");
  process.exit(hasRealFailure ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  main();
}
