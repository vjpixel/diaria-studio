/**
 * test/statusline-develop-concluded-3541.test.ts (#3541)
 *
 * bug(statusline): develop concluído sequestra a barra sobre overnight ativo
 * mais recente (mesmo dia).
 *
 * Root cause: em `renderStatusline`, `developBar` suprimia `overnightBar`
 * INCONDICIONALMENTE (`editionBar ? "" : renderDevelopBar(developEntry)`).
 * Diferente das edições, que têm o guard `mostRecentEditionEncerrada` (#2618)
 * pra sumir quando concluídas, não existia guard análogo pra develop
 * concluído — um `plan.json` de develop com todas issues terminais (5/5)
 * continuava renderizando 100% pra sempre, escondendo um overnight mais
 * recente e genuinamente ativo no mesmo dia (achado ao vivo 260716).
 *
 * Fix escolhido: guard de conclusão (`isPlanConcluded`), não recência via
 * mtime. `developBar` só é suprimido quando (a) develop concluiu E (b) existe
 * um overnight ATIVO (não vazio, não também concluído) pra assumir o
 * display — preservando o comportamento pré-#3541 em todos os outros casos
 * (develop ativo sempre vence; develop concluído sem overnight ativo mostra
 * sua própria barra em 100%, #2246 pt3).
 *
 * Coberturas obrigatórias (#633, ver issue):
 *   (a) develop concluído (5/5 terminal) + overnight ATIVO mesmo dia → barra
 *       mostra OVERNIGHT, não o develop 100%.
 *   (b) inverso: overnight concluído + develop ATIVO → mostra develop
 *       (já era o comportamento correto — cobertura de regressão).
 *   (c) develop ATIVO + overnight (qualquer estado) → ainda mostra develop —
 *       precedência develop > overnight preservada, guard não deve disparar
 *       quando develop não está concluído.
 *   + `isPlanConcluded` como função pura isolada (null/malformado/vazio/parcial/completo).
 *   + edge case: develop concluído + overnight TAMBÉM concluído → develop
 *     continua vencendo (comportamento pré-#3541, não regride).
 *   + edge case: develop concluído + overnight ausente (null) → develop
 *     mostra sua barra 100% (não desaparece).
 *
 * ATUALIZAÇÃO (#3590, 260716): os 2 edge cases acima ("develop concluído mostra 100%")
 * foram revisados pelo editor — rodada concluída agora SOME em vez de travar em 100%.
 * As asserções desses 2 casos foram atualizadas na seção "edge cases de preservação"
 * abaixo; os demais casos (a)/(b)/(c) — envolvendo overnight ou develop ATIVO — não
 * mudaram. Ver test/statusline-concluded-hides-3590.test.ts pra cobertura dedicada do #3590.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderStatusline,
  renderDevelopBar,
  renderOvernightBar,
  isPlanConcluded,
  type Plan,
  type DevelopPlanEntry,
} from "../scripts/overnight-statusline.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeConcludedDevelopPlan(n: number): Plan {
  return {
    issues: Array.from({ length: n }, () => ({ status: "mergeada" as const })),
  };
}

function makeActiveDevelopPlan(): Plan {
  return {
    issues: [
      { status: "mergeada" },
      { status: "mergeada" },
      { status: "elegivel" }, // não-terminal → ativa
    ],
  };
}

function makeActiveOvernightPlan(): Plan {
  return {
    issues: [
      { status: "mergeada" },
      { status: "elegivel" },
    ],
  };
}

function makeConcludedOvernightPlan(): Plan {
  return {
    issues: [{ status: "mergeada" }, { status: "pulada" }],
  };
}

// ─── isPlanConcluded — função pura ─────────────────────────────────────────────

describe("isPlanConcluded — função pura (#3541)", () => {
  it("null/undefined → false", () => {
    assert.equal(isPlanConcluded(null), false);
    assert.equal(isPlanConcluded(undefined), false);
  });

  it("plan.issues ausente/não-array → false, sem throw", () => {
    assert.doesNotThrow(() => isPlanConcluded({} as Plan));
    assert.equal(isPlanConcluded({} as Plan), false);
    assert.equal(isPlanConcluded({ issues: "not-an-array" } as unknown as Plan), false);
  });

  it("issues vazio → false (fila não iniciada, não é 'concluída')", () => {
    assert.equal(isPlanConcluded({ issues: [] }), false);
  });

  it("todas issues terminais (5/5 mergeada) → true", () => {
    assert.equal(isPlanConcluded(makeConcludedDevelopPlan(5)), true);
  });

  it("issues parcialmente terminais (2/3) → false", () => {
    assert.equal(isPlanConcluded(makeActiveDevelopPlan()), false);
  });

  it("mix de status terminais (mergeada/pulada/draft-ci-vermelho) todos terminais → true", () => {
    const plan: Plan = {
      issues: [
        { status: "mergeada" },
        { status: "pulada" },
        { status: "draft-ci-vermelho" },
      ],
    };
    assert.equal(isPlanConcluded(plan), true);
  });

  it("#3131: issues com in_round:false são excluídas do cálculo (não contam nem no total nem no done)", () => {
    const plan: Plan = {
      issues: [
        { status: "mergeada", in_round: true },
        { status: "bloqueada-externa", in_round: false }, // excluída — não impede conclusão
      ],
    };
    assert.equal(isPlanConcluded(plan), true, "issue fora do round não deve impedir a conclusão");
  });

  it("#3131: só issues com in_round:false → issues relevantes vazias → false", () => {
    const plan: Plan = {
      issues: [{ status: "bloqueada-externa", in_round: false }],
    };
    assert.equal(isPlanConcluded(plan), false);
  });
});

// ─── (a) develop concluído + overnight ATIVO mesmo dia → mostra OVERNIGHT ─────

describe("renderStatusline — #3541 (a): develop concluído (5/5) + overnight ATIVO mesmo dia → mostra OVERNIGHT", () => {
  it("repro exato da issue: develop 260716 100% (5/5) vs overnight 260716 ativo → overnight vence", () => {
    const developPlan = makeConcludedDevelopPlan(5);
    const developEntry: DevelopPlanEntry = { id: "260716", plan: developPlan };
    const overnightPlan = makeActiveOvernightPlan();

    const result = renderStatusline(
      null,           // sem edição em curso
      overnightPlan,  // overnight ativo
      null,
      null,
      "master",
      developEntry,   // develop concluído
    );

    assert.ok(!result.includes("develop 260716"), `NÃO deve mostrar develop concluído: "${result}"`);
    assert.ok(!result.includes("100%"), `NÃO deve mostrar o 100% do develop: "${result}"`);
    assert.ok(result.includes("50%"), `deve mostrar o progresso overnight (1/2 = 50%): "${result}"`);
    assert.ok(result.includes("(1/2)"), `deve mostrar (1/2) do overnight: "${result}"`);
  });

  it("develop concluído com 8/8 (achado real do repro) + overnight parcial 2/6 → overnight vence", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeConcludedDevelopPlan(8) };
    const overnightPlan: Plan = {
      issues: [
        { status: "mergeada" },
        { status: "mergeada" },
        { status: "elegivel" },
        { status: "elegivel" },
        { status: "precisa-resposta" },
        { status: "elegivel" },
      ],
    };

    const result = renderStatusline(null, overnightPlan, null, null, "master", developEntry);

    assert.ok(!result.includes("develop"), `develop não deve aparecer: "${result}"`);
    assert.ok(result.includes("(2/6)"), `deve mostrar progresso overnight (2/6): "${result}"`);
  });
});

// ─── (b) inverso: overnight concluído + develop ATIVO → mostra develop (regressão) ─

describe("renderStatusline — #3541 (b): overnight concluído + develop ATIVO → mostra develop (sem regressão)", () => {
  it("overnight 100% concluído + develop ativo (2/3) → develop vence", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeActiveDevelopPlan() };
    const overnightPlan = makeConcludedOvernightPlan();

    const result = renderStatusline(null, overnightPlan, null, null, "master", developEntry);

    assert.ok(result.includes("develop 260716"), `deve mostrar o develop ativo: "${result}"`);
    assert.ok(!result.includes("100%"), `não deve mostrar o overnight concluído (100%): "${result}"`);
  });
});

// ─── (c) develop ATIVO + overnight (qualquer estado) → develop continua vencendo ──

describe("renderStatusline — #3541 (c): develop ATIVO + overnight → precedência develop > overnight preservada", () => {
  it("develop ativo + overnight ativo → develop vence (guard não dispara quando develop não concluiu)", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeActiveDevelopPlan() };
    const overnightPlan = makeActiveOvernightPlan();

    const result = renderStatusline(null, overnightPlan, null, null, "master", developEntry);

    assert.ok(result.includes("develop 260716"), `develop ativo deve vencer: "${result}"`);
    assert.ok(!result.includes("50%"), `overnight não deve aparecer: "${result}"`);
  });

  it("develop ativo + overnight AUSENTE (null) → develop vence (comportamento pré-#3541)", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeActiveDevelopPlan() };

    const result = renderStatusline(null, null, null, null, "master", developEntry);

    assert.ok(result.includes("develop 260716"), `develop deve aparecer sem overnight: "${result}"`);
  });

  it("develop ativo + overnight TAMBÉM concluído → develop vence (guard exige overnight ATIVO, não só presente)", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeActiveDevelopPlan() };
    const overnightPlan = makeConcludedOvernightPlan();

    const result = renderStatusline(null, overnightPlan, null, null, "master", developEntry);

    assert.ok(result.includes("develop 260716"), `develop ativo deve vencer mesmo com overnight concluído: "${result}"`);
  });
});

// ─── edge cases adicionais de preservação de comportamento pré-#3541 ──────────

describe("renderStatusline — #3541: edge cases de preservação (develop concluído sem overnight ativo)", () => {
  // #3590 revisou este comportamento: um develop CONCLUÍDO agora SOME (cai pro fallback
  // idle/vazio) em vez de travar em 100% pra sempre — decisão de produto do editor
  // (achado ao vivo 260716), ver test/statusline-concluded-hides-3590.test.ts pra cobertura
  // dedicada. Os 2 casos abaixo foram atualizados de "develop concluído mostra 100%" pra
  // "develop concluído some" (mantidos aqui pra não perder a cobertura de regressão do
  // #3541 — overnight concluído junto não ressuscita o develop).
  it("#3590: develop concluído + overnight AUSENTE (null) → barra some (não trava em 100%)", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeConcludedDevelopPlan(5) };

    const result = renderStatusline(null, null, null, null, "master", developEntry);

    // Sem edição no disco, o fallback (#2618) é o idle bar padrão, não string vazia —
    // o ponto testado é que o develop concluído não trava mais em 100%.
    assert.ok(!result.includes("develop"), `develop concluído deve sumir: "${result}"`);
    assert.ok(!result.includes("100%"), `NÃO deve travar em 100%: "${result}"`);
  });

  it("#3590: develop concluído + overnight TAMBÉM concluído → barra some (nenhum dos dois trava em 100%)", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeConcludedDevelopPlan(5) };
    const overnightPlan = makeConcludedOvernightPlan();

    const result = renderStatusline(null, overnightPlan, null, null, "master", developEntry);

    assert.ok(!result.includes("develop"), `develop concluído deve sumir: "${result}"`);
    assert.ok(!result.includes("100%"), `NÃO deve travar em 100%: "${result}"`);
  });

  it("edição em curso tem precedência máxima mesmo com develop concluído + overnight ativo", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeConcludedDevelopPlan(5) };
    const overnightPlan = makeActiveOvernightPlan();
    const editionDoc = {
      edition: "260717",
      rows: [
        { stage: 0, status: "done" as const },
        { stage: 1, status: "running" as const },
        { stage: 2, status: "pending" as const },
        { stage: 3, status: "pending" as const },
        { stage: 4, status: "pending" as const },
        { stage: 5, status: "pending" as const },
        { stage: 6, status: "pending" as const },
      ],
      generated_at: "2026-07-17T09:00:00.000Z",
    };

    const result = renderStatusline(editionDoc, overnightPlan, "260717", editionDoc, "master", developEntry);

    assert.ok(result.includes("edição 260717"), `edição em curso deve ter precedência máxima: "${result}"`);
    assert.ok(!result.includes("develop"), `develop não deve aparecer: "${result}"`);
    assert.ok(!result.includes("50%"), `overnight não deve aparecer: "${result}"`);
  });

  it("renderStatusline é pura — chamadas repetidas com os mesmos inputs produzem o mesmo resultado", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeConcludedDevelopPlan(5) };
    const overnightPlan = makeActiveOvernightPlan();
    const args: Parameters<typeof renderStatusline> = [null, overnightPlan, null, null, "master", developEntry];

    const r1 = renderStatusline(...args);
    const r2 = renderStatusline(...args);
    assert.equal(r1, r2, "função pura deve ser idempotente");
  });
});

// ─── sanity: renderDevelopBar / renderOvernightBar isoladas continuam corretas ─
// (guard vive em renderStatusline, não nos renderizadores individuais — confirma
// que eles continuam produzindo a saída completa quando chamados diretamente,
// só a COMPOSIÇÃO em renderStatusline é que decide qual mostrar.)

describe("renderStatusline — #3541: renderDevelopBar/renderOvernightBar isoladas não mudaram", () => {
  it("renderDevelopBar(developEntry concluído) continua retornando a barra 100% quando chamada direta", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeConcludedDevelopPlan(5) };
    const bar = renderDevelopBar(developEntry);
    assert.ok(bar.includes("100%"), `renderDevelopBar isolada deve continuar mostrando 100%: "${bar}"`);
    assert.ok(bar.includes("develop 260716"), `deve incluir o id: "${bar}"`);
  });

  it("renderOvernightBar(plan ativo) continua retornando a barra parcial quando chamada direta", () => {
    const bar = renderOvernightBar(makeActiveOvernightPlan());
    assert.ok(bar.includes("50%"), `renderOvernightBar isolada deve continuar mostrando 50%: "${bar}"`);
  });
});
