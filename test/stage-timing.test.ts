/**
 * test/stage-timing.test.ts (#1405)
 *
 * Cobre `fileToStage()` — mapping de file prefix → stage id/label.
 *
 * Bug original: mapping usava o número do prefix direto como stage_id
 * (`03-social` → Stage 3 "Social", `05-published` → Stage 5 "Newsletter",
 * `06-social-published` → Stage 6 "Social pub"). Pipeline atual (CLAUDE.md)
 * só tem 4 stages — Stage 5 e 6 não existem. Output do report ficava
 * confuso pro editor com labels stale.
 *
 * Fix #1405: prefixes 03-* viraram Stage 2 (Writing — social paralelo);
 * 04-* virou Stage 3 (Images); 05-* + 06-* viraram Stage 4 (Publishing).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileToStage, detectLatestEditionIn } from "../scripts/stage-timing.ts";

describe("fileToStage (#1405)", () => {
  it("01-eia* → Stage 1 Research", () => {
    assert.deepEqual(fileToStage("01-eia.md"), { stage: 1, label: "Research" });
    assert.deepEqual(fileToStage("01-eia-A.jpg"), { stage: 1, label: "Research" });
    assert.deepEqual(fileToStage("01-eia-B.jpg"), { stage: 1, label: "Research" });
  });

  it("01-categorized.md → Stage 1 Research", () => {
    assert.deepEqual(fileToStage("01-categorized.md"), { stage: 1, label: "Research" });
    assert.deepEqual(fileToStage("_internal/01-approved.json"), { stage: 1, label: "Research" });
  });

  it("02-* → Stage 2 Writing (newsletter)", () => {
    assert.deepEqual(fileToStage("02-reviewed.md"), { stage: 2, label: "Writing" });
    assert.deepEqual(fileToStage("_internal/02-draft.md"), { stage: 2, label: "Writing" });
  });

  it("03-* → Stage 2 Writing (social paralelo, não Stage 3)", () => {
    // Regression #1405: antes ia pra Stage 3 "Social", mas social roda em
    // paralelo com newsletter dentro do Stage 2 (CLAUDE.md pipeline atual).
    assert.deepEqual(fileToStage("03-social.md"), { stage: 2, label: "Writing" });
    assert.deepEqual(fileToStage("_internal/03-linkedin.tmp.md"), { stage: 2, label: "Writing" });
  });

  it("04-* → Stage 3 Images", () => {
    // Regression #1405: antes ia pra Stage 4 "Images" (offset+1).
    assert.deepEqual(fileToStage("04-d1-2x1.jpg"), { stage: 3, label: "Images" });
    assert.deepEqual(fileToStage("04-d2-1x1.jpg"), { stage: 3, label: "Images" });
    assert.deepEqual(fileToStage("04-d3-1x1.jpg"), { stage: 3, label: "Images" });
  });

  it("05-* → Stage 4 Publishing (newsletter)", () => {
    // Regression #1405: antes ia pra Stage 5 "Newsletter" — stage que não
    // existe no pipeline atual (4 stages).
    assert.deepEqual(fileToStage("05-published.json"), { stage: 4, label: "Publishing" });
    assert.deepEqual(fileToStage("_internal/05-published.json"), { stage: 4, label: "Publishing" });
  });

  it("06-* → Stage 4 Publishing (social, não Stage 6)", () => {
    // Regression #1405: antes ia pra Stage 6 "Social pub" — também stage
    // inexistente. Newsletter + social publish ambos rodam em Stage 4 paralelo.
    assert.deepEqual(fileToStage("06-social-published.json"), { stage: 4, label: "Publishing" });
    assert.deepEqual(fileToStage("_internal/06-public-images.json"), { stage: 4, label: "Publishing" });
  });

  it("retorna null pra arquivos não-pipeline", () => {
    assert.equal(fileToStage("README.md"), null);
    assert.equal(fileToStage("random.txt"), null);
    assert.equal(fileToStage("99-future.json"), null);
  });

  it("detectLatestEditionIn: retorna null quando editions dir não existe", () => {
    assert.equal(detectLatestEditionIn("/nonexistent/path"), null);
  });

  it("detectLatestEditionIn: retorna null quando editions dir está vazio", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-timing-empty-"));
    try {
      assert.equal(detectLatestEditionIn(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #2463/#3024: detectLatestEdition (via --all e auto-detect) precisa
  // enxergar edições no layout NESTED novo, não só no flat legado.
  it("detectLatestEditionIn: encontra a mais recente entre flat e nested misturados", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-timing-mixed-"));
    try {
      mkdirSync(join(dir, "260421"), { recursive: true }); // flat legado
      mkdirSync(join(dir, "2604", "260423"), { recursive: true }); // nested novo, mais recente
      assert.equal(detectLatestEditionIn(dir), "260423");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nunca retorna Stage 5 ou 6 (não existem no pipeline atual)", () => {
    // Sentinel: itera prefixes plausíveis e garante que nenhum cai em
    // stage_id legacy (5 ou 6).
    const samples = [
      "05-published.json",
      "06-social-published.json",
      "_internal/05-publish-consent.json",
      "_internal/06-public-images.json",
    ];
    for (const name of samples) {
      const result = fileToStage(name);
      assert.ok(result, `esperado mapping pra ${name}`);
      assert.ok(
        result.stage <= 4,
        `${name} mapeou pra Stage ${result.stage} — pipeline atual só tem 0-4 (CLAUDE.md)`,
      );
    }
  });
});
