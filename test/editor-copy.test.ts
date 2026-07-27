import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureEditorCopyRow, EDITOR_COPY_EMAIL, EDITOR_SEED_EMAILS } from "../scripts/lib/editor-copy.ts";

describe("ensureEditorCopyRow (#3455)", () => {
  it("adiciona uma linha com EDITOR_COPY_EMAIL ao CSV normalizado", () => {
    const csv = "EMAIL,NOME\na@x.com,Ana\nb@x.com,Bia\n";
    const out = ensureEditorCopyRow(csv);
    assert.ok(out.includes(EDITOR_COPY_EMAIL), `deveria conter ${EDITOR_COPY_EMAIL}: ${out}`);
    // #4045: 2 contatos reais + N seeds (default = EDITOR_SEED_EMAILS)
    const rows = out.trim().split("\n");
    assert.equal(rows.length, 1 + 2 + EDITOR_SEED_EMAILS.length, `header + 2 contatos + seeds: ${out}`);
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

describe("EDITOR_SEED_EMAILS (#4045 — seed inbox de colocação)", () => {
  it("BUG ORIGINAL: só o Gmail pessoal recebia cópia, então colocação em outro provedor era invisível", () => {
    const csv = "EMAIL,NOME\na@x.com,Ana\n";
    const out = ensureEditorCopyRow(csv);
    for (const seed of EDITOR_SEED_EMAILS) {
      assert.ok(out.toLowerCase().includes(seed.toLowerCase()), `seed ausente do CSV: ${seed}\n${out}`);
    }
  });

  it("cobre os provedores que pesam na base: Gmail, Google Workspace, Microsoft e Yahoo", () => {
    const dominios = EDITOR_SEED_EMAILS.map((e) => e.split("@")[1].toLowerCase());
    for (const d of ["gmail.com", "memelab.com.br", "hotmail.com", "yahoo.com"]) {
      assert.ok(dominios.includes(d), `faltou cobertura de ${d}: ${dominios.join(", ")}`);
    }
  });

  it("EDITOR_COPY_EMAIL continua sendo o primeiro seed (cópia QA canônica)", () => {
    assert.equal(EDITOR_SEED_EMAILS[0], EDITOR_COPY_EMAIL);
  });

  it("seeds não duplicam: aplicar 2× é idempotente", () => {
    const csv = "EMAIL,NOME\na@x.com,Ana\n";
    const once = ensureEditorCopyRow(csv);
    assert.equal(ensureEditorCopyRow(once), once, `2ª aplicação não deve adicionar linha:\n${once}`);
  });

  it("seed já presente no CSV de origem não vira linha duplicada", () => {
    const csv = `EMAIL,NOME\na@x.com,Ana\npixel@memelab.com.br,Pixel\n`;
    const out = ensureEditorCopyRow(csv);
    assert.equal((out.match(/pixel@memelab\.com\.br/gi) ?? []).length, 1, `seed não deve duplicar: ${out}`);
  });

  it("nenhum seed repetido na constante (dois endereços iguais medem a mesma caixa)", () => {
    const lower = EDITOR_SEED_EMAILS.map((e) => e.toLowerCase());
    assert.equal(new Set(lower).size, lower.length, `seeds duplicados: ${lower.join(", ")}`);
  });
});
