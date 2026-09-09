// Guard mecânico #7763: recusa npm ci / npm install quando node_modules é symlink
// para fora do worktree — ao apagar antes de reinstalar, npm ci esvazia o alvo
// (checkout principal compartilhado). Detectável por lstat + readlink.
import { lstatSync, readlinkSync, existsSync } from "fs";
import { resolve, isAbsolute } from "path";

export interface GuardResult { blocked: boolean; reason: string; path?: string; target?: string };

export function checkNodeModulesSymlink(cwd?: string): GuardResult {
  const dir = cwd || process.cwd();
  const nm = resolve(dir, "node_modules");
  try {
    const st = lstatSync(nm);
    if (!st.isSymbolicLink()) return { blocked: false, reason: "node_modules é diretório real" };
    const target = readlinkSync(nm);
    const absTarget = isAbsolute(target) ? target : resolve(dir, target);
    const absDir = resolve(dir);
    if (absTarget === absDir || absTarget.startsWith(absDir + "/") || absDir.startsWith(absTarget + "/")) {
      return { blocked: false, reason: "symlink intra-worktree (self-referente), aceitável" };
    }
    // Symlink apontando para FORA do worktree — bloqueio
    return { blocked: true, reason: `node_modules é symlink para fora do worktree (${absTarget}) — npm ci/apagaria o alvo`, path: nm, target: absTarget };
  } catch (e: any) {
    if (e.code === "ENOENT") return { blocked: false, reason: "node_modules ausente (instalação necessária)" };
    return { blocked: false, reason: "não foi possível inspecionar node_modules" };
  }
}

export function guardBeforeNpmInstall(cwd?: string): void {
  const r = checkNodeModulesSymlink(cwd);
  if (r.blocked) {
    throw new Error(`[GUARD #7763] BLOQUEADO: ${r.reason}. Remova o symlink manualmente e instale dentro do worktree (nunca symlink pro principal). Path=${r.path}, target=${r.target}`);
  }
}
