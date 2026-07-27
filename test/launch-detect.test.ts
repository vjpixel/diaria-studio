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
  // Calibração adicional (self-review PR #4134, finding 2) — "chega" em
  // sentido de aniversário/marco temporal, não lançamento. O bug de raiz era
  // o grupo de preposição (ao|à|as|no|na|para) casar como PREFIXO de palavra
  // ("aos" começa com "ao") — corrigido com lookahead `(?!\w)` exigindo
  // palavra inteira, mais um segundo lookahead excluindo "marca"/"número"
  // logo após a preposição (marco de uso, não lugar/lançamento).
  // ---------------------------------------------------------------------

  it("'Empresa chega aos 10 anos com nova rodada de investimento' → false (aniversário/marco temporal)", () => {
    const det = detectLaunchCandidate({
      title: "Empresa chega aos 10 anos com nova rodada de investimento",
      summary: "A Anthropic celebra a data com anúncio de expansão",
    });
    assert.equal(det.is_candidate, false);
  });

  it("'Base de assinantes da Anthropic chega à marca de 800 milhões de usuários' → false (marco de uso)", () => {
    const det = detectLaunchCandidate({
      title: "Base de assinantes da Anthropic chega à marca de 800 milhões de usuários",
    });
    assert.equal(det.is_candidate, false);
  });

  it("'xAI Grok chega ao mercado corporativo' → true (chega ao <lugar> continua lançamento)", () => {
    // Regressão de calibração: as travas do finding 2 não podem quebrar o
    // caso positivo original — "ao" como palavra inteira seguida de lugar
    // (não "marca"/"número") continua candidato.
    const det = detectLaunchCandidate({
      title: "xAI Grok chega ao mercado corporativo",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "x.ai");
  });

  // ---------------------------------------------------------------------
  // Voz passiva — futura e progressiva (self-review PR #4134, finding 3).
  // A cobertura original (#4080) só pegava a forma simples (é/foi/são/foram).
  // Faltavam futura ("será/serão lançado") e progressiva ("está/estão sendo
  // lançado", "vem/vêm sendo apresentado") — comuns em manchete de veículo
  // brasileiro cobrindo pré-lançamento confirmado.
  // ---------------------------------------------------------------------

  it("'Claude Opus 5 será lançado em setembro pela Anthropic' → true (futura, será lançado)", () => {
    const det = detectLaunchCandidate({
      title: "Claude Opus 5 será lançado em setembro pela Anthropic",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "anthropic.com");
  });

  it("'Novo modelo será anunciado pela OpenAI ainda este mês' → true (futura, será anunciado)", () => {
    const det = detectLaunchCandidate({
      title: "Novo modelo será anunciado pela OpenAI ainda este mês",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "openai.com");
  });

  it("'Gemini 3 está sendo lançado em fases pelo Google' → true (progressiva, está sendo lançado)", () => {
    const det = detectLaunchCandidate({
      title: "Gemini 3 está sendo lançado em fases pelo Google",
    });
    assert.equal(det.is_candidate, true);
  });

  it("'Copilot vem sendo apresentado em eventos da Microsoft' → true (progressiva, vem sendo apresentado)", () => {
    const det = detectLaunchCandidate({
      title: "Copilot vem sendo apresentado em eventos da Microsoft",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "blogs.microsoft.com");
  });

  it("'Modelos da Mistral estão sendo lançados nesta semana' → true (progressiva, plural)", () => {
    const det = detectLaunchCandidate({
      title: "Modelos da Mistral estão sendo lançados nesta semana",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "mistral.ai");
  });

  // Fronteira deliberada (finding 3): futura/progressiva cobre ANÚNCIO DE
  // FATO ("será lançado", "está sendo lançado"), não modal de especulação
  // ("deve chegar", "pode ser anunciado" — rumor, ainda sem confirmação).
  // "deve"/"pode" nunca entram no grupo de verbos, e o infinitivo
  // ("chegar"/"ser") não casa com as formas conjugadas exigidas pelos regexes
  // — por construção, não por lista de exclusão.

  it("'Novo iPhone dobrável deve chegar em 2027, dizem rumores' → false (modal, especulação — não anúncio consumado)", () => {
    const det = detectLaunchCandidate({
      title: "Novo iPhone dobrável deve chegar em 2027, dizem rumores",
    });
    assert.equal(det.is_candidate, false);
  });

  it("'Modelo da OpenAI pode ser anunciado ainda este ano, aponta site' → false (modal, especulação)", () => {
    const det = detectLaunchCandidate({
      title: "Modelo da OpenAI pode ser anunciado ainda este ano, aponta site",
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
