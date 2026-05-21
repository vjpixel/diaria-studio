/**
 * test/launch-vs-news.test.ts (#1442)
 *
 * Cobre `isLikelyNewsNotLaunch` — heurística usada pelo `categorize.ts` pra
 * distinguir anúncio institucional (parceria geográfica, programa por país,
 * evento) de lançamento de produto/feature, mesmo em domínio oficial.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLikelyNewsNotLaunch } from "../scripts/lib/launch-vs-news.ts";

describe("isLikelyNewsNotLaunch (#1442) — anúncio institucional vs lançamento", () => {
  // ============ POSITIVE cases (deve retornar true → vira NOTÍCIA) ============

  it("'Introducing OpenAI for Singapore' — programa geográfico", () => {
    assert.equal(isLikelyNewsNotLaunch("Introducing OpenAI for Singapore"), true);
  });

  it("'The next phase of OpenAI's Education for Countries' — programa multi-país", () => {
    assert.equal(
      isLikelyNewsNotLaunch("The next phase of OpenAI's Education for Countries"),
      true,
    );
  });

  it("'Claude for Brazil' — produto/programa pra país lusófono", () => {
    assert.equal(isLikelyNewsNotLaunch("Claude for Brazil"), true);
  });

  it("'Gemini for India' — programa geográfico", () => {
    assert.equal(isLikelyNewsNotLaunch("Gemini for India"), true);
  });

  it("'Anthropic opens new office in Tokyo' — expansão geográfica", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Anthropic opens new office in Tokyo"),
      true,
    );
  });

  it("'OpenAI abre escritório em São Paulo' — expansão geográfica (PT)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("OpenAI abre escritório em São Paulo"),
      true,
    );
  });

  it("'Google Cloud Next 2026 Summit' — evento", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Google Cloud Next 2026 Summit"),
      true,
    );
  });

  it("'New features at Cloud Next' — apresentação em evento", () => {
    assert.equal(
      isLikelyNewsNotLaunch("New features at Cloud Next"),
      true,
    );
  });

  it("'Education para países' — programa governamental PT", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Educação para países em desenvolvimento"),
      true,
    );
  });

  it("'OpenAI para o Brasil' — programa geográfico PT direto", () => {
    assert.equal(
      isLikelyNewsNotLaunch("OpenAI para o Brasil"),
      true,
    );
  });

  it("'Claude para a Índia' — programa geográfico PT (artigo feminino)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Claude para a Índia"),
      true,
    );
  });

  it("anti-case PT: 'Claude para Desenvolvedores' continua lancamento (audience, não geo)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Claude para Desenvolvedores"),
      false,
    );
  });

  // ============ ANTI-cases (deve retornar false → continua LANÇAMENTO) ============

  it("'Introducing Gemini Omni' — lançamento de modelo", () => {
    assert.equal(isLikelyNewsNotLaunch("Introducing Gemini Omni"), false);
  });

  it("'Introducing Google Antigravity 2.0' — lançamento de produto", () => {
    assert.equal(isLikelyNewsNotLaunch("Introducing Google Antigravity 2.0"), false);
  });

  it("'Asset Studio ganha capacidades multimodais' — feature update", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Asset Studio ganha capacidades multimodais"),
      false,
    );
  });

  it("'OlmoEarth v1.1: Earth observation models' — lançamento de versão", () => {
    assert.equal(
      isLikelyNewsNotLaunch("OlmoEarth v1.1: Earth observation models"),
      false,
    );
  });

  it("'Co-Scientist: A multi-agent AI partner' — lançamento de produto", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Co-Scientist: A multi-agent AI partner"),
      false,
    );
  });

  it("'Claude 4 Sonnet' — lançamento de modelo (sem 'for {Country}')", () => {
    assert.equal(isLikelyNewsNotLaunch("Claude 4 Sonnet"), false);
  });

  it("'Claude for Creative Work' — feature/audience-name, não programa geográfico", () => {
    assert.equal(isLikelyNewsNotLaunch("Claude for Creative Work"), false);
  });

  it("'GPT-5 for Enterprise' — feature tier, não programa geográfico", () => {
    assert.equal(isLikelyNewsNotLaunch("GPT-5 for Enterprise"), false);
  });

  it("'A new approach to safety' — research/posicionamento, não institucional", () => {
    assert.equal(isLikelyNewsNotLaunch("A new approach to safety"), false);
  });

  it("título vazio retorna false (defensive)", () => {
    assert.equal(isLikelyNewsNotLaunch(""), false);
  });
});
