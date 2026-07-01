import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveEffort, buildReviewInstruction } from "../.claude/hooks/pr-create-review.mjs";

// #2754: overnight (token-sensitive) usa /code-review low; develop/manual
// (velocidade > tokens) mantém max. Regressão do PR que introduziu essa
// branch-detection — sem isso, todo PR (inclusive overnight/*) volta a pagar
// o custo do review multi-agente max por cima do self-review interno da skill.

describe("resolveEffort (#2754)", () => {
  it("branch overnight/* → low", () => {
    const execFn = () => "overnight/fix-1234\n";
    assert.equal(resolveEffort("https://github.com/o/r/pull/1", execFn), "low");
  });

  it("branch overnight/batch-social-1234 → low (prefixo, não match exato)", () => {
    const execFn = () => "overnight/batch-social-1234\n";
    assert.equal(resolveEffort("https://github.com/o/r/pull/1", execFn), "low");
  });

  it("branch develop/fix-1234 → max", () => {
    const execFn = () => "develop/fix-1234\n";
    assert.equal(resolveEffort("https://github.com/o/r/pull/1", execFn), "max");
  });

  it("branch sem prefixo especial (manual) → max", () => {
    const execFn = () => "fix-something\n";
    assert.equal(resolveEffort("https://github.com/o/r/pull/1", execFn), "max");
  });

  it("gh indisponível/erro → fail-safe max", () => {
    const execFn = () => {
      throw new Error("gh: command not found");
    };
    assert.equal(resolveEffort("https://github.com/o/r/pull/1", execFn), "max");
  });

  it("URL sem número de PR reconhecível → fail-safe max (nem chama execFn)", () => {
    let called = false;
    const execFn = () => {
      called = true;
      return "overnight/fix-1\n";
    };
    assert.equal(resolveEffort("https://github.com/o/r/not-a-pr-url", execFn), "max");
    assert.equal(called, false, "não deveria invocar gh sem número de PR");
  });

  it("branch com substring 'overnight' mas não como prefixo → max (evita false-positive)", () => {
    const execFn = () => "feature/overnight-related-refactor\n";
    assert.equal(resolveEffort("https://github.com/o/r/pull/1", execFn), "max");
  });
});

describe("buildReviewInstruction (#2754)", () => {
  it("effort=low menciona LOW effort e branch overnight", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "low");
    assert.match(msg, /\/code-review low --comment/);
    assert.match(msg, /LOW effort/);
    assert.match(msg, /overnight branch/);
  });

  it("effort=max menciona ULTRACODE / maximum effort", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "max");
    assert.match(msg, /\/code-review max --comment/);
    assert.match(msg, /ULTRACODE/);
  });

  it("nunca sugere cloud ultra, em nenhum effort", () => {
    for (const effort of ["low", "max"]) {
      const msg = buildReviewInstruction("https://github.com/o/r/pull/1", effort);
      assert.match(msg, /Do NOT use cloud `ultra`/);
    }
  });
});
