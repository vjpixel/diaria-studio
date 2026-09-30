/**
 * test/hook-command-tokenizer-parity-7896.test.ts (#7896)
 *
 * `block-unsafe-shared-checkout-ops.mjs` e `block-worktree-bare-push.mjs`
 * carregam cópias próprias e independentes de `stripQuotedSpans`/
 * `stripHeredocSpans`/`SEPARATOR_RE` — decisão deliberada de "hooks
 * self-contained não importam um do outro" (ver docblock de
 * `stripHeredocSpans` em `block-worktree-bare-push.mjs`), então NÃO
 * extraímos um módulo compartilhado (extrair contrariaria essa convenção
 * documentada). O risco que a #7896 aponta — divergência silenciosa se só
 * um dos dois for editado — é coberto aqui por um teste de PARIDADE: roda
 * a mesma bateria de comandos contra as duas cópias e falha se alguma
 * divergir. Editar um lado sem o outro quebra este teste, tornando a
 * divergência um erro de CI em vez de um bug silencioso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripQuotedSpans as stripQuotedSpansA, stripHeredocSpans as stripHeredocSpansA } from "../.claude/hooks/block-unsafe-shared-checkout-ops.mjs";
import { stripQuotedSpans as stripQuotedSpansB, stripHeredocSpans as stripHeredocSpansB } from "../.claude/hooks/block-worktree-bare-push.mjs";
import { stripQuotedSpans as stripQuotedSpansC, stripHeredocSpans as stripHeredocSpansC } from "../.claude/hooks/block-handwritten-pr-checks-loop.mjs";
import { stripHeredocSpans as stripHeredocSpansD } from "../.claude/hooks/block-npm-install-node-modules-symlink.mjs";

const QUOTED_SPAN_CASES = [
  "",
  "git push",
  "echo 'hello && world'",
  'echo "hello ; world"',
  "rm -f 'a b c'",
  `cd "C:/Users/x/data" && npm ci`,
  "gh pr create --body 'linha && outra; terceira'",
  "printf '%s\\n' 'a' 'b'",
  // #9197: aspa escapada fora de aspas não abre span.
  "echo don\\'t; git push",
  'echo \\" ; git push',
];

const HEREDOC_CASES = [
  "",
  "git push origin master",
  "cat <<EOF\ngit push\nEOF",
  "cat <<'EOF'\nrm -rf /\nEOF",
  "cat <<-EOF\n  git push\n  EOF",
  "gh issue create --body-file - <<'EOF'\nrode git push depois\nEOF\necho done",
  "echo sem heredoc && git push origin main",
  // #9197: here-string (`<<<`) não é heredoc.
  "cat <<< foo\ngit push\nfoo",
  "cat <<<EOF\ngit push\nEOF",
];

describe("Paridade stripQuotedSpans entre os 2 hooks (#7896)", () => {
  for (const input of QUOTED_SPAN_CASES) {
    it(`casa para: ${JSON.stringify(input)}`, () => {
      assert.equal(stripQuotedSpansA(input), stripQuotedSpansB(input));
    });
  }
});

describe("Paridade stripHeredocSpans entre os 2 hooks (#7896)", () => {
  for (const input of HEREDOC_CASES) {
    it(`casa para: ${JSON.stringify(input)}`, () => {
      assert.equal(stripHeredocSpansA(input), stripHeredocSpansB(input));
    });
  }
});

// #9161: 3ª cópia, em `block-handwritten-pr-checks-loop.mjs`.
describe("Paridade da 3ª cópia (block-handwritten-pr-checks-loop, #9161)", () => {
  for (const input of QUOTED_SPAN_CASES) {
    it(`stripQuotedSpans casa para: ${JSON.stringify(input)}`, () => {
      assert.equal(stripQuotedSpansC(input), stripQuotedSpansB(input));
    });
  }
  for (const input of HEREDOC_CASES) {
    it(`stripHeredocSpans casa para: ${JSON.stringify(input)}`, () => {
      assert.equal(stripHeredocSpansC(input), stripHeredocSpansB(input));
    });
  }
});

// #9197: `block-npm-install-node-modules-symlink.mjs` tem uma 4ª cópia de
// `stripHeredocSpans` (sem `stripQuotedSpans` — usa `splitTopLevel` próprio).
describe("Paridade stripHeredocSpans da 4ª cópia (block-npm-install-node-modules-symlink, #9197)", () => {
  for (const input of HEREDOC_CASES) {
    it(`casa para: ${JSON.stringify(input)}`, () => {
      assert.equal(stripHeredocSpansD(input), stripHeredocSpansB(input));
    });
  }
});
