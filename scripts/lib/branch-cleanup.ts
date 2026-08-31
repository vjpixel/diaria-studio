/**
 * scripts/lib/branch-cleanup.ts (#6802)
 *
 * Responde, de forma DETERMINÍSTICA, a pergunta "esta branch/worktree local
 * é segura pra apagar?" — critério medido contra o achado da issue: o
 * reflexo óbvio (`git branch --merged`/`merge-base --is-ancestor`) ERRA
 * neste repo, porque todo merge é SQUASH — a branch nunca vira ancestral
 * do master, mesmo tendo sido integrada. Medido nas 61 branches
 * `continuo/` limpas em 30/08/2026: ancestralidade classificava 51 como
 * "não mergeadas" quando o estado real da PR no GitHub (via `gh`) dizia
 * `MERGED` pra 55 delas — o critério ingênuo apagaria trabalho (falso
 * negativo de "mergeada") ou, na direção seguraça, nunca apagaria nada de
 * squash-merge (inócuo, mas não resolve o problema).
 *
 * ## Critério (#6802)
 *
 * **`safe-delete`** — qualquer um dos dois, checados nesta ordem:
 *   1. Existe PR (qualquer, `gh pr list --head <branch> --state all`) com
 *      `state: MERGED` — critério PRIMÁRIO, cobre o caso normal (squash).
 *   2. `git merge-base --is-ancestor <branch> master` — sinal SECUNDÁRIO,
 *      cobre merge sem squash ou push direto pra master sem PR.
 *
 * **`needs-review`** (NUNCA apagado automaticamente) — o resto:
 *   - PR existe mas está `CLOSED` sem merge — pode ser trabalho realmente
 *     abandonado, ou pode ter sido superseded por outro PR que resolveu a
 *     mesma issue de forma diferente; só um humano/sessão com contexto
 *     sabe.
 *   - Nenhuma PR encontrada E não é ancestral — WIP nunca submetido, ou
 *     branch órfã de sessão morta no meio da implementação.
 *
 * Fail-closed por construção: a única saída que autoriza apagar é
 * `safe-delete`, e ela exige EVIDÊNCIA POSITIVA (PR merged, ou
 * ancestralidade confirmada) — nunca "não achei nada contra, então deve
 * ser seguro". Erro de rede/`gh` indisponível no CLI (não neste módulo,
 * que é puro) também cai em `needs-review` — ver `scripts/branch-cleanup.ts`.
 *
 * ## Worktrees (#6802 item 3)
 *
 * `classifyWorktreeForCleanup` NUNCA remove um worktree com mudança não
 * commitada (`git status --porcelain` não-vazio) — mesmo que a branch dele
 * seja `safe-delete`, preserva o diff local até um humano decidir (achado
 * da issue: 2 dos 13 worktrees tinham diff não commitado "já superado por
 * PR mergeado", mas isso só foi confirmado por inspeção humana, não
 * automática). Worktree detached (sem branch, `git worktree list
 * --porcelain` reporta `detached`) sempre cai em `needs-review` — sem
 * branch não tem PR pra consultar, sem sinal pra decidir sozinho.
 * Worktree LOCKED (`git worktree lock`) nunca é removido, independente de
 * tudo o resto — é o sinal explícito e nativo do git pra "isto está em
 * uso" (#6802, review da PR #6852). E `git status --porcelain` que FALHA
 * (não "vazio", FALHA — índice travado por sessão concorrente, permissão,
 * disco cheio) nunca é tratado como limpo: `PorcelainStatus` tem 3 valores
 * justamente pra isso, `"unknown"` cai no mesmo `needs-review` de sujo,
 * nunca no mesmo caminho de `"clean"`.
 *
 * `git worktree prune` (nativo do git, não reimplementado aqui) já cobre o
 * caso mais simples e mais comum na auditoria — worktree cujo diretório no
 * disco nem existe mais (`prunable gitdir file points to non-existent
 * location`, achado ao vivo: 7 dos 13 worktrees do levantamento). Rodar
 * isso é sempre seguro por definição do próprio git (só remove metadado
 * órfão, nunca um diretório que ainda existe) — o CLI roda antes de
 * qualquer classificação.
 */

export type CleanupVerdict = "safe-delete" | "needs-review";

/** Vocabulário real de `gh pr list --json state` (#6802, review da PR
 * #6852 — P3: `string[]` cru deixava um typo/valor futuro do GitHub passar
 * sem sinal de compilador; como a direção de erro já é fail-closed
 * (qualquer valor não reconhecido cai em `needs-review`), o custo do typo
 * era baixo, mas o tipo documenta o contrato real). */
export type PrState = "OPEN" | "CLOSED" | "MERGED";

export interface BranchCleanupInput {
  readonly branch: string;
  /** Estados de TODAS as PRs encontradas com este branch como head (pode
   * ser mais de uma — reabertura, ou 2 PRs históricas pro mesmo branch
   * name reusado). `[]` = nenhuma PR encontrada. */
  readonly prStates: readonly PrState[];
  /** `git merge-base --is-ancestor <branch> master` — `true` sse a branch
   * é ancestral (já está, integralmente, na história de master). */
  readonly isAncestorOfMaster: boolean;
}

export interface CleanupDecision {
  readonly verdict: CleanupVerdict;
  readonly reason: string;
}

/** Pura — decide se uma branch local é `safe-delete` ou `needs-review`. */
export function classifyBranchForCleanup(input: BranchCleanupInput): CleanupDecision {
  if (input.prStates.includes("MERGED")) {
    return { verdict: "safe-delete", reason: "PR MERGED encontrada (gh pr list --state all)" };
  }
  if (input.isAncestorOfMaster) {
    return {
      verdict: "safe-delete",
      reason: "branch é ancestral de master (integrada sem squash, ou push direto — sinal secundário)",
    };
  }
  if (input.prStates.includes("CLOSED")) {
    return {
      verdict: "needs-review",
      reason: "PR CLOSED sem merge — pode ser abandonada ou superseded por outra PR; checar antes de apagar",
    };
  }
  return {
    verdict: "needs-review",
    reason: "nenhuma PR encontrada e não é ancestral de master — pode ser WIP nunca submetido",
  };
}

export interface WorktreeListEntry {
  readonly path: string;
  /** `null` = detached, ou entry `bare`. */
  readonly branch: string | null;
  readonly prunable: boolean;
  /** #6802, review da PR #6852 (P1, confiança alta) — `git worktree lock`
   * é o mecanismo NATIVO do git pra "não mexa, isto está em uso"; um
   * `git worktree remove --force` ignora essa trava. Sem este campo,
   * `classifyWorktreeForCleanup` não tinha como saber que um worktree
   * estava explicitamente marcado como intocável. */
  readonly locked: boolean;
}

/** Pura — parseia `git worktree list --porcelain` (blocos separados por
 * linha em branco, cada bloco começa com `worktree <path>`). Formato
 * estável do próprio git, não versionado por nós — ver `git help
 * worktree`. Nunca lança em entrada malformada/vazia (retorna `[]`). */
export function parseWorktreeListPorcelain(output: string): WorktreeListEntry[] {
  const blocks = output.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const entries: WorktreeListEntry[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    if (!pathLine) continue;
    const path = pathLine.slice("worktree ".length).trim();
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const branch = branchLine ? branchLine.slice("branch ".length).replace(/^refs\/heads\//, "").trim() : null;
    const prunable = lines.some((l) => l.startsWith("prunable"));
    const locked = lines.some((l) => l.startsWith("locked"));
    entries.push({ path, branch, prunable, locked });
  }
  return entries;
}

/** #6802, review da PR #6852 (P0, confiança alta, confirmado por 3
 * revisores independentes): `boolean` sozinho não distingue "verificado
 * limpo" de "não deu pra verificar" — um `git status --porcelain` que
 * falha (lock de índice por sessão concorrente, permissão, disco cheio)
 * e vira `null` no CLI não pode colapsar pro MESMO valor que "de fato
 * limpo", porque isso faria `--force` remover um worktree cujo estado
 * real é desconhecido, não confirmadamente limpo. `"unknown"` é tratado
 * como sujo — fail-closed, nunca como "limpo por omissão". */
export type PorcelainStatus = "clean" | "dirty" | "unknown";

export interface WorktreeCleanupInput {
  readonly path: string;
  /** `null` = worktree detached (sem branch checked out). */
  readonly branch: string | null;
  readonly porcelainStatus: PorcelainStatus;
  /** `git worktree lock` ativo — nunca remover, independente de tudo o
   * resto (ver docstring de `WorktreeListEntry.locked`). */
  readonly locked: boolean;
  /** Decisão já computada pra `branch` (via `classifyBranchForCleanup`),
   * ou `null` se `branch` é `null`. */
  readonly branchDecision: CleanupDecision | null;
}

export interface WorktreeCleanupDecision {
  readonly verdict: "safe-remove" | "needs-review";
  readonly reason: string;
}

/** Pura — decide se um worktree EXISTENTE (já passou por `git worktree
 * prune`, que cobre o caso "diretório nem existe mais") é seguro remover. */
export function classifyWorktreeForCleanup(input: WorktreeCleanupInput): WorktreeCleanupDecision {
  if (input.locked) {
    return { verdict: "needs-review", reason: "worktree está locked (git worktree lock) — sinal explícito de 'em uso', nunca remove" };
  }
  if (input.porcelainStatus !== "clean") {
    const detail =
      input.porcelainStatus === "unknown"
        ? "não deu pra confirmar o status (git status falhou) — tratado como sujo, fail-closed"
        : "worktree tem mudança não commitada";
    return { verdict: "needs-review", reason: `${detail} — nunca remove estado não-confirmadamente-limpo` };
  }
  if (input.branch === null) {
    return { verdict: "needs-review", reason: "worktree detached (sem branch) — sem sinal pra decidir sozinho" };
  }
  if (input.branchDecision?.verdict === "safe-delete") {
    return { verdict: "safe-remove", reason: `branch '${input.branch}': ${input.branchDecision.reason}` };
  }
  return {
    verdict: "needs-review",
    reason: `branch '${input.branch}' não é safe-delete ainda (${input.branchDecision?.reason ?? "sem decisão computada"})`,
  };
}
