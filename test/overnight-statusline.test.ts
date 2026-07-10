/**
 * test/overnight-statusline.test.ts (#2184, #2246, #2298)
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
 *   - cycleLabel (#2298): fila principal / mini-rodada N / review 1.5x determinístico
 */

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderOvernightBar, readTodayPlan, cycleLabel, OVERNIGHT_DIR_RE, type Plan } from "../scripts/overnight-statusline.ts";

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

/**
 * Helper #3131: constrói um plan com `in_round` explícito por issue.
 * `makePlan` (acima) nunca grava o campo — cobre o caso legado (fail-open).
 * Entries sem `in_round` aqui também omitem o campo (simula plan.json legado
 * misturado com issues novas que já têm o campo).
 */
function makePlanWithInRound(entries: Array<{ status: string; in_round?: boolean }>): Plan {
  return {
    started_at: "2026-06-13T22:00:00.000Z",
    issues: entries.map((entry, idx) => ({
      number: 2000 + idx,
      status: entry.status,
      ...(entry.in_round !== undefined ? { in_round: entry.in_round } : {}),
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

    // Use "] 0%" to avoid false-positive match on "100%"
    assert.ok(result.includes("] 0%"), `deve ter 0% (não 100%): ${result}`);
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

  it("rodada encerrada: formato canônico [████████████] 100%  (N/N)  · <ciclo>", () => {
    const plan = makePlan(["mergeada", "mergeada"]);
    const result = renderOvernightBar(plan);
    // Formato completo: [bar cheia de 12 █] 100%  (N/N)  · <ciclo> (#2298)
    // Nota: /[█+]/ seria char class (casa █ OU +) — usar {12} para exigir exatamente 12 blocos.
    assert.match(result, /^\[█{12}\] 100%  \(\d+\/\d+\)  · .+$/);
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

  it("formato canônico: [bar] NN%  (X/Y)  · <ciclo>", () => {
    const plan = makePlan(["mergeada", "elegivel"]);
    const result = renderOvernightBar(plan);

    // Deve ter [bar] + % + (X/Y) + rótulo de ciclo (#2298)
    assert.match(result, /^\[[█░]+\] \d+%  \(\d+\/\d+\)  · .+$/);
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

// #3071: EPIC deliberadamente deferido (fecha só quando a issue-filha mergear)
// não é trabalho pendente real — deve contar como terminal na barra, senão a
// rodada nunca bate 100% mesmo com a cadeia genuinamente encerrada (incidente
// real: data/overnight/260706/plan.json, issue #2808 travando 25/26 pra sempre).
describe("renderOvernightBar — #3071: EPIC deferido ('elegivel_especial') conta como terminal", () => {
  it("'elegivel_especial' conta como terminal — rodada com só esse status pendente bate 100%", () => {
    const plan = makePlan(["mergeada", "pulada", "elegivel_especial"]);
    const result = renderOvernightBar(plan);
    assert.ok(result.includes("(3/3)"), `elegivel_especial deve contar como terminal: ${result}`);
    assert.ok(result.includes("100%"), `deve bater 100% com só EPIC deferido pendente: ${result}`);
  });

  it("issue elegivel comum (não-EPIC) ainda NÃO conta — não confundir com elegivel_especial", () => {
    const plan = makePlan(["mergeada", "elegivel_especial", "elegivel"]);
    const result = renderOvernightBar(plan);
    assert.ok(result.includes("(2/3)"), `'elegivel' comum não deve contar como terminal: ${result}`);
  });
});

// ─── #3131: in_round exclui do denominador issues que nunca entraram na rodada ──
// Bug original: renderOvernightBar computava total = issues.length sobre TODO
// plan.issues, incluindo issues que a Fase 0 passo 4 excluiu ANTES de entrar
// (bloqueada-externa, not-this-week, ambígua/trade-off-real) e o EPIC deferido
// elegivel_especial (nunca despachado). Rodada real 260707: plan.json tinha 57
// issues, só 53 de fato entraram (47 iniciais elegivel/precisa-resposta + 6
// mid-round); com 2 mergeadas a barra mostrava 6/57 (as outras 4 excluídas
// eram todas terminais — pulada/elegivel_especial — inflando numerador E
// denominador em igual medida) quando o sinal útil era 2/53.
describe("renderOvernightBar — #3131: exclusão do denominador (réplica do incidente 260707)", () => {
  it("4 issues in_round:false (bloqueada-externa/not-this-week/trade-off-real/EPIC) somem do denominador — 2/53, não 6/57", () => {
    const entries: Array<{ status: string; in_round?: boolean }> = [
      // 4 issues excluídas JÁ na Fase 0 passo 4 — nunca entraram na rodada.
      { status: "pulada", in_round: false }, // bloqueada-externa
      { status: "pulada", in_round: false }, // not-this-week
      { status: "pulada", in_round: false }, // ambígua/trade-off-real
      { status: "elegivel_especial", in_round: false }, // EPIC deferido (#3071)
      // 53 issues que de fato entraram: 2 mergeadas, 51 ainda em aberto.
      { status: "mergeada", in_round: true },
      { status: "mergeada", in_round: true },
      ...Array.from({ length: 51 }, () => ({ status: "elegivel", in_round: true })),
    ];
    assert.equal(entries.length, 57, "fixture deve ter 57 issues no total (réplica do incidente 260707)");

    const plan = makePlanWithInRound(entries);
    const result = renderOvernightBar(plan);

    assert.ok(result.includes("(2/53)"), `deve mostrar (2/53) — sinal útil do que entrou na rodada: ${result}`);
    assert.ok(!result.includes("(6/57)"), `NÃO deve mostrar o denominador antigo inflado: ${result}`);
  });

  it("plan só com issues in_round:false → barra oculta (issues.length filtrado = 0)", () => {
    const plan = makePlanWithInRound([
      { status: "pulada", in_round: false },
      { status: "pulada", in_round: false },
      { status: "pulada", in_round: false },
      { status: "elegivel_especial", in_round: false },
    ]);
    assert.equal(renderOvernightBar(plan), "", "plan sem NENHUMA issue in_round:true deve ocultar a barra");
  });
});

describe("renderOvernightBar — #3131: pulada MID-RODADA (in_round:true) continua contando", () => {
  it("issue elegivel que vira pulada mid-rodada (sem-resposta/rescan-limit/ambigua) mantém in_round:true e continua contando", () => {
    // Entraram 3 issues na rodada (in_round:true): 1 mergeada, 1 pulada mid-rodada
    // (motivo sem-resposta — skip DEPOIS de entrar, não exclusão de Fase 0),
    // 1 ainda elegivel.
    const plan = makePlanWithInRound([
      { status: "mergeada", in_round: true },
      { status: "pulada", in_round: true }, // pulada mid-rodada (sem-resposta)
      { status: "elegivel", in_round: true },
    ]);
    const result = renderOvernightBar(plan);
    // 2 terminais (mergeada + pulada mid-rodada) de 3 in_round:true — a pulada
    // mid-rodada NÃO é excluída, diferente das puladas de Fase 0 acima.
    assert.ok(result.includes("(2/3)"), `pulada mid-rodada deve contar no numerador E no denominador: ${result}`);
  });

  it("mistura: excluída de Fase 0 (in_round:false) fica fora, pulada mid-rodada (in_round:true) fica dentro", () => {
    const plan = makePlanWithInRound([
      { status: "pulada", in_round: false }, // bloqueada-externa, Fase 0 — fora
      { status: "pulada", in_round: true },  // sem-resposta, mid-rodada — dentro
      { status: "mergeada", in_round: true },
      { status: "elegivel", in_round: true },
    ]);
    const result = renderOvernightBar(plan);
    // Denominador = 3 (só as in_round:true); numerador = 2 (pulada mid-rodada + mergeada)
    assert.ok(result.includes("(2/3)"), `deve excluir só a issue in_round:false do denominador: ${result}`);
  });
});

describe("renderOvernightBar — #3131: legado (sem campo in_round) trata como true (fail-open)", () => {
  it("plan.json legado sem NENHUM in_round → todas as issues contam no denominador (comportamento pré-#3131 preservado)", () => {
    // Reusa makePlan (helper legado) — nunca grava in_round, simulando plan.json
    // gravado antes deste campo existir (fail-open: campo ausente = in_round true).
    const plan = makePlan(["mergeada", "pulada", "elegivel", "bloqueada-externa"]);
    const result = renderOvernightBar(plan);
    // "bloqueada-externa" não é terminal (fora de TERMINAL_STATUSES) — só
    // mergeada+pulada contam como terminal. O ponto do teste é o DENOMINADOR:
    // as 4 issues devem contar nele (fail-open), não só as com o campo.
    assert.ok(result.includes("(2/4)"), `plan legado sem in_round deve contar TODAS as issues no denominador: ${result}`);
  });

  it("mix: algumas issues com in_round:true explícito, outras sem o campo (undefined) — ambas contam", () => {
    const plan = makePlanWithInRound([
      { status: "mergeada" }, // sem campo — fail-open true
      { status: "elegivel", in_round: true }, // explícito true
      { status: "elegivel" }, // sem campo — fail-open true
    ]);
    const result = renderOvernightBar(plan);
    assert.ok(result.includes("(1/3)"), `issues sem campo in_round devem contar como true: ${result}`);
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

  // Todos os 5 não-terminais do tipo IssueStatus (#2301)
  it("'not-this-week' não conta como terminal — barra fica visível", () => {
    const plan = makePlan(["not-this-week", "elegivel"]);
    const result = renderOvernightBar(plan);
    assert.notEqual(result, "", `not-this-week não deve encerrar a rodada: ${result}`);
    assert.ok(result.includes("(0/2)"), `not-this-week não deve contar como terminal: ${result}`);
  });

  it("'fora-do-escopo' não conta como terminal — barra fica visível", () => {
    const plan = makePlan(["fora-do-escopo", "elegivel"]);
    const result = renderOvernightBar(plan);
    assert.notEqual(result, "", `fora-do-escopo não deve encerrar a rodada: ${result}`);
    assert.ok(result.includes("(0/2)"), `fora-do-escopo não deve contar como terminal: ${result}`);
  });

  it("mix de todos os não-terminais: nenhum conta como terminal", () => {
    // Todos os 5 não-terminais documentados em IssueStatus
    const plan = makePlan(["elegivel", "precisa-resposta", "bloqueada-externa", "not-this-week", "fora-do-escopo"]);
    const result = renderOvernightBar(plan);
    assert.notEqual(result, "", "plan com todos não-terminais deve mostrar barra ativa");
    assert.ok(result.includes("(0/5)"), `nenhum dos não-terminais deve contar: ${result}`);
    // Use " 0%" (with leading space) to avoid false-positive match on "100%"
    assert.ok(result.includes("] 0%"), `deve mostrar 0% (não 100%): ${result}`);
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

  // Register cleanup FIRST — before any throwable setup — so tmpRoot is always cleaned up.
  after(() => {
    // Limpa os tmp dirs no teardown — não em afterEach (os tests compartilham a estrutura)
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Cria os dirs via before() hook (runs after after() registration, before first it)
  before(() => {
    createFixtureDirs();
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

// ─── #2298: cycleLabel — rótulo de ciclo/fase da rodada overnight ─────────────

/**
 * Helper: cria plan.json com issues do depth 0 (fila principal).
 * O source "initial" é omitido (campo ausente) para testar robustez de legado.
 */
function makeDepth0Plan(
  statuses: string[],
  review?: string | null,
  findings_depth?: number,
): Plan {
  return {
    started_at: "2026-06-15T22:00:00.000Z",
    findings_depth: findings_depth ?? 0,
    review: review ?? null,
    issues: statuses.map((status, idx) => ({
      number: 3000 + idx,
      status,
      // sem `source` → legado, conta como "initial" (profundidade 0)
    })),
  };
}

/** Helper: cria plan.json com issues de uma mini-rodada (finding-depth-N). */
function makeMiniRodadaPlan(
  depth: number,
  mainStatuses: string[],
  findingStatuses: string[],
  review?: string | null,
): Plan {
  const mainIssues = mainStatuses.map((status, idx) => ({
    number: 3000 + idx,
    status,
    source: "initial",
  }));
  const findingIssues = findingStatuses.map((status, idx) => ({
    number: 4000 + idx,
    status,
    source: `finding-depth-${depth}`,
  }));
  return {
    started_at: "2026-06-15T22:00:00.000Z",
    findings_depth: depth,
    review: review ?? null,
    issues: [...mainIssues, ...findingIssues],
  };
}

describe("cycleLabel — fila principal (depth 0, queue ativa)", () => {
  it("depth 0, issues não todas terminais → 'fila principal'", () => {
    const plan = makeDepth0Plan(["elegivel", "mergeada", "elegivel"]);
    assert.equal(cycleLabel(plan), "fila principal");
  });

  it("depth 0, nenhuma issue terminal → 'fila principal'", () => {
    const plan = makeDepth0Plan(["elegivel", "elegivel"]);
    assert.equal(cycleLabel(plan), "fila principal");
  });

  it("depth 0, queue esgotada MAS review já concluído (done depth 0) → 'fila principal'", () => {
    // Após review 1.5 concluído e findings_depth ainda 0 → Fase 2 (não há mais o que mostrar
    // como mini-rodada, mas também não estamos EM review). Retorna 'fila principal' para
    // indicar que a cadeia está encerrada no depth corrente.
    const plan = makeDepth0Plan(["mergeada", "mergeada"], "done (depth 0)", 0);
    assert.equal(cycleLabel(plan), "fila principal");
  });

  it("depth 0, queue esgotada, review skipped → 'fila principal'", () => {
    const plan = makeDepth0Plan(["mergeada", "pulada"], "skipped: diff trivial (depth 0)", 0);
    assert.equal(cycleLabel(plan), "fila principal");
  });

  it("depth 0, legado: findings_depth ausente, review ausente, issues ativas → 'fila principal'", () => {
    // Plan legado sem findings_depth nem review
    const plan: Plan = {
      started_at: "2026-06-01T22:00:00.000Z",
      issues: [
        { number: 1001, status: "elegivel" },
        { number: 1002, status: "mergeada" },
      ],
    };
    assert.equal(cycleLabel(plan), "fila principal");
  });
});

describe("cycleLabel — review 1.5 (depth 0, queue esgotada, review null)", () => {
  it("depth 0, todas terminais, review null → 'review 1.5'", () => {
    const plan = makeDepth0Plan(["mergeada", "pulada", "draft-ci-vermelho"], null, 0);
    assert.equal(cycleLabel(plan), "review 1.5");
  });

  it("depth 0, 1 issue terminal, review null → NÃO é review 1.5 (ainda tem pendentes)", () => {
    const plan = makeDepth0Plan(["mergeada", "elegivel"], null, 0);
    assert.notEqual(cycleLabel(plan), "review 1.5");
    assert.equal(cycleLabel(plan), "fila principal");
  });

  it("review 1.5: barra exibe rótulo '· review 1.5' ao encerrar rodada", () => {
    const plan = makeDepth0Plan(["mergeada", "mergeada", "pulada"], null, 0);
    const bar = renderOvernightBar(plan);
    assert.match(bar, /· review 1\.5(?!b|c)/, `barra deve conter '· review 1.5' (não 1.5b/c): ${bar}`);
    assert.ok(bar.includes("100%"), `barra deve mostrar 100% (encerrada): ${bar}`);
  });

  it("review 1.5: barra em progresso parcial também exibe rótulo", () => {
    // 2 terminais de 4 → fila ainda ativa → 'fila principal' (não review 1.5)
    const plan = makeDepth0Plan(["mergeada", "mergeada", "elegivel", "elegivel"], null, 0);
    const bar = renderOvernightBar(plan);
    assert.ok(bar.includes("· fila principal"), `barra deve conter '· fila principal': ${bar}`);
  });
});

describe("cycleLabel — mini-rodada 1 (depth 1, finding-depth-1 ativas)", () => {
  it("depth 1, finding-depth-1 não todas terminais → 'mini-rodada 1'", () => {
    // 1 finding pendente → mini-rodada em progresso
    const plan = makeMiniRodadaPlan(1, ["mergeada", "mergeada"], ["elegivel", "mergeada"], "done (depth 0)");
    assert.equal(cycleLabel(plan), "mini-rodada 1");
  });

  it("depth 1, nenhuma finding-depth-1 terminal → 'mini-rodada 1'", () => {
    const plan = makeMiniRodadaPlan(1, ["mergeada"], ["elegivel"], "done (depth 0)");
    assert.equal(cycleLabel(plan), "mini-rodada 1");
  });

  it("mini-rodada 1: barra exibe '· mini-rodada 1'", () => {
    const plan = makeMiniRodadaPlan(1, ["mergeada", "pulada"], ["elegivel", "elegivel"], "done (depth 0)");
    const bar = renderOvernightBar(plan);
    assert.ok(bar.includes("· mini-rodada 1"), `barra deve conter '· mini-rodada 1': ${bar}`);
  });
});

describe("cycleLabel — review 1.5b (depth 1, finding-depth-1 esgotadas, review null para depth 1)", () => {
  it("depth 1, todas finding-depth-1 terminais, review 'done (depth 0)' → 'review 1.5b'", () => {
    // issues principais: mergeadas; finding-depth-1: todas mergeadas; review depth 0 OK, depth 1 pendente
    const plan = makeMiniRodadaPlan(1, ["mergeada", "mergeada"], ["mergeada", "pulada"], "done (depth 0)");
    assert.equal(cycleLabel(plan), "review 1.5b");
  });

  it("depth 1, finding-depth-1 esgotadas, review null → 'review 1.5b'", () => {
    // review pode ser null se plan.json não foi gravado com review de depth 0 (legado parcial)
    const plan = makeMiniRodadaPlan(1, ["mergeada"], ["mergeada"], null);
    assert.equal(cycleLabel(plan), "review 1.5b");
  });

  it("depth 1, review 'done (depth 1)' → NÃO é review 1.5b (já concluído)", () => {
    // Review 1.5b já concluído → cadeia encerra ou avança para depth 2
    const plan = makeMiniRodadaPlan(1, ["mergeada"], ["mergeada"], "done (depth 1)");
    assert.notEqual(cycleLabel(plan), "review 1.5b");
    assert.equal(cycleLabel(plan), "mini-rodada 1");
  });

  it("review 1.5b: barra exibe '· review 1.5b'", () => {
    const plan = makeMiniRodadaPlan(1, ["mergeada", "pulada"], ["mergeada", "draft-ci-vermelho"], "done (depth 0)");
    const bar = renderOvernightBar(plan);
    assert.ok(bar.includes("· review 1.5b"), `barra deve conter '· review 1.5b': ${bar}`);
  });
});

// #3071: `plan.review` gravado na prática costuma trazer texto explicativo
// ANEXADO após a tag canônica "done (depth N)" — igualdade estrita quebrava
// a detecção e prendia a barra em "review 1.5x" pra sempre mesmo com a rodada
// genuinamente encerrada (incidente real: data/overnight/260706/plan.json).
describe("cycleLabel — #3071: review com texto explicativo anexado (não é mais 'preso')", () => {
  it("depth 1, review 'done (depth 1) - texto explicativo extra' → NÃO é review 1.5b", () => {
    const plan = makeMiniRodadaPlan(
      1,
      ["mergeada"],
      ["mergeada"],
      "done (depth 1) - depth limit reached, cadeia encerrada. detalhes extras aqui.",
    );
    assert.notEqual(cycleLabel(plan), "review 1.5b");
    assert.equal(cycleLabel(plan), "mini-rodada 1");
  });

  it("depth 0, review legado 'done' + sufixo (ex: 'done pronto') → NÃO reconhece — legado exige igualdade EXATA, diferente do formato com depth que agora tolera sufixo (#3071)", () => {
    // Distingue de fato o comportamento (#3072 review — o teste anterior aqui
    // usava um input que falhava nos DOIS branches pelo mesmo motivo, sem
    // provar que o branch legado é estrito por design). "done pronto" é
    // estruturalmente análogo ao caso que o branch com depth agora tolera
    // ("done (depth N) - explicação"), mas pro formato legado (sem depth)
    // a igualdade EXATA `reviewValue === "done"` continua sendo exigida —
    // só "done" bare aciona o branch legado (ver teste "review:'done' (sem
    // depth)" mais abaixo).
    const plan = makeDepth0Plan(["mergeada", "pulada"], "done pronto", 0);
    assert.equal(cycleLabel(plan), "review 1.5");
  });
});

// #3072 (review do #3071): `includes` puro no branch "skipped:" era vulnerável
// a falso positivo quando o motivo livre menciona o depth de OUTRA rodada
// entre parênteses ANTES da tag real — corrigido pra casar pela ÚLTIMA
// ocorrência de "(depth N)" na string (`lastDepthTagMatches`), não qualquer uma.
// Lembrete de semântica (confirmado pelos testes pré-existentes "review skipped
// → 'fila principal'"/"done (depth 1) → NÃO é review 1.5b"): reviewDone=true
// (review já rodou/foi pulado pra este depth) NUNCA retorna "review 1.5x" —
// cai no fallback de fila ativa ("mini-rodada N" / "fila principal").
// "review 1.5x" só aparece quando reviewDone=false (review AINDA pendente).
describe("cycleLabel — #3072: 'skipped:' casa pela ÚLTIMA tag de depth, não qualquer ocorrência", () => {
  it("motivo livre menciona '(depth 1)' de outra rodada ANTES da tag real '(depth 2)' → depth 1 NÃO é dado como concluído (continua sinalizando review 1.5b pendente)", () => {
    const plan = makeMiniRodadaPlan(
      1,
      ["mergeada"],
      ["mergeada", "pulada"],
      "skipped: revisitando o achado registrado em (depth 1) durante o triage, decidiu-se nao reabrir (depth 2)",
    );
    // A tag real (a ÚLTIMA da string) é "(depth 2)" — não "(depth 1)", mesmo
    // aparecendo mais cedo no texto. Pro depth 1 (o depth desta rodada),
    // reviewDone deve ser false → allTerminal && !reviewDone → "review 1.5b"
    // (sinaliza CORRETAMENTE que o review consolidado do depth 1 ainda
    // precisa rodar). Com o bug antigo (`includes` sem âncora), a menção
    // incidental a "(depth 1)" no motivo faria reviewDone=true incorretamente,
    // mascarando essa pendência atrás de "mini-rodada 1".
    assert.equal(cycleLabel(plan), "review 1.5b");
  });

  it("última tag da string é a real: motivo menciona '(depth 0)' antes, tag final '(depth 1)' → reconhece review do depth 1 como concluído", () => {
    const plan = makeMiniRodadaPlan(
      1,
      ["mergeada"],
      ["mergeada", "pulada"],
      "skipped: mesma razao do (depth 0) anterior, sem novidade (depth 1)",
    );
    // Última tag = "(depth 1)" = o depth desta rodada → reviewDone=true →
    // cai no fallback de fila ativa (não "review 1.5b" — review já concluído).
    assert.notEqual(cycleLabel(plan), "review 1.5b");
    assert.equal(cycleLabel(plan), "mini-rodada 1");
  });

  it("caso real de produção (padrão de data/overnight/260623): motivo simples, 1 única tag de depth → continua reconhecendo review concluído", () => {
    const plan = makeMiniRodadaPlan(
      1,
      ["mergeada"],
      ["mergeada"],
      "skipped: diff trivial mini-rodada 1 (<50 linhas, 2 finding-fixes verdes) (depth 1)",
    );
    assert.notEqual(cycleLabel(plan), "review 1.5b");
    assert.equal(cycleLabel(plan), "mini-rodada 1");
  });
});

describe("cycleLabel — legado: plan.json sem findings_depth nem review", () => {
  it("plan legado sem findings_depth → treat como 0, issues ativas → 'fila principal'", () => {
    const plan: Plan = {
      started_at: "2026-06-01T22:00:00.000Z",
      issues: [
        { number: 1001, status: "elegivel" },
        { number: 1002, status: "elegivel" },
      ],
    };
    // findings_depth ausente → 0, review ausente → null, issues não terminais → fila principal
    assert.equal(cycleLabel(plan), "fila principal");
  });

  it("plan legado sem findings_depth, todas terminais → 'review 1.5' (review null implícito)", () => {
    // Plan legado sem findings_depth/review — todas terminais → review 1.5
    const plan: Plan = {
      started_at: "2026-06-01T22:00:00.000Z",
      issues: [
        { number: 1001, status: "mergeada" },
        { number: 1002, status: "pulada" },
      ],
    };
    assert.equal(cycleLabel(plan), "review 1.5");
  });

  it("plan legado com review: 'done' (sem depth) → trata como concluído no nível corrente → 'fila principal'", () => {
    // Legado: review "done" sem depth indicator → review concluído → não em review
    const plan: Plan = {
      started_at: "2026-06-01T22:00:00.000Z",
      review: "done",
      issues: [
        { number: 1001, status: "mergeada" },
        { number: 1002, status: "mergeada" },
      ],
    };
    assert.equal(cycleLabel(plan), "fila principal");
  });

  it("plan null → 'fila principal' (sem throw)", () => {
    assert.doesNotThrow(() => cycleLabel(null));
    assert.equal(cycleLabel(null), "fila principal");
  });

  it("plan undefined → 'fila principal' (sem throw)", () => {
    assert.doesNotThrow(() => cycleLabel(undefined));
    assert.equal(cycleLabel(undefined), "fila principal");
  });
});

describe("cycleLabel — formato do rótulo na barra renderOvernightBar (#2298)", () => {
  it("barra em progresso parcial inclui '· <ciclo>' no final", () => {
    const plan = makeDepth0Plan(["mergeada", "elegivel", "elegivel"]);
    const bar = renderOvernightBar(plan);
    // Formato: [bar] NN%  (X/Y)  · <ciclo>
    assert.match(bar, /^\[[█░]+\] \d+%  \(\d+\/\d+\)  · .+$/);
  });

  it("barra encerrada (100%) inclui '· <ciclo>' no final", () => {
    const plan = makeDepth0Plan(["mergeada", "mergeada"]);
    const bar = renderOvernightBar(plan);
    // Formato: [████████████] 100%  (N/N)  · <ciclo>
    assert.match(bar, /^\[█{12}\] 100%  \(\d+\/\d+\)  · .+$/);
  });

  it("barra null-plan → string vazia (sem rótulo, sem throw)", () => {
    assert.equal(renderOvernightBar(null), "");
    assert.equal(renderOvernightBar(undefined), "");
  });

  it("a adição do rótulo não altera a contagem nem o % (só appenda)", () => {
    const plan = makeDepth0Plan(["mergeada", "elegivel", "elegivel", "elegivel"]);
    const bar = renderOvernightBar(plan);
    assert.ok(bar.includes("25%"), `deve ter 25%: ${bar}`);
    assert.ok(bar.includes("(1/4)"), `deve ter (1/4): ${bar}`);
    assert.ok(bar.includes("· fila principal"), `deve ter rótulo: ${bar}`);
  });
});

describe("cycleLabel — review 1.5c (depth 2, finding-depth-2 esgotadas)", () => {
  it("depth 2, todas finding-depth-2 terminais, review 'done (depth 1)' → 'review 1.5c'", () => {
    // depth-2 bucket esgotado, review de depth 1 concluído, depth 2 pendente → review 1.5c
    const plan = makeMiniRodadaPlan(2, ["mergeada"], ["mergeada", "pulada"], "done (depth 1)");
    assert.equal(cycleLabel(plan), "review 1.5c");
  });

  it("depth 2, finding-depth-2 esgotadas, review null → 'review 1.5c'", () => {
    // review pode ser null quando plan.json não gravou o review de depth anterior
    const plan = makeMiniRodadaPlan(2, ["mergeada"], ["mergeada"], null);
    assert.equal(cycleLabel(plan), "review 1.5c");
  });

  it("review 1.5c: barra exibe '· review 1.5c'", () => {
    const plan = makeMiniRodadaPlan(2, ["mergeada"], ["mergeada"], "done (depth 1)");
    const bar = renderOvernightBar(plan);
    assert.ok(bar.includes("· review 1.5c"), `barra deve conter '· review 1.5c': ${bar}`);
  });
});

// ─── legado: plan.json sem findings_depth — renderOvernightBar completo (#2301) ─
// Confirma que plan.json legado (sem findings_depth nem review — gerado antes de
// #2298) não quebra o render e produz a barra correta end-to-end.

describe("renderOvernightBar — plan.json legado sem findings_depth (#2301)", () => {
  it("plan legado com issues ativas: bar parcial com rótulo '· fila principal'", () => {
    // Plan sem findings_depth nem review → legado pré-#2298
    const plan: Plan = {
      started_at: "2026-06-01T22:00:00.000Z",
      issues: [
        { number: 1001, status: "mergeada" } as Plan["issues"][0],
        { number: 1002, status: "elegivel" } as Plan["issues"][0],
        { number: 1003, status: "elegivel" } as Plan["issues"][0],
      ],
    };
    // findings_depth ausente → tratado como 0 → fila principal
    const bar = renderOvernightBar(plan);

    assert.ok(bar.length > 0, `legado com issues ativas deve produzir barra: ${bar}`);
    assert.ok(bar.includes("33%"), `legado 1/3 deve mostrar 33%: ${bar}`);
    assert.ok(bar.includes("(1/3)"), `legado deve mostrar (1/3): ${bar}`);
    assert.ok(bar.includes("· fila principal"), `legado deve mostrar '· fila principal': ${bar}`);
    // Formato: [bar] NN%  (X/Y)  · fila principal
    assert.match(bar, /^\[[█░]+\] \d+%  \(\d+\/\d+\)  · fila principal$/);
  });

  it("plan legado com todas terminais: bar 100% com rótulo '· review 1.5'", () => {
    // Todas terminais, review ausente → review 1.5 (aguardando revisão consolidada)
    const plan: Plan = {
      started_at: "2026-06-01T22:00:00.000Z",
      issues: [
        { number: 1001, status: "mergeada" } as Plan["issues"][0],
        { number: 1002, status: "pulada" } as Plan["issues"][0],
        { number: 1003, status: "draft-ci-vermelho" } as Plan["issues"][0],
      ],
    };
    const bar = renderOvernightBar(plan);

    assert.ok(bar.length > 0, `legado encerrado deve produzir barra visível: ${bar}`);
    assert.ok(bar.includes("100%"), `legado encerrado deve mostrar 100%: ${bar}`);
    assert.ok(bar.includes("(3/3)"), `legado encerrado deve mostrar (3/3): ${bar}`);
    assert.ok(bar.includes("· review 1.5"), `legado encerrado deve mostrar '· review 1.5': ${bar}`);
    // Formato: [████████████] 100%  (N/N)  · review 1.5
    assert.match(bar, /^\[█{12}\] 100%  \(\d+\/\d+\)  · review 1\.5(?!b|c)/);
  });

  it("plan legado com review:'done' (sem depth), 100%: bar mostra '· concluída' (#3071 — não 'fila principal', nada está ativo)", () => {
    // Plan legado: review 'done' sem indicador de depth → concluído no nível atual → não em review.
    // cycleLabel() isolado ainda retorna 'fila principal' (fallback de fila ativa) — mas a 100%,
    // renderOvernightBar substitui esse fallback por 'concluída' (#3071: nada está rodando).
    const plan: Plan = {
      started_at: "2026-06-01T22:00:00.000Z",
      review: "done",
      issues: [
        { number: 1001, status: "mergeada" } as Plan["issues"][0],
        { number: 1002, status: "mergeada" } as Plan["issues"][0],
      ],
    };
    assert.equal(cycleLabel(plan), "fila principal"); // cycleLabel isolado é inalterado
    const bar = renderOvernightBar(plan);

    assert.ok(bar.includes("100%"), `legado com review:done deve mostrar 100%: ${bar}`);
    assert.ok(bar.includes("· concluída"), `review:done concluído a 100% deve mostrar '· concluída': ${bar}`);
  });
});

// #3071: a 100%, o fallback de "fila ativa" (fila principal/mini-rodada N) nunca é
// um estado real — substituído por 'concluída'. "review 1.5x" continua intacto
// (fila esgotada mas review consolidado do depth ainda não rodou é sinal útil).
describe("renderOvernightBar — #3071: rótulo 'concluída' substitui fallback de fila ativa a 100%", () => {
  it("100% + review done (com sufixo explicativo) → '· concluída', não '· mini-rodada N'", () => {
    // Reproduz o incidente real: data/overnight/260706/plan.json
    const plan = makeMiniRodadaPlan(
      2,
      ["mergeada", "mergeada"],
      ["mergeada", "elegivel_especial"],
      "done (depth 2) - depth limit reached, cadeia encerrada. texto explicativo extra.",
    );
    const bar = renderOvernightBar(plan);
    assert.ok(bar.includes("100%"), `deve bater 100% com EPIC deferido terminal: ${bar}`);
    assert.ok(bar.includes("· concluída"), `deve mostrar 'concluída', não 'mini-rodada 2': ${bar}`);
    assert.ok(!bar.includes("mini-rodada"), `não deve mais mostrar 'mini-rodada': ${bar}`);
  });

  it("100% mas review ainda não rodou → mantém '· review 1.5x' (sinal útil, não vira 'concluída')", () => {
    const plan = makeDepth0Plan(["mergeada", "mergeada", "pulada"], null, 0);
    const bar = renderOvernightBar(plan);
    assert.ok(bar.includes("100%"), `deve bater 100%: ${bar}`);
    assert.match(bar, /· review 1\.5(?!b|c)/, `review pendente deve preservar 'review 1.5': ${bar}`);
  });
});
