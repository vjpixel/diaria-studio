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
 *      (reversível). Se stash falhar E nenhum stash tiver sido criado → warn +
 *      retorna sem tocar o tree ("stash_failed"). Se stash pop falhar (conflito
 *      de merge) → warn + stash preservado.
 *   3a. #3411: `git stash --include-untracked` não é atômico — cria o(s) commit(s)
 *      de stash e SÓ DEPOIS remove os arquivos não-rastreados (clean-equivalente).
 *      Se essa remoção falhar parcialmente (ex: Permission denied), o comando sai
 *      não-zero MESMO com o stash já criado — "working tree não tocada" seria
 *      falso nesse caso. Detectado comparando `refs/stash` antes/depois; se um
 *      stash foi criado apesar do exit não-zero, tenta `git stash pop` automático
 *      ("stash_partial_failure" se recuperar; "stash_partial_failure_unrecovered"
 *      com stash preservado se o pop também falhar — nunca faz `git stash drop`).
 *   4. Se working tree limpa → merge --ff-only origin/master direto.
 *      Se ff-only falhar (divergência) → warn + retorna (nunca força merge).
 *   5. Falha de fetch OU ff_failed OU stash_pop_failed OU stash_partial_failure
 *      (ou sua variante _unrecovered) NÃO bloqueiam a edição — retornam status
 *      de warn e a skill continua.
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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitSpawnFn, SpawnResult } from "./spawn-types.ts";

export type { SpawnResult } from "./spawn-types.ts";

/**
 * Tipo do spawner injetável. Produção usa spawnSync; testes usam mock.
 * Alias local de back-compat — o tipo canônico é `GitSpawnFn` em
 * `scripts/lib/spawn-types.ts` (#2699 — evita colisão com o `SpawnFn` de
 * 3 args de `scripts/check-pr-bugfix.ts`).
 */
export type SpawnFn = GitSpawnFn;

/**
 * Raiz do repo, resolvida a partir da localização deste arquivo (não de
 * `process.cwd()`) — #2699 item 1. Sem isso, `defaultSpawn` roda `git` no
 * CWD do processo; se `/diaria-edicao` for invocado de dentro de um worktree
 * (`.claude/worktrees/agent-*`), o sync miraria o worktree, não o checkout
 * principal. `scripts/lib/git-sync.ts` está 2 níveis abaixo da raiz.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Status da operação de sync. */
export type GitSyncOutcome =
  | "synced"              // pull --ff-only bem-sucedido em tree limpa
  | "synced_stashed"      // stash → pull --ff-only → stash pop OK
  | "already_up_to_date"  // já na versão mais recente (tree limpa ou suja)
  | "fetch_failed"        // git fetch falhou (offline / auth) — warn, segue
  | "ff_failed"           // pull --ff-only falhou (divergência) — warn, segue
  | "stash_failed"        // stash falhou E nenhum stash foi criado — tree não tocada — warn, segue
  | "stash_partial_failure"             // stash saiu não-zero MAS criou um stash (#3411); recuperado via pop automático — warn, segue
  | "stash_partial_failure_unrecovered" // idem, mas o pop automático TAMBÉM falhou — stash preservado p/ investigação manual — warn, segue
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

/**
 * Spawner de produção. `cwd: REPO_ROOT` explícito (#2699 item 1) — nunca
 * confiar em `process.cwd()` como único sinal de onde rodar o `git`.
 */
export function defaultSpawn(cmd: string, args: string[]): SpawnResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS, cwd: REPO_ROOT });
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
  // #2699 item 3: se o próprio `rev-parse` falhar (não-repo / HEAD órfão / git
  // indisponível), branchBefore cai em "unknown" só por ausência de stdout —
  // registrar isso explicitamente agora, senão o diagnóstico downstream (se o
  // checkout também falhar) aponta pra "branch inesperada" em vez da causa raiz.
  const branchRevParseFailed = branchRes.status !== 0;
  const branchBefore = branchRes.stdout.trim() || "unknown";
  if (branchRevParseFailed) {
    warnings.push(
      `[git-sync] WARN: git rev-parse --abbrev-ref HEAD falhou (exit ${branchRes.status}). ` +
        `Causa raiz provável: não é um repositório git, ou git indisponível no ambiente — não uma ` +
        `branch desconhecida. Stderr: ${branchRes.stderr.trim() || "(vazio)"}`,
    );
  }

  // ── 2. Se não estiver em master → checkout master ─────────────────────────
  if (branchBefore !== "master") {
    const w = `[git-sync] Branch atual: '${branchBefore}'. Tentando checkout master antes do sync.`;
    warnings.push(w);
    const checkoutRes = spawn("git", ["checkout", "master"]);
    if (checkoutRes.status !== 0) {
      const rootCauseNote = branchRevParseFailed
        ? ` Causa raiz provável: git indisponível ou não é um repositório git (git rev-parse já ` +
          `havia falhado acima) — não uma branch inesperada.`
        : "";
      const msg =
        `[git-sync] WARN: checkout master falhou (branch='${branchBefore}').${rootCauseNote} ` +
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
    // #3411: captura o estado de `refs/stash` ANTES de rodar o stash. Motivo:
    // `git stash --include-untracked` NÃO é atômico — ele (1) cria o(s) commit(s)
    // de stash (index + working-tree + untracked-files) e SÓ DEPOIS (2) remove os
    // arquivos não-rastreados do working tree (clean-equivalente). Se o passo 2
    // falhar parcialmente (ex: "Permission denied" num diretório com handle aberto
    // por outro processo), o comando INTEIRO sai com exit não-zero mesmo com o
    // stash já criado e parte dos untracked já removida — reportar "working tree
    // não tocada" nesse caso é falso e pode esconder perda real de arquivos
    // (incidente real 260713). Comparar refs/stash antes/depois é a forma robusta
    // de distinguir "nada foi stashado" de "stash foi criado apesar do exit != 0".
    const stashRefBeforeRes = spawn("git", ["rev-parse", "--verify", "refs/stash"]);
    const stashRefBefore = stashRefBeforeRes.status === 0 ? stashRefBeforeRes.stdout.trim() : null;

    const stashRes = spawn("git", ["stash", "--include-untracked"]);
    if (stashRes.status !== 0) {
      const stashRefAfterRes = spawn("git", ["rev-parse", "--verify", "refs/stash"]);
      const stashRefAfter = stashRefAfterRes.status === 0 ? stashRefAfterRes.stdout.trim() : null;
      // Um novo stash foi criado apesar do exit não-zero se refs/stash mudou
      // (cobre tanto o caso "não existia stash antes" [before=null] quanto
      // "já existia um stash diferente antes").
      const stashWasCreatedDespiteFailure = stashRefAfter !== null && stashRefAfter !== stashRefBefore;

      if (stashWasCreatedDespiteFailure) {
        // O stash existe e é válido (o commit foi criado no passo 1 antes da
        // falha no passo 2) — tentar recuperar automaticamente via pop, reusando
        // a mesma lógica de tratamento de conflito do caminho de sucesso.
        const popRes = spawn("git", ["stash", "pop"]);
        if (popRes.status === 0) {
          const msg =
            `[git-sync] WARN: git stash --include-untracked saiu com erro (exit ${stashRes.status}) — ` +
            `provável falha parcial ao remover arquivos não-rastreados (ex: Permission denied em diretório ` +
            `com handle aberto por outro processo) — MAS um stash FOI criado (${stashRefAfter}) apesar do ` +
            `exit não-zero. Sync ignorado (nenhum merge tentado nesta rodada) — stash recuperado ` +
            `automaticamente via 'git stash pop' com sucesso, working tree restaurada. ` +
            `Stderr original do stash: ${stashRes.stderr.trim() || "(vazio)"}`;
          warnings.push(msg);
          return {
            outcome: "stash_partial_failure",
            message: msg,
            branch_before: branchBefore,
            warnings,
            proceed: true,
          };
        }

        // Pop também falhou (conflito ou outro erro) — NÃO descartar o stash;
        // preservado para investigação manual. Outcome DISTINTO de
        // "stash_pop_failed" (que implica pull/merge bem-sucedido) — aqui nenhum
        // merge foi sequer tentado, então reusar aquele outcome enganaria
        // qualquer consumidor que assume "pull OK" a partir dele. Warning
        // explicitamente mais urgente (prefixo ERROR), porque a causa raiz
        // envolve possível remoção não-recuperável de arquivos não-rastreados.
        const msg =
          `[git-sync] ERROR: git stash --include-untracked saiu com erro (exit ${stashRes.status}) E criou ` +
          `um stash (${stashRefAfter}) apesar disso — possível remoção NÃO-RECUPERÁVEL de arquivos não-` +
          `rastreados (#3411). A recuperação automática via 'git stash pop' TAMBÉM falhou (conflito ou ` +
          `outro erro) — stash NÃO foi descartado, preservado para investigação manual: ` +
          `'git stash show -p ${stashRefAfter}' ou 'git stash apply ${stashRefAfter}'. ` +
          `Stderr stash: ${stashRes.stderr.trim() || "(vazio)"} | Stderr pop: ${popRes.stderr.trim() || "(vazio)"}`;
        warnings.push(msg);
        return {
          outcome: "stash_partial_failure_unrecovered",
          message: msg,
          branch_before: branchBefore,
          warnings,
          proceed: true,
        };
      }

      const msg =
        `[git-sync] WARN: git stash falhou — sync ignorado, working tree não tocada ` +
        `(nenhum stash foi criado — refs/stash não mudou). ` +
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
    // #2716 item 5c: outcome "synced_stashed" só é correto quando algo de fato foi
    // stashado E despopado (stashedSomething). Quando `git stash` não tinha nada pra
    // guardar (working tree "dirty" só por `git status` ter falhado — ver comentário
    // acima do dirty check — ou por já estar em sync com o índice), `stashedSomething`
    // é false e o outcome deve refletir "synced" puro (nada foi stashado/restaurado),
    // senão o log confunde diagnóstico futuro (parece que houve stash quando não houve).
    const outcome = upToDate ? "already_up_to_date" : stashedSomething ? "synced_stashed" : "synced";
    return {
      outcome,
      message: upToDate
        ? "[git-sync] Código já estava atualizado (dirty tree restaurada)."
        : stashedSomething
          ? "[git-sync] Código sincronizado com origin/master (dirty tree restaurada via stash)."
          : "[git-sync] Código sincronizado com origin/master (nada foi stashado — stash não tinha mudanças a guardar).",
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
