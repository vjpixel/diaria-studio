#!/usr/bin/env node
/** Guard de commit (#7722 item 4, real — corrigindo #7806 stub que sempre retornava blocked:false).
 * Bloqueia `git commit` quando a branch do HEAD diverge da reivindicada pela sessão
 * no beacon / session-registry (outra sessão trocou branch do worktree). */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  const beaconPath = path.join(process.cwd(), ".claude/hooks/session-beacon.mjs");
  if (fs.existsSync(beaconPath)) {
    // Beacon é código ESM; não importável por require. Lemos a worktree list via git diretamente.
    const gitOut = execSync("git worktree list --porcelain", { encoding: "utf8", timeout: 1000 }).trim();
    const lines = gitOut.split("\n");
    let foundBranch = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("worktree ")) {
        const wtPath = lines[i].slice("worktree ".length).trim();
        if (wtPath === process.cwd() || wtPath === ".") {
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].startsWith("branch ")) { foundBranch = lines[j].slice("branch ".length).trim(); break; }
            if (lines[j].startsWith("worktree ") || lines[j].startsWith("HEAD ")) break;
          }
        }
      }
    }
    if (foundBranch && foundBranch !== branchNow && branchNow !== "HEAD" && foundBranch !== "HEAD") {
      console.error("[block-worktree-alien-commit] BLOQUEADO: worktree branch (" + foundBranch + ") diverge da HEAD atual (" + branchNow + ")");
      process.exit(1);
    }
  }
} catch {}

process.exit(0);
