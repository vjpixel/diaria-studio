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
 *   - statuses precisa-resposta e bloqueada-externa são não-terminais (#2184/Finding 6)
 *   - pct usa Math.floor para não mostrar 100% com barra ainda visível (#2184/Finding 3)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderOvernightBar, OVERNIGHT_DIR_RE, type Plan } from "../scripts/overnight-statusline.ts";

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

describe("renderOvernightBar — progresso 4/6 = 66% (Math.floor)", () => {
  it("6 unidades, 4 terminais → barra com 66% e proporção correta (Math.floor)", () => {
    // Math.floor(4/6 * 100) = Math.floor(66.67) = 66  (não 67 que Math.round daria)
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
    assert.ok(result.includes("66%"), `deve ter 66%: ${result}`);
    // Contém (X/Y)
    assert.ok(result.includes("(4/6)"), `deve ter (4/6): ${result}`);
    // Contém barras cheias e vazias (barra de 12 chars → 8 cheias, 4 vazias)
    // Math.floor(4/6 * 12) = Math.floor(8) = 8 blocos cheios
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

// ─── Finding 6: statuses precisa-resposta e bloqueada-externa são não-terminais ───

describe("renderOvernightBar — status não-terminais: precisa-resposta e bloqueada-externa", () => {
  it("'precisa-resposta' não conta como terminal — barra fica visível", () => {
    // 0 terminais de 2 → barra visível (run ativo)
    const plan = makePlan(["precisa-resposta", "elegivel"]);
    const result = renderOvernightBar(plan);
    assert.notEqual(result, "", `precisa-resposta não deve encerrar a rodada: ${result}`);
    assert.ok(result.includes("(0/2)"), `precisa-resposta não deve contar como terminal: ${result}`);
  });

  it("'bloqueada-externa' não conta como terminal — barra fica visível", () => {
    // 0 terminais de 2 → barra visível (run ativo)
    const plan = makePlan(["bloqueada-externa", "elegivel"]);
    const result = renderOvernightBar(plan);
    assert.notEqual(result, "", `bloqueada-externa não deve encerrar a rodada: ${result}`);
    assert.ok(result.includes("(0/2)"), `bloqueada-externa não deve contar como terminal: ${result}`);
  });

  it("plan com apenas precisa-resposta mantém barra visível (run ativo, não encerrado)", () => {
    const plan = makePlan(["precisa-resposta", "precisa-resposta"]);
    const result = renderOvernightBar(plan);
    assert.notEqual(result, "", `plan só com precisa-resposta deve manter barra visível: ${result}`);
    assert.ok(result.includes("(0/2)"), `deve mostrar 0 terminais de 2: ${result}`);
  });

  it("plan com apenas bloqueada-externa mantém barra visível (run ativo, não encerrado)", () => {
    const plan = makePlan(["bloqueada-externa"]);
    const result = renderOvernightBar(plan);
    assert.notEqual(result, "", `plan só com bloqueada-externa deve manter barra visível: ${result}`);
    assert.ok(result.includes("(0/1)"), `deve mostrar 0 terminais de 1: ${result}`);
  });

  it("mix de precisa-resposta + bloqueada-externa + mergeada: só mergeada é terminal", () => {
    // 1 terminal (mergeada) de 3
    const plan = makePlan(["precisa-resposta", "bloqueada-externa", "mergeada"]);
    const result = renderOvernightBar(plan);
    assert.notEqual(result, "", `deve estar ativo: ${result}`);
    assert.ok(result.includes("(1/3)"), `só mergeada conta como terminal: ${result}`);
  });
});

// ─── #2200: filtro AAMMDD em readTodayPlan ────────────────────────────────────
// readTodayPlan filtra dirs por OVERNIGHT_DIR_RE (/^\d{6}$/) antes de ler plan.json.
// Testamos OVERNIGHT_DIR_RE diretamente (importado de overnight-statusline.ts) para
// garantir que o teste exercita o MESMO filtro que readTodayPlan usa, não uma cópia.

describe("filtro AAMMDD — OVERNIGHT_DIR_RE de overnight-statusline.ts", () => {
  it("aceita dirs válidos no formato AAMMDD", () => {
    assert.ok(OVERNIGHT_DIR_RE.test("260613"), "260613 deve ser aceito");
    assert.ok(OVERNIGHT_DIR_RE.test("260101"), "260101 deve ser aceito");
    // "000000" é sintaticamente válido (6 dígitos) — OVERNIGHT_DIR_RE filtra apenas
    // pela forma, não pela validade calendárica do AAMMDD.
    assert.ok(OVERNIGHT_DIR_RE.test("000000"), "000000 (6 dígitos válidos, AAMMDD degenerate) deve ser aceito");
  });

  it("rejeita dirs não-numéricos", () => {
    assert.ok(!OVERNIGHT_DIR_RE.test("archive"), "archive deve ser rejeitado");
    assert.ok(!OVERNIGHT_DIR_RE.test("tmp"), "tmp deve ser rejeitado");
    assert.ok(!OVERNIGHT_DIR_RE.test(".keep"), ".keep deve ser rejeitado");
    assert.ok(!OVERNIGHT_DIR_RE.test("26061a"), "26061a (letra) deve ser rejeitado");
  });

  it("rejeita dirs com comprimento diferente de 6 dígitos", () => {
    assert.ok(!OVERNIGHT_DIR_RE.test("2606"), "4 dígitos deve ser rejeitado");
    assert.ok(!OVERNIGHT_DIR_RE.test("2606130"), "7 dígitos deve ser rejeitado");
    assert.ok(!OVERNIGHT_DIR_RE.test(""), "string vazia deve ser rejeitada");
  });
});

// ─── Finding 3: Math.floor evita mostrar 100% com barra ainda visível ─────────

describe("renderOvernightBar — pct usa Math.floor (Finding #3)", () => {
  it("199/200: deve mostrar 99% (não 100%) para que a barra permaneça visível", () => {
    // Math.round(199/200 * 100) = Math.round(99.5) = 100 → BUG
    // Math.floor(199/200 * 100) = Math.floor(99.5) = 99  → CORRETO
    const statuses = Array(199).fill("mergeada").concat(["elegivel"]);
    const plan = makePlan(statuses);
    const result = renderOvernightBar(plan);
    // Barra deve estar visível (não encerrada)
    assert.notEqual(result, "", `199/200 não deve encerrar a rodada: ${result}`);
    // Não deve mostrar 100%
    assert.ok(!result.includes("100%"), `199/200 não deve mostrar 100%: ${result}`);
    // Deve mostrar 99%
    assert.ok(result.includes("99%"), `199/200 deve mostrar 99%: ${result}`);
  });

  it("1/2: Math.floor(50%) = 50% (sem diferença de round vs floor aqui)", () => {
    const plan = makePlan(["mergeada", "elegivel"]);
    const result = renderOvernightBar(plan);
    assert.ok(result.includes("50%"), `1/2 deve mostrar 50%: ${result}`);
  });

  it("2/3: Math.floor(66.6%) = 66%, não 67% (diferença de round vs floor)", () => {
    const plan = makePlan(["mergeada", "mergeada", "elegivel"]);
    const result = renderOvernightBar(plan);
    // Math.round(2/3 * 100) = Math.round(66.67) = 67
    // Math.floor(2/3 * 100) = Math.floor(66.67) = 66
    assert.ok(result.includes("66%"), `2/3 deve mostrar 66% com Math.floor: ${result}`);
    assert.ok(!result.includes("67%"), `2/3 não deve mostrar 67% (Math.round seria errado): ${result}`);
  });
});
