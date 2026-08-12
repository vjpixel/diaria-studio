/**
 * test/lint-ia-in-title.test.ts (#4825)
 *
 * Testes de regressão para `checkTitleMentionsIA`
 * (scripts/lib/lint-checks/ia-in-title.ts) — lint WARN-ONLY que sinaliza
 * "IA"/"AI"/"inteligência artificial" em títulos de DESTAQUE.
 *
 * Casos cobertos (#633):
 *   - título com "IA" → warning
 *   - título sem o termo → sem warning
 *   - anti-falso-positivo: substring dentro de palavra maior (NVIDIA) não
 *     flagra (word boundary)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkTitleMentionsIA } from "../scripts/lib/lint-checks/ia-in-title.ts";

/** Constrói um bloco DESTAQUE com título inline link. */
function destaqueMd(
  title: string,
  { destaque = 1, category = "INDÚSTRIA", url = "https://example.com/artigo" } = {},
): string {
  return `DESTAQUE ${destaque} | ${category}\n\n[${title}](${url})\n\nPor que isso importa: contexto relevante aqui.\n\n---`;
}

describe("checkTitleMentionsIA (#4825)", () => {
  it("flagra título com sigla 'IA' maiúscula", () => {
    const md = destaqueMd("Nova IA da Anthropic escreve código sozinha");
    const result = checkTitleMentionsIA(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].matched, "IA");
    assert.equal(result.errors[0].destaque, 1);
  });

  it("flagra título com a frase 'inteligência artificial' (case-insensitive)", () => {
    const md = destaqueMd("Como a Inteligência Artificial mudou a radiologia");
    const result = checkTitleMentionsIA(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].matched, /inteligência artificial/i);
  });

  it("flagra título com a frase sem acento 'inteligencia artificial'", () => {
    const md = destaqueMd("Debate sobre inteligencia artificial na eleicao");
    const result = checkTitleMentionsIA(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
  });

  it("flagra título com a sigla inglesa 'AI'", () => {
    const md = destaqueMd("Perplexity AI lança novo modo de busca");
    const result = checkTitleMentionsIA(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].matched, "AI");
  });

  it("NÃO flagra título limpo (sem menção a IA/AI)", () => {
    const md = destaqueMd("Claude escreve código sozinha em novo benchmark");
    const result = checkTitleMentionsIA(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("ANTI-FP: NÃO flagra 'NVIDIA' (substring 'IA' dentro de palavra maior — word boundary)", () => {
    const md = destaqueMd("NVIDIA anuncia novo chip para data centers");
    const result = checkTitleMentionsIA(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("ANTI-FP: NÃO flagra 'ia' minúsculo dentro de palavra comum do português", () => {
    const md = destaqueMd("Empresa capta recursos em um dia histórico para o setor");
    const result = checkTitleMentionsIA(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("marca ok: false mas NUNCA deve ser tratado como bloqueante — CLI sempre sai 0 (ver lint-newsletter-md.ts)", () => {
    const md = destaqueMd("Regulação de IA avança no Congresso");
    const result = checkTitleMentionsIA(md);
    // O contrato do módulo é reportar `ok`/`errors` — o caráter warn-only é
    // responsabilidade do CALLER (CLI e invariant registry), não deste
    // helper. Este teste documenta que `ok: false` É esperado aqui mesmo em
    // casos de exceção legítima (ex: manchete sobre a categoria em si) —
    // não há allowlist, por design (ver docstring do módulo).
    assert.equal(result.ok, false);
  });

  it("detecta em múltiplos destaques, cada um com seu número correto", () => {
    const md = [
      destaqueMd("Claude escreve código sozinha", { destaque: 1, category: "PRODUTO" }),
      destaqueMd("Nova IA da Anthropic assusta especialistas", {
        destaque: 2,
        category: "MERCADO",
        url: "https://example.com/d2",
      }),
    ].join("\n\n");
    const result = checkTitleMentionsIA(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].destaque, 2);
  });

  it("#5084: CRLF line-endings não quebram a detecção do header DESTAQUE", () => {
    const md = destaqueMd("Nova IA da Anthropic escreve código sozinha").replace(/\n/g, "\r\n");
    const result = checkTitleMentionsIA(md);
    assert.equal(result.ok, false, "header DESTAQUE precisa ser detectado mesmo com \\r\\n");
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].matched, "IA");
  });
});
