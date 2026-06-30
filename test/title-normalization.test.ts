/**
 * title-normalization.test.ts (#2664 + #2672)
 *
 * Testes de regressão para os lint checks:
 *
 * - `checkTitlePublisherSuffix` (#2664) — flagra títulos com sufixo de veículo
 *   em newsletter md (destaque + seções secundárias).
 * - `checkTitleTrailingPeriod` (#2672) — flagra títulos com ponto final.
 *
 * Casos reais dos issues:
 *   - #2664: "ChatGPT consegue...veja como - Canaltech" → flagrado
 *   - #2672: "AINews: OpenAI reports...November 2025." → flagrado
 *   - Anti-FP: "OpenAI lança GPT-5 - o maior modelo" → NÃO flagrado
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkTitlePublisherSuffix,
  checkTitleTrailingPeriod,
} from "../scripts/lib/lint-checks/title-normalization.ts";

// ===========================================================================
// Helpers para construir snippets de newsletter md
// ===========================================================================

/** Constrói um bloco DESTAQUE com título inline link. */
function destaqueMd(title: string, url = "https://example.com/artigo"): string {
  return `DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL\n\n[${title}](${url})\n\nPor que isso importa: contexto relevante aqui.\n\n---`;
}

/** Constrói um item de seção secundária com inline link. */
function radarItemMd(title: string, url = "https://example.com/radar"): string {
  return `RADAR\n\n[${title}](${url})\nDescrição do item.\n`;
}

// ===========================================================================
// checkTitlePublisherSuffix (#2664)
// ===========================================================================

describe("checkTitlePublisherSuffix (#2664)", () => {
  // Caso real do issue #2664 — seção RADAR
  it("CASO REAL #2664: flagra '...veja como - Canaltech' em item RADAR", () => {
    const md = radarItemMd(
      "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo; veja como - Canaltech",
    );
    const result = checkTitlePublisherSuffix(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].separator, "dash");
    assert.equal(result.errors[0].suffix, "Canaltech");
  });

  // Caso real do issue #2664 — seção DESTAQUE
  it("CASO REAL #2664: flagra '...veja como - Canaltech' em DESTAQUE", () => {
    const md = destaqueMd(
      "ChatGPT consegue fazer check-up do seu PC; veja como - Canaltech",
    );
    const result = checkTitlePublisherSuffix(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].separator, "dash");
  });

  it("flagra sufixo pipe '| G1' em título de item", () => {
    const md = radarItemMd(
      "Especialistas criticam modelo de regulamentação da IA no Brasil | G1",
    );
    const result = checkTitlePublisherSuffix(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].separator, "pipe");
    assert.equal(result.errors[0].suffix, "G1");
  });

  it("flagra sufixo travessão '— TechCrunch'", () => {
    const md = radarItemMd(
      "Google anuncia Gemini 2.5 Pro com melhorias significativas — TechCrunch",
    );
    const result = checkTitlePublisherSuffix(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].separator, "em_dash");
  });

  // Anti-falso-positivo: "GPT-5 - o maior modelo" NÃO é veículo
  it("ANTI-FP: NÃO flagra '- o maior modelo' (5 palavras = não é sufixo de veículo)", () => {
    const md = radarItemMd(
      "OpenAI lança GPT-5 - o maior modelo da história",
    );
    const result = checkTitlePublisherSuffix(md);
    // "o maior modelo da história" = 5 palavras → > 4 → não flagrado
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("ANTI-FP: NÃO flagra título limpo sem separador de veículo", () => {
    const md = radarItemMd("Google anuncia novidades no I/O 2026");
    const result = checkTitlePublisherSuffix(md);
    assert.equal(result.ok, true);
  });

  it("retorna ok: true para newsletter limpa", () => {
    const md = [
      destaqueMd("Modelo de IA da Meta supera GPT-4 em benchmarks"),
      radarItemMd("Startup brasileira capta R$ 50 milhões em rodada Series A"),
    ].join("\n\n");
    const result = checkTitlePublisherSuffix(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });
});

// ===========================================================================
// checkTitleTrailingPeriod (#2672)
// ===========================================================================

describe("checkTitleTrailingPeriod (#2672)", () => {
  // Caso real do issue #2672
  it("CASO REAL #2672: flagra título AINews com ponto final em DESTAQUE", () => {
    const md = destaqueMd(
      "AINews: OpenAI reports median internal Codex output tokens grew 56x since November 2025.",
    );
    const result = checkTitleTrailingPeriod(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].title.endsWith("."));
  });

  it("CASO REAL #2672: flagra título com ponto final em item RADAR", () => {
    const md = radarItemMd(
      "AINews: OpenAI reports median internal Codex output tokens grew 56x since November 2025.",
    );
    const result = checkTitleTrailingPeriod(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
  });

  it("NÃO flagra título com '?' (pontuação intencional)", () => {
    const md = radarItemMd("Será que a IA vai tomar os empregos?");
    const result = checkTitleTrailingPeriod(md);
    assert.equal(result.ok, true);
  });

  it("NÃO flagra título com '!' (pontuação intencional)", () => {
    const md = radarItemMd("Meta anuncia headset de realidade aumentada!");
    const result = checkTitleTrailingPeriod(md);
    assert.equal(result.ok, true);
  });

  it("NÃO flagra título com '…' (reticências unicode)", () => {
    const md = radarItemMd("O futuro da inteligência artificial generativa…");
    const result = checkTitleTrailingPeriod(md);
    assert.equal(result.ok, true);
  });

  it("NÃO flagra título com '...' (reticências ascii)", () => {
    const md = radarItemMd("O que vem por aí no mundo da IA...");
    const result = checkTitleTrailingPeriod(md);
    assert.equal(result.ok, true);
  });

  it("NÃO flagra título limpo sem ponto final", () => {
    const md = radarItemMd("Google anuncia novidades no I/O 2026");
    const result = checkTitleTrailingPeriod(md);
    assert.equal(result.ok, true);
  });

  it("retorna ok: true para newsletter com títulos limpos", () => {
    const md = [
      destaqueMd("Modelo de IA da Meta supera GPT-4 em benchmarks"),
      radarItemMd("Startup brasileira capta R$ 50 milhões em rodada Series A"),
    ].join("\n\n");
    const result = checkTitleTrailingPeriod(md);
    assert.equal(result.ok, true);
  });
});

// ===========================================================================
// Anti-falso-positivo de corpo (#2664/#2672 follow-up)
//
// `extractAllTitles` NÃO pode coletar linhas de corpo (parágrafos, links de
// referência no corpo de um DESTAQUE) como se fossem títulos — senão os checks
// flagram texto de corpo. Guards: looksLikeTitleOption (plain-text) + coleta de
// inline link só dentro de seção secundária.
// ===========================================================================

describe("extractAllTitles — não coleta linhas de corpo (#2664/#2672 follow-up)", () => {
  it("ANTI-FP: link de referência no corpo do DESTAQUE (com ponto) NÃO é flagrado", () => {
    const md = [
      "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
      "",
      "[Modelo de IA da Meta supera GPT-4 em benchmarks](https://example.com/d1)",
      "",
      "Por que isso importa: contexto relevante aqui.",
      "",
      "[Leia o estudo completo da OpenAI.](https://openai.com/report)",
      "",
      "---",
    ].join("\n");
    // O link de referência termina em "." mas é corpo, não título → não flagra.
    const period = checkTitleTrailingPeriod(md);
    assert.equal(period.ok, true, "link de referência no corpo não deve disparar lint de ponto final");
  });

  it("ANTI-FP: link de referência no corpo do DESTAQUE (com traço+veículo) NÃO é flagrado", () => {
    const md = [
      "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
      "",
      "[Modelo de IA da Meta supera GPT-4 em benchmarks](https://example.com/d1)",
      "",
      "Por que isso importa: veja a cobertura.",
      "",
      "[Matéria completa - Canaltech](https://canaltech.com.br/x)",
      "",
      "---",
    ].join("\n");
    const suffix = checkTitlePublisherSuffix(md);
    assert.equal(suffix.ok, true, "link de referência no corpo não deve disparar lint de sufixo");
  });

  it("ANTI-FP: parágrafo de corpo (legado) terminando em ponto NÃO é flagrado", () => {
    const md = [
      "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
      "Título legado do destaque",
      "Este é um parágrafo de corpo que descreve o artigo e termina em ponto.",
      "https://example.com/legacy",
    ].join("\n");
    const period = checkTitleTrailingPeriod(md);
    assert.equal(period.ok, true, "parágrafo de corpo não deve disparar lint de ponto final");
  });

  it("REGRESSÃO: título de item em seção secundária com ponto AINDA é flagrado", () => {
    // Garante que o guard de seção secundária não suprime títulos reais.
    const md = radarItemMd("AINews: relatório da OpenAI sobre Codex em 2025.");
    const result = checkTitleTrailingPeriod(md);
    assert.equal(result.ok, false, "título de item RADAR com ponto deve continuar flagrado");
    assert.equal(result.errors.length, 1);
  });
});
