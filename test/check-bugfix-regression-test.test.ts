/**
 * test/check-bugfix-regression-test.test.ts (#970)
 *
 * Cobre helpers puros do guard CI #970. Não testa main() (depende de gh CLI
 * + git diff externos — testado via integração no GH Action real).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isBugfixPr,
  hasExceptionLabel,
  hasNewOrModifiedTest,
  justificationInBody,
} from "../scripts/check-bugfix-regression-test.ts";

describe("isBugfixPr (#970)", () => {
  it("detecta label `bug`", () => {
    assert.equal(isBugfixPr("any title", "", ["bug", "P2"]), true);
  });

  it("detecta título 'fix:'", () => {
    assert.equal(isBugfixPr("fix: drive-sync conflict", "", []), true);
    assert.equal(isBugfixPr("fix(stage-2): null check", "", []), true);
  });

  it("detecta keywords no título (bugfix, hotfix)", () => {
    assert.equal(isBugfixPr("hotfix LinkedIn cron", "", []), true);
    assert.equal(isBugfixPr("bugfix: missing url field", "", []), true);
  });

  it("não detecta PR de feature/refactor", () => {
    assert.equal(isBugfixPr("feat: nova funcionalidade", "", ["enhancement"]), false);
    assert.equal(isBugfixPr("refactor: split helper", "", []), false);
    assert.equal(isBugfixPr("docs: update README", "", ["documentation"]), false);
  });
});

describe("hasExceptionLabel (#970)", () => {
  it("detecta no-regression-test", () => {
    assert.equal(hasExceptionLabel(["bug", "no-regression-test"]), true);
  });

  it("retorna false sem label", () => {
    assert.equal(hasExceptionLabel(["bug", "P2"]), false);
  });
});

describe("hasNewOrModifiedTest (#970)", () => {
  it("detecta arquivo em test/", () => {
    assert.equal(hasNewOrModifiedTest(["test/foo.test.ts"]), true);
    assert.equal(hasNewOrModifiedTest(["test/lib/bar.test.ts"]), true);
  });

  it("detecta arquivo em tests/", () => {
    assert.equal(hasNewOrModifiedTest(["tests/integration.test.ts"]), true);
  });

  it("ignora arquivos fora de test/", () => {
    assert.equal(hasNewOrModifiedTest(["scripts/foo.ts"]), false);
    assert.equal(hasNewOrModifiedTest(["docs/test.md"]), false);
    assert.equal(hasNewOrModifiedTest(["test-data/sample.json"]), false);
  });

  it("ignora .ts não-.test.ts", () => {
    assert.equal(hasNewOrModifiedTest(["test/_helpers/utils.ts"]), false);
  });

  it("aceita .test.js", () => {
    assert.equal(hasNewOrModifiedTest(["test/legacy.test.js"]), true);
  });

  it("retorna false em diff vazio", () => {
    assert.equal(hasNewOrModifiedTest([]), false);
  });
});

describe("justificationInBody (#970)", () => {
  it("aceita justificativa com 30+ chars", () => {
    const body = `## Summary\n\nFix.\n\nno-regression-test: agent prompt change, sem teste TS unitário possível.`;
    assert.equal(justificationInBody(body), true);
  });

  it("rejeita label sem justificativa", () => {
    const body = `## Summary\n\nFix.`;
    assert.equal(justificationInBody(body), false);
  });

  it("rejeita justificativa curta (<30 chars)", () => {
    const body = `no-regression-test: skip`;
    assert.equal(justificationInBody(body), false);
  });

  it("aceita variantes de capitalização", () => {
    const body = `No-Regression-Test agent prompt change não pode ser testado em TS unitário.`;
    assert.equal(justificationInBody(body), true);
  });
});
