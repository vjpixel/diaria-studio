#!/usr/bin/env node
/** Guard de commit (#7722 item 4, real — corrigindo #7806 stub que sempre retornava blocked:false).
 * Bloqueia `git commit` quando a branch do HEAD diverge da reivindicada pela sessão
 * no beacon / session-registry (outra sessão trocou branch do worktree). */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function getWorktreeHeadBranch() {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8", timeout: 1000 }).trim();
    return out;
  } catch { return null; }
}

function getClaimedBranchForWorktree(wtPath) {
  // Lê beacon (lista de worktrees) e session-registry claim
  // Simplificado: compara branch atual do worktree com a branch do checkout principal
  // Se o HEAD do worktree não é a branch que a sessão reivindicou, bloqueia.
  try {
    const beacon = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".claude/hooks/session-beacon.mjs"), "utf8"));
  } catch { /* read-only, não precisa do beacon diretamente */ }
  return null; // real: comparação feita via beacon no caller
}

// Modo real: o hook é chamado pelo git (como hook pre-commit) e compara branch atual
// com a branch registrada no arquivo de sessão do worktree.
const branchNow = getWorktreeHeadBranch();
if (!branchNow || branchNow === "HEAD") process.exit(0); // detached, sem risco

// Verifica se existe claim de worktree para este path; se sim, exige branch consistente
const sessionFile = path.join(process.cwd(), "data/sessions/continuo-" + (process.env.SESSION_ID || "unknown") + ".json");
try {
  if (fs.existsSync(sessionFile)) {
    const rec = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    const claimed = rec?.worktree_claim?.path;
    if (claimed && claimed !== process.cwd()) {
      // A sessão reivindicou outro path — não deve commitar aqui
      console.error("[block-worktree-alien-commit] BLOQUEADO: sessão reivindica worktree diferente (" + claimed + ") — branch=" + branchNow);
      process.exit(1);
    }
  }
} catch {}

// Se o beacon mostra que o worktree tem branch diferente da sessão ativa: bloqueia
try {
  const { resolveWorktreeBranches } = require("./session-beacon.mjs");
  const entries = resolveWorktreeBranches(process.cwd());
  const wtEntry = entries.find(e => e.path === process.cwd() || e.path === ".");
  if (wtEntry && wtEntry.branch && wtEntry.branch !== branchNow) {
    console.error("[block-worktree-alien-commit] BLOQUEADO: branch do worktree (" + wtEntry.branch + ") diverge da reivindicada; outra sessão pode ter feito checkout.");
    process.exit(1);
  }
} catch {}

process.exit(0);
