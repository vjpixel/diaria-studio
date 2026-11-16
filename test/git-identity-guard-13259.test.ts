/**
 * #13259 — a rodada 261115f commitou como `Test <test@test.com>` porque o git
 * do `300` estava com essa identidade (global e `.git/config`). O guard recusa
 * identidade vazia ou placeholder antes do trem de merge criar commits.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { evaluateGitIdentity, formatGitIdentityProblem, readGitIdentity } from "../scripts/lib/git-identity-guard.ts";

describe("evaluateGitIdentity (#13259)", () => {
  it("REGRESSÃO: `Test <test@test.com>` da rodada 261115f é recusada", () => {
    const v = evaluateGitIdentity("Test", "test@test.com");
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.equal(v.problems.length, 2);
    assert.match(formatGitIdentityProblem(v), /Test <test@test\.com>/);
  });

  it("identidade real do editor passa", () => {
    assert.deepEqual(evaluateGitIdentity("Pixel", "vjpixel@gmail.com"), { ok: true, name: "Pixel", email: "vjpixel@gmail.com" });
  });

  it("vazia (sem config) é recusada", () => {
    const v = evaluateGitIdentity("", "");
    assert.equal(v.ok, false);
    if (!v.ok) assert.deepEqual(v.problems, ["user.email vazio", "user.name vazio"]);
  });

  it("placeholders dos testes do repo e domínios reservados são recusados", () => {
    for (const email of ["t@t", "t@example.com", "TEST@example.com", "x@sub.example.org", "a@localhost", "semarroba"]) {
      assert.equal(evaluateGitIdentity("Pixel", email).ok, false, email);
    }
    for (const name of ["t", "T", "test", "Other Session"]) {
      assert.equal(evaluateGitIdentity(name, "vjpixel@gmail.com").ok, false, name);
    }
  });

  it("domínio que só CONTÉM 'test' não é falso positivo", () => {
    assert.equal(evaluateGitIdentity("Ana", "ana@contest.com.br").ok, true);
    assert.equal(evaluateGitIdentity("Ana", "ana@testing.io").ok, true);
  });
});

describe("readGitIdentity (#13259, git real em repo sintético)", () => {
  it("lê a identidade local do repositório", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-identity-13259-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
      spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
      const id = readGitIdentity(dir);
      assert.deepEqual(id, { name: "Test", email: "test@test.com" });
      assert.equal(evaluateGitIdentity(id.name, id.email).ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chave ausente vira string vazia (runner injetado)", () => {
    const id = readGitIdentity("/nao-importa", () => "");
    assert.deepEqual(id, { name: "", email: "" });
  });
});
