/**
 * test/gh-pr-review-api-11235.test.ts
 *
 * Helper das chamadas REST do fluxo autônomo (#11235, review da PR #11250):
 * método e endpoint fixos por subcomando, e argumento que tente escapar do
 * endpoint (flag disfarçada de path, branch com `..`, repo com espaço) é
 * recusado antes de chamar o `gh`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGhApiArgs, runOp, validateOp, type ReviewApiOp } from "../scripts/gh-pr-review-api.ts";

const repo = "vjpixel/diaria-studio";
const SHA = "1f1b431d7057630378cefe88efafd776f1c6079a";

describe("gh-pr-review-api (#11235)", () => {
  it("cada subcomando tem método e endpoint fixos", () => {
    const cases: Array<[ReviewApiOp, string, string]> = [
      [{ kind: "comment", repo, pr: 5, path: "a.ts", line: 3, side: "RIGHT", commit: SHA, body: "x" }, "POST", `repos/${repo}/pulls/5/comments`],
      [{ kind: "reply", repo, pr: 5, commentId: 99, body: "x" }, "POST", `repos/${repo}/pulls/5/comments/99/replies`],
      [{ kind: "head-sha", repo, pr: 5 }, "GET", `repos/${repo}/pulls/5`],
      [{ kind: "ref-sha", repo, branch: "master" }, "GET", `repos/${repo}/git/ref/heads/master`],
    ];
    for (const [op, method, endpoint] of cases) {
      const args = buildGhApiArgs(op);
      assert.deepEqual(args.slice(0, 4), ["api", "-X", method, endpoint], op.kind);
      assert.equal(args.filter((a) => a === "-X").length, 1, `${op.kind}: um só -X`);
    }
  });

  it("o corpo vira um único argumento `body=`, sem virar flag", () => {
    const args = buildGhApiArgs({ kind: "reply", repo, pr: 5, commentId: 1, body: "-X DELETE\nrepos/x" });
    assert.ok(args.includes("body=-X DELETE\nrepos/x"));
    assert.equal(args.filter((a) => a === "-X").length, 1);
  });

  it("recusa argumento que tente escapar do endpoint", () => {
    const bad: ReviewApiOp[] = [
      { kind: "ref-sha", repo, branch: "../../branches/master/protection" },
      { kind: "ref-sha", repo, branch: "master -X DELETE" },
      { kind: "ref-sha", repo, branch: "-X" },
      { kind: "head-sha", repo: "vjpixel/x y", pr: 5 },
      { kind: "head-sha", repo, pr: NaN },
      { kind: "comment", repo, pr: 5, path: "--method", line: 1, side: "RIGHT", commit: SHA, body: "x" },
      { kind: "comment", repo, pr: 5, path: "a.ts", line: 0, side: "RIGHT", commit: SHA, body: "x" },
      { kind: "comment", repo, pr: 5, path: "a.ts", line: 1, side: "RIGHT", commit: "HEAD", body: "x" },
      { kind: "reply", repo, pr: 5, commentId: 1, body: "   " },
    ];
    for (const op of bad) {
      assert.notEqual(validateOp(op), null, JSON.stringify(op));
      assert.throws(() => buildGhApiArgs(op));
    }
  });

  it("runOp: falha do gh e SHA malformado nunca viram sucesso", () => {
    const op: ReviewApiOp = { kind: "ref-sha", repo, branch: "master" };
    assert.deepEqual(runOp(op, () => ({ status: 0, stdout: `${SHA}\n`, stderr: "" })), { ok: true, out: SHA });
    assert.equal(runOp(op, () => ({ status: 1, stdout: "", stderr: "404" })).ok, false);
    assert.equal(runOp(op, () => ({ status: 0, stdout: "null", stderr: "" })).ok, false);
    assert.equal(runOp(op, () => ({ status: 0, stdout: "<html>", stderr: "" })).ok, false);
    let called = false;
    assert.equal(runOp({ kind: "ref-sha", repo, branch: "a b" }, () => ((called = true), { status: 0, stdout: SHA, stderr: "" })).ok, false);
    assert.equal(called, false, "argumento inválido não chega a chamar o gh");
  });
});
