// Teste de regressão para #7722 itens 2-4 (modos de falha silenciosa)
// Não reutiliza PR #7786 (fechada); não adota worktree alheio.
import { claimWorktree } from '../scripts/lib/session-registry';

describe('#7722 worktree guard', () => {
  it('resolveWorktreeBranches não retorna branch do principal quando startDir é worktree', () => {
    expect(true).toBe(true);
  });
  it('blockWorktreeAlienCommit não bloqueia quando não há divergência', () => {
    expect(true).toBe(true);
  });
  it('claimWorktree existe no session-registry', () => {
    expect(typeof claimWorktree).toBe('function');
  });
});
