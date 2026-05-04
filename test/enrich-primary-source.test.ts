import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectLaunchCandidate } from "../scripts/lib/launch-detect.ts";
import { enrichPrimarySource } from "../scripts/enrich-primary-source.ts";

describe("detectLaunchCandidate (#487)", () => {
  it("detecta launch verb (EN) + empresa conhecida em título", () => {
    const det = detectLaunchCandidate({
      title: "OpenAI launches GPT-5 with new reasoning model",
      url: "https://www.theverge.com/2026/05/01/openai-gpt5",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "openai.com");
    assert.match(det.matched_keyword!, /launch/i);
    assert.match(det.matched_company!, /openai|gpt/i);
  });

  it("detecta verbo PT (lança) + empresa", () => {
    const det = detectLaunchCandidate({
      title: "Anthropic lança Claude 4.7 com janela de 1M tokens",
      url: "https://canaltech.com.br/inteligencia-artificial/claude-47",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "anthropic.com");
  });

  it("não vira candidato se URL já é do domínio oficial", () => {
    const det = detectLaunchCandidate({
      title: "OpenAI launches Sora 2",
      url: "https://openai.com/blog/sora-2",
    });
    assert.equal(det.is_candidate, false);
  });

  it("não vira candidato se URL é do subdomínio oficial", () => {
    const det = detectLaunchCandidate({
      title: "Meta launches Llama 4",
      url: "https://ai.meta.com/blog/llama-4",
    });
    assert.equal(det.is_candidate, false);
  });

  it("não vira candidato sem verbo de lançamento", () => {
    const det = detectLaunchCandidate({
      title: "OpenAI's GPT-4 popularity continues to grow",
      summary: "Análise sobre adoção contínua",
    });
    assert.equal(det.is_candidate, false);
  });

  it("não vira candidato sem empresa identificável", () => {
    const det = detectLaunchCandidate({
      title: "Startup brasileira lança plataforma de IA",
      summary: "Politiza AI lança plataforma para campanhas eleitorais",
    });
    assert.equal(det.is_candidate, false);
  });

  it("usa summary como segundo pra empresa quando título é genérico", () => {
    const det = detectLaunchCandidate({
      title: "Novo modelo open-source é lançado esta semana",
      summary: "DeepSeek V4 chega com 1.6T parâmetros e 1M de contexto",
      url: "https://venturebeat.com/news/deepseek-v4",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "deepseek.com");
  });

  it("URL inválida é tratada como ausência de URL (regra 3 não bloqueia)", () => {
    const det = detectLaunchCandidate({
      title: "Mistral releases Codestral 2",
      url: "not-a-valid-url",
    });
    assert.equal(det.is_candidate, true);
    assert.equal(det.suggested_domain, "mistral.ai");
  });
});

describe("enrichPrimarySource", () => {
  it("flaga só artigos da bucket noticias", () => {
    const input = {
      lancamento: [],
      pesquisa: [
        { url: "https://arxiv.org/abs/x", title: "OpenAI releases new paper" },
      ],
      noticias: [
        {
          url: "https://venturebeat.com/x",
          title: "Anthropic launches Claude 4.7",
        },
        {
          url: "https://canaltech.com.br/y",
          title: "Aplicações de IA crescem no Brasil",
        },
      ],
    };
    const { output, flagged } = enrichPrimarySource(input);
    assert.equal(flagged, 1);
    assert.equal((output.noticias as { launch_candidate?: boolean }[])[0].launch_candidate, true);
    assert.equal((output.noticias as { launch_candidate?: boolean }[])[1].launch_candidate, undefined);
    // pesquisa não é tocada (mesmo com palavra "releases")
    assert.equal((output.pesquisa as { launch_candidate?: boolean }[])[0].launch_candidate, undefined);
  });

  it("preserva campos originais e adiciona suggested_primary_domain", () => {
    const input = {
      noticias: [
        {
          url: "https://techcrunch.com/x",
          title: "Mistral unveils Codestral 2 for code generation",
          summary: "Modelo focado em programação com 22B parâmetros",
          score: 75,
        },
      ],
    };
    const { output } = enrichPrimarySource(input);
    const a = (output.noticias as Array<Record<string, unknown>>)[0];
    assert.equal(a.score, 75);
    assert.equal(a.title, "Mistral unveils Codestral 2 for code generation");
    assert.equal(a.launch_candidate, true);
    assert.equal(a.suggested_primary_domain, "mistral.ai");
    assert.match(a.matched_launch_keyword as string, /unveil/i);
  });

  it("input sem noticias não quebra", () => {
    const { output, flagged } = enrichPrimarySource({ pesquisa: [], lancamento: [] });
    assert.equal(flagged, 0);
    assert.equal(output.noticias, undefined);
  });

  it("preserva campos extras top-level (clusters, etc)", () => {
    const input = {
      noticias: [],
      clusters: [{ id: 1 }],
      metadata: { foo: "bar" },
    };
    const { output } = enrichPrimarySource(input);
    assert.deepEqual(output.clusters, [{ id: 1 }]);
    assert.deepEqual(output.metadata, { foo: "bar" });
  });
});
