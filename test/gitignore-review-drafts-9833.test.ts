/**
 * test/gitignore-review-drafts-9833.test.ts (#9833)
 *
 * Regressão: rascunhos de comentário de review (`.rev9801.md`, `.review-i1.md`)
 * gravados na raiz do checkout compartilhado foram empacotados pelo
 * `rescue-continuo-orphaned-work.ts` (`git add -A`) na PR espúria #9806.
 * Testa COMPORTAMENTO via `git check-ignore` (ver #6691: regra inerte passa em grep).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isIgnored(relPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", relPath], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("#9833 — rascunhos de review na raiz não entram no rescue", () => {
  for (const p of [".rev9801.md", ".rev9802.md", ".rev9803.md", ".review-i1.md"]) {
    it(`ignora ${p}`, () => assert.equal(isIgnored(p), true));
  }
  it("não ignora docs legítimos", () => {
    for (const p of ["README.md", "docs/review.md", "docs/.rev1.md"]) {
      assert.equal(isIgnored(p), false, `${p} não deveria ser ignorado`);
    }
  });
  it("o reviewer é instruído a gravar o rascunho fora do checkout", () => {
    const hook = readFileSync(resolve(repoRoot, ".claude/hooks/pr-create-review.mjs"), "utf8");
    assert.match(hook, /OUTSIDE the checkout[\s\S]{0,200}#9833/);
    const agent = readFileSync(resolve(repoRoot, ".claude/agents/dev-revisor.md"), "utf8");
    assert.match(agent, /FORA do checkout/);
  });
});
