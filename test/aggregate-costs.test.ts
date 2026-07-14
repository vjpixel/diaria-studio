import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStageStatusJson,
  aggregateCosts,
  formatSummary,
} from "../scripts/aggregate-costs.ts";

function stageStatusJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    edition: "260424",
    generated_at: "2026-04-24T14:00:00Z",
    rows: [
      { stage: 0, status: "done", duration_ms: 300000 },
      {
        stage: 1,
        status: "done",
        duration_ms: 2400000,
        tokens_in: 500000,
        tokens_out: 20000,
        models: ["haiku-4-5"],
      },
      {
        stage: 2,
        status: "done",
        duration_ms: 1800000,
        cost_usd: 0.45,
        tokens_in: 80000,
        tokens_out: 12000,
        models: ["sonnet-5"],
      },
    ],
    ...overrides,
  });
}

describe("parseStageStatusJson", () => {
  it("parseia rows com tokens/cost/models", () => {
    const stages = parseStageStatusJson(stageStatusJson());
    assert.equal(stages.length, 3);
    const s1 = stages.find((s) => s.stage === 1);
    assert.ok(s1);
    assert.equal(s1!.tokensIn, 500000);
    assert.equal(s1!.tokensOut, 20000);
    assert.deepEqual(s1!.models, ["haiku-4-5"]);
    assert.equal(s1!.costUsd, undefined);
  });

  it("preserva cost_usd explícito quando presente", () => {
    const stages = parseStageStatusJson(stageStatusJson());
    const s2 = stages.find((s) => s.stage === 2);
    assert.equal(s2!.costUsd, 0.45);
  });

  it("tolera rows sem campos opcionais (legado)", () => {
    const md = JSON.stringify({
      edition: "260101",
      rows: [{ stage: 0, status: "done", duration_ms: 60000 }],
    });
    const stages = parseStageStatusJson(md);
    assert.equal(stages.length, 1);
    assert.equal(stages[0].tokensIn, 0);
    assert.equal(stages[0].tokensOut, 0);
    assert.deepEqual(stages[0].models, []);
  });

  it("retorna vazio para JSON inválido", () => {
    assert.equal(parseStageStatusJson("not json").length, 0);
  });

  it("retorna vazio quando rows não é array", () => {
    assert.equal(parseStageStatusJson(JSON.stringify({ edition: "x" })).length, 0);
  });
});

describe("aggregateCosts — integração", () => {
  function setup(): { root: string; editionsDir: string } {
    const root = mkdtempSync(join(tmpdir(), "diaria-cost-"));
    const editionsDir = join(root, "data/editions");
    mkdirSync(editionsDir, { recursive: true });
    return { root, editionsDir };
  }

  function addEdition(editionsDir: string, name: string, json: string): void {
    const dir = join(editionsDir, name, "_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stage-status.json"), json);
  }

  it("agrega 3 edições e soma totais", () => {
    const { editionsDir } = setup();
    try {
      addEdition(editionsDir, "260421", stageStatusJson());
      addEdition(editionsDir, "260422", stageStatusJson());
      addEdition(editionsDir, "260423", stageStatusJson());

      const result = aggregateCosts({ editionsDir });
      assert.equal(result.length, 3);
      // duration = 300000 + 2400000 + 1800000 = 4500000ms
      assert.equal(result[0].totals.durationMs, 4500000);
      assert.equal(result[0].totals.tokensIn, 580000);
      assert.equal(result[0].totals.tokensOut, 32000);
      // stage 2 tem cost_usd explícito (0.45); stage 1 estima via haiku pricing
      // (500000/1M * 1 + 20000/1M * 5 = 0.5 + 0.1 = 0.6) -> total ~1.05
      assert.ok(result[0].totals.costUsd > 1.0);
      assert.equal(result[0].totals.costEstimated, true);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("filtra por since/until", () => {
    const { editionsDir } = setup();
    try {
      addEdition(editionsDir, "260410", stageStatusJson());
      addEdition(editionsDir, "260415", stageStatusJson());
      addEdition(editionsDir, "260420", stageStatusJson());

      const result = aggregateCosts({
        editionsDir,
        since: "260415",
        until: "260419",
      });
      assert.equal(result.length, 1);
      assert.equal(result[0].edition, "260415");
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("ignora edições sem stage-status.json", () => {
    const { editionsDir } = setup();
    try {
      addEdition(editionsDir, "260421", stageStatusJson());
      // 260422 sem stage-status.json (só _internal/)
      mkdirSync(join(editionsDir, "260422/_internal"), { recursive: true });

      const result = aggregateCosts({ editionsDir });
      assert.equal(result.length, 1);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("ignora diretórios non-AAMMDD", () => {
    const { editionsDir } = setup();
    try {
      addEdition(editionsDir, "260421", stageStatusJson());
      mkdirSync(join(editionsDir, "archive"), { recursive: true });

      const result = aggregateCosts({ editionsDir });
      assert.equal(result.length, 1);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  // #2463/#3024: stage-status.json de edições no layout NESTED novo
  // ({AAMM}/{AAMMDD}) precisa ser agregado junto com o flat legado.
  it("agrega edições em layout NESTED junto com flat legado", () => {
    const { editionsDir } = setup();
    try {
      addEdition(editionsDir, "260421", stageStatusJson()); // flat legado
      const nestedInternal = join(editionsDir, "2604", "260423", "_internal");
      mkdirSync(nestedInternal, { recursive: true });
      writeFileSync(join(nestedInternal, "stage-status.json"), stageStatusJson());

      const result = aggregateCosts({ editionsDir });
      assert.deepEqual(
        result.map((e) => e.edition).sort(),
        ["260421", "260423"],
      );
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("edições retornadas em ordem crescente", () => {
    const { editionsDir } = setup();
    try {
      addEdition(editionsDir, "260423", stageStatusJson());
      addEdition(editionsDir, "260421", stageStatusJson());
      addEdition(editionsDir, "260422", stageStatusJson());

      const result = aggregateCosts({ editionsDir });
      assert.deepEqual(
        result.map((e) => e.edition),
        ["260421", "260422", "260423"],
      );
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("edição sem tokens/cost conta pra duração mas fica com custo zero", () => {
    const { editionsDir } = setup();
    try {
      addEdition(
        editionsDir,
        "260101",
        JSON.stringify({
          edition: "260101",
          rows: [{ stage: 0, status: "done", duration_ms: 60000 }],
        }),
      );
      const result = aggregateCosts({ editionsDir });
      assert.equal(result.length, 1);
      assert.equal(result[0].totals.durationMs, 60000);
      assert.equal(result[0].totals.costUsd, 0);
      assert.equal(result[0].totals.costEstimated, false);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("usa pricing intro do Sonnet 5 (2026-08-31 ou antes) vs standard depois", () => {
    const { editionsDir } = setup();
    try {
      const rows = JSON.stringify({
        edition: "260101",
        rows: [
          {
            stage: 2,
            status: "done",
            duration_ms: 1000,
            tokens_in: 1_000_000,
            tokens_out: 1_000_000,
            models: ["sonnet-5"],
          },
        ],
      });
      addEdition(editionsDir, "260101", rows); // pre intro-end -> $2 in + $10 out = $12
      const rowsAfter = JSON.parse(rows);
      rowsAfter.edition = "260901";
      addEdition(editionsDir, "260901", JSON.stringify(rowsAfter)); // post intro-end -> $3 in + $15 out = $18

      const result = aggregateCosts({ editionsDir });
      const before = result.find((e) => e.edition === "260101")!;
      const after = result.find((e) => e.edition === "260901")!;
      assert.ok(Math.abs(before.totals.costUsd - 12) < 0.001);
      assert.ok(Math.abs(after.totals.costUsd - 18) < 0.001);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("não estima custo quando o stage mistura 2+ modelos", () => {
    const { editionsDir } = setup();
    try {
      addEdition(
        editionsDir,
        "260421",
        JSON.stringify({
          edition: "260421",
          rows: [
            {
              stage: 1,
              status: "done",
              duration_ms: 1000,
              tokens_in: 1_000_000,
              tokens_out: 1_000_000,
              models: ["haiku-4-5", "sonnet-5"],
            },
          ],
        }),
      );
      const result = aggregateCosts({ editionsDir });
      assert.equal(result[0].totals.costUsd, 0);
      assert.equal(result[0].totals.costEstimated, false);
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });
});

describe("formatSummary", () => {
  it("renderiza resumo completo com 2 edições", () => {
    const editions = [
      {
        edition: "260421",
        month: "2604",
        stages: [
          {
            stage: 1,
            label: "Pesquisa",
            status: "done",
            durationMs: 60000,
            costUsd: 0.1,
            tokensIn: 1000,
            tokensOut: 500,
            models: ["haiku-4-5"],
          },
        ],
        totals: { durationMs: 60000, costUsd: 0.1, costEstimated: false, tokensIn: 1000, tokensOut: 500 },
      },
      {
        edition: "260422",
        month: "2604",
        stages: [
          {
            stage: 1,
            label: "Pesquisa",
            status: "done",
            durationMs: 30000,
            costUsd: 0.05,
            tokensIn: 800,
            tokensOut: 400,
            models: ["haiku-4-5"],
          },
        ],
        totals: { durationMs: 30000, costUsd: 0.05, costEstimated: false, tokensIn: 800, tokensOut: 400 },
      },
    ];
    const out = formatSummary(editions, new Date("2026-04-24T12:00:00Z"));
    assert.ok(out.includes("Edições agregadas: 2"));
    assert.ok(out.includes("Top 5 edições"));
    assert.ok(out.includes("260421"));
  });

  it("handle vazio sem crash", () => {
    const out = formatSummary([], new Date("2026-04-24T12:00:00Z"));
    assert.ok(out.includes("Edições agregadas: 0"));
    assert.ok(out.includes("Nenhuma edição"));
  });
});
