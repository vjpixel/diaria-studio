#!/usr/bin/env npx tsx
/**
 * scripts/list-fork-issues.ts (#6817 item 7)
 *
 * Lê as issues abertas do fork `vjpixel/hermes` (2ª fila, ver `scripts/lib/
 * hermes-fork-issue-queue.ts` pro racional completo) via `gh issue list
 * --repo vjpixel/hermes`. `classifyExecTrack` continua a fonte única pras
 * issues DESTE repo — este script nunca é chamado pra decidir nada sobre
 * `diaria-studio`, só pra listar/relatar o fork.
 *
 * É RELATÓRIO, não gate — mesma disciplina de `check-alarm-retirement-
 * candidates.ts`: falha de `gh` (rede, auth, repo inacessível) nunca
 * bloqueia o ciclo do contínuo, sempre sai 0 com a fila secundária vazia
 * reportada (nunca finge sucesso silencioso — a falha vai pro stderr).
 *
 * Modos:
 *
 *   npx tsx scripts/list-fork-issues.ts
 *     -> JSON de ForkIssueSummary[] no stdout (vazio [] se `gh` falhar ou
 *        não houver issue aberta).
 *
 *   npx tsx scripts/list-fork-issues.ts --report --primary-count N
 *     -> linhas de relatório prontas pro Telegram/log (`buildDualQueue
 *        ReportLines`), cruzando com a contagem da fila primária que o
 *        caller já calculou via `classifyExecTrack`.
 *
 * Exit codes: sempre 0 (relatório, nunca gate — mesmo com `gh` falhando).
 * Uso inválido (`--report` sem `--primary-count`) sai 2.
 */

import { execSync } from "node:child_process";
import { hasFlag, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { buildDualQueueReportLines, FORK_REPO, InvalidForkIssuesJsonError, parseForkIssuesJson } from "./lib/hermes-fork-issue-queue.ts";
import type { ForkIssueSummary } from "./lib/hermes-fork-issue-queue.ts";

const LOG_PREFIX = "[list-fork-issues]";

/** Busca as issues abertas do fork via `gh`. Nunca lança — falha de
 * qualquer natureza (rede, auth, `gh` ausente, JSON inesperado) vira
 * `{ ok: false, reason }`; sucesso vira `{ ok: true, issues }` (mesmo
 * `issues: []` quando o fork não tem issue aberta — não é falha). */
function fetchForkIssues(): { ok: true; issues: ForkIssueSummary[] } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = execSync(`gh issue list --repo ${FORK_REPO} --state open --json number,title,labels,url`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, reason: `gh issue list falhou: ${err.stderr ?? err.message}` };
  }
  try {
    return { ok: true, issues: parseForkIssuesJson(raw) };
  } catch (e) {
    if (e instanceof InvalidForkIssuesJsonError) {
      return { ok: false, reason: e.message };
    }
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { values } = parseArgs(argv);

  const fetchResult = fetchForkIssues();
  if (!fetchResult.ok) {
    console.error(`${LOG_PREFIX} ${fetchResult.reason} — fila secundária tratada como vazia neste ciclo (relatório, nunca gate).`);
  }
  const issues = fetchResult.ok ? fetchResult.issues : [];

  if (hasFlag(argv, "report")) {
    const primaryCountRaw = values["primary-count"];
    const primaryCount = primaryCountRaw !== undefined ? Number(primaryCountRaw) : NaN;
    if (!Number.isInteger(primaryCount) || primaryCount < 0) {
      console.error(`${LOG_PREFIX} uso: --report --primary-count N (inteiro >= 0)`);
      process.exit(2);
    }
    for (const line of buildDualQueueReportLines(primaryCount, issues)) {
      console.log(line);
    }
    process.exit(0);
  }

  console.log(JSON.stringify(issues, null, 2));
  process.exit(0);
}
