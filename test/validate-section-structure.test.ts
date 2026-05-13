/**
 * test/validate-section-structure.test.ts (#1205)
 *
 * Cobre regressão do title-picker que corrompeu estrutura de 02-reviewed.md
 * em 260517: removeu `---` entre OUTRAS NOTÍCIAS e SORTEIO + moveu ERRO
 * INTENCIONAL pro final.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractStructure, diffStructure } from "../scripts/validate-section-structure.ts";

const CANONICAL_MD = [
  "Cobertura.",
  "",
  "---",
  "",
  "**DESTAQUE 1 | BRASIL**",
  "Título D1",
  "",
  "Corpo D1.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | TENDÊNCIA**",
  "Título D2",
  "",
  "Corpo D2.",
  "",
  "---",
  "",
  "**É IA?**",
  "",
  "Crédito.",
  "",
  "---",
  "",
  "**DESTAQUE 3 | FERRAMENTA**",
  "Título D3",
  "",
  "Corpo D3.",
  "",
  "---",
  "",
  "**LANÇAMENTOS**",
  "**[Item](https://x.com)**",
  "Desc.",
  "",
  "---",
  "",
  "**OUTRAS NOTÍCIAS**",
  "**[Notícia](https://y.com)**",
  "Desc.",
  "",
  "---",
  "",
  "**ERRO INTENCIONAL**",
  "Reveal.",
  "",
  "---",
  "",
  "**🎁 SORTEIO**",
  "Body sorteio.",
  "",
  "---",
  "",
  "**🙋🏼‍♀️ PARA ENCERRAR**",
  "Body encerrar.",
].join("\n");

describe("extractStructure (#1205)", () => {
  it("extrai todos os headers + separadores canônicos", () => {
    const tokens = extractStructure(CANONICAL_MD);
    const labels = tokens.map((t) => t.label);
    assert.ok(labels.includes("destaque-1"));
    assert.ok(labels.includes("destaque-2"));
    assert.ok(labels.includes("destaque-3"));
    assert.ok(labels.includes("é-ia"));
    assert.ok(labels.includes("lancamentos"));
    assert.ok(labels.includes("outras-noticias"));
    assert.ok(labels.includes("erro-intencional"));
    assert.ok(labels.includes("sorteio"));
    assert.ok(labels.includes("para-encerrar"));
  });

  it("ignora linhas que não são separadores nem headers", () => {
    const md = "Parágrafo qualquer.\n\nOutra linha.\n";
    const tokens = extractStructure(md);
    assert.equal(tokens.length, 0);
  });

  it("conta separadores `---` em linha própria", () => {
    const md = "Frase.\n\n---\n\nOutra frase.\n\n---\n\nFinal.";
    const tokens = extractStructure(md);
    const seps = tokens.filter((t) => t.kind === "separator");
    assert.equal(seps.length, 2);
  });

  it("normaliza CRLF", () => {
    const md = CANONICAL_MD.replace(/\n/g, "\r\n");
    const tokens = extractStructure(md);
    assert.ok(tokens.length > 5);
  });
});

describe("diffStructure (#1205)", () => {
  it("ok quando before === after", () => {
    const before = extractStructure(CANONICAL_MD);
    const after = extractStructure(CANONICAL_MD);
    const r = diffStructure(before, after);
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 0);
  });

  it("detecta separador removido (caso 260517)", () => {
    // Reproduzir: title-picker removeu `---` entre OUTRAS NOTÍCIAS e SORTEIO
    const corrupted = CANONICAL_MD.replace(
      "Desc.\n\n---\n\n**ERRO INTENCIONAL**",
      "Desc.\n\n**ERRO INTENCIONAL**",
    );
    const before = extractStructure(CANONICAL_MD);
    const after = extractStructure(corrupted);
    const r = diffStructure(before, after);
    assert.equal(r.ok, false);
    assert.equal(
      r.changes[0].type,
      "removed",
      `expected removed but got ${r.changes[0]?.type}`,
    );
    assert.match(r.changes[0].detail, /---/);
  });

  it("detecta ERRO INTENCIONAL movido pro final (caso 260517)", () => {
    // Reproduzir: title-picker moveu ERRO INTENCIONAL pra depois de PARA ENCERRAR
    const reordered = CANONICAL_MD
      .replace("**ERRO INTENCIONAL**\nReveal.\n\n---\n\n", "")
      .replace("Body encerrar.", "Body encerrar.\n\n---\n\n**ERRO INTENCIONAL**\nReveal.");

    const before = extractStructure(CANONICAL_MD);
    const after = extractStructure(reordered);
    const r = diffStructure(before, after);
    assert.equal(r.ok, false, `expected diff. before=${before.map(t=>t.label).join(",")}, after=${after.map(t=>t.label).join(",")}`);
    // Pode ser reorder (mesmas contagens) ou removed/added
    assert.ok(r.changes.length > 0);
  });

  it("detecta header adicionado", () => {
    const augmented = CANONICAL_MD + "\n\n---\n\n**DESTAQUE 4 | NOVO**\n";
    const before = extractStructure(CANONICAL_MD);
    const after = extractStructure(augmented);
    const r = diffStructure(before, after);
    assert.equal(r.ok, false);
    // Changes podem incluir tanto separator extra quanto destaque-4 — checar
    // que pelo menos um change menciona destaque-4
    const allDetails = r.changes.map((c) => c.detail).join(" | ");
    assert.match(allDetails, /destaque-4/);
    assert.ok(r.changes.some((c) => c.type === "added"));
  });
});
