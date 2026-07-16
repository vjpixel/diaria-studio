/**
 * test/studio-review-text-diff.test.ts (#3559)
 *
 * Diff de linhas PURO (`scripts/studio-ui/text-diff.ts`) — usado pelo painel
 * de revisão de conteúdo pra mostrar "o que o editor mudou vs. a versão
 * gerada pelo agente".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffLines, diffIsEmpty } from "../scripts/studio-ui/text-diff.ts";

describe("text-diff (#3559)", () => {
  it("conteúdo idêntico → tudo 'equal', diffIsEmpty true", () => {
    const text = "linha 1\nlinha 2\nlinha 3";
    const lines = diffLines(text, text);
    assert.ok(lines.every((l) => l.type === "equal"));
    assert.equal(diffIsEmpty(lines), true);
  });

  it("detecta 1 linha adicionada", () => {
    const baseline = "a\nb\nc";
    const current = "a\nb\nNOVA\nc";
    const lines = diffLines(baseline, current);
    assert.equal(diffIsEmpty(lines), false);
    const added = lines.filter((l) => l.type === "add");
    assert.equal(added.length, 1);
    assert.equal(added[0].text, "NOVA");
    assert.equal(added[0].baselineLine, null);
  });

  it("detecta 1 linha removida", () => {
    const baseline = "a\nb\nREMOVIDA\nc";
    const current = "a\nb\nc";
    const lines = diffLines(baseline, current);
    const removed = lines.filter((l) => l.type === "del");
    assert.equal(removed.length, 1);
    assert.equal(removed[0].text, "REMOVIDA");
    assert.equal(removed[0].currentLine, null);
  });

  it("detecta substituição de linha (del + add)", () => {
    const baseline = "a\nb\nc";
    const current = "a\nB-EDITADO\nc";
    const lines = diffLines(baseline, current);
    assert.equal(lines.filter((l) => l.type === "del").length, 1);
    assert.equal(lines.filter((l) => l.type === "add").length, 1);
    assert.equal(lines.filter((l) => l.type === "equal").length, 2);
  });

  it("baseline vazio vs. conteúdo novo → tudo 'add', sem linha vazia espúria", () => {
    const lines = diffLines("", "a\nb");
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.type === "add"));
  });

  it("conteúdo vazio vs. baseline com texto → tudo 'del'", () => {
    const lines = diffLines("a\nb", "");
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.type === "del"));
  });

  it("dois vazios → diff vazio, diffIsEmpty true", () => {
    const lines = diffLines("", "");
    assert.deepEqual(lines, []);
    assert.equal(diffIsEmpty(lines), true);
  });
});
