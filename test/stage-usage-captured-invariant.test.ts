/**
 * test/stage-usage-captured-invariant.test.ts (#5475)
 *
 * Cobre o invariant `stage-usage-captured` em STAGE_5_RULES — o caso EXATO
 * da issue #5475 (edição 260817): `capture-stage-usage.ts` roda no §5h,
 * falha em resolver o transcript da sessão (`source: "unavailable"`), sai
 * com exit 0 sem escrever `cost_usd`/`tokens_in`, e nada avisa — o stage
 * fica marcado `done` com custo/tokens ausentes, indistinguível de "custou
 * zero" no `stage-status.md` renderizado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  checkStageUsageCaptured,
  STAGE_5_RULES,
} from "../scripts/lib/invariant-checks/stage-5.ts";
import { makeInitialDoc, applyUpdate, saveDoc } from "../scripts/update-stage-status.ts";
import { makeEditionDir } from "./_helpers/make-edition-dir.ts";

describe("stage-usage-captured registrado em STAGE_5_RULES (#5475)", () => {
  it("rule presente, severity warning (nunca bloqueia), postDispatchOnly", () => {
    const rule = STAGE_5_RULES.find((r) => r.id === "stage-usage-captured");
    assert.ok(rule, "stage-usage-captured deve estar em STAGE_5_RULES");
    assert.equal(rule?.stage, 5);
    // Só faz sentido depois que §5h (fim do dispatch) já rodou — em
    // pre-dispatch o stage nem começou, então checar ali daria falso-positivo
    // sempre.
    assert.equal(rule?.postDispatchOnly, true);
  });
});

describe("checkStageUsageCaptured (#5475 — regressão do incidente 260817)", () => {
  it("REGRESSÃO: stage 5 done sem cost_usd/tokens_in → warning explícito", () => {
    const dir = makeEditionDir("stage-usage-captured-invariant-");
    try {
      const doc = makeInitialDoc("260817");
      const updated = applyUpdate(
        doc,
        {
          stage: 5,
          status: "done",
          start: "2026-08-17T08:00:00Z",
          end: "2026-08-17T09:00:00Z",
          // cost_usd/tokens_in NÃO passados — reproduz capture-stage-usage.ts
          // retornando source:"unavailable" sem escrever nada.
        },
        "2026-08-17T09:00:00Z",
      );
      saveDoc(dir, updated);

      const violations = checkStageUsageCaptured(dir);
      assert.equal(violations.length, 1);
      const v = violations[0];
      assert.equal(v.rule, "stage-usage-captured");
      assert.equal(v.severity, "warning");
      assert.equal(v.source_issue, "#5475");
      assert.match(v.message, /cost_usd|tokens_in/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stage 5 done COM cost_usd/tokens_in populados → sem violação", () => {
    const dir = makeEditionDir("stage-usage-captured-invariant-ok-");
    try {
      const doc = makeInitialDoc("260814");
      const updated = applyUpdate(
        doc,
        {
          stage: 5,
          status: "done",
          start: "2026-08-14T08:00:00Z",
          end: "2026-08-14T09:00:00Z",
          cost_usd: 53.487,
          tokens_in: 173_710_000,
          tokens_out: 500_000,
        },
        "2026-08-14T09:00:00Z",
      );
      saveDoc(dir, updated);

      const violations = checkStageUsageCaptured(dir);
      assert.deepEqual(violations, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stage 5 ainda não done (running/pending) → sem violação (não é falso-positivo pre-dispatch)", () => {
    const dir = makeEditionDir("stage-usage-captured-invariant-pending-");
    try {
      const doc = makeInitialDoc("260818");
      saveDoc(dir, doc); // todos os stages pending, nenhum start/end

      const violations = checkStageUsageCaptured(dir);
      assert.deepEqual(violations, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stage-status.json ausente → sem violação (fail-soft, não fabrica warning sem dado)", () => {
    const dir = makeEditionDir("stage-usage-captured-invariant-missing-");
    try {
      const violations = checkStageUsageCaptured(dir);
      assert.deepEqual(violations, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
