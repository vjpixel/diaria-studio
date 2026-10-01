/**
 * test/hook-tokenizer-parity-9318.test.ts (#9318)
 *
 * O #9214 corrigiu continuação de linha e `$'...'` em só 3 das 9 cópias de
 * `stripQuotedSpans`. Agora todas reexportam `.claude/hooks/lib/shell-quote-strip.mjs`;
 * este teste trava a paridade em TODOS os hooks e os cenários concretos do issue.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error -- hooks .mjs sem tipos
import * as consumeGrant from "../.claude/hooks/consume-merge-grant-on-merge.mjs";
// @ts-expect-error -- hooks .mjs sem tipos
import * as mergeSubagent from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";
// @ts-expect-error -- hooks .mjs sem tipos
import * as checkoutMain from "../.claude/hooks/block-branch-checkout-main.mjs";
// @ts-expect-error -- hooks .mjs sem tipos
import * as alienCommit from "../.claude/hooks/block-worktree-alien-commit.mjs";
// @ts-expect-error -- hooks .mjs sem tipos
import * as pii from "../.claude/hooks/block-pr-create-pii-runtime-artifacts.mjs";
// @ts-expect-error -- hooks .mjs sem tipos
import * as prReview from "../.claude/hooks/pr-create-review.mjs";
// @ts-expect-error -- hooks .mjs sem tipos
import * as unsafeCheckout from "../.claude/hooks/block-unsafe-shared-checkout-ops.mjs";
import * as barePush from "../.claude/hooks/block-worktree-bare-push.mjs";
import * as checksLoop from "../.claude/hooks/block-handwritten-pr-checks-loop.mjs";
import * as npmGuard from "../.claude/hooks/block-npm-install-node-modules-symlink.mjs";
import { stripQuotedSpans as shared } from "../.claude/hooks/lib/shell-quote-strip.mjs";

const HOOKS = {
  "consume-merge-grant-on-merge": consumeGrant,
  "block-gh-pr-merge-subagent": mergeSubagent,
  "block-branch-checkout-main": checkoutMain,
  "block-worktree-alien-commit": alienCommit,
  "block-pr-create-pii-runtime-artifacts": pii,
  "pr-create-review": prReview,
  "block-unsafe-shared-checkout-ops": unsafeCheckout,
  "block-worktree-bare-push": barePush,
  "block-handwritten-pr-checks-loop": checksLoop,
} as Record<string, { stripQuotedSpans: (s: string) => string }>;

describe("stripQuotedSpans: todos os hooks usam o tokenizer compartilhado (#9318)", () => {
  for (const [name, mod] of Object.entries(HOOKS)) {
    it(`${name}: é a mesma função da lib`, () => {
      assert.equal(mod.stripQuotedSpans, shared);
    });
    it(`${name}: sem cópia local do scanner`, () => {
      const src = readFileSync(`.claude/hooks/${name}.mjs`, "utf8");
      assert.ok(!/function stripQuotedSpans\s*\(/.test(src));
    });
  }
  it("continuação de linha e ANSI-C", () => {
    assert.equal(shared("gh pr merge \\\n123 --squash"), "gh pr merge 123 --squash");
    assert.equal(shared("echo $'it\\'s'; git push"), "echo ; git push");
  });
});

describe("cenário do issue: gh pr merge \\<nl>123 (#9318)", () => {
  it("consume-merge-grant extrai o PR alvo", () => {
    assert.equal(String(consumeGrant.extractGhPrMergeTargetPr("gh pr merge \\\n123 --squash")), "123");
  });
});

describe("npm guard: $'...' não mascara npm ci (#9318)", () => {
  const inspect = (dir: string) => (dir === "/wt" ? "/principal/node_modules" : null);
  it("echo $'it\\'s'; npm ci; echo 'x' é detectado", () => {
    assert.ok(npmGuard.findBlockedNpmInstall("echo $'it\\'s'; npm ci; echo 'x'", "/wt", inspect));
  });
  it("npm ci citado dentro de $'...' segue livre", () => {
    assert.equal(npmGuard.findBlockedNpmInstall("echo $'roda; npm ci'", "/wt", inspect), null);
  });
});
