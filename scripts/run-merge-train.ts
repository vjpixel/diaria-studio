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
 *   npx tsx scripts/run-merge-train.ts --session-id <uuid> --kind overnight --prs 1,2 \
 *     --resolve-low-severity-threads --report data/overnight/261028/report.md
 *
 * `--resolve-low-severity-threads` (#11461): antes de compor os lotes, resolve
 * as threads de self-review da automação com finding P2/P3 sem confiança alta
 * (`resolve-review-threads.ts --low-severity-only`); as demais seguram a PR.
 * `--report <report.md>` (#11461): ao terminar, reconcilia o relatório da
 * rodada com o estado real das PRs (`reconcile-overnight-report.ts`), fail-soft.
 * Caminho relativo resolve contra a raiz do checkout PRINCIPAL, não contra o
 * cwd (#12458): rodar o trem de dentro de um worktree de agente grava a
 * timeline no `plan.json` certo (`resolveReportPathAgainstMainCheckout`).
 * Com `--report`, o fim do trem também preenche no `plan.json` vizinho os
 * `timeline.pr_opened`/`ci_green`/`merged` que faltam, pelo estado real das
 * PRs (`backfill-overnight-timeline.ts`, #12874), fail-soft.
 *
 * Escrita pendente em `data/` (#12026): no fim, para cada PR mergeado (no
 * PR-trem ou solo) cuja seção `Escrita pendente em data/` (item 35 de
 * `context/overnight-dispatch-rules.md`) tinha itens, o stdout traz o bloco
 * `run-merge-train: ESCRITA PENDENTE em data/ …` e uma linha
 * `run-merge-train: escrita-pendente-json {…}` (por PR). O trem não aplica
 * nada: quem aplica é o coordenador, depois do merge. Nunca muda o exit code.
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
 *       `threads-bloqueantes` (#12734 — revalidação do Gate 2 barrou um PR
 *       por thread de review aberta; o detalhe lista o PR e os IDs das
 *       threads retidas; num lote, só esse PR sai e o resto volta à fila,
 *       #12784), `threads-ilegiveis` (#12734 — a leitura das
 *       threads falhou na revalidação, sem lista confiável),
 *       `retido-ilegivel` (#10299 — sinal de retenção
 *       ilegível no instante do merge) OU `indeterminate` (falha real de
 *       merge, ou lote sem resolução — não
 *       "vermelho de CI", que sempre resolve via bisecção até o piso;
 *       `lock-blocked` é um lote que provou passar junto no CI mas não
 *       conseguiu a janela de merge lock após retries, ou falhou na
 *       revalidação de Gate 2 por motivo que não é a condição 2 (threads); `indeterminate` (#7064) é um lote cujas 2
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
import type { PrPendingDataWrites } from "./lib/pending-data-writes.ts";
import { filesForPr, discoverOpenPrs, parsePrsArg } from "./lib/merge-train-discovery.ts";
import {
  screenTrainPrs,
  createRealTrainRunner,
  fetchTrainPrInfo,
  partitionRetidoCandidates,
  runMergeTrain,
  trainHasRealFailure,
  TRAIN_REPO,
  type TrainBatchOutcome,
} from "./lib/merge-train-live.ts";
import { logEvent } from "./lib/run-log.ts";
import { resolveReviewThreads, EXIT_OK as THREADS_EXIT_OK } from "./resolve-review-threads.ts";
import { reconcileReport, realGhJson } from "./reconcile-overnight-report.ts";
import { backfillPlanTimeline } from "./backfill-overnight-timeline.ts";
import { spawnGhSync } from "./lib/shared/gh-run.ts";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { recordTrainMergedTimeline } from "./lib/overnight-unit-timeline.ts";

const DEFAULT_MAX_BATCH_SIZE = 3; // "K não deve ser grande. Começar em 3." — issue #6300
const VALID_KINDS = ["overnight", "develop", "continuo"] as const;

/** `git rev-parse --path-format=absolute --git-common-dir` no `cwd`; `null` se falhar. */
export function readGitCommonDir(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  const out = typeof r.stdout === "string" ? r.stdout.trim() : "";
  return r.status === 0 && out ? out : null;
}

/**
 * Caminho do `--report` resolvido contra a RAIZ DO CHECKOUT PRINCIPAL (#12458).
 *
 * O `report.md`/`plan.json` da rodada vivem em `data/` do checkout principal
 * (worktree de agente não tem a junction `data/`). Com o cwd deixado num
 * `.claude/worktrees/agent-*` pelo harness, `resolve(values.report)` apontava
 * pro worktree: a timeline do trem não era gravada no `plan.json` e o
 * reconcile era pulado só com aviso. Caminho relativo agora resolve contra o
 * pai do `.git` comum (o mesmo de qualquer worktree do repo); absoluto fica
 * como veio. `.git` comum ilegível ou fora do formato `<raiz>/.git` (repo
 * bare, `GIT_DIR` custom) cai no cwd, com `warning` para o chamador imprimir.
 */
export function resolveReportPathAgainstMainCheckout(
  raw: string,
  cwd: string,
  gitCommonDir: (cwd: string) => string | null = readGitCommonDir,
): { path: string; warning: string | null } {
  if (isAbsolute(raw)) return { path: resolvePath(raw), warning: null };
  const common = gitCommonDir(cwd);
  if (common && basename(common) === ".git") {
    return { path: resolvePath(dirname(common), raw), warning: null };
  }
  return {
    path: resolvePath(cwd, raw),
    warning: `run-merge-train: raiz do checkout principal não resolvida (git-common-dir ${common ? `"${common}" fora do formato <raiz>/.git` : "ilegível"}) — --report resolvido contra o cwd (${cwd}); se o cwd for um worktree de agente, a timeline e o reconcile vão mirar o lugar errado`,
  };
}

/**
 * Timeline das unidades no fim do trem (#12874): preenche `pr_opened`,
 * `ci_green` e `merged` que faltam no `plan.json` (ao lado do `report.md`) a
 * partir do estado real das PRs — inclusive as que entraram no plano depois
 * do merge ou que mergearam numa invocação anterior do trem. Fail-soft: nunca
 * lança nem muda o exit code; o merge já aconteceu (ou não).
 */
export function backfillTimelineAtTrainEnd(
  reportPath: string,
  deps: { backfill?: typeof backfillPlanTimeline } = {},
): { level: "log" | "warn"; message: string } {
  try {
    const r = (deps.backfill ?? backfillPlanTimeline)({
      planPath: join(dirname(reportPath), "plan.json"),
      gh: realGhJson,
      warn: (m) => console.warn(m),
    });
    return {
      level: r.exitCode === 0 ? "log" : "warn",
      message: `run-merge-train: timeline do plano (#12874): ${r.messages.join("; ")}`,
    };
  } catch (err) {
    return { level: "warn", message: `run-merge-train: timeline do plano (#12874) não preenchida: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Linha de reconcile do relatório no fim do trem (#11461, #11615).
 *
 * `--report` apontando pra um `report.md` que ainda não existe é o caso
 * NORMAL quando o trem roda antes da Fase 2 gravar o relatório: vira uma
 * linha informativa, não o aviso "relatório não encontrado" de falha.
 */
export function reconcileReportAtTrainEnd(
  reportPath: string,
  trainedPrs: number[],
  deps: { exists?: (p: string) => boolean; reconcile?: typeof reconcileReport } = {},
): { level: "log" | "warn"; message: string } {
  const exists = deps.exists ?? existsSync;
  if (!exists(reportPath)) {
    return {
      level: "log",
      message: `run-merge-train: relatório ainda não gravado (${reportPath}), reconcile pulado — esperado quando o report.md só sai na Fase 2; rode reconcile-overnight-report.ts --report depois de gravá-lo`,
    };
  }
  const r = (deps.reconcile ?? reconcileReport)({
    reportPath,
    planPath: join(dirname(reportPath), "plan.json"),
    extraPrs: trainedPrs,
    discover: true,
    check: false,
    gh: realGhJson,
  });
  return { level: r.exitCode === 0 ? "log" : "warn", message: `run-merge-train: reconcile do relatório (#11461): ${r.message}` };
}

/**
 * Escrita pendente em `data/` das PRs que de fato mergearam (#12026). Só
 * `merged`/`solo-merged`: a escrita pertence ao estado pós-merge (item 35),
 * PR não mergeado não tem nada a aplicar ainda. Ordem dos outcomes, sem
 * repetir PR; PR sem itens fica de fora.
 */
export function collectMergedPendingDataWrites(
  outcomes: readonly TrainBatchOutcome[],
  prInfos: readonly TrainPrInfo[],
): PrPendingDataWrites[] {
  const byNumber = new Map(prInfos.map((p) => [p.pr, p]));
  const seen = new Set<number>();
  const out: PrPendingDataWrites[] = [];
  for (const o of outcomes) {
    if (o.status !== "merged" && o.status !== "solo-merged") continue;
    for (const pr of o.batch.prs) {
      if (seen.has(pr)) continue;
      seen.add(pr);
      const writes = byNumber.get(pr)?.pendingDataWrites ?? [];
      if (writes.length > 0) out.push({ pr, writes });
    }
  }
  return out;
}

/** Linhas de stdout do bloco de escrita pendente (#12026) — vazio sem pendência. */
export function formatPendingDataWritesReport(list: readonly PrPendingDataWrites[]): string[] {
  if (list.length === 0) return [];
  const lines = [
    `run-merge-train: ESCRITA PENDENTE em data/ (#11780, #12026) — ${list.length} PR(s) mergeada(s) declararam escrita; aplicar no checkout principal agora (item 35):`,
  ];
  for (const p of list) {
    lines.push(`  PR #${p.pr}:`);
    for (const w of p.writes) lines.push(`    - ${w.line}`);
  }
  for (const p of list) {
    lines.push(`run-merge-train: escrita-pendente-json ${JSON.stringify({ pr: p.pr, writes: p.writes })}`);
  }
  return lines;
}

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
  // #11461: com `--report`, o relatório da rodada é reconciliado com o estado
  // real das PRs no fim do trem — inclusive quando o trem termina depois de a
  // sessão já ter gravado o `report.md`. Fail-soft: falha aqui só avisa, nunca
  // muda o exit code do trem (o merge já aconteceu ou não; o relatório é rastro).
  if (flags.has("report")) {
    console.error("run-merge-train: --report precisa de valor (caminho do report.md da rodada)");
    process.exit(2);
    return;
  }
  let reportPath: string | null = null;
  if (typeof values.report === "string") {
    const r = resolveReportPathAgainstMainCheckout(values.report, cwd);
    if (r.warning) console.warn(r.warning);
    reportPath = r.path;
  }
  const trainedPrs = [...prNumbers];
  const finish = (code: number): void => {
    if (reportPath) {
      const tl = backfillTimelineAtTrainEnd(reportPath);
      (tl.level === "log" ? console.log : console.warn)(tl.message);
      const line = reconcileReportAtTrainEnd(reportPath, trainedPrs);
      (line.level === "log" ? console.log : console.warn)(line.message);
    }
    process.exit(code);
  };

  // #11461: threads de self-review P2/P3 (sem confiança alta) da automação
  // travavam o merge sob o ruleset (`required_review_thread_resolution`) numa
  // rodada desassistida. `--resolve-low-severity-threads` resolve só essas
  // antes de compor os lotes; P0/P1/confiança alta/sem severidade ficam
  // abertas e a condição 2 do Gate 2 segura a PR, como sempre.
  if (flags.has("resolve-low-severity-threads")) {
    const gh = (args: string[]) => spawnGhSync(args, cwd, 30_000);
    for (const pr of prNumbers) {
      const rep = resolveReviewThreads(TRAIN_REPO, pr, gh, null, { lowSeverityOnly: true });
      console.log(
        `run-merge-train: threads PR #${pr} (#11461) — resolvidas ${rep.resolved.length}, retidas ${rep.held.length} (P0/P1/confiança alta/sem severidade), do editor ${rep.skipped.length}` +
          (rep.exitCode === THREADS_EXIT_OK ? "" : ` — exit ${rep.exitCode}${rep.error ? `: ${rep.error}` : ""}`),
      );
      for (const f of rep.resolvedFindings) console.log(`    resíduo resolvido ${f.id}: ${f.excerpt}`);
      logEvent({
        edition: null,
        stage: null,
        agent: kind,
        level: rep.exitCode === THREADS_EXIT_OK ? "info" : "warn",
        message: "merge_train_low_severity_threads",
        details: { pr, resolved: rep.resolved.length, held: rep.held, skipped: rep.skipped, findings: rep.resolvedFindings, exit_code: rep.exitCode },
      });
    }
  }

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
    finish(retidoReadFailure ? 1 : 0);
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
    if (reportPath) {
      try {
        recordTrainMergedTimeline(join(dirname(reportPath), "plan.json"),
          outcomes.filter((o) => o.status === "merged" || o.status === "solo-merged").flatMap((o) => o.batch.prs),
          new Date().toISOString());
      } catch (err) {
        console.warn(`run-merge-train: timeline não persistida: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`run-merge-train: ${allOutcomes.length} resultado(s):`);
  for (const o of allOutcomes) console.log(printOutcome(o));

  // #12026: fail-soft — o merge já aconteceu (ou não); isto é só o rastro da
  // escrita pendente, nunca muda o exit code.
  try {
    const pending = collectMergedPendingDataWrites(allOutcomes, prInfos);
    for (const line of formatPendingDataWritesReport(pending)) console.log(line);
    if (pending.length > 0) {
      logEvent({
        edition: null,
        stage: null,
        agent: kind,
        level: "warn",
        message: "merge_train_pending_data_writes",
        details: { prs: pending.map((p) => ({ pr: p.pr, writes: p.writes.map((w) => w.line) })) },
      });
    }
  } catch (err) {
    console.error(`run-merge-train: AVISO — coleta de "Escrita pendente em data/" falhou (#12026), conferir o corpo das PRs mergeadas à mão: ${err instanceof Error ? err.message : String(err)}`);
  }

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
  // threads-bloqueantes (#12734 — thread de review aberta barrou o merge) OU
  // threads-ilegiveis (#12734 — leitura das threads falhou na revalidação) OU
  // indeterminate (#7064 — 2 execuções de reconfirmação discordaram; não é
  // "PR com defeito", mas também não é "resolvido" — precisa de nova
  // invocação do trem, então conta pro exit != 0 pelo mesmo motivo que
  // lock-blocked conta: sinaliza trabalho pendente, não bug de código).
  // `retido` (#10294) NÃO conta: é retenção deliberada pro editor, não falha.
  // `retido-ilegivel` (#10299) conta: sinal ilegível no instante do merge,
  // mesma regra do ilegível da descoberta (`retidoReadFailure`).
  const hasRealFailure = trainHasRealFailure(allOutcomes, retidoReadFailure);
  finish(hasRealFailure ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  main();
}
