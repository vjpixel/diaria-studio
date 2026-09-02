/**
 * test/check-issue-duplicate-preflight.test.ts (#7020)
 *
 * Smoke test do CLI (`scripts/check-issue-duplicate-preflight.ts`) — chama
 * `main()` diretamente (import, não subprocess) contra um repo git real
 * fabricado, cobrindo os exit codes documentados no cabeçalho do script.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { main } from "../scripts/check-issue-duplicate-preflight.ts";

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr || r.stdout}`);
}

function commitFile(cwd: string, name: string, content: string, message: string): void {
  writeFileSync(join(cwd, name), content, "utf8");
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-m", message]);
}

function setupRepo(): { workDir: string; originDir: string } {
  const originDir = mkdtempSync(join(tmpdir(), "check-dup-preflight-origin-"));
  git(originDir, ["init", "--bare", "-b", "master"]);
  const workDir = mkdtempSync(join(tmpdir(), "check-dup-preflight-work-"));
  git(workDir, ["init", "-b", "master"]);
  git(workDir, ["config", "user.email", "test@example.com"]);
  git(workDir, ["config", "user.name", "Test"]);
  git(workDir, ["remote", "add", "origin", originDir]);
  return { workDir, originDir };
}

describe("check-issue-duplicate-preflight main() (#7020)", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (e) {
        console.warn(`[check-issue-duplicate-preflight.test] cleanup ${d}: ${(e as Error).message}`);
      }
    }
  });

  it("sem --issue → exit 2", () => {
    const { workDir, originDir } = setupRepo();
    dirs.push(workDir, originDir);
    const logs: string[] = [];
    const orig = console.error;
    console.error = (m: string) => logs.push(m);
    try {
      const code = main([], workDir);
      assert.equal(code, 2);
    } finally {
      console.error = orig;
    }
  });

  it("issue não citada em master → exit 0, verdict not-in-master", () => {
    const { workDir, originDir } = setupRepo();
    dirs.push(workDir, originDir);
    commitFile(workDir, "a.txt", "x", "chore: nada a ver");
    git(workDir, ["push", "origin", "master"]);
    git(workDir, ["fetch", "origin"]);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: string) => logs.push(m);
    let code: number;
    try {
      code = main(["--issue", "12345"], workDir);
    } finally {
      console.log = orig;
    }
    assert.equal(code, 0);
    const parsed = JSON.parse(logs.join(""));
    assert.equal(parsed.verdict, "not-in-master");
  });

  it("issue já resolvida com Closes em master → exit 1, verdict closes-should-be-closed", () => {
    const { workDir, originDir } = setupRepo();
    dirs.push(workDir, originDir);
    commitFile(workDir, "a.txt", "x", "fix(#555): resolve\n\nCloses #555");
    git(workDir, ["push", "origin", "master"]);
    git(workDir, ["fetch", "origin"]);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: string) => logs.push(m);
    let code: number;
    try {
      code = main(["--issue", "555"], workDir);
    } finally {
      console.log = orig;
    }
    assert.equal(code, 1);
    const parsed = JSON.parse(logs.join(""));
    assert.equal(parsed.verdict, "closes-should-be-closed");
  });
});
