import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error -- hook .mjs sem .d.mts (mesma situação, já na baseline, de block-gh-pr-merge-subagent-hook.test.ts)
import { buildBlockReason, isGhPrMergeCommand } from '../.claude/hooks/block-gh-pr-merge-subagent.mjs';

const threads = `for n in 42 43; do
  gh api graphql -f query="{ repository(owner: \"o\", name: \"r\") { pullRequest(number: $n) { reviewThreads(first: 100) { nodes { id } } } } }"
  for t in PRRT_x; do
    gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"$t\"}) { thread { isResolved } } }"
  done
done`;

describe('#10926 GraphQL de threads com interpolação do shell', () => {
  it('preserva fail-closed e explica a opacidade sem recomendar registro ou merge', () => {
    assert.equal(isGhPrMergeCommand(threads), true);
    const reason = buildBlockReason({ command: threads, blockCause: 'not-authorized' });
    assert.match(reason, /^gh api graphql bloqueado/);
    assert.match(reason, /não pode ser inspecionada estaticamente/);
    assert.match(reason, /variáveis GraphQL via -f\/-F/);
    assert.doesNotMatch(reason, /register|grant-merge|merge-lock-acquire/);
  });

  it('permite as mesmas operações com query literal e variáveis GraphQL', () => {
    const command = `for n in 42 43; do
      gh api graphql -f query='query($n: Int!) { repository(owner: "o", name: "r") { pullRequest(number: $n) { reviewThreads(first: 100) { nodes { id } } } } }' -F n="$n"
      for t in PRRT_x; do
        gh api graphql -f query='mutation($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { isResolved } } }' -f t="$t"
      done
    done`;
    assert.equal(isGhPrMergeCommand(command), false);
  });

  it('preserva diagnóstico de merge real em comando misto', () => {
    const reason = buildBlockReason({ command: `${threads}; gh pr merge 42` });
    assert.match(reason, /^gh pr merge bloqueado/);
  });
});
