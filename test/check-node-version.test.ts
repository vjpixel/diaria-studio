/**
 * check-node-version.test.ts (#4823)
 *
 * Testa `checkNodeVersion`/`assertSupportedNodeVersion` com a versão
 * INJETADA via parâmetro — nunca depende de `process.version` real da
 * máquina que roda os testes (mesmo padrão de `detectExecMode`/`test/exec-mode.test.ts`
 * com fs mockado). Isso é o que torna o teste determinístico rodando em
 * QUALQUER Node — inclusive o Node <22.5 que o próprio guard rejeitaria se
 * fosse checado ao vivo.
 *
 * Regressão coberta (#4823): Node <22.5 → mensagem clara nomeando o
 * requisito real (`node:sqlite`, `.nvmrc`, versão do CI) em vez do erro
 * nativo opaco `ERR_UNKNOWN_BUILTIN_MODULE`; Node >=22.5 → passa em
 * silêncio (`ok: true`, sem `message`, sem lançar).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkNodeVersion,
  assertSupportedNodeVersion,
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
} from "../scripts/lib/check-node-version.ts";

describe("checkNodeVersion", () => {
  it("Node abaixo do mínimo (20.20.2, o achado ao vivo do #4823) → ok:false com mensagem clara", () => {
    const result = checkNodeVersion("v20.20.2");
    assert.equal(result.ok, false);
    assert.ok(result.message, "esperava mensagem explicando o requisito");
    assert.match(result.message!, /v20\.20\.2/);
    assert.match(result.message!, /node:sqlite/);
    assert.match(result.message!, /\.nvmrc/);
  });

  it("major menor que o mínimo, mas minor alto (21.99.0) → ainda ok:false", () => {
    const result = checkNodeVersion("v21.99.0");
    assert.equal(result.ok, false);
  });

  it(`major igual ao mínimo (${MIN_NODE_MAJOR}), minor abaixo do mínimo (${MIN_NODE_MAJOR}.0.0) → ok:false`, () => {
    const result = checkNodeVersion(`v${MIN_NODE_MAJOR}.0.0`);
    assert.equal(result.ok, false);
  });

  it(`major igual ao mínimo, minor exatamente no limiar (${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0) → ok:true, sem message`, () => {
    const result = checkNodeVersion(`v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`);
    assert.equal(result.ok, true);
    assert.equal(result.message, undefined);
  });

  it("Node 24 (versão do CI e do .nvmrc) → ok:true", () => {
    const result = checkNodeVersion("v24.0.0");
    assert.equal(result.ok, true);
    assert.equal(result.message, undefined);
  });

  it("major maior que o mínimo, minor irrelevante (23.0.0) → ok:true", () => {
    const result = checkNodeVersion("v23.0.0");
    assert.equal(result.ok, true);
  });

  it("aceita versão sem o 'v' inicial (formato alternativo)", () => {
    const result = checkNodeVersion("24.1.0");
    assert.equal(result.ok, true);
  });

  it("formato inesperado (input malformado) → fail-soft, ok:true", () => {
    const result = checkNodeVersion("not-a-version");
    assert.equal(result.ok, true);
  });

  it("sem argumento, usa process.version real — não lança", () => {
    const result = checkNodeVersion();
    assert.ok(typeof result.ok === "boolean");
  });
});

describe("assertSupportedNodeVersion", () => {
  it("Node <22.5 → lança Error com a mesma mensagem clara", () => {
    assert.throws(
      () => assertSupportedNodeVersion("v20.20.2"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /v20\.20\.2/);
        assert.match(err.message, /node:sqlite/);
        return true;
      },
    );
  });

  it("Node >=22.5 → passa silenciosamente, não lança", () => {
    assert.doesNotThrow(() => assertSupportedNodeVersion("v24.0.0"));
  });
});
