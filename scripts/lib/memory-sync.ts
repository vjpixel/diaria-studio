/**
 * memory-sync.ts (#7533 item 5)
 *
 * Lógica pura de "auto-commit + pull --rebase" para o repo git dedicado de
 * `memory/` (decisão do editor, comentário #7533: reverte a política
 * anterior de "nunca commitar memory/" — `docs/claude-config-sync.md:196`).
 *
 * Este repo git é FORA deste checkout (`~/.claude/projects/{slug}/memory/`,
 * caminho que varia por máquina/usuário — não é derivável de constante, ver
 * issue) e o editor precisa criá-lo manualmente 1x por máquina antes deste
 * script funcionar. `scripts/memory-sync.ts` (CLI, no mesmo PR) documenta
 * os passos manuais. Este módulo isola a DECISÃO/sequência de comandos git
 * como função pura testável via spawner injetável — mesmo padrão de
 * `scripts/lib/git-sync.ts`.
 *
 * Deliberadamente fail-soft em cada etapa (nunca lança) — é um script que o
 * editor roda manualmente ou via hook opcional; travar a sessão por um
 * conflito de rebase no repo de memória seria pior que reportar e parar.
 */

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Spawner = (cmd: string, args: string[], cwd: string) => GitCommandResult;

export type MemorySyncStep =
  | "not-a-git-repo"
  | "no-changes"
  | "committed"
  | "commit-failed"
  | "no-remote"
  | "pull-rebase-failed"
  | "pushed"
  | "push-failed";

export interface MemorySyncOutcome {
  step: MemorySyncStep;
  detail?: string;
}

export const MANUAL_SETUP_INSTRUCTIONS = [
  "1. Criar um repositório PRIVADO no GitHub (ex: vjpixel/diaria-memory) — 1x, numa máquina.",
  "2. Nessa máquina: cd <diretório de memória> && git init && git remote add origin <url-do-repo> && git add -A && git commit -m 'memory: seed inicial' && git push -u origin HEAD",
  "3. Nas demais máquinas: cd <diretório de memória> && git init && git remote add origin <url-do-repo> && git fetch && git reset --hard origin/<branch>",
  "4. A partir daí, rodar este script (manualmente ou via hook) em cada máquina faz o auto-commit + pull --rebase.",
] as const;

/**
 * Executa a sequência add → commit (se houver mudança) → pull --rebase →
 * push, parando cedo em qualquer etapa que não permita seguir com segurança
 * (não é repo git, sem remote configurado, rebase falhou). Cada chamada
 * retorna a lista de outcomes já observados, na ordem — o último elemento é
 * sempre o resultado final da tentativa.
 */
export function runMemorySync(
  memoryDir: string,
  spawner: Spawner,
  now: () => Date = () => new Date(),
): MemorySyncOutcome[] {
  const outcomes: MemorySyncOutcome[] = [];

  const isRepo = spawner("git", ["rev-parse", "--is-inside-work-tree"], memoryDir);
  if (isRepo.status !== 0) {
    outcomes.push({ step: "not-a-git-repo", detail: isRepo.stderr || isRepo.stdout });
    return outcomes;
  }

  spawner("git", ["add", "-A"], memoryDir);
  const statusResult = spawner("git", ["status", "--porcelain"], memoryDir);
  if (statusResult.stdout.trim()) {
    const message = `memory: auto-sync ${now().toISOString()}`;
    const commitResult = spawner("git", ["commit", "-m", message], memoryDir);
    if (commitResult.status !== 0) {
      outcomes.push({ step: "commit-failed", detail: commitResult.stderr || commitResult.stdout });
      return outcomes;
    }
    outcomes.push({ step: "committed", detail: message });
  } else {
    outcomes.push({ step: "no-changes" });
  }

  const remoteResult = spawner("git", ["remote"], memoryDir);
  if (!remoteResult.stdout.trim()) {
    outcomes.push({ step: "no-remote" });
    return outcomes;
  }

  const pullResult = spawner("git", ["pull", "--rebase"], memoryDir);
  if (pullResult.status !== 0) {
    outcomes.push({ step: "pull-rebase-failed", detail: pullResult.stderr || pullResult.stdout });
    return outcomes;
  }

  const pushResult = spawner("git", ["push"], memoryDir);
  outcomes.push({
    step: pushResult.status === 0 ? "pushed" : "push-failed",
    detail: pushResult.status === 0 ? undefined : pushResult.stderr || pushResult.stdout,
  });
  return outcomes;
}
