/**
 * test/studio-edition-detail.test.ts (#3555) — cobertura de
 * scripts/studio-ui/studio-edition-detail.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEditionDetail, GATE_FACING_FILES } from "../scripts/studio-ui/studio-edition-detail.ts";
import { saveDoc, makeInitialDoc, applyUpdate } from "../scripts/update-stage-status.ts";

function setupRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "studio-edition-detail-"));
  mkdirSync(join(root, "data", "editions"), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("buildEditionDetail (#3555)", () => {
  it("AAMMDD inválido: found=false, sem lançar", () => {
    const { root, cleanup } = setupRoot();
    try {
      const detail = buildEditionDetail(root, "not-a-date");
      assert.equal(detail.found, false);
      assert.equal(detail.currentStage, "unknown");
      assert.deepEqual(detail.gateFacingFiles, []);
    } finally {
      cleanup();
    }
  });

  it("edição inexistente no disco: found=false", () => {
    const { root, cleanup } = setupRoot();
    try {
      const detail = buildEditionDetail(root, "260716");
      assert.equal(detail.found, false);
    } finally {
      cleanup();
    }
  });

  it("edição existente sem stage-status: found=true, currentStage='unknown', stageStatus=null", () => {
    const { root, cleanup } = setupRoot();
    try {
      const editionDir = join(root, "data", "editions", "260716");
      mkdirSync(editionDir, { recursive: true });
      writeFileSync(join(editionDir, "01-categorized.md"), "conteúdo");

      const detail = buildEditionDetail(root, "260716");
      assert.equal(detail.found, true);
      assert.equal(detail.currentStage, "unknown");
      assert.equal(detail.stageStatus, null);

      const categorized = detail.gateFacingFiles.find((f) => f.name === "01-categorized.md");
      assert.ok(categorized);
      assert.equal(categorized!.exists, true);
      assert.ok((categorized!.sizeBytes ?? 0) > 0);
      assert.ok(categorized!.modifiedAt);

      const missing = detail.gateFacingFiles.find((f) => f.name === "02-reviewed.md");
      assert.equal(missing!.exists, false);
      assert.equal(missing!.sizeBytes, null);
    } finally {
      cleanup();
    }
  });

  it("edição com stage-status.json: expõe stageStatus.rows completo (timeline)", () => {
    const { root, cleanup } = setupRoot();
    try {
      const editionDir = join(root, "data", "editions", "260716");
      mkdirSync(editionDir, { recursive: true });
      let doc = makeInitialDoc("260716");
      doc = applyUpdate(doc, { stage: 1, status: "done" });
      doc = applyUpdate(doc, { stage: 2, status: "running" });
      saveDoc(editionDir, doc);

      const detail = buildEditionDetail(root, "260716");
      assert.equal(detail.currentStage, 2);
      assert.ok(detail.stageStatus);
      assert.equal(detail.stageStatus!.rows.find((r) => r.stage === 1)?.status, "done");
      assert.equal(detail.stageStatus!.rows.find((r) => r.stage === 2)?.status, "running");
    } finally {
      cleanup();
    }
  });

  it("gatesPending inclui 6 quando stage 5 done e stage 6 sem sentinel", () => {
    const { root, cleanup } = setupRoot();
    try {
      const editionDir = join(root, "data", "editions", "260716", "_internal");
      mkdirSync(editionDir, { recursive: true });
      writeFileSync(join(editionDir, ".step-5-done.json"), "{}");

      const detail = buildEditionDetail(root, "260716");
      assert.deepEqual(detail.gatesPending, [6]);
    } finally {
      cleanup();
    }
  });

  it("GATE_FACING_FILES é uma lista fechada e conhecida (regressão contra scan livre)", () => {
    assert.ok(GATE_FACING_FILES.includes("02-reviewed.md"));
    assert.ok(GATE_FACING_FILES.includes("03-social.md"));
    assert.ok(!GATE_FACING_FILES.some((f) => f.startsWith("_internal")));
  });
});
