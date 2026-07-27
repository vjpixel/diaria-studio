/**
 * test/launch-detect.test.ts (#4080)
 *
 * Regressão: `detectLaunchCandidate` só reconhecia lançamento em voz ATIVA
 * ("Empresa lança X"). Título em voz PASSIVA ("X é/foi lançado") passava
 * batido, mesmo com a empresa presente — os dois mecanismos que dependem
 * dessa função (enrich-primary-source #1699 e review-highlight-source
 * #1699/#1699-guard) ficavam cegos pra metade das construções em PT-BR.
 *
 * Caso real (edição 260727): o D2 foi publicado com link de imprensa
 * (Tecnoblog, "Claude Opus 5 é lançado com foco no desempenho e controle de
 * custos") quando o anúncio oficial (anthropic.com/news/claude-opus-5)
 * estava no próprio pool da edição. A variante em voz ativa da mesma notícia
 * ("Anthropic lança Opus 5...") FOI detectada — a heurística é cega
 * especificamente pra voz passiva, não pra falta de menção à empresa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectLaunchCandidate } from "../scripts/lib/launch-detect.ts";

describe("detectLaunchCandidate — voz passiva (#4080, caso real edição 260727)", () => {
  // Os 4 títulos exatos citados na issue #4080.

  it("'Claude Opus 5 é lançado com foco no desempenho e controle de custos' → true (passiva, antes false)", () => {
    const det = detectLaunchCandidate({
      title: "Claude Opus 5 é lançado com foco no desempenho e controle de custos",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "anthropic.com");
  });

  it("'Anthropic lança Opus 5 e promete IA de alto desempenho por metade do custo' → true (ativa, não regride)", () => {
    const det = detectLaunchCandidate({
      title: "Anthropic lança Opus 5 e promete IA de alto desempenho por metade do custo",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "anthropic.com");
  });

  it("'Claude Opus 5 foi lançado pela Anthropic' → true (passiva, empresa à direita do verbo)", () => {
    const det = detectLaunchCandidate({
      title: "Claude Opus 5 foi lançado pela Anthropic",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "anthropic.com");
  });

  it("'Anthropic lança Claude Opus 5 para empresas' → true (ativa, não regride)", () => {
    const det = detectLaunchCandidate({
      title: "Anthropic lança Claude Opus 5 para empresas",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "anthropic.com");
  });

  // Cobertura adicional dos padrões pedidos na issue: anunciado/apresentado,
  // plural, e empresa em posição ainda mais distante do verbo.

  it("'Novo modelo foi anunciado pela OpenAI nesta quinta' → true (foi anunciado)", () => {
    const det = detectLaunchCandidate({
      title: "Novo modelo foi anunciado pela OpenAI nesta quinta",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "openai.com");
  });

  it("'Gemini 3 é apresentado em evento da Google' → true (é apresentado)", () => {
    const det = detectLaunchCandidate({
      title: "Gemini 3 é apresentado em evento da Google",
      summary: "Gemini AI é a nova geração de modelos do Google",
    });
    assert.equal(det.is_candidate, true);
  });

  it("'Novos modelos da Mistral são lançados nesta semana' → true (plural, são lançados)", () => {
    const det = detectLaunchCandidate({
      title: "Novos modelos da Mistral são lançados nesta semana",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "mistral.ai");
  });

  it("'Copilot ganha nova versão com foco em produtividade' → true (ganha versão, Microsoft)", () => {
    const det = detectLaunchCandidate({
      title: "Copilot ganha nova versão com foco em produtividade",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "blogs.microsoft.com");
  });

  it("'Grok chega ao Brasil em parceria com operadoras locais' → true (chega ao <lugar>)", () => {
    const det = detectLaunchCandidate({
      title: "Grok chega ao Brasil em parceria com operadoras locais",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "x.ai");
  });

  // ---------------------------------------------------------------------
  // Calibração — falso-positivo (#4080 pediu cuidado explícito com "chega")
  // ---------------------------------------------------------------------

  it("'Mercado de IA da OpenAI chega a US$ 500 bilhões, aponta relatório' → false (estatística, não lançamento)", () => {
    const det = detectLaunchCandidate({
      title: "Mercado de IA da OpenAI chega a US$ 500 bilhões, aponta relatório",
    });
    assert.equal(det.is_candidate, false);
  });

  it("'ChatGPT chega a 800 milhões de usuários semanais, diz OpenAI' → false (marco de uso, não lançamento)", () => {
    const det = detectLaunchCandidate({
      title: "ChatGPT chega a 800 milhões de usuários semanais, diz OpenAI",
    });
    assert.equal(det.is_candidate, false);
  });

  it("'Anthropic: gasto com IA generativa chega a R$ 2 bilhões no Brasil' → false (estatística de mercado)", () => {
    const det = detectLaunchCandidate({
      title: "Anthropic: gasto com IA generativa chega a R$ 2 bilhões no Brasil",
    });
    assert.equal(det.is_candidate, false);
  });

  // ---------------------------------------------------------------------
  // Calibração — análise/opinião que só menciona um produto/empresa,
  // sem verbo de anúncio nem construção de lançamento.
  // ---------------------------------------------------------------------

  it("'Por que o Claude Opus 5 divide opiniões entre desenvolvedores' → false (análise/opinião)", () => {
    const det = detectLaunchCandidate({
      title: "Por que o Claude Opus 5 divide opiniões entre desenvolvedores",
    });
    assert.equal(det.is_candidate, false);
  });

  it("'Como a Anthropic pensa a segurança de modelos de fronteira' → false (opinião/posicionamento)", () => {
    const det = detectLaunchCandidate({
      title: "Como a Anthropic pensa a segurança de modelos de fronteira",
    });
    assert.equal(det.is_candidate, false);
  });

  it("'Entenda os bastidores da parceria entre OpenAI e Microsoft' → false (institucional, sem verbo de anúncio)", () => {
    const det = detectLaunchCandidate({
      title: "Entenda os bastidores da parceria entre OpenAI e Microsoft",
    });
    assert.equal(det.is_candidate, false);
  });

  it("'Google detalha como o Gemini funciona por trás das cortinas' → false (explicativo, sem verbo)", () => {
    const det = detectLaunchCandidate({
      title: "Google detalha como o Gemini funciona por trás das cortinas",
    });
    assert.equal(det.is_candidate, false);
  });
});
