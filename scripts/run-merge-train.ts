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
 *   0 = todos os PRs ADMITIDOS no trem terminaram em `merged`/`solo-merged`.
 *       NÃO significa "todo PR passado entrou": PR fechado pulado (`--prs` ou
 *       `--open`) e PR de outro repo filtrado em `--open` (#10901,
 *       `screenTrainPrs`) também saem com `0` sem merge — inclusive quando
 *       nenhum sobra ("nada a fazer"). Esses aparecem no stdout como
 *       `run-merge-train: PULADO — …`; quem precisa saber o que entrou lê o
 *       stdout, não só o exit code.
 *   1 = pelo menos 1 terminou `solo-failed`, `lock-blocked`,
 *       `retido-ilegivel` (#10299 — sinal de retenção ilegível no instante
 *       do merge) OU `indeterminate` (falha real de merge, ou lote sem resolução — não
 *       "vermelho de CI", que sempre resolve via bisecção até o piso;
 *       `lock-blocked` é um lote que provou passar junto no CI mas não
 *       conseguiu a janela de merge lock após retries, ou falhou na
 *       revalidação de Gate 2; `indeterminate` (#7064) é um lote cujas 2
 *       execuções de reconfirmação discordaram — assinatura da corrida do
 *       #7060, nunca reprovação — precisa de nova invocação do trem, não
 *       de um fixer — ver `scripts/lib/merge-train-live.ts`)
 *       OU `gh`/preparação falhou antes de processar qualquer lote
 *       OU o sinal `retido-para-editor` de algum PR estava ilegível
 *       (#10294 — fail-closed: o PR é excluído e o resto segue). PR retido
 *       de fato (excluído na descoberta, ou status `retido` no merge) NÃO
 *       conta como falha — é retenção deliberada pro editor.
 *   2 = uso inválido (--session-id/--kind ausentes; nem --prs nem --open;
 *       --prs vazio/token inválido; --max-batch-size inválido; PR de `--prs`
 *       que não é do vjpixel/diaria-studio mirando master — o trem é
 *       só-studio, #10618 fatia 4: `checkStudioTrainPr`). Em `--open` esse PR
 *       é só filtrado, e PR fechado é pulado nos dois modos (#10901,
 *       `screenTrainPrs`).
 */

import { isMainModule, parseArgs, getIntArg, getStringArg } from "./lib/cli-args.ts";
import { composeTrainBatches, summarizeTrainCiRuns, type TrainCandidate, type TrainPrInfo } from "./lib/merge-train.ts";
import { filesForPr, discoverOpenPrs, parsePrsArg } from "./lib/merge-train-discovery.ts";
import {
  screenTrainPrs,
  createRealTrainRunner,
  fetchTrainPrInfo,
  partitionRetidoCandidates,
  runMergeTrain,
  trainHasRealFailure,
  type TrainBatchOutcome,
} from "./lib/merge-train-live.ts";
import { logEvent } from "./lib/run-log.ts";

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

  const runner = createRealTrainRunner(cwd);

  // #10618 (fatia 4, review 2): o trem é só-studio. Todo PR de `--prs`/`--open`
  // precisa ser um PR ABERTO do vjpixel/diaria-studio mirando master — o número
  // de um PR do diaria-design passado aqui resolveria o studio PR #N (o `gh` sem
  // `-R`) e seria mergeado no lugar. Ilegível = falha operacional (exit 1).
  // #10901: PR de fora passado EXPLICITAMENTE em `--prs` recusa o trem inteiro
  // (exit 2); em `--open` (descoberta) só é filtrado; PR fechado entre a
  // composição e o trem é pulado nos dois modos (`screenTrainPrs`).
  {
    const screen = screenTrainPrs(runner, prNumbers, !values.prs);
    if (screen.refused.length > 0) {
      for (const f of screen.refused) console.error(`run-merge-train: RECUSADO — ${f}`);
      console.error("run-merge-train: PR de outro repo (ex.: vjpixel/diaria-design) nunca entra no trem — merge isolado com -R (item 32 de context/overnight-dispatch-rules.md).");
      process.exit(2);
      return;
    }
    if (screen.unreadable.length > 0) {
      for (const u of screen.unreadable) console.error(`run-merge-train: ${u}`);
      process.exit(1);
      return;
    }
    for (const s of screen.skipped) console.log(`run-merge-train: PULADO — ${s}`);
    prNumbers = screen.admitted;
    if (prNumbers.length === 0) {
      console.log("run-merge-train: nenhum PR do studio aberto entre os candidatos — nada a fazer.");
      process.exit(0);
      return;
    }
  }

  // #10294: PR retida para o editor (label `retido-para-editor` ou marcador
  // no corpo, #10278) sai do trem ANTES de compor os lotes, com motivo
  // explícito — nunca entra num lote e por isso nunca prende os demais.
  // Sinal ilegível = fail-closed (excluída também) e conta como falha no
  // exit code; retenção de fato é decisão deliberada, não falha.
  const { eligible, excluded } = partitionRetidoCandidates(runner, prNumbers);
  for (const ex of excluded) {
    console.log(`run-merge-train: PR #${ex.pr} EXCLUÍDO do trem (${ex.retido === true ? "retido para o editor" : "sinal de retenção ilegível — fail-closed"}): ${ex.reason}`);
    logEvent({
      edition: null,
      stage: null,
      agent: kind,
      level: ex.retido === true ? "info" : "warn",
      message: "merge_train_pr_retido_excluido",
      details: { pr: ex.pr, retido: ex.retido, reason: ex.reason },
    });
  }
  const retidoReadFailure = excluded.some((ex) => ex.retido === null);
  if (eligible.length === 0) {
    console.log("run-merge-train: nenhum PR elegível após excluir os retidos — nada a mergear.");
    process.exit(retidoReadFailure ? 1 : 0);
    return;
  }

  const candidates: TrainCandidate[] = [];
  const prInfos: TrainPrInfo[] = [];
  const failures: string[] = [];
  for (const pr of eligible) {
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

  // Instrumentação de medição antes/depois (#6300, último critério de
  // aceite: "runs de CI por issue mergeada"). Derivado dos outcomes já
  // computados acima, sem I/O extra — ver docstring de `summarizeTrainCiRuns`
  // em scripts/lib/merge-train.ts pro racional completo de cada campo.
  // Emitido SEMPRE, mesmo quando nenhum lote ≥2 se formou (ciRunsUsed=0) —
  // presença do evento é o sinal de "o trem rodou", não o valor.
  const ciRunsSummary = summarizeTrainCiRuns(allOutcomes, prInfos);
  console.log(
    `run-merge-train: CI runs — ${ciRunsSummary.ciRunsUsed} usado(s) pelo trem vs. ${ciRunsSummary.prsInvolvedInBatches}` +
      ` que seriam gastos sem ele (${ciRunsSummary.issuesInvolvedInBatches} issue(s) cobertas em lote, ${ciRunsSummary.soloPrs} PR(s) solo fora do trem)`,
  );
  logEvent({
    edition: null,
    stage: null,
    agent: kind,
    level: "info",
    message: "merge_train_ci_runs",
    details: {
      ci_runs_used: ciRunsSummary.ciRunsUsed,
      ci_runs_without_train: ciRunsSummary.prsInvolvedInBatches,
      prs_involved_in_batches: ciRunsSummary.prsInvolvedInBatches,
      issues_involved_in_batches: ciRunsSummary.issuesInvolvedInBatches,
      solo_prs: ciRunsSummary.soloPrs,
      batches: batches.length,
    },
  });

  // "abandoned" NUNCA é status final por si só — todo lote abandoned é
  // sempre bissectado e reprocessado até virar um dos status terminais
  // abaixo (registrado no array só como rastro de ONDE a bisecção
  // aconteceu). Falha real = solo-failed (piso da bissecção falhou) OU
  // lock-blocked (lote provou passar mas não conseguiu mergear) OU
  // indeterminate (#7064 — 2 execuções de reconfirmação discordaram; não é
  // "PR com defeito", mas também não é "resolvido" — precisa de nova
  // invocação do trem, então conta pro exit != 0 pelo mesmo motivo que
  // lock-blocked conta: sinaliza trabalho pendente, não bug de código).
  // `retido` (#10294) NÃO conta: é retenção deliberada pro editor, não falha.
  // `retido-ilegivel` (#10299) conta: sinal ilegível no instante do merge,
  // mesma regra do ilegível da descoberta (`retidoReadFailure`).
  const hasRealFailure = trainHasRealFailure(allOutcomes, retidoReadFailure);
  process.exit(hasRealFailure ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  main();
}
