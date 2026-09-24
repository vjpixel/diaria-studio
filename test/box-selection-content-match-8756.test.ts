/**
 * #8756 — `_internal/box-selection.json` grava o `slot` da seleção do
 * Stage 2. Quando o editor move os boxes à mão no `02-reviewed.md` (Stage 4),
 * o número deixa de bater com a posição real e o render aplicava a categoria
 * /alt/título do arquivo ERRADO ao box. O box que está de fato no slot passa
 * a ser identificado pelo conteúdo quando o match é único.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  matchBoxSelectionFileByContent,
  boxSnippetSignature,
  normalizeBoxTextForMatch,
} from "../scripts/lib/newsletter-parse.ts";

const SNIPPETS: Record<string, string> = {
  "workshop-agente-ia-outubro.md": "**Crie seu agente de IA sem programar**\n\nWorkshop ao vivo em outubro.",
  "nexo-emprego-ia.md": "📚 **Nexo: o que a IA faz com o emprego**\n\nReportagem especial.",
};
const read = (f: string) => SNIPPETS[f] ?? null;

// Caso real da 260924: o editor pôs o workshop no gap D1/D2 e o Nexo depois
// do último destaque, mas o JSON dizia slot:1 → nexo, slot:2 → workshop.
const ENTRIES = [
  { slot: 1, file: "nexo-emprego-ia.md" },
  { slot: 2, file: "workshop-agente-ia-outubro.md" },
];

describe("matchBoxSelectionFileByContent (#8756)", () => {
  it("box do workshop, em qualquer slot, resolve pro arquivo do workshop", () => {
    const boxText = "<strong>Crie seu agente de IA sem programar</strong> Workshop ao vivo em outubro.";
    assert.equal(matchBoxSelectionFileByContent(ENTRIES, boxText, read), "workshop-agente-ia-outubro.md");
  });

  it("box do Nexo resolve pro arquivo do Nexo, ignorando emoji e markdown", () => {
    assert.equal(
      matchBoxSelectionFileByContent(ENTRIES, "Nexo: o que a IA faz com o emprego — Reportagem especial.", read),
      "nexo-emprego-ia.md",
    );
  });

  it("sem match (texto editado à mão) → null, caller cai no lookup por slot", () => {
    assert.equal(matchBoxSelectionFileByContent(ENTRIES, "Um box totalmente novo escrito pelo editor", read), null);
  });

  it("match ambíguo (2 snippets com a mesma abertura) → null", () => {
    const dup = (f: string) => (f.endsWith(".md") ? "Mesma abertura de texto para os dois" : null);
    assert.equal(matchBoxSelectionFileByContent(ENTRIES, "Mesma abertura de texto para os dois boxes", dup), null);
  });

  it("snippet ausente em data/snippets (sessão cloud) → null, nunca lança", () => {
    assert.equal(matchBoxSelectionFileByContent(ENTRIES, "qualquer coisa", () => null), null);
  });
});

describe("boxSnippetSignature / normalizeBoxTextForMatch (#8756)", () => {
  it("pula linhas curtas demais pra identificar e normaliza acento/markdown", () => {
    assert.equal(boxSnippetSignature("---\n\n**Ação já!**\n\nParticipe da votação agora"), "participe da votacao agora");
    assert.equal(normalizeBoxTextForMatch("**Olá, Mundo!** 📚"), "ola mundo");
  });
});
