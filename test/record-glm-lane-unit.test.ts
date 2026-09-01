import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeUnitCostUsd, parseCreditsSnapshot } from "../scripts/record-glm-lane-unit.ts";

describe("computeUnitCostUsd (#6930)", () => {
  it("delta positivo normal → custo = depois - antes", () => {
    const cost = computeUnitCostUsd({ ok: true, totalUsageUsd: 10 }, { ok: true, totalUsageUsd: 10.5 });
    assert.equal(cost, 0.5);
  });

  it("snapshot 'before' com ok:false → null, nunca 0 fabricado", () => {
    const cost = computeUnitCostUsd({ ok: false }, { ok: true, totalUsageUsd: 10.5 });
    assert.equal(cost, null);
  });

  it("snapshot 'after' com ok:false → null", () => {
    const cost = computeUnitCostUsd({ ok: true, totalUsageUsd: 10 }, { ok: false });
    assert.equal(cost, null);
  });

  it("delta negativo (créditos recarregados no meio) → null, nunca número sem sentido", () => {
    const cost = computeUnitCostUsd({ ok: true, totalUsageUsd: 10 }, { ok: true, totalUsageUsd: 9 });
    assert.equal(cost, null);
  });

  it("delta zero → 0 é um valor legítimo (unidade sem custo detectável)", () => {
    const cost = computeUnitCostUsd({ ok: true, totalUsageUsd: 10 }, { ok: true, totalUsageUsd: 10 });
    assert.equal(cost, 0);
  });

  it("totalUsageUsd ausente em algum dos dois → null", () => {
    const cost = computeUnitCostUsd({ ok: true }, { ok: true, totalUsageUsd: 10 });
    assert.equal(cost, null);
  });
});

describe("parseCreditsSnapshot (#6930)", () => {
  it("JSON válido com ok:true → parseia normalmente", () => {
    const snapshot = parseCreditsSnapshot('{"ok":true,"totalUsageUsd":5}');
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.totalUsageUsd, 5);
  });

  it("JSON válido com ok:false → parseia normalmente (warning preservado)", () => {
    const snapshot = parseCreditsSnapshot('{"ok":false,"warning":"chave ausente"}');
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.warning, "chave ausente");
  });

  it("JSON malformado → ok:false, nunca lança", () => {
    assert.doesNotThrow(() => {
      const snapshot = parseCreditsSnapshot("não é json{{{");
      assert.equal(snapshot.ok, false);
    });
  });

  it("JSON sem campo 'ok' → ok:false (nunca assume true por omissão)", () => {
    const snapshot = parseCreditsSnapshot('{"totalUsageUsd":5}');
    assert.equal(snapshot.ok, false);
  });

  it("string vazia → ok:false, nunca lança", () => {
    const snapshot = parseCreditsSnapshot("");
    assert.equal(snapshot.ok, false);
  });
});
