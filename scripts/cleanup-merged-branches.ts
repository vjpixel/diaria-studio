/**
 * scripts/cleanup-merged-branches.ts (#4706)
 *
 * Espelha `scripts/cleanup-merged-worktrees.ts` (#4335) pro problema irmão:
 * branches REMOTAS `overnight/*`/`develop/*` que sobrevivem indefinidamente
 * depois que o PR delas já foi mergeado. O fluxo de merge do repo é sempre
 * SQUASH (#636) — uma branch mergeada nunca vira ancestral de `master`, então
 * `git merge-base --is-ancestor origin/{branch} origin/master` retorna falso
 * pra TODAS as branches, inclusive as já mergeadas. A checagem correta é pelo
 * ESTADO DO PR, não pelo grafo de commits — mesmo critério que
 * `cleanup-merged-worktrees.ts` já usa: `gh pr list --head {branch} --state
 * merged`.
 *
 * **PR fechado SEM merge não é lixo.** Uma branch pode ser preservada de
 * propósito mesmo com o PR fechado (ex: `develop/fix-4669`, diff é o único
 * registro de um trabalho suspenso, ver #4706) — este script só marca pra
 * deleção o que tem PR **mergeado** confirmado; qualquer outra coisa
 * (PR fechado sem merge, PR aberto, sem PR nenhum) fica de fora por design,
 * pra o editor triar caso a caso.
 *
 * Diferente de `cleanup-merged-worktrees.ts` (que já roda automaticamente no
 * fim de overnight/develop, com dry-run OPT-IN via `--dry-run`), este script
 * é **dry-run por padrão** — deletar uma branch remota é uma ação mais
 * "pública" (visível em `git branch -r` de qualquer clone) e este script
 * ainda não está integrado a nenhum fluxo automático (#4706 deixa isso como
 * follow-up opcional). `--push` é o opt-in explícito pra deletar de verdade.
 *
 * Uso:
 *   npx tsx scripts/cleanup-merged-branches.ts [--push] [--root <repoRoot>] [--prefix overnight/,develop/]
 *
 * Lógica pura (testável sem git/gh reais):
 *   - parseLsRemoteHeads(output) — parseia `git ls-remote --heads origin ...`.
 *   - selectMergedForDeletion(branches, isMerged) — dado um checker
 *     injetável `(branch) => boolean`, retorna só os confirmados como
 *     mergeados.
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsWithTrueDefault as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { checkBranchMergedViaGh } from "./cleanup-merged-worktrees.ts"; // #4706: reusa o mesmo checker gh, sem duplicar

const DEFAULT_PREFIXES = ["overnight/", "develop/"];

/**
 * Parseia a saída de `git ls-remote --heads origin <pattern...>`. Formato:
 * `<sha>\trefs/heads/<branch>` por linha. Linhas vazias/malformadas são
 * ignoradas (defensivo — nunca deveria acontecer no formato real do git).
 */
export function parseLsRemoteHeads(output: string): string[] {
  const branches: string[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx === -1) continue;
    const ref = line.slice(tabIdx + 1).trim();
    if (!ref.startsWith("refs/heads/")) continue;
    branches.push(ref.slice("refs/heads/".length));
  }
  return branches;
}

/**
 * Seleciona, dentre as branches candidatas, as que devem ser deletadas —
 * `isMerged(branch)` retorna true. Injetável pra testar a lógica de seleção
 * sem chamar `gh` de verdade.
 */
export function selectMergedForDeletion(
  branches: string[],
  isMerged: (branch: string) => boolean,
): string[] {
  return branches.filter((b) => isMerged(b));
}

/**
 * #4744 fleet review: entre as branches já confirmadas como "PR mergeado
 * existe", separa as que têm um PR ABERTO reusando o mesmo nome AGORA (nome
 * reaproveitado numa retentativa — não são lixo, excluir da deleção) das
 * que estão genuinamente seguras. `hasOpenPr` é injetável (mesmo padrão de
 * `isMerged` em `selectMergedForDeletion`) pra testar sem `gh` real.
 */
export function excludeReopenedBranches(
  branches: string[],
  hasOpenPr: (branch: string) => boolean,
): { safe: string[]; excluded: string[] } {
  const excluded = branches.filter((b) => hasOpenPr(b));
  const safe = branches.filter((b) => !hasOpenPr(b));
  return { safe, excluded };
}

// ─── I/O real (fail-soft) ────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 15_000;

function listRemoteBranchesSafe(cwd: string, prefixes: string[]): string[] {
  try {
    const patterns = prefixes.map((p) => `${p}*`);
    const result = spawnSync("git", ["ls-remote", "--heads", "origin", ...patterns], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      console.warn(`[cleanup-merged-branches] git ls-remote falhou (status ${result.status}): ${result.stderr?.trim()}`);
      return [];
    }
    return parseLsRemoteHeads(result.stdout ?? "");
  } catch (e) {
    console.warn(`[cleanup-merged-branches] git ls-remote lançou: ${(e as Error).message}`);
    return [];
  }
}

/**
 * `gh pr list --head {branch} --state open` — true se existir um PR ABERTO
 * usando este nome de branch AGORA. #4744 fleet review: `checkBranchMergedViaGh`
 * só pergunta "existe algum PR HISTORICAMENTE mergeado com este nome?" — não
 * garante que o nome não foi reaproveitado por um PR novo, ainda aberto,
 * depois que o antigo foi mergeado (branch com nome baseado em número de
 * issue reaberta, ex: `overnight/fix-4700` reusado numa 2ª tentativa). Sem
 * este guard extra, `cleanup-merged-branches.ts` deletaria a branch remota
 * de um PR aberto em andamento só porque um PR ANTIGO, já mergeado, tinha o
 * mesmo nome — irreversível (perde o trabalho não mergeado ainda). Fail-soft
 * pro lado SEGURO: qualquer erro na consulta retorna `true` (assume que HÁ
 * um PR aberto, não deleta) — o oposto do fail-soft de `checkBranchMergedViaGh`
 * (que retorna `false`/não-mergeado em erro), porque aqui um falso positivo
 * é "não deletei uma branch seguramente deletável" (barato, resolve na
 * próxima execução) enquanto lá seria "deletei uma branch que não devia"
 * (irreversível).
 */
export function hasOpenPrForBranch(branch: string, cwd: string): boolean {
  try {
    const result = spawnSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "open", "--json", "number", "--limit", "1"],
      { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS },
    );
    if (result.status !== 0) return true;
    const parsed = JSON.parse(result.stdout ?? "[]") as unknown[];
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return true;
  }
}

/** `git push origin --delete {branch}` — nunca lança; retorna resultado pro caller logar. */
export function deleteRemoteBranchSafe(branch: string, cwd: string): { ok: boolean; error?: string } {
  try {
    const result = spawnSync("git", ["push", "origin", "--delete", branch], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.root ? resolve(String(args.root)) : ROOT;
  const push = args.push === "true";
  const prefixes = args.prefix
    ? String(args.prefix).split(",").map((p) => p.trim()).filter(Boolean)
    : DEFAULT_PREFIXES;

  // Fail-soft de topo — mesmo racional de cleanup-merged-worktrees.ts (#4335):
  // este script é pensado pra rodar tanto manual quanto (no futuro, #4706
  // deixa como follow-up) embutido num fluxo automático; um erro inesperado
  // aqui nunca deve propagar como exceção não tratada.
  try {
    const all = listRemoteBranchesSafe(repoRoot, prefixes);

    if (all.length === 0) {
      console.log(`[cleanup-merged-branches] nenhuma branch remota sob ${prefixes.join(", ")} — nada a fazer.`);
      return;
    }

    const mergedCandidates = selectMergedForDeletion(all, (branch) => checkBranchMergedViaGh(branch, repoRoot));
    const unmerged = all.filter((b) => !mergedCandidates.includes(b));

    // #4744 fleet review: um nome de branch pode ter um PR ANTIGO mergeado
    // E um PR NOVO ainda aberto reusando o mesmo nome (issue reaberta,
    // retentativa) — checkBranchMergedViaGh sozinho não distingue os dois
    // casos. Reconfirma cada candidata contra PR ABERTO antes de deletar;
    // qualquer uma com PR aberto agora sai da lista de deleção (fail-soft
    // pro lado seguro — ver docstring de hasOpenPrForBranch).
    const { safe: merged, excluded: reopened } = excludeReopenedBranches(mergedCandidates, (branch) =>
      hasOpenPrForBranch(branch, repoRoot),
    );

    console.log(
      `[cleanup-merged-branches] ${all.length} branch(es) remota(s) encontrada(s) sob ${prefixes.join(", ")}, ` +
        `${merged.length} com PR mergeada confirmada e SEM PR aberto reusando o nome, ${unmerged.length} sem confirmação ` +
        `(PR aberto/fechado-sem-merge/sem PR — não tocadas)` +
        `${reopened.length > 0 ? `, ${reopened.length} excluída(s) da deleção por ter PR ABERTO reusando o nome (${reopened.join(", ")})` : ""}.`,
    );

    if (!push) {
      for (const branch of merged) {
        console.log(`[cleanup-merged-branches] (dry-run) deletaria: ${branch}`);
      }
      console.log(
        `[cleanup-merged-branches] dry-run — nenhuma branch deletada. Rode com --push pra deletar de verdade.`,
      );
      return;
    }

    let deleted = 0;
    let failed = 0;
    for (const branch of merged) {
      const result = deleteRemoteBranchSafe(branch, repoRoot);
      if (result.ok) {
        deleted++;
        console.log(`[cleanup-merged-branches] deletada: ${branch}`);
      } else {
        failed++;
        console.warn(`[cleanup-merged-branches] falha ao deletar ${branch}: ${result.error}`);
      }
    }
    console.log(`[cleanup-merged-branches] fim: ${deleted} deletada(s), ${failed} falha(s).`);
  } catch (e) {
    console.warn(`[cleanup-merged-branches] erro inesperado, pulando cleanup (fail-soft): ${(e as Error).message}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
