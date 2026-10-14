#!/usr/bin/env node
/**
 * scripts/check-site-page-pr-gate.ts (#10160)
 *
 * Trava do fim da Etapa 6 no merge do PR da página do site.
 *
 * ## Por que existe
 *
 * Desde o #10160 o PR da página (`publish-edition-site-page.ts`) é aberto no
 * INÍCIO da Etapa 5 (§5b-site, `--no-wait-merge`) e o dispatch segue sem
 * esperar o merge — CI (~12min) e review andam em paralelo com newsletter,
 * social e Brevo/Kit. O merge passou a ser pré-requisito do FIM da Etapa 6:
 * sem ele, `/p/{slug}` (link de WhatsApp do e-mail) dá 404 no envio.
 *
 * Este script é a checagem determinística (#573 — nunca a prosa do agente)
 * que o Stage 6 roda duas vezes: antes do gate único (§6b-site, `--wait-ms 0`,
 * só pra mostrar o estado no gate) e logo antes do Schedule (§6c-site,
 * `--wait-ms 540000`, a trava). O invariante `site-page-pr-merged`
 * (`STAGE_6_RULES`, bloqueante) fecha o mesmo buraco no sentinel
 * `.step-6-done.json`, caso o passo seja pulado.
 *
 * ## O que faz
 *
 * Lê `_internal/site-page-published.json` e consulta o PR ao vivo com a MESMA
 * lógica de merge do publisher (`waitAndMergeSitePagePr` — `gh pr view` +
 * `evaluatePrChecksGate`, merge `--squash --match-head-commit` sob o merge
 * lock da máquina):
 *
 *   - `MERGED` → segue (exit 0);
 *   - `OPEN` com CI verde → mergeia agora (regra do #5251) e segue (exit 0);
 *   - CI ainda rodando no fim da janela → exit 3 (re-rodar; nunca "ok");
 *   - CI vermelho, conflito, PR fechado, `gh pr merge` falho → exit 1 (halt);
 *   - `gh pr view` falhou → exit 2 (halt — desconhecido NUNCA vira mergeado);
 *   - sem PR registrado (state ausente/ilegível, `published≠true`, sem
 *     `prUrl`) → exit 4 (rodar o fallback de publicação do §6b-site).
 *
 * Merge feito aqui é gravado no state file (`merged: true`, `status:
 * "merged"`, `mergeBlocker` limpo) — mesma função do waiter
 * (`applyMergeWaiterResult`), rótulo próprio.
 *
 * ## Uso
 *
 *   npx tsx scripts/check-site-page-pr-gate.ts --edition-dir {EDITION_DIR}
 *   npx tsx scripts/check-site-page-pr-gate.ts --edition-dir {EDITION_DIR} --wait-ms 540000
 *
 * ## Guard de publicação
 *
 * Mergeia o PR da página do site (artefato gerado, isento de review — ver
 * `docs/site-page-publish-mechanism.md`) e nada mais. Nunca toca Beehiiv/Kit/
 * redes sociais.
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { readSitePageState } from "./check-site-page-merge.ts";
import {
  applyMergeWaiterResult,
  defaultGhRunner,
  makeSessionRegistryMergeLock,
  parsePrNumberFromUrl,
  waitAndMergeSitePagePr,
  type GhRunner,
  type MergeAttemptResult,
  type SitePageMergeLock,
  type SleepFn,
} from "./publish-edition-site-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Teto da trava pré-Schedule: abaixo dos 10min de um Bash foreground do harness. */
export const SITE_PAGE_PR_GATE_MAX_WAIT_MS = 540_000;
export const SITE_PAGE_PR_GATE_POLL_MS = 15_000;

export type SitePagePrGateVerdict =
  | { kind: "merged"; prNumber: number; reason: string }
  | { kind: "pending"; prNumber: number; reason: string }
  | { kind: "blocked"; prNumber: number; reason: string }
  | { kind: "cannot-verify"; prNumber: number; reason: string }
  | { kind: "no-pr"; reason: string };

/** Exit code de cada veredito — ver docstring do módulo. */
export function exitCodeForVerdict(v: SitePagePrGateVerdict): number {
  switch (v.kind) {
    case "merged":
      return 0;
    case "blocked":
      return 1;
    case "cannot-verify":
      return 2;
    case "pending":
      return 3;
    case "no-pr":
      return 4;
  }
}

/**
 * Pura: classifica o desfecho de `waitAndMergeSitePagePr`. `ghError` (estado
 * desconhecido) e `timedOut` (CI pendente) são os únicos não-mergeados que
 * NÃO são bloqueio definitivo.
 */
export function classifyMergeAttempt(prNumber: number, attempt: MergeAttemptResult): SitePagePrGateVerdict {
  if (attempt.merged) return { kind: "merged", prNumber, reason: attempt.reason };
  if (attempt.ghError) return { kind: "cannot-verify", prNumber, reason: attempt.reason };
  if (attempt.timedOut) return { kind: "pending", prNumber, reason: attempt.reason };
  return { kind: "blocked", prNumber, reason: attempt.reason };
}

export interface SitePagePrGateDeps {
  gh?: GhRunner;
  sleep?: SleepFn;
  mergeLock?: SitePageMergeLock;
  waitMs?: number;
  pollMs?: number;
  now?: Date;
}

/** Corpo do CLI, injetável. */
export function runSitePagePrGate(
  rootDir: string,
  editionDirAbs: string,
  deps: SitePagePrGateDeps = {},
): SitePagePrGateVerdict {
  const read = readSitePageState(editionDirAbs);
  if (read.kind === "absent") {
    return { kind: "no-pr", reason: "_internal/site-page-published.json ausente — §5b-site não rodou" };
  }
  if (read.kind === "unreadable") return { kind: "no-pr", reason: read.reason };
  const state = read.state;
  if (state.published !== true) {
    return {
      kind: "no-pr",
      reason: `página não publicada (published=${String(state.published)}, code=${String(state.code ?? "?")}): ${String(state.reason ?? "sem motivo")}`,
    };
  }
  const prNumber = parsePrNumberFromUrl(typeof state.prUrl === "string" ? state.prUrl : undefined);
  if (prNumber === undefined) {
    return { kind: "no-pr", reason: `PR da página não identificado no state file (branch site-publish/${String(state.slug ?? "?")})` };
  }
  // O publisher e o waiter só gravam `merged: true` depois de confirmar o merge.
  if (state.merged === true) {
    return { kind: "merged", prNumber, reason: `state file já registra o merge do PR #${prNumber}` };
  }
  const sleep: SleepFn = deps.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const attempt = waitAndMergeSitePagePr(
    rootDir,
    prNumber,
    deps.gh ?? defaultGhRunner,
    sleep,
    deps.waitMs ?? 0,
    deps.pollMs ?? SITE_PAGE_PR_GATE_POLL_MS,
    deps.mergeLock,
  );
  const verdict = classifyMergeAttempt(prNumber, attempt);
  if (verdict.kind === "merged") {
    const next = applyMergeWaiterResult(state, prNumber, attempt, deps.now ?? new Date(), "trava do Stage 6 (#10160)");
    if (next) {
      try {
        writeFileAtomic(join(editionDirAbs, "_internal", "site-page-published.json"), JSON.stringify(next, null, 2));
      } catch (e) {
        // O merge aconteceu; o state defasado só faz o invariante consultar o PR ao vivo.
        process.stderr.write(`[site-page-pr-gate] aviso: merge feito, mas o state file não foi regravado (${(e as Error).message})\n`);
      }
    }
  }
  return verdict;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const editionDirArg = getArg(argv, "edition-dir");
  if (!editionDirArg) {
    console.error("uso: npx tsx scripts/check-site-page-pr-gate.ts --edition-dir <dir> [--wait-ms N] [--poll-ms N]");
    process.exitCode = 1;
    return;
  }
  const waitMs = Number(getArg(argv, "wait-ms") || "0");
  const pollMs = Number(getArg(argv, "poll-ms") || String(SITE_PAGE_PR_GATE_POLL_MS));
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > SITE_PAGE_PR_GATE_MAX_WAIT_MS || !Number.isFinite(pollMs) || pollMs <= 0) {
    console.error(`--wait-ms precisa estar em [0, ${SITE_PAGE_PR_GATE_MAX_WAIT_MS}] e --poll-ms > 0`);
    process.exitCode = 1;
    return;
  }
  const editionDirAbs = resolve(ROOT, editionDirArg);
  const state = readSitePageState(editionDirAbs);
  const prNumber =
    state.kind === "ok" ? parsePrNumberFromUrl(typeof state.state.prUrl === "string" ? state.state.prUrl : undefined) : undefined;
  const verdict = runSitePagePrGate(ROOT, editionDirAbs, {
    waitMs,
    pollMs,
    mergeLock: prNumber !== undefined ? makeSessionRegistryMergeLock(ROOT, prNumber) : undefined,
  });
  console.log(JSON.stringify(verdict, null, 2));
  process.exitCode = exitCodeForVerdict(verdict);
}

if (isMainModule(import.meta.url)) {
  await main();
}
