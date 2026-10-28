import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyUpdateBranchResponse,
  updateBranchApiArgs,
} from "../scripts/gh-pr-update-branch.ts";

// #11448: o gh do 300 não tem `gh pr update-branch`; o passo de trazer a base
// para a PR antes do merge passa pelo wrapper REST.

describe("classifyUpdateBranchResponse (#11448)", () => {
  it("202 (gh api exit 0) → accepted", () => {
    const r = classifyUpdateBranchResponse(0, '{"message":"Updating pull request branch.","url":"x"}', "");
    assert.equal(r.outcome, "accepted");
  });

  it("422 sem commits novos na base → already-up-to-date (não é falha)", () => {
    const r = classifyUpdateBranchResponse(
      1,
      '{"message":"There are no new commits on the base branch.","status":"422"}',
      "gh: There are no new commits on the base branch. (HTTP 422)",
    );
    assert.equal(r.outcome, "already-up-to-date");
  });

  it("422 por conflito → conflict", () => {
    const r = classifyUpdateBranchResponse(1, "", "gh: merge conflict between base and head (HTTP 422)");
    assert.equal(r.outcome, "conflict");
  });

  it("422 por expected_head_sha divergente → head-mismatch", () => {
    const r = classifyUpdateBranchResponse(1, "", "gh: expected head sha didn't match current head ref. (HTTP 422)");
    assert.equal(r.outcome, "head-mismatch");
  });

  it("qualquer outra falha (404, auth, rede) → error, nunca sucesso", () => {
    assert.equal(classifyUpdateBranchResponse(1, "", "gh: Not Found (HTTP 404)").outcome, "error");
    assert.equal(classifyUpdateBranchResponse(null, "", "").outcome, "error");
  });
});

describe("updateBranchApiArgs (#11448)", () => {
  it("PUT no endpoint update-branch do repo do cwd quando --repo ausente", () => {
    const args = updateBranchApiArgs(42, undefined);
    assert.deepEqual(args.slice(0, 4), ["api", "-X", "PUT", "repos/{owner}/{repo}/pulls/42/update-branch"]);
    assert.ok(!args.includes("-f"));
  });

  it("--repo explícito e expected_head_sha repassado", () => {
    const args = updateBranchApiArgs(7, "vjpixel/diaria-design", "abc123");
    assert.ok(args.includes("repos/vjpixel/diaria-design/pulls/7/update-branch"));
    assert.deepEqual(args.slice(-2), ["-f", "expected_head_sha=abc123"]);
  });
});

describe("o passo de atualizar a base do overnight usa o wrapper (#11448)", () => {
  const skill = readFileSync(new URL("../.claude/skills/diaria-overnight/SKILL.md", import.meta.url), "utf8");
  const rules = readFileSync(new URL("../context/overnight-dispatch-rules.md", import.meta.url), "utf8");

  it("SKILL.md do overnight não manda mais rodar `gh pr update-branch` cru", () => {
    assert.match(skill, /npx tsx scripts\/gh-pr-update-branch\.ts --pr \{N\} \[--repo \{repo\}\]/);
    assert.doesNotMatch(skill, /`gh pr update-branch \{N\}/);
  });

  it("regras de dispatch citam o wrapper como forma canônica", () => {
    assert.match(rules.replace(/\s+/g, " "), /npx tsx scripts\/gh-pr-update-branch\.ts --pr N/);
  });
});
