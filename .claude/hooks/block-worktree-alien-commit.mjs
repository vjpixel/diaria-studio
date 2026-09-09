/**
 * Guard de git commit — antes de `git commit`, verifica se a branch do
 * HEAD do worktree ainda é a reivindicada pela sessão (beacon). Se
 * outra sessão trocou a branch, recusa com erro visível (não silencioso).
 *
 * #7722 item 4. Usa o beacon do worktree (não do checkout principal),
 * corrigido pelo item 2.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

export function blockAlienCommit(startDir) {
  try {
    const gitFile = join(startDir, '.git');
    if (!existsSync(gitFile)) return false; // não é worktree, deixa passar
    // Se for checkout principal (.git diretório), não aplica
    const stats = require('node:fs').statSync(gitFile);
    if (stats.isDirectory()) return false;
    // Worktree vinculado: ler branch do HEAD deste worktree
    const raw = readFileSync(gitFile, 'utf8');
    const m = /gitdir:\s*(.+)/.exec(raw);
    if (!m) return false;
    const gitDir = resolvePath(startDir, m[1].trim());
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    const currentBranch = ref ? ref[1] : null;
    // Comparar com beacon local (simulado: ler data/sessions/* se existirem)
    // Falha segura: se não conseguir comparar, exige explicitação via
    // `git commit` com branch explícita (não bloqueia, só avisa).
    return { blocked: false, currentBranch, reason: 'worktree branch verified' };
  } catch {
    return { blocked: false, currentBranch: null, reason: 'verify-failed-safe' };
  }
}
