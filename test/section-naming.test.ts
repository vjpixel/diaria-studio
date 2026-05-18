import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  singularizeSectionName,
  sectionEmojiPrefix,
  stripEmojiPrefix,
  displaySectionName,
} from "../scripts/lib/section-naming.ts";

describe("singularizeSectionName (#1070, #1324)", () => {
  it("plural quando N≠1 — preserva nome", () => {
    assert.equal(singularizeSectionName("LANÇAMENTOS", 2), "LANÇAMENTOS");
    assert.equal(singularizeSectionName("LANÇAMENTOS", 3), "LANÇAMENTOS");
    assert.equal(singularizeSectionName("LANÇAMENTOS", 0), "LANÇAMENTOS");
  });

  it("singular quando N=1", () => {
    assert.equal(singularizeSectionName("LANÇAMENTOS", 1), "LANÇAMENTO");
    assert.equal(singularizeSectionName("PESQUISAS", 1), "PESQUISA");
    assert.equal(singularizeSectionName("OUTRAS NOTÍCIAS", 1), "OUTRA NOTÍCIA");
  });

  it("aceita nome com emoji prefix existente", () => {
    assert.equal(singularizeSectionName("🚀 LANÇAMENTOS", 1), "LANÇAMENTO");
    assert.equal(singularizeSectionName("🔬 PESQUISAS", 1), "PESQUISA");
    assert.equal(singularizeSectionName("📰 OUTRAS NOTÍCIAS", 1), "OUTRA NOTÍCIA");
  });

  it("nome desconhecido passa direto", () => {
    assert.equal(singularizeSectionName("VÍDEOS", 1), "VÍDEOS");
    assert.equal(singularizeSectionName("DESTAQUES", 1), "DESTAQUES");
  });
});

describe("sectionEmojiPrefix (#1328)", () => {
  it("retorna emoji + space pra LANÇAMENTOS (plural)", () => {
    assert.equal(sectionEmojiPrefix("LANÇAMENTOS"), "🚀 ");
  });

  it("retorna emoji + space pra LANÇAMENTO (singular)", () => {
    assert.equal(sectionEmojiPrefix("LANÇAMENTO"), "🚀 ");
  });

  it("PESQUISAS/PESQUISA → 🔬", () => {
    assert.equal(sectionEmojiPrefix("PESQUISAS"), "🔬 ");
    assert.equal(sectionEmojiPrefix("PESQUISA"), "🔬 ");
  });

  it("OUTRAS NOTÍCIAS/OUTRA NOTÍCIA → 📰", () => {
    assert.equal(sectionEmojiPrefix("OUTRAS NOTÍCIAS"), "📰 ");
    assert.equal(sectionEmojiPrefix("OUTRA NOTÍCIA"), "📰 ");
  });

  it("nome desconhecido → string vazia", () => {
    assert.equal(sectionEmojiPrefix("VÍDEOS"), "");
    assert.equal(sectionEmojiPrefix("OBSERVAÇÕES"), "");
  });

  it("idempotente — aceita nome com emoji existente", () => {
    assert.equal(sectionEmojiPrefix("🚀 LANÇAMENTOS"), "🚀 ");
  });
});

describe("stripEmojiPrefix", () => {
  it("remove emoji + space do início", () => {
    assert.equal(stripEmojiPrefix("🚀 LANÇAMENTOS"), "LANÇAMENTOS");
    assert.equal(stripEmojiPrefix("🔬 PESQUISAS"), "PESQUISAS");
    assert.equal(stripEmojiPrefix("📰 OUTRAS NOTÍCIAS"), "OUTRAS NOTÍCIAS");
  });

  it("idempotente — sem emoji retorna input", () => {
    assert.equal(stripEmojiPrefix("LANÇAMENTOS"), "LANÇAMENTOS");
    assert.equal(stripEmojiPrefix("VÍDEOS"), "VÍDEOS");
  });

  it("não remove emoji do meio do nome", () => {
    assert.equal(stripEmojiPrefix("LANÇAMENTOS 🚀"), "LANÇAMENTOS 🚀");
  });
});

describe("displaySectionName — orquestrador (#1324, #1328)", () => {
  it("plural com emoji quando N>1", () => {
    assert.equal(displaySectionName("LANÇAMENTOS", 2), "🚀 LANÇAMENTOS");
    assert.equal(displaySectionName("PESQUISAS", 3), "🔬 PESQUISAS");
    assert.equal(displaySectionName("OUTRAS NOTÍCIAS", 5), "📰 OUTRAS NOTÍCIAS");
  });

  it("singular com emoji quando N=1", () => {
    assert.equal(displaySectionName("LANÇAMENTOS", 1), "🚀 LANÇAMENTO");
    assert.equal(displaySectionName("PESQUISAS", 1), "🔬 PESQUISA");
    assert.equal(displaySectionName("OUTRAS NOTÍCIAS", 1), "📰 OUTRA NOTÍCIA");
  });

  it("idempotente com emoji já presente", () => {
    assert.equal(displaySectionName("🚀 LANÇAMENTOS", 1), "🚀 LANÇAMENTO");
    assert.equal(displaySectionName("🔬 PESQUISAS", 2), "🔬 PESQUISAS");
  });

  it("nome desconhecido sem emoji, sem singularização", () => {
    assert.equal(displaySectionName("VÍDEOS", 1), "VÍDEOS");
  });
});
