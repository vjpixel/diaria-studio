/**
 * test/corpus-index-coverage.test.ts (#5125 "índices por mês e por tema")
 *
 * Cobre `scripts/lib/corpus-index-coverage.ts` com fixture pequena e
 * determinística — não lê o corpus real (`data/beehiiv-cache/posts/`),
 * roda sem o junction `data/`, sem depender de sessão local.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeCorpusIndexCoverage,
  renderCorpusIndexStatusMarkdown,
  type CorpusEditionSummary,
  type ThemeCoverageInput,
} from "../scripts/lib/corpus-index-coverage.ts";

describe("computeCorpusIndexCoverage (#5125)", () => {
  const editions: CorpusEditionSummary[] = [
    { slug: "edicao-a", hasResolvableDate: true },
    { slug: "edicao-b", hasResolvableDate: true },
    { slug: "edicao-c", hasResolvableDate: true },
    { slug: "edicao-d", hasResolvableDate: false }, // slug/data não resolvível (caso raro)
    { slug: "edicao-e", hasResolvableDate: true },
  ];

  const themes: ThemeCoverageInput[] = [
    { slug: "tema-x", label: "Tema X", editionSlugs: ["edicao-a", "edicao-b"] },
    // "edicao-b" casa 2 temas (overlap legítimo, mesmo comportamento real
    // de meta-ai+mercado-trabalho) — não deve ser contado 2x na união.
    { slug: "tema-y", label: "Tema Y", editionSlugs: ["edicao-b", "edicao-c"] },
  ];

  it("totalEditions reflete o tamanho do corpus de entrada", () => {
    const result = computeCorpusIndexCoverage(editions, themes);
    assert.equal(result.totalEditions, 5);
  });

  it("monthIndexCoveredEditions conta só edições com data resolvível", () => {
    const result = computeCorpusIndexCoverage(editions, themes);
    assert.equal(result.monthIndexCoveredEditions, 4); // todas menos "edicao-d"
  });

  it("themeIndexCoveredEditions é a UNIÃO (não a soma) das edições por tema", () => {
    const result = computeCorpusIndexCoverage(editions, themes);
    // a, b, c cobertas (união de tema-x={a,b} e tema-y={b,c}); d e e não.
    assert.equal(result.themeIndexCoveredEditions, 3);
  });

  it("themeCoveragePct é a porcentagem arredondada a 1 casa decimal", () => {
    const result = computeCorpusIndexCoverage(editions, themes);
    assert.equal(result.themeCoveragePct, 60); // 3/5 = 60.0%
  });

  it("byTheme reporta a contagem POR TEMA (com overlap, sem dedupe entre temas)", () => {
    const result = computeCorpusIndexCoverage(editions, themes);
    assert.deepEqual(result.byTheme, [
      { slug: "tema-x", label: "Tema X", editionCount: 2 },
      { slug: "tema-y", label: "Tema Y", editionCount: 2 },
    ]);
  });

  it("uncoveredSlugs lista as edições fora de todo tema, ordenadas alfabeticamente", () => {
    const result = computeCorpusIndexCoverage(editions, themes);
    assert.deepEqual(result.uncoveredSlugs, ["edicao-d", "edicao-e"]);
  });

  it("um editionSlug de tema que não pertence ao corpus não infla a cobertura", () => {
    const themesWithOrphan: ThemeCoverageInput[] = [
      { slug: "tema-x", label: "Tema X", editionSlugs: ["edicao-a", "slug-orfao-nao-no-corpus"] },
    ];
    const result = computeCorpusIndexCoverage(editions, themesWithOrphan);
    assert.equal(result.themeIndexCoveredEditions, 1); // só "edicao-a" conta
    assert.ok(!result.uncoveredSlugs.includes("slug-orfao-nao-no-corpus"));
  });

  it("corpus vazio produz zeros, nunca lança nem NaN", () => {
    const result = computeCorpusIndexCoverage([], themes);
    assert.equal(result.totalEditions, 0);
    assert.equal(result.themeIndexCoveredEditions, 0);
    assert.equal(result.themeCoveragePct, 0);
    assert.deepEqual(result.uncoveredSlugs, []);
  });

  it("nenhum tema publicado ainda produz 0% de cobertura por tema, todo corpus 'uncovered'", () => {
    const result = computeCorpusIndexCoverage(editions, []);
    assert.equal(result.themeIndexCoveredEditions, 0);
    assert.equal(result.byTheme.length, 0);
    assert.equal(result.uncoveredSlugs.length, 5);
  });

  it("edição casando o mesmo tema 2x (editionSlugs duplicado) conta 1x", () => {
    const dupedTheme: ThemeCoverageInput[] = [
      { slug: "tema-x", label: "Tema X", editionSlugs: ["edicao-a", "edicao-a", "edicao-b"] },
    ];
    const result = computeCorpusIndexCoverage(editions, dupedTheme);
    assert.equal(result.byTheme[0].editionCount, 2);
  });
});

describe("renderCorpusIndexStatusMarkdown (#5125)", () => {
  const result = computeCorpusIndexCoverage(
    [
      { slug: "edicao-a", hasResolvableDate: true },
      { slug: "edicao-b", hasResolvableDate: true },
    ],
    [{ slug: "tema-x", label: "Tema X", editionSlugs: ["edicao-a"] }],
  );

  it("inclui a data de geração passada por parâmetro (nunca Date.now() interno)", () => {
    const md = renderCorpusIndexStatusMarkdown(result, { generatedAt: "2026-01-01" });
    assert.match(md, /Gerado em 2026-01-01/);
  });

  it("cita as 2 URLs de produção (arquivo raiz + /temas/) que já cobrem o corpus", () => {
    const md = renderCorpusIndexStatusMarkdown(result, { generatedAt: "2026-01-01" });
    assert.match(md, /https:\/\/arquivo\.diar\.ia\.br\//);
    assert.match(md, /https:\/\/arquivo\.diar\.ia\.br\/temas\//);
  });

  it("lista cada tema com seu rótulo e contagem", () => {
    const md = renderCorpusIndexStatusMarkdown(result, { generatedAt: "2026-01-01" });
    assert.match(md, /\*\*Tema X\*\* \(`tema-x`\): 1 edição\(ões\)/);
  });

  it("trunca a lista de uncovered em 20 com contagem do resto, quando longa", () => {
    const manyEditions: CorpusEditionSummary[] = Array.from({ length: 25 }, (_, i) => ({
      slug: `edicao-${String(i).padStart(2, "0")}`,
      hasResolvableDate: true,
    }));
    const bigResult = computeCorpusIndexCoverage(manyEditions, []);
    const md = renderCorpusIndexStatusMarkdown(bigResult, { generatedAt: "2026-01-01" });
    assert.match(md, /e mais 5/);
  });

  it("corpus totalmente coberto não lista nenhuma edição sem tema", () => {
    const fullyCovered = computeCorpusIndexCoverage(
      [{ slug: "edicao-a", hasResolvableDate: true }],
      [{ slug: "tema-x", label: "Tema X", editionSlugs: ["edicao-a"] }],
    );
    const md = renderCorpusIndexStatusMarkdown(fullyCovered, { generatedAt: "2026-01-01" });
    assert.match(md, /nenhuma — todo o corpus confirmado está coberto/);
  });
});
