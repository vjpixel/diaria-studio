/**
 * git-sync.ts (#2686)
 *
 * Helper testável para sincronizar o checkout local com origin/master no início
 * de cada edição (`/diaria-edicao`). Garante que o pipeline rode sempre com a
 * versão mais recente do código (rodadas overnight/develop mergeiam muito).
 *
 * Comportamento:
 *   1. Se não estiver em master → tenta `git checkout master` antes do sync.
 *      Se checkout falhar → warn + retorna sem forçar (fail-soft).
 *   2. `git fetch origin` — fail-soft (offline, credencial, etc.) → warn + retorna.
 *   3. Se working tree suja → stash → pull --ff-only → stash pop (reversível).
 *      Se stash falhar → warn + retorna sem tocar o tree.
 *      Se stash pop falhar (conflito de merge) → warn + stash preservado.
 *   4. Se working tree limpa → pull --ff-only direto.
 *      Se ff-only falhar (divergência) → warn + retorna (nunca força merge).
 *   5. Falha de fetch OU ff_failed OU stash_pop_failed NÃO bloqueiam a edição
 *      — retornam status de warn e a skill continua.
 *
 * Idempotente: re-rodar não tem efeito colateral se já atualizado.
 *
 * @see .claude/skills/diaria-edicao/SKILL.md — invocado no Passo 0.
 */

import { spawnSync } from "node:child_process";

/** Resultado de uma chamada de processo injetável (testável sem git real). */
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Tipo do spawner injetável. Produção usa spawnSync; testes usam mock. */
export type SpawnFn = (cmd: string, args: string[]) => SpawnResult;

/** Status da operação de sync. */
export type GitSyncOutcome =
  | "synced"              // pull --ff-only bem-sucedido em tree limpa
  | "synced_stashed"      // stash → pull --ff-only → stash pop OK
  | "already_up_to_date"  // já na versão mais recente (tree limpa ou suja)
  | "fetch_failed"        // git fetch falhou (offline / auth) — warn, segue
  | "ff_failed"           // pull --ff-only falhou (divergência) — warn, segue
  | "stash_failed"        // stash falhou — skip pull, tree não tocada — warn, segue
  | "stash_pop_failed"    // pull OK mas stash pop teve conflito — warn, stash preservado
  | "checkout_failed";    // não estava em master e checkout master falhou — warn, segue

/** Resultado completo do sync. */
export interface GitSyncResult {
  outcome: GitSyncOutcome;
  message: string;
  branch_before: string;
  warnings: string[];
  /** true quando a edição pode continuar normalmente (sempre true — fail-soft). */
  proceed: true;
}

function defaultSpawn(cmd: string, args: string[]): SpawnResult {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    status: r.status,
    stdout: (r.stdout as string | null) ?? "",
    stderr: (r.stderr as string | null) ?? "",
  };
}

function isAlreadyUpToDate(stdout: string): boolean {
  // git pull --ff-only imprime "Already up to date." (EN) ou "Já está atualizado." (PT)
  return /already up.to.date/i.test(stdout) || /j[aá] est[aá]/i.test(stdout);
}

/**
 * Sincroniza o checkout local com origin/master.
 *
 * @param spawn   Spawner injetável para testes (default: spawnSync real).
 * @param cwd     Diretório de trabalho do git (default: undefined = CWD do processo).
 */
export function syncCode(spawn: SpawnFn = defaultSpawn): GitSyncResult {
  const warnings: string[] = [];

  // ── 1. Branch atual ────────────────────────────────────────────────────────
  const branchRes = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branchBefore = branchRes.stdout.trim() || "unknown";

  // ── 2. Se não estiver em master → checkout master ─────────────────────────
  if (branchBefore !== "master") {
    const w = `[git-sync] Branch atual: '${branchBefore}'. Tentando checkout master antes do sync.`;
    warnings.push(w);
    const checkoutRes = spawn("git", ["checkout", "master"]);
    if (checkoutRes.status !== 0) {
      const msg =
        `[git-sync] WARN: checkout master falhou (branch='${branchBefore}'). ` +
        `Sync ignorado — edição continua com código local. ` +
        `Stderr: ${checkoutRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "checkout_failed", message: msg, branch_before: branchBefore, warnings, proceed: true };
    }
    warnings.push("[git-sync] Switched to master.");
  }

  // ── 3. git fetch origin ────────────────────────────────────────────────────
  const fetchRes = spawn("git", ["fetch", "origin"]);
  if (fetchRes.status !== 0) {
    const msg =
      `[git-sync] WARN: git fetch origin falhou (offline ou erro de rede). ` +
      `Edição continua com código local. ` +
      `Stderr: ${fetchRes.stderr.trim() || "(vazio)"}`;
    warnings.push(msg);
    return { outcome: "fetch_failed", message: msg, branch_before: branchBefore, warnings, proceed: true };
  }

  // ── 4. Dirty check ────────────────────────────────────────────────────────
  const statusRes = spawn("git", ["status", "--porcelain"]);
  const isDirty = statusRes.stdout.trim().length > 0;

  if (isDirty) {
    // ── 5a. Dirty tree: stash → pull --ff-only → stash pop ─────────────────
    const stashRes = spawn("git", ["stash", "--include-untracked"]);
    if (stashRes.status !== 0) {
      const msg =
        `[git-sync] WARN: git stash falhou — sync ignorado, working tree não tocada. ` +
        `Stderr: ${stashRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "stash_failed", message: msg, branch_before: branchBefore, warnings, proceed: true };
    }

    const stashedSomething = !stashRes.stdout.includes("No local changes to save");

    // pull --ff-only
    const pullRes = spawn("git", ["pull", "--ff-only", "origin", "master"]);

    // ── restaurar stash sempre (mesmo se pull falhou) ─────────────────────
    if (stashedSomething) {
      const popRes = spawn("git", ["stash", "pop"]);
      if (popRes.status !== 0) {
        // pull pode ter trazido mudanças conflitantes com o stash
        const msg =
          `[git-sync] WARN: git stash pop teve conflito. Stash preservado — ` +
          `use 'git stash show' para ver. ` +
          `Stderr: ${popRes.stderr.trim() || "(vazio)"}`;
        warnings.push(msg);
        // Se o pull em si também falhou, reportar ff_failed; senão stash_pop_failed.
        const outcome = pullRes.status !== 0 ? "ff_failed" : "stash_pop_failed";
        return { outcome, message: msg, branch_before: branchBefore, warnings, proceed: true };
      }
    }

    if (pullRes.status !== 0) {
      const msg =
        `[git-sync] WARN: git pull --ff-only falhou (divergência?). ` +
        `Working tree restaurada. Edição continua com código local. ` +
        `Stderr: ${pullRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "ff_failed", message: msg, branch_before: branchBefore, warnings, proceed: true };
    }

    const upToDate = isAlreadyUpToDate(pullRes.stdout);
    return {
      outcome: upToDate ? "already_up_to_date" : "synced_stashed",
      message: upToDate
        ? "[git-sync] Código já estava atualizado (dirty tree restaurada)."
        : "[git-sync] Código sincronizado com origin/master (dirty tree restaurada via stash).",
      branch_before: branchBefore,
      warnings,
      proceed: true,
    };
  } else {
    // ── 5b. Clean tree: pull --ff-only direto ─────────────────────────────
    const pullRes = spawn("git", ["pull", "--ff-only", "origin", "master"]);

    if (pullRes.status !== 0) {
      const msg =
        `[git-sync] WARN: git pull --ff-only falhou (divergência ou conflito). ` +
        `Edição continua com código local. ` +
        `Stderr: ${pullRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "ff_failed", message: msg, branch_before: branchBefore, warnings, proceed: true };
    }

    const upToDate = isAlreadyUpToDate(pullRes.stdout);
    return {
      outcome: upToDate ? "already_up_to_date" : "synced",
      message: upToDate
        ? "[git-sync] Código já estava atualizado."
        : "[git-sync] Código sincronizado com origin/master.",
      branch_before: branchBefore,
      warnings,
      proceed: true,
    };
  }
}
