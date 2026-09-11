/**
 * test/scoring-features.test.ts (#7975)
 *
 * Cobre scripts/lib/scoring-features.ts — extração determinística de
 * features de score a partir de 01-categorized.json/01-approved.json.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractScoringFeatures,
  editionDateFromAammdd,
  computeRecencyHours,
  launchHeuristicsSha,
  NON_CALIBRATABLE_FEATURES,
} from "../scripts/lib/scoring-features.ts";

describe("editionDateFromAammdd (#7975)", () => {
  it("converte AAMMDD válido pro meio-dia UTC daquele dia", () => {
    const d = editionDateFromAammdd("260911");
    assert.ok(d);
    assert.equal(d!.toISOString(), "2026-09-11T12:00:00.000Z");
  });

  it("retorna null pra formato inválido, nunca lança", () => {
    assert.equal(editionDateFromAammdd("abc123"), null);
    assert.equal(editionDateFromAammdd("2609111"), null);
    assert.equal(editionDateFromAammdd(""), null);
  });
});

describe("computeRecencyHours (#7975)", () => {
  const editionDate = editionDateFromAammdd("260911")!;

  it("calcula horas entre published_at e a data da edição", () => {
    const hours = computeRecencyHours({ published_at: "2026-09-10T19:03:11.000Z" }, editionDate);
    // 260911 meio-dia UTC - 260910T19:03:11 = 16h56m49s ≈ 16.9h
    assert.equal(hours, 16.9);
  });

  it("usa date (YYYY-MM-DD) como fallback quando published_at ausente", () => {
    const hours = computeRecencyHours({ date: "2026-09-10" }, editionDate);
    assert.equal(hours, 36); // meia-noite 260910 até meio-dia 260911
  });

  it("retorna null quando nenhuma das duas datas parseia, nunca lança", () => {
    assert.equal(computeRecencyHours({}, editionDate), null);
    assert.equal(computeRecencyHours({ published_at: "não é data" }, editionDate), null);
  });
});

describe("extractScoringFeatures (#7975)", () => {
  const editionDate = editionDateFromAammdd("260911")!;

  function categorized(overrides: Record<string, unknown[]>): Record<string, unknown> {
    return { highlights: [], runners_up: [], lancamento: [], radar: [], use_melhor: [], video: [], ...overrides };
  }

  it("extrai bonuses_applied como booleanos por prefixo, sem colidir howto_br com howto_br_source", async () => {
    const json = categorized({
      radar: [
        {
          url: "https://example.com/a",
          title: "Artigo A",
          score: 70,
          bonuses_applied: ["hands_on:+8", "howto_br_source:+3"],
        },
      ],
    });
    const [row] = await extractScoringFeatures(json, editionDate);
    assert.equal(row.hands_on, true);
    assert.equal(row.academy, false);
    assert.equal(row.howto_br, false, "howto_br não pode ser true só porque howto_br_source é");
    assert.equal(row.howto_br_source, true);
    assert.equal(row.primary_source, false);
  });

  it("extrai howto_br:true independente de howto_br_source estar ausente", async () => {
    const json = categorized({
      radar: [{ url: "https://example.com/b", title: "B", bonuses_applied: ["howto_br:+5"] }],
    });
    const [row] = await extractScoringFeatures(json, editionDate);
    assert.equal(row.howto_br, true);
    assert.equal(row.howto_br_source, false);
  });

  it("lê highlights via article.* (mesma indireção de classifyApprovedDiff)", async () => {
    const json = categorized({
      highlights: [{ article: { url: "https://example.com/d1", title: "D1", score: 90 } }],
    });
    const [row] = await extractScoringFeatures(json, editionDate);
    assert.equal(row.url, "https://example.com/d1");
    assert.equal(row.bucket, "highlights");
    assert.equal(row.score, 90);
  });

  it("cluster_sources_count reflete o array real", async () => {
    const json = categorized({
      radar: [
        {
          url: "https://example.com/c",
          title: "C",
          cluster_sources: [{ url: "https://example.com/c-en" }, { url: "https://example.com/c-outra" }],
        },
      ],
    });
    const [row] = await extractScoringFeatures(json, editionDate);
    assert.equal(row.cluster_sources_count, 2);
  });

  it("negative_impact vem direto do campo top-level", async () => {
    const json = categorized({
      radar: [{ url: "https://example.com/d", title: "D", negative_impact: true }],
    });
    const [row] = await extractScoringFeatures(json, editionDate);
    assert.equal(row.negative_impact, true);
  });

  it("has_official_link detecta domínio oficial cadastrado (openai.com)", async () => {
    const json = categorized({
      lancamento: [{ url: "https://openai.com/index/algo-novo", title: "Novo" }],
    });
    const [row] = await extractScoringFeatures(json, editionDate);
    assert.equal(row.has_official_link, true);
    assert.equal(row.domain, "openai.com");
  });

  it("has_official_link é false pra domínio de imprensa cobrindo o mesmo fato", async () => {
    const json = categorized({
      radar: [{ url: "https://canaltech.com.br/inteligencia-artificial/algo", title: "Cobertura" }],
    });
    const [row] = await extractScoringFeatures(json, editionDate);
    assert.equal(row.has_official_link, false);
  });

  it("title_char_count e domain calculados corretamente, domain null pra URL inválida", async () => {
    const json = categorized({
      radar: [
        { url: "https://www.example.com/x", title: "Doze letras" },
        { url: "não-é-uma-url", title: "T" },
      ],
    });
    const rows = await extractScoringFeatures(json, editionDate);
    assert.equal(rows[0].title_char_count, "Doze letras".length);
    assert.equal(rows[0].domain, "example.com", "www. deve ser removido");
    assert.equal(rows[1].domain, null);
  });

  it("features não implementadas nesta fase são sempre null, nunca fabricadas", async () => {
    const json = categorized({ radar: [{ url: "https://example.com/e", title: "E" }] });
    const [row] = await extractScoringFeatures(json, editionDate);
    assert.equal(row.novelty_vs_past_editions, null);
    assert.equal(row.source_reputation_ctr_30d, null);
    assert.equal(row.source_reputation_ctr_90d, null);
  });

  it("proveniência: feature_available_since é ISO válido, launch_heuristics_sha é string ou null (nunca lança)", async () => {
    const json = categorized({ radar: [{ url: "https://example.com/f", title: "F" }] });
    const [row] = await extractScoringFeatures(json, editionDate);
    assert.ok(!Number.isNaN(new Date(row.feature_available_since).getTime()));
    assert.ok(row.launch_heuristics_sha === null || typeof row.launch_heuristics_sha === "string");
  });

  it("URL duplicada entre buckets: só a 1ª ocorrência vira linha (mesmo padrão de indexPool)", async () => {
    const json = categorized({
      lancamento: [{ url: "https://example.com/dup", title: "Dup" }],
      radar: [{ url: "https://example.com/dup", title: "Dup outra vez" }],
    });
    const rows = await extractScoringFeatures(json, editionDate);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bucket, "lancamento");
  });

  it("editionDate null propaga recency_hours null sem lançar", async () => {
    const json = categorized({
      radar: [{ url: "https://example.com/g", title: "G", published_at: "2026-09-10T00:00:00.000Z" }],
    });
    const [row] = await extractScoringFeatures(json, null);
    assert.equal(row.recency_hours, null);
  });

  it("bucket ausente/malformado (não-array) é ignorado sem lançar", async () => {
    const json = { ...categorized({}), radar: "não é array" as unknown as unknown[] };
    const rows = await extractScoringFeatures(json, editionDate);
    assert.deepEqual(rows, []);
  });
});

describe("NON_CALIBRATABLE_FEATURES (#7975)", () => {
  it("contém negative_impact e bucket — nunca podem virar coeficiente de calibração", () => {
    assert.ok(NON_CALIBRATABLE_FEATURES.has("negative_impact"));
    assert.ok(NON_CALIBRATABLE_FEATURES.has("bucket"));
  });
});

describe("launchHeuristicsSha (#7975)", () => {
  it("retorna string (repo real tem git) ou null, nunca lança", () => {
    const sha = launchHeuristicsSha();
    assert.ok(sha === null || (typeof sha === "string" && sha.length === 40));
  });
});
