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
  renderTimeline,
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

// Regressão #2124 — item 4: ordem cronológica preservada (solo/lote/solo intercalado)
describe("buildTimelineRows — ordem cronológica preservada (#2124)", () => {
  it("plano intercalado solo→lote→solo emite na posição da primeira aparição", () => {
    // Plano: #A001 (solo), #B001+#B002 (lote batch-x), #C001 (solo)
    // Antes do fix: solos vinham primeiro (A001, C001), lote depois (batch-x)
    // Após fix: A001, batch-x, C001 — ordem de plan.issues
    const plan = makePlan([
      { number: 14001, batch: null,      timeline: { dispatch: "2026-06-11T20:00:00.000Z", merged: "2026-06-11T20:10:00.000Z" } },
      { number: 14002, batch: "lote-x",  timeline: { dispatch: "2026-06-11T20:15:00.000Z", merged: "2026-06-11T20:45:00.000Z" } },
      { number: 14003, batch: "lote-x",  timeline: { dispatch: "2026-06-11T20:15:00.000Z", merged: "2026-06-11T20:45:00.000Z" } },
      { number: 14004, batch: null,      timeline: { dispatch: "2026-06-11T20:50:00.000Z", merged: "2026-06-11T21:10:00.000Z" } },
    ]);
    const rows = buildTimelineRows(plan);

    // 3 rows: solo #14001, lote lote-x (#14002, #14003), solo #14004
    assert.equal(rows.length, 3, "deve ter 3 linhas (2 solos + 1 lote)");
    assert.equal(rows[0].unidade, "#14001", "1ª linha deve ser #14001 (solo antes do lote)");
    assert.ok(rows[1].unidade.startsWith("lote lote-x"), `2ª linha deve ser o lote, got: ${rows[1].unidade}`);
    assert.ok(rows[1].unidade.includes("#14002"), "lote deve incluir #14002");
    assert.ok(rows[1].unidade.includes("#14003"), "lote deve incluir #14003");
    assert.equal(rows[2].unidade, "#14004", "3ª linha deve ser #14004 (solo após o lote)");
  });

  it("lote→solo→lote2 intercalado: dois lotes distintos na posição de primeira aparição", () => {
    const plan = makePlan([
      { number: 15001, batch: "alpha",   timeline: { dispatch: "2026-06-11T20:00:00.000Z", merged: "2026-06-11T20:20:00.000Z" } },
      { number: 15002, batch: "alpha",   timeline: { dispatch: "2026-06-11T20:00:00.000Z", merged: "2026-06-11T20:20:00.000Z" } },
      { number: 15003, batch: null,      timeline: { dispatch: "2026-06-11T20:25:00.000Z", merged: "2026-06-11T20:35:00.000Z" } },
      { number: 15004, batch: "beta",    timeline: { dispatch: "2026-06-11T20:40:00.000Z", merged: "2026-06-11T21:00:00.000Z" } },
      { number: 15005, batch: "beta",    timeline: { dispatch: "2026-06-11T20:40:00.000Z", merged: "2026-06-11T21:00:00.000Z" } },
    ]);
    const rows = buildTimelineRows(plan);

    assert.equal(rows.length, 3, "deve ter 3 linhas (alpha, solo, beta)");
    assert.ok(rows[0].unidade.startsWith("lote alpha"), `1ª linha deve ser lote alpha, got: ${rows[0].unidade}`);
    assert.equal(rows[1].unidade, "#15003", `2ª linha deve ser solo #15003, got: ${rows[1].unidade}`);
    assert.ok(rows[2].unidade.startsWith("lote beta"), `3ª linha deve ser lote beta, got: ${rows[2].unidade}`);
  });

  it("lote com issues intercaladas no plano (mesmo batch não-consecutivo): emite na posição da 1ª", () => {
    // Caso edge: #A, #B(lote-z), #C(solo), #D(lote-z) — o batch tem issues não-consecutivas
    // Posição de emissão = 1ª aparição do batch (posição de #B)
    const plan = makePlan([
      { number: 16001, batch: null,      timeline: { dispatch: "2026-06-11T20:00:00.000Z", merged: "2026-06-11T20:05:00.000Z" } },
      { number: 16002, batch: "lote-z",  timeline: { dispatch: "2026-06-11T20:10:00.000Z", merged: "2026-06-11T20:30:00.000Z" } },
      { number: 16003, batch: null,      timeline: { dispatch: "2026-06-11T20:35:00.000Z", merged: "2026-06-11T20:45:00.000Z" } },
      { number: 16004, batch: "lote-z",  timeline: { dispatch: "2026-06-11T20:10:00.000Z", merged: "2026-06-11T20:30:00.000Z" } },
    ]);
    const rows = buildTimelineRows(plan);

    // Deve ter 3 linhas: #16001, lote-z (#16002, #16004), #16003
    assert.equal(rows.length, 3, "deve ter 3 linhas");
    assert.equal(rows[0].unidade, "#16001");
    assert.ok(rows[1].unidade.startsWith("lote lote-z"), `2ª deve ser lote-z, got: ${rows[1].unidade}`);
    assert.ok(rows[1].unidade.includes("#16002") && rows[1].unidade.includes("#16004"), "lote deve ter ambas as issues");
    assert.equal(rows[2].unidade, "#16003");
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

// #3072 (review do #3071): EPIC deliberadamente deferido (status
// "elegivel_especial") nunca tem timeline preenchido (nunca foi de fato
// despachado), mas isTerminalForBar já o trata como terminal na statusLine
// desde #3071 — sem esse fix, a linha da timeline ficava presa em "em
// andamento" pra sempre, contradizendo a statusLine dentro do MESMO relatório.
describe("buildTimelineRows — #3072: EPIC deferido não fica preso em 'em andamento'", () => {
  it("status 'elegivel_especial' sem timeline → fim 'concluída (fora do timeline)', não 'em andamento'", () => {
    const plan = makePlan([
      {
        number: 2808,
        batch: null,
        status: "elegivel_especial",
        timeline: {},
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].endLabel, "concluída (fora do timeline)");
    assert.equal(rows[0].fim, "concluída (fora do timeline)");
  });

  it("status 'elegivel_especial' SEM campo timeline (undefined, não {}) → mesmo tratamento", () => {
    const plan = makePlan([
      { number: 2809, batch: null, status: "elegivel_especial" },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].endLabel, "concluída (fora do timeline)");
  });

  it("status 'elegivel' comum (não-EPIC) sem timeline (objeto {}) → fim '—', não 'em andamento' (#3712)", () => {
    const plan = makePlan([
      { number: 4003, batch: null, status: "elegivel", timeline: {} },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].endLabel, "—");
  });
});

// #3712 — issue na fila (sem `dispatch`) não pode aparecer como "em andamento".
// Bug: o guard antigo era `if (!tl) return "—"`, que só cobria timeline
// COMPLETAMENTE ausente (undefined). Um `timeline: {}` (ou parcial sem
// `dispatch`) passava pelos primeiros guards, não batia em `!tl`, e caía no
// fallback "em andamento" — mesmo a issue nunca tendo sido despachada.
describe("buildTimelineRows — #3712: issue não despachada não vira 'em andamento'", () => {
  it("timeline: {} (objeto vazio, sem dispatch) e status não-EPIC_DEFERRED → fim '—'", () => {
    const plan = makePlan([
      { number: 3712, batch: null, status: "elegivel", timeline: {} },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].endLabel, "—");
    assert.equal(rows[0].fim, "—");
  });

  it("sem campo `timeline` (undefined) e status não-EPIC_DEFERRED → fim '—' (comportamento já correto, preservado)", () => {
    const plan = makePlan([
      { number: 3713, batch: null, status: "elegivel" },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].endLabel, "—");
    assert.equal(rows[0].fim, "—");
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

describe("renderOvernightTimeline — mais lenta usa duração da tabela (#2099 fix)", () => {
  it("batch com representative mais rápido: mais lenta mostra duração da row, não do issue individual", () => {
    // Issue 1 = representative (tem dispatch), merged em 30m
    // Issue 2 = não-representative, merged em 2h — sem fix, mais lenta não deveria ser 2h via issue loop
    // Após fix: mais lenta usa rows, que usa o representative → 30m
    // (O correto é que a tabela e mais lenta mostrem o mesmo número para o mesmo batch)
    const plan = makePlan([
      {
        number: 8001,
        batch: "batch-foo",
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          merged: "2026-06-11T20:30:00.000Z",
        },
      },
      {
        number: 8002,
        batch: "batch-foo",
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          merged: "2026-06-11T22:00:00.000Z",
        },
      },
    ]);
    const output = renderOvernightTimeline(plan);
    const tableRow = output.split("\n").filter((l) => l.startsWith("| lote batch-foo"))[0];
    const maisLenta = output.split("\n").filter((l) => l.includes("mais lenta"))[0];

    // Table shows 30m (from representative issue 8001)
    assert.ok(tableRow.includes("30m"), `table row deve mostrar 30m: ${tableRow}`);
    // mais lenta must show same duration as the table row (30m), not 2h from issue 8002
    assert.ok(maisLenta.includes("30m"), `mais lenta deve mostrar 30m (mesma duração da tabela): ${maisLenta}`);
    // The label in mais lenta matches the unidade column
    assert.ok(
      maisLenta.includes("lote batch-foo (#8001, #8002)"),
      `mais lenta label deve incluir números das issues: ${maisLenta}`,
    );
  });

  it("solo: mais lenta mostra mesma duração da tabela", () => {
    const plan = makePlan([
      {
        number: 9001,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          merged: "2026-06-11T21:30:00.000Z",
        },
      },
      {
        number: 9002,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          merged: "2026-06-11T20:15:00.000Z",
        },
      },
    ]);
    const output = renderOvernightTimeline(plan);
    const maisLenta = output.split("\n").filter((l) => l.includes("mais lenta"))[0];
    assert.ok(maisLenta.includes("#9001"), "mais lenta deve ser #9001 (1h30m)");
    assert.ok(maisLenta.includes("1h30m"), `mais lenta deve mostrar 1h30m: ${maisLenta}`);
  });
});

// ─── Regressões #2102 ─────────────────────────────────────────────────────────

describe("fmtHHMM BRT (#2102 — item 1)", () => {
  it("horários exibidos em BRT fixo (UTC-3), não no TZ do processo", () => {
    // 2026-06-11T02:30:00Z = 23:30 BRT (UTC-3)
    const plan = makePlan([
      {
        number: 10001,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T02:30:00.000Z",
          merged: "2026-06-11T03:15:00.000Z",
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    // BRT: 02:30 UTC = 23:30 BRT; 03:15 UTC = 00:15 BRT
    assert.equal(rows[0].inicio, "23:30", `início deve ser 23:30 BRT, got ${rows[0].inicio}`);
    assert.equal(rows[0].fim, "00:15", `fim deve ser 00:15 BRT, got ${rows[0].fim}`);
  });

  it("issue sem timestamp exibe '—', não um horário inválido", () => {
    const plan = makePlan([{ number: 10002, batch: null }]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].inicio, "—");
    assert.equal(rows[0].fim, "—");
  });
});

describe("mais lenta: guard unidade 0m (#2102 — item 2)", () => {
  it("unidade de 0m não é eleita como mais lenta — retorna '—' quando todas têm 0ms", () => {
    // Dispatch == merged → durationMs = 0 → não elegível
    const plan = makePlan([
      {
        number: 11001,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T22:00:00.000Z",
          merged: "2026-06-11T22:00:00.000Z", // exatamente 0ms
        },
      },
    ]);
    const output = renderOvernightTimeline(plan);
    const maisLenta = output.split("\n").filter((l) => l.includes("mais lenta"))[0];
    assert.ok(maisLenta.includes("—"), `0m não deve ser eleita mais lenta: ${maisLenta}`);
    assert.ok(!maisLenta.includes("#11001"), `#11001 (0m) não deve aparecer na mais lenta: ${maisLenta}`);
  });

  it("com issues mistas 0m e >0m, a mais lenta é a com duração positiva", () => {
    const plan = makePlan([
      {
        number: 11002,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T22:00:00.000Z",
          merged: "2026-06-11T22:00:00.000Z", // 0m — não elegível
        },
      },
      {
        number: 11003,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T22:05:00.000Z",
          merged: "2026-06-11T22:20:00.000Z", // 15m — elegível
        },
      },
    ]);
    const output = renderOvernightTimeline(plan);
    const maisLenta = output.split("\n").filter((l) => l.includes("mais lenta"))[0];
    assert.ok(maisLenta.includes("#11003"), `#11003 (15m) deve ser a mais lenta: ${maisLenta}`);
    assert.ok(!maisLenta.includes("#11002"), `#11002 (0m) não deve ser a mais lenta: ${maisLenta}`);
  });
});

describe("durationMs armazenado na TimelineRow (#2102 — item 3)", () => {
  it("row com timestamps válidos tem durationMs numérico correto", () => {
    const plan = makePlan([
      {
        number: 12001,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          merged: "2026-06-11T21:30:00.000Z", // 5400000ms = 90m
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].durationMs, 5_400_000, `durationMs deve ser 5400000: ${rows[0].durationMs}`);
  });

  it("row sem timestamp de fim tem durationMs null", () => {
    const plan = makePlan([
      {
        number: 12002,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          // sem merged/draft/pulada
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].durationMs, null);
  });

  it("row sem timeline tem durationMs null", () => {
    const plan = makePlan([{ number: 12003, batch: null }]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].durationMs, null);
  });
});

// #3889: `ultimoEventoISO` — ISO do timestamp `timeline.*` mais recente da
// unidade, usado pelo Studio (rodada.js) pra calcular "idade desde o último
// evento" de uma unidade "em andamento" (via `computeStageAge`, mesmo módulo
// de #3871). Precisa ser o MAIS RECENTE entre TODOS os campos presentes —
// não só `dispatch` — senão uma unidade que já avançou (pr_opened,
// fix_iteration_N) além do dispatch original apareceria com idade
// superestimada (falso alarme de stall).
describe("buildTimelineRows — ultimoEventoISO (#3889)", () => {
  it("unidade em andamento com só dispatch: ultimoEventoISO = dispatch", () => {
    const plan = makePlan([
      {
        number: 20001,
        batch: null,
        timeline: { dispatch: "2026-07-22T10:00:00.000Z" },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].fim, "em andamento");
    assert.equal(rows[0].ultimoEventoISO, "2026-07-22T10:00:00.000Z");
  });

  it("unidade em andamento com dispatch + pr_opened + fix_iteration_1: ultimoEventoISO é o MAIS RECENTE (fix_iteration_1), não dispatch", () => {
    const plan = makePlan([
      {
        number: 20002,
        batch: null,
        timeline: {
          dispatch: "2026-07-22T09:00:00.000Z",
          pr_opened: "2026-07-22T09:15:00.000Z",
          fix_iteration_1: "2026-07-22T09:55:00.000Z",
          // sem ci_green/merged — ainda "em andamento"
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].fim, "em andamento");
    assert.equal(
      rows[0].ultimoEventoISO,
      "2026-07-22T09:55:00.000Z",
      "deve usar fix_iteration_1 (mais recente), não dispatch",
    );
  });

  it("unidade mergeada: ultimoEventoISO = merged (mais recente entre os campos)", () => {
    const plan = makePlan([
      {
        number: 20003,
        batch: null,
        timeline: {
          dispatch: "2026-07-22T08:00:00.000Z",
          merged: "2026-07-22T08:30:00.000Z",
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].ultimoEventoISO, "2026-07-22T08:30:00.000Z");
  });

  it("sem timeline: ultimoEventoISO é null", () => {
    const plan = makePlan([{ number: 20004, batch: null }]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].ultimoEventoISO, null);
  });

  it("timeline: {} (vazio, sem nenhum timestamp): ultimoEventoISO é null", () => {
    const plan = makePlan([{ number: 20005, batch: null, timeline: {} }]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].ultimoEventoISO, null);
  });

  it("lote: usa o ultimoEventoISO do timeline REPRESENTANTE (1ª issue com dispatch), mesmo critério de inicio/fim", () => {
    const plan = makePlan([
      {
        number: 20006,
        batch: "lote-w",
        timeline: {
          dispatch: "2026-07-22T07:00:00.000Z",
          fix_iteration_1: "2026-07-22T07:40:00.000Z",
        },
      },
      {
        number: 20007,
        batch: "lote-w",
        timeline: {
          dispatch: "2026-07-22T07:00:00.000Z",
        },
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ultimoEventoISO, "2026-07-22T07:40:00.000Z");
  });
});

describe("countFixIterations dinâmico N (#2102 — item 4)", () => {
  it("fix_iteration_3 e _4 são contadas (não ignoradas)", () => {
    const plan = makePlan([
      {
        number: 13001,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          fix_iteration_1: "2026-06-11T20:15:00.000Z",
          fix_iteration_2: "2026-06-11T20:30:00.000Z",
          fix_iteration_3: "2026-06-11T20:45:00.000Z",
          fix_iteration_4: "2026-06-11T21:00:00.000Z",
          merged: "2026-06-11T21:30:00.000Z",
        } as import("../scripts/render-overnight-timeline.ts").IssueTimeline,
      },
    ]);
    const rows = buildTimelineRows(plan);
    assert.equal(rows[0].fixIteracoes, 4, `deveria contar 4 fix-iterations, got ${rows[0].fixIteracoes}`);
  });
});

// ─── renderTimeline fluxo-neutro (#2637) ──────────────────────────────────────

describe("renderTimeline — back-compat do alias overnight (#2637)", () => {
  it("renderOvernightTimeline(plan) === renderTimeline(plan) byte-a-byte", () => {
    const plan = makePlan([
      {
        number: 17001,
        batch: null,
        timeline: {
          dispatch: "2026-06-11T20:00:00.000Z",
          fix_iteration_1: "2026-06-11T20:20:00.000Z",
          merged: "2026-06-11T21:00:00.000Z",
        },
      },
      {
        number: 17002,
        batch: "lote-bc",
        timeline: { dispatch: "2026-06-11T21:05:00.000Z", merged: "2026-06-11T21:35:00.000Z" },
      },
      {
        number: 17003,
        batch: "lote-bc",
        timeline: { dispatch: "2026-06-11T21:05:00.000Z", merged: "2026-06-11T21:35:00.000Z" },
      },
    ]);
    // O alias deve produzir EXATAMENTE a mesma saída do default de renderTimeline.
    assert.equal(renderOvernightTimeline(plan), renderTimeline(plan));
  });

  it("default de renderTimeline preserva os rótulos overnight ('noite'/'rodada')", () => {
    const plan = makePlan([
      { number: 17004, batch: null, timeline: { dispatch: "2026-06-11T20:00:00.000Z", merged: "2026-06-11T20:30:00.000Z" } },
    ]);
    const output = renderTimeline(plan);
    assert.ok(output.includes("## Timeline da noite"), "default mantém título overnight");
    assert.ok(output.includes("**Total da rodada:**"), "default mantém rótulo de total overnight");
  });

  it("plan vazio com default mantém o título overnight", () => {
    const plan: Plan = { started_at: "2026-06-11T22:00:00.000Z", issues: [] };
    const output = renderTimeline(plan);
    assert.ok(output.includes("## Timeline da noite"));
    assert.ok(output.includes("nenhuma unidade registrada"));
  });
});

describe("renderTimeline — rótulos de sessão develop (#2637)", () => {
  it("opts.title/totalLabel substituem os rótulos overnight", () => {
    const plan = makePlan([
      { number: 18001, batch: null, timeline: { dispatch: "2026-06-11T20:00:00.000Z", merged: "2026-06-11T20:30:00.000Z" } },
    ]);
    const output = renderTimeline(plan, { title: "Timeline da sessão", totalLabel: "Total da sessão" });
    assert.ok(output.includes("## Timeline da sessão"), "título de sessão aplicado");
    assert.ok(output.includes("**Total da sessão:**"), "rótulo de total de sessão aplicado");
    // Não deve vazar os rótulos overnight quando custom é passado.
    assert.ok(!output.includes("## Timeline da noite"), "não vaza título overnight");
    assert.ok(!output.includes("**Total da rodada:**"), "não vaza rótulo overnight");
  });

  it("título custom também vale no caminho de plan vazio", () => {
    const plan: Plan = { started_at: "2026-06-27T13:40:00.000Z", issues: [] };
    const output = renderTimeline(plan, { title: "Timeline da sessão" });
    assert.ok(output.includes("## Timeline da sessão"));
    assert.ok(output.includes("nenhuma unidade registrada"));
  });

  it("plan.json no estilo develop (campos extras de desbloqueio) renderiza a tabela normalmente", () => {
    // O plan.json do /diaria-develop reusa o schema overnight + campos próprios
    // (block_category, unblock_status, wave, source). Devem ser ignorados
    // graciosamente — o renderizador só lê `timeline`/`batch`/`number`.
    const plan: Plan = {
      started_at: "2026-06-27T13:40:00.000Z",
      loop_estendido: true,
      issues: [
        {
          number: 2483,
          priority: "P3",
          status: "mergeada",
          batch: null,
          pr: 9001,
          block_category: "A",
          block_label: "bloqueio-externo",
          unblock_status: "desbloqueada-validada",
          wave: 1,
          source: "fresh-scan",
          timeline: { dispatch: "2026-06-27T14:00:00.000Z", merged: "2026-06-27T14:40:00.000Z" },
        } as unknown as PlanIssue,
      ],
    };
    const output = renderTimeline(plan, { title: "Timeline da sessão", totalLabel: "Total da sessão" });
    assert.ok(output.includes("## Timeline da sessão"));
    assert.ok(output.includes("#2483"), "issue de develop aparece na tabela");
    assert.ok(output.includes("| 40m |"), "duração calculada (14:00→14:40 = 40m)");
    assert.ok(output.includes("**Unidade mais lenta:** #2483 (40m)"), "rodapé calculado normalmente");
  });
});
