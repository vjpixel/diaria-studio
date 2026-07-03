/**
 * test/stage-4-capture-failed-invariant.test.ts (#2878)
 *
 * Segunda barreira (gate-blocking) do fix #2878: mesmo que
 * `sync-coverage-line.ts` (Stage 2) já tenha trocado a linha de cobertura
 * pelo aviso, o Stage 4 gate re-checa o marker diretamente — cobre o caso do
 * editor editar `02-reviewed.md` no Drive e apagar/ignorar o aviso sem
 * perceber que a contagem de submissões está comprometida.
 *
 * Espelha o padrão de test/stage-4-title-normalization-invariant.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkCaptureFailedSubmissionCount,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { writeMarker } from "../scripts/lib/pipeline-state.ts";

function makeEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-capture-failed-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(resolve(dir, "02-reviewed.md"), "Para esta edição, eu (o editor) enviei 0 submissões e a Diar.ia encontrou outros 130 artigos. Selecionamos os 34 mais relevantes para as pessoas que assinam a newsletter.\n");
  return dir;
}

describe("checkCaptureFailedSubmissionCount (#2878)", () => {
  it("(a) marker com capture_failed:true → violação error, gate-blocking", () => {
    const dir = makeEditionDir();
    try {
      writeMarker(dir, "inject-inbox-urls", {
        editor_blocks: 0,
        newsletter_blocks: 0,
        capture_failed: true,
        capture_error: "invalid_client: The OAuth client was not found.",
      });
      const violations = checkCaptureFailedSubmissionCount(dir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].severity, "error");
      assert.equal(violations[0].rule, "capture-failed-submission-count");
      assert.equal(violations[0].source_issue, "#2878");
      assert.match(violations[0].message, /invalid_client/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(b) marker legítimo com 0 (sem capture_failed) → [] (não bloqueia)", () => {
    const dir = makeEditionDir();
    try {
      writeMarker(dir, "inject-inbox-urls", {
        editor_blocks: 0,
        newsletter_blocks: 0,
        captured_newsletter_count: 0,
        newsletter_source: "inbox-md",
      });
      assert.deepEqual(checkCaptureFailedSubmissionCount(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna [] quando o marker inject-inbox-urls não existe", () => {
    const dir = makeEditionDir();
    try {
      assert.deepEqual(checkCaptureFailedSubmissionCount(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("usa 'motivo desconhecido' na mensagem quando capture_error ausente", () => {
    const dir = makeEditionDir();
    try {
      writeMarker(dir, "inject-inbox-urls", { capture_failed: true });
      const violations = checkCaptureFailedSubmissionCount(dir);
      assert.equal(violations.length, 1);
      assert.match(violations[0].message, /motivo desconhecido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("STAGE_4_RULES registry (#2878)", () => {
  it("inclui capture-failed-submission-count", () => {
    const ids = STAGE_4_RULES.map((r) => r.id);
    assert.ok(ids.includes("capture-failed-submission-count"));
  });

  it("a regra registrada é severity error via run() (gate-blocking)", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "capture-failed-submission-count");
    assert.ok(rule);
    const dir = makeEditionDir();
    try {
      writeMarker(dir, "inject-inbox-urls", { capture_failed: true, capture_error: "x" });
      const violations = rule!.run(dir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].severity, "error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
