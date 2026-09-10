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

const QUOTED_SPAN_CASES = [
  "",
  "git push",
  "echo 'hello && world'",
  'echo "hello ; world"',
  "rm -f 'a b c'",
  `cd "C:/Users/x/data" && npm ci`,
  "gh pr create --body 'linha && outra; terceira'",
  "printf '%s\\n' 'a' 'b'",
];

const HEREDOC_CASES = [
  "",
  "git push origin master",
  "cat <<EOF\ngit push\nEOF",
  "cat <<'EOF'\nrm -rf /\nEOF",
  "cat <<-EOF\n  git push\n  EOF",
  "gh issue create --body-file - <<'EOF'\nrode git push depois\nEOF\necho done",
  "echo sem heredoc && git push origin main",
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
