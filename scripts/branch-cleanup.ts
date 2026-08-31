#!/usr/bin/env npx tsx
/**
 * scripts/branch-cleanup.ts (#6802)
 *
 * CLI de GC de branches locais + worktrees — ver `scripts/lib/branch-cleanup.ts`
 * pro critério puro/docs completas do POR QUÊ (o achado central: neste
 * repo o merge é sempre SQUASH, então `merge-base --is-ancestor` sozinho
 * classifica branch integrada como "não mergeada" — 51 de 61 no lote
 * medido — e apagaria trabalho se usado como único critério de segurança
 * ao contrário; usado aqui só como sinal SECUNDÁRIO, nunca substitui o
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
 *   2. `git fetch origin master --quiet` — `isAncestorOfMaster` (passo 4)
 *      compara contra `origin/master`, não o `master` local: sem fetch, um
 *      checkout desatualizado só produziria falso NEGATIVO (branch que já
 *      é ancestral de verdade cai em `needs-review` por engano) — direção
 *      seguraça, mas o fetch fecha a lacuna de qualquer jeito. Falha do
 *      fetch é fail-soft aqui (loga e segue com o `origin/master` que já
 *      existir localmente) — diferente do `gh pr list` do passo 3, que é
 *      o critério PRIMÁRIO e aborta o script inteiro se falhar.
 *   3. Lista branches locais (`git for-each-ref refs/heads`), exclui
 *      `master`/`main` e qualquer branch checked-out em algum worktree
 *      (`git branch -D` recusaria de qualquer forma — filtrar antes evita
 *      erro ruidoso no meio do lote).
 *   4. 1 chamada `gh pr list --state all --json headRefName,state --limit
 *      N` pra TODAS as branches de uma vez (não 1 chamada por branch —
 *      745 branches locais medidas na issue, uma chamada por branch
 *      estouraria rate limit em minutos). Um PR de uma branch antiga
 *      demais pra caber no limite conta como "nenhuma PR encontrada" —
 *      cai em `needs-review`, direção fail-closed (nunca vira
 *      `safe-delete` por engano de paginação). Falha desta chamada ABORTA
 *      o script inteiro (fail-closed — sem `gh`, nada pode ser classificado
 *      com segurança).
 *   5. Classifica cada branch (`classifyBranchForCleanup`) e cada worktree
 *      restante (`classifyWorktreeForCleanup`, cruzando com a decisão da
 *      branch dele).
 *   6. Sem `--push`: imprime relatório (contagens + listas) e para — gh
 *      NUNCA é chamado com efeito, git NUNCA apaga nada.
 *   7. Com `--push`: **worktrees primeiro** (`git worktree remove --force`
 *      nas `safe-remove` — remover o worktree libera a branch dele pro
 *      passo seguinte, se ela também for `safe-delete`), **depois**
 *      branches (`git branch -D` nas `safe-delete` restantes). `--force`
 *      só é seguro aqui porque o passo 5 já confirmou porcelain limpo E
 *      não-locked — nunca sobre diff sujo, status desconhecido, ou
 *      worktree explicitamente travado. Re-confirma `git status
 *      --porcelain` IMEDIATAMENTE antes de cada remoção (não só na
 *      classificação) — fecha a janela de corrida entre classificar e
 *      apagar, onde outra sessão poderia ter sujado o worktree nesse
 *      meio-tempo (review da PR #6852, P2/P3 — checkout compartilhado é
 *      padrão conhecido deste repo). `needs-review` NUNCA é tocado por
 *      este script, com ou sem --push — fica só no relatório, pra decisão
 *      humana.
 *
 * ## Fail-closed em erro de LISTAGEM (review da PR #6852, P2)
 *
 * `git worktree list`/`git for-each-ref` que FALHAM (não "saída vazia",
 * FALHAM — erro de processo) nunca são tratados como "0 candidatos, nada a
 * fazer": um erro estrutural (cwd não é repo git, permissão) reportado como
 * sucesso vazio esconderia que a varredura simplesmente não rodou. Esses 2
 * comandos abortam o script (mesma disciplina do `gh pr list`) se falharem
 * — só `git worktree prune` é best-effort (puramente informativo, nunca
 * decide segurança de nada).
 */

import { execFileSync } from "node:child_process";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  classifyBranchForCleanup,
  classifyWorktreeForCleanup,
  parseWorktreeListPorcelain,
  type CleanupDecision,
  type PorcelainStatus,
  type PrState,
  type WorktreeCleanupDecision,
} from "./lib/branch-cleanup.ts";

const LOG_PREFIX = "[branch-cleanup]";
/** Generoso o bastante pra cobrir o volume medido na issue (745 branches
 * locais) sem paginar — `gh pr list` aceita limites grandes num único
 * request. PR mais velha que isso cai em `needs-review` (fail-closed),
 * nunca em `safe-delete` por engano de paginação — o sinal secundário
 * (`isAncestorOfMaster`) ainda cobre branch fora da janela que de fato foi
 * integrada, então "sem PR encontrada por paginação" nunca é, sozinho, o
 * que decide `needs-review` — precisa TAMBÉM não ser ancestral. */
const GH_PR_LIST_LIMIT = 3000;

/** #6802, review da PR #6852 (P2, confiança alta) — todo `catch` deste
 * arquivo agora LOGA antes de engolir o erro. Um `gitOrNull` mudo (comportamento
 * pré-review) deixava "comando falhou" e "saída legitimamente vazia"
 * indistinguíveis nos 3 caminhos de listagem — exatamente o padrão "null
 * confundido com sinal negativo confirmado" que este fix fecha. */
function logGitFailure(args: string[], e: unknown): void {
  console.error(`${LOG_PREFIX} git ${args.join(" ")} falhou: ${(e as Error).message}`);
}

function git(args: string[], cwd = process.cwd()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Best-effort de verdade — só pra comandos cujo resultado NUNCA decide
 * segurança de apagar nada (`git worktree prune`). Loga a falha, nunca
 * lança. NÃO usar para nenhum comando cujo resultado alimenta
 * classificação — ver `gitRequired` abaixo. */
function gitBestEffort(args: string[], cwd = process.cwd()): string | null {
  try {
    return git(args, cwd);
  } catch (e) {
    logGitFailure(args, e);
    return null;
  }
}

/** Resultado de um comando cujo resultado ALIMENTA classificação/segurança
 * — nunca colapsa erro e vazio no mesmo valor. `ok: false` é sempre
 * fail-closed no chamador (aborta, ou trata como "sujo"/"desconhecido"),
 * nunca como "lista vazia legítima". */
type GitRequiredResult = { ok: true; stdout: string } | { ok: false; error: string };

function gitRequired(args: string[], cwd = process.cwd()): GitRequiredResult {
  try {
    return { ok: true, stdout: git(args, cwd) };
  } catch (e) {
    logGitFailure(args, e);
    return { ok: false, error: (e as Error).message };
  }
}

function isAncestorOfMaster(branch: string, cwd: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, "origin/master"], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `git status --porcelain` num worktree específico — nunca retorna
 * `"clean"` quando o comando falhou (ver `PorcelainStatus`). */
function checkPorcelainStatus(path: string, cwd: string): PorcelainStatus {
  try {
    const out = git(["-C", path, "status", "--porcelain"], cwd);
    return out.length === 0 ? "clean" : "dirty";
  } catch (e) {
    console.error(`${LOG_PREFIX} git status --porcelain falhou em ${path}: ${(e as Error).message} — tratando como desconhecido (fail-closed)`);
    return "unknown";
  }
}

interface PrRecord {
  headRefName: string;
  state: string;
}

const KNOWN_PR_STATES: ReadonlySet<string> = new Set<PrState>(["OPEN", "CLOSED", "MERGED"]);

function fetchAllPrStates(cwd: string): Map<string, PrState[]> {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--state", "all", "--json", "headRefName,state", "--limit", String(GH_PR_LIST_LIMIT)],
    { cwd, encoding: "utf8" },
  );
  const records = JSON.parse(out) as PrRecord[];
  const map = new Map<string, PrState[]>();
  for (const r of records) {
    // Estado fora do vocabulário conhecido (typo do lado do gh, ou um
    // valor futuro do GitHub) nunca vira "MERGED" por acidente — só é
    // adicionado se bater EXATAMENTE um dos 3 literais reconhecidos;
    // fora disso, a branch correspondente simplesmente não ganha esse
    // sinal (equivalente a "PR não encontrada" pra fins de classificação,
    // fail-closed).
    if (!KNOWN_PR_STATES.has(r.state)) continue;
    const list = map.get(r.headRefName) ?? [];
    list.push(r.state as PrState);
    map.set(r.headRefName, list);
  }
  return map;
}

interface WorktreeDecisionRow extends WorktreeCleanupDecision {
  readonly path: string;
  readonly branch: string | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const skipWorktrees = hasFlag(argv, "skip-worktrees");
  const cwd = process.cwd();

  // Passo 1 — best-effort de verdade (nunca decide segurança de nada).
  const pruneOut = gitBestEffort(["worktree", "prune", "-v"], cwd);
  console.log(`${LOG_PREFIX} git worktree prune: ${pruneOut || "(nada a podar)"}`);

  // Passo 2 — fetch antes de checar ancestralidade contra origin/master.
  // Fail-soft de propósito (ver docstring do módulo) — só warning, nunca aborta.
  const fetchResult = gitRequired(["fetch", "origin", "master", "--quiet"], cwd);
  if (!fetchResult.ok) {
    console.error(`${LOG_PREFIX} AVISO: git fetch origin master falhou (${fetchResult.error}) — ancestralidade vai usar o origin/master local, possivelmente desatualizado (só reduz sinal, nunca aumenta risco de apagar errado).`);
  }

  // Worktrees restantes (pós-prune) + branches checked-out em algum deles.
  // FAIL-CLOSED: erro real aqui aborta o script — "nada listado" != "nada existe".
  const worktreeListResult = gitRequired(["worktree", "list", "--porcelain"], cwd);
  if (!worktreeListResult.ok) {
    console.error(`${LOG_PREFIX} git worktree list falhou — abortando (fail-closed, sem essa listagem não dá pra saber o que está checked-out).`);
    process.exitCode = 1;
    return;
  }
  const worktrees = parseWorktreeListPorcelain(worktreeListResult.stdout);
  const checkedOutBranches = new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== null));

  // Passo 3 — branches locais candidatas. Inclui as checked-out em worktree
  // (precisam de decisão pra classificar o WORKTREE correspondente, passo
  // 5b abaixo) — só EXCLUI master/main. `git branch -D` numa branch
  // checked-out falharia de qualquer forma; o passo de apagar (só com
  // --push) filtra checkedOutBranches de novo antes de deletar.
  const allBranchesResult = gitRequired(["for-each-ref", "refs/heads", "--format=%(refname:short)"], cwd);
  if (!allBranchesResult.ok) {
    console.error(`${LOG_PREFIX} git for-each-ref falhou — abortando (fail-closed).`);
    process.exitCode = 1;
    return;
  }
  const allBranches = allBranchesResult.stdout
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .filter((b) => b !== "master" && b !== "main");

  console.log(
    `${LOG_PREFIX} branches locais candidatas (excl. master/main): ${allBranches.length} ` +
      `(${checkedOutBranches.size} checked-out em worktree)`,
  );

  // Passo 4 — 1 chamada gh pra todas.
  let prStatesByBranch: Map<string, PrState[]>;
  try {
    prStatesByBranch = fetchAllPrStates(cwd);
  } catch (e) {
    console.error(`${LOG_PREFIX} gh pr list falhou: ${(e as Error).message} — abortando (fail-closed, sem gh não classifica nada)`);
    process.exitCode = 1;
    return;
  }

  // Passo 5 — classifica branches.
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
  const worktreeDecisions: WorktreeDecisionRow[] = [];
  if (!skipWorktrees) {
    for (const wt of worktrees) {
      if (wt.path === mainWorktreePath) continue;
      if (wt.prunable) continue; // já coberto pelo passo 1, não deveria sobrar, mas defesa em profundidade
      const porcelainStatus = checkPorcelainStatus(wt.path, cwd);
      const branchDecision = wt.branch ? (branchDecisions.get(wt.branch) ?? null) : null;
      const decision = classifyWorktreeForCleanup({
        path: wt.path,
        branch: wt.branch,
        porcelainStatus,
        locked: wt.locked,
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
      // Re-checagem IMEDIATAMENTE antes da remoção — fecha a janela de
      // corrida entre a classificação (acima) e agora: outra sessão pode
      // ter sujado o worktree nesse meio-tempo (checkout compartilhado é
      // padrão conhecido deste repo). --force só é seguro com este recheck.
      const recheckedStatus = checkPorcelainStatus(w.path, cwd);
      if (recheckedStatus !== "clean") {
        console.error(
          `${LOG_PREFIX} pulando remoção de ${w.path}: estava limpo na classificação mas não está mais agora (${recheckedStatus}) — provável escrita concorrente, needs-review nesta rodada.`,
        );
        continue;
      }
      const removeResult = execFileSyncCaptured(["worktree", "remove", "--force", w.path], cwd);
      if (removeResult.ok) {
        removedWt++;
        console.log(`${LOG_PREFIX} worktree removido: ${w.path}`);
      } else {
        console.error(`${LOG_PREFIX} falha ao remover worktree ${w.path}: ${removeResult.error}`);
      }
    }
  }

  let removedBranches = 0;
  for (const [branch, d] of deletableBranchEntries) {
    if (d.verdict !== "safe-delete") continue;
    const deleteResult = execFileSyncCaptured(["branch", "-D", branch], cwd);
    if (deleteResult.ok) {
      removedBranches++;
    } else {
      console.error(`${LOG_PREFIX} falha ao apagar branch ${branch}: ${deleteResult.error}`);
    }
  }

  console.log(`${LOG_PREFIX} --push aplicado: ${removedBranches} branch(es) apagada(s), ${removedWt} worktree(s) removido(s).`);
}

/** `execFileSync` com `stdio: "ignore"` descarta o stderr real do git — o
 * catch acabava logando só "Command failed: ..." sem o motivo (review da
 * PR #6852, P3). Captura stderr via pipe pra diagnóstico útil, mantendo o
 * mesmo contrato de nunca lançar pro chamador. */
function execFileSyncCaptured(args: string[], cwd: string): { ok: true } | { ok: false; error: string } {
  try {
    execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true };
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim();
    return { ok: false, error: stderr || (e as Error).message };
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
