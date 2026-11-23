/**
 * test/dev-fixer-removal-declaration-13872.test.ts (#13872)
 * As regras lidas pelo dev-fixer devem mandar checar o tamanho do diff e a
 * linha removal-declaration: antes do re-push.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("dev-fixer removal-declaration (#13872)", () => {
  const rules = readFileSync("context/overnight-dispatch-rules.md", "utf8");
  const fixer = readFileSync(".claude/agents/dev-fixer.md", "utf8");
  it("dev-fixer manda ler as regras de dispatch", () => {
    assert.match(fixer, /context\/overnight-dispatch-rules\.md/);
  });
  it("regra do fixer confere o diff e exige removal-declaration acima de 500", () => {
    const i = rules.indexOf("Fixer e re-push (#13872)");
    assert.ok(i > 0);
    const sec = rules.slice(i, i + 700);
    assert.match(sec, /git diff --shortstat origin\/master\.\.\.HEAD/);
    assert.match(sec, /500/);
    assert.match(sec, /removal-declaration:/);
  });
});
