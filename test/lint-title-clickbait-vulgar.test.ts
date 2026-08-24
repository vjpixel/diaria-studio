/**
 * test/lint-title-clickbait-vulgar.test.ts (#6008)
 *
 * Testes de regressão para `checkTitleClickbaitVulgar`
 * (scripts/lib/lint-checks/title-clickbait-vulgar.ts) — lint WARN-ONLY que
 * sinaliza a faixa VULGAR de clickbait em títulos de DESTAQUE (blocklist),
 * backstop do padrão "clickbait elegante" decidido pelo editor (260824).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkTitleClickbaitVulgar } from "../scripts/lib/lint-checks/title-clickbait-vulgar.ts";

function destaqueMd(
  title: string,
  { destaque = 1, category = "INDÚSTRIA", url = "https://example.com/artigo" } = {},
): string {
  return `DESTAQUE ${destaque} | ${category}\n\n[${title}](${url})\n\nPor que isso importa: contexto relevante aqui.\n\n---`;
}

describe("checkTitleClickbaitVulgar (#6008)", () => {
  it("título de tensão factual elegante NÃO flagra", () => {
    const md = destaqueMd("Amazon trai desenvolvedores e abre o próprio chip");
    const result = checkTitleClickbaitVulgar(md);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("pergunta provocativa elegante NÃO flagra", () => {
    const md = destaqueMd("Quem paga a conta dos data centers?");
    const result = checkTitleClickbaitVulgar(md);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("flagra 'você não vai acreditar' (com acento)", () => {
    const result = checkTitleClickbaitVulgar(destaqueMd("Você não vai acreditar no que a OpenAI fez"));
    assert.equal(result.ok, false);
    assert.match(result.errors[0].matched, /acreditar/i);
  });

  it("flagra 'nao vai acreditar' sem acento", () => {
    const result = checkTitleClickbaitVulgar(destaqueMd("Isso nao vai acreditar: modelo engole processo"));
    assert.equal(result.ok, false);
  });

  it("flagra 'Não vai acreditar' com acento, standalone (review #6024)", () => {
    const result = checkTitleClickbaitVulgar(destaqueMd("Não vai acreditar: modelo engole processo"));
    assert.equal(result.ok, false);
    assert.match(result.errors[0].matched, /acreditar/i);
  });

  it("flagra 'chocante'", () => {
    const result = checkTitleClickbaitVulgar(destaqueMd("O número chocante que a Meta escondeu"));
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].matched, "chocante");
  });

  it("flagra 'o que aconteceu depois' (curiosity gap clássico)", () => {
    const result = checkTitleClickbaitVulgar(destaqueMd("OpenAI demitiu pesquisador — o que aconteceu depois"));
    assert.equal(result.ok, false);
  });

  it("flagra ponto de exclamação", () => {
    const result = checkTitleClickbaitVulgar(destaqueMd("Google lança modelo grátis!"));
    assert.equal(result.ok, false);
    assert.match(result.errors[0].matched, /exclamação/);
  });

  it("flagra reticências de suspense no fim", () => {
    const result = checkTitleClickbaitVulgar(destaqueMd("O detalhe que ninguém viu na demo..."));
    assert.equal(result.ok, false);
    assert.match(result.errors[0].matched, /reticências/);
  });

  it("flagra listicle vazio ('5 coisas')", () => {
    const result = checkTitleClickbaitVulgar(destaqueMd("5 coisas que a Anthropic mudou nos termos"));
    assert.equal(result.ok, false);
    assert.match(result.errors[0].matched, /listicle/);
  });

  it("flagra CAPS LOCK (palavra ≥6 letras toda maiúscula)", () => {
    const result = checkTitleClickbaitVulgar(destaqueMd("URGENTE: corte afeta fornecedores de GPU"));
    assert.equal(result.ok, false);
    assert.match(result.errors[0].matched, /CAPS/);
  });

  it("sigla legítima na allowlist NÃO flagra como CAPS", () => {
    // OPENAI está na allowlist; título segue elegante.
    const result = checkTitleClickbaitVulgar(destaqueMd("OPENAI corta preço e rivais reagem"));
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("números com % e cifras não disparam falso-positivo", () => {
    const result = checkTitleClickbaitVulgar(destaqueMd("Custo de treino cai 90% e muda o mercado"));
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
});
