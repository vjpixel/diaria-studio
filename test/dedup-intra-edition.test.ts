/**
 * dedup-intra-edition.test.ts (#2367)
 *
 * Testa o dedup INTRA-EDIÇÃO: remoção de itens de buckets secundários que
 * cobrem o mesmo evento de um destaque aprovado.
 *
 * Regressão principal: D1 "SpaceX compra o Cursor por US$ 60 bilhões"
 * (braziljournal) + RADAR "SpaceX compra Cursor..." (exame) — mesmo evento,
 * URLs diferentes → antes passava todas as guards existentes.
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
});
