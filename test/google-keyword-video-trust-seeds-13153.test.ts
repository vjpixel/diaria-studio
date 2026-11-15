/**
 * test/google-keyword-video-trust-seeds-13153.test.ts (#13153)
 *
 * Regressão: o filtro de ruído de marca do pull de keywords descartava as
 * sementes de vídeo sem marcador forte de IA ("como usar o gemini", "como usar
 * o claude", "gemini vs claude", "o que é vibe coding") junto com os termos
 * relacionados. O modo `trustSeeds` (flag `--trust-seeds` do CLI, usada só no
 * passo de vídeo da task mensal) preserva essas sementes; o modo default, que
 * alimenta a descoberta do Stage 1, continua filtrando igual. Sem rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { partitionIdeas, type KeywordIdea } from "../scripts/lib/google-keyword-planner.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";

function idea(keyword: string, vol = 100): KeywordIdea {
  return { keyword, avgMonthlySearches: vol, competition: "LOW", competitionIndex: 1, lowBidBrl: null, highBidBrl: null };
}

const SEEDS = ["como usar o gemini", "como usar o claude", "gemini vs claude", "o que é vibe coding", "o que é chatgpt"];

// Vizinhança realista: termos de marca/genéricos que compartilham token com a
// semente e não têm marcador de IA ("gemini" = DJ, "claude" = nome próprio).
const IDEAS: KeywordIdea[] = [
  ...SEEDS.map((s) => idea(s, 1000)),
  idea("como usar o gemini no celular", 500),
  idea("como usar o claude no pc", 300),
  idea("gemini vs claude qual o melhor", 200),
  idea("o que é vibe coding na prática", 90),
  idea("gemini dj"),
  idea("cdj gemini"),
  idea("como usar o google drive"),
  idea("como usar o excel"),
  idea("claude monet"),
  idea("claude troisgros"),
  idea("gemini signo"),
  idea("o que é coding"),
  idea("vibe musica"),
];

const BRAND_NOISE = ["gemini dj", "cdj gemini", "como usar o google drive", "como usar o excel", "claude monet", "claude troisgros", "gemini signo", "o que é coding", "vibe musica"];

describe("#13153 — pull de vídeo preserva as sementes 'como usar X'", () => {
  it("default (Stage 1): o filtro de marca segue descartando sementes sem marcador (comportamento preservado)", () => {
    const { kept, contaminated } = partitionIdeas(IDEAS, SEEDS);
    const keptSet = new Set(kept.map((i) => i.keyword));
    // A premissa do bug: sem o modo de vídeo, pelo menos uma semente cai.
    assert.ok(contaminated.length > 0, "o cenário precisa reproduzir a contaminação");
    assert.ok(SEEDS.some((s) => !keptSet.has(s)));
    assert.ok(!keptSet.has("como usar o gemini no celular"));
  });

  it("trustSeeds: todas as sementes ficam em kept e nenhuma vira contaminada", () => {
    const { kept, contaminated } = partitionIdeas(IDEAS, SEEDS, { trustSeeds: true });
    const keptSet = new Set(kept.map((i) => i.keyword));
    for (const s of SEEDS) assert.ok(keptSet.has(s), `semente descartada: ${s}`);
    assert.deepEqual(contaminated, []);
  });

  it("trustSeeds: termos que contêm a semente inteira ficam; ruído de marca continua fora", () => {
    const { kept, discarded } = partitionIdeas(IDEAS, SEEDS, { trustSeeds: true });
    const keptSet = new Set(kept.map((i) => i.keyword));
    const discSet = new Set(discarded.map((i) => i.keyword));
    for (const t of ["como usar o gemini no celular", "como usar o claude no pc", "gemini vs claude qual o melhor", "o que é vibe coding na prática"]) {
      assert.ok(keptSet.has(t), `relacionado descartado: ${t}`);
    }
    for (const t of BRAND_NOISE) assert.ok(discSet.has(t), `ruído entrou na tabela: ${t}`);
    assert.equal(kept.length + discarded.length, IDEAS.length);
  });

  it("trustSeeds casa a semente por palavra inteira, com acento e caixa normalizados", () => {
    const { kept } = partitionIdeas(
      [idea("Como Usar o Gêmini hoje"), idea("como usar o geminiano")],
      ["como usar o gemini"],
      { trustSeeds: true },
    );
    const keptSet = new Set(kept.map((i) => i.keyword));
    assert.ok(keptSet.has("Como Usar o Gêmini hoje"));
    assert.ok(!keptSet.has("como usar o geminiano"));
  });

  it("a task mensal passa --trust-seeds só no pull de vídeo, nunca no de seed/keywords.csv", () => {
    const task = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Google-Keyword-Monthly-Pull");
    assert.ok(task);
    const video = task.steps.find((s) => s.key === "video-keywords");
    const general = task.steps.find((s) => s.key === "keywords");
    assert.ok(video?.args?.includes("--trust-seeds"));
    assert.ok(video?.args?.includes("seed/video-keywords.csv"));
    assert.ok(!(general?.args ?? []).includes("--trust-seeds"));
  });
});
