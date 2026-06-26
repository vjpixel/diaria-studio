/**
 * check-intra-themes.test.ts (#2597)
 *
 * Testa detecção de clustering temático intra-edição.
 *
 * Casos reais (#2597):
 *   (a) Cluster "agentes de IA": 3 itens sobre o mesmo tema numa edição.
 *   (b) Secundário vs destaque: RADAR "Google jobtools" vs D3 "Gemini notebooks"
 *       — mesmo tema Google/ferramentas, mas abaixo do threshold do dedup-intra.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkIntraThemes,
  type CheckIntraThemesResult,
} from "../scripts/check-intra-themes.ts";

// ---------------------------------------------------------------------------
// Caso (a): cluster de 3 itens sobre agentes de IA (#2597)
// ---------------------------------------------------------------------------

describe("checkIntraThemes — cluster intra-secundários agentes de IA", () => {
  it("detecta cluster de 3 itens sobre agentes de IA", () => {
    const data = {
      highlights: [
        {
          rank: 1,
          url: "https://openai.com/o3-mini",
          article: { url: "https://openai.com/o3-mini", title: "OpenAI lança o3-mini para raciocínio" },
        },
      ],
      radar: [
        {
          url: "https://techcrunch.com/ai-agents-take-over",
          title: "Agentes de IA assumem tarefas autônomas em 2026",
        },
        {
          url: "https://venturebeat.com/enterprise-agents",
          title: "Empresas adotam agentes de IA para automação de processos",
        },
        {
          url: "https://wired.com/ai-agent-era",
          title: "A era dos agentes de IA: o que muda para os trabalhadores",
        },
        {
          url: "https://reuters.com/unrelated-topic",
          title: "Fed aumenta taxa de juros em 0.25 pontos percentuais",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const result = checkIntraThemes(data, 3);

    assert.ok(result.theme_clusters.length >= 1, "deve detectar pelo menos 1 cluster temático");
    const aiCluster = result.theme_clusters.find((c) => c.cluster_size >= 3);
    assert.ok(aiCluster, "deve detectar cluster com 3 itens sobre agentes de IA");
    assert.ok(
      aiCluster.items.some((it) => it.title.includes("Agentes de IA")),
      "cluster deve conter item sobre 'Agentes de IA'",
    );
    assert.ok(
      aiCluster.items.some((it) => it.title.includes("agentes de IA")),
      "cluster deve conter segundo item sobre agentes",
    );
  });

  it("não agrupa itens sobre temas diferentes", () => {
    const data = {
      highlights: [],
      radar: [
        { url: "https://tech.com/a", title: "Nubank lança cartão premium" },
        { url: "https://tech.com/b", title: "SpaceX consegue lançamento bem-sucedido de Starship" },
        { url: "https://tech.com/c", title: "Fed aumenta juros nos EUA" },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const result = checkIntraThemes(data, 3);
    const largeClusters = result.theme_clusters.filter((c) => c.cluster_size >= 2);
    assert.equal(largeClusters.length, 0, "temas diferentes não devem ser agrupados");
  });
});

// ---------------------------------------------------------------------------
// Caso (b): secundário vs destaque — Google jobtools vs Gemini notebooks (#2597)
// ---------------------------------------------------------------------------

describe("checkIntraThemes — secundário vs destaque Google/ferramentas", () => {
  it("sinaliza secundário Google quando D3 é também sobre Google/IA (empresa + tema parcialmente compartilhado)", () => {
    // Caso real #2597 simplificado: dois artigos sobre Google IA no mesmo dia,
    // Jaccard baixo (produtos diferentes) mas empresa compartilhada + tema AI/tools.
    // O check deve sinalizar quando há empresa + ao menos algum token temático em comum.
    const data = {
      highlights: [
        {
          rank: 1,
          url: "https://openai.com/o3",
          article: { url: "https://openai.com/o3", title: "OpenAI lança o3 para raciocínio avançado" },
        },
        {
          rank: 2,
          url: "https://anthropic.com/claude4",
          article: { url: "https://anthropic.com/claude4", title: "Anthropic lança Claude 4 com visão" },
        },
        {
          rank: 3,
          url: "https://blog.google/gemini-search-ai",
          article: {
            url: "https://blog.google/gemini-search-ai",
            title: "Google expande Gemini para busca inteligente com IA",
          },
        },
      ],
      radar: [
        {
          // Artigo RADAR sobre Google + busca — vocabulário parcialmente comum com D3
          url: "https://techcrunch.com/google-search-jobs",
          title: "Google usa IA para melhorar busca de empregos e recomendações",
        },
        {
          url: "https://reuters.com/fed-juros",
          title: "Fed sobe juros em reunião surpreendente",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const result = checkIntraThemes(data, 3);

    // Deve sinalizar o Google RADAR como tema similar ao D3 Google/Gemini/busca
    const googleWarnings = result.secondary_vs_highlight.filter(
      (w) => w.shared_companies.includes("google"),
    );
    assert.ok(
      googleWarnings.length >= 1,
      "deve sinalizar secundário Google/busca com tema similar ao destaque D3 Google/Gemini/busca",
    );
    const w = googleWarnings[0];
    assert.equal(w.secondary_url, "https://techcrunch.com/google-search-jobs");
    assert.ok(w.highlight_rank >= 1, "deve referenciar o destaque");
    assert.ok(w.jaccard < 0.45, "Jaccard deve estar abaixo do threshold do dedup-intra (0.45)");
  });

  it("não sinaliza secundário que já foi removido pelo dedup-intra (Jaccard >= 0.45)", () => {
    // Este item teria Jaccard alto o suficiente para o dedup-intra remover,
    // então não deve aparecer no secondary_vs_highlight
    const data = {
      highlights: [
        {
          rank: 1,
          url: "https://openai.com/gpt5",
          article: { url: "https://openai.com/gpt5", title: "OpenAI lança GPT-5 com raciocínio avançado" },
        },
      ],
      radar: [
        // Título muito similar ao destaque → dedup-intra removeria, não deve aparecer aqui
        {
          url: "https://techcrunch.com/gpt5",
          title: "OpenAI lança GPT-5 com raciocínio avançado e multimodalidade",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const result = checkIntraThemes(data, 3);
    // O item com Jaccard >= 0.45 NÃO deve aparecer no secondary_vs_highlight
    // (porque o dedup-intra já teria removido — só sinalizamos o que "escapou")
    const gpt5Warnings = result.secondary_vs_highlight.filter(
      (w) => w.secondary_url === "https://techcrunch.com/gpt5",
    );
    assert.equal(
      gpt5Warnings.length,
      0,
      "não deve sinalizar itens com Jaccard >= 0.45 (dedup-intra os remove)",
    );
  });

  it("não gera aviso quando não há overlap temático", () => {
    const data = {
      highlights: [
        {
          rank: 1,
          url: "https://openai.com/gpt5",
          article: { url: "https://openai.com/gpt5", title: "OpenAI lança GPT-5" },
        },
      ],
      radar: [
        { url: "https://reuters.com/fed", title: "Fed sobe juros em reunião surpresa" },
        { url: "https://g1.com/eleicoes", title: "Eleições 2026: pesquisas mostram empate técnico" },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const result = checkIntraThemes(data, 3);
    assert.equal(result.secondary_vs_highlight.length, 0, "sem overlap temático = sem aviso");
  });
});

// ---------------------------------------------------------------------------
// Output não dropa — só avisa
// ---------------------------------------------------------------------------

describe("checkIntraThemes — sinaliza, não dropa", () => {
  it("resultado contém theme_clusters e secondary_vs_highlight mas NÃO removed", () => {
    const data = {
      highlights: [],
      radar: [
        { url: "https://a.com", title: "Agentes de IA tomam decisões autônomas" },
        { url: "https://b.com", title: "IA agentes mudam o trabalho nas empresas" },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const result: CheckIntraThemesResult = checkIntraThemes(data, 3);

    // Deve ter theme_clusters (avisos) mas NÃO "removed" (não dropa nada)
    assert.ok("theme_clusters" in result, "deve ter theme_clusters");
    assert.ok("secondary_vs_highlight" in result, "deve ter secondary_vs_highlight");
    assert.ok(!("removed" in result), "NÃO deve ter campo 'removed' — não dropa itens");
    assert.ok(!("kept" in result), "NÃO deve ter campo 'kept' — não modifica a edição");
  });

  it("retorna counts corretos", () => {
    const data = {
      highlights: [
        { rank: 1, url: "https://h.com", article: { url: "https://h.com", title: "Destaque principal" } },
      ],
      radar: [
        { url: "https://a.com", title: "Item radar 1" },
        { url: "https://b.com", title: "Item radar 2" },
      ],
      lancamento: [{ url: "https://c.com", title: "Lançamento 1" }],
      use_melhor: [],
      video: [],
    };

    const result = checkIntraThemes(data, 3);
    assert.equal(result.candidates_checked, 3, "deve contar 3 itens secundários (radar×2 + lancamento×1)");
    assert.equal(result.highlights_checked, 1, "deve contar 1 destaque");
  });
});
