/**
 * dedup-intra-edition.test.ts (#2367, #2397)
 *
 * Testa o dedup INTRA-EDIÇÃO: remoção de itens de buckets secundários que
 * cobrem o mesmo evento de um destaque aprovado.
 *
 * Regressão principal (#2367): D1 "SpaceX compra o Cursor por US$ 60 bilhões"
 * (braziljournal) + RADAR "SpaceX compra Cursor..." (exame) — mesmo evento,
 * URLs diferentes → antes passava todas as guards existentes.
 *
 * Regressão #2397 (260618 real):
 * (a) 3 itens "- Finsiders Brasil" distintos (Mercado de SaaS, Open Assets,
 *     Fintechs/PicPay) eram incorretamente removidos como duplicatas do
 *     highlight "Nubank ... - Finsiders Brasil" — sufixo de veículo virava
 *     entidades compartilhadas.
 * (b) Dedup rodava contra os 6 candidatos do scorer (não os 3 destaques finais)
 *     — item podia ser removido por match com candidato rank 4–6 não-promovido.
 * (c) extractNamedEntities pulava index-0 → "SpaceX" no início do título do
 *     artigo RADAR não era capturado → par SpaceX/Cursor não era detectado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dedupIntraEdition,
  isIntraEditionDuplicate,
  highlightTitle,
  highlightUrl,
  INTRA_JACCARD_THRESHOLD,
  INTRA_ENTITY_MIN_SHARED,
  DEFAULT_INTRA_DESTAQUE_COUNT,
  extractNamedEntitiesIntra,
  stripVehicleSuffix,
} from "../scripts/dedup-intra-edition.ts";

// ---------------------------------------------------------------------------
// Regressão 260618: SpaceX/Cursor (caso real)
// ---------------------------------------------------------------------------

describe("dedup-intra-edition — regressão #2367 SpaceX/Cursor 260618", () => {
  it("remove RADAR SpaceX/Cursor quando D1 já cobre o mesmo evento", () => {
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://braziljournal.com/spacex-compra-cursor",
          article: {
            url: "https://braziljournal.com/spacex-compra-cursor",
            title: "SpaceX compra o Cursor por US$ 60 bilhões",
          },
        },
      ],
      radar: [
        {
          url: "https://exame.com/spacex-cursor-aquisicao",
          title: "SpaceX compra Cursor por US$ 60 bilhões em grande aquisição",
        },
        {
          url: "https://techcrunch.com/openai-o3-release",
          title: "OpenAI lança o modelo o3",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    assert.equal(removed.length, 1, "exatamente 1 item deve ser removido");
    assert.equal(removed[0].url, "https://exame.com/spacex-cursor-aquisicao");
    assert.equal(removed[0].bucket, "radar");
    assert.ok(
      removed[0].matched_highlight.includes("SpaceX"),
      "deve referenciar o destaque D1",
    );

    assert.equal(kept.radar?.length, 1, "RADAR deve ter 1 item restante");
    assert.equal(
      kept.radar?.[0].url,
      "https://techcrunch.com/openai-o3-release",
      "item não-relacionado deve ser preservado",
    );

    // D1 preservado
    assert.equal(kept.highlights?.length, 1, "destaques não são alterados");
    assert.equal(
      kept.highlights?.[0].url,
      "https://braziljournal.com/spacex-compra-cursor",
    );
  });

  it("preserva destaque quando não há duplicata no RADAR", () => {
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://braziljournal.com/spacex-compra-cursor",
          article: {
            url: "https://braziljournal.com/spacex-compra-cursor",
            title: "SpaceX compra o Cursor por US$ 60 bilhões",
          },
        },
      ],
      radar: [
        {
          url: "https://wired.com/apple-wwdc-2026",
          title: "Apple anuncia novidades no WWDC 2026",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    assert.equal(removed.length, 0, "nenhum item deve ser removido");
    assert.equal(kept.radar?.length, 1, "RADAR preservado integralmente");
  });
});

// ---------------------------------------------------------------------------
// isIntraEditionDuplicate — testes unitários
// ---------------------------------------------------------------------------

describe("isIntraEditionDuplicate", () => {
  const highlights = [
    {
      rank: 1,
      url: "https://braziljournal.com/spacex-cursor",
      title: "SpaceX compra o Cursor por US$ 60 bilhões",
    },
    {
      rank: 2,
      url: "https://techcrunch.com/openai-gpt5",
      title: "OpenAI lança GPT-5 com capacidade de raciocínio avançada",
    },
  ];

  it("detecta duplicata por Jaccard alto (mesmo evento, fontes diferentes)", () => {
    const article = {
      url: "https://exame.com/spacex-cursor",
      title: "SpaceX compra Cursor por US$ 60 bilhões em grande aquisição",
    };
    const result = isIntraEditionDuplicate(article, highlights);
    assert.ok(result !== null, "deve detectar duplicata");
    assert.equal(result!.match_type, "jaccard");
    assert.ok(result!.score >= INTRA_JACCARD_THRESHOLD);
  });

  it("detecta duplicata por entity overlap (≥2 entidades compartilhadas)", () => {
    // Entidades que NÃO estão no ENTITY_STOPWORDS: Palantir, Databricks.
    // OpenAI/GPT/Llama/Nvidia estão em ENTITY_STOPWORDS e NÃO contam.
    // Tanto destaque quanto artigo devem ter as entidades FORA do índice 0.
    const highlightsWithNonStopwords = [
      {
        rank: 1,
        url: "https://reuters.com/palantir-databricks-deal",
        // "Acordo" → index 0, skip. "Palantir" index 2, "Databricks" index 4.
        title: "Acordo entre Palantir e Databricks transforma analise de dados",
      },
    ];
    // Vocabulário diferente mas mesmas entidades (Palantir + Databricks, ambas no meio)
    const article = {
      url: "https://techcrunch.com/databricks-palantir-agreement",
      // "Parceria" → index 0 skip. "Databricks" index 2, "Palantir" index 4.
      title: "Parceria entre Databricks e Palantir redefine infraestrutura corporativa",
    };
    const result = isIntraEditionDuplicate(article, highlightsWithNonStopwords);
    assert.ok(result !== null, "deve detectar duplicata por entity overlap");
    assert.equal(result!.match_type, "entity");
  });

  it("não detecta duplicata para evento diferente", () => {
    const article = {
      url: "https://bloomberg.com/tesla-recall",
      title: "Tesla anuncia recall de veículos elétricos",
    };
    const result = isIntraEditionDuplicate(article, highlights);
    assert.equal(result, null, "não deve detectar duplicata para evento diferente");
  });

  it("não detecta duplicata quando artigo tem mesmo URL que destaque", () => {
    // Destaque pode aparecer no bucket também (duplicata de URL é diferente)
    const article = {
      url: "https://braziljournal.com/spacex-cursor",
      title: "SpaceX compra o Cursor por US$ 60 bilhões",
    };
    const result = isIntraEditionDuplicate(article, highlights);
    assert.equal(result, null, "mesmo URL = não é intra-edition dup (é URL dup, tratado por dedup.ts)");
  });

  it("não detecta duplicata quando artigo não tem título", () => {
    const article = { url: "https://example.com/no-title" };
    const result = isIntraEditionDuplicate(article, highlights);
    assert.equal(result, null, "artigo sem título não deve gerar falso-positivo");
  });

  it("não detecta duplicata com lista de destaques vazia", () => {
    const article = { url: "https://example.com/test", title: "SpaceX compra Cursor" };
    const result = isIntraEditionDuplicate(article, []);
    assert.equal(result, null, "lista vazia = sem duplicata");
  });
});

// ---------------------------------------------------------------------------
// dedupIntraEdition — casos gerais
// ---------------------------------------------------------------------------

describe("dedupIntraEdition — comportamento geral", () => {
  it("sem destaques → nenhuma remoção", () => {
    const input = {
      highlights: [],
      radar: [{ url: "https://a.com/1", title: "SpaceX compra algo" }],
      lancamento: [],
      use_melhor: [],
      video: [],
    };
    const { kept, removed } = dedupIntraEdition(input);
    assert.equal(removed.length, 0);
    assert.equal(kept.radar?.length, 1);
  });

  it("sem buckets secundários → nenhuma remoção", () => {
    const input = {
      highlights: [{ rank: 1, url: "https://a.com/h1", title: "Destaque principal" }],
      radar: [],
      lancamento: [],
      use_melhor: [],
      video: [],
    };
    const { kept, removed } = dedupIntraEdition(input);
    assert.equal(removed.length, 0);
    assert.equal(kept.highlights?.length, 1);
  });

  it("preserva campos extras do input (clusters, etc)", () => {
    const input = {
      highlights: [{ rank: 1, url: "https://a.com/h1", title: "Destaque X" }],
      radar: [],
      lancamento: [],
      use_melhor: [],
      video: [],
      clusters: [{ id: 1, members: ["https://a.com/h1"] }],
      metadata: { edition: "260618" },
    };
    const { kept } = dedupIntraEdition(input);
    assert.deepEqual(
      (kept as { clusters: unknown[] }).clusters,
      input.clusters,
      "clusters deve ser preservado",
    );
    assert.deepEqual(
      (kept as { metadata: unknown }).metadata,
      input.metadata,
      "metadata arbitrária deve ser preservada",
    );
  });

  it("remove do bucket correto (lancamento vs radar)", () => {
    const input = {
      highlights: [
        { rank: 1, url: "https://a.com/h1", title: "Apple lança iPhone 17 com chip M4" },
      ],
      radar: [
        { url: "https://b.com/unrelated", title: "Google Maps adiciona modo offline" },
      ],
      lancamento: [
        // Mesmo evento que o destaque — deve ser removido
        { url: "https://c.com/iphone17", title: "Apple anuncia iPhone 17 com M4 chip" },
      ],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    assert.equal(removed.length, 1);
    assert.equal(removed[0].bucket, "lancamento");
    assert.equal(kept.radar?.length, 1, "RADAR não afetado");
    assert.equal(kept.lancamento?.length, 0, "LANÇAMENTOS: duplicata removida");
  });

  it("remove de múltiplos buckets quando necessário", () => {
    // Usar títulos com alta sobreposição de tokens para Jaccard ≥0.45
    const input = {
      highlights: [
        { rank: 1, url: "https://main.com/apple-vision", title: "Apple Vision Pro chega ao Brasil por R$ 29.999" },
      ],
      radar: [
        // Jaccard alto: "Apple Vision Pro Brasil" shared tokens
        { url: "https://r1.com/apple-vision-2", title: "Apple Vision Pro lançado no Brasil custando R$ 29.999" },
        { url: "https://r2.com/unrelated", title: "Banco Central do Brasil anuncia nova política monetária" },
      ],
      lancamento: [
        // Também dup
        { url: "https://l1.com/apple-vision-3", title: "Apple Vision Pro Brasil R$ 29.999 disponível nas lojas" },
      ],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    assert.equal(removed.length, 2, "deve remover 1 de radar + 1 de lancamento");
    const buckets = removed.map((r) => r.bucket).sort();
    assert.deepEqual(buckets, ["lancamento", "radar"]);
    assert.equal(kept.radar?.length, 1, "1 item não-relacionado preservado no radar");
    assert.equal(kept.lancamento?.length, 0, "lançamento dup removido");
  });
});

// ---------------------------------------------------------------------------
// highlightTitle / highlightUrl — helpers
// ---------------------------------------------------------------------------

describe("highlightTitle e highlightUrl", () => {
  it("extrai título do campo title direto", () => {
    assert.equal(highlightTitle({ title: "Meu Destaque" }), "Meu Destaque");
  });

  it("extrai título do campo article.title (shape legado)", () => {
    assert.equal(
      highlightTitle({ article: { url: "u", title: "Do article" } }),
      "Do article",
    );
  });

  it("retorna null quando ambos ausentes", () => {
    assert.equal(highlightTitle({}), null);
  });

  it("extrai URL do campo url direto", () => {
    assert.equal(highlightUrl({ url: "https://a.com" }), "https://a.com");
  });

  it("extrai URL do campo article.url", () => {
    assert.equal(
      highlightUrl({ article: { url: "https://b.com" } }),
      "https://b.com",
    );
  });
});

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

describe("thresholds exportados", () => {
  it("INTRA_JACCARD_THRESHOLD é 0.45", () => {
    assert.equal(INTRA_JACCARD_THRESHOLD, 0.45);
  });

  it("INTRA_ENTITY_MIN_SHARED é 2", () => {
    assert.equal(INTRA_ENTITY_MIN_SHARED, 2);
  });

  it("DEFAULT_INTRA_DESTAQUE_COUNT é 3", () => {
    assert.equal(DEFAULT_INTRA_DESTAQUE_COUNT, 3);
  });
});

// ---------------------------------------------------------------------------
// #2397: stripVehicleSuffix
// ---------------------------------------------------------------------------

describe("stripVehicleSuffix (#2397)", () => {
  it("strip sufixo '- Finsiders Brasil'", () => {
    assert.equal(
      stripVehicleSuffix("Nubank prepara assistente financeiro com IA - Finsiders Brasil"),
      "Nubank prepara assistente financeiro com IA",
    );
  });

  it("strip sufixo '- Exame'", () => {
    assert.equal(
      stripVehicleSuffix("SpaceX compra Cursor em aposta de US$ 60 bilhões - Exame"),
      "SpaceX compra Cursor em aposta de US$ 60 bilhões",
    );
  });

  it("strip sufixo '- Brazil Journal'", () => {
    assert.equal(
      stripVehicleSuffix("Por que a SpaceX comprou o Cursor - Brazil Journal"),
      "Por que a SpaceX comprou o Cursor",
    );
  });

  it("não altera título sem sufixo de veículo", () => {
    assert.equal(
      stripVehicleSuffix("SpaceX compra Cursor em aposta de US$ 60 bilhões na IA"),
      "SpaceX compra Cursor em aposta de US$ 60 bilhões na IA",
    );
  });

  it("não strip hífen ordinário dentro do título", () => {
    // Hífen dentro da frase sem "- Palavra Capitalizada" no final não é strip
    assert.equal(
      stripVehicleSuffix("Open Assets: o plano do BC"),
      "Open Assets: o plano do BC",
    );
  });
});

// ---------------------------------------------------------------------------
// #2397: extractNamedEntitiesIntra — strip de veículo + não pula index-0
// ---------------------------------------------------------------------------

describe("extractNamedEntitiesIntra (#2397)", () => {
  it("NÃO inclui sufixo de veículo como entidade", () => {
    const ents = extractNamedEntitiesIntra(
      "Nubank prepara assistente financeiro com IA para clientes - Finsiders Brasil",
    );
    assert.ok(!ents.has("finsiders"), "finsiders não deve ser entidade");
    assert.ok(!ents.has("brasil"), "brasil não deve ser entidade");
    assert.ok(ents.has("nubank"), "nubank deve ser entidade");
  });

  it("NÃO inclui sufixo 'Finsiders Brasil' de itens distintos", () => {
    // Todos os 3 itens Finsiders da edição 260618
    const saasEnts = extractNamedEntitiesIntra(
      "Mercado de SaaS na América Latina pode atingir US$ 46 bi até 2027, aponta Acorn - Finsiders Brasil",
    );
    const openAssetsEnts = extractNamedEntitiesIntra(
      "'Open Assets': o plano do BC para além dos recebíveis de cartões - Finsiders Brasil",
    );
    const fintechEnts = extractNamedEntitiesIntra(
      "Fintechs fecham semana no azul e PicPay lidera com alta de 16% - Finsiders Brasil",
    );
    for (const ents of [saasEnts, openAssetsEnts, fintechEnts]) {
      assert.ok(!ents.has("finsiders"), "finsiders não deve ser entidade");
      assert.ok(!ents.has("brasil"), "brasil não deve ser entidade");
    }
  });

  it("captura empresa em index-0 (não pula a primeira palavra)", () => {
    // 'SpaceX' está em index-0 em "SpaceX compra Cursor..."
    const ents = extractNamedEntitiesIntra("SpaceX compra Cursor em aposta de US$ 60 bilhões na IA");
    assert.ok(ents.has("spacex"), "spacex (index-0) deve ser capturado");
    assert.ok(ents.has("cursor"), "cursor deve ser capturado");
  });

  it("detecta entidades do par SpaceX/Cursor para entity-match", () => {
    const hEnts = extractNamedEntitiesIntra("Por que a SpaceX comprou o Cursor");
    const artEnts = extractNamedEntitiesIntra("SpaceX compra Cursor em aposta de US$ 60 bilhões na IA");
    const shared = [...hEnts].filter(e => artEnts.has(e));
    assert.ok(shared.length >= 2, `deve ter ≥2 entidades compartilhadas, got: [${shared.join(", ")}]`);
    assert.ok(shared.includes("spacex"), "spacex deve estar no shared");
    assert.ok(shared.includes("cursor"), "cursor deve estar no shared");
  });
});

// ---------------------------------------------------------------------------
// #2397: destaqueCount — dedup só contra top-N highlights por rank
// ---------------------------------------------------------------------------

describe("dedupIntraEdition — destaqueCount (#2397)", () => {
  // Simula a situação real 260618:
  // - Nubank está em rank=4 (candidato, não promovido pelo editor)
  // - 3 itens "- Finsiders Brasil" DISTINTOS no RADAR
  // - Com bug: eram removidos por match com Nubank (rank-4)
  // - Com fix (destaqueCount=3): Nubank rank-4 excluído da comparação → preservados
  const finsidersHighlights = [
    { rank: 1, url: "https://braziljournal.com/spacex-cursor", title: "Por que a SpaceX comprou o Cursor" },
    { rank: 2, url: "https://tech.com/microsoft-trump", title: "Microsoft desafia Trump e pode trocar IA americana por rival chinesa" },
    { rank: 3, url: "https://health.com/amie", title: "New research shows how AMIE, our medical AI, could help manage health conditions." },
    // rank=4: Nubank — editor NÃO vai promover este
    { rank: 4, url: "https://finsiders.com/nubank-ia", title: "Nubank prepara assistente financeiro com IA para clientes - Finsiders Brasil" },
    { rank: 5, url: "https://tech.com/ms-ia", title: "Microsoft lança IA colega de trabalho que faz tarefas sozinho com PC desligado" },
    { rank: 6, url: "https://ml.com/glm", title: "GLM-5.2: Built for Long-Horizon Tasks" },
  ];

  const finsidersRadar = [
    { url: "https://finsiders.com/saas", title: "Mercado de SaaS na América Latina pode atingir US$ 46 bi até 2027, aponta Acorn - Finsiders Brasil" },
    { url: "https://finsiders.com/open-assets", title: "'Open Assets': o plano do BC para além dos recebíveis de cartões - Finsiders Brasil" },
    { url: "https://finsiders.com/fintechs", title: "Fintechs fecham semana no azul e PicPay lidera com alta de 16% - Finsiders Brasil" },
  ];

  it("com destaqueCount=3: NÃO remove os 3 itens Finsiders distintos", () => {
    const input = {
      highlights: finsidersHighlights,
      radar: [...finsidersRadar],
      lancamento: [],
      use_melhor: [],
      video: [],
    };
    const { kept, removed } = dedupIntraEdition(input, { destaqueCount: 3 });

    const finsidersRemoved = removed.filter(r =>
      (r.title ?? "").includes("Finsiders"),
    );
    assert.equal(
      finsidersRemoved.length,
      0,
      `Nenhum item Finsiders deve ser removido, mas foram removidos: ${finsidersRemoved.map(r => r.title).join(", ")}`,
    );
    assert.equal(kept.radar?.length, 3, "todos os 3 itens Finsiders preservados");
  });

  it("com destaqueCount=6 (bug original): remove incorretamente os itens Finsiders", () => {
    // Documenta o comportamento pré-fix para validar que a regressão está coberta
    const input = {
      highlights: finsidersHighlights,
      radar: [...finsidersRadar],
      lancamento: [],
      use_melhor: [],
      video: [],
    };
    // destaqueCount=6 inclui rank-4 (Nubank) na comparação
    // Com a entidade compartilhada "finsiders"/"brasil" (antes do fix),
    // os 3 itens seriam removidos. Com o fix do extractNamedEntitiesIntra,
    // mesmo com destaqueCount=6 eles NÃO devem ser removidos pois o sufixo
    // de veículo é stripped.
    const { kept } = dedupIntraEdition(input, { destaqueCount: 6 });
    // Com o fix de extractNamedEntitiesIntra, sufixo é stripped em ambos lados:
    // Nubank (rank-4) após strip tem só {nubank}; itens Finsiders após strip
    // têm {mercado, saas, america, latina, acorn} / {assets} / {fintechs, picpay}
    // → shared < 2 → NÃO removidos mesmo com destaqueCount=6
    assert.equal(kept.radar?.length, 3, "com fix de sufixo: itens Finsiders preservados mesmo com destaqueCount=6");
  });

  it("com destaqueCount=3: ainda remove SpaceX/Cursor duplicata (rank-1 incluído)", () => {
    const input = {
      highlights: finsidersHighlights,
      radar: [
        { url: "https://exame.com/spacex-cursor", title: "SpaceX compra Cursor em aposta de US$ 60 bilhões na IA" },
        ...finsidersRadar,
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };
    const { removed } = dedupIntraEdition(input, { destaqueCount: 3 });

    const spacexRemoved = removed.filter(r => (r.title ?? "").includes("SpaceX"));
    assert.equal(spacexRemoved.length, 1, "SpaceX/Cursor duplicata deve ser removida");
    assert.equal(spacexRemoved[0].bucket, "radar");
  });

  it("destaqueCount padrão é DEFAULT_INTRA_DESTAQUE_COUNT (3)", () => {
    // Verifica que dedupIntraEdition sem options usa 3 highlights por default
    const input = {
      highlights: finsidersHighlights, // 6 highlights
      radar: [...finsidersRadar],
      lancamento: [],
      use_melhor: [],
      video: [],
    };
    const { kept: keptDefault } = dedupIntraEdition(input); // sem options
    const { kept: keptExplicit3 } = dedupIntraEdition(input, { destaqueCount: 3 });

    assert.deepEqual(
      keptDefault.radar?.map(r => r.url),
      keptExplicit3.radar?.map(r => r.url),
      "comportamento sem options deve ser igual a destaqueCount=3",
    );
  });

  it("sort por rank funciona quando rank é numérico", () => {
    // Inverte a ordem dos highlights — destaqueCount=1 deve pegar rank=1
    const shuffledHighlights = [
      { rank: 3, url: "https://h3.com", title: "H3 outro tema completamente diferente" },
      { rank: 1, url: "https://spacex.com/cursor", title: "SpaceX compra Cursor por US$ 60 bilhões" },
      { rank: 2, url: "https://h2.com", title: "H2 outro tema completamente diferente" },
    ];
    const input = {
      highlights: shuffledHighlights,
      radar: [
        { url: "https://exame.com/spacex", title: "SpaceX compra Cursor em aposta bilionária" },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };
    // Com destaqueCount=1, só rank=1 (SpaceX) é comparado → duplicata removida
    const { removed: removed1 } = dedupIntraEdition(input, { destaqueCount: 1 });
    assert.equal(removed1.length, 1, "com destaqueCount=1, rank-1 comparado → duplicata removida");

    // Com destaqueCount=0 — edge case, nenhum highlight comparado
    const inputWith0 = { ...input, highlights: [] };
    const { removed: removed0 } = dedupIntraEdition(inputWith0, { destaqueCount: 3 });
    assert.equal(removed0.length, 0, "sem highlights: nenhuma remoção");
  });
});
