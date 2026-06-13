/**
 * test/overnight-statusline.test.ts (#2184)
 *
 * Testes da função pura `renderOvernightBar` que alimenta a statusLine
 * do Claude Code durante rodadas /diaria-overnight.
 *
 * Coberturas obrigatórias (#633):
 *   - plan com N unidades e M terminais → % + proporção de blocos corretos
 *   - plan null/undefined → string vazia
 *   - plan malformado (sem campo issues) → string vazia, sem throw
 *   - rodada encerrada (todas terminais) → string vazia (barra ocultada)
 *   - plan com 0 issues → string vazia
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderOvernightBar, type Plan } from "../scripts/overnight-statusline.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makePlan(statuses: string[]): Plan {
  return {
    started_at: "2026-06-13T22:00:00.000Z",
    issues: statuses.map((status, idx) => ({
      number: 1000 + idx,
      status,
    })),
  };
}

// ─── casos: plan ausente / malformado ─────────────────────────────────────────

describe("renderOvernightBar — plan null", () => {
  it("retorna string vazia para null", () => {
    assert.equal(renderOvernightBar(null), "");
  });

  it("retorna string vazia para undefined", () => {
    assert.equal(renderOvernightBar(undefined), "");
  });
});

describe("renderOvernightBar — plan malformado", () => {
  it("plan sem campo issues → string vazia, sem throw", () => {
    // Não deve lançar exceção mesmo com plan truncado
    const malformed = {} as Plan;
    let result: string;
    assert.doesNotThrow(() => {
      result = renderOvernightBar(malformed);
    });
    assert.equal(renderOvernightBar(malformed), "");
  });

  it("plan com issues não-array → string vazia, sem throw", () => {
    const malformed = { issues: "not-an-array" } as unknown as Plan;
    assert.doesNotThrow(() => renderOvernightBar(malformed));
    assert.equal(renderOvernightBar(malformed), "");
  });

  it("plan com issues null → string vazia, sem throw", () => {
    const malformed = { issues: null } as unknown as Plan;
    assert.doesNotThrow(() => renderOvernightBar(malformed));
    assert.equal(renderOvernightBar(malformed), "");
  });

  it("issue com status ausente é tratada como não-terminal", () => {
    // Issue sem campo status: count como não-terminal (elegível)
    // Evita crash + faz a barra aparecer corretamente
    const plan: Plan = {
      issues: [
        { status: "mergeada" },
        {} as { status: string },       // sem status
        { status: "elegivel" },
      ],
    };
    // 1 terminal de 3 → 33%
    const result = renderOvernightBar(plan);
    assert.ok(result.includes("33%"), `deve ter 33%: ${result}`);
    assert.ok(result.includes("(1/3)"), `deve ter (1/3): ${result}`);
  });
});

// ─── casos: plan com 0 issues ─────────────────────────────────────────────────

describe("renderOvernightBar — 0 issues", () => {
  it("retorna string vazia para plan com issues vazio", () => {
    const plan = makePlan([]);
    assert.equal(renderOvernightBar(plan), "");
  });
});

// ─── casos: progresso parcial ─────────────────────────────────────────────────

describe("renderOvernightBar — progresso 4/6 = 67%", () => {
  it("6 unidades, 4 terminais → barra com 67% e proporção correta", () => {
    const plan = makePlan([
      "mergeada",          // terminal
      "draft-ci-vermelho", // terminal
      "mergeada",          // terminal
      "pulada",            // terminal
      "elegivel",          // não-terminal
      "elegivel",          // não-terminal
    ]);
    const result = renderOvernightBar(plan);

    // Contém %
    assert.ok(result.includes("67%"), `deve ter 67%: ${result}`);
    // Contém (X/Y)
    assert.ok(result.includes("(4/6)"), `deve ter (4/6): ${result}`);
    // Contém barras cheias e vazias (barra de 12 chars → 8 cheias, 4 vazias)
    assert.ok(result.includes("████████"), `deve ter 8 blocos cheios: ${result}`);
    assert.ok(result.includes("░░░░"), `deve ter 4 blocos vazios: ${result}`);
    // Formato: [bar] %  (X/Y)
    assert.ok(result.startsWith("["), `deve começar com [: ${result}`);
  });
});

describe("renderOvernightBar — progresso 0/5 = 0%", () => {
  it("5 unidades elegíveis, 0 terminais → barra 0% com todos os blocos vazios", () => {
    const plan = makePlan(["elegivel", "elegivel", "elegivel", "elegivel", "elegivel"]);
    const result = renderOvernightBar(plan);

    assert.ok(result.includes("0%"), `deve ter 0%: ${result}`);
    assert.ok(result.includes("(0/5)"), `deve ter (0/5): ${result}`);
    // 12 blocos vazios quando done=0
    assert.ok(result.includes("░░░░░░░░░░░░"), `deve ter 12 blocos vazios: ${result}`);
    // Nenhum bloco cheio
    assert.ok(!result.includes("█"), `não deve ter blocos cheios: ${result}`);
  });
});

describe("renderOvernightBar — progresso 1/3 = 33%", () => {
  it("3 unidades, 1 terminal → 33% com 4 blocos cheios", () => {
    const plan = makePlan(["mergeada", "elegivel", "elegivel"]);
    const result = renderOvernightBar(plan);

    assert.ok(result.includes("33%"), `deve ter 33%: ${result}`);
    assert.ok(result.includes("(1/3)"), `deve ter (1/3): ${result}`);
    // 12 * 1/3 = 4 blocos cheios, 8 vazios
    assert.ok(result.includes("████"), `deve ter blocos cheios: ${result}`);
  });
});

// ─── casos: rodada encerrada ───────────────────────────────────────────────────

describe("renderOvernightBar — rodada encerrada", () => {
  it("todas mergeadas → string vazia (barra ocultada)", () => {
    const plan = makePlan(["mergeada", "mergeada", "mergeada"]);
    assert.equal(renderOvernightBar(plan), "");
  });

  it("mix de terminais (mergeada + pulada + draft-ci-vermelho) → string vazia", () => {
    const plan = makePlan(["mergeada", "pulada", "draft-ci-vermelho"]);
    assert.equal(renderOvernightBar(plan), "");
  });

  it("1 issue pulada → string vazia (rodada de 1 unidade concluída)", () => {
    const plan = makePlan(["pulada"]);
    assert.equal(renderOvernightBar(plan), "");
  });
});

// ─── verificação de formato ────────────────────────────────────────────────────

describe("renderOvernightBar — formato da barra", () => {
  it("barra tem exatamente 12 caracteres dentro de []", () => {
    const plan = makePlan(["mergeada", "elegivel", "elegivel"]);
    const result = renderOvernightBar(plan);

    // Extrai conteúdo entre [ e ]
    const match = result.match(/\[([█░]+)\]/);
    assert.ok(match, `resultado deve ter [bar]: ${result}`);
    assert.equal(
      match![1].length,
      12,
      `barra deve ter 12 chars, got ${match![1].length}: ${match![1]}`,
    );
  });

  it("formato canônico: [bar] NN%  (X/Y)", () => {
    const plan = makePlan(["mergeada", "elegivel"]);
    const result = renderOvernightBar(plan);

    // Deve ter [bar] + % + (X/Y)
    assert.match(result, /^\[[█░]+\] \d+%  \(\d+\/\d+\)$/);
  });
});

// ─── status terminals corretos ─────────────────────────────────────────────────

describe("renderOvernightBar — status terminais reconhecidos", () => {
  it("'mergeada' conta como terminal", () => {
    const plan = makePlan(["mergeada", "elegivel"]);
    const result = renderOvernightBar(plan);
    assert.ok(result.includes("(1/2)"), `mergeada deve contar: ${result}`);
  });

  it("'draft-ci-vermelho' conta como terminal", () => {
    const plan = makePlan(["draft-ci-vermelho", "elegivel"]);
    const result = renderOvernightBar(plan);
    assert.ok(result.includes("(1/2)"), `draft-ci-vermelho deve contar: ${result}`);
  });

  it("'pulada' conta como terminal", () => {
    const plan = makePlan(["pulada", "elegivel"]);
    const result = renderOvernightBar(plan);
    assert.ok(result.includes("(1/2)"), `pulada deve contar: ${result}`);
  });

  it("'elegivel' não conta como terminal", () => {
    const plan = makePlan(["elegivel", "elegivel"]);
    const result = renderOvernightBar(plan);
    assert.ok(result.includes("(0/2)"), `elegivel não deve contar: ${result}`);
  });

  it("status desconhecido não conta como terminal", () => {
    const plan = makePlan(["qualquer-status-inventado", "elegivel"]);
    const result = renderOvernightBar(plan);
    assert.ok(result.includes("(0/2)"), `status desconhecido não deve contar: ${result}`);
  });
});
