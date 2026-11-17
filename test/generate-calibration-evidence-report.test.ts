/**
 * test/generate-calibration-evidence-report.test.ts (#7978)
 *
 * Cobre scripts/generate-calibration-evidence-report.ts::generate — grava
 * o markdown em disco sob data/reports/calibration/.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, safeReportFileName } from "../scripts/generate-calibration-evidence-report.ts";
import { featureFromCalibrationReportTitle } from "../scripts/trigger-track-a-calibration.ts";
import { trackAReportFeatureLabel } from "../scripts/lib/track-a-features.ts";
import type { CalibrationEvidenceInput } from "../scripts/lib/calibration-evidence-report.ts";

describe("generate (#7978)", () => {
  it("grava o markdown em data/reports/calibration/{feature}-{prNumber}.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "calib-evidence-"));
    try {
      const input: CalibrationEvidenceInput = {
        feature: "hands_on",
        whatChanges: "peso +8 → +10",
        cases: [{ edition: "260901", url: "https://x.com/a", action: "ação" }],
        revertCommand: "git revert abc123",
      };
      const result = generate(dir, input, "8010");
      const abs = join(dir, "data", "reports", "calibration", "hands_on-8010.md");
      assert.ok(existsSync(abs));
      assert.equal(result.outPath, "data/reports/calibration/hands_on-8010.md");
      assert.match(readFileSync(abs, "utf8"), /## O que muda/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propaga o erro de renderCalibrationEvidenceReport (ex: >5 casos) sem escrever arquivo parcial", () => {
    const dir = mkdtempSync(join(tmpdir(), "calib-evidence-fail-"));
    try {
      const input: CalibrationEvidenceInput = {
        feature: "hands_on",
        whatChanges: "x",
        cases: Array.from({ length: 6 }, (_, i) => ({ edition: `26090${i}`, url: `https://x.com/${i}`, action: "a" })),
        revertCommand: "git revert abc123",
      };
      assert.throws(() => generate(dir, input, "8010"));
      assert.ok(!existsSync(join(dir, "data", "reports", "calibration", "hands_on-8010.md")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("feature com prefixo track-a: gera nome sem caractere inválido no Windows e o título segue reconhecido pelo trigger (#13387)", () => {
    const dir = mkdtempSync(join(tmpdir(), "calib-evidence-win-"));
    try {
      const feature = trackAReportFeatureLabel("coverage_bonus_present");
      const input: CalibrationEvidenceInput = {
        feature,
        whatChanges: "x",
        cases: [{ edition: "260901", url: "https://x.com/a", action: "a" }],
        revertCommand: "git revert abc123",
      };
      const result = generate(dir, input, "8010");
      const name = result.outPath.split("/").pop()!;
      assert.doesNotMatch(name, /[<>:"/\\|?*]/);
      assert.equal(name, safeReportFileName(feature, "8010"));
      assert.ok(existsSync(join(dir, "data", "reports", "calibration", name)));
      assert.match(result.markdown, /track-a:coverage_bonus_present/);
      assert.equal(featureFromCalibrationReportTitle(`Calibração ${feature} — PR #8010`), "coverage_bonus_present");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
