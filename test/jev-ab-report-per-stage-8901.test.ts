/**
 * test/jev-ab-report-per-stage-8901.test.ts (#8901)
 *
 * O relatório A/B do Jev reduzia todo o uso a um número só (`tokens`, soma de
 * TODAS as etapas). Isso escondia que a Etapa 4 (dominada pelo gate humano)
 * afogava qualquer diferença real do Jev na Etapa 1 (onde ele atua) e nas
 * Etapas 1-3 (que rodam sem gate). Este teste cobre:
 *   - tokens/cost_usd extraídos POR ETAPA (1-4) a partir de `stage-status.json`;
 *   - soma 1-3 (sem gate) computada e marcada como métrica principal;
 *   - Etapa 4 reportada separadamente, marcada como ruidosa;
 *   - métrica ausente por etapa vira null + warning, nunca 0 fabricado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeMetrics,
  buildAbReport,
  renderAbReport,
  PRIMARY_METRIC_KEYS,
  NOISY_STAGE4_METRIC_KEYS,
  type EditionRaw,
  type Tri,
} from "../scripts/lib/jev-ab-report.ts";

const ok = <T>(value: T): Tri<T> => ({ state: "ok", value });
const absent = <T>(): Tri<T> => ({ state: "absent" });

function stageRow(stage: number, tokensIn: number, tokensOut: number, costUsd: number) {
  return { stage, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd, duration_ms: 60000, pipeline_ms: 60000 };
}

function makeEdition(id: string, rows: unknown[]): EditionRaw {
  return {
    edition: id,
    exists: true,
    profile: absent(),
    editorRequests: absent(),
    stageRows: ok(rows),
  };
}

describe("computeMetrics — tokens/cost_usd por etapa (#8901)", () => {
  it("extrai tokens_in/tokens_out/cost_usd de cada etapa 1-4 separadamente", () => {
    const e = makeEdition("260928", [
      stageRow(1, 1_000_000, 100_000, 5),
      stageRow(2, 2_000_000, 200_000, 10),
      stageRow(3, 500_000, 50_000, 2),
      stageRow(4, 203_600_000, 30_000_000, 119),
    ]);
    const { m } = computeMetrics(e);
    assert.equal(m.stage1TokensIn, 1_000_000);
    assert.equal(m.stage1TokensOut, 100_000);
    assert.equal(m.stage1CostUsd, 5);
    assert.equal(m.stage4TokensIn, 203_600_000);
    assert.equal(m.stage4CostUsd, 119);
  });

  it("soma Etapas 1-3 (sem gate) — dado íntegro nas 3 etapas", () => {
    const e = makeEdition("260928", [
      stageRow(1, 1_000_000, 100_000, 5),
      stageRow(2, 2_000_000, 200_000, 10),
      stageRow(3, 500_000, 50_000, 2),
      stageRow(4, 203_600_000, 30_000_000, 119),
    ]);
    const { m } = computeMetrics(e);
    assert.equal(m.stage1to3TokensIn, 3_500_000);
    assert.equal(m.stage1to3TokensOut, 350_000);
    assert.equal(m.stage1to3CostUsd, 17);
  });

  it("etapa sem dado (stage row ausente) vira null + warning AGREGADO (1 linha por métrica, não por etapa)", () => {
    const e = makeEdition("260928", [stageRow(1, 1_000_000, 100_000, 5)]);
    const { m, warnings } = computeMetrics(e);
    assert.equal(m.stage2TokensIn, null);
    assert.equal(m.stage2CostUsd, null);
    // #8912 self-review: warning agregado por métrica ("Etapas 2, 3, 4"), não 1 linha por etapa — reduz ruído.
    assert.ok(warnings.some((w) => w.includes("tokens_in/tokens_out ausentes nas Etapas") && w.includes("2") && w.includes("3") && w.includes("4")));
    assert.ok(warnings.some((w) => w.includes("cost_usd ausente nas Etapas")));
  });

  it("soma 1-3 parcial (falta 1 etapa) vira null — nunca soma só o que tem (#8946)", () => {
    const e = makeEdition("260928", [
      stageRow(1, 1_000_000, 100_000, 5),
      stageRow(3, 500_000, 50_000, 2),
    ]);
    const { m, warnings } = computeMetrics(e);
    // #8946: uma soma parcial (Etapa 2 ausente) subestimaria o total e faria
    // o braço parecer mais barato por dado faltante, não por comportamento
    // real — null é o resultado correto, não a soma do que sobrou.
    assert.equal(m.stage1to3TokensIn, null);
    assert.equal(m.stage1to3TokensOut, null);
    assert.equal(m.stage1to3CostUsd, null);
    // #8912 self-review: a parcialidade já é comunicada pelo warning agregado
    // "tokens_in/tokens_out ausentes nas Etapas 2, 4" — não duplicar com uma
    // linha específica de "soma parcial".
    assert.ok(!warnings.some((w) => w.includes("soma Etapas 1-3")));
    assert.ok(warnings.some((w) => w.includes("tokens_in/tokens_out ausentes nas Etapas") && w.includes("2")));
  });

  it("edição COMPLETA (cost_usd + 4 etapas presentes) não gera nenhum warning por-etapa (#8912 self-review)", () => {
    const e = makeEdition("260928", [
      stageRow(1, 1_000_000, 100_000, 5),
      stageRow(2, 2_000_000, 200_000, 10),
      stageRow(3, 500_000, 50_000, 2),
      stageRow(4, 203_600_000, 30_000_000, 119),
    ]);
    const { warnings } = computeMetrics(e);
    assert.ok(!warnings.some((w) => w.includes("tokens_in/tokens_out ausentes")));
    assert.ok(!warnings.some((w) => w.includes("cost_usd ausente")));
  });
});

describe("renderAbReport — Etapa 1 / 1-3 principais, Etapa 4 ruidosa (#8901)", () => {
  it("relatório inclui seção de métricas principais e seção de Etapa 4 marcada ruidosa", () => {
    const editions: EditionRaw[] = [
      makeEdition("260921", [stageRow(1, 1_000_000, 100_000, 5), stageRow(4, 50_000_000, 5_000_000, 30)]),
      makeEdition("260922", [stageRow(1, 1_200_000, 110_000, 6), stageRow(4, 60_000_000, 6_000_000, 40)]),
    ];
    const report = buildAbReport(editions);
    const md = renderAbReport(report);
    assert.match(md, /Métricas principais \(Etapa 1 e Etapas 1-3/);
    assert.match(md, /Etapa 4 — RUIDOSA/);
    assert.match(md, /Etapa 1 — tokens in/);
    assert.match(md, /Etapas 1-3 \(soma, sem gate\) — tokens in/);
  });

  it("PRIMARY_METRIC_KEYS cobre só Etapa 1 e soma 1-3; NOISY_STAGE4_METRIC_KEYS só Etapa 4", () => {
    assert.ok(PRIMARY_METRIC_KEYS.every((k) => k.startsWith("stage1") ));
    assert.ok(NOISY_STAGE4_METRIC_KEYS.every((k) => k.startsWith("stage4")));
  });
});
