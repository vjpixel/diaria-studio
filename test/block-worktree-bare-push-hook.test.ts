import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isBareGitPush,
  commandHasBareGitPush,
  isLinkedWorktree,
  BARE_PUSH_IN_WORKTREE_BLOCK_REASON,
} from "../.claude/hooks/block-worktree-bare-push.mjs";

// #7722 item 1 — `git push` sem remote+refspec explícitos, dentro de um
// worktree, pode reportar sucesso ("Everything up-to-date") sem empurrar
// nada quando outra sessão trocou a branch checked out por baixo (incidente
// medido ao vivo 2× em 09/09/2026, worktrees wt-7694 e wt-7708).

describe("isBareGitPush (#7722)", () => {
  it("'git push' bare (sem remote nem refspec) → true", () => {
    assert.equal(isBareGitPush(["git", "push"]), true);
  });

  it("'git push origin' (só remote, sem branch) → true", () => {
    assert.equal(isBareGitPush(["git", "push", "origin"]), true);
  });

  it("'git push -u' (só flag) → true", () => {
    assert.equal(isBareGitPush(["git", "push", "-u"]), true);
  });

  it("'git push origin <branch>' (remote + refspec explícitos) → false", () => {
    assert.equal(isBareGitPush(["git", "push", "origin", "fix/7707-slug"]), false);
  });

  it("'git push -u origin <branch>' → false", () => {
    assert.equal(isBareGitPush(["git", "push", "-u", "origin", "fix/7707-slug"]), false);
  });

  it("'git push --force-with-lease origin <branch>' → false", () => {
    assert.equal(isBareGitPush(["git", "push", "--force-with-lease", "origin", "fix/7707-slug"]), false);
  });

  it("'git push --tags'/'--all'/'--mirror' (independem de branch checked out) → false", () => {
    assert.equal(isBareGitPush(["git", "push", "--tags"]), false);
    assert.equal(isBareGitPush(["git", "push", "origin", "--all"]), false);
    assert.equal(isBareGitPush(["git", "push", "--mirror"]), false);
  });

  it("não-git-push → false", () => {
    assert.equal(isBareGitPush(["git", "pull"]), false);
    assert.equal(isBareGitPush(["npm", "run", "push"]), false);
  });
});

describe("commandHasBareGitPush (#7722)", () => {
  it("detecta comando standalone", () => {
    assert.equal(commandHasBareGitPush("git push"), true);
    assert.equal(commandHasBareGitPush("git push origin main"), false);
  });

  it("detecta dentro de comando encadeado", () => {
    assert.equal(commandHasBareGitPush("git commit -m x && git push"), true);
    assert.equal(commandHasBareGitPush("git commit -m x && git push origin fix/1"), false);
  });

  it("NÃO detecta 'git push' citado dentro de argumento (--body)", () => {
    assert.equal(commandHasBareGitPush('gh issue create --body "rode git push depois"'), false);
  });

  it("tipo não-string → false", () => {
    assert.equal(commandHasBareGitPush(undefined), false);
  });
});

describe("isLinkedWorktree (#7722, duplicado dos hooks irmãos)", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  function freshRoot(): string {
    const root = join(tmpdir(), `bare-push-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    return root;
  }

  it("'.git' como DIRETÓRIO → checkout principal (false)", () => {
    const root = freshRoot();
    mkdirSync(join(root, ".git"));
    assert.equal(isLinkedWorktree(root), false);
  });

  it("'.git' como ARQUIVO com 'gitdir:' → worktree vinculado (true)", () => {
    const root = freshRoot();
    writeFileSync(join(root, ".git"), "gitdir: /some/main/.git/worktrees/agent-x\n", "utf8");
    assert.equal(isLinkedWorktree(root), true);
  });
});

describe("BARE_PUSH_IN_WORKTREE_BLOCK_REASON (#7722)", () => {
  it("cita a issue de origem e a alternativa (remote + branch explícitos)", () => {
    assert.match(BARE_PUSH_IN_WORKTREE_BLOCK_REASON, /#7722/);
    assert.match(BARE_PUSH_IN_WORKTREE_BLOCK_REASON, /git push origin/);
  });
});
