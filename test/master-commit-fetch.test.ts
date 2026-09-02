/**
 * test/master-commit-fetch.test.ts (#7020)
 *
 * Regressão da causa raiz do próprio bug que o preflight existe pra
 * prevenir: `git log --all --grep` inclui refs alcançáveis por QUALQUER
 * caminho (branch local nunca mergeada, ref de PR fechada) — `origin/master`
 * não. Constrói um repo git real e temporário: um commit citando `#42`
 * MERGEADO em `master`, e outro commit citando `#42` numa branch separada
 * NUNCA mergeada (simula o SHA de uma PR fechada sem merge) — só o
 * primeiro deve aparecer via `fetchMasterCommitsForIssue`.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fetchMasterCommitsForIssue } from "../scripts/lib/master-commit-fetch.ts";

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} falhou: ${r.stderr || r.stdout}`);
  }
}

function commitFile(cwd: string, name: string, content: string, message: string): void {
  writeFileSync(join(cwd, name), content, "utf8");
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-m", message]);
}

describe("fetchMasterCommitsForIssue — origin/master vs --all (#7020)", () => {
  let originDir: string | null = null;
  let workDir: string | null = null;

  after(() => {
    for (const dir of [originDir, workDir]) {
      if (!dir) continue;
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (e) {
        console.warn(`[master-commit-fetch.test] cleanup residual de ${dir}: ${(e as Error).message}`);
      }
    }
  });

  it("commit em master é encontrado; commit só em branch não-mergeada NÃO é (o que --all erraria)", () => {
    originDir = mkdtempSync(join(tmpdir(), "master-commit-fetch-origin-"));
    git(originDir, ["init", "--bare", "-b", "master"]);

    workDir = mkdtempSync(join(tmpdir(), "master-commit-fetch-work-"));
    git(workDir, ["init", "-b", "master"]);
    git(workDir, ["config", "user.email", "test@example.com"]);
    git(workDir, ["config", "user.name", "Test"]);
    git(workDir, ["remote", "add", "origin", originDir]);

    commitFile(workDir, "base.txt", "base", "chore: base");
    commitFile(workDir, "merged.txt", "conteudo", "fix(#42): resolve de verdade\n\nCloses #42");
    git(workDir, ["push", "origin", "master"]);

    // Branch separada, NUNCA mergeada em master nem pusheada pra origin —
    // simula o SHA de uma PR fechada sem merge (o cenário que `--all`
    // erraria ao incluir).
    git(workDir, ["checkout", "-b", "closed-pr-branch"]);
    commitFile(workDir, "unmerged.txt", "conteudo", "fix(#42): tentativa que nunca foi mergeada\n\nCloses #42");
    git(workDir, ["checkout", "master"]);

    git(workDir, ["fetch", "origin"]);

    const result = fetchMasterCommitsForIssue(workDir, 42);
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.commits.length, 1, "só o commit mergeado em origin/master deve aparecer");
    assert.match(result.commits[0].subject, /resolve de verdade/);
    assert.doesNotMatch(result.commits[0].subject, /nunca foi mergeada/);
  });

  it("issue não citada em nenhum commit → array vazio, sem erro", () => {
    workDir = mkdtempSync(join(tmpdir(), "master-commit-fetch-work2-"));
    originDir = mkdtempSync(join(tmpdir(), "master-commit-fetch-origin2-"));
    git(originDir, ["init", "--bare", "-b", "master"]);
    git(workDir, ["init", "-b", "master"]);
    git(workDir, ["config", "user.email", "test@example.com"]);
    git(workDir, ["config", "user.name", "Test"]);
    git(workDir, ["remote", "add", "origin", originDir]);
    commitFile(workDir, "base.txt", "base", "chore: sem menção a issue nenhuma");
    git(workDir, ["push", "origin", "master"]);
    git(workDir, ["fetch", "origin"]);

    const result = fetchMasterCommitsForIssue(workDir, 9999);
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.commits, []);
  });

  it("#42 não casa por engano com commit citando #420 (boundary de dígito de ponta a ponta)", () => {
    workDir = mkdtempSync(join(tmpdir(), "master-commit-fetch-work3-"));
    originDir = mkdtempSync(join(tmpdir(), "master-commit-fetch-origin3-"));
    git(originDir, ["init", "--bare", "-b", "master"]);
    git(workDir, ["init", "-b", "master"]);
    git(workDir, ["config", "user.email", "test@example.com"]);
    git(workDir, ["config", "user.name", "Test"]);
    git(workDir, ["remote", "add", "origin", originDir]);
    commitFile(workDir, "base.txt", "base", "fix(#420): outra issue, número parecido");
    git(workDir, ["push", "origin", "master"]);
    git(workDir, ["fetch", "origin"]);

    const result = fetchMasterCommitsForIssue(workDir, 42);
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.commits, []);
  });
});
