/**
 * test/lint-checks-destaque-category-noticias.test.ts (#8200)
 *
 * Regressão (#633) do lint `checkDestaqueCategoryNoticias` — 2 edições
 * seguidas (260916, 260917) saíram com `**DESTAQUE N | 📰 NOTÍCIAS**`,
 * violando o #6083 ("categoria nunca deve ser 'notícias'") só documentado em
 * prosa em `.claude/agents/orchestrator-stage-2.md`. GATE-BLOCKING: sem
 * exceção legítima conhecida (mesmo racional do `banned-lexicon`, #7260).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDestaqueCategoryNoticias } from "../scripts/lib/lint-checks/destaque-category-noticias.ts";

describe("checkDestaqueCategoryNoticias (#8200)", () => {
  it("CASO REAL: flagra 'DESTAQUE 2 | 📰 NOTÍCIAS' (edição 260916/260917)", () => {
    const md = "**DESTAQUE 2 | 📰 NOTÍCIAS**\n\nTítulo do destaque\n";
    const result = checkDestaqueCategoryNoticias(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].destaqueNumber, 2);
    assert.equal(result.errors[0].category, "📰 NOTÍCIAS");
    assert.equal(result.errors[0].line, 1);
  });

  it("flagra sem emoji: 'DESTAQUE 3 | NOTÍCIAS'", () => {
    const md = "**DESTAQUE 3 | NOTÍCIAS**\n";
    const result = checkDestaqueCategoryNoticias(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].destaqueNumber, 3);
  });

  it("case-insensitive: 'notícias' minúsculo também flagra", () => {
    const md = "**DESTAQUE 1 | notícias**\n";
    const result = checkDestaqueCategoryNoticias(md);
    assert.equal(result.ok, false);
  });

  it("flagra sem negrito (header plain, mesma forma aceita por HIGHLIGHT_HEADER_RE)", () => {
    const md = "DESTAQUE 1 | 📰 Notícias\n";
    const result = checkDestaqueCategoryNoticias(md);
    assert.equal(result.ok, false);
  });

  it("NÃO flagra categoria temática real (ex: MERCADO, EDUCAÇÃO, REGULAÇÃO — o refinamento correto do #6083)", () => {
    const md = [
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
      "",
      "**DESTAQUE 2 | 📈 MERCADO**",
      "",
      "**DESTAQUE 3 | ⚖️ REGULAÇÃO**",
    ].join("\n");
    const result = checkDestaqueCategoryNoticias(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("NÃO flagra a palavra 'notícias' no CORPO do texto (só o header de destaque conta)", () => {
    const md = [
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
      "",
      "Essas notícias mostram que o mercado de IA segue aquecido.",
    ].join("\n");
    const result = checkDestaqueCategoryNoticias(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("acusa múltiplos destaques com 'NOTÍCIAS', com número de linha correto", () => {
    const md = [
      "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
      "corpo do destaque 1",
      "**DESTAQUE 2 | 📰 NOTÍCIAS**",
      "corpo do destaque 2",
      "**DESTAQUE 3 | 📰 Notícias**",
    ].join("\n");
    const result = checkDestaqueCategoryNoticias(md);
    assert.equal(result.errors.length, 2);
    assert.equal(result.errors[0].line, 3);
    assert.equal(result.errors[0].destaqueNumber, 2);
    assert.equal(result.errors[1].line, 5);
    assert.equal(result.errors[1].destaqueNumber, 3);
  });

  it("texto sem nenhum header de destaque passa limpo", () => {
    const md = "Apenas um parágrafo qualquer sem headers de destaque.";
    const result = checkDestaqueCategoryNoticias(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });
});
