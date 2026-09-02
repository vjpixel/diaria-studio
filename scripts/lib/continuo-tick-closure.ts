/**
 * continuo-tick-closure.ts (#7130)
 *
 * O contínuo mediu (#6908, rodada 02/09) que 2 de 3 ticks longos produziram
 * trabalho real e não fecharam o laço: sem claim, sem commit, sem PR — a
 * árvore de trabalho ficou suja no checkout COMPARTILHADO (#6952: 498 linhas
 * nunca commitadas). O guard existente (#6922, `session-registry.ts end`)
 * só protege quando o tick chega a chamar `end` — o modo de falha medido é
 * justamente o tick não chegar lá (processo morto, budget estourado, crash).
 *
 * Este módulo implementa a "direção 3" da issue (#7130) de forma mecânica,
 * não em prosa: em vez de confiar que o PRÓXIMO tick vai lembrar de checar
 * `git status` antes de mexer em qualquer coisa, `rescueOrphanedWork`
 * detecta árvore suja no checkout compartilhado e a MOVE pra uma branch
 * dedicada (commit local, nunca descartado) — preservando o trabalho e
 * limpando a árvore antes que outra sessão rode `git add -A`/`git commit`
 * e publique o trabalho alheio na PR errada (o efeito colateral citado
 * na issue de origem).
 *
 * Chamado a partir do Passo 0 de `.claude/skills/diaria-continuo/SKILL.md`
 * e do passo 1 (§1) de `hermes/skills/hermes-diaria-continuo/SKILL.md`,
 * SEMPRE antes de `scripts/sync-code.ts` (que também mexe em stash — rodar
 * a recuperação primeiro evita que um `git stash` do sync misture o
 * trabalho órfão com o dele; ver `scripts/rescue-continuo-orphaned-work.ts`
 * pro CLI wrapper).
 *
 * Só cuida do checkout COMPARTILHADO — nunca roda dentro de um worktree de
 * subagente (`.claude/worktrees/agent-*`), que tem ciclo de vida próprio e
 * não é lido pela `sync-code.ts`/pelo loop do contínuo.
 *
 * Design DI (mesmo padrão de `scripts/lib/git-sync.ts`, #2699): todo comando
 * `git` passa por um `spawn` injetável — testável sem tocar git real.
 */

import type { GitSpawnFn as SpawnFn, SpawnResult } from "./spawn-types.ts";
import { defaultSpawn as gitDefaultSpawn } from "./git-sync.ts";

export type { SpawnFn, SpawnResult };

/** Reusa o spawner de produção de `git-sync.ts` (mesmo `cwd: REPO_ROOT`,
 * #2699 item 1 — nunca `process.cwd()`). */
export const defaultSpawn: SpawnFn = gitDefaultSpawn;

/** `true` quando `git status --porcelain` reporta QUALQUER path (staged,
 * unstaged ou untracked) — puro, sem I/O. */
export function hasUncommittedWork(porcelain: string): boolean {
  return porcelain.trim().length > 0;
}

export interface RescueBranchPlan {
  branchName: string;
  commitMessage: string;
}

/** Nome de branch determinístico a partir de um timestamp ISO — dedicado
 * (`continuo/rescue-*`), nunca reusa `continuo/fix-*`/`continuo/batch-*`
 * (item 2 de `context/overnight-dispatch-rules.md`) porque esta branch não
 * corresponde a nenhuma issue conhecida — é o próprio propósito dela: um
 * achado, não uma unidade de trabalho planejada. */
export function planRescueBranch(nowIso: string): RescueBranchPlan {
  const stamp = nowIso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const branchName = `continuo/rescue-${stamp}`;
  const commitMessage =
    `chore(#7130): recupera trabalho órfão de tick do contínuo interrompido\n\n` +
    `Commit automático de \`rescue-continuo-orphaned-work.ts\` — a árvore de ` +
    `trabalho do checkout compartilhado estava suja sem PR aberto nem status ` +
    `terminal registrado para o tick que a produziu (ver #7130). Preservado ` +
    `numa branch dedicada para triagem manual; NÃO mergear sem revisão humana ` +
    `— a origem exata (qual issue, qual tick) é desconhecida por construção.`;
  return { branchName, commitMessage };
}

export type RescueOutcome =
  | { outcome: "clean"; message: string }
  | { outcome: "rescued"; branch: string; message: string; checkoutBackFailed: boolean }
  | { outcome: "rescue_failed"; message: string };

/**
 * Verifica o checkout compartilhado e, se sujo, recupera o trabalho numa
 * branch dedicada. Idempotente/seguro em árvore limpa (`outcome: "clean"`,
 * nenhum comando além do `git status` é executado). Nunca lança — qualquer
 * falha de comando git vira `"rescue_failed"` com a mensagem do stderr, sem
 * tentar mais nada depois (fail loud, não fail silencioso: quem chama este
 * módulo trata `rescue_failed` como bloqueio, não como warning ignorável —
 * ver docstring de `scripts/rescue-continuo-orphaned-work.ts`).
 */
export function rescueOrphanedWork(spawn: SpawnFn, nowIso: string = new Date().toISOString()): RescueOutcome {
  const statusRes = spawn("git", ["status", "--porcelain"]);
  if (statusRes.status !== 0) {
    return { outcome: "rescue_failed", message: `git status --porcelain falhou: ${statusRes.stderr.trim()}` };
  }
  if (!hasUncommittedWork(statusRes.stdout)) {
    return { outcome: "clean", message: "checkout compartilhado limpo — nada a recuperar." };
  }

  const plan = planRescueBranch(nowIso);

  const branchRes = spawn("git", ["checkout", "-b", plan.branchName]);
  if (branchRes.status !== 0) {
    return {
      outcome: "rescue_failed",
      message:
        `git checkout -b ${plan.branchName} falhou (${branchRes.stderr.trim()}) — trabalho AINDA sujo no ` +
        `checkout compartilhado, sem recuperação. Investigar manualmente antes de qualquer git add/commit.`,
    };
  }

  const addRes = spawn("git", ["add", "-A"]);
  if (addRes.status !== 0) {
    return {
      outcome: "rescue_failed",
      message:
        `git add -A falhou (${addRes.stderr.trim()}) na branch ${plan.branchName} — trabalho parcialmente ` +
        `movido, investigar manualmente ('git status', 'git checkout master' só depois de resolver).`,
    };
  }

  const commitRes = spawn("git", ["commit", "-m", plan.commitMessage]);
  if (commitRes.status !== 0) {
    return {
      outcome: "rescue_failed",
      message:
        `git commit falhou (${commitRes.stderr.trim()}) na branch ${plan.branchName} — trabalho staged mas ` +
        `NÃO commitado, investigar manualmente antes de trocar de branch.`,
    };
  }

  const backRes = spawn("git", ["checkout", "master"]);
  const checkoutBackFailed = backRes.status !== 0;

  return {
    outcome: "rescued",
    branch: plan.branchName,
    checkoutBackFailed,
    message: checkoutBackFailed
      ? `Trabalho órfão recuperado e commitado em ${plan.branchName}, MAS 'git checkout master' pós-rescue ` +
        `falhou (${backRes.stderr.trim()}) — o checkout compartilhado ainda está na branch de rescue; trocar ` +
        `manualmente antes de qualquer outra sessão continuar. Push + 'gh pr create' seguem necessários.`
      : `Trabalho órfão recuperado e commitado em ${plan.branchName}. Checkout compartilhado limpo (voltou pra ` +
        `master). Push + 'gh pr create' seguem necessários (ou rode o CLI com --push) para o trabalho virar PR ` +
        `triável em vez de só uma branch local.`,
  };
}

export interface PushOutcome {
  ok: boolean;
  message: string;
}

/** Best-effort: publica a branch de rescue (`git push -u origin {branch}`).
 * Falha aqui NUNCA descarta o commit local já feito por `rescueOrphanedWork`
 * — o trabalho continua seguro na branch, só não está no remoto ainda. */
export function pushRescueBranch(spawn: SpawnFn, branch: string): PushOutcome {
  const pushRes = spawn("git", ["push", "-u", "origin", branch]);
  if (pushRes.status !== 0) {
    return { ok: false, message: `git push falhou (${pushRes.stderr.trim()}) — branch ${branch} só existe local.` };
  }
  return { ok: true, message: `branch ${branch} publicada em origin.` };
}
