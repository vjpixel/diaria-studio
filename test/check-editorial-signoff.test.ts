/**
 * test/check-editorial-signoff.test.ts (#7978)
 *
 * Cobre scripts/check-editorial-signoff.ts::evaluateCalibrationTouch — a
 * parte pura da decisão "esse conjunto de arquivos mudados toca
 * calibração?", com provedores de linha/conteúdo injetados (sem git real).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateCalibrationTouch, SIGNOFF_LABEL } from "../scripts/check-editorial-signoff.ts";
import { CALIBRATION_ALLOWLIST } from "../scripts/lib/calibration-file-allowlist.ts";

describe("evaluateCalibrationTouch (#7978)", () => {
  it("diff sem nenhum arquivo da allowlist: não toca calibração", () => {
    const check = evaluateCalibrationTouch(
      ["scripts/random.ts", "README.md"],
      () => new Set([1, 2, 3]),
      () => "conteúdo qualquer",
    );
    assert.equal(check.touchesCalibration, false);
    assert.deepEqual(check.touchedPaths, []);
  });

  it("diff toca um ts-file da allowlist com linhas tocadas: toca calibração", () => {
    const tsPath = CALIBRATION_ALLOWLIST.find((e) => e.kind === "ts-file")!.path;
    const check = evaluateCalibrationTouch(
      [tsPath, "scripts/outro.ts"],
      () => new Set([5]),
      () => "conteúdo",
    );
    assert.equal(check.touchesCalibration, true);
    assert.deepEqual(check.touchedPaths, [tsPath]);
  });

  it("diff toca arquivo marked-blocks mas SÓ fora de qualquer bloco CALIBRATED: não toca calibração", () => {
    const mdPath = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!.path;
    const content = ["l1", "<!-- CALIBRATED:x:start -->", "l3", "<!-- CALIBRATED:x:end -->", "l5"].join("\n");
    const check = evaluateCalibrationTouch(
      [mdPath],
      () => new Set([1, 5]), // só linhas fora do bloco (2-4)
      () => content,
    );
    assert.equal(check.touchesCalibration, false);
  });

  it("diff toca arquivo marked-blocks DENTRO de um bloco CALIBRATED: toca calibração", () => {
    const mdPath = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!.path;
    const content = ["l1", "<!-- CALIBRATED:x:start -->", "l3", "<!-- CALIBRATED:x:end -->", "l5"].join("\n");
    const check = evaluateCalibrationTouch(
      [mdPath],
      () => new Set([3]),
      () => content,
    );
    assert.equal(check.touchesCalibration, true);
    assert.deepEqual(check.touchedPaths, [mdPath]);
  });

  it("múltiplos arquivos calibráveis tocados: touchedPaths lista todos", () => {
    const paths = CALIBRATION_ALLOWLIST.filter((e) => e.kind === "ts-file").map((e) => e.path);
    const check = evaluateCalibrationTouch(paths, () => new Set([1]), () => "x");
    assert.equal(check.touchedPaths.length, paths.length);
  });

  it("SIGNOFF_LABEL é o literal usado como convenção de label no GitHub (documentação viva)", () => {
    assert.equal(SIGNOFF_LABEL, "editorial-signoff:approved");
  });
});
