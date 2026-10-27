import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  findRawPrReviewComment as find,
  shouldBlockRawPrReviewComment as shouldBlock,
  RAW_PR_REVIEW_COMMENT_BLOCK_REASON,
} from "../.claude/hooks/block-raw-pr-review-comment.mjs";

// #11300 — na PR #11285 o dev-implementador postou o self-review por `gh api`
// cru, sem o marcador `<!-- diaria-auto-review -->`; `resolve-review-threads.ts`
// (#11269) leu as 4 threads como do editor e o Gate 2 travou.

const HOOK = join(import.meta.dirname, "..", ".claude", "hooks", "block-raw-pr-review-comment.mjs");

describe("findRawPrReviewComment (#11300)", () => {
  it("cenário da issue: self-review inline por gh api cru → bloqueia", () => {
    assert.equal(
      find(`gh api repos/vjpixel/diaria-studio/pulls/11285/comments -f body="**self-review** x" -f commit_id=abc -f path=scripts/a.ts -F line=12 -f side=RIGHT`),
      "rest",
    );
    assert.equal(find(`gh api -X POST "repos/{owner}/{repo}/pulls/$PR/comments" --input payload.json`), "rest");
    assert.equal(find(`gh api --method=POST repos/o/r/pulls/5/comments/99/replies -f body=ok`), "rest");
    assert.equal(find(`gh api -XPATCH repos/o/r/pulls/comments/99 -f body=editado`), "rest");
    assert.equal(find(`gh api repos/o/r/pulls/5/reviews --input review.json`), "rest");
  });
  it("prefixos, wrappers, flags globais, subshell e bash -c → bloqueia", () => {
    assert.equal(find(`GH_REPO=o/r timeout 30 gh api repos/o/r/pulls/5/comments -f body=x`), "rest");
    assert.equal(find(`cd /tmp/w && /usr/bin/gh api repos/o/r/pulls/5/comments -f body=x`), "rest");
    assert.equal(find(`url=$(gh api repos/o/r/pulls/5/comments -f body=x --jq .html_url)`), "rest");
    assert.equal(find(`bash -c "gh api repos/o/r/pulls/5/comments -f body=x"`), "rest");
  });
  it("graphql com mutation de review → bloqueia; query de leitura passa", () => {
    assert.equal(
      find(`gh api graphql -f query='mutation { addPullRequestReviewThread(input: {pullRequestId: "X", body: "y", path: "a", line: 1}) { thread { id } } }'`),
      "graphql",
    );
    assert.equal(find(`gh api graphql -f query='query { repository(owner:"o", name:"r") { pullRequest(number: 5) { id } } }'`), null);
  });
  it("gh pr review --comment/-c → bloqueia; approve passa", () => {
    assert.equal(find(`gh pr review 11285 --comment -b "self-review: 4 findings"`), "pr-review");
    assert.equal(find(`gh pr -R o/r review 5 -c -b x`), "pr-review");
    assert.equal(find(`gh pr review 5 --approve`), null);
    assert.equal(find(`gh pr review 5 --approve --body -correcao`), null);
    assert.equal(find(`gh pr review 5 --approve --body-file -comentarios`), null);
    assert.equal(find(`gh pr review 5 --body -correcao --comment`), "pr-review");
  });
  it("leitura (GET) e outros endpoints → passa", () => {
    assert.equal(find(`gh api repos/o/r/pulls/5/comments`), null);
    assert.equal(find(`gh api --paginate repos/o/r/pulls/5/comments --jq '.[].body'`), null);
    assert.equal(find(`gh api -X GET repos/o/r/pulls/5/comments -f per_page=100`), null);
    assert.equal(find(`gh api repos/o/r/issues/5/comments -f body=x`), null);
    assert.equal(find(`gh api repos/o/r/pulls/5`), null);
    assert.equal(find(`gh pr comment 5 --body-file /tmp/x.md`), null);
  });
  it("o helper e menções em texto → passa", () => {
    assert.equal(find(`npx tsx scripts/gh-pr-review-api.ts comment --pr 5 --path a.ts --line 3 --body-file /tmp/f.md`), null);
    assert.equal(find(`gh issue create --title t --body "não use gh api repos/o/r/pulls/5/comments -f body=x"`), null);
    assert.equal(find(`echo gh api repos/o/r/pulls/5/comments -f body=x`), null);
    assert.equal(find(`cat <<'EOF' > /tmp/corpo.md\ngh api repos/o/r/pulls/5/comments -f body=x\nEOF`), null);
    assert.equal(find(`git commit -m "gh api repos/o/r/pulls/5/comments -f body=x"`), null);
  });
});

describe("shouldBlockRawPrReviewComment — todas as sessões (#11331)", () => {
  const cmd = `gh api repos/o/r/pulls/5/comments -f body=x`;
  it("dev-implementador, dev-fixer e dev-revisor → bloqueia", () => {
    for (const agent_type of ["dev-implementador", "dev-fixer", "dev-revisor"]) {
      assert.equal(shouldBlock({ tool_name: "Bash", agent_type, tool_input: { command: cmd } }), "rest", agent_type);
    }
  });
  it("sem agent_type (coordenador) ou outro agent → bloqueia", () => {
    assert.equal(shouldBlock({ tool_name: "Bash", tool_input: { command: cmd } }), "rest");
    assert.equal(shouldBlock({ tool_name: "Bash", agent_type: "general-purpose", tool_input: { command: cmd } }), "rest");
    assert.equal(shouldBlock({ tool_name: "Edit", agent_type: "dev-fixer", tool_input: { command: cmd } }), null);
  });
});

describe("hook block-raw-pr-review-comment.mjs (processo)", () => {
  const run = (payload: unknown) => spawnSync("node", [HOOK], { input: JSON.stringify(payload), encoding: "utf8" });
  it("nega com o motivo apontando pro helper", () => {
    const r = run({ tool_name: "Bash", agent_type: "dev-implementador", tool_input: { command: `gh api repos/o/r/pulls/5/comments -f body=x` } });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, RAW_PR_REVIEW_COMMENT_BLOCK_REASON);
    assert.match(RAW_PR_REVIEW_COMMENT_BLOCK_REASON, /gh-pr-review-api\.ts comment/);
  });
  it("nega no processo sem metadados de agente (#11331)", () => {
    for (const command of [
      "gh api repos/o/r/pulls/5/comments -f body=x",
      "gh pr review 5 --comment --body x",
      "gh api graphql -f 'query=mutation { addPullRequestReview(input: {}) { clientMutationId } }'",
    ]) {
      const r = run({ tool_name: "Bash", tool_input: { command } });
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
    }
  });
  it("silencioso pra comando legítimo e fail-open em JSON inválido", () => {
    assert.equal(run({ tool_name: "Bash", agent_type: "dev-fixer", tool_input: { command: "gh pr view 5" } }).stdout, "");
    const bad = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, "");
  });
  it("registrado em .claude/settings.json (PreToolUse Bash)", () => {
    const settings = JSON.parse(readFileSync(join(import.meta.dirname, "..", ".claude", "settings.json"), "utf8"));
    const bash = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === "Bash");
    const args = bash.hooks.flatMap((h: { args?: string[] }) => h.args ?? []);
    assert.ok(args.some((a: string) => a.endsWith("block-raw-pr-review-comment.mjs")));
  });
});
