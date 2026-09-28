import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockMessage, isProtectedBranch, shouldBlockCommit } from "../scripts/lib/master-commit-guard.ts";
import { getCurrentBranch } from "../scripts/check-master-direct-commit.ts";

const REPO_ROOT = join(import.meta.dirname, "..");

describe("master-commit-guard (#8878) — lógica pura", () => {
  it("isProtectedBranch: só master/main", () => {
    assert.equal(isProtectedBranch("master"), true);
    assert.equal(isProtectedBranch("main"), true);
    assert.equal(isProtectedBranch("overnight/fix-1-x"), false);
    assert.equal(isProtectedBranch(null), false);
    assert.equal(isProtectedBranch(undefined), false);
    assert.equal(isProtectedBranch(""), false);
  });

  it("shouldBlockCommit: bloqueia master/main sem override", () => {
    assert.equal(shouldBlockCommit("master", {}), true);
    assert.equal(shouldBlockCommit("main", {}), true);
  });

  it("shouldBlockCommit: branch de trabalho nunca bloqueia", () => {
    assert.equal(shouldBlockCommit("overnight/fix-8878-hermes-commit-guard", {}), false);
    assert.equal(shouldBlockCommit(null, {}), false);
  });

  it("shouldBlockCommit: override explícito DIARIA_ALLOW_MASTER_COMMIT=1 libera", () => {
    assert.equal(shouldBlockCommit("master", { DIARIA_ALLOW_MASTER_COMMIT: "1" }), false);
  });

  it("shouldBlockCommit: qualquer outro valor do override NÃO libera (só '1' exato)", () => {
    assert.equal(shouldBlockCommit("master", { DIARIA_ALLOW_MASTER_COMMIT: "true" }), true);
    assert.equal(shouldBlockCommit("master", { DIARIA_ALLOW_MASTER_COMMIT: "yes" }), true);
    assert.equal(shouldBlockCommit("master", { DIARIA_ALLOW_MASTER_COMMIT: "" }), true);
  });

  it("blockMessage: cita a branch e a issue de origem", () => {
    const msg = blockMessage("master");
    assert.match(msg, /#8878/);
    assert.match(msg, /"master"/);
    assert.match(msg, /DIARIA_ALLOW_MASTER_COMMIT=1/);
  });
});

describe("getCurrentBranch (#8878)", () => {
  it("lê a branch HEAD de um repo git com branch real (via symbolic-ref)", () => {
    // Não usa REPO_ROOT aqui: CI (actions/checkout) costuma deixar o
    // checkout em HEAD DESANEXADO (checkout por SHA, não por branch) —
    // `git symbolic-ref --short HEAD` devolve null nesse estado, e isso é
    // correto (não há branch simbólica pra devolver), não uma falha do
    // guard. Um repo próprio, com uma branch de verdade, é o cenário que
    // este teste precisa provar — e é o cenário real de todo `git commit`
    // que o hook intercepta (sempre numa branch, nunca em HEAD desanexado).
    const dir = mkdtempSync(join(tmpdir(), "master-commit-guard-branch-"));
    execFileSync("git", ["init", "-q", "-b", "minha-branch", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    writeFileSync(join(dir, "f.txt"), "x");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    assert.equal(getCurrentBranch(dir), "minha-branch");
  });

  it("devolve null em HEAD desanexado (mesmo com commits) — sem branch simbólica pra devolver", () => {
    const dir = mkdtempSync(join(tmpdir(), "master-commit-guard-detached-"));
    execFileSync("git", ["init", "-q", "-b", "master", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    writeFileSync(join(dir, "f.txt"), "x");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", dir, "checkout", "-q", sha]);
    assert.equal(getCurrentBranch(dir), null);
  });

  it("devolve null fora de um repo git", () => {
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    assert.equal(getCurrentBranch(dir), null);
  });
});

/**
 * Teste de regressão end-to-end (#633): reproduz o cenário REAL do #8878 —
 * `git commit` direto em `master`, num checkout fresco, deve ser recusado
 * pelo hook instalado (`scripts/hooks/pre-commit`), não só pela função pura
 * acima. Cobre a integração (hook shell -> check-master-direct-commit.ts ->
 * master-commit-guard.ts), que o teste unitário sozinho não prova.
 */
describe("scripts/hooks/pre-commit (#8878) — integração end-to-end", () => {
  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "master-commit-guard-"));
    execFileSync("git", ["init", "-q", "-b", "master", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    // Instala o hook apontando pro tsx + script do repo REAL, mas rodando
    // com cwd = este repo TEMPORÁRIO (mesmo contrato do hook instalado de
    // verdade no checkout compartilhado: `check-master-direct-commit.ts` lê
    // a branch de `process.cwd()`) — simula "hook instalado", sem clonar o
    // repo inteiro pra dentro do tmpdir.
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    const tsx = join(REPO_ROOT, "node_modules", ".bin", "tsx");
    const script = join(REPO_ROOT, "scripts", "check-master-direct-commit.ts");
    writeFileSync(hookPath, ["#!/bin/sh", `'${tsx}' '${script}'`].join("\n") + "\n");
    chmodSync(hookPath, 0o755);
    writeFileSync(join(dir, "f.txt"), "x");
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    return dir;
  }

  it("recusa commit direto em master (regressão do incidente real)", () => {
    const dir = makeRepo();
    assert.throws(() => {
      execFileSync("git", ["-C", dir, "commit", "-m", "direto em master"], { stdio: "pipe" });
    }, /BLOQUEADO|non-zero exit code/);
  });

  it("permite commit numa branch de trabalho", () => {
    const dir = makeRepo();
    execFileSync("git", ["-C", dir, "checkout", "-q", "-b", "feature/x"]);
    execFileSync("git", ["-C", dir, "commit", "-m", "ok numa branch"], { stdio: "pipe" });
    const log = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" });
    assert.match(log, /ok numa branch/);
  });

  it("override DIARIA_ALLOW_MASTER_COMMIT=1 permite commit humano deliberado em master", () => {
    const dir = makeRepo();
    execFileSync("git", ["-C", dir, "commit", "-m", "hotfix humano"], {
      stdio: "pipe",
      env: { ...process.env, DIARIA_ALLOW_MASTER_COMMIT: "1" },
    });
    const log = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" });
    assert.match(log, /hotfix humano/);
  });
});
