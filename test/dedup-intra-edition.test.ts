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
  INTRA_DOMAIN_JACCARD_MIN,
  DEFAULT_INTRA_DESTAQUE_COUNT,
  extractNamedEntitiesIntra,
  extractProductEntitiesIntra,
  extractCompanyMentionsIntra,
  extractProductCodeTokens,
  highlightSummary,
  stripVehicleSuffix,
  isPressCovertageOfHighlight,
  CROSS_EDITION_TERM_MIN_LEN,
  CROSS_EDITION_TERM_MIN_SHARED,
} from "../scripts/dedup-intra-edition.ts";
import { tokenizeForJaccard, jaccardSimilarity } from "../scripts/lib/title-similarity.ts";

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

  it("#2406: Jaccard não dispara por sufixo de veículo compartilhado (títulos distintos, mesmo veículo)", () => {
    // Antes do #2406: tokens "finsiders"/"brasil"/"tecnologia" do sufixo
    // participavam do Jaccard → 2 títulos curtos do mesmo veículo cruzavam 0.45
    // só pelo sufixo. Após strip antes de tokenizar, o sinal é só do conteúdo.
    const article = {
      url: "https://fb.com/cripto",
      title: "Cripto despenca - Finsiders Brasil Tecnologia",
    };
    const highlights = [
      {
        rank: 1,
        url: "https://fb.com/robotica",
        title: "Robótica avança - Finsiders Brasil Tecnologia",
      },
    ];
    const result = isIntraEditionDuplicate(article, highlights);
    assert.equal(
      result,
      null,
      "títulos com conteúdo distinto não devem casar só pelo sufixo de veículo compartilhado",
    );
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

  it("#2406: NÃO over-strip — preserva ' - CapWord' do meio quando há sufixo de veículo no fim", () => {
    // O sufixo só pode pegar o ÚLTIMO ' - ' (sem ' - ' interno), então
    // "- OpenAI e Meta" do meio é preservado; só "- Exame" é removido.
    assert.equal(
      stripVehicleSuffix("Governo lança IA - OpenAI e Meta - Exame"),
      "Governo lança IA - OpenAI e Meta",
    );
  });

  it("#2406: strip sufixo de 3 palavras (MIT Technology Review)", () => {
    assert.equal(
      stripVehicleSuffix("MIT cria robô - MIT Technology Review"),
      "MIT cria robô",
    );
  });

  it("#2406: NÃO strip oração longa capitalizada (>3 palavras após ' - ')", () => {
    // Sufixos de veículo têm ≤3 palavras; uma oração longa não é veículo.
    assert.equal(
      stripVehicleSuffix("Empresa cresce - Por Que Isso Importa Demais"),
      "Empresa cresce - Por Que Isso Importa Demais",
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

  it("#2406: big-tech de alta frequência não conta como entidade discriminante", () => {
    // "Microsoft" sozinho não deve disparar entity-match entre histórias
    // diferentes da mesma empresa — o evento precisa de 2ª entidade.
    const ents = extractNamedEntitiesIntra("Microsoft anuncia parceria com Anthropic");
    assert.ok(!ents.has("microsoft"), "microsoft é stopword (alta frequência)");
    assert.ok(!ents.has("anthropic"), "anthropic é stopword (alta frequência)");
  });

  it("#2406: 2 itens distintos da mesma big-tech NÃO casam por entity só pelo nome da empresa", () => {
    const h = extractNamedEntitiesIntra("Microsoft lança Copilot para Excel");
    const a = extractNamedEntitiesIntra("Microsoft processada por antitruste na Europa");
    const shared = [...a].filter(e => h.has(e));
    assert.ok(shared.length < 2, `não deve compartilhar ≥2 entidades, got: [${shared.join(", ")}]`);
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
// #2587: extractProductEntitiesIntra — inclui produto, exclui só empresa+genérico
// ---------------------------------------------------------------------------

describe("extractProductEntitiesIntra (#2587)", () => {
  it("INCLUI nome de produto (Gemini) que extractNamedEntitiesIntra exclui", () => {
    const general = extractNamedEntitiesIntra("Google lança Gemini computer use");
    const product = extractProductEntitiesIntra("Google lança Gemini computer use");
    assert.ok(!general.has("gemini"), "entity-geral exclui 'gemini' (stopword de produto)");
    assert.ok(product.has("gemini"), "entity-de-produto INCLUI 'gemini'");
  });

  it("EXCLUI nome de empresa (Google/Microsoft) — empresa já vem do domínio", () => {
    const product = extractProductEntitiesIntra("Google e Microsoft anunciam GPT-5 juntos");
    assert.ok(!product.has("google"), "'google' é stopword de empresa");
    assert.ok(!product.has("microsoft"), "'microsoft' é stopword de empresa");
    assert.ok(product.has("gpt5"), "'gpt5' (produto) é capturado");
  });

  it("EXCLUI termos genéricos (IA, dias, meses)", () => {
    const product = extractProductEntitiesIntra("IA da Segunda em Janeiro muda tudo");
    assert.ok(!product.has("ia"), "'ia' é genérico");
    assert.ok(!product.has("segunda"), "dia-da-semana é genérico");
    assert.ok(!product.has("janeiro"), "mês é genérico");
  });

  it("2 lançamentos da mesma empresa não compartilham entidade de produto", () => {
    const a = extractProductEntitiesIntra("Google lança Pixel 9 Pro");
    const b = extractProductEntitiesIntra("Google anuncia Android 16");
    const shared = [...a].filter(e => b.has(e));
    assert.equal(shared.length, 0, `não deve compartilhar produto, got: [${shared.join(", ")}]`);
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

  it("defense-in-depth: strip de sufixo preserva Finsiders mesmo com destaqueCount=6 (rank-4 Nubank incluído)", () => {
    // Os 2 fixes do #2397 são independentes e complementares:
    //  (1) top-N por rank exclui o candidato Nubank (rank-4) da comparação;
    //  (2) strip de sufixo de veículo evita o falso-match mesmo se Nubank for
    //      comparado. Este teste isola o fix (2): força destaqueCount=6 (Nubank
    //      ENTRA na comparação) e confirma que os itens Finsiders AINDA são
    //      preservados — porque o sufixo "- Finsiders Brasil" é stripado em ambos
    //      os lados. Nubank (rank-4) após strip = {nubank}; itens Finsiders após
    //      strip = {mercado, saas, america, latina, acorn} / {assets} /
    //      {fintechs, picpay} → shared < 2 → NÃO removidos.
    const input = {
      highlights: finsidersHighlights,
      radar: [...finsidersRadar],
      lancamento: [],
      use_melhor: [],
      video: [],
    };
    const { kept, removed } = dedupIntraEdition(input, { destaqueCount: 6 });
    const finsidersRemoved = removed.filter(r => (r.title ?? "").includes("Finsiders"));
    assert.equal(
      finsidersRemoved.length,
      0,
      `fix de sufixo: nenhum item Finsiders removido mesmo com destaqueCount=6, mas removidos: ${finsidersRemoved.map(r => r.title).join(", ")}`,
    );
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

// ---------------------------------------------------------------------------
// #2548 Furo 2: domain-based match via suggested_primary_domain
// Regressão: canaltech.com.br/google-libera-ia-que-consegue-mexer-no-computador
// = cobertura de imprensa do D1 (blog.google.com/gemini-computer-use).
// Entidades Google/Gemini estão no ENTITY_STOPWORDS_INTRA → entity-check falha.
// Jaccard falha porque os títulos divergem muito.
// Fix: usar suggested_primary_domain do RADAR para match pelo domínio do D1.
// ---------------------------------------------------------------------------

import {
  extractRegistrableDomain,
  isPressCovertageOfHighlight,
} from "../scripts/dedup-intra-edition.ts";

describe("extractRegistrableDomain (#2548 Furo 2)", () => {
  it("extrai eTLD+1 de URL de blog de empresa", () => {
    assert.equal(extractRegistrableDomain("https://blog.google.com/products/gemini"), "google.com");
    assert.equal(extractRegistrableDomain("https://openai.com/research/x"), "openai.com");
    // research.google → .google é um TLD; extrai os 2 últimos segmentos = "research.google".
    // NÃO está no DOMAIN_ALIASES (#2580) — não é primary_domain de nenhuma entrada em
    // official-domains.ts (o primary_domain do Google é "blog.google", não "research.google").
    // Manter "research.google" como saída é correto — falso-negativo aceitável (só perde match,
    // não gera falso-positivo) e a chance real de conflito é baixa (suggested_primary_domain
    // para Google vem de "blog.google" via companyToDomain(), não de "research.google").
    assert.equal(extractRegistrableDomain("https://research.google/"), "research.google");
  });

  it("extrai eTLD+1 de URL de veículo de imprensa", () => {
    assert.equal(extractRegistrableDomain("https://canaltech.com.br/ia/google-libera"), "com.br");
    assert.equal(extractRegistrableDomain("https://techcrunch.com/story"), "techcrunch.com");
    assert.equal(extractRegistrableDomain("https://exame.com/tecnologia"), "exame.com");
  });

  it("retorna null para URL inválida", () => {
    assert.equal(extractRegistrableDomain("not-a-url"), null);
    assert.equal(extractRegistrableDomain(""), null);
  });

  it("lowercases o resultado", () => {
    assert.equal(extractRegistrableDomain("HTTPS://Blog.Google.COM/foo"), "google.com");
  });
});

describe("isPressCovertageOfHighlight (#2548 Furo 2)", () => {
  it("CENÁRIO REAL: RADAR canaltech + D1 blog.google.com → match quando suggested_primary_domain=google.com", () => {
    const radarArticle = {
      url: "https://canaltech.com.br/ia/google-libera-ia-que-consegue-mexer-no-computador",
      title: "Google libera IA que consegue mexer no computador",
      suggested_primary_domain: "google.com",
    };
    const highlightUrl = "https://blog.google.com/products/gemini/google-agents-computer-use";

    assert.equal(
      isPressCovertageOfHighlight(radarArticle, highlightUrl),
      true,
      "RADAR canaltech com suggested_primary_domain=google.com deve casar com D1 blog.google.com",
    );
  });

  it("sem suggested_primary_domain → não detecta domain-match", () => {
    const radarArticle = {
      url: "https://canaltech.com.br/ia/google-libera-ia",
      title: "Google libera IA",
      // sem suggested_primary_domain
    };
    assert.equal(
      isPressCovertageOfHighlight(radarArticle, "https://blog.google.com/foo"),
      false,
      "sem suggested_primary_domain não deve detectar match",
    );
  });

  it("suggested_primary_domain diferente do domínio do destaque → sem match", () => {
    const radarArticle = {
      url: "https://canaltech.com.br/ia/openai-lanca-gpt-5",
      title: "OpenAI lança GPT-5",
      suggested_primary_domain: "openai.com",
    };
    // D1 é do Google, não da OpenAI
    const highlightUrl = "https://blog.google.com/products/gemini/something";
    assert.equal(
      isPressCovertageOfHighlight(radarArticle, highlightUrl),
      false,
    );
  });

  it("URL do destaque null → sem match", () => {
    const radarArticle = {
      url: "https://canaltech.com.br/ia/google-libera-ia",
      title: "Google libera IA",
      suggested_primary_domain: "google.com",
    };
    assert.equal(isPressCovertageOfHighlight(radarArticle, null), false);
  });

  it("#2586: suggested_primary_domain='deepmind.com' casa D1 do Google (alias DeepMind/Google)", () => {
    // Integração do alias deepmind.com→google.com (#2586): um RADAR cuja fonte
    // primária sugerida é deepmind.com deve casar contra um D1 em blog.google.com,
    // pois deepmind.com é domains[] da entry "DeepMind / Google" em official-domains.ts.
    const radarArticle = {
      url: "https://canaltech.com.br/ia/deepmind-lanca-alphafold-4",
      title: "DeepMind lança AlphaFold 4",
      suggested_primary_domain: "deepmind.com",
    };
    const highlightUrl = "https://blog.google.com/technology/google-deepmind/alphafold-4";
    assert.equal(
      isPressCovertageOfHighlight(radarArticle, highlightUrl),
      true,
      "deepmind.com (alias) deve casar com blog.google.com (ambos → google.com)",
    );
  });
});

describe("dedup-intra-edition — regressão #2548 Furo 2 domain-match", () => {
  it("CENÁRIO REAL: remove RADAR canaltech cobrindo mesmo lançamento do D1 blog.google.com (via entidade de produto, Jaccard ~0)", () => {
    // Este é o caso que falhou na edição 260625:
    // D1 = blog.google.com sobre Gemini computer use (título EM INGLÊS)
    // RADAR = canaltech.com.br cobrindo a mesma funcionalidade (título EM PORTUGUÊS)
    //
    // #2587: domain-match sozinho não basta. Mas as línguas divergem (EN vs PT) →
    // Jaccard de título ≈ 0 (sem token comum significativo). O que salva é o
    // SEGUNDO SINAL via ENTIDADE DE PRODUTO: ambos citam "Gemini" (produto), que
    // NÃO é stopword de empresa → entidade-de-produto compartilhada → mesmo evento.
    // "Google" é stopword de empresa (já estabelecida pelo domain-match) e NÃO conta.
    // Isto prova que o fix #2587 NÃO regride o #2548 sem trapaça de Jaccard.
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://blog.google.com/products/gemini/google-agents-computer-use",
          article: {
            url: "https://blog.google.com/products/gemini/google-agents-computer-use",
            // Título oficial em inglês — diverge lexicalmente do título PT do RADAR.
            title: "Introducing Gemini agents that use your computer",
          },
        },
      ],
      radar: [
        {
          url: "https://canaltech.com.br/ia/google-libera-ia-que-consegue-mexer-no-computador",
          // Título de imprensa em português — só "Gemini" coincide com o D1.
          title: "Google libera Gemini que consegue mexer no computador sozinho",
          suggested_primary_domain: "google.com",
        },
        {
          url: "https://techcrunch.com/2026/06/24/anthropic-releases-claude-5",
          title: "Anthropic lança Claude 5 com raciocínio avançado",
          // sem suggested_primary_domain — notícia diferente, não duplicata
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    assert.equal(removed.length, 1, "deve remover exatamente 1 item (RADAR canaltech)");
    assert.equal(
      removed[0].url,
      "https://canaltech.com.br/ia/google-libera-ia-que-consegue-mexer-no-computador",
    );
    assert.equal(removed[0].match_type, "domain", "deve usar match_type='domain'");
    assert.equal(removed[0].bucket, "radar");

    assert.equal(kept.radar?.length, 1, "deve preservar o RADAR não-relacionado (Claude 5)");
    assert.equal(
      kept.radar?.[0].url,
      "https://techcrunch.com/2026/06/24/anthropic-releases-claude-5",
    );
  });

  it("#2578: RADAR sem suggested_primary_domain com lançamento detectável é removido por domain-match (fallback)", () => {
    // #2578: após o fix, isPressCovertageOfHighlight tem fallback via detectLaunchCandidate.
    // "OpenAI lança GPT-5 com capacidade..." → detectLaunchCandidate detecta verbo "lança" +
    // empresa "OpenAI" → suggested_domain = "openai.com" → D1 em openai.com → domain-match!
    // Sem o campo persistido no JSON, a feature agora funciona via re-derivação no-op.
    // #2587: segundo sinal satisfeito por DUAS vias aqui — entidade de produto
    // compartilhada ("gpt5") E Jaccard ≥ 0.2 — qualquer uma confirma o mesmo evento.
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://openai.com/research/gpt-5",
          title: "OpenAI launches GPT-5 with advanced reasoning",
        },
      ],
      radar: [
        {
          url: "https://canaltech.com.br/ia/openai-lanca-gpt-5",
          title: "OpenAI lança GPT-5 com capacidade de raciocínio avançada",
          // sem suggested_primary_domain — field foi stripado pelo scorer
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { removed } = dedupIntraEdition(input);

    // Com #2578: mesmo sem suggested_primary_domain, detectLaunchCandidate re-deriva
    // "openai.com" a partir do título — e o D1 em openai.com faz match por domain.
    const domainMatches = removed.filter(r => r.match_type === "domain");
    assert.equal(domainMatches.length, 1, "#2578: fallback detectLaunchCandidate deve produzir domain-match");
    assert.equal(removed[0].url, "https://canaltech.com.br/ia/openai-lanca-gpt-5");
  });

  it("domain-match não remove destaque próprio (mesmo URL)", () => {
    // Se por algum motivo o destaque aparecer também no bucket, não deve ser
    // auto-removido (URL-skip guard já previne isso).
    const highlightUrl = "https://blog.google.com/products/gemini/computer-use";
    const input = {
      highlights: [
        {
          rank: 1,
          url: highlightUrl,
          title: "Google lança IA computer use",
          // mesmo URL que o highlight
        },
      ],
      radar: [
        {
          url: highlightUrl, // mesmo URL que o highlight
          title: "Google lança IA computer use",
          suggested_primary_domain: "google.com",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { removed } = dedupIntraEdition(input);

    // O URL-skip guard (article.url === hUrl) previne remoção
    assert.equal(removed.length, 0, "mesmo URL = não é intra-dup");
  });
});

// ---------------------------------------------------------------------------
// #2578: domain-match funciona mesmo sem suggested_primary_domain (re-derivação)
// Regressão: o campo é setado em tmp-categorized.json (passo 1m) mas pode ser
// stripado pelo scorer/assemble antes de chegar em 01-categorized.json (passo 1u).
// Fix: isPressCovertageOfHighlight re-deriva via detectLaunchCandidate como fallback.
// ---------------------------------------------------------------------------

describe("isPressCovertageOfHighlight — fallback sem suggested_primary_domain (#2578)", () => {
  it("CENÁRIO REAL: sem suggested_primary_domain, re-deriva via detectLaunchCandidate", () => {
    // Simula o caso onde sugerido_primary_domain foi stripado pelo scorer.
    // O artigo RADAR fala de lançamento do Google (verbo "lança" + keyword "gemini").
    // Sem o campo, o fallback usa detectLaunchCandidate pra re-derivar o domínio.
    const radarArticle = {
      url: "https://canaltech.com.br/ia/google-libera-ia-que-consegue-mexer-no-computador",
      title: "Google lança IA Gemini que consegue mexer no computador",
      // campo NOT presente — simula strip pelo scorer/assemble
    };
    const highlightUrl = "https://blog.google.com/products/gemini/google-agents-computer-use";

    // "Google lança IA Gemini" → detectLaunchCandidate → is_candidate: true,
    // "gemini" casa a entry "DeepMind / Google" (detection_keywords: /\b(deepmind|gemini)\b/i),
    // cujo primary_domain é "deepmind.google".
    // normalizeDomainForMatch("deepmind.google") → DOMAIN_ALIASES → "google.com".
    // extractRegistrableDomain(highlightUrl "blog.google.com") → "google.com" (via alias #2580).
    // "google.com" === "google.com" → domain-match!
    const result = isPressCovertageOfHighlight(radarArticle, highlightUrl);
    assert.equal(
      result,
      true,
      "sem suggested_primary_domain, deve re-derivar via detectLaunchCandidate e detectar domain-match",
    );
  });

  it("artigo sem verbo de lançamento e sem suggested_primary_domain → sem domain-match", () => {
    // Artigo de notícia geral sem verbo de lançamento — não é candidato a
    // isPressCovertageOfHighlight mesmo que fale de empresa.
    const radarArticle = {
      url: "https://canaltech.com.br/ia/google-apresenta-resultados",
      title: "Google apresenta resultados do trimestre",
      // sem suggested_primary_domain e sem verbo de lançamento reconhecível
    };
    const result = isPressCovertageOfHighlight(radarArticle, "https://blog.google.com/something");
    // "apresenta" é verbo de lançamento e detectLaunchCandidate pode derivar google.com.
    // Mas isPressCovertageOfHighlight só verifica domain — a decisão de remoção em
    // isIntraEditionDuplicate (#2587) exige segundo sinal (entidade-de-produto OU
    // Jaccard ≥ 0.2). Este teste cobre só isPressCovertageOfHighlight isoladamente.
    // "Google apresenta resultados do trimestre" → "google" casa entry "Google (blog)"
    // detection_keywords /\b(google ai|gemma)\b/i → NÃO casa (sem "google ai" ou "gemma").
    // Nenhuma entry com detection_keywords que case "google" sozinho → is_candidate = false.
    // Sem suggested_primary_domain e sem detecção → retorna false.
    assert.equal(result, false, "artigo sem verbo de lançamento reconhecível não deve ter domain-match");
  });

  it("dedupIntraEdition remove RADAR sem suggested_primary_domain quando detectLaunchCandidate detecta", () => {
    // Testa o fluxo completo: artigo RADAR sem suggested_primary_domain
    // mas com verbo de lançamento + empresa → domain-match via fallback.
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://blog.google.com/products/gemini/google-agents-computer-use",
          article: {
            url: "https://blog.google.com/products/gemini/google-agents-computer-use",
            title: "Google launches Gemini computer use agents",
          },
        },
      ],
      radar: [
        {
          url: "https://canaltech.com.br/ia/google-lanca-gemini-computer-use",
          title: "Google lança Gemini para controlar computadores",
          // SEM suggested_primary_domain — simula strip do scorer
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    assert.equal(
      removed.length,
      1,
      "deve remover RADAR via fallback detectLaunchCandidate mesmo sem suggested_primary_domain",
    );
    assert.equal(removed[0].match_type, "domain");
    assert.equal(kept.radar?.length, 0);
  });
});

// ---------------------------------------------------------------------------
// #2580: extractRegistrableDomain normaliza domínios Google com gTLD .google
// Regressão: blog.google → "blog.google" (2 labels) ≠ "google.com" (resultado
// de cloud.google.com), então match contra suggested_primary_domain="blog.google"
// falhava para destaques em cloud.google.com.
// ---------------------------------------------------------------------------

describe("extractRegistrableDomain — normalização domínios Google (#2580)", () => {
  it("blog.google (gTLD .google) é normalizado para google.com via alias map", () => {
    // blog.google é o blog oficial do Google — 2 labels, mas é o mesmo "dono"
    // de cloud.google.com (3 labels → "google.com"). #2580 alias normaliza.
    assert.equal(
      extractRegistrableDomain("https://blog.google/products/gemini/something"),
      "google.com",
      "blog.google deve ser aliasado para google.com",
    );
  });

  it("cloud.google.com e blog.google resultam no mesmo registrable domain", () => {
    const blogGoogle = extractRegistrableDomain("https://blog.google/technology/ai");
    const cloudGoogle = extractRegistrableDomain("https://cloud.google.com/blog/ai-tools");
    assert.equal(
      blogGoogle,
      cloudGoogle,
      `blog.google (${blogGoogle}) e cloud.google.com (${cloudGoogle}) devem resultar no mesmo domain`,
    );
  });

  it("deepmind.google é normalizado para google.com", () => {
    assert.equal(
      extractRegistrableDomain("https://deepmind.google/research/gemini"),
      "google.com",
    );
  });

  it("#2586: deepmind.com é normalizado para google.com (alias faltando em #2585)", () => {
    // deepmind.com está listado em official-domains.ts como domains[] da entry
    // "DeepMind / Google" (junto com deepmind.google e ai.google), mas não estava
    // em DOMAIN_ALIASES → extractRegistrableDomain("deepmind.com") retornava
    // "deepmind.com" em vez de "google.com", quebrando match contra D1s do Google.
    assert.equal(
      extractRegistrableDomain("https://deepmind.com/research/alphafold"),
      "google.com",
    );
  });

  it("ai.google é normalizado para google.com", () => {
    assert.equal(
      extractRegistrableDomain("https://ai.google/research/gemma"),
      "google.com",
    );
  });

  it("domínios não-Google não são alterados", () => {
    // Domínio comum (2 labels): sem alias → resultado direto
    assert.equal(extractRegistrableDomain("https://openai.com/blog/gpt-5"), "openai.com");
    assert.equal(extractRegistrableDomain("https://deepseek.com/news"), "deepseek.com");
    // Subdomínio (3 labels): últimos 2 labels
    assert.equal(extractRegistrableDomain("https://blogs.nvidia.com/ai"), "nvidia.com");
  });
});

// ---------------------------------------------------------------------------
// #2587: domain-match sozinho não remove — exige segundo sinal:
//   (≥1 entidade-de-PRODUTO compartilhada além do nome da empresa)
//   OR (Jaccard de título ≥ INTRA_DOMAIN_JACCARD_MIN).
// Regressão potencial: "Google lança produto A" (D1) + "Google lança produto B"
// (RADAR) compartilham domínio google.com, mas são eventos DIFERENTES → RADAR
// deve ser preservado (sem entidade-de-produto nem Jaccard compartilhados).
// ---------------------------------------------------------------------------

describe("dedup-intra-edition — #2587 domain-match exige segundo sinal", () => {
  it("(a) 2 lançamentos Google DIFERENTES: RADAR preservado quando sem produto nem Jaccard compartilhado além de 'google'", () => {
    // D1 = Google lança Pixel 9 Pro. RADAR = Google anuncia Android 16.
    // Os dois são da mesma empresa (google.com) mas são produtos distintos.
    // Só "google" coincide ("anuncia" ≠ "lança") → Jaccard ≈ 0.11 < 0.2, e
    // "pixel"/"android" não se cruzam ("google" é stopword de empresa) → 0
    // entidades de produto compartilhadas. Nenhum segundo sinal → RADAR preservado.
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://blog.google.com/products/pixel/introducing-pixel-9-pro",
          title: "Google lança Pixel 9 Pro com câmera aprimorada",
          suggested_primary_domain: "google.com",
        },
      ],
      radar: [
        {
          url: "https://canaltech.com.br/android/google-lanca-android-16",
          title: "Google anuncia Android 16 para desenvolvedores",
          suggested_primary_domain: "google.com",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    assert.equal(
      removed.length,
      0,
      "#2587: 2 lançamentos diferentes da mesma empresa NÃO devem ser removidos pelo domain-match sozinho",
    );
    assert.equal(kept.radar?.length, 1, "RADAR deve ser preservado");
    assert.equal(
      kept.radar?.[0].url,
      "https://canaltech.com.br/android/google-lanca-android-16",
    );
  });

  it("(b) ENTIDADE de produto compartilhada com Jaccard < 0.2 (cross-lingual): RADAR removido", () => {
    // D1 = Google lança Gemini computer use (EN). RADAR = canaltech cobrindo o
    // MESMO Gemini (PT). Línguas divergem → Jaccard ≈ 0.07 < 0.2, então o caminho
    // de Jaccard NÃO dispara. O que remove é a ENTIDADE DE PRODUTO compartilhada
    // ("gemini") — exatamente o caminho que evita regredir o #2548 sem trapaça.
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://blog.google.com/products/gemini/computer-use-launch",
          title: "Introducing Gemini agents that use your computer",
          suggested_primary_domain: "google.com",
        },
      ],
      radar: [
        {
          url: "https://canaltech.com.br/ia/google-gemini-computer-use",
          title: "Google libera Gemini que consegue mexer no computador sozinho",
          suggested_primary_domain: "google.com",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    assert.equal(
      removed.length,
      1,
      "#2587: entidade de produto 'gemini' compartilhada (Jaccard < 0.2) deve remover via caminho de entidade",
    );
    assert.equal(removed[0].match_type, "domain");
    assert.equal(removed[0].score, 1.0, "entidade compartilhada → score 1.0");
    assert.equal(kept.radar?.length, 0);
  });

  it("(c) JACCARD ≥ 0.2 sem entidade de produto compartilhada: RADAR removido", () => {
    // Mesmo lançamento, ambos PT, sem nome de produto (ou produto idêntico
    // textual) → Jaccard alto carrega o segundo sinal sozinho. Score = Jaccard.
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://blog.google.com/products/ai/google-lanca-modo-agente",
          title: "Google lança modo agente que controla o navegador",
          suggested_primary_domain: "google.com",
        },
      ],
      radar: [
        {
          url: "https://canaltech.com.br/ia/google-modo-agente",
          title: "Google lança modo agente que controla o navegador do usuário",
          suggested_primary_domain: "google.com",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { removed } = dedupIntraEdition(input);

    assert.equal(removed.length, 1, "#2587: Jaccard ≥ 0.2 deve remover mesmo sem entidade de produto");
    assert.equal(removed[0].match_type, "domain");
    assert.ok(
      removed[0].score >= INTRA_DOMAIN_JACCARD_MIN && removed[0].score < 1.0,
      `score deve refletir o Jaccard real (${removed[0].score}), não 1.0`,
    );
  });

  it("INTRA_DOMAIN_JACCARD_MIN exportado é 0.2", () => {
    assert.equal(INTRA_DOMAIN_JACCARD_MIN, 0.2);
  });
});

// ---------------------------------------------------------------------------
// #3099 CASO REAL 260708: cross-vehicle same-company (DeepSeek chip)
//
// D2 "DeepSeek prepara chip de IA para reduzir dependência da NVIDIA, revela
// portal" (canaltech) + RADAR "Chinesa DeepSeek está desenvolvendo o próprio
// chip de IA, dizem fontes" (CNN Brasil) — mesmo evento (chip da DeepSeek),
// mas nenhum guard existente pegava: Jaccard ≈ 0.14 (abaixo de 0.45);
// entity-match geral = 0 (DeepSeek/NVIDIA são stopword de empresa); domain-
// match (#2548/#2587) não se aplica porque NENHUM dos dois lados é a página
// oficial (ambos são cobertura de imprensa, sem suggested_primary_domain
// batendo a URL do destaque). Fix: cross-vehicle same-company match — mesma
// empresa citada nos dois títulos + ≥1 token de tópico compartilhado além
// da empresa (aqui, "chip").
// ---------------------------------------------------------------------------

describe("extractCompanyMentionsIntra (#3099)", () => {
  it("detecta 'DeepSeek' e 'NVIDIA' no título (empresa É o sinal aqui, ao contrário do entity-match geral)", () => {
    const companies = extractCompanyMentionsIntra(
      "DeepSeek prepara chip de IA para reduzir dependência da NVIDIA, revela portal",
    );
    assert.ok(companies.has("deepseek"));
    assert.ok(companies.has("nvidia"));
  });

  it("detecta empresa mencionada no meio da frase (não só index-0)", () => {
    const companies = extractCompanyMentionsIntra(
      "Chinesa DeepSeek está desenvolvendo o próprio chip de IA, dizem fontes",
    );
    assert.ok(companies.has("deepseek"));
  });

  it("não detecta empresa ausente do título", () => {
    const companies = extractCompanyMentionsIntra("Anthropic lança novo modelo Claude");
    assert.ok(!companies.has("openai"));
  });
});

describe("dedup-intra-edition — regressão #3099 CASO REAL 260708: DeepSeek chip cross-vehicle", () => {
  it("remove RADAR CNN Brasil que cobre o mesmo chip DeepSeek que o destaque canaltech (Jaccard baixo, sem domain-match)", () => {
    const input = {
      highlights: [
        {
          rank: 2,
          url: "https://canaltech.com.br/inteligencia-artificial/deepseek-prepara-chip-de-ia-para-reduzir-dependencia-da-nvidia-revela-portal/",
          title: "DeepSeek prepara chip de IA para reduzir dependência da NVIDIA, revela portal",
        },
      ],
      radar: [
        {
          url: "https://www.cnnbrasil.com.br/economia/negocios/chinesa-deepseek-esta-desenvolvendo-o-proprio-chip-de-ia-dizem-fontes/",
          title: "Chinesa DeepSeek está desenvolvendo o próprio chip de IA, dizem fontes",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    assert.equal(removed.length, 1, "RADAR CNN Brasil deve ser removido como cobertura do mesmo evento");
    assert.equal(removed[0].match_type, "cross_vehicle");
    assert.equal(kept.radar?.length, 0);
  });

  it("NÃO remove notícia de empresa diferente que só compartilha token genérico (sem falso-positivo)", () => {
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://canaltech.com.br/x/deepseek-chip-nvidia",
          title: "DeepSeek prepara chip de IA para reduzir dependência da NVIDIA, revela portal",
        },
      ],
      radar: [
        {
          // Empresa diferente (Anthropic) — não deve colidir mesmo compartilhando "ia"/"nova".
          url: "https://exame.com/x/anthropic-novo-modelo",
          title: "Anthropic lança nova versão do Claude para empresas",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { removed } = dedupIntraEdition(input);
    assert.equal(removed.length, 0, "empresas diferentes não devem colidir via cross-vehicle match");
  });

  it("NÃO remove segunda notícia da MESMA empresa sobre tópico diferente (só termos genéricos em comum)", () => {
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://canaltech.com.br/x/deepseek-chip-nvidia",
          title: "DeepSeek prepara chip de IA para reduzir dependência da NVIDIA, revela portal",
        },
      ],
      radar: [
        {
          // Mesma empresa (DeepSeek), tópico DIFERENTE (modelo de codificação, não chip).
          // Só compartilha "deepseek" (empresa) — sem token de tópico específico.
          url: "https://www.cnnbrasil.com.br/x/deepseek-lancara-novo-modelo-de-ia-focado-em-codificacao",
          title: "DeepSeek lançará novo modelo de IA focado em codificação",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { removed } = dedupIntraEdition(input);
    assert.equal(
      removed.length,
      0,
      "segunda história da mesma empresa sobre tópico diferente não deve ser removida",
    );
  });
});

// ---------------------------------------------------------------------------
// #4185: destaque com cobertura múltipla — código de produto compartilhado
// ---------------------------------------------------------------------------
//
// Regressão do caso real (edição 260728): D1 "Itaú coloca IA para cuidar do
// relacionamento com o cliente" (Tecnoblog) + RADAR "Nova IA do Itaú mostra
// para onde vai o seu dinheiro e te ajuda a controlar gastos" (Canaltech) —
// cobrem o MESMO lançamento (assistente "ia.i" do Itaú), mas nenhum título
// menciona "ia.i" literalmente — só o lead/corpo de cada matéria (confirmado
// contra as matérias reais: Canaltech abre com "...o seu novo assistente de
// IA: o ia.i.", Tecnoblog cobre a mesma revelação). O único token de título
// compartilhado é "itau" (Jaccard ~0.07, abaixo do threshold intra-edição de
// 0.45; entity-match via só o título vê 1 entidade compartilhada, abaixo do
// mínimo de 2). Nenhum dos matchers pré-#4185 (jaccard/entity/domain/
// cross_vehicle) detecta o par.

const itauD1Title = "Itaú coloca IA para cuidar do relacionamento com o cliente";
const itauD1Summary =
  "O Itaú anunciou a adoção de IA generativa no aplicativo oficial sob o nome ia.i, chatbot na tela inicial que responde perguntas dos clientes.";
const itauCanaltechTitle =
  "Nova IA do Itaú mostra para onde vai o seu dinheiro e te ajuda a controlar gastos";
const itauCanaltechSummary =
  "O Itaú lançou nesta segunda-feira o seu novo assistente de IA: o ia.i. Com a novidade, o banco oferece aos clientes uma nova interface para acessar a conta corrente como se estivesse em uma conversa.";

describe("extractProductCodeTokens (#4185)", () => {
  it("extrai código de produto com ponto sem espaço ('ia.i')", () => {
    const tokens = extractProductCodeTokens(itauCanaltechSummary);
    assert.ok(tokens.has("ia.i"), "deve capturar 'ia.i' do lead da matéria");
  });

  it("extrai codinome alfanumérico versionado ('gpt4o' — letra inicial, dígitos depois do ponto)", () => {
    const tokens = extractProductCodeTokens("OpenAI atualiza o gpt4o.mini para desenvolvedores");
    assert.ok(tokens.has("gpt4o.mini"));
  });

  it("#4185 (decisão conservadora): NÃO extrai token puramente numérico ('3.1' de 'Llama 3.1')", () => {
    // Deliberado: exigir letra inicial (`[a-z][a-z0-9]*(?:\.[a-z0-9]+)+`) evita
    // que "1.500" (separador de milhar comum em PT-BR: "1.500 clientes",
    // "1.500 funcionários") vire um falso sinal de mesmo-produto entre duas
    // matérias DIFERENTES da mesma empresa que coincidentemente citam o mesmo
    // número redondo. Custo aceito: um par real como "GPT-4.1" ganha o token
    // via o prefixo alfabético ("gpt" + a versão colada, ex: "gpt4o.mini"
    // acima) — o cenário puro "Nome 3.1" com espaço antes do número (sem
    // prefixo grudado) fica de fora. Ver PR body (#4185) pra trade-off.
    const tokens = extractProductCodeTokens("Meta lança Llama 3.1 com contexto maior");
    assert.equal(tokens.size, 0, "token puramente numérico não deve casar (risco de falso-positivo com separador de milhar PT-BR)");
  });

  it("normaliza pra lowercase (case-insensitive)", () => {
    const tokens = extractProductCodeTokens("A empresa lançou o IA.I hoje");
    assert.ok(tokens.has("ia.i"));
  });

  it("não casa ponto de fim de frase (requer alnum grudado dos dois lados)", () => {
    const tokens = extractProductCodeTokens("Isso é uma frase normal. Outra frase aqui.");
    assert.equal(tokens.size, 0, "pontuação de frase normal não deve virar token");
  });

  it("string vazia/sem padrão retorna set vazio", () => {
    assert.equal(extractProductCodeTokens("").size, 0);
    assert.equal(extractProductCodeTokens("nenhum código de produto aqui").size, 0);
  });
});

describe("highlightSummary (#4185)", () => {
  it("extrai summary do campo direto", () => {
    assert.equal(highlightSummary({ summary: "um resumo" }), "um resumo");
  });

  it("extrai summary do campo article.summary (shape real do pipeline)", () => {
    assert.equal(
      highlightSummary({ article: { url: "u", summary: "resumo aninhado" } }),
      "resumo aninhado",
    );
  });

  it("retorna null quando ambos ausentes", () => {
    assert.equal(highlightSummary({}), null);
  });
});

describe("isIntraEditionDuplicate — código de produto + entidade compartilhados (#4185)", () => {
  it("REGRESSÃO par real 260728: Tecnoblog (D1) + Canaltech (RADAR) sobre o ia.i do Itaú casam via product_code", () => {
    const highlights = [
      {
        rank: 1,
        url: "https://tecnoblog.net/noticias/itau-coloca-ia-para-cuidar-do-relacionamento-com-o-cliente/",
        title: itauD1Title,
        summary: itauD1Summary,
      },
    ];
    const article = {
      url: "https://canaltech.com.br/apps/nova-ia-do-itau-mostra-para-onde-vai-o-seu-dinheiro-e-te-ajuda-a-controlar-gastos/",
      title: itauCanaltechTitle,
      summary: itauCanaltechSummary,
    };

    // Confirma a premissa do incidente: nenhum dos sinais PRÉ-#4185 dispara.
    const jaccard = jaccardOf(article.title, itauD1Title);
    assert.ok(jaccard < INTRA_JACCARD_THRESHOLD, `Jaccard ${jaccard} deveria estar abaixo do threshold ${INTRA_JACCARD_THRESHOLD}`);
    const entities1 = extractNamedEntitiesIntra(article.title);
    const entities2 = extractNamedEntitiesIntra(itauD1Title);
    const shared = [...entities1].filter((e) => entities2.has(e));
    assert.ok(shared.length < INTRA_ENTITY_MIN_SHARED, "entity-match (b) sozinho não deveria bastar (só 'itau')");

    const result = isIntraEditionDuplicate(article, highlights);
    assert.ok(result !== null, "deve detectar o par via código de produto compartilhado (ia.i)");
    assert.equal(result!.match_type, "product_code");
    assert.equal(result!.matched_highlight, itauD1Title);
  });

  it("NÃO casa quando há código de produto compartilhado mas NENHUMA entidade nomeada em comum", () => {
    // Títulos sem nenhuma palavra capitalizada (artEntities.size === 0) —
    // item (e) exige os DOIS sinais (AND), não só o código de produto.
    const highlights = [
      { rank: 1, url: "https://a.com/x", title: "ferramenta chega com suporte a ia.i para todos" },
    ];
    const article = {
      url: "https://b.com/y",
      title: "empresa rival também anuncia recurso baseado em ia.i",
    };
    const result = isIntraEditionDuplicate(article, highlights);
    assert.equal(result, null, "código de produto sozinho, sem entidade compartilhada, não deve casar");
  });

  it("NÃO casa quando há entidade compartilhada mas NENHUM código de produto em comum (comportamento preexistente)", () => {
    // Mesma empresa (Itaú), histórias DIFERENTES, sem termo versionado/
    // codinome em nenhum dos dois lados — não deve colidir via item (e).
    const highlights = [
      { rank: 1, url: "https://a.com/x", title: "Itaú anuncia resultado trimestral acima do esperado" },
    ];
    const article = {
      url: "https://b.com/y",
      title: "Itaú patrocina evento de tecnologia em São Paulo",
    };
    const result = isIntraEditionDuplicate(article, highlights);
    assert.equal(result, null, "sem código de produto compartilhado, entidade única não deve bastar");
  });
});

describe("dedupIntraEdition — cluster_sources[] preservado no destaque (#4185)", () => {
  it("REGRESSÃO par real 260728: Canaltech sai do RADAR e vira cluster_sources[] do D1 (Tecnoblog)", () => {
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://tecnoblog.net/noticias/itau-coloca-ia-para-cuidar-do-relacionamento-com-o-cliente/",
          article: {
            url: "https://tecnoblog.net/noticias/itau-coloca-ia-para-cuidar-do-relacionamento-com-o-cliente/",
            title: itauD1Title,
            summary: itauD1Summary,
            source: "Tecnoblog",
          },
        },
      ],
      radar: [
        {
          url: "https://canaltech.com.br/apps/nova-ia-do-itau-mostra-para-onde-vai-o-seu-dinheiro-e-te-ajuda-a-controlar-gastos/",
          title: itauCanaltechTitle,
          summary: itauCanaltechSummary,
          source: "Canaltech",
        },
        {
          // Item não-relacionado — deve sobreviver no RADAR intacto.
          url: "https://wired.com/apple-wwdc-2026",
          title: "Apple anuncia novidades no WWDC 2026",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    // (1) Canaltech não aparece mais como item independente do RADAR.
    assert.equal(kept.radar?.length, 1, "só o item não-relacionado deve sobrar no RADAR");
    assert.equal(kept.radar?.[0].url, "https://wired.com/apple-wwdc-2026");
    assert.equal(removed.length, 1);
    assert.equal(
      removed[0].url,
      "https://canaltech.com.br/apps/nova-ia-do-itau-mostra-para-onde-vai-o-seu-dinheiro-e-te-ajuda-a-controlar-gastos/",
    );
    assert.equal(removed[0].match_type, "product_code");

    // (2) Canaltech chega ao writer-destaque via cluster_sources[] do D1 —
    // não é um descarte silencioso (critério de aceite da #4185).
    const d1 = kept.highlights?.[0] as { article?: { cluster_sources?: Array<{ url: string; title?: string; source?: string }> } };
    assert.ok(d1.article?.cluster_sources, "D1 deve carregar cluster_sources[] após o rescue");
    assert.equal(d1.article!.cluster_sources!.length, 1);
    assert.equal(
      d1.article!.cluster_sources![0].url,
      "https://canaltech.com.br/apps/nova-ia-do-itau-mostra-para-onde-vai-o-seu-dinheiro-e-te-ajuda-a-controlar-gastos/",
    );
    assert.equal(d1.article!.cluster_sources![0].source, "Canaltech");

    // (3) input original não foi mutado (contrato "pure function").
    assert.equal(
      (input.highlights[0].article as { cluster_sources?: unknown[] }).cluster_sources,
      undefined,
      "dedupIntraEdition não deve mutar o objeto de input",
    );
  });

  // #4228: lacuna entre o #4192/#4193 (dedup.ts resgata/protege submissões
  // do editor no pool bruto) e o #4185 (dedup-intra-edition.ts dobra um item
  // do pool num cluster_source de destaque). Um artigo editor_submitted que
  // sobrevive ao pool mas depois é reconhecido como duplicata intra-edição
  // de um destaque precisa preservar o marcador de proveniência no
  // cluster_source resultante — antes do fix em toClusterSource, o sinal
  // desaparecia (a URL sobrevivia, "isto veio do editor" não).
  it("artigo editor_submitted que colide com um destaque preserva flag/editor_submitted_url no cluster_source (#4228)", () => {
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://tecnoblog.net/noticias/itau-coloca-ia-para-cuidar-do-relacionamento-com-o-cliente/",
          article: {
            url: "https://tecnoblog.net/noticias/itau-coloca-ia-para-cuidar-do-relacionamento-com-o-cliente/",
            title: itauD1Title,
            summary: itauD1Summary,
            source: "Tecnoblog",
          },
        },
      ],
      radar: [
        {
          url: "https://canaltech.com.br/apps/nova-ia-do-itau-mostra-para-onde-vai-o-seu-dinheiro-e-te-ajuda-a-controlar-gastos/",
          title: itauCanaltechTitle,
          summary: itauCanaltechSummary,
          source: "Canaltech",
          flag: "editor_submitted",
          editor_submitted_url: "https://canaltech.com.br/apps/nova-ia-do-itau-mostra-para-onde-vai-o-seu-dinheiro-e-te-ajuda-a-controlar-gastos/",
        },
      ],
      lancamento: [],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    assert.equal(removed.length, 1, "Canaltech ainda deve ser reconhecido como duplicata intra-edição do D1");
    const d1 = kept.highlights?.[0] as {
      article?: { cluster_sources?: Array<{ url: string; flag?: string; editor_submitted_url?: string }> };
    };
    assert.ok(d1.article?.cluster_sources, "D1 deve carregar cluster_sources[] após o rescue");
    const entry = d1.article!.cluster_sources!.find((c) => c.url.includes("canaltech"));
    assert.ok(entry, "esperava a entrada da Canaltech em cluster_sources[]");
    assert.equal(entry!.flag, "editor_submitted", "o marcador de proveniência do editor não pode desaparecer ao virar cluster_source");
    assert.equal(
      entry!.editor_submitted_url,
      "https://canaltech.com.br/apps/nova-ia-do-itau-mostra-para-onde-vai-o-seu-dinheiro-e-te-ajuda-a-controlar-gastos/",
    );
  });

  it("acumula 2 fontes extras no mesmo destaque quando 2 itens de buckets diferentes casam", () => {
    const input = {
      highlights: [
        {
          rank: 1,
          url: "https://tecnoblog.net/noticias/itau-coloca-ia-para-cuidar-do-relacionamento-com-o-cliente/",
          article: {
            url: "https://tecnoblog.net/noticias/itau-coloca-ia-para-cuidar-do-relacionamento-com-o-cliente/",
            title: itauD1Title,
            summary: itauD1Summary,
          },
        },
      ],
      radar: [
        {
          url: "https://canaltech.com.br/apps/nova-ia-do-itau",
          title: itauCanaltechTitle,
          summary: itauCanaltechSummary,
        },
      ],
      lancamento: [
        {
          url: "https://techtudo.com.br/itau-ia-i-gastos",
          title: "Itaú lança IA que ajuda a controlar gastos e entender seu perfil financeiro",
          summary: "O ia.i chega para clientes do Itaú com foco em controle de gastos mensais.",
        },
      ],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);
    assert.equal(removed.length, 2, "os 2 artigos secundários devem casar com o D1");
    const d1 = kept.highlights?.[0] as { article?: { cluster_sources?: Array<{ url: string }> } };
    assert.equal(d1.article?.cluster_sources?.length, 2, "as 2 fontes extras devem se acumular no mesmo destaque");
  });

  it("highlights fora do top-N (rank 4+) não são tocados/clonados desnecessariamente", () => {
    const input = {
      highlights: [
        { rank: 1, url: "https://a.com/1", title: "Destaque 1 sem relação" },
        { rank: 2, url: "https://a.com/2", title: "Destaque 2 sem relação" },
        { rank: 3, url: "https://a.com/3", title: "Destaque 3 sem relação" },
        { rank: 4, url: "https://a.com/4", title: "Candidato não-promovido rank 4" },
      ],
      radar: [],
      lancamento: [],
      use_melhor: [],
      video: [],
    };
    const { kept } = dedupIntraEdition(input);
    assert.equal(kept.highlights?.length, 4);
    // rank 4 passa como a MESMA referência do input (não fazia parte do
    // top-N comparado, não precisa ser clonado).
    assert.equal(kept.highlights?.[3], input.highlights[3]);
  });
});

/** Helper local só pra afirmar a premissa do incidente no teste de regressão. */
function jaccardOf(a: string, b: string): number {
  const ta = tokenizeForJaccard(a);
  const tb = tokenizeForJaccard(b);
  return jaccardSimilarity(ta, tb);
}

// ---------------------------------------------------------------------------
// #4262: crossEditionMode — sinais adicionais pra comparação candidato vs.
// CORPO INTEIRO de edições passadas (usado por check-highlight-themes.ts).
// Caso real (edição 260729): 5 dos 6 candidatos a destaque eram histórias já
// publicadas em 260727/260728. Ver docstrings de `CROSS_EDITION_TERM_MIN_LEN`
// e da Fonte 3 em `isPressCovertageOfHighlight` para o racional completo.
// ---------------------------------------------------------------------------

describe("isIntraEditionDuplicate — crossEditionMode desligado por default (#4262)", () => {
  it("sem crossEditionMode, o par imprensa×fonte-oficial (sem verbo de lançamento no candidato) NÃO casa", () => {
    const match = isIntraEditionDuplicate(
      {
        title: "Claude Opus 5: o que muda no novo modelo",
        url: "https://exame.com/tecnologia/claude-opus-5-o-que-muda-no-novo-modelo/",
      },
      [
        { title: "Anthropic lança o Claude Opus 5", url: "https://anthropic.com/news/claude-opus-5" },
      ],
    );
    assert.equal(match, null, "sem crossEditionMode, Fonte 3 (detectDomainMismatchCandidate) não é tentada");
  });

  it("sem crossEditionMode, o par PT×PT sem empresa de IA citada (professor/alunos) NÃO casa", () => {
    const match = isIntraEditionDuplicate(
      {
        title: "Com prompt invisível, professor desmascara 32 alunos usando IA em prova",
        url: "https://canaltech.com.br/comportamento/x",
      },
      [
        {
          title: "Professor cria armadilha para descobrir quem usou IA e reprova 32 de 35 alunos",
          url: "https://g1.globo.com/x",
        },
      ],
    );
    assert.equal(match, null, "sem crossEditionMode, path (f) content_terms não roda");
  });
});

describe("isIntraEditionDuplicate — crossEditionMode: 3 pares reais da #4262", () => {
  it("Fonte 3 (detectDomainMismatchCandidate): Exame 'o que muda' x anthropic.com (imprensa×oficial, sem verbo de lançamento)", () => {
    const match = isIntraEditionDuplicate(
      {
        title: "Claude Opus 5: o que muda no novo modelo",
        url: "https://exame.com/tecnologia/claude-opus-5-o-que-muda-no-novo-modelo/",
      },
      [
        { title: "Anthropic lança o Claude Opus 5", url: "https://anthropic.com/news/claude-opus-5" },
      ],
      { crossEditionMode: true },
    );
    assert.ok(match, "deve detectar mesma-história via domain-match cross-edição");
    assert.equal(match!.match_type, "domain");
  });

  it("path (f) content_terms: Canaltech x g1 (professor/alunos, PT×PT, sem empresa citada)", () => {
    const match = isIntraEditionDuplicate(
      {
        title: "Com prompt invisível, professor desmascara 32 alunos usando IA em prova",
        url: "https://canaltech.com.br/comportamento/com-prompt-invisivel-professor-desmascara-32-alunos-usando-ia-em-prova/",
      },
      [
        {
          title: "Professor cria armadilha para descobrir quem usou IA e reprova 32 de 35 alunos",
          url: "https://g1.globo.com/educacao/noticia/2026/07/27/professor-cria-armadilha.ghtml",
        },
      ],
      { crossEditionMode: true },
    );
    assert.ok(match, "deve detectar mesma-história via termos de conteúdo compartilhados");
    assert.equal(match!.match_type, "content_terms");
  });

  it("cross-língua Claude/Google (PT×EN): já é pego pelo path (d) cross_vehicle existente, sem depender de crossEditionMode", () => {
    // Nota (ver comentário do editor na #4262): este par passa porque "Google"
    // e "Claude" são cognatos que aparecem idênticos nos dois idiomas — não
    // porque o mecanismo faz tradução/semântica cross-língua de verdade. Um
    // par verdadeiramente traduzido (sem termo compartilhado literal) não
    // seria pego por nenhum path deste comparador.
    const artigo = {
      title: "Usa o Claude? Suas conversas íntimas podem estar no Google",
      url: "https://canaltech.com.br/ia/usa-o-claude-suas-conversas-intimas-podem-estar-no-google/",
    };
    const historico = [
      {
        title: "Uh-oh, some Claude shared conversations were indexed by Google search",
        url: "https://zdnet.com/article/claude-ai-shared-chats-indexed-by-google/",
      },
    ];
    const semCrossEdition = isIntraEditionDuplicate(artigo, historico);
    assert.ok(semCrossEdition, "cross_vehicle já detecta este par sem crossEditionMode");
    assert.equal(semCrossEdition!.match_type, "cross_vehicle");

    const comCrossEdition = isIntraEditionDuplicate(artigo, historico, { crossEditionMode: true });
    assert.equal(comCrossEdition!.match_type, "cross_vehicle", "crossEditionMode não muda o path que dispara aqui");
  });

  it("guard de falso-positivo: duas histórias genuinamente diferentes não casam mesmo com crossEditionMode", () => {
    const match = isIntraEditionDuplicate(
      {
        title: "Google lança novo modelo Gemini para desenvolvedores",
        url: "https://a.com/1",
      },
      [
        {
          title: "Meta anuncia parceria com fabricante de chips para data centers",
          url: "https://b.com/2",
        },
      ],
      { crossEditionMode: true },
    );
    assert.equal(match, null);
  });
});

describe("isPressCovertageOfHighlight — Fonte 3 crossEditionMode (#4262)", () => {
  it("sem crossEditionMode, detectDomainMismatchCandidate não é tentada (retorna false)", () => {
    const result = isPressCovertageOfHighlight(
      { title: "Claude Opus 5: o que muda no novo modelo", url: "https://exame.com/x" },
      "https://anthropic.com/news/claude-opus-5",
    );
    assert.equal(result, false);
  });

  it("com crossEditionMode, detecta domínio oficial via empresa citada sem verbo de lançamento", () => {
    const result = isPressCovertageOfHighlight(
      { title: "Claude Opus 5: o que muda no novo modelo", url: "https://exame.com/x" },
      "https://anthropic.com/news/claude-opus-5",
      { crossEditionMode: true },
    );
    assert.equal(result, true);
  });
});

describe("CROSS_EDITION_TERM_MIN_LEN / CROSS_EDITION_TERM_MIN_SHARED (#4262)", () => {
  it("são inteiros positivos", () => {
    assert.ok(Number.isInteger(CROSS_EDITION_TERM_MIN_LEN) && CROSS_EDITION_TERM_MIN_LEN > 0);
    assert.ok(Number.isInteger(CROSS_EDITION_TERM_MIN_SHARED) && CROSS_EDITION_TERM_MIN_SHARED > 0);
  });
});

// ---------------------------------------------------------------------------
// #4360 CASO REAL 260731 — LANÇAMENTOS duplica mesmo lançamento (Gemini
// Robotics ER 2): model-card page + post oficial de blog, NENHUM dos 2 é
// destaque — o dedup destaque-vs-bucket nunca os compara entre si.
// ---------------------------------------------------------------------------

import {
  dedupLancamentoIntraBucket,
  isModelCardOrHubPage,
} from "../scripts/dedup-intra-edition.ts";

describe("isModelCardOrHubPage (#4360)", () => {
  it("detecta path /models/model-cards/ (caso real deepmind.google)", () => {
    assert.equal(
      isModelCardOrHubPage(
        "https://deepmind.google/models/model-cards/gemini-robotics-er-2",
      ),
      true,
    );
  });

  it("detecta huggingface.co/{org}/{model} como model card", () => {
    assert.equal(isModelCardOrHubPage("https://huggingface.co/meta-llama/Llama-3-70B"), true);
  });

  it("NÃO detecta huggingface.co/blog/{slug} (post, não model card)", () => {
    assert.equal(isModelCardOrHubPage("https://huggingface.co/blog/smollm3"), false);
  });

  it("NÃO detecta post oficial de blog (caso real blog.google)", () => {
    assert.equal(
      isModelCardOrHubPage(
        "https://blog.google/technology/google-deepmind/gemini-robotics-er-2/",
      ),
      false,
    );
  });

  it("retorna false para URL inválida", () => {
    assert.equal(isModelCardOrHubPage("not-a-url"), false);
  });
});

describe("dedupLancamentoIntraBucket (#4360)", () => {
  it("CASO REAL: consolida model-card + post oficial do mesmo lançamento (Gemini Robotics ER 2)", () => {
    const articles = [
      {
        url: "https://deepmind.google/models/model-cards/gemini-robotics-er-2",
        title: "Gemini Robotics-ER 1.5",
        // sem summary — model card, specs técnicas sem prosa descritiva
      },
      {
        url: "https://blog.google/technology/google-deepmind/gemini-robotics-er-2/",
        title: "Gemini Robotics-ER 1.5: bringing AI into the physical world",
        summary: "Google DeepMind announces the newest embodied reasoning model.",
      },
    ];

    const { kept, removed } = dedupLancamentoIntraBucket(articles);

    assert.equal(removed.length, 1, "deve consolidar em 1 item");
    assert.equal(
      removed[0].url,
      "https://deepmind.google/models/model-cards/gemini-robotics-er-2",
      "model-card (sem descrição) deve ser o removido",
    );
    assert.equal(kept.length, 1);
    assert.equal(
      kept[0].url,
      "https://blog.google/technology/google-deepmind/gemini-robotics-er-2/",
      "post oficial com descrição deve ser o mantido",
    );
    assert.equal(removed[0].consolidated_into, kept[0].url);
  });

  it("2 lançamentos DIFERENTES não são consolidados", () => {
    const articles = [
      { url: "https://a.com/1", title: "Google lança Pixel 10 Pro", summary: "..." },
      { url: "https://b.com/2", title: "Google anuncia Android 17", summary: "..." },
    ];
    const { kept, removed } = dedupLancamentoIntraBucket(articles);
    assert.equal(removed.length, 0);
    assert.equal(kept.length, 2);
  });

  it("bucket com 1 único item não é afetado", () => {
    const articles = [{ url: "https://a.com/1", title: "Gemini Robotics ER 2" }];
    const { kept, removed } = dedupLancamentoIntraBucket(articles);
    assert.equal(removed.length, 0);
    assert.equal(kept.length, 1);
  });

  it("bucket vazio não é afetado", () => {
    const { kept, removed } = dedupLancamentoIntraBucket([]);
    assert.equal(removed.length, 0);
    assert.equal(kept.length, 0);
  });

  it("3 itens do mesmo lançamento consolidam em 1 (transitividade)", () => {
    const articles = [
      { url: "https://a.com/1", title: "Gemini Robotics ER 2 model card" },
      {
        url: "https://b.com/2",
        title: "Introducing Gemini Robotics ER 2",
        summary: "Descrição oficial do lançamento.",
      },
      { url: "https://c.com/3", title: "Gemini Robotics ER 2 details" },
    ];
    const { kept, removed } = dedupLancamentoIntraBucket(articles);
    assert.equal(kept.length, 1, "só 1 sobrevive");
    assert.equal(removed.length, 2);
    assert.equal(kept[0].url, "https://b.com/2", "o único com summary sobrevive");
  });

  it("desempate por segundo nível: nenhum tem summary → prefere o que NÃO é model-card/hub page", () => {
    // Exercita o 2º nível de desempate (isModelCardOrHubPage) — diferente do
    // teste CASO REAL acima, que já decide no 1º nível (summary presente vs
    // ausente). Aqui NENHUM dos 2 itens tem summary, então a decisão cai pro
    // isModelCardOrHubPage.
    const articles = [
      {
        url: "https://huggingface.co/meta-llama/Llama-4-Scout",
        title: "Llama 4 Scout",
        // sem summary — model card (huggingface.co/{org}/{model})
      },
      {
        url: "https://ai.meta.com/blog/llama-4-scout-announcement/",
        title: "Introducing Llama 4 Scout",
        // sem summary também — mas NÃO é model-card/hub page
      },
    ];
    const { kept, removed } = dedupLancamentoIntraBucket(articles);
    assert.equal(removed.length, 1);
    assert.equal(
      removed[0].url,
      "https://huggingface.co/meta-llama/Llama-4-Scout",
      "model card deve ser o removido quando nenhum tem summary",
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].url, "https://ai.meta.com/blog/llama-4-scout-announcement/");
  });

  it("dedupIntraEdition (integração): consolida duplicata intra-LANÇAMENTOS quando nenhum é destaque", () => {
    const input = {
      highlights: [
        { rank: 1, url: "https://highlight.com/x", title: "Um destaque completamente não-relacionado" },
      ],
      radar: [],
      lancamento: [
        {
          url: "https://deepmind.google/models/model-cards/gemini-robotics-er-2",
          title: "Gemini Robotics-ER 1.5",
        },
        {
          url: "https://blog.google/technology/google-deepmind/gemini-robotics-er-2/",
          title: "Gemini Robotics-ER 1.5: bringing AI into the physical world",
          summary: "Google DeepMind announces the newest embodied reasoning model.",
        },
      ],
      use_melhor: [],
      video: [],
    };

    const { kept, removed } = dedupIntraEdition(input);

    const intraBucketRemoved = removed.filter((r) => r.match_type === "intra_bucket");
    assert.equal(intraBucketRemoved.length, 1, "deve consolidar via intra_bucket");
    assert.equal(
      intraBucketRemoved[0].url,
      "https://deepmind.google/models/model-cards/gemini-robotics-er-2",
    );
    assert.equal(intraBucketRemoved[0].bucket, "lancamento");
    assert.equal(kept.lancamento?.length, 1, "lançamento consolidado em 1 item");
    assert.equal(
      kept.lancamento?.[0].url,
      "https://blog.google/technology/google-deepmind/gemini-robotics-er-2/",
    );
    // destaque não-relacionado preservado
    assert.equal(kept.highlights?.length, 1);
  });
});
