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

  // ============ #1521: benchmarks, migrations, hardware, ads ============

  it("#1521: 'NVIDIA Vera CPU Is Packing a Heavy-Hitting Punch' → true (benchmark)", () => {
    assert.equal(isLikelyNewsNotLaunch("NVIDIA Vera CPU Is 'Packing a Heavy-Hitting Punch' Against Competition"), true);
  });

  it("#1521: 'Google Display Ads has a new home in Demand Gen' → true (migration)", () => {
    assert.equal(isLikelyNewsNotLaunch("Google Display Ads has a new home in Demand Gen."), true);
  });

  it("#1521: 'First benchmarks of Apple M5 Ultra' → true (benchmark)", () => {
    assert.equal(isLikelyNewsNotLaunch("First benchmarks of Apple M5 Ultra"), true);
  });

  it("#1521: 'Service migrates to new platform' → true (migration)", () => {
    assert.equal(isLikelyNewsNotLaunch("Google Cloud service migrates to new platform"), true);
  });

  it("#1521: 'CPU benchmark results show improvement' → true", () => {
    assert.equal(isLikelyNewsNotLaunch("CPU benchmark results show 40% improvement"), true);
  });

  it("#1521: 'OpenAI launches GPT-6' → false (real launch, no benchmark/migration keywords)", () => {
    assert.equal(isLikelyNewsNotLaunch("OpenAI launches GPT-6"), false);
  });

  it("#1521: 'Anthropic releases Claude 5' → false (real launch)", () => {
    assert.equal(isLikelyNewsNotLaunch("Anthropic releases Claude 5"), false);
  });

  // ============ #1573: governance/conference/podcast (260529 false positives) ============

  it("#1573: 'OpenAI Frontier Governance Framework' → true (policy, não lançamento)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("OpenAI's Frontier Governance Framework"),
      true,
    );
  });

  it("#1573: 'NVIDIA Research Advances Robotics From Simulation to the Real World' → true (research framing)", () => {
    assert.equal(
      isLikelyNewsNotLaunch(
        "NVIDIA Research Advances Robotics From Simulation to the Real World",
      ),
      true,
    );
  });

  it("#1573: 'Apple at CVPR 2026' → true (conference attendance)", () => {
    assert.equal(isLikelyNewsNotLaunch("Apple at CVPR 2026"), true);
  });

  it("#1573: 'Anthropic at NeurIPS' → true (conference attendance)", () => {
    assert.equal(isLikelyNewsNotLaunch("Anthropic at NeurIPS"), true);
  });

  it("#1573: 'Google Research presents new model at ICML' → true", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Google Research presents new model at ICML"),
      true,
    );
  });

  it("#1573: 'How AI is rebuilding marketing - Ads Decoded podcast finale' → true (podcast)", () => {
    assert.equal(
      isLikelyNewsNotLaunch(
        "How AI is rebuilding marketing - Ads Decoded podcast finale",
      ),
      true,
    );
  });

  it("#1573: 'AI Safety Principles for Frontier Models' → true (policy/principles)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("AI Safety Principles for Frontier Models"),
      true,
    );
  });

  it("#1573: 'Framework for Responsible AI Deployment' → true (framework)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Framework for Responsible AI Deployment"),
      true,
    );
  });

  // Negative cases — real launches that mention these words inside other contexts
  it("#1573: 'Claude 5 launched' → false (real launch, no policy keyword)", () => {
    assert.equal(isLikelyNewsNotLaunch("Claude 5 launched"), false);
  });

  it("#1573: 'Gemini 3 released' → false (real launch)", () => {
    assert.equal(isLikelyNewsNotLaunch("Gemini 3 released"), false);
  });

  // ============ #1598 review fix: narrow over-broad regexes ============

  it("#1598: 'Final Cut Pro launches AI editing' → false (real launch, bare `final` removido)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Final Cut Pro launches AI editing"),
      false,
    );
  });

  it("#1598: 'Versão final do Claude Code lançada' → false (PT real launch)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Versão final do Claude Code lançada"),
      false,
    );
  });

  it("#1598: 'Anthropic launches new podcast app' → false (podcast precisa de followup)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Anthropic launches new podcast app"),
      false,
    );
  });

  it("#1598: 'A framework for developers to ship faster' → false (framework genérico ok)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("A framework for developers to ship faster"),
      false,
    );
  });

  it("#1598: 'Acceptable Use Policy v2 published' → false (bare policy removido)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Acceptable Use Policy v2 published"),
      false,
    );
  });

  it("#1598: 'Brand guidelines updated for partners' → false (bare guidelines removido)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Brand guidelines updated for partners"),
      false,
    );
  });

  // RE-CONFIRMAR que casos legítimos de governance ainda fire
  it("#1598: 'AI Safety Policy v2 from Anthropic' → true (AI safety qualifier)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("AI Safety Policy v2 from Anthropic"),
      true,
    );
  });

  it("#1598: 'Princípios de segurança da OpenAI' → true (PT governance)", () => {
    assert.equal(
      isLikelyNewsNotLaunch("Princípios de segurança da OpenAI"),
      true,
    );
  });

  // Conferências adicionais
  it("#1598: 'Google Research at AAAI 2026' → true (AAAI agora reconhecida)", () => {
    assert.equal(isLikelyNewsNotLaunch("Google Research at AAAI 2026"), true);
  });
});
