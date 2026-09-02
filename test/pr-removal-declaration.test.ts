/**
 * test/pr-removal-declaration.test.ts (#7115)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRemovalDeclaration,
  hasRemovalDeclaration,
  missingRemovalDeclarationMessage,
  needsRemovalDeclaration,
  REMOVAL_DECLARATION_ADDED_LINES_THRESHOLD,
} from "../scripts/lib/pr-removal-declaration.ts";

describe("hasRemovalDeclaration", () => {
  it("reconhece o marcador com conteúdo suficiente", () => {
    assert.equal(hasRemovalDeclaration("removal-declaration: removi o script X que ficou órfão"), true);
  });

  it("é case-insensitive e aceita em qualquer lugar do body", () => {
    assert.equal(hasRemovalDeclaration("blah blah\n\nREMOVAL-DECLARATION: feature nova, nada a remover ainda"), true);
  });

  it("recusa marcador com conteúdo curto demais (<10 chars)", () => {
    assert.equal(hasRemovalDeclaration("removal-declaration: no"), false);
  });

  it("recusa body sem o marcador", () => {
    assert.equal(hasRemovalDeclaration("Closes #123\n\nAlguma descrição qualquer."), false);
  });
});

describe("needsRemovalDeclaration", () => {
  it("exige acima do limiar, não exige no limiar exato", () => {
    assert.equal(needsRemovalDeclaration(REMOVAL_DECLARATION_ADDED_LINES_THRESHOLD), false);
    assert.equal(needsRemovalDeclaration(REMOVAL_DECLARATION_ADDED_LINES_THRESHOLD + 1), true);
  });

  it("limiar customizado é respeitado", () => {
    assert.equal(needsRemovalDeclaration(50, 100), false);
    assert.equal(needsRemovalDeclaration(150, 100), true);
  });
});

describe("evaluateRemovalDeclaration", () => {
  it("not-required abaixo do limiar, independente do body", () => {
    const result = evaluateRemovalDeclaration({ files: 2, added: 100, removed: 5 }, "");
    assert.equal(result.status, "not-required");
    assert.equal(result.addedLines, 100);
  });

  it("ok acima do limiar com marcador presente", () => {
    const result = evaluateRemovalDeclaration(
      { files: 10, added: 1000, removed: 5 },
      "removal-declaration: feature nova, sem remoção correspondente",
    );
    assert.equal(result.status, "ok");
  });

  it("missing acima do limiar sem marcador", () => {
    const result = evaluateRemovalDeclaration({ files: 10, added: 1000, removed: 5 }, "Closes #1");
    assert.equal(result.status, "missing");
    assert.equal(result.ratio, 200);
  });

  it("ratio null quando removed é 0", () => {
    const result = evaluateRemovalDeclaration({ files: 1, added: 600, removed: 0 }, "");
    assert.equal(result.ratio, null);
  });
});

describe("missingRemovalDeclarationMessage", () => {
  it("cita linhas adicionadas, limiar e o exemplo do marcador", () => {
    const msg = missingRemovalDeclarationMessage({
      status: "missing",
      addedLines: 900,
      removedLines: 10,
      ratio: 90,
      threshold: 500,
    });
    assert.match(msg, /900/);
    assert.match(msg, /500/);
    assert.match(msg, /removal-declaration:/);
  });
});
