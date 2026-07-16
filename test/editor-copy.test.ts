import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureEditorCopyRow, EDITOR_COPY_EMAIL } from "../scripts/lib/editor-copy.ts";

describe("ensureEditorCopyRow (#3455)", () => {
  it("adiciona uma linha com EDITOR_COPY_EMAIL ao CSV normalizado", () => {
    const csv = "EMAIL,NOME\na@x.com,Ana\nb@x.com,Bia\n";
    const out = ensureEditorCopyRow(csv);
    assert.ok(out.includes(EDITOR_COPY_EMAIL), `deveria conter ${EDITOR_COPY_EMAIL}: ${out}`);
    // 2 contatos reais + 1 editor = 3 linhas de dados
    const rows = out.trim().split("\n");
    assert.equal(rows.length, 4, `header + 3 linhas de dados: ${out}`);
  });

  it("idempotente: não duplica se o editor já está no CSV", () => {
    const csv = `EMAIL,NOME\na@x.com,Ana\n${EDITOR_COPY_EMAIL},Pixel\n`;
    const out = ensureEditorCopyRow(csv);
    const occurrences = out.split(EDITOR_COPY_EMAIL).length - 1;
    assert.equal(occurrences, 1, `email do editor não deve duplicar: ${out}`);
  });

  it("dedupe é case-insensitive", () => {
    const csv = "EMAIL,NOME\nVJPixel@Gmail.com,Pixel\n";
    const out = ensureEditorCopyRow(csv);
    const occurrences = (out.match(/vjpixel@gmail\.com/gi) ?? []).length;
    assert.equal(occurrences, 1, `case diferente ainda deve deduplicar: ${out}`);
  });

  it("preserva colunas extras (waves store-driven), preenchendo com vazio", () => {
    const csv = "EMAIL,NOME,OPEN_PROBABILITY,RECENCY_QUARTIL\na@x.com,Ana,24,Q1\n";
    const out = ensureEditorCopyRow(csv);
    assert.ok(out.startsWith("EMAIL,NOME,OPEN_PROBABILITY,RECENCY_QUARTIL"));
    const lines = out.trim().split("\n");
    const editorLine = lines.find((l) => l.includes(EDITOR_COPY_EMAIL));
    assert.ok(editorLine, `linha do editor deve existir: ${out}`);
    assert.equal(editorLine, `${EDITOR_COPY_EMAIL},Pixel (editor),,`);
  });

  it("sem coluna EMAIL reconhecível → retorna CSV inalterado (fail-soft)", () => {
    const csv = "nome,sobrenome\nA,B\n";
    assert.equal(ensureEditorCopyRow(csv), csv);
  });

  it("aceita editorEmail customizado (não hardcoded pro call-site)", () => {
    const csv = "EMAIL,NOME\na@x.com,Ana\n";
    const out = ensureEditorCopyRow(csv, "outro@exemplo.com");
    assert.ok(out.includes("outro@exemplo.com"));
    assert.ok(!out.includes(EDITOR_COPY_EMAIL));
  });
});
