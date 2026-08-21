/**
 * test/ads-test-run-state.test.ts (#5845)
 *
 * Lógica pura de `scripts/lib/ads-test-run-state.ts` — imutabilidade do
 * pré-registro do D0 (`planRunStateWrite`) + validação de forma.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAdsTestRunState,
  planRunStateWrite,
  assertValidRunState,
  ADS_TEST_2608_BRACOS,
  type AdsTestRunState,
} from "../scripts/lib/ads-test-run-state.ts";

const NOW_ISO = "2026-08-26T09:00:00.000Z";

describe("#5845 — ads-test-run-state: buildAdsTestRunState", () => {
  it("constrói o estado completo a partir do D0", () => {
    const state = buildAdsTestRunState("2026-08-26", NOW_ISO);
    assert.equal(state.d0, "2026-08-26");
    assert.equal(state.fim_janela, "2026-09-09");
    assert.equal(state.registrado_em, NOW_ISO);
    assert.deepEqual(state.bracos, ADS_TEST_2608_BRACOS);
  });
});

describe("#5845 — ads-test-run-state: planRunStateWrite (imutabilidade)", () => {
  const nextState = buildAdsTestRunState("2026-08-26", NOW_ISO);

  it("arquivo ainda não existe → grava direto", () => {
    const plan = planRunStateWrite(null, nextState, { force: false, reason: null, nowIso: NOW_ISO });
    assert.equal(plan.action, "write");
  });

  it("arquivo já existe, sem --force → recusa (imutabilidade default)", () => {
    const existing = buildAdsTestRunState("2026-08-20", "2026-08-20T00:00:00.000Z");
    const plan = planRunStateWrite(existing, nextState, { force: false, reason: null, nowIso: NOW_ISO });
    assert.equal(plan.action, "refuse-exists-no-force");
    if (plan.action === "refuse-exists-no-force") {
      assert.equal(plan.existing.d0, "2026-08-20");
    }
  });

  it("arquivo já existe, --force SEM reason → recusa (motivo obrigatório)", () => {
    const existing = buildAdsTestRunState("2026-08-20", "2026-08-20T00:00:00.000Z");
    const plan = planRunStateWrite(existing, nextState, { force: true, reason: null, nowIso: NOW_ISO });
    assert.equal(plan.action, "refuse-force-without-reason");
  });

  it("arquivo já existe, --force com reason em branco → recusa", () => {
    const existing = buildAdsTestRunState("2026-08-20", "2026-08-20T00:00:00.000Z");
    const plan = planRunStateWrite(existing, nextState, { force: true, reason: "   ", nowIso: NOW_ISO });
    assert.equal(plan.action, "refuse-force-without-reason");
  });

  it("arquivo já existe, --force COM reason → grava com histórico do estado anterior", () => {
    const existing = buildAdsTestRunState("2026-08-20", "2026-08-20T00:00:00.000Z");
    const plan = planRunStateWrite(existing, nextState, {
      force: true,
      reason: "D0 real adiado por aprovação de conta",
      nowIso: NOW_ISO,
    });
    assert.equal(plan.action, "write-with-history");
    if (plan.action === "write-with-history") {
      assert.equal(plan.state.d0, "2026-08-26");
      assert.equal(plan.historyEntry.previous_state.d0, "2026-08-20");
      assert.equal(plan.historyEntry.reason, "D0 real adiado por aprovação de conta");
      assert.equal(plan.historyEntry.overwritten_at, NOW_ISO);
    }
  });
});

describe("#5845 — ads-test-run-state: assertValidRunState", () => {
  it("aceita um AdsTestRunState válido", () => {
    const valid: AdsTestRunState = buildAdsTestRunState("2026-08-26", NOW_ISO);
    assert.doesNotThrow(() => assertValidRunState(valid));
  });

  it("rejeita null/undefined/não-objeto", () => {
    assert.throws(() => assertValidRunState(null));
    assert.throws(() => assertValidRunState(undefined));
    assert.throws(() => assertValidRunState("string"));
  });

  it("rejeita campo de data ausente", () => {
    const { d0: _d0, ...rest } = buildAdsTestRunState("2026-08-26", NOW_ISO);
    assert.throws(() => assertValidRunState(rest));
  });

  it("rejeita data malformada", () => {
    const state = { ...buildAdsTestRunState("2026-08-26", NOW_ISO), d0: "26/08/2026" };
    assert.throws(() => assertValidRunState(state));
  });

  it("rejeita bracos vazio", () => {
    const state = { ...buildAdsTestRunState("2026-08-26", NOW_ISO), bracos: [] };
    assert.throws(() => assertValidRunState(state));
  });

  it("rejeita registrado_em vazio", () => {
    const state = { ...buildAdsTestRunState("2026-08-26", NOW_ISO), registrado_em: "" };
    assert.throws(() => assertValidRunState(state));
  });
});
