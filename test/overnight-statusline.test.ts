/**
 * test/overnight-statusline.test.ts (#2184, #2246)
 *
 * Testes da função pura `renderOvernightBar` que alimenta a statusLine
 * do Claude Code durante rodadas /diaria-overnight.
 *
 * Coberturas obrigatórias (#633):
 *   - plan com N unidades e M terminais → % + proporção de blocos corretos
 *   - plan null/undefined → string vazia
 *   - plan malformado (sem campo issues) → string vazia, sem throw
 *   - rodada encerrada (todas terminais) → 100% VISÍVEL (#2246 pt3, revisa #2184)
 *   - plan com 0 issues → string vazia
 *   - statuses precisa-resposta e bloqueada-externa são não-terminais (#2184/Finding 6)
 *   - pct usa Math.floor para não mostrar 100% com barra ainda visível (#2184/Finding 3)
 *   - OVERNIGHT_DIR_RE casa sufixo [a-z]? (exatamente 1 letra — 260613b/c) (#2246 pt1)
 *   - readTodayPlan usa dir MAIS RECENTE, não sequestra por plan antigo (#2246 pt2)
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderOvernightBar, readTodayPlan, OVERNIGHT_DIR_RE, type Plan } from "../scripts/overnight-statusline.ts";

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

// ─── casos: rodada encerrada (#2246 pt3: 100% visível, NÃO "") ────────────────

describe("renderOvernightBar — rodada encerrada → 100% visível (#2246)", () => {
  it("todas mergeadas → barra 100% visível (NÃO string vazia)", () => {
    const plan = makePlan(["mergeada", "mergeada", "mergeada"]);
    const result = renderOvernightBar(plan);
    assert.notEqual(result, "", "rodada encerrada não deve retornar string vazia");
    assert.ok(result.includes("100%"), `deve mostrar 100%: ${result}`);
    assert.ok(result.includes("(3/3)"), `deve mostrar (3/3): ${result}`);
    assert.ok(result.includes("████████████"), `deve ter barra cheia: ${result}`);
  });

  it("mix de terminais (mergeada + pulada + draft-ci-vermelho) → 100% visível", () => {
    const plan = makePlan(["mergeada", "pulada", "draft-ci-vermelho"]);
    const result = renderOvernightBar(plan);
    assert.notEqual(result, "", "rodada encerrada não deve retornar string vazia");
    assert.ok(result.includes("100%"), `deve mostrar 100%: ${result}`);
    assert.ok(result.includes("(3/3)"), `deve mostrar (3/3): ${result}`);
  });

  it("1 issue pulada → barra 100% visível (rodada de 1 unidade concluída)", () => {
    const plan = makePlan(["pulada"]);
    const result = renderOvernightBar(plan);
    assert.notEqual(result, "", "rodada de 1 unidade concluída não deve retornar string vazia");
    assert.ok(result.includes("100%"), `deve mostrar 100%: ${result}`);
    assert.ok(result.includes("(1/1)"), `deve mostrar (1/1): ${result}`);
  });

  it("rodada encerrada: formato canônico [████████████] 100%  (N/N)", () => {
    const plan = makePlan(["mergeada", "mergeada"]);
    const result = renderOvernightBar(plan);
    // Formato completo: [bar cheia de 12 █] 100%  (N/N)
    // Nota: /[█+]/ seria char class (casa █ OU +) — usar {12} para exigir exatamente 12 blocos.
    assert.match(result, /^\[█{12}\] 100%  \(\d+\/\d+\)$/);
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

// ─── #2200 + #2246 pt1: filtro AAMMDD[a-z]? em readTodayPlan ─────────────────
// readTodayPlan filtra dirs por OVERNIGHT_DIR_RE antes de ler plan.json.
// Fix #2246 pt1: regex atualizada para /^\d{6}[a-z]?$/ — casa sufixo de 1 letra de mesmo-dia.
// Dois sufixos (260613aa) não são aceitos — mis-ordenariam lexicograficamente.
// Testamos OVERNIGHT_DIR_RE diretamente (importado de overnight-statusline.ts) para
// garantir que o teste exercita o MESMO filtro que readTodayPlan usa, não uma cópia.

describe("filtro AAMMDD — OVERNIGHT_DIR_RE de overnight-statusline.ts", () => {
  it("aceita dirs válidos no formato AAMMDD (sem sufixo)", () => {
    assert.ok(OVERNIGHT_DIR_RE.test("260613"), "260613 deve ser aceito");
    assert.ok(OVERNIGHT_DIR_RE.test("260101"), "260101 deve ser aceito");
    // "000000" é sintaticamente válido (6 dígitos) — OVERNIGHT_DIR_RE filtra apenas
    // pela forma, não pela validade calendárica do AAMMDD.
    assert.ok(OVERNIGHT_DIR_RE.test("000000"), "000000 (6 dígitos válidos, AAMMDD degenerate) deve ser aceito");
  });

  // Fix #2246 pt1: sufixos de rodadas suplementares devem ser aceitos (exatamente 1 letra)
  it("aceita dirs com sufixo de rodada suplementar (AAMMDD[a-z]? — 1 letra)", () => {
    assert.ok(OVERNIGHT_DIR_RE.test("260613b"), "260613b (rodada B) deve ser aceito");
    assert.ok(OVERNIGHT_DIR_RE.test("260613c"), "260613c (rodada C) deve ser aceito");
    assert.ok(OVERNIGHT_DIR_RE.test("260613z"), "260613z (rodada Z) deve ser aceito");
    // Dois sufixos NÃO são aceitos — mis-ordenariam lexicograficamente
    assert.ok(!OVERNIGHT_DIR_RE.test("260613aa"), "260613aa (2 letras) deve ser rejeitado");
    assert.ok(!OVERNIGHT_DIR_RE.test("260613bc"), "260613bc (2 letras) deve ser rejeitado");
  });

  it("rejeita dirs não-numéricos", () => {
    assert.ok(!OVERNIGHT_DIR_RE.test("archive"), "archive deve ser rejeitado");
    assert.ok(!OVERNIGHT_DIR_RE.test("tmp"), "tmp deve ser rejeitado");
    assert.ok(!OVERNIGHT_DIR_RE.test(".keep"), ".keep deve ser rejeitado");
  });

  it("rejeita dirs com letras ANTES dos dígitos ou misturadas", () => {
    assert.ok(!OVERNIGHT_DIR_RE.test("a260613"), "letra antes de dígitos deve ser rejeitada");
    assert.ok(!OVERNIGHT_DIR_RE.test("26061a3"), "letra no meio deve ser rejeitada");
  });

  it("rejeita dirs com comprimento diferente de 6 dígitos base", () => {
    assert.ok(!OVERNIGHT_DIR_RE.test("2606"), "4 dígitos deve ser rejeitado");
    assert.ok(!OVERNIGHT_DIR_RE.test("2606130"), "7 dígitos sem sufixo deve ser rejeitado");
    assert.ok(!OVERNIGHT_DIR_RE.test(""), "string vazia deve ser rejeitada");
  });

  it("sort lexicográfico garante 260613c > 260613b > 260613 > 260611 (desc correto)", () => {
    // Verifica que a ordenação que readTodayPlan usa (sort+reverse) é correta
    const dirs = ["260611", "260613", "260613b", "260613c"];
    const sorted = [...dirs].sort().reverse();
    assert.deepEqual(sorted, ["260613c", "260613b", "260613", "260611"],
      `ordem incorreta: ${sorted.join(", ")}`);
  });
});

// ─── #2246 pt2: renderOvernightBar não sequestra por plan antigo ──────────────
// Estes testes exercitam renderOvernightBar diretamente com os plans que
// readTodayPlan deveria selecionar. O comportamento correto de readTodayPlan
// (usar o mais-recente) é testado indiretamente via OVERNIGHT_DIR_RE sort acima.
// A garantia end-to-end é: se o plan mais-recente (260613c, terminal) for passado,
// renderOvernightBar mostra 100% — não o plan antigo (260611, não-terminal, 45/47).

describe("renderOvernightBar — #2246: plan da rodada mais recente (encerrada) → 100%", () => {
  it("plan recente todo-terminal mostra 100% (bug: antes mostrava '' + sequestrava pro antigo)", () => {
    // Simula plan da 260613c (todos terminais — rodada encerrada)
    const planRecente = makePlan(["mergeada", "mergeada", "mergeada", "mergeada", "mergeada"]);
    const result = renderOvernightBar(planRecente);
    // Fix #2246 pt3: deve mostrar 100%, não ""
    assert.notEqual(result, "", "plan da rodada mais recente (encerrada) não deve retornar ''");
    assert.ok(result.includes("100%"), `deve mostrar 100%: ${result}`);
    assert.ok(result.includes("(5/5)"), `deve mostrar (5/5): ${result}`);
  });

  it("renderOvernightBar: plan recente (encerrado) mostra 100%, plan antigo (não-terminal) mostraria %parcial", () => {
    // Este teste documenta a lógica correta de renderOvernightBar para os dois casos
    // extremos: plan mais-recente (encerrado, todos terminais) e plan antigo (com não-terminal).
    // A garantia de que readTodayPlan seleciona o mais-recente está no teste de integração
    // "readTodayPlan: retorna plan do dir MAIS RECENTE" (seção abaixo).
    //
    // Simulação: comparamos o que acontece quando passamos o plan correto vs errado:
    const planAntigo = makePlan(Array(45).fill("mergeada").concat(["concluida-sem-pr", "elegivel"]));
    const planRecente = makePlan(Array(5).fill("mergeada")); // 260613c: 5/5 terminal

    const resultAntigo = renderOvernightBar(planAntigo);
    const resultRecente = renderOvernightBar(planRecente);

    // Plan antigo (sem o fix): mostraria ~95% ou similar (não-terminal presente)
    assert.ok(resultAntigo.includes("(45/47)"), `plan antigo deve mostrar 45/47: ${resultAntigo}`);
    assert.ok(!resultAntigo.includes("100%"), `plan antigo não deve ser 100%: ${resultAntigo}`);

    // Plan recente (comportamento correto com o fix): mostra 100%
    assert.ok(resultRecente.includes("100%"), `plan recente deve mostrar 100%: ${resultRecente}`);
    assert.notEqual(resultRecente, "", "plan recente não deve retornar ''");
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

// ─── #2246 pt2: integração real — readTodayPlan lê dir mais recente ──────────
// Reproduz o bug raiz: plan antigo (260611) com não-terminal sequestrava a barra
// durante rodadas suplementares (260613b, 260613c) quando a regex era /[a-z]*/.
// Sem o fix, readTodayPlan pegaria 260611 (primeiro com não-terminal) em vez de
// 260613c (mais recente). Com o fix (sort desc + retorna o mais recente), pega 260613c.

describe("readTodayPlan — integração com dirs reais (#2246 pt2)", () => {
  // Cria um tmpdir exclusivo para este describe (limpo no after)
  const tmpRoot = join(tmpdir(), `overnight-statusline-test-${Date.now()}`);

  // Fixture: plan com issues terminais (rodada encerrada)
  function makeTerminalPlan(n: number): string {
    const issues = Array.from({ length: n }, (_, i) => ({
      number: 1000 + i,
      status: "mergeada",
    }));
    return JSON.stringify({ started_at: "2026-06-13T22:00:00.000Z", issues });
  }

  // Fixture: plan com pelo menos 1 issue não-terminal (rodada ativa ou antiga)
  function makeActivePlan(done: number, total: number): string {
    const issues = [
      ...Array.from({ length: done }, (_, i) => ({ number: 1000 + i, status: "mergeada" })),
      ...Array.from({ length: total - done }, (_, i) => ({ number: 2000 + i, status: "elegivel" })),
    ];
    return JSON.stringify({ started_at: "2026-06-11T22:00:00.000Z", issues });
  }

  // Cria estrutura:
  //   {tmpRoot}/data/overnight/260611/plan.json   ← antigo, 45/47 não-terminal
  //   {tmpRoot}/data/overnight/260613/plan.json   ← rodada base (encerrada)
  //   {tmpRoot}/data/overnight/260613b/plan.json  ← rodada B (encerrada)
  //   {tmpRoot}/data/overnight/260613c/plan.json  ← rodada C (mais recente, encerrada)
  function createFixtureDirs(): void {
    const overnightDir = join(tmpRoot, "data", "overnight");

    // 260611: antigo, 45 terminais + 2 não-terminais → bug: sequestrava sem o fix
    mkdirSync(join(overnightDir, "260611"), { recursive: true });
    writeFileSync(join(overnightDir, "260611", "plan.json"), makeActivePlan(45, 47));

    // 260613: rodada base, encerrada (3/3 terminais)
    mkdirSync(join(overnightDir, "260613"), { recursive: true });
    writeFileSync(join(overnightDir, "260613", "plan.json"), makeTerminalPlan(3));

    // 260613b: rodada suplementar B, encerrada (5/5 terminais)
    mkdirSync(join(overnightDir, "260613b"), { recursive: true });
    writeFileSync(join(overnightDir, "260613b", "plan.json"), makeTerminalPlan(5));

    // 260613c: rodada suplementar C (mais recente), encerrada (4/4 terminais)
    mkdirSync(join(overnightDir, "260613c"), { recursive: true });
    writeFileSync(join(overnightDir, "260613c", "plan.json"), makeTerminalPlan(4));
  }

  // Cria os dirs antes do primeiro it
  createFixtureDirs();

  after(() => {
    // Limpa os tmp dirs no teardown — não em afterEach (os tests compartilham a estrutura)
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("retorna plan do dir MAIS RECENTE (260613c), NÃO do antigo com não-terminal (260611)", () => {
    const plan = readTodayPlan(tmpRoot);

    // Deve ter retornado o plan de 260613c: 4 issues, todas terminais
    assert.ok(plan !== null, "plan não deve ser null");
    assert.ok(Array.isArray(plan!.issues), "plan.issues deve ser array");
    assert.equal(plan!.issues.length, 4, `260613c tem 4 issues, got ${plan!.issues.length}`);

    // Todas as issues de 260613c são terminais → renderOvernightBar mostra 100%
    const bar = renderOvernightBar(plan!);
    assert.ok(bar.includes("100%"), `barra deve mostrar 100% (260613c encerrada): ${bar}`);
    assert.ok(bar.includes("(4/4)"), `barra deve mostrar (4/4): ${bar}`);

    // Bug de antes: plan antigo (260611, 45/47) NUNCA deve ser retornado quando há mais-recente
    assert.ok(!bar.includes("(45/47)"), `plan antigo NÃO deve ser selecionado: ${bar}`);
    assert.ok(!bar.includes("45/47"), `plan antigo NÃO deve aparecer na barra: ${bar}`);
  });

  it("ignora plan vazio (issues:[]) e avança para o próximo dir mais recente com issues", () => {
    // Cria um dir mais recente que 260613c com plan vazio (sem issues)
    const overnightDir = join(tmpRoot, "data", "overnight");
    mkdirSync(join(overnightDir, "260613d"), { recursive: true });
    writeFileSync(
      join(overnightDir, "260613d", "plan.json"),
      JSON.stringify({ started_at: "2026-06-13T23:00:00.000Z", issues: [] }),
    );

    const plan = readTodayPlan(tmpRoot);

    // Plan vazio (260613d) é ignorado → retorna 260613c (4 issues)
    assert.ok(plan !== null, "plan não deve ser null");
    assert.equal(plan!.issues.length, 4, `deve pular o plan vazio e retornar 260613c (4 issues), got ${plan!.issues.length}`);
  });

  it("retorna null quando não há nenhum dir overnight com plan válido", () => {
    // Cria um tmpdir isolado (sem nenhum plan)
    const emptyRoot = join(tmpdir(), `overnight-empty-${Date.now()}`);
    mkdirSync(join(emptyRoot, "data", "overnight"), { recursive: true });

    try {
      const plan = readTodayPlan(emptyRoot);
      assert.equal(plan, null, "sem plans válidos deve retornar null");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
