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

  it("registro malformado (email_address ausente/não-string) não lança — pula e reporta em skipped (#6383 F3)", () => {
    const result = auditKitFixtures([
      { id: 1, email_address: "ana@example.com", state: "active" },
      // Simula shape inesperado da API do Kit (#6181) — sem type-cast forçado
      // pra provar que o guard é em runtime, não só em compile-time.
      { id: 2, email_address: undefined, state: "active" } as unknown as {
        id: number;
        email_address: string;
        state: string;
      },
      { id: 3, state: "active" } as unknown as {
        id: number;
        email_address: string;
        state: string;
      },
    ]);
    assert.equal(result.active.length, 1);
    assert.equal(result.skipped?.length, 2);
    assert.deepEqual(
      result.skipped?.map((s) => s.id),
      [2, 3],
    );
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
