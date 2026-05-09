import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractStageLabels,
  isRegression,
  timeToFixHours,
  aggregateByStage,
  renderHeatmap,
  renderTable,
  renderReport,
  formatMttr,
  type GhIssueRaw,
} from "../scripts/bug-heatmap.ts";

/**
 * Tests pra bug-heatmap aggregation + rendering (#1014).
 * Foco em pure functions; CLI/gh integration NÃO testada (precisa mock spawn).
 */

function mkIssue(overrides: Partial<GhIssueRaw> = {}): GhIssueRaw {
  return {
    number: 1,
    title: "Test bug",
    state: "open",
    createdAt: "2026-05-01T00:00:00Z",
    closedAt: null,
    labels: [{ name: "bug" }],
    ...overrides,
  };
}

describe("extractStageLabels", () => {
  it("retorna labels com prefixo stage-", () => {
    const issue = mkIssue({ labels: [{ name: "bug" }, { name: "stage-1" }, { name: "P2" }] });
    assert.deepEqual(extractStageLabels(issue), ["stage-1"]);
  });

  it("issue pode ter múltiplos stages", () => {
    const issue = mkIssue({
      labels: [{ name: "stage-2" }, { name: "stage-3" }],
    });
    assert.deepEqual(extractStageLabels(issue), ["stage-2", "stage-3"]);
  });

  it("issue sem stage label vai pra (unlabeled)", () => {
    const issue = mkIssue({ labels: [{ name: "bug" }, { name: "P1" }] });
    assert.deepEqual(extractStageLabels(issue), ["(unlabeled)"]);
  });

  it("labels stage-publish e stage-research são reconhecidos", () => {
    const issue = mkIssue({ labels: [{ name: "stage-publish" }] });
    assert.deepEqual(extractStageLabels(issue), ["stage-publish"]);
  });
});

describe("isRegression", () => {
  it("label regression-* → true", () => {
    assert.equal(isRegression(mkIssue({ labels: [{ name: "regression-of-456" }] })), true);
  });

  it("título contendo 'regression' → true", () => {
    assert.equal(isRegression(mkIssue({ title: "Regression: feature X broken" })), true);
  });

  it("nem label nem título → false", () => {
    assert.equal(isRegression(mkIssue()), false);
  });

  it("case-insensitive", () => {
    assert.equal(isRegression(mkIssue({ title: "REGRESSION" })), true);
    assert.equal(isRegression(mkIssue({ labels: [{ name: "Regression-X" }] })), true);
  });
});

describe("timeToFixHours", () => {
  it("issue closed: retorna diff em horas", () => {
    const issue = mkIssue({
      createdAt: "2026-05-01T00:00:00Z",
      closedAt: "2026-05-01T05:30:00Z",
    });
    assert.equal(timeToFixHours(issue), 5.5);
  });

  it("issue open: retorna null", () => {
    const issue = mkIssue({ closedAt: null });
    assert.equal(timeToFixHours(issue), null);
  });
});

describe("aggregateByStage", () => {
  it("vazio: stages com count 0", () => {
    const stats = aggregateByStage([]);
    assert.equal(stats.length, 9); // 6 stages numéricos + publish + research + unlabeled
    assert.ok(stats.every((s) => s.total === 0));
  });

  it("conta corretamente bugs por stage", () => {
    const issues = [
      mkIssue({ number: 1, labels: [{ name: "stage-1" }] }),
      mkIssue({ number: 2, labels: [{ name: "stage-1" }] }),
      mkIssue({ number: 3, labels: [{ name: "stage-2" }] }),
    ];
    const stats = aggregateByStage(issues);
    assert.equal(stats.find((s) => s.stage === "stage-1")?.total, 2);
    assert.equal(stats.find((s) => s.stage === "stage-2")?.total, 1);
    assert.equal(stats.find((s) => s.stage === "stage-3")?.total, 0);
  });

  it("calcula MTTR corretamente", () => {
    const issues = [
      mkIssue({
        labels: [{ name: "stage-1" }],
        state: "closed",
        createdAt: "2026-05-01T00:00:00Z",
        closedAt: "2026-05-01T10:00:00Z", // 10h
      }),
      mkIssue({
        labels: [{ name: "stage-1" }],
        state: "closed",
        createdAt: "2026-05-01T00:00:00Z",
        closedAt: "2026-05-01T20:00:00Z", // 20h
      }),
    ];
    const stats = aggregateByStage(issues);
    assert.equal(stats.find((s) => s.stage === "stage-1")?.mttr_hours, 15); // (10+20)/2
  });

  it("ignora issues open no MTTR", () => {
    const issues = [
      mkIssue({
        labels: [{ name: "stage-1" }],
        state: "closed",
        createdAt: "2026-05-01T00:00:00Z",
        closedAt: "2026-05-01T10:00:00Z",
      }),
      mkIssue({
        labels: [{ name: "stage-1" }],
        state: "open", // não conta no MTTR
      }),
    ];
    const stats = aggregateByStage(issues);
    const stage1 = stats.find((s) => s.stage === "stage-1")!;
    assert.equal(stage1.total, 2);
    assert.equal(stage1.open, 1);
    assert.equal(stage1.closed, 1);
    assert.equal(stage1.mttr_hours, 10);
  });

  it("MTTR null quando nenhum bug fechado no stage", () => {
    const issues = [mkIssue({ labels: [{ name: "stage-1" }], state: "open" })];
    const stats = aggregateByStage(issues);
    assert.equal(stats.find((s) => s.stage === "stage-1")?.mttr_hours, null);
  });

  it("conta regression separadamente", () => {
    const issues = [
      mkIssue({ labels: [{ name: "stage-1" }], title: "regression: foo" }),
      mkIssue({ labels: [{ name: "stage-1" }], title: "normal bug" }),
    ];
    const stats = aggregateByStage(issues);
    assert.equal(stats.find((s) => s.stage === "stage-1")?.recurrence_count, 1);
  });

  it("captura até 5 example issues", () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      mkIssue({ number: 100 + i, labels: [{ name: "stage-1" }] }),
    );
    const stats = aggregateByStage(issues);
    const stage1 = stats.find((s) => s.stage === "stage-1")!;
    assert.equal(stage1.example_issues.length, 5);
    assert.deepEqual(stage1.example_issues, [100, 101, 102, 103, 104]);
  });

  it("aceita state em UPPERCASE (gh CLI format)", () => {
    const issues: GhIssueRaw[] = [
      // @ts-expect-error testando contrato gh CLI (UPPERCASE)
      { ...mkIssue({ labels: [{ name: "stage-1" }] }), state: "CLOSED", closedAt: "2026-05-02T00:00:00Z" },
      // @ts-expect-error testando contrato gh CLI (UPPERCASE)
      { ...mkIssue({ labels: [{ name: "stage-1" }] }), state: "OPEN" },
    ];
    const stats = aggregateByStage(issues);
    const stage1 = stats.find((s) => s.stage === "stage-1")!;
    assert.equal(stage1.total, 2);
    assert.equal(stage1.open, 1);
    assert.equal(stage1.closed, 1);
  });
});

describe("renderHeatmap", () => {
  it("ASCII bar tem largura proporcional", () => {
    const stats = aggregateByStage([
      mkIssue({ number: 1, labels: [{ name: "stage-1" }] }),
      mkIssue({ number: 2, labels: [{ name: "stage-1" }] }),
      mkIssue({ number: 3, labels: [{ name: "stage-2" }] }),
    ]);
    const heatmap = renderHeatmap(stats);
    assert.match(heatmap, /Stage/);
    assert.match(heatmap, /stage-1/);
    assert.match(heatmap, /■/, "deve ter ao menos 1 barra preenchida");
  });

  it("dataset vazio: barras todas vazias mas estrutura presente", () => {
    const stats = aggregateByStage([]);
    const heatmap = renderHeatmap(stats);
    assert.match(heatmap, /stage-1/);
    // Bars das linhas de stage devem ter zero ■ (header tem ■ no legend, ignora)
    const barLines = heatmap.split("\n").filter((l) => /^stage-/.test(l) || /^\(unlabeled\)/.test(l));
    for (const line of barLines) {
      assert.doesNotMatch(line, /■/, `linha "${line}" não deveria ter barras preenchidas`);
    }
    // E todas devem terminar com count 0
    assert.match(heatmap, / 0 \(open 0\)/);
  });
});

describe("renderTable", () => {
  it("gera markdown table com colunas esperadas", () => {
    const stats = aggregateByStage([
      mkIssue({ number: 100, labels: [{ name: "stage-1" }] }),
    ]);
    const table = renderTable(stats);
    assert.match(table, /\| Stage \| Total \| Open \| Closed \| MTTR/);
    assert.match(table, /#100/);
  });

  it("MTTR null renderiza como —", () => {
    const stats = aggregateByStage([
      mkIssue({ labels: [{ name: "stage-1" }], state: "open" }),
    ]);
    const table = renderTable(stats);
    assert.match(table, /\| — \|/);
  });
});

describe("formatMttr", () => {
  it("null → —", () => {
    assert.equal(formatMttr(null), "—");
  });

  it("<24h → \"Nh\"", () => {
    assert.equal(formatMttr(0), "0.0h");
    assert.equal(formatMttr(5.5), "5.5h");
    assert.equal(formatMttr(23.9), "23.9h");
  });

  it("≥24h → \"Nd\" (dias com uma casa)", () => {
    assert.equal(formatMttr(24), "1.0d");
    assert.equal(formatMttr(48), "2.0d");
    assert.equal(formatMttr(168), "7.0d");
    assert.equal(formatMttr(720), "30.0d");
  });

  it("bug antigo (1000h+) lê em dias, não horas", () => {
    // Antes: \"1234.0h\" — agora: \"51.4d\"
    assert.equal(formatMttr(1234), "51.4d");
  });
});

describe("renderReport", () => {
  it("gera markdown completo com header + heatmap + tabela", () => {
    const stats = aggregateByStage([
      mkIssue({ number: 100, labels: [{ name: "stage-1" }] }),
    ]);
    const at = new Date("2026-05-09T00:00:00Z");
    const report = renderReport(stats, at);
    assert.match(report, /# Bug Heatmap/);
    assert.match(report, /Gerado em.*2026-05-09/);
    assert.match(report, /Total de bugs analisados.*1/);
    assert.match(report, /## ASCII Heatmap/);
    assert.match(report, /## Tabela detalhada/);
    assert.match(report, /## Como interpretar/);
  });
});
