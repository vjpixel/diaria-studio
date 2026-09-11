/**
 * test/diff-touched-lines.test.ts (#7978)
 *
 * Cobre scripts/lib/diff-touched-lines.ts — parsing puro de hunks
 * `git diff --unified=0`, mais o wrapper git real contra um repo sintético.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTouchedLinesFromUnifiedZeroDiff, gitDiffTouchedLines, gitShowFileAtSha } from "../scripts/lib/diff-touched-lines.ts";

describe("parseTouchedLinesFromUnifiedZeroDiff (#7978)", () => {
  it("hunk com contagem explícita (+c,d): marca d linhas a partir de c", () => {
    const diff = "@@ -1,2 +1,3 @@\n context\n+added1\n+added2\n";
    assert.deepEqual([...parseTouchedLinesFromUnifiedZeroDiff(diff)].sort((a, b) => a - b), [1, 2, 3]);
  });

  it("hunk sem contagem (+c, implícito 1 linha)", () => {
    const diff = "@@ -5 +5 @@\n-old\n+new\n";
    assert.deepEqual([...parseTouchedLinesFromUnifiedZeroDiff(diff)], [5]);
  });

  it("hunk de deleção pura (+c,0): nenhuma linha marcada", () => {
    const diff = "@@ -3,2 +3,0 @@\n-removed1\n-removed2\n";
    assert.deepEqual([...parseTouchedLinesFromUnifiedZeroDiff(diff)], []);
  });

  it("múltiplos hunks: união de todas as linhas", () => {
    const diff = "@@ -1 +1 @@\n+a\n@@ -10,2 +10,2 @@\n+b\n+c\n";
    assert.deepEqual([...parseTouchedLinesFromUnifiedZeroDiff(diff)].sort((a, b) => a - b), [1, 10, 11]);
  });

  it("nenhum hunk (diff vazio): conjunto vazio", () => {
    assert.deepEqual([...parseTouchedLinesFromUnifiedZeroDiff("")], []);
  });
});

describe("gitDiffTouchedLines / gitShowFileAtSha (#7978, git real em repo sintético)", () => {
  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "diff-touched-lines-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
    return dir;
  }

  it("detecta a linha nova adicionada entre 2 commits", () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "f.md"), "linha1\nlinha2\nlinha3\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

      writeFileSync(join(dir, "f.md"), "linha1\nMUDOU\nlinha3\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "muda linha 2"], { cwd: dir });
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

      const touched = gitDiffTouchedLines(dir, baseSha, headSha, "f.md");
      assert.deepEqual([...touched], [2]);

      const content = gitShowFileAtSha(dir, headSha, "f.md");
      assert.equal(content, "linha1\nMUDOU\nlinha3\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gitShowFileAtSha retorna null pra arquivo que não existe naquele SHA", () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "f.md"), "x\n");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "c1"], { cwd: dir });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      assert.equal(gitShowFileAtSha(dir, sha, "nao-existe.md"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
