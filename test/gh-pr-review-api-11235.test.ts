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
import {
  EXIT_GH,
  EXIT_OK,
  EXIT_USAGE,
  LIST_COMMENTS_JQ,
  buildGhApiArgs,
  runCli,
  runOp,
  validateOp,
  type GhRunFn,
  type ReviewApiOp,
} from "../scripts/gh-pr-review-api.ts";

const repo = "vjpixel/diaria-studio";
const SHA = "1f1b431d7057630378cefe88efafd776f1c6079a";
const ROOT = process.cwd();

function fakeGh(responses: Array<{ status: number; stdout: string; stderr: string }>) {
  const calls: string[][] = [];
  const run: GhRunFn = (args) => {
    calls.push(args);
    return responses[calls.length - 1] ?? { status: 1, stdout: "", stderr: "sem resposta" };
  };
  return { run, calls };
}
const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
const files = (map: Record<string, string>) => (p: string) => {
  if (!(p in map)) throw new Error(`ENOENT: ${p}`);
  return map[p];
};

describe("gh-pr-review-api: buildGhApiArgs", () => {
  it("args completos de cada subcomando", () => {
    const cases: Array<[ReviewApiOp, string[]]> = [
      [
        { kind: "comment", repo, pr: 5, path: "a.ts", line: 3, side: "RIGHT", commit: SHA, body: "x" },
        ["api", "-X", "POST", `repos/${repo}/pulls/5/comments`, "-f", "body=x", "-f", `commit_id=${SHA}`, "-f", "path=a.ts", "-F", "line=3", "-f", "side=RIGHT", "--jq", ".html_url"],
      ],
      [{ kind: "reply", repo, pr: 5, commentId: 99, body: "x" }, ["api", "-X", "POST", `repos/${repo}/pulls/5/comments/99/replies`, "-f", "body=x", "--jq", ".html_url"]],
      [{ kind: "list-comments", repo, pr: 5 }, ["api", "-X", "GET", "--paginate", `repos/${repo}/pulls/5/comments`, "--jq", LIST_COMMENTS_JQ]],
      [{ kind: "head-sha", repo, pr: 5 }, ["api", "-X", "GET", `repos/${repo}/pulls/5`, "--jq", ".head.sha"]],
      [{ kind: "ref-sha", repo, branch: "master" }, ["api", "-X", "GET", `repos/${repo}/git/ref/heads/master`, "--jq", ".object.sha"]],
    ];
    for (const [op, expected] of cases) assert.deepEqual(buildGhApiArgs(op), expected, op.kind);
  });

  it("o corpo vira um único argumento `body=`, sem virar flag", () => {
    const args = buildGhApiArgs({ kind: "reply", repo, pr: 5, commentId: 1, body: "-X DELETE\nrepos/x" });
    assert.ok(args.includes("body=-X DELETE\nrepos/x"));
    assert.equal(args.filter((a) => a === "-X").length, 1);
  });
});

describe("gh-pr-review-api: validateOp", () => {
  const comment = (over: Partial<Extract<ReviewApiOp, { kind: "comment" }>>): ReviewApiOp => ({
    kind: "comment", repo, pr: 5, path: "a.ts", line: 1, side: "RIGHT", commit: SHA, body: "x", ...over,
  });
  it("recusa argumento que tente escapar do endpoint ou seja inválido", () => {
    const bad: ReviewApiOp[] = [
      { kind: "ref-sha", repo, branch: "../../branches/master/protection" },
      { kind: "ref-sha", repo, branch: "master -X DELETE" },
      { kind: "ref-sha", repo, branch: "-X" },
      { kind: "ref-sha", repo, branch: "/master" },
      { kind: "head-sha", repo: "vjpixel/x y", pr: 5 },
      { kind: "head-sha", repo, pr: NaN },
      { kind: "list-comments", repo, pr: 0 },
      { kind: "head-sha", repo, pr: -3 },
      comment({ path: "--method" }),
      comment({ path: "../etc/passwd" }),
      comment({ path: "a/../../b" }),
      comment({ path: "/abs.ts" }),
      comment({ path: "" }),
      comment({ line: 0 }),
      comment({ commit: "HEAD" }),
      comment({ commit: SHA.slice(0, 7) }),
      comment({ side: "UP" as "RIGHT" }),
      comment({ body: "  \n" }),
      { kind: "reply", repo, pr: 5, commentId: 0, body: "x" },
      { kind: "reply", repo, pr: 5, commentId: NaN, body: "x" },
      { kind: "reply", repo, pr: 5, commentId: 1, body: "   " },
    ];
    for (const op of bad) {
      assert.notEqual(validateOp(op), null, JSON.stringify(op));
      assert.throws(() => buildGhApiArgs(op), JSON.stringify(op));
    }
    assert.equal(validateOp(comment({ path: "scripts/lib/a.ts", side: "LEFT" })), null);
  });
});

describe("gh-pr-review-api: runOp", () => {
  it("falha do gh e SHA malformado nunca viram sucesso; argumento inválido não chama o gh", () => {
    const op: ReviewApiOp = { kind: "ref-sha", repo, branch: "master" };
    assert.deepEqual(runOp(op, () => ok(`${SHA}\n`)), { ok: true, out: SHA });
    assert.equal(runOp(op, () => ({ status: 1, stdout: "", stderr: "404" })).ok, false);
    assert.equal(runOp(op, () => ok("null")).ok, false);
    assert.equal(runOp(op, () => ok("abc1234")).ok, false, "SHA curto");
    let called = false;
    assert.equal(runOp({ kind: "ref-sha", repo, branch: "a b" }, () => ((called = true), ok(SHA))).ok, false);
    assert.equal(called, false);
  });

  it("list-comments junta o NDJSON de todas as páginas num array; linha inválida é erro", () => {
    const op: ReviewApiOp = { kind: "list-comments", repo, pr: 5 };
    const a = { id: 1, path: "a.ts", line: 2, body: "x", author_association: "OWNER", user: "vjpixel" };
    const b = { id: 2, path: "b.ts", line: null, body: "y", author_association: "NONE", user: "z" };
    assert.deepEqual(runOp(op, () => ok(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`)), { ok: true, out: JSON.stringify([a, b]) });
    assert.deepEqual(runOp(op, () => ok("")), { ok: true, out: "[]" });
    assert.equal(runOp(op, () => ok("{nope")).ok, false);
  });
});

describe("gh-pr-review-api: runCli", () => {
  it("comment sem --commit busca o head da PR e comenta nele", () => {
    const gh = fakeGh([ok(SHA), ok("https://github.com/x/pull/5#discussion_r1")]);
    const r = runCli(["comment", "--pr", "5", "--path", "a.ts", "--line", "3", "--body-file", "/b.md"], gh.run, files({ "/b.md": "achado" }), ROOT);
    assert.equal(r.exitCode, EXIT_OK, r.stderr);
    assert.equal(r.stdout, "https://github.com/x/pull/5#discussion_r1");
    assert.deepEqual(gh.calls[0].slice(0, 4), ["api", "-X", "GET", `repos/${repo}/pulls/5`]);
    assert.ok(gh.calls[1].includes(`commit_id=${SHA}`));
    assert.ok(gh.calls[1].includes("body=achado"));
  });

  it("comment: head da PR indisponível é exit 1, sem postar", () => {
    const gh = fakeGh([{ status: 1, stdout: "", stderr: "404" }]);
    const r = runCli(["comment", "--pr", "5", "--path", "a.ts", "--line", "3", "--body-file", "/b.md"], gh.run, files({ "/b.md": "x" }), ROOT);
    assert.equal(r.exitCode, EXIT_GH);
    assert.equal(gh.calls.length, 1);
  });

  it("list-comments devolve o array JSON", () => {
    const c = { id: 7, path: "a.ts", line: 1, body: "f", author_association: "OWNER", user: "vjpixel" };
    const gh = fakeGh([ok(JSON.stringify(c))]);
    const r = runCli(["list-comments", "--pr", "5", "--repo", "vjpixel/diaria-studio"], gh.run, files({}), ROOT);
    assert.equal(r.exitCode, EXIT_OK);
    assert.deepEqual(JSON.parse(r.stdout), [c]);
    assert.ok(gh.calls[0].includes("--paginate"));
  });

  it("erros de uso saem 2 sem chamar o gh", () => {
    const body = files({ "/b.md": "x" });
    for (const argv of [
      ["comment", "--pr", "5", "--path", "a.ts", "--line", "3", "--body-file", "/b.md", "--side", "UP"],
      ["comment", "--pr", "5", "--path", "a.ts", "--line", "3", "--body-file", "/b.md", "--commit", "abc1234"],
      ["comment", "--pr", "5", "--path", "a.ts", "--line", "3", "--body-file", "/nao-existe.md"],
      ["comment", "--pr", "5", "--path", "a.ts", "--line", "3"],
      ["comment", "--pr", "5", "--path", "../x", "--line", "3", "--body-file", "/b.md", "--commit", SHA],
      ["reply", "--pr", "5", "--comment-id", "abc", "--body-file", "/b.md"],
      ["head-sha", "--pr", "0"],
      ["head-sha", "--pr", "5", "--method", "DELETE"],
      ["head-sha", "--pr", "5", "--paginate"],
      ["ref-sha", "--branch", "master", "solto"],
      ["delete-branch", "--branch", "x"],
      [],
    ]) {
      const gh = fakeGh([]);
      const r = runCli(argv, gh.run, body, ROOT);
      assert.equal(r.exitCode, EXIT_USAGE, JSON.stringify(argv));
      assert.equal(gh.calls.length, 0, JSON.stringify(argv));
    }
  });
});
