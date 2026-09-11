/**
 * test/revert-calibration.test.ts (#7978)
 *
 * Cobre scripts/revert-calibration.ts::buildRevertPlan (puro) e
 * executeRevertPlan contra um repo git sintético (sem tocar rede/gh real).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRevertPlan, executeRevertPlan } from "../scripts/revert-calibration.ts";

describe("buildRevertPlan (#7978)", () => {
  it("monta branch/comando/PR a partir do SHA e da razão", () => {
    const plan = buildRevertPlan("abc1234567890", "CTR caiu 3pp na semana seguinte");
    assert.equal(plan.branchName, "revert/calibration-abc1234567");
    assert.deepEqual(plan.revertCommand, ["git", "revert", "--no-edit", "abc1234567890"]);
    assert.match(plan.prTitle, /abc1234567/);
    assert.match(plan.prBody, /CTR caiu 3pp na semana seguinte/);
    assert.match(plan.prBody, /#5251/);
  });

  it("prBody menciona a pendência do gate de sign-off (documentação viva do achado)", () => {
    const plan = buildRevertPlan("sha", "motivo");
    assert.match(plan.prBody, /revert-calibration\.ts/);
  });
});

describe("executeRevertPlan (#7978, git real em repo sintético)", () => {
  function makeRepoWithCommitToRevert(): { dir: string; sha: string } {
    const dir = mkdtempSync(join(tmpdir(), "revert-calibration-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
    writeFileSync(join(dir, "f.txt"), "original\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });

    writeFileSync(join(dir, "f.txt"), "calibrado\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "calibração"], { cwd: dir });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    return { dir, sha };
  }

  it("checkout -b + git revert aplicam limpo quando não há conflito (push/PR falham sem remote/gh — esperado neste teste sintético)", () => {
    const { dir, sha } = makeRepoWithCommitToRevert();
    try {
      const plan = buildRevertPlan(sha, "teste");
      const result = executeRevertPlan(plan, dir);
      // Sem remote configurado neste repo sintético, o push falha — o que
      // este teste garante é que o revert em si (a parte que pode ter
      // CONFLITO real) aconteceu limpo antes de chegar lá.
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /push falhou/);

      const content = execFileSync("git", ["show", "HEAD:f.txt"], { cwd: dir, encoding: "utf8" });
      assert.equal(content, "original\n", "o revert deveria ter restaurado o conteúdo original");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SHA inexistente: git revert falha com erro claro, nunca side-effect parcial não-reportado", () => {
    const dir = mkdtempSync(join(tmpdir(), "revert-calibration-badsha-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
    writeFileSync(join(dir, "f.txt"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "c1"], { cwd: dir });
    try {
      const plan = buildRevertPlan("0000000000000000000000000000000000000", "teste");
      const result = executeRevertPlan(plan, dir);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /git revert falhou/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
