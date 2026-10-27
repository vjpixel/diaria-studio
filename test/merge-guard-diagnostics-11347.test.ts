import { it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error -- hook .mjs sem .d.mts (TS7016), mesmo padrão dos demais testes de hooks.
import { classifyMergeBlockCause, buildBlockReason } from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";
import { isGhPrMergeCommand } from "../.claude/hooks/lib/gh-pr-merge-command.mjs";

it("#11347: coordenadora legível com lock próprio tolera registros de peers ilegíveis", () => {
  const ids = new Set(["develop"]);
  assert.equal(classifyMergeBlockCause(ids, "develop", {
    scanDegraded: true, mergeLockHolder: "develop", callerInLinkedWorktree: false,
  }), null);
  for (const mergeLockHolder of [null, undefined, "peer"]) {
    assert.notEqual(classifyMergeBlockCause(ids, "develop", {
      scanDegraded: true, mergeLockHolder,
    }), null);
  }
  assert.notEqual(classifyMergeBlockCause(ids, "develop", {
    scanDegraded: true, mergeLockHolder: "develop", callerInLinkedWorktree: true,
  }), null);
  assert.notEqual(classifyMergeBlockCause(ids, "other", {
    scanDegraded: true, mergeLockHolder: "other",
  }), null);
});

it("#11347: mensagens distinguem I/O de cwd vinculado sem culpar identidade", () => {
  const reason = buildBlockReason({ blockCause: "scan-degraded" });
  assert.match(reason, /varredura.*ilegível/);
  assert.doesNotMatch(reason, /não pertence à sessão coordenadora/);
  assert.match(buildBlockReason({ blockCause: "not-authorized", callerInLinkedWorktree: true }), /payload.cwd/);
});

it("#11347: issue create com merge somente no corpo heredoc continua sendo dado", () => {
  assert.equal(isGhPrMergeCommand("gh issue create --title bug --body-file - <<'EOF'\ngh pr merge 11336 --squash\nEOF", { aliases: new Map() }), false);
});
