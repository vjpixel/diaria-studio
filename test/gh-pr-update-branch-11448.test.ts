import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyUpdateBranchResponse,
  updateBranchApiArgs,
  waitForHeadChange,
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

// Review do #11455: 202 com a branch já em dia não pode virar falso `timeout`,
// e falha transitória do `gh pr view` na espera não pode sumir com o JSON.
describe("waitForHeadChange (#11455)", () => {
  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: (ms: number) => { t += ms; } };
  }

  it("HEAD muda → updated", () => {
    const clock = fakeClock();
    const heads = ["old", "old", "new"];
    const r = waitForHeadChange("old", 90, {
      ...clock,
      readHead: () => heads.shift() ?? "new",
      readBehindBy: () => assert.fail("não deve consultar behind_by quando o HEAD mudou"),
    });
    assert.equal(r.outcome, "updated");
    assert.equal(r.headAfter, "new");
  });

  it("202 com HEAD igual e base ancestral (behind_by 0) → already-up-to-date, não timeout", () => {
    const clock = fakeClock();
    const r = waitForHeadChange("same", 9, { ...clock, readHead: () => "same", readBehindBy: () => 0 });
    assert.equal(r.outcome, "already-up-to-date");
    assert.equal(r.headAfter, "same");
  });

  it("HEAD igual e base ainda à frente → timeout", () => {
    const clock = fakeClock();
    const r = waitForHeadChange("same", 9, { ...clock, readHead: () => "same", readBehindBy: () => 2 });
    assert.equal(r.outcome, "timeout");
  });

  it("falha do behind_by no fim → timeout (nunca sucesso), erro registrado", () => {
    const clock = fakeClock();
    const r = waitForHeadChange("same", 3, {
      ...clock,
      readHead: () => "same",
      readBehindBy: () => { throw new Error("compare 500"); },
    });
    assert.equal(r.outcome, "timeout");
    assert.ok(r.readErrors.some((e) => e.includes("compare 500")));
  });

  it("gh pr view falhando na espera não aborta: tenta de novo e devolve resultado", () => {
    const clock = fakeClock();
    let calls = 0;
    const r = waitForHeadChange("old", 90, {
      ...clock,
      readHead: () => {
        calls++;
        if (calls <= 2) throw new Error("gh pr view falhou: HTTP 502");
        return "new";
      },
      readBehindBy: () => 1,
    });
    assert.equal(r.outcome, "updated");
    assert.equal(r.headAfter, "new");
    assert.equal(r.readErrors.length, 2);
  });

  it("gh pr view falhando até o prazo → timeout com os erros, sem lançar", () => {
    const clock = fakeClock();
    const r = waitForHeadChange("old", 9, {
      ...clock,
      readHead: () => { throw new Error("rede"); },
      readBehindBy: () => 3,
    });
    assert.equal(r.outcome, "timeout");
    assert.equal(r.headAfter, "old");
    assert.ok(r.readErrors.length >= 1);
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
