#!/usr/bin/env npx tsx
/**
 * scripts/branch-cleanup.ts (#6802)
 *
 * CLI de GC de branches locais + worktrees — ver `scripts/lib/branch-cleanup.ts`
 * pro critério puro/docs completas do POR QUÊ (o achado central: neste
 * repo o merge é sempre SQUASH, então `merge-base --is-ancestor` sozinho
 * classifica branch integrada como "não mergeada" — 51 de 61 no lote
 * medido — e apagaria trabalho se usado como único critério de segurança
 * ao contrário; usado aqui só como sinal SECUNDÁRIO, nunca susbtitui o
 * estado real da PR via `gh`).
 *
 * Uso:
 *   npx tsx scripts/branch-cleanup.ts                # dry-run (default) — relatório, gh NÃO apaga nada
 *   npx tsx scripts/branch-cleanup.ts --push          # apaga as safe-delete/safe-remove de verdade
 *   npx tsx scripts/branch-cleanup.ts --skip-worktrees # só branches, não mexe em worktree nenhum
 *
 * Passos (nesta ordem):
 *   1. `git worktree prune` — sempre roda, mesmo em dry-run (é uma operação
 *      do PRÓPRIO git que só remove metadado de worktree cujo diretório no
 *      disco já não existe mais — nunca toca um diretório que ainda existe,
 *      então não tem "modo apagar" a proteger com --push).
 *   2. Lista branches locais (`git for-each-ref refs/heads`), exclui
 *      `master`/`main` e qualquer branch checked-out em algum worktree
 *      (`git branch -D` recusaria de qualquer forma — filtrar antes evita
 *      erro ruidoso no meio do lote).
 *   3. 1 chamada `gh pr list --state all --json headRefName,state --limit
 *      N` pra TODAS as branches de uma vez (não 1 chamada por branch —
 *      745 branches locais medidas na issue, uma chamada por branch
 *      estouraria rate limit em minutos). Um PR de uma branch antiga
 *      demais pra caber no limite conta como "nenhuma PR encontrada" —
 *      cai em `needs-review`, direção fail-closed (nunca vira
 *      `safe-delete` por engano de paginação).
 *   4. Classifica cada branch (`classifyBranchForCleanup`) e cada worktree
 *      restante (`classifyWorktreeForCleanup`, cruzando com a decisão da
 *      branch dele).
 *   5. Sem `--push`: imprime relatório (contagens + listas) e para — gh
 *      NUNCA é chamado com efeito, git NUNCA apaga nada.
 *   6. Com `--push`: `git branch -D` nas `safe-delete`, `git worktree
 *      remove --force` nas `safe-remove` (força só porque o passo 4 já
 *      confirmou `isPorcelainClean` — nunca força sobre diff sujo).
 *      `needs-review` NUNCA é tocado por este script, com ou sem --push —
 *      fica só no relatório, pra decisão humana.
 */

import { execFileSync } from "node:child_process";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  classifyBranchForCleanup,
  classifyWorktreeForCleanup,
  parseWorktreeListPorcelain,
  type CleanupDecision,
} from "./lib/branch-cleanup.ts";

const LOG_PREFIX = "[branch-cleanup]";
/** Generoso o bastante pra cobrir o volume medido na issue (745 branches
 * locais) sem paginar — `gh pr list` aceita limites grandes num único
 * request. PR mais velha que isso cai em `needs-review` (fail-closed),
 * nunca em `safe-delete` por engano de paginação. */
const GH_PR_LIST_LIMIT = 3000;

function git(args: string[], cwd = process.cwd()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitOrNull(args: string[], cwd = process.cwd()): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function isAncestorOfMaster(branch: string, cwd: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, "master"], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface PrRecord {
  headRefName: string;
  state: string;
}

function fetchAllPrStates(cwd: string): Map<string, string[]> {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--state", "all", "--json", "headRefName,state", "--limit", String(GH_PR_LIST_LIMIT)],
    { cwd, encoding: "utf8" },
  );
  const records = JSON.parse(out) as PrRecord[];
  const map = new Map<string, string[]>();
  for (const r of records) {
    const list = map.get(r.headRefName) ?? [];
    list.push(r.state);
    map.set(r.headRefName, list);
  }
  return map;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const skipWorktrees = hasFlag(argv, "skip-worktrees");
  const cwd = process.cwd();

  // Passo 1 — sempre, mesmo em dry-run (ver docstring: nunca toca dir vivo).
  const pruneOut = gitOrNull(["worktree", "prune", "-v"], cwd);
  console.log(`${LOG_PREFIX} git worktree prune: ${pruneOut || "(nada a podar)"}`);

  // Worktrees restantes (pós-prune) + branches checked-out em algum deles.
  const worktreeListOut = gitOrNull(["worktree", "list", "--porcelain"], cwd) ?? "";
  const worktrees = parseWorktreeListPorcelain(worktreeListOut);
  const checkedOutBranches = new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== null));

  // Passo 2 — branches locais candidatas. Inclui as checked-out em worktree
  // (precisam de decisão pra classificar o WORKTREE correspondente, passo
  // 4b abaixo) — só EXCLUI master/main. `git branch -D` numa branch
  // checked-out falharia de qualquer forma; o passo de apagar (só com
  // --push) filtra checkedOutBranches de novo antes de deletar.
  const allBranchesOut = gitOrNull(["for-each-ref", "refs/heads", "--format=%(refname:short)"], cwd) ?? "";
  const allBranches = allBranchesOut
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .filter((b) => b !== "master" && b !== "main");

  console.log(
    `${LOG_PREFIX} branches locais candidatas (excl. master/main): ${allBranches.length} ` +
      `(${checkedOutBranches.size} checked-out em worktree)`,
  );

  // Passo 3 — 1 chamada gh pra todas.
  let prStatesByBranch: Map<string, string[]>;
  try {
    prStatesByBranch = fetchAllPrStates(cwd);
  } catch (e) {
    console.error(`${LOG_PREFIX} gh pr list falhou: ${(e as Error).message} — abortando (fail-closed, sem gh não classifica nada)`);
    process.exitCode = 1;
    return;
  }

  // Passo 4 — classifica branches.
  const branchDecisions = new Map<string, CleanupDecision>();
  for (const branch of allBranches) {
    const decision = classifyBranchForCleanup({
      branch,
      prStates: prStatesByBranch.get(branch) ?? [],
      isAncestorOfMaster: isAncestorOfMaster(branch, cwd),
    });
    branchDecisions.set(branch, decision);
  }

  // Relatório/delete de BRANCH só sobre as NÃO checked-out — as checked-out
  // são tratadas pelo caminho de worktree (removê-lo primeiro libera a
  // branch; se sobrar sem worktree, uma rodada seguinte deste script já
  // classifica normalmente).
  const deletableBranchEntries = [...branchDecisions.entries()].filter(([b]) => !checkedOutBranches.has(b));
  const safeDelete = deletableBranchEntries.filter(([, d]) => d.verdict === "safe-delete");
  const needsReview = deletableBranchEntries.filter(([, d]) => d.verdict === "needs-review");

  console.log(`${LOG_PREFIX} branches: ${safeDelete.length} safe-delete, ${needsReview.length} needs-review`);
  for (const [branch, d] of needsReview) {
    console.log(`${LOG_PREFIX}   needs-review: ${branch} — ${d.reason}`);
  }

  // Worktrees existentes (excl. o principal, que não tem como remover).
  const mainWorktreePath = worktrees[0]?.path;
  const worktreeDecisions: Array<{ path: string; branch: string | null; verdict: string; reason: string }> = [];
  if (!skipWorktrees) {
    for (const wt of worktrees) {
      if (wt.path === mainWorktreePath) continue;
      if (wt.prunable) continue; // já coberto pelo passo 1, não deveria sobrar, mas defesa em profundidade
      const isPorcelainClean = (gitOrNull(["-C", wt.path, "status", "--porcelain"], cwd) ?? "").length === 0;
      const branchDecision = wt.branch ? (branchDecisions.get(wt.branch) ?? null) : null;
      const decision = classifyWorktreeForCleanup({
        path: wt.path,
        branch: wt.branch,
        isPorcelainClean,
        branchDecision,
      });
      worktreeDecisions.push({ path: wt.path, branch: wt.branch, ...decision });
    }
    const safeRemoveWt = worktreeDecisions.filter((w) => w.verdict === "safe-remove");
    const needsReviewWt = worktreeDecisions.filter((w) => w.verdict === "needs-review");
    console.log(`${LOG_PREFIX} worktrees: ${safeRemoveWt.length} safe-remove, ${needsReviewWt.length} needs-review`);
    for (const w of needsReviewWt) {
      console.log(`${LOG_PREFIX}   needs-review: ${w.path} (branch: ${w.branch ?? "detached"}) — ${w.reason}`);
    }
  }

  if (!push) {
    console.log(`${LOG_PREFIX} dry-run (default) — nada apagado. Rode com --push pra aplicar as safe-delete/safe-remove acima.`);
    return;
  }

  // Worktrees primeiro (remover o worktree libera a branch pra --push do
  // passo seguinte, se ela também for safe-delete — ordem importa aqui).
  let removedWt = 0;
  if (!skipWorktrees) {
    for (const w of worktreeDecisions) {
      if (w.verdict !== "safe-remove") continue;
      try {
        execFileSync("git", ["worktree", "remove", "--force", w.path], { cwd, stdio: "ignore" });
        removedWt++;
        console.log(`${LOG_PREFIX} worktree removido: ${w.path}`);
      } catch (e) {
        console.error(`${LOG_PREFIX} falha ao remover worktree ${w.path}: ${(e as Error).message}`);
      }
    }
  }

  let removedBranches = 0;
  for (const [branch, d] of deletableBranchEntries) {
    if (d.verdict !== "safe-delete") continue;
    try {
      execFileSync("git", ["branch", "-D", branch], { cwd, stdio: "ignore" });
      removedBranches++;
    } catch (e) {
      console.error(`${LOG_PREFIX} falha ao apagar branch ${branch}: ${(e as Error).message}`);
    }
  }

  console.log(`${LOG_PREFIX} --push aplicado: ${removedBranches} branch(es) apagada(s), ${removedWt} worktree(s) removido(s).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
