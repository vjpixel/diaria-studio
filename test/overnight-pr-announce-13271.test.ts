import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rules = readFileSync("context/overnight-dispatch-rules.md", "utf8");

it("implementador anuncia a PR por SendMessage antes do self-review (#13271)", () => {
  const i = rules.indexOf("**Anúncio de PR (overnight, develop e continuo; #13271):**");
  assert.ok(i >= 0);
  const block = rules.slice(i, i + 600);
  assert.match(block, /SendMessage/);
  assert.match(block, /antes de iniciar o self-review/);
  assert.match(block, /em\s+paralelo/);
});

it("o anúncio fica na seção 2, antes do bootstrap do worktree (#13271)", () => {
  assert.ok(rules.indexOf("**Anúncio de PR (overnight, develop e continuo; #13271):**") < rules.indexOf("## 3. Bootstrap do worktree"));
});
