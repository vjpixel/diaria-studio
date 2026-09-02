/**
 * test/overnight-dispatch-rules-worktree-guard-7089.test.ts (#7089)
 *
 * Trava a presença do item 22 do checklist de dispatch (isolation: worktree
 * recusado alegando metadata git irresolvível — falso-positivo de corrupção
 * quando a causa é contenção do harness, não `.git` danificado). PR doc-only:
 * não há superfície de código executável pra testar aqui (a mudança é prosa
 * de runbook sobre um bug de harness fora deste repo — issue #7089); este
 * guard existe pra não deixar o item ser removido/reescrito em silêncio,
 * mesmo padrão de `test/token-reduction-3453-3454.test.ts` (asserções sobre
 * strings do checklist compartilhado, não comportamento de LLM).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISPATCH_RULES = resolve(ROOT, "context/overnight-dispatch-rules.md");
const rules = readFileSync(DISPATCH_RULES, "utf8");

describe("#7089 — item 22: isolation worktree recusado não é corrupção de .git", () => {
  it("existe como item numerado 22 citando #7089", () => {
    assert.match(
      rules,
      /## 22\. `isolation: worktree` recusado alegando metadata git irresolvível — não é corrupção \(#7089\)/
    );
  });

  it("documenta o discriminador determinístico (rev-parse/worktree list/prune --dry-run)", () => {
    assert.match(rules, /git rev-parse --git-dir/);
    assert.match(rules, /git worktree list/);
    assert.match(rules, /git worktree prune --dry-run -v/);
  });

  it("documenta o contorno manual (worktree add + dispatch sem isolation)", () => {
    assert.match(rules, /git worktree add -b <branch> \.claude\/worktrees\/<nome> origin\/master/);
    assert.match(rules, /dispatchar o subagente\s*\*\*sem\*\* `isolation`/);
  });

  it("proíbe reparo agressivo no checkout compartilhado por causa desse erro", () => {
    assert.match(rules, /não rodar `git worktree prune` nem qualquer reparo\s*\nagressivo/);
  });
});
