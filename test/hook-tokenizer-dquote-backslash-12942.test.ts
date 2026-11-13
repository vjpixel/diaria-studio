/**
 * test/hook-tokenizer-dquote-backslash-12942.test.ts (#12942)
 *
 * A #12544 corrigiu a regra da `\` entre aspas duplas só em
 * `block-branch-checkout-main`: o bash descarta a barra apenas antes de `$`,
 * crase, `"`, `\` e newline; antes de outro caractere ela fica. A auditoria
 * da #12942 passou por todas as cópias de tokenizer dos hooks que extraem o
 * VALOR de uma palavra citada (as que só acham o fim do span, como
 * `stripQuotedSpans`, não mudam valor nenhum) e travou a regra em cada uma:
 *
 * - corrigidos aqui: `block-npm-install-node-modules-symlink` (payload de
 *   `bash -c "..."` perdia a barra), `block-unsafe-shared-checkout-ops`
 *   (`\"` fechava a aspa cedo) e `block-continuo-master-commit` (`\"` e `\$`
 *   ficavam com a barra);
 * - já corretos, travados para não regredir: `block-branch-checkout-main`,
 *   `lib/gh-target-repo`, `lib/gh-pr-merge-command` e
 *   `scripts/lib/protected-path-bash-write`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error -- hooks .mjs sem tipos
import * as branchCheckout from "../.claude/hooks/block-branch-checkout-main.mjs";
import * as ghTarget from "../.claude/hooks/lib/gh-target-repo.mjs";
import * as protectedPath from "../scripts/lib/protected-path-bash-write.mjs";
import * as mergeCommand from "../.claude/hooks/lib/gh-pr-merge-command.mjs";
import * as continuoCommit from "../.claude/hooks/block-continuo-master-commit.mjs";
// @ts-expect-error -- hooks .mjs sem tipos
import * as unsafeCheckout from "../.claude/hooks/block-unsafe-shared-checkout-ops.mjs";
import * as npmGuard from "../.claude/hooks/block-npm-install-node-modules-symlink.mjs";

// `cd "C:\Users\x\wt"` (path do Git Bash no Windows) + `\"` dentro de aspas.
const COMMAND = 'cd "C:\\Users\\x\\wt" && git -C "a\\"b" commit';
const EXPECTED = [
  ["cd", "C:\\Users\\x\\wt"],
  ["git", "-C", 'a"b', "commit"],
];

describe("tokenizers dos hooks: \\ entre aspas duplas segue o bash (#12942)", () => {
  it("block-branch-checkout-main (corrigido na #12544)", () => {
    const segs = (branchCheckout.tokenizeShellSegments(COMMAND) as { value: string }[][]).map((s) =>
      s.map((t) => t.value),
    );
    assert.deepEqual(segs, EXPECTED);
  });

  it("lib/gh-target-repo splitShellWords", () => {
    assert.deepEqual(ghTarget.splitShellWords(COMMAND), [...EXPECTED[0], "&&", ...EXPECTED[1]]);
  });

  it("scripts/lib/protected-path-bash-write tokenizeShell", () => {
    const cmds = (protectedPath.tokenizeShell(COMMAND) as { words: string[] }[]).map((c) => c.words);
    assert.deepEqual(cmds, EXPECTED);
  });

  it("lib/gh-pr-merge-command parseShellCommands", () => {
    assert.deepEqual(mergeCommand.parseShellCommands(COMMAND), EXPECTED);
  });

  it("block-continuo-master-commit tokenize: \\\" vira aspa, barra de path fica", () => {
    assert.deepEqual(continuoCommit.tokenize(COMMAND), EXPECTED);
    assert.deepEqual(continuoCommit.tokenize('git commit -m "custa \\$5"'), [["git", "commit", "-m", "custa $5"]]);
  });

  it("block-unsafe-shared-checkout-ops: cd com path Windows e rm com \\\" no alvo", () => {
    const [hit] = unsafeCheckout.extractRmTargetsWithCwd('cd "C:\\Users\\x\\wt" && rm "a\\"b c"', "/s") as {
      path: string;
      cwd: string;
    }[];
    assert.equal(hit.path, 'a"b c', "\\\" não fecha a aspa nem deixa a barra no alvo");
    assert.match(hit.cwd, /C:\\Users\\x\\wt$/, "barra do path Windows preservada");
  });

  it("block-npm-install-node-modules-symlink: payload de bash -c mantém a barra de path", () => {
    assert.equal(
      npmGuard.shellWrapperPayload('bash -c "cd C:\\wt && echo \\"x\\" && npm ci"'),
      'cd C:\\wt && echo "x" && npm ci',
    );
  });
});
