// Guard mecânico #7763: recusa npm ci / npm install quando node_modules é symlink
// para fora do worktree — ao apagar antes de reinstalar, npm ci esvazia o alvo
// (checkout principal compartilhado). Detectável por lstat + readlink.
import { lstatSync, readlinkSync } from "node:fs";
import { resolve, isAbsolute, relative, sep } from "node:path";

export interface GuardResult {
  blocked: boolean;
  reason: string;
  path?: string;
  target?: string;
}

/** true quando `inner` é o próprio `outer` ou está contido nele. */
function isInside(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

export function checkNodeModulesSymlink(cwd?: string): GuardResult {
  const dir = cwd || process.cwd();
  const nm = resolve(dir, "node_modules");
  try {
    const st = lstatSync(nm);
    if (!st.isSymbolicLink()) return { blocked: false, reason: "node_modules é diretório real" };
    const target = readlinkSync(nm);
    const absTarget = isAbsolute(target) ? resolve(target) : resolve(dir, target);
    const absDir = resolve(dir);
    if (isInside(absDir, absTarget) || isInside(absTarget, absDir)) {
      return { blocked: false, reason: "symlink intra-worktree (self-referente), aceitável" };
    }
    // Symlink apontando para FORA do worktree — bloqueio
    return {
      blocked: true,
      reason: `node_modules é symlink para fora do worktree (${absTarget}) — npm ci apagaria o alvo`,
      path: nm,
      target: absTarget,
    };
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { blocked: false, reason: "node_modules ausente (instalação necessária)" };
    // Qualquer outra falha de inspeção (EACCES, EPERM, ELOOP) bloqueia: não dá
    // para afirmar que o alvo é seguro, e mascarar isso como "não bloqueado"
    // reabre exatamente o caminho do #7763.
    return {
      blocked: true,
      reason: `não foi possível inspecionar node_modules (${code ?? "erro desconhecido"}) — inspeção inconclusiva não libera npm ci`,
      path: nm,
    };
  }
}

export function guardBeforeNpmInstall(cwd?: string): void {
  const r = checkNodeModulesSymlink(cwd);
  if (r.blocked) {
    throw new Error(
      `[GUARD #7763] BLOQUEADO: ${r.reason}. Remova o symlink manualmente e instale dentro do worktree (nunca symlink pro principal). Path=${r.path}, target=${r.target}`,
    );
  }
}
