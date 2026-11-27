/**
 * test/triage-preserved-worktrees-eol-14336.test.ts (#14336)
 *
 * Worktree cuja única sujeira é de fim de linha (arquivo commitado em LF,
 * reescrito em CRLF, `core.autocrlf=true`): o `git status` dá `M` e o
 * `git diff HEAD` sai vazio. Até o #14336 o `--discard` recusava ("há arquivo
 * rastreado sujo e o git diff saiu vazio") e o worktree voltava em toda
 * triagem. Agora o resgate guarda a cópia crua em `tracked-raw/` e remove.
 * Repositório git TEMPORÁRIO com remoto bare, nunca os worktrees desta máquina.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTrackedDirtyPaths, runTriage, type TriageDeps } from "../scripts/triage-preserved-worktrees.ts";
import { removeWorktreeSafe } from "../scripts/cleanup-merged-worktrees.ts";

const DAY = 24 * 60 * 60 * 1000;
const CRLF = "linha 1\r\nlinha 2\r\n";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=.no-hooks", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
  return r.stdout;
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "triage-14336-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  git(root, "init", "--bare", "-b", "master", remote);
  git(root, "init", "-b", "master", repo);
  writeFileSync(join(repo, "a.txt"), "linha 1\nlinha 2\n");
  writeFileSync(join(repo, "b.txt"), "intacto\n");
  git(repo, "add", "a.txt", "b.txt");
  git(repo, "commit", "--no-verify", "-m", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "master");
  const wt = join(root, "wts", "wt-eol").replace(/\\/g, "/");
  // Checkout em LF e só depois `core.autocrlf=true` (com ele ligado antes, o
  // checkout no Linux já escreveria CRLF e o índice registraria esse tamanho).
  git(repo, "worktree", "add", "--detach", wt, "master");
  git(repo, "config", "core.autocrlf", "true");
  // mtime antigo + índice atualizado: o tamanho gravado no índice (LF) difere
  // do CRLF no disco e o status dá `M`, sem a janela de "racy git" do relógio.
  const old = new Date("2001-01-01T00:00:00Z");
  utimesSync(join(wt, "a.txt"), old, old);
  git(wt, "update-index", "--refresh");
  writeFileSync(join(wt, "a.txt"), CRLF);
  utimesSync(join(wt, "a.txt"), old, old);
  return { root, repo, wt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function deps(repo: string, logs: string[]): TriageDeps {
  return {
    prsForBranch: (branch) => {
      throw new Error(`prsForBranch não deveria ser chamado (branch ${branch})`);
    },
    listActiveSessions: () => ({ sessions: [], readable: true }),
    isPidAlive: () => false,
    removeWorktree: (path) => removeWorktreeSafe(path, repo, []),
    nowMs: Date.now() + 30 * DAY,
    log: (line) => logs.push(line),
  };
}

test("#14336 fixture reproduz a sujeira só de EOL: status M, git diff vazio", () => {
  const fx = makeFixture();
  try {
    assert.match(git(fx.wt, "status", "--porcelain"), /^ M a\.txt$/m);
    assert.equal(git(fx.wt, "diff", "--binary", "HEAD"), "");
    assert.deepEqual(listTrackedDirtyPaths(fx.wt), ["a.txt"]);
  } finally {
    fx.cleanup();
  }
});

test("#14336 --discard remove worktree com sujeira só de CRLF e guarda a cópia crua", () => {
  const fx = makeFixture();
  try {
    const logs: string[] = [];
    const rescue = join(fx.root, "rescue");
    const d = deps(fx.repo, logs);
    assert.equal(runTriage({ discard: "true", "rescue-dir": rescue }, fx.repo, d), 0, logs.join("\n"));
    assert.doesNotMatch(logs.join("\n"), /resgate falhou/);
    assert.equal(existsSync(fx.wt), false, logs.join("\n"));
    const dir = join(rescue, new Date(d.nowMs).toISOString().slice(0, 10), "wt-eol");
    assert.equal(readFileSync(join(dir, "tracked.diff"), "utf8"), "");
    assert.equal(readFileSync(join(dir, "tracked-raw", "a.txt"), "utf8"), CRLF);
    assert.equal(existsSync(join(dir, "tracked-raw", "b.txt")), false);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    assert.deepEqual(meta.tracked_raw, ["a.txt"]);
  } finally {
    fx.cleanup();
  }
});

test("#14336 listTrackedDirtyPaths ignora untracked e pega o destino do rename", () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.wt, "novo.txt"), "untracked\n");
    git(fx.wt, "mv", "b.txt", "c.txt");
    assert.deepEqual(listTrackedDirtyPaths(fx.wt)!.sort(), ["a.txt", "c.txt"]);
  } finally {
    fx.cleanup();
  }
});
