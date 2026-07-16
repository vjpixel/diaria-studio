/**
 * test/statusline-concluded-hides-3590.test.ts (#3590)
 *
 * bug(statusline): rodada overnight/develop CONCLUÍDA fica congelada em 100%
 * em vez de sumir (follow-up direto do #3541).
 *
 * Root cause: o fix do #3541 adicionou `isPlanConcluded(plan)` e
 * `overnightIsActive`, mas:
 *   - o `overnightBar` NUNCA checava `isPlanConcluded(plan)` — um overnight
 *     concluído (todas issues terminais) continuava renderizando 100% pra
 *     sempre, diferente das edições, que têm o guard `mostRecentEditionEncerrada`
 *     (#2618) que faz a barra SUMIR quando concluídas.
 *   - o `developBar` só suprimia o develop concluído quando havia um overnight
 *     ATIVO pra assumir (`developConcluded && overnightIsActive`) — um develop
 *     concluído SOZINHO (sem overnight) continuava travado em 100%.
 *
 * Decisão de produto do editor (260716, achado ao vivo): rodada overnight/
 * develop CONCLUÍDA deve SUMIR da barra (cair pro fallback idle/vazio), NÃO
 * ficar congelada em 100%. Revisa o comportamento do #2246 pt3 ("rodada
 * encerrada fica visível") por feedback de que 100% preso confunde o editor.
 *
 * Fix em `renderStatusline`:
 *   1. `overnightBar` agora suprimido quando `isPlanConcluded(plan)`
 *      (`(editionBar || developBar || isPlanConcluded(plan)) ? "" : overnightBarCandidate`).
 *   2. `developSuppressed` agora é `editionBar !== "" || developConcluded` — não
 *      depende mais de `overnightIsActive`, então um develop concluído SOZINHO
 *      também some.
 *   3. Ambos caem pro fallback (idle/vazio, #2618); com os dois concluídos e
 *      sem edição no disco, a statusline retorna só o branch.
 *
 * Coberturas obrigatórias (#633, ver issue):
 *   (a) overnight concluído (terminal) SEM develop/edição → barra some (só o branch).
 *   (b) develop concluído SEM overnight → some.
 *   (c) ambos concluídos → some.
 *   (d) regressão: overnight ATIVO mostra; develop ATIVO mostra; edição em
 *       curso precede tudo.
 *   (e) #3541 preservado: develop-concluído + overnight-ATIVO → mostra o overnight.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderStatusline,
  isPlanConcluded,
  type Plan,
  type DevelopPlanEntry,
} from "../scripts/overnight-statusline.ts";

// ─── helpers (mesmo padrão de test/statusline-develop-concluded-3541.test.ts) ──

function makeConcludedPlan(n: number): Plan {
  return {
    issues: Array.from({ length: n }, () => ({ status: "mergeada" as const })),
  };
}

function makeActivePlan(): Plan {
  return {
    issues: [
      { status: "mergeada" },
      { status: "mergeada" },
      { status: "elegivel" }, // não-terminal → ativa
    ],
  };
}

function makeInProgressEditionDoc(edition: string) {
  return {
    edition,
    rows: [
      { stage: 0, status: "done" as const },
      { stage: 1, status: "running" as const },
      { stage: 2, status: "pending" as const },
      { stage: 3, status: "pending" as const },
      { stage: 4, status: "pending" as const },
      { stage: 5, status: "pending" as const },
      { stage: 6, status: "pending" as const },
    ],
    generated_at: "2026-07-16T09:00:00.000Z",
  };
}

// ─── (a) overnight concluído sozinho (sem develop/edição) → some ──────────────

// Nota: sem edição alguma no disco (mostRecentEditionId/mostRecentDoc null), o fallback
// (#2618, Source 5) é o idle bar padrão ("Diar.ia · sem rodada ativa"), não uma string
// vazia — string vazia só ocorre quando a edição MAIS RECENTE está encerrada (guard
// `mostRecentEditionEncerrada`). O ponto testado aqui é que o overnight/develop concluído
// NÃO aparece mais (nem 100%, nem contagem) — a barra "some" no sentido de ceder pro
// fallback, exatamente como a issue descreve ("cair pro idle/vazio").
const IDLE_NO_EDITION = "[████████████] Diar.ia · sem rodada ativa";

describe("renderStatusline — #3590 (a): overnight CONCLUÍDO sozinho (sem develop/edição) → barra some", () => {
  it("repro exato da issue: overnight 260716 17/17 terminal, sem develop/edição → cai pro idle, não trava em 100%", () => {
    const plan = makeConcludedPlan(17);

    const result = renderStatusline(null, plan, null, null, "master", null);

    assert.equal(result, `master  ${IDLE_NO_EDITION}`, `overnight concluído deve ceder pro idle: "${result}"`);
    assert.ok(!result.includes("17/17"), `NÃO deve mostrar (17/17): "${result}"`);
  });

  it("overnight concluído (2/2) com status mistos (mergeada/pulada) → some (cai pro idle)", () => {
    const plan: Plan = { issues: [{ status: "mergeada" }, { status: "pulada" }] };

    const result = renderStatusline(null, plan, null, null, "master", null);

    assert.equal(result, `master  ${IDLE_NO_EDITION}`, `overnight concluído deve sumir: "${result}"`);
  });
});

// ─── (b) develop concluído sozinho (sem overnight) → some ─────────────────────

describe("renderStatusline — #3590 (b): develop CONCLUÍDO sozinho (sem overnight) → barra some", () => {
  it("develop 260716 5/5 terminal, sem overnight (plan null) → cai pro idle, não trava em 100%", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeConcludedPlan(5) };

    const result = renderStatusline(null, null, null, null, "master", developEntry);

    assert.equal(result, `master  ${IDLE_NO_EDITION}`, `develop concluído deve ceder pro idle: "${result}"`);
    assert.ok(!result.includes("develop"), `NÃO deve mostrar a barra do develop: "${result}"`);
  });
});

// ─── (c) ambos concluídos → some ──────────────────────────────────────────────

describe("renderStatusline — #3590 (c): overnight CONCLUÍDO + develop CONCLUÍDO → ambos somem", () => {
  it("overnight 17/17 + develop 5/5, ambos terminais → cai pro idle, nenhum trava em 100%", () => {
    const overnightPlan = makeConcludedPlan(17);
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeConcludedPlan(5) };

    const result = renderStatusline(null, overnightPlan, null, null, "master", developEntry);

    assert.equal(result, `master  ${IDLE_NO_EDITION}`, `nenhum dos dois deve travar em 100%: "${result}"`);
    assert.ok(!result.includes("100%"), `NÃO deve mostrar 100%: "${result}"`);
  });
});

// ─── (d) regressão: overnight ATIVO / develop ATIVO / edição em curso ─────────

describe("renderStatusline — #3590 (d): regressão — ativo continua mostrando normalmente", () => {
  it("overnight ATIVO (não concluído), sem develop/edição → mostra a barra normalmente", () => {
    const plan = makeActivePlan();

    const result = renderStatusline(null, plan, null, null, "master", null);

    assert.ok(result.includes("(2/3)"), `overnight ativo deve mostrar progresso: "${result}"`);
    assert.ok(!result.includes("100%"), `overnight ativo (2/3) não deve mostrar 100%: "${result}"`);
  });

  it("develop ATIVO (não concluído), sem overnight → mostra a barra normalmente", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeActivePlan() };

    const result = renderStatusline(null, null, null, null, "master", developEntry);

    assert.ok(result.includes("develop 260716"), `develop ativo deve continuar visível: "${result}"`);
    assert.ok(result.includes("(2/3)"), `deve mostrar progresso do develop: "${result}"`);
  });

  it("edição EM CURSO tem precedência mesmo com overnight E develop concluídos", () => {
    const overnightPlan = makeConcludedPlan(17);
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeConcludedPlan(5) };
    const editionDoc = makeInProgressEditionDoc("260717");

    const result = renderStatusline(editionDoc, overnightPlan, "260717", editionDoc, "master", developEntry);

    assert.ok(result.includes("edição 260717"), `edição em curso deve ter precedência máxima: "${result}"`);
    assert.ok(!result.includes("develop"), `develop não deve aparecer: "${result}"`);
    assert.ok(!result.includes("17/17"), `overnight não deve aparecer: "${result}"`);
  });
});

// ─── (e) #3541 preservado: develop-concluído + overnight-ATIVO → mostra overnight ─

describe("renderStatusline — #3590 (e): #3541 preservado — develop concluído + overnight ATIVO → mostra o overnight", () => {
  it("develop 5/5 concluído + overnight ativo (1/2) mesmo dia → overnight assume a barra", () => {
    const developEntry: DevelopPlanEntry = { id: "260716", plan: makeConcludedPlan(5) };
    const overnightPlan = makeActivePlan();

    const result = renderStatusline(null, overnightPlan, null, null, "master", developEntry);

    assert.ok(!result.includes("develop 260716"), `develop concluído NÃO deve aparecer: "${result}"`);
    assert.ok(!result.includes("100%"), `NÃO deve mostrar o 100% do develop: "${result}"`);
    assert.ok(result.includes("(2/3)"), `deve mostrar o progresso do overnight ativo: "${result}"`);
  });
});

// ─── isPlanConcluded sanity (já coberta em detalhe no #3541, aqui só smoke) ───

describe("renderStatusline — #3590: isPlanConcluded como guard tanto pro overnight quanto pro develop", () => {
  it("isPlanConcluded aplicado ao mesmo `plan` que alimenta tanto overnightBar quanto o guard", () => {
    assert.equal(isPlanConcluded(makeConcludedPlan(1)), true);
    assert.equal(isPlanConcluded(makeActivePlan()), false);
    assert.equal(isPlanConcluded(null), false);
  });
});
