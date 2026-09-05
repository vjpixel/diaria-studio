/**
 * overnight-plan-briefing.test.ts (#7497)
 *
 * Cobre o cenário real que motivou a issue: um `plan.json` cujo campo
 * `briefing` deixa `asked: false` sem causa legítima (`reason:
 * "desconhecido"`) precisa ser sinalizado (`isSuspiciousMissingBriefing`),
 * enquanto os 3 caminhos de fallback legítimos (`dry-run`, `plano-legado`,
 * `sem-editor-presente`) e o caso normal (`asked: true`/`reason: "asked"`)
 * validam sem problema. Também cobre o plano legado (campo `briefing`
 * ausente inteiramente) como fail-open, e as inconsistências de formato
 * que o gate deve rejeitar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OVERNIGHT_BRIEFING_REASONS,
  isOvernightBriefingReason,
  checkOvernightPlanBriefingFromRoot,
  isSuspiciousMissingBriefing,
  type OvernightPlanRootLike,
} from "../scripts/lib/overnight-plan-briefing.ts";

describe("OVERNIGHT_BRIEFING_REASONS", () => {
  it("inclui os 5 valores do vocabulário fechado", () => {
    for (const reason of ["asked", "dry-run", "plano-legado", "sem-editor-presente", "desconhecido"]) {
      assert.ok(isOvernightBriefingReason(reason), `"${reason}" deveria estar no vocabulário`);
    }
  });

  it("rejeita um reason inventado/typo", () => {
    assert.equal(isOvernightBriefingReason("sem-perguntas"), false);
    assert.equal(isOvernightBriefingReason(""), false);
  });

  it("não tem duplicatas", () => {
    assert.equal(new Set(OVERNIGHT_BRIEFING_REASONS).size, OVERNIGHT_BRIEFING_REASONS.length);
  });
});

describe("checkOvernightPlanBriefingFromRoot", () => {
  it("plano legado (campo briefing ausente) é fail-open", () => {
    const plan: OvernightPlanRootLike = { started_at: "2026-07-21T14:34:00Z" };
    assert.deepEqual(checkOvernightPlanBriefingFromRoot(plan), { status: "ok", present: false });
  });

  it("cenário real 260905: reason legítimo (sem-editor-presente) valida", () => {
    const plan: OvernightPlanRootLike = {
      machine_id: "helios",
      briefing: {
        asked: false,
        reason: "sem-editor-presente",
        precisa_resposta_count: 0,
        loop_estendido_asked: false,
        batch_approval_asked: false,
      },
    };
    assert.deepEqual(checkOvernightPlanBriefingFromRoot(plan), { status: "ok", present: true });
    assert.equal(isSuspiciousMissingBriefing(plan), false);
  });

  it("asked: true com reason: asked valida", () => {
    const plan: OvernightPlanRootLike = {
      briefing: { asked: true, reason: "asked", precisa_resposta_count: 2 },
    };
    assert.deepEqual(checkOvernightPlanBriefingFromRoot(plan), { status: "ok", present: true });
  });

  it("dry-run e plano-legado também validam", () => {
    for (const reason of ["dry-run", "plano-legado"] as const) {
      const plan: OvernightPlanRootLike = { briefing: { asked: false, reason } };
      assert.deepEqual(checkOvernightPlanBriefingFromRoot(plan), { status: "ok", present: true });
    }
  });

  it("reason fora do vocabulário é rejeitado", () => {
    const plan: OvernightPlanRootLike = { briefing: { asked: false, reason: "sem-perguntas" } };
    const result = checkOvernightPlanBriefingFromRoot(plan);
    assert.equal(result.status, "invalid");
  });

  it("asked ausente/não-boolean é rejeitado", () => {
    const plan: OvernightPlanRootLike = { briefing: { reason: "asked" } };
    const result = checkOvernightPlanBriefingFromRoot(plan);
    assert.equal(result.status, "invalid");
  });

  it("asked/reason inconsistentes entre si são rejeitados", () => {
    const askedTrueWrongReason: OvernightPlanRootLike = {
      briefing: { asked: true, reason: "sem-editor-presente" },
    };
    assert.equal(checkOvernightPlanBriefingFromRoot(askedTrueWrongReason).status, "invalid");

    const askedFalseReasonAsked: OvernightPlanRootLike = {
      briefing: { asked: false, reason: "asked" },
    };
    assert.equal(checkOvernightPlanBriefingFromRoot(askedFalseReasonAsked).status, "invalid");
  });

  it("briefing não-objeto é rejeitado", () => {
    const plan: OvernightPlanRootLike = { briefing: "sim" };
    const result = checkOvernightPlanBriefingFromRoot(plan);
    assert.equal(result.status, "invalid");
  });

  it("reason não-string (número/null) é rejeitado", () => {
    for (const reason of [42, null] as const) {
      const plan: OvernightPlanRootLike = { briefing: { asked: false, reason } };
      assert.equal(checkOvernightPlanBriefingFromRoot(plan).status, "invalid");
    }
  });

  it("precisa_resposta_count inválido (negativo/não-número) é rejeitado", () => {
    for (const count of [-1, "2", Number.NaN] as const) {
      const plan: OvernightPlanRootLike = {
        briefing: { asked: true, reason: "asked", precisa_resposta_count: count },
      };
      assert.equal(checkOvernightPlanBriefingFromRoot(plan).status, "invalid");
    }
  });

  it("precisa_resposta_count omitido não é erro (campo opcional)", () => {
    const plan: OvernightPlanRootLike = { briefing: { asked: true, reason: "asked" } };
    assert.deepEqual(checkOvernightPlanBriefingFromRoot(plan), { status: "ok", present: true });
  });

  it("loop_estendido_asked/batch_approval_asked não-boolean são rejeitados", () => {
    for (const field of ["loop_estendido_asked", "batch_approval_asked"] as const) {
      const plan: OvernightPlanRootLike = {
        briefing: { asked: true, reason: "asked", [field]: "sim" },
      };
      assert.equal(checkOvernightPlanBriefingFromRoot(plan).status, "invalid");
    }
  });
});

describe("isSuspiciousMissingBriefing", () => {
  it("true só quando asked=false E reason=desconhecido — o cenário (b) da issue", () => {
    assert.equal(
      isSuspiciousMissingBriefing({ briefing: { asked: false, reason: "desconhecido" } }),
      true,
    );
  });

  it("false para os 3 fallbacks legítimos e para o caso normal", () => {
    assert.equal(isSuspiciousMissingBriefing({ briefing: { asked: false, reason: "dry-run" } }), false);
    assert.equal(
      isSuspiciousMissingBriefing({ briefing: { asked: false, reason: "plano-legado" } }),
      false,
    );
    assert.equal(
      isSuspiciousMissingBriefing({ briefing: { asked: false, reason: "sem-editor-presente" } }),
      false,
    );
    assert.equal(isSuspiciousMissingBriefing({ briefing: { asked: true, reason: "asked" } }), false);
  });

  it("false quando o plano não tem briefing nenhum (legado)", () => {
    assert.equal(isSuspiciousMissingBriefing({}), false);
  });
});
