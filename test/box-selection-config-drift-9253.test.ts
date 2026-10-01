/**
 * #9253: trocar `boxes_divulgacao.slotN` no config depois do stitch não tinha
 * efeito nem aviso — `box-selection.json` congelado vencia em silêncio (caso
 * real 261001: slot 1 seguia em workshop-agente-ia-outubro.md).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBoxSelectionConfigDrift } from "../scripts/lib/box-selection-drift.ts";
import { checkBoxSelectionConfigDrift, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

const rec = (slot: number, mode: string, file: string | null, extra: Record<string, unknown> = {}) => ({
  slot, mode, file, nome: null, score: null, trend: null, editionsAppeared: null, seasonal: null, ...extra,
});

describe("detectBoxSelectionConfigDrift (#9253)", () => {
  it("config trocado depois do stitch (modo disabled) → drift no slot", () => {
    const sel = [rec(1, "disabled", "workshop-agente-ia-outubro.md"), rec(2, "disabled", "livro.md"), rec(3, "disabled", null)];
    const d = detectBoxSelectionConfigDrift(sel, { slot1: "novo-box.md", slot2: "livro.md" });
    assert.deepEqual(d, [{ slot: 1, selectionFile: "workshop-agente-ia-outubro.md", configFile: "novo-box.md", mode: "disabled" }]);
  });

  it("pinned e fallback-no-candidates também comparam com o config", () => {
    const sel = [rec(1, "pinned", "a.md"), rec(2, "fallback-no-candidates", "b.md")];
    assert.equal(detectBoxSelectionConfigDrift(sel, { slot1: "x.md", slot2: "y.md" }).length, 2);
    assert.equal(detectBoxSelectionConfigDrift(sel, { slot1: "a.md", slot2: "b.md" }).length, 0);
  });

  it("fallback-ineligible compara o rejectedFile", () => {
    const sel = [rec(1, "fallback-ineligible", null, { rejectedFile: "velho.md" })];
    assert.equal(detectBoxSelectionConfigDrift(sel, { slot1: "velho.md" }).length, 0);
    assert.equal(detectBoxSelectionConfigDrift(sel, { slot1: "novo.md" }).length, 1);
  });

  it("auto e manual nunca são drift (divergem do config por definição)", () => {
    const sel = [rec(1, "auto", "por-cliques.md"), rec(2, "manual", "aplicado.md")];
    assert.deepEqual(detectBoxSelectionConfigDrift(sel, { slot1: "x.md", slot2: "y.md" }), []);
  });

  it("slot inativo (disabled, file null) não é drift; entrada malformada ignorada", () => {
    assert.deepEqual(detectBoxSelectionConfigDrift([rec(2, "disabled", null)], { slot2: "y.md" }), []);
    assert.deepEqual(detectBoxSelectionConfigDrift({ not: "array" }, {}), []);
  });

  it("#9319: slot vazio gravado pelo Studio como \"\" nos dois lados não é drift", () => {
    // pinned/fallback-no-candidates herdam `file: ""` do config (`?? null` mantém "").
    const sel = [rec(1, "pinned", "a.md"), rec(2, "pinned", ""), rec(2, "fallback-no-candidates", "")];
    assert.deepEqual(detectBoxSelectionConfigDrift(sel, { slot1: "a.md", slot2: "" }), []);
    // null de um lado e "" do outro também equivalem (ambos = sem caixa).
    assert.deepEqual(detectBoxSelectionConfigDrift([rec(2, "pinned", null)], { slot2: "" }), []);
  });

  it("#9319: config esvaziado (\"\") depois do stitch com box real congelado → drift com configFile null", () => {
    const d = detectBoxSelectionConfigDrift([rec(2, "pinned", "livro.md")], { slot2: "" });
    assert.deepEqual(d, [{ slot: 2, selectionFile: "livro.md", configFile: null, mode: "pinned" }]);
  });
});

describe("checkBoxSelectionConfigDrift — invariant do Stage 4 (#9253)", () => {
  it("emite warning com o comando apply-box-slot e está registrado em STAGE_4_RULES", () => {
    const root = mkdtempSync(join(tmpdir(), "drift-9253-"));
    try {
      const editionDir = join(root, "261001");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", "box-selection.json"),
        JSON.stringify([rec(1, "disabled", "workshop-agente-ia-outubro.md"), rec(2, "disabled", "livro.md")]),
      );
      writeFileSync(join(root, "platform.config.json"), JSON.stringify({ boxes_divulgacao: { slot1: "novo-box.md", slot2: "livro.md" } }));
      const v = checkBoxSelectionConfigDrift(editionDir, root);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "box-selection-config-drift");
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /apply-box-slot\.ts --edition 261001 --slot 1 --file novo-box\.md/);

      writeFileSync(join(root, "platform.config.json"), JSON.stringify({ boxes_divulgacao: { slot1: "workshop-agente-ia-outubro.md", slot2: "livro.md" } }));
      assert.deepEqual(checkBoxSelectionConfigDrift(editionDir, root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    assert.ok(STAGE_4_RULES.some((r) => r.id === "box-selection-config-drift"));
  });

  it("sem box-selection.json → nada", () => {
    const root = mkdtempSync(join(tmpdir(), "drift-9253-"));
    try {
      assert.deepEqual(checkBoxSelectionConfigDrift(root, root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
