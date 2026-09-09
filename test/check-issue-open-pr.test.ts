/**
 * test/check-issue-open-pr.test.ts (#7788)
 *
 * Smoke test do CLI (`scripts/check-issue-open-pr.ts`) — chama `main()`
 * diretamente (import, não subprocess) com um `CommandRunner` injetado
 * (nunca bate no `gh` real nem na API do GitHub). Cobre os 3 exit codes
 * documentados no cabeçalho do script, com ênfase na regra inegociável do
 * #7788: `gh` falhando NUNCA vira "sem PR aberta".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../scripts/check-issue-open-pr.ts";
import type { CommandRunner, CommandRunnerResult } from "../scripts/lib/gh-open-pr-fetch.ts";

function fakeRunnerReturning(stdout: string): CommandRunner {
  return () => ({ status: 0, stdout, stderr: "" });
}

function fakeRunnerFailing(message: string): CommandRunner {
  return () => ({ status: null, stdout: "", stderr: "", error: new Error(message) } as CommandRunnerResult);
}

function withCapturedLogs<T>(fn: () => T): { result: T; logs: string[]; errs: string[] } {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (m: string) => logs.push(m);
  console.error = (m: string) => errs.push(m);
  try {
    return { result: fn(), logs, errs };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("check-issue-open-pr main() (#7788)", () => {
  it("sem --issue → exit 2", () => {
    const { result: code } = withCapturedLogs(() => main([], "/tmp"));
    assert.equal(code, 2);
  });

  it("--issue inválido → exit 2", () => {
    const { result: code } = withCapturedLogs(() => main(["--issue", "abc"], "/tmp"));
    assert.equal(code, 2);
  });

  it("gh falhando → exit 2, verdict cannot-verify (NUNCA no-open-pr)", () => {
    const runner = fakeRunnerFailing("ENOENT: gh não encontrado");
    const { result: code, logs } = withCapturedLogs(() => main(["--issue", "7788"], "/tmp", runner));
    assert.equal(code, 2);
    const parsed = JSON.parse(logs.join("\n"));
    assert.equal(parsed.verdict, "cannot-verify");
    assert.notEqual(parsed.verdict, "no-open-pr");
    assert.ok(parsed.error);
  });

  it("gh retornando JSON malformado → exit 2, verdict cannot-verify", () => {
    const runner = fakeRunnerReturning("{ isto não é json");
    const { result: code, logs } = withCapturedLogs(() => main(["--issue", "7788"], "/tmp", runner));
    assert.equal(code, 2);
    const parsed = JSON.parse(logs.join("\n"));
    assert.equal(parsed.verdict, "cannot-verify");
  });

  it("PR aberta cobrindo a issue (branch continuo/fix-7746-pr-cap) → exit 1, open-pr-covers-scope", () => {
    const stdout = JSON.stringify([
      {
        number: 7783,
        title: "fix: cap de PRs paralelas no continuo",
        body: "",
        headRefName: "continuo/fix-7746-pr-cap",
        author: { login: "vjpixel" },
        updatedAt: "2026-09-09T09:18:00Z",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
    ]);
    const runner = fakeRunnerReturning(stdout);
    const { result: code, logs } = withCapturedLogs(() => main(["--issue", "7746"], "/tmp", runner));
    assert.equal(code, 1);
    const parsed = JSON.parse(logs.join("\n"));
    assert.equal(parsed.verdict, "open-pr-covers-scope");
    assert.equal(parsed.matches[0].number, 7783);
  });

  it("nenhuma PR aberta cobrindo a issue → exit 0, no-open-pr", () => {
    const runner = fakeRunnerReturning("[]");
    const { result: code, logs } = withCapturedLogs(() => main(["--issue", "7788"], "/tmp", runner));
    assert.equal(code, 0);
    const parsed = JSON.parse(logs.join("\n"));
    assert.equal(parsed.verdict, "no-open-pr");
  });
});
