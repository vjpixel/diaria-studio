/**
 * test/search-demand-curation-8370.test.ts (#8370 Peça 1)
 *
 * Cobre o filtro de elegibilidade (competição LOW/MEDIUM + volume ~200-5.000),
 * a rotação por edição, e a integração fail-soft com `data/seo/google-keywords-*.json`
 * (achar o arquivo mais recente, ler `kept`, degradar pra [] sem pull ainda rodado).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterDemandKeywords,
  pickSearchDemandDiscoveryQueries,
  findLatestKeywordPlannerFile,
  loadSearchDemandIdeas,
  SEARCH_DEMAND_MIN_VOLUME,
  SEARCH_DEMAND_MAX_VOLUME,
} from "../scripts/lib/search-demand-curation.ts";
import type { KeywordIdea } from "../scripts/lib/google-keyword-planner.ts";

function idea(overrides: Partial<KeywordIdea>): KeywordIdea {
  return {
    keyword: "termo",
    avgMonthlySearches: 1000,
    competition: "LOW",
    competitionIndex: null,
    lowBidBrl: null,
    highBidBrl: null,
    ...overrides,
  };
}

describe("#8370 — filterDemandKeywords (competição + volume de nicho)", () => {
  it("mantém LOW/MEDIUM dentro do range 200-5000, descarta o resto", () => {
    const ideas: KeywordIdea[] = [
      idea({ keyword: "nicho baixo", competition: "LOW", avgMonthlySearches: 480 }),
      idea({ keyword: "nicho medio", competition: "MEDIUM", avgMonthlySearches: 3600 }),
      idea({ keyword: "volume de marca", competition: "LOW", avgMonthlySearches: 30_400_000 }),
      idea({ keyword: "competicao alta", competition: "HIGH", avgMonthlySearches: 1000 }),
      idea({ keyword: "abaixo do piso", competition: "LOW", avgMonthlySearches: 50 }),
      idea({ keyword: "sem volume", competition: "LOW", avgMonthlySearches: null }),
      idea({ keyword: "no teto exato", competition: "LOW", avgMonthlySearches: 5000 }),
      idea({ keyword: "no piso exato", competition: "MEDIUM", avgMonthlySearches: 200 }),
      idea({ keyword: "acima do teto", competition: "LOW", avgMonthlySearches: 5001 }),
    ];
    const kept = filterDemandKeywords(ideas).map((i) => i.keyword);
    assert.deepEqual(kept.sort(), [
      "nicho baixo",
      "nicho medio",
      "no piso exato",
      "no teto exato",
    ].sort());
  });

  it("range default é 200-5000 (constantes exportadas)", () => {
    assert.equal(SEARCH_DEMAND_MIN_VOLUME, 200);
    assert.equal(SEARCH_DEMAND_MAX_VOLUME, 5000);
  });

  it("aceita range customizado via opts", () => {
    const ideas: KeywordIdea[] = [idea({ keyword: "deepfake", competition: "LOW", avgMonthlySearches: 33_100 })];
    assert.deepEqual(filterDemandKeywords(ideas), []);
    assert.deepEqual(
      filterDemandKeywords(ideas, { maxVolume: 40_000 }).map((i) => i.keyword),
      ["deepfake"],
    );
  });
});

describe("#8370 — pickSearchDemandDiscoveryQueries (rotação por edição)", () => {
  const ideas: KeywordIdea[] = [
    idea({ keyword: "termo a", competition: "LOW", avgMonthlySearches: 5000 }),
    idea({ keyword: "termo b", competition: "MEDIUM", avgMonthlySearches: 3000 }),
    idea({ keyword: "termo c", competition: "LOW", avgMonthlySearches: 1000 }),
    idea({ keyword: "fora do range", competition: "LOW", avgMonthlySearches: 30_000_000 }),
  ];

  it("retorna count termos elegíveis, ordenados por volume desc antes de rotacionar", () => {
    const picked = pickSearchDemandDiscoveryQueries(ideas, 0, 2);
    assert.deepEqual(picked, ["termo a", "termo b"]);
  });

  it("rotaciona por editionNum (mesmo esquema de getHowToDiscoveryQueries)", () => {
    const picked = pickSearchDemandDiscoveryQueries(ideas, 1, 2);
    assert.deepEqual(picked, ["termo b", "termo c"]);
  });

  it("clampa count ao total elegível sem duplicar", () => {
    const picked = pickSearchDemandDiscoveryQueries(ideas, 0, 10);
    assert.deepEqual(picked, ["termo a", "termo b", "termo c"]);
  });

  it("pool vazio (sem termo elegível) -> []", () => {
    assert.deepEqual(pickSearchDemandDiscoveryQueries([], 260919, 2), []);
    const soNoise: KeywordIdea[] = [idea({ keyword: "so marca", avgMonthlySearches: 30_000_000 })];
    assert.deepEqual(pickSearchDemandDiscoveryQueries(soNoise, 260919, 2), []);
  });

  it("editionNum não-finito (NaN) cai pro slot 0 em vez de lançar", () => {
    const picked = pickSearchDemandDiscoveryQueries(ideas, NaN, 1);
    assert.deepEqual(picked, ["termo a"]);
  });
});

describe("#8370 — I/O fail-soft (data/seo/google-keywords-*.json)", () => {
  it("diretório ausente -> findLatestKeywordPlannerFile null, loadSearchDemandIdeas []", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-8370-"));
    try {
      assert.equal(findLatestKeywordPlannerFile(root), null);
      assert.deepEqual(loadSearchDemandIdeas(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("escolhe o arquivo mais recente por DATA NO NOME, não mtime", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-8370-"));
    try {
      const seoDir = join(root, "data", "seo");
      mkdirSync(seoDir, { recursive: true });
      // Escrito fora de ordem (o "antigo" tem mtime mais recente no disco).
      writeFileSync(join(seoDir, "google-keywords-2026-09-19.json"), JSON.stringify({ kept: [idea({ keyword: "de setembro" })] }));
      writeFileSync(join(seoDir, "google-keywords-2026-08-01.json"), JSON.stringify({ kept: [idea({ keyword: "de agosto" })] }));
      writeFileSync(join(seoDir, "google-keywords-2026-08-01.md"), "não é json, deve ser ignorado");
      const latest = findLatestKeywordPlannerFile(root);
      assert.ok(latest?.endsWith("google-keywords-2026-09-19.json"));
      const ideas = loadSearchDemandIdeas(root);
      assert.deepEqual(ideas.map((i) => i.keyword), ["de setembro"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("arquivo com JSON inválido ou sem `kept` -> [] (nunca lança)", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-8370-"));
    try {
      const seoDir = join(root, "data", "seo");
      mkdirSync(seoDir, { recursive: true });
      writeFileSync(join(seoDir, "google-keywords-2026-09-19.json"), "{ nao fecha");
      assert.deepEqual(loadSearchDemandIdeas(root), []);

      writeFileSync(join(seoDir, "google-keywords-2026-09-20.json"), JSON.stringify({ discarded: [] }));
      assert.deepEqual(loadSearchDemandIdeas(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("integração ponta a ponta: pull real (partitionIdeas.kept) -> query de discovery", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-8370-"));
    try {
      const seoDir = join(root, "data", "seo");
      mkdirSync(seoDir, { recursive: true });
      writeFileSync(
        join(seoDir, "google-keywords-2026-09-19.json"),
        JSON.stringify({
          pulled_at: "2026-09-19T00:00:00Z",
          seeds: ["inteligência artificial"],
          kept: [
            idea({ keyword: "impactos da inteligência artificial no mercado de trabalho", competition: "LOW", avgMonthlySearches: 480 }),
            idea({ keyword: "prompt engineering", competition: "LOW", avgMonthlySearches: 3600 }),
          ],
          discarded: [],
          contaminated_seeds: [],
          raw: [],
        }),
      );
      const picked = pickSearchDemandDiscoveryQueries(loadSearchDemandIdeas(root), 260919, 2);
      assert.deepEqual(picked, ["impactos da inteligência artificial no mercado de trabalho", "prompt engineering"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
