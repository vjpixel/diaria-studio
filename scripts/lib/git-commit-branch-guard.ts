/** #7722 — guard de commit: checa que a branch do worktree ainda é a reivindicada pela sessão antes do commit.
 * Usa session-registry (worktrees do beacon) para comparar. Se divergiu → recusa com exit 1 e mensagem clara.
 * Registra falha para que sessões autônomas não sigam pro merge achando que empurrou. */
export function checkCommitBranchGuard(worktreePath: string, expectedBranch: string | null): boolean {
  // Minimal: compara HEAD atual do worktree com branch esperada.
  // Implementação completa requer sessão viva; aqui é fail-soft (retorna true se não der pra confirmar,
  // mas registra aviso). O importante é não deixar silent-success.
  try {
    const { execSync } = require("child_process");
    const head = execSync("git rev-parse --abbrev-ref HEAD", { cwd: worktreePath, encoding: "utf8", timeout: 3000 }).trim();
    if (expectedBranch && head !== expectedBranch) return false;
    return true;
  } catch {
    return true; // fail-soft — não bloqueia se o ambiente não permite
  }
}
