/**
 * scripts/cleanup-merged-worktrees.ts (#4335, follow-up do #4326)
 *
 * `.claude/worktrees/` acumula worktrees órfãos ao longo do tempo — sessões
 * overnight/develop que usam `isolation: "worktree"` (praticamente todas) e,
 * por algum motivo (crash, mini-rodada que não chegou no passo de cleanup do
 * SKILL.md, sessão interrompida), não removeram o worktree após o merge do
 * PR. O #4326 (fechado 260729c) encontrou 47 acumulados, removeu 31 manualmente
 * — só os com PR mergeada CONFIRMADA via `gh pr list --head {branch} --state
 * merged` (achado do #4326: `git worktree prune`/`git branch --merged` não
 * servem aqui — os merges do repo são sempre squash [#636], então o commit da
 * branch nunca aparece como ancestral de master via `git branch --merged`, e
 * `prunable` do `git worktree list` só marca um worktree cujo DIRETÓRIO já
 * sumiu do disco, nunca um que ainda existe mas cuja branch já foi mergeada).
 *
 * Este script automatiza a mesma checagem: lista os worktrees sob
 * `.claude/worktrees/`, resolve a branch de cada um, confere via `gh pr list
 * --head {branch} --state merged` se existe PR mergeada pra essa branch, e
 * remove (`git worktree remove --force`) os confirmados.
 *
 * Invocado no fim de `/diaria-overnight` e `/diaria-develop` (Fase 2, ver
 * SKILL.md de cada skill) — **FAIL-SOFT por design**: qualquer erro (gh
 * indisponível, permissão negada num diretório, rate limit) NUNCA deve
 * travar o encerramento da sessão. Cada worktree é tratado independentemente
 * — falha num não impede a checagem/remoção dos demais.
 *
 * **Guard de sessão compartilhada (#5156 item 9).** `.claude/worktrees/` pode
 * ter worktrees vivos de OUTRA sessão `/diaria-overnight`/`/diaria-develop`
 * rodando em paralelo (mesma máquina) — um `git worktree remove --force`
 * disparado no meio dessa outra sessão remove um diretório que ela ainda está
 * usando. Antes de varrer, o script consulta `scripts/lib/session-registry.ts`
 * (`listActiveSessions`) — se houver QUALQUER sessão ativa registrada nesta
 * máquina, a varredura destrutiva é PULADA por padrão (mesmo em `--dry-run`
 * seria só leitura, mas o padrão aqui é conservador: sem confirmação
 * explícita, nem lista o que removeria) com um aviso explicando o motivo;
 * `--confirm-shared` prossegue mesmo assim (uso em contexto onde o chamador já
 * confirmou que é seguro — ex: as sessões ativas não têm worktree conflitante).
 * Registro de sessão é **opt-in** (rollout novo, #5156) — nenhuma sessão
 * registrada (caso comum hoje, antes do rollout completo nas duas skills) =
 * comportamento IDÊNTICO ao pré-#5156, sem gate nenhum.
 *
 * Uso:
 *   npx tsx scripts/cleanup-merged-worktrees.ts [--dry-run] [--root <repoRoot>] [--confirm-shared]
 *
 * Lógica pura (testável sem git/gh reais):
 *   - parseWorktreePorcelain(output) — parseia `git worktree list --porcelain`.
 *   - filterUnderWorktreesDir(entries, worktreesDir) — só os sob
 *     `.claude/worktrees/` (nunca o worktree principal do repo).
 *   - selectMergedForRemoval(entries, isMerged) — dado um checker injetável
 *     `(branch) => boolean`, retorna só os confirmados como mergeados.
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsWithTrueDefault as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { listActiveSessions, type SessionRecord } from "./lib/session-registry.ts";

export interface WorktreeEntry {
  /** Path absoluto do worktree (normalizado com `/`). */
  path: string;
  /** Nome da branch (sem `refs/heads/`), ou `null` se detached/bare. */
  branch: string | null;
}

/**
 * Parseia a saída de `git worktree list --porcelain`. Blocos separados por
 * linha em branco; cada bloco tem `worktree <path>`, opcionalmente `HEAD
 * <sha>`, e um de `branch refs/heads/<nome>` / `detached` / `bare`.
 */
export function parseWorktreePorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  const flush = () => {
    if (currentPath !== null) {
      entries.push({ path: currentPath, branch: currentBranch });
    }
    currentPath = null;
    currentBranch = null;
  };

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      // Uma nova entrada "worktree" antes de uma linha em branco (não deveria
      // acontecer no formato real, mas defensivo): fecha a anterior primeiro.
      if (currentPath !== null) flush();
      currentPath = line.slice("worktree ".length).trim().replace(/\\/g, "/");
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      currentBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
    // "HEAD <sha>", "detached", "bare" — ignorados (branch fica null se nunca setado).
  }
  flush();

  return entries;
}

/** Mantém só os worktrees cujo path está sob `worktreesDir` (nunca o worktree principal do repo). */
export function filterUnderWorktreesDir(entries: WorktreeEntry[], worktreesDir: string): WorktreeEntry[] {
  const normalizedDir = worktreesDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return entries.filter((e) => e.path.startsWith(normalizedDir + "/"));
}

/**
 * Seleciona, dentre os worktrees candidatos, os que devem ser removidos —
 * branch não-nula E `isMerged(branch)` retorna true. `isMerged` é injetável
 * pra testar a lógica de seleção sem chamar `gh` de verdade.
 */
export function selectMergedForRemoval(
  entries: WorktreeEntry[],
  isMerged: (branch: string) => boolean,
): WorktreeEntry[] {
  return entries.filter((e) => e.branch !== null && isMerged(e.branch));
}

// ─── I/O real (fail-soft) ────────────────────────────────────────────────

const GH_TIMEOUT_MS = 10_000;

/**
 * `gh pr list --head {branch} --state merged` — retorna true só se a chamada
 * teve sucesso E encontrou ≥1 PR mergeada. Qualquer falha (gh ausente,
 * timeout, rate limit, JSON inesperado) retorna **false** (fail-soft: never
 * assume merged on error — o pior caso de um falso-negativo aqui é só "não
 * limpou este worktree agora", nunca uma remoção indevida).
 */
export function checkBranchMergedViaGh(branch: string, cwd: string): boolean {
  try {
    const result = spawnSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "merged", "--json", "number", "--limit", "1"],
      { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS },
    );
    if (result.status !== 0) return false;
    const parsed = JSON.parse(result.stdout ?? "[]") as unknown[];
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/** `git worktree remove --force {path}` — nunca lança; retorna resultado pro caller logar. */
export function removeWorktreeSafe(path: string, cwd: string): { ok: boolean; error?: string } {
  try {
    const result = spawnSync("git", ["worktree", "remove", "--force", path], {
      cwd,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function listWorktreesSafe(cwd: string): WorktreeEntry[] {
  try {
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      console.warn(`[cleanup-merged-worktrees] git worktree list falhou (status ${result.status}): ${result.stderr?.trim()}`);
      return [];
    }
    return parseWorktreePorcelain(result.stdout ?? "");
  } catch (e) {
    console.warn(`[cleanup-merged-worktrees] git worktree list lançou: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Decide se a varredura destrutiva deve ser pulada por segurança (#5156 item
 * 9) — pura, testável sem tocar `data/sessions/` real. Pula quando existe
 * ≥1 sessão ativa registrada E `confirmShared` não foi passado. Registro
 * vazio (opt-in ainda não adotado, ou nenhuma outra sessão rodando) nunca
 * pula — comportamento idêntico ao pré-#5156.
 */
export function shouldSkipForSharedSession(activeSessions: SessionRecord[], confirmShared: boolean): boolean {
  return activeSessions.length > 0 && !confirmShared;
}

function listActiveSessionsSafe(repoRoot: string): SessionRecord[] {
  try {
    return listActiveSessions(repoRoot);
  } catch (e) {
    console.warn(`[cleanup-merged-worktrees] listActiveSessions lançou (fail-soft, tratando como vazio): ${(e as Error).message}`);
    return [];
  }
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.root ? resolve(String(args.root)) : ROOT;
  const dryRun = args["dry-run"] === "true";
  const confirmShared = args["confirm-shared"] === "true";
  const worktreesDir = resolve(repoRoot, ".claude", "worktrees").replace(/\\/g, "/");

  // Fail-soft de topo: qualquer exceção não prevista aqui é logada como
  // warning e o script sai 0 — este step nunca deve travar o encerramento
  // da sessão overnight/develop que o invoca (#4335, requisito explícito).
  try {
    const activeSessions = listActiveSessionsSafe(repoRoot);
    if (shouldSkipForSharedSession(activeSessions, confirmShared)) {
      const who = activeSessions.map((s) => `${s.kind}:${s.sessionId}`).join(", ");
      console.warn(
        `[cleanup-merged-worktrees] ${activeSessions.length} sessão(ões) ativa(s) detectada(s) em data/sessions/ (${who}) — ` +
          "pulando a varredura de .claude/worktrees/ por segurança (#5156 item 9): um worktree ainda em uso por " +
          "outra sessão poderia ser removido no meio do trabalho dela. Rode de novo com --confirm-shared se já " +
          "confirmou que é seguro prosseguir mesmo assim.",
      );
      return;
    }

    const all = listWorktreesSafe(repoRoot);
    const candidates = filterUnderWorktreesDir(all, worktreesDir);

    if (candidates.length === 0) {
      console.log("[cleanup-merged-worktrees] nenhum worktree em .claude/worktrees/ — nada a fazer.");
      return;
    }

    const toRemove = selectMergedForRemoval(candidates, (branch) => checkBranchMergedViaGh(branch, repoRoot));

    console.log(
      `[cleanup-merged-worktrees] ${candidates.length} worktree(s) encontrados, ${toRemove.length} com PR mergeada confirmada.`,
    );

    let removed = 0;
    let failed = 0;
    for (const entry of toRemove) {
      if (dryRun) {
        console.log(`[cleanup-merged-worktrees] (dry-run) removeria: ${entry.path} (branch ${entry.branch})`);
        continue;
      }
      const result = removeWorktreeSafe(entry.path, repoRoot);
      if (result.ok) {
        removed++;
        console.log(`[cleanup-merged-worktrees] removido: ${entry.path} (branch ${entry.branch})`);
      } else {
        failed++;
        console.warn(`[cleanup-merged-worktrees] falha ao remover ${entry.path}: ${result.error}`);
      }
    }

    if (!dryRun) {
      console.log(`[cleanup-merged-worktrees] fim: ${removed} removido(s), ${failed} falha(s).`);
    }
  } catch (e) {
    console.warn(`[cleanup-merged-worktrees] erro inesperado, pulando cleanup (fail-soft): ${(e as Error).message}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
