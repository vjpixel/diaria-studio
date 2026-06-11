/**
 * test/render-overnight-timeline.test.ts (#2099)
 *
 * Testa renderização determinística da tabela "Timeline da noite"
 * a partir de fixtures de plan.json. Foco em degrades: timeline parcial,
 * rodada interrompida, fix-iterations, lotes, e plan vazio.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTimelineRows,
  renderOvernightTimeline,
  type Plan,
  type PlanIssue,
} from "../scripts/render-overnight-timeline.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makePlan(issues: Partial<PlanIssue>[]): Plan {
  return {
    started_at: "2026-06-11T22:00:00.000Z",
    issues: issues.map((i, idx) =>
      ({
        number: i.number ?? 1000 + idx,
        priority: i.priority ?? "P2",
        status: i.status ?? "mergeada",
        batch: i.batch ?? null,
        pr: i.pr ?? null,
        timeline: i.timeline,
      }) as PlanIssue,
    ),
  };
}

// ─── buildTimelineRows ────────────────────────────────────────────────────────

describe("buildTimelineRows — solo sem timeline", () => {
  it("issue sem timeline emite linha com valores '—'", () => {
    const plan = makePlan([{ number: 1001, batch: null }]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].unidade, "#1001");
    assert.equal(rows[0].inicio, "—");
    assert.equal(rows[0].duracao, "—");
    assert.equal(rows[0].fixIteracoes, 0);
  });
});

describe("buildTimelineRows — solo com timeline completo", () => {
  it("calcula duração e fix-iterations corretamente", () => {
    const plan = makePlan([
      {
        number: 2001,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T22:05:00.000Z",
          pr_opened: "2026-06-11T22:20:00.000Z",
          fix_iteration_1: "2026-06-11T22:35:00.000Z",
          ci_green: "2026-06-11T22:50:00.000Z",
          merged: "2026-06-11T22:51:00.000Z",
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].unidade, "#2001");
    assert.equal(rows[0].fixIteracoes, 1);
    assert.equal(rows[0].duracao, "46m"); // 22:05 → 22:51 = 46m
    assert.equal(rows[0].endLabel, "mergeado");
  });

  it("2 fix-iterations contadas", () => {
    const plan = makePlan([
      {
        number: 2002,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T21:00:00.000Z",
          fix_iteration_1: "2026-06-11T21:30:00.000Z",
          fix_iteration_2: "2026-06-11T21:50:00.000Z",
          merged: "2026-06-11T22:45:00.000Z",
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].fixIteracoes, 2);
    // 21:00 → 22:45 = 105 minutos = 1h45m
    assert.equal(rows[0].duracao, "1h45m");
  });
});

describe("buildTimelineRows — lote", () => {
  it("issues do mesmo batch são agrupadas em 1 linha", () => {
    const plan = makePlan([
      {
        number: 3001,
        batch: "ds-email",
        timeline: {
          dispatch: "2026-06-11T22:00:00.000Z",
          merged: "2026-06-11T22:30:00.000Z",
        },
      },
      {
        number: 3002,
        batch: "ds-email",
        timeline: {
          dispatch: "2026-06-11T22:00:00.000Z",
          merged: "2026-06-11T22:30:00.000Z",
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows.length, 1, "Lote deve gerar apenas 1 linha");
    assert.ok(rows[0].unidade.startsWith("lote ds-email"));
    assert.ok(rows[0].unidade.includes("#3001"));
    assert.ok(rows[0].unidade.includes("#3002"));
    assert.equal(rows[0].duracao, "30m");
  });

  it("fix-iterations no lote = máximo entre issues", () => {
    const plan = makePlan([
      {
        number: 3003,
        batch: "lote-x",
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          fix_iteration_1: "2026-06-11T20:15:00.000Z",
          fix_iteration_2: "2026-06-11T20:30:00.000Z",
          merged: "2026-06-11T21:00:00.000Z",
        },
      },
      {
        number: 3004,
        batch: "lote-x",
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          merged: "2026-06-11T21:00:00.000Z",
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].fixIteracoes, 2, "deve usar máximo entre issues do lote");
  });
});

describe("buildTimelineRows — timeline parcial (rodada interrompida)", () => {
  it("dispatch sem fim → fim 'em andamento'", () => {
    const plan = makePlan([
      {
        number: 4001,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T23:00:00.000Z",
          pr_opened: "2026-06-11T23:15:00.000Z",
          // sem ci_green nem merged (rodada interrompida)
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].fim, "em andamento");
    assert.equal(rows[0].duracao, "—"); // sem fim → duração indefinida
  });

  it("unidade pulada usa timestamp pulada como fim", () => {
    const plan = makePlan([
      {
        number: 4002,
        batch: null,
        status: "pulada",
        timeline: {
          pulada: "2026-06-11T22:10:00.000Z",
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].endLabel, "pulada");
    // sem dispatch → inicio "—", mas pulada tem timestamp
  });
});

describe("buildTimelineRows — plan sem issues", () => {
  it("retorna array vazio", () => {
    const plan: Plan = { started_at: "2026-06-11T22:00:00.000Z", issues: [] };
    const rows = buildTimelineRows(plan);
    assert.equal(rows.length, 0);
  });
});

// ─── renderOvernightTimeline ──────────────────────────────────────────────────

describe("renderOvernightTimeline — plan vazio", () => {
  it("emite mensagem de nenhuma unidade registrada", () => {
    const plan: Plan = { started_at: "2026-06-11T22:00:00.000Z", issues: [] };
    const output = renderOvernightTimeline(plan);
    assert.ok(output.includes("nenhuma unidade registrada"));
    assert.ok(output.includes("Timeline da noite"));
  });
});

describe("renderOvernightTimeline — tabela completa", () => {
  it("contém cabeçalho, linhas e rodapé com total + mais lenta", () => {
    const plan = makePlan([
      {
        number: 5001,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          merged: "2026-06-11T20:30:00.000Z",
        },
      },
      {
        number: 5002,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T20:31:00.000Z",
          fix_iteration_1: "2026-06-11T21:00:00.000Z",
          merged: "2026-06-11T22:15:00.000Z",
        },
      },
    ]);
    const output = renderOvernightTimeline(plan);

    // cabeçalho
    assert.ok(output.includes("## Timeline da noite"), "deve ter cabeçalho");
    assert.ok(output.includes("| Unidade |"), "deve ter tabela markdown");
    assert.ok(output.includes("| Fix-iterations |"), "deve ter coluna fix-iterations");

    // linhas das issues
    assert.ok(output.includes("#5001"), "deve listar issue 5001");
    assert.ok(output.includes("#5002"), "deve listar issue 5002");

    // rodapé
    assert.ok(output.includes("**Total da rodada:**"), "deve ter total");
    assert.ok(output.includes("**Unidade mais lenta:**"), "deve ter unidade mais lenta");
    assert.ok(output.includes("#5002"), "mais lenta deve ser #5002 (1h44m)");
  });

  it("fix-iterations zero renderiza como '—'", () => {
    const plan = makePlan([
      {
        number: 5003,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          merged: "2026-06-11T20:10:00.000Z",
        },
      },
    ]);
    const output = renderOvernightTimeline(plan);
    // A linha da issue na tabela começa com "| #5003"
    const tableLines = output.split("\n").filter((l) => l.startsWith("| #5003"));
    assert.equal(tableLines.length, 1, "deve ter 1 linha de tabela para #5003");
    assert.ok(tableLines[0].includes("| — |"), "fix-iterations zero deve ser '—'");
  });

  it("degrada bem com issues mistas (com e sem timeline)", () => {
    const plan = makePlan([
      {
        number: 6001,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          merged: "2026-06-11T20:45:00.000Z",
        },
      },
      {
        number: 6002,
        batch: null,
        // sem timeline — issue de rodada anterior
      },
    ]);
    const output = renderOvernightTimeline(plan);
    assert.ok(output.includes("#6001"), "issue com timeline deve aparecer");
    assert.ok(output.includes("#6002"), "issue sem timeline deve aparecer");
    // não deve lançar exceção e deve ter ambas as linhas
    const tableLines = output
      .split("\n")
      .filter((l) => l.startsWith("| #"));
    assert.equal(tableLines.length, 2, "deve ter 2 linhas na tabela");
  });
});

describe("renderOvernightTimeline — draft (CI vermelho persistente)", () => {
  it("draft aparece na tabela com endLabel 'draft'", () => {
    const plan = makePlan([
      {
        number: 7001,
        batch: null,
        status: "draft-ci-vermelho",
        timeline: {
          dispatch: "2026-06-11T21:00:00.000Z",
          pr_opened: "2026-06-11T21:10:00.000Z",
          fix_iteration_1: "2026-06-11T21:30:00.000Z",
          fix_iteration_2: "2026-06-11T21:50:00.000Z",
          draft: "2026-06-11T22:05:00.000Z",
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].endLabel, "draft");
    assert.equal(rows[0].fixIteracoes, 2);
    assert.equal(rows[0].duracao, "1h05m");
  });
});
