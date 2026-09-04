/**
 * test/detect-claude-binary-error.test.ts (#7189)
 *
 * Cobre `scripts/lib/detect-claude-binary-error.ts` — detecção da
 * assinatura de erro "claude native binary not installed" em texto
 * capturado (stdout/stderr/mensagem de erro de subprocesso), item 2 da
 * correção sugerida na issue: reconhecer o texto e nunca deixá-lo se
 * disfarçar de veredito real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_BINARY_ERROR_SIGNATURE,
  containsClaudeBinaryErrorSignature,
  findClaudeBinaryErrorSignature,
} from "../scripts/lib/detect-claude-binary-error.ts";

const REAL_ERROR_TEXT = `Error: claude native binary not installed.

Either postinstall did not run (--ignore-scripts, some pnpm configs)
or the platform-native optional dependency was not downloaded
(--omit=optional).

Run the postinstall manually (adjust path for local vs global install):
  node node_modules/@anthropic-ai/claude-code/install.cjs`;

describe("containsClaudeBinaryErrorSignature", () => {
  it("detecta a assinatura no texto real do erro (#7189)", () => {
    assert.equal(containsClaudeBinaryErrorSignature(REAL_ERROR_TEXT), true);
  });

  it("detecta a assinatura mesmo cercada de outro texto (não precisa ser a mensagem inteira)", () => {
    assert.equal(
      containsClaudeBinaryErrorSignature(`algum log antes\n${CLAUDE_BINARY_ERROR_SIGNATURE}\nalgum log depois`),
      true,
    );
  });

  it("texto normal (sem a assinatura) => false, nunca falso-positivo", () => {
    assert.equal(containsClaudeBinaryErrorSignature("3 check(s) reprovado(s): lint, tests, build"), false);
  });

  it("string vazia => false", () => {
    assert.equal(containsClaudeBinaryErrorSignature(""), false);
  });

  it("null/undefined/não-string => false, nunca lança", () => {
    assert.equal(containsClaudeBinaryErrorSignature(null), false);
    assert.equal(containsClaudeBinaryErrorSignature(undefined), false);
    assert.equal(containsClaudeBinaryErrorSignature(42), false);
    assert.equal(containsClaudeBinaryErrorSignature({ msg: CLAUDE_BINARY_ERROR_SIGNATURE }), false);
  });

  it("substring parcial (não a frase completa) => false", () => {
    assert.equal(containsClaudeBinaryErrorSignature("claude native binary"), false);
  });
});

describe("findClaudeBinaryErrorSignature", () => {
  it("devolve o rótulo da fonte em que a assinatura apareceu (stdout)", () => {
    const label = findClaudeBinaryErrorSignature({
      stdout: REAL_ERROR_TEXT,
      stderr: "",
      "mensagem de erro do spawn": undefined,
    });
    assert.equal(label, "stdout");
  });

  it("devolve o rótulo da fonte em que a assinatura apareceu (stderr, stdout limpo)", () => {
    const label = findClaudeBinaryErrorSignature({
      stdout: '{"statusCheckRollup":[]}',
      stderr: REAL_ERROR_TEXT,
    });
    assert.equal(label, "stderr");
  });

  it("nenhuma fonte contém a assinatura => null", () => {
    const label = findClaudeBinaryErrorSignature({
      stdout: '{"statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}]}',
      stderr: "",
      "mensagem de erro do spawn": undefined,
    });
    assert.equal(label, null);
  });

  it("objeto de fontes vazio => null", () => {
    assert.equal(findClaudeBinaryErrorSignature({}), null);
  });

  it("primeira fonte na ordem de inserção que casa vence, mesmo com múltiplas contendo a assinatura", () => {
    const label = findClaudeBinaryErrorSignature({
      stdout: REAL_ERROR_TEXT,
      stderr: REAL_ERROR_TEXT,
    });
    assert.equal(label, "stdout");
  });
});
