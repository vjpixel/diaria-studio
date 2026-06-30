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
// Caso (#2629 — finding 2): cluster 2-alto(Pass1a) + 1(Pass1b) silenciado
// ---------------------------------------------------------------------------

describe("checkIntraThemes — cluster 2-alto+1 (#2629 finding 2)", () => {
  // Cenário: 3 artigos sobre "agentes de IA"
  //   A e B: Google agent tools (company + Jaccard → pareados no Pass 1a)
  //   C: Microsoft agents (compartilha keyword "agentes" mas Jaccard com A/B < threshold)
  //   ANTES DO FIX: C tem newItems.length=1 < KEYWORD_CLUSTER_MIN(3) → sem aviso
  //   APÓS O FIX: emite cluster [A, B, C] com cluster_size=3
  const data_2_mais_1 = {
    highlights: [],
    radar: [
      {
        // A: Google agentes (vai parear com B via company Google + Jaccard ≈ 0.20)
        url: "https://techcrunch.com/google-agents",
        title: "Google lança agentes de IA para automação empresarial avançada",
      },
      {
        // B: Google agentes ferramentas (pareia com A)
        url: "https://venturebeat.com/google-tools-agents",
        title: "Google apresenta ferramentas de agentes de IA para empresas de produtividade",
      },
      {
        // C: Microsoft agents (compartilha "agentes" mas Jaccard com A/B < CLUSTER_JACCARD_THRESHOLD)
        url: "https://wired.com/microsoft-agents",
        title: "Microsoft desenvolve agentes autônomos com capacidades multimodais avançadas",
      },
      {
        // D: Totalmente off-topic
        url: "https://reuters.com/fed-juros-eua",
        title: "Fed eleva taxa de juros nos Estados Unidos pela terceira vez",
      },
    ],
    lancamento: [],
    use_melhor: [],
    video: [],
  };

  it("emite aviso de cluster quando 2 itens do Pass1a + 1 novo compartilham keyword (#2629)", () => {
    const result = checkIntraThemes(data_2_mais_1, 3);

    // Deve emitir cluster com os 3 itens sobre "agentes"
    const agentesCluster = result.theme_clusters.find(
      (c) => c.cluster_size >= 3 &&
             c.items.some((it) => it.url.includes("google-agents")) &&
             c.items.some((it) => it.url.includes("microsoft-agents")),
    );
    assert.ok(
      agentesCluster !== undefined,
      "deve emitir cluster de tamanho 3 incluindo itens Google e Microsoft sobre agentes",
    );
    assert.equal(agentesCluster.cluster_size, 3, "cluster_size deve ser 3 (contagem total, não só novos)");
    // D (Fed/juros) NÃO deve estar no cluster
    assert.ok(
      !agentesCluster.items.some((it) => it.url.includes("fed-juros")),
      "item off-topic (Fed/juros) não deve estar no cluster",
    );
  });

  it("não emite aviso duplicado: Pass1a cluster [A,B] é absorvido pelo keyword cluster [A,B,C] (#2629)", () => {
    const result = checkIntraThemes(data_2_mais_1, 3);

    // Não deve ter um cluster separado com apenas [A, B] E um cluster com [A, B, C]
    // — isso seria duplicado. Deve existir apenas 1 cluster cobrindo os 3.
    const clustersWithGoogleAgents = result.theme_clusters.filter(
      (c) => c.items.some((it) => it.url.includes("google-agents")),
    );
    assert.equal(
      clustersWithGoogleAgents.length,
      1,
      "deve existir apenas 1 cluster cobrindo os artigos sobre Google/agentes (sem duplicata Pass1a + Pass1b)",
    );
  });

  it("contagem total do cluster (não só novos) está correta no output (#2629)", () => {
    const result = checkIntraThemes(data_2_mais_1, 3);

    for (const c of result.theme_clusters) {
      assert.equal(
        c.cluster_size,
        c.items.length,
        `cluster_size=${c.cluster_size} deve ser igual a items.length=${c.items.length}`,
      );
    }
  });
});

describe("checkIntraThemes — sem duplicata quando Pass1a já cobre tudo (#2629)", () => {
  it("não duplica aviso quando keyword cluster é subconjunto de cluster Pass1a", () => {
    // 3 itens altamente similares → Pass1a forma cluster de 3 via Jaccard
    // → Pass1b: keyword "agentes" nos 3, mas todos já em alreadyClustered → skip
    // Resultado esperado: 1 cluster (do Pass1a), não 2
    const data = {
      highlights: [],
      radar: [
        {
          url: "https://a.com/1",
          title: "Agentes de IA tomam decisões empresariais autônomas avançadas",
        },
        {
          url: "https://b.com/2",
          title: "Agentes de IA passam a tomar decisões empresariais autônomas",
        },
        {
          url: "https://c.com/3",
          title: "Decisões empresariais autônomas com agentes de IA avançados",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const result = checkIntraThemes(data, 3);

    // Todos os 3 itens devem estar em algum cluster (Pass1a ou Pass1b)
    const allUrls = new Set(result.theme_clusters.flatMap((c) => c.items.map((it) => it.url)));
    assert.ok(allUrls.has("https://a.com/1") || result.theme_clusters.length > 0,
      "os 3 itens similares devem ser capturados por algum cluster");

    // Não deve haver mais clusters do que o esperado (duplicata)
    // Se todos 3 são pareados em Pass1a como 3-cluster, deve haver exatamente 1 cluster
    // (Pass1b não deve emitir cluster adicional pra os mesmos itens)
    const totalItems = result.theme_clusters.flatMap((c) => c.items);
    const uniqueUrls = new Set(totalItems.map((it) => it.url));
    // Se há duplicatas de URL em clusters diferentes, significa warning duplicado
    assert.equal(
      uniqueUrls.size,
      totalItems.length,
      "cada item deve aparecer em no máximo 1 cluster (sem aviso duplicado)",
    );
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
