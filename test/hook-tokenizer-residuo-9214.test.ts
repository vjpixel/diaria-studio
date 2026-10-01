/**
 * test/hook-tokenizer-residuo-9214.test.ts (#9214 itens 3 e 5)
 *
 * Item 3: `block-npm-install-node-modules-symlink.mjs` — um PAR de aspas
 * escapadas fora de aspas (`don\'t ... it\'s`) formava um span falso que
 * escondia o `npm ci` entre elas (fail-open).
 *
 * Item 5: gaps antigos do tokenizer compartilhado pelos hooks irmãos —
 * `$((a<<b))` lido como heredoc, continuação de linha (`git \<nl>push`)
 * partida no `\n`, ANSI-C quoting `$'don\'t'` desalinhando o scanner.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error -- hook .mjs sem tipos
import * as A from "../.claude/hooks/block-unsafe-shared-checkout-ops.mjs";
import * as B from "../.claude/hooks/block-worktree-bare-push.mjs";
import * as C from "../.claude/hooks/block-handwritten-pr-checks-loop.mjs";
import * as D from "../.claude/hooks/block-npm-install-node-modules-symlink.mjs";

describe("item 3: aspas escapadas em par no hook de npm (#9214)", () => {
  const inspect = (dir: string) => (dir === "/wt" ? "/principal/node_modules" : null);
  it("npm ci entre duas aspas escapadas é detectado", () => {
    assert.ok(D.findBlockedNpmInstall("echo don\\'t; npm ci; echo it\\'s", "/wt", inspect));
  });
  it("aspas duplas escapadas em par também", () => {
    assert.ok(D.findBlockedNpmInstall('echo \\"a; npm ci; echo b\\"', "/wt", inspect));
  });
  it("continuação de linha não parte o comando", () => {
    assert.ok(D.findBlockedNpmInstall("npm \\\nci", "/wt", inspect));
  });
  it("menção citada segue livre", () => {
    assert.equal(D.findBlockedNpmInstall("git commit -m \"roda npm ci\"", "/wt", inspect), null);
  });
});

const HEREDOC_COPIES = [A, B, C, D] as const;
const QUOTE_COPIES = [A, B, C] as const;

describe("item 5: $((a<<b)) é shift aritmético, não heredoc (#9214)", () => {
  for (const [idx, mod] of HEREDOC_COPIES.entries()) {
    it(`cópia ${idx}: linhas seguintes preservadas`, () => {
      const cmd = "echo $((a<<b))\ngit push origin master\nb";
      assert.equal(mod.stripHeredocSpans(cmd), cmd);
      const cmd2 = "((x = 1<<EOF))\ngit push\nEOF";
      assert.equal(mod.stripHeredocSpans(cmd2), cmd2);
    });
    it(`cópia ${idx}: heredoc real depois de aritmética fechada segue removido`, () => {
      assert.equal(mod.stripHeredocSpans("echo $((1+1)) <<EOF\ngit push\nEOF"), "echo $((1+1)) <<EOF\n");
    });
  }
});

describe("item 5: continuação de linha e ANSI-C quoting (#9214)", () => {
  for (const [idx, mod] of QUOTE_COPIES.entries()) {
    it(`cópia ${idx}: git \\<nl>push vira um comando só`, () => {
      assert.equal(mod.stripQuotedSpans("git \\\npush origin"), "git push origin");
    });
    it(`cópia ${idx}: $'don\\'t' não desalinha o scanner`, () => {
      assert.equal(mod.stripQuotedSpans("echo $'don\\'t'; git push"), "echo ; git push");
    });
  }
});
