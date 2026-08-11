/**
 * stage1-summary-pipeline-integration.test.ts (#4988, #4986)
 *
 * Teste de regressão de PONTA-A-PONTA: um `RunRecord[]` com `summary`
 * preenchido deve preservar `summary` através de TODO o pipeline do Stage 1
 * até `tmp-finalists.json` — assemble-research-pool → dedup → categorize →
 * split-for-scoring/merge-scored-chunks.
 *
 * Encadeia as funções PURAS de produção reais (não reimplementações) —
 * `flattenRunRecords`, `dedup`, `categorizeArticles`, `flattenCategorized`,
 * `mergeChunks` — exatamente como o orchestrator Stage 1 as invoca em
 * sequência (ver `.claude/agents/orchestrator-stage-1-research.md` §1g-ter,
 * 1l, 1m, 1q.1/1q.3). Cobre a causa raiz do #4955/#4988/#4986: edição 260811
 * ao vivo, 9/10 artigos + o D1 chegaram ao Stage 4/finalists sem `summary`
 * porque a montagem do pool inicial era manual (LLM copiando campo a campo)
 * em vez de repasse verbatim — corrigido em `assemble-research-pool.ts`.
 *
 * `verify-summary-integrity.test.ts` cobre o checkpoint determinístico que
 * detecta a regressão SE ela voltar; este teste cobre o caminho feliz
 * ponta-a-ponta com as funções de produção reais.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flattenRunRecords, type RunRecordLike } from "../scripts/assemble-research-pool.ts";
import { dedup } from "../scripts/dedup.ts";
import { categorizeArticles } from "../scripts/categorize.ts";
import { flattenCategorized } from "../scripts/split-articles-for-scoring.ts";
import { mergeChunks, type ChunkScoreFile } from "../scripts/merge-scored-chunks.ts";
import { findSummaryLossViolations } from "../scripts/verify-summary-integrity.ts";

describe("Stage 1: summary sobrevive ponta-a-ponta (RunRecord[] → tmp-finalists.json)", () => {
  it("artigo com summary no researcher-results.json chega com summary em tmp-finalists.json", () => {
    const D1_URL = "https://arxiv.org/abs/2608.99999";
    const D1_SUMMARY = "Resumo completo do paper em 1-2 frases, sem hype, com o núcleo do achado.";

    // 1) researcher-results.json — RunRecord[] tal como gravado pelo passo 1g.
    const runs: RunRecordLike[] = [
      {
        source: "discovery:pesquisa-ia",
        outcome: "ok",
        articles: [
          {
            url: D1_URL,
            title: "Novo modelo de linguagem para IA generativa reduz custo de inferência",
            summary: D1_SUMMARY,
            published_at: "2026-08-10",
            author: "Fulano de Tal",
          },
        ],
      },
      {
        source: "Fonte quebrada",
        outcome: "fail",
        reason: "timeout",
        articles: [{ url: "https://nunca-deveria-aparecer.com", summary: "não deveria sobreviver" }],
      } as RunRecordLike,
    ];

    // 2) assemble-research-pool.ts (#4955) — monta tmp-articles-raw.json.
    const rawPool = flattenRunRecords(runs);
    assert.equal(rawPool.length, 1, "só o run 'ok' entra no pool");
    assert.equal(rawPool[0].summary, D1_SUMMARY, "summary sobrevive do RunRecord ao pool bruto");

    // 3) dedup.ts (passo 1l) — sem histórico passado, nada é removido.
    const dedupResult = dedup(rawPool as never, new Set(), 0.85);
    assert.equal(dedupResult.kept.length, 1);
    assert.equal(dedupResult.kept[0].summary, D1_SUMMARY, "summary sobrevive ao dedup");

    // 4) categorize.ts (passo 1m) — bucketed { lancamento, radar, use_melhor, video }.
    const categorized = categorizeArticles(dedupResult.kept as never);
    const flatCategorized = flattenCategorized(categorized as never);
    assert.equal(flatCategorized.length, 1);
    const categorizedArticle = flatCategorized.find((a) => a.url === D1_URL);
    assert.ok(categorizedArticle, "artigo sobrevive ao categorize");
    assert.equal(categorizedArticle!.summary, D1_SUMMARY, "summary sobrevive ao categorize");

    // 5) split-articles-for-scoring.ts (1q.1) → scorer-chunk (LLM, output enxuto
    //    {url, score}) → merge-scored-chunks.ts (1q.3) reconstrói tmp-finalists.json
    //    a partir do pool categorizado — NÃO do output do scorer-chunk.
    const chunkScores: ChunkScoreFile = { all_scored: [{ url: D1_URL, score: 95 }] };
    const merged = mergeChunks(categorized as never, [chunkScores], 15, 0);
    assert.equal(merged.catastrophic, false);
    assert.equal(merged.finalists.length, 1);
    const finalist = merged.finalists[0];
    assert.equal(finalist.url, D1_URL);
    assert.equal(
      (finalist.article as { summary?: string }).summary,
      D1_SUMMARY,
      "#4986: summary deve sobreviver intacto até tmp-finalists.json",
    );

    // 6) Checkpoint de integridade (#4986) confirma: nenhuma violação entre
    //    o pool bruto e o shape real de tmp-finalists.json.
    const finalistsShape = { finalists: merged.finalists };
    const violations = findSummaryLossViolations(
      rawPool as never,
      (finalistsShape.finalists as Array<{ url: string; article?: { url?: string; summary?: unknown; title?: unknown } }>).map(
        (f) => ({ url: f.url, title: f.article?.title, summary: f.article?.summary }),
      ),
    );
    assert.deepEqual(violations, [], "checkpoint não deve reportar nenhuma violação no caminho feliz");
  });
});
