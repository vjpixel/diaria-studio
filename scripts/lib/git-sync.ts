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
 *   3. Se working tree suja → stash → merge --ff-only origin/master → stash pop
 *      (reversível). Se stash falhar → warn + retorna sem tocar o tree.
 *      Se stash pop falhar (conflito de merge) → warn + stash preservado.
 *   4. Se working tree limpa → merge --ff-only origin/master direto.
 *      Se ff-only falhar (divergência) → warn + retorna (nunca força merge).
 *   5. Falha de fetch OU ff_failed OU stash_pop_failed NÃO bloqueiam a edição
 *      — retornam status de warn e a skill continua.
 *
 * Nota: usa `git merge --ff-only origin/master` (não `git pull`) após o fetch
 * explícito do passo 2 — evita um segundo fetch implícito (rede = única
 * superfície de falha) e roda offline-friendly contra o ref já buscado.
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

/**
 * Timeout por comando git (#2686 review — angle H). Sem isso, um git que trava
 * esperando passphrase de SSH ou credencial bloquearia o processo indefinidamente,
 * derrotando o fail-soft. 120s cobre fetch/pull em conexões lentas com folga.
 */
const GIT_TIMEOUT_MS = 120_000;

function defaultSpawn(cmd: string, args: string[]): SpawnResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  return {
    status: r.status,
    stdout: (r.stdout as string | null) ?? "",
    stderr: (r.stderr as string | null) ?? "",
  };
}

function isAlreadyUpToDate(stdout: string): boolean {
  // git merge/pull imprime "Already up to date." (EN) ou "Já está atualizado." (PT).
  // Espaços literais (não wildcards) — evita falso-positivo em strings inesperadas.
  return /already up to date/i.test(stdout) || /j[aá] est[aá] atualizad/i.test(stdout);
}

/**
 * Sincroniza o checkout local com origin/master.
 *
 * @param spawn   Spawner injetável para testes (default: spawnSync real).
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
  // Se o próprio `git status` falhar (índice corrompido, .git/index.lock travado),
  // NÃO assumir tree limpa — isso pularia a proteção do stash e o ff poderia
  // mover o branch sob mudanças não-protegidas. Conservador: tratar como dirty
  // (força o caminho com stash, que protege ou aborta limpo via stash_failed).
  const statusRes = spawn("git", ["status", "--porcelain"]);
  if (statusRes.status !== 0) {
    warnings.push(
      `[git-sync] WARN: git status falhou (exit ${statusRes.status}). ` +
        `Tratando como dirty por segurança. Stderr: ${statusRes.stderr.trim() || "(vazio)"}`,
    );
  }
  const isDirty = statusRes.status !== 0 || statusRes.stdout.trim().length > 0;

  if (isDirty) {
    // ── 5a. Dirty tree: stash → merge --ff-only → stash pop ────────────────
    const stashRes = spawn("git", ["stash", "--include-untracked"]);
    if (stashRes.status !== 0) {
      const msg =
        `[git-sync] WARN: git stash falhou — sync ignorado, working tree não tocada. ` +
        `Stderr: ${stashRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "stash_failed", message: msg, branch_before: branchBefore, warnings, proceed: true };
    }

    // Detecção locale-robusta de "nada foi guardado" (#2686 review — EN + PT-BR).
    // Dentro do branch isDirty, o esperado é que algo tenha sido guardado; só
    // pulamos o pop quando o git explicitamente diz que não havia nada (evita
    // `stash pop` numa pilha vazia, que falharia espuriamente).
    const stashedNothing =
      /no local changes to save/i.test(stashRes.stdout) ||
      /n(ã|a)o h(á|a) (mudan|altera)/i.test(stashRes.stdout);
    const stashedSomething = !stashedNothing;

    // ff-only via merge do ref já buscado no passo 3 — evita o re-fetch implícito
    // do `git pull` (segunda superfície de falha de rede) (#2686 review — angle H/I).
    const pullRes = spawn("git", ["merge", "--ff-only", "origin/master"]);

    // ── restaurar stash sempre (mesmo se o merge falhou) ──────────────────
    if (stashedSomething) {
      const popRes = spawn("git", ["stash", "pop"]);
      if (popRes.status !== 0) {
        // merge pode ter trazido mudanças conflitantes com o stash.
        // Se o merge TAMBÉM falhou, incluir o stderr dele — senão a mensagem
        // apontaria só pro conflito de stash e esconderia a divergência (#2686
        // review — angles A/B/G/J/C).
        const ffFailed = pullRes.status !== 0;
        const msg = ffFailed
          ? `[git-sync] WARN: ff (merge --ff-only) falhou (divergência) E git stash pop teve conflito. ` +
            `Stash preservado — use 'git stash show'. ` +
            `Stderr ff: ${pullRes.stderr.trim() || "(vazio)"} | Stderr pop: ${popRes.stderr.trim() || "(vazio)"}`
          : `[git-sync] WARN: git stash pop teve conflito. Stash preservado — ` +
            `use 'git stash show' para ver. Stderr: ${popRes.stderr.trim() || "(vazio)"}`;
        warnings.push(msg);
        const outcome = ffFailed ? "ff_failed" : "stash_pop_failed";
        return { outcome, message: msg, branch_before: branchBefore, warnings, proceed: true };
      }
    }

    if (pullRes.status !== 0) {
      const msg =
        `[git-sync] WARN: ff (merge --ff-only origin/master) falhou (divergência?). ` +
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
    // ── 5b. Clean tree: merge --ff-only direto ────────────────────────────
    const pullRes = spawn("git", ["merge", "--ff-only", "origin/master"]);

    if (pullRes.status !== 0) {
      const msg =
        `[git-sync] WARN: ff (merge --ff-only origin/master) falhou (divergência ou conflito). ` +
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
