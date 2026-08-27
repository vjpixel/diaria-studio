/**
 * test/kit-fixture-audit.test.ts (#6336)
 *
 * `auditKitFixtures` é puro (sem rede) — combina a listagem de assinantes
 * com o detector de padrão e separa quem está `active`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditKitFixtures, renderKitFixtureAuditReport } from "../scripts/lib/kit-fixture-audit.ts";

describe("auditKitFixtures (#6336)", () => {
  it("separa fixtures ativos dos demais estados", () => {
    const result = auditKitFixtures([
      { id: 1, email_address: "ana@example.com", state: "active" },
      { id: 2, email_address: "leitor.real@empresa.com.br", state: "active" },
      { id: 3, email_address: "teste-x@gmail.com", state: "cancelled" },
      { id: 4, email_address: "vjpixel+kittest@gmail.com", state: "active" },
    ]);
    assert.equal(result.all.length, 3);
    assert.equal(result.active.length, 2);
    assert.deepEqual(
      result.active.map((f) => f.email).sort(),
      ["ana@example.com", "vjpixel+kittest@gmail.com"],
    );
  });

  it("lista vazia quando nenhum assinante bate padrão de fixture", () => {
    const result = auditKitFixtures([
      { id: 1, email_address: "leitor.real@empresa.com.br", state: "active" },
    ]);
    assert.equal(result.all.length, 0);
    assert.equal(result.active.length, 0);
  });

  it("base vazia não lança", () => {
    const result = auditKitFixtures([]);
    assert.equal(result.all.length, 0);
    assert.equal(result.active.length, 0);
  });
});

describe("renderKitFixtureAuditReport (#6336)", () => {
  it("relatório 'limpo' quando all vazio", () => {
    const text = renderKitFixtureAuditReport({ all: [], active: [] });
    assert.match(text, /Nenhum assinante de fixture/);
  });

  it("relatório lista cada finding com estado e motivo", () => {
    const text = renderKitFixtureAuditReport({
      all: [{ id: 1, email: "ana@example.com", state: "active", reason: "domínio reservado RFC 2606 (example.com) — nunca entrega" }],
      active: [{ id: 1, email: "ana@example.com", state: "active", reason: "domínio reservado RFC 2606 (example.com) — nunca entrega" }],
    });
    assert.match(text, /1 assinante\(s\) de fixture encontrado\(s\) \(1 ATIVO\(s\)\)/);
    assert.match(text, /ATIVO.*ana@example\.com/);
  });
});
