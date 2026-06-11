/**
 * test/stage-4-review-completed.test.ts (#1577, #1694)
 *
 * Cobre o invariant `stage-4-review-completed` em stage-5 + o gate
 * complementar em `blockReasonForMarkingStageDone` (update-stage-status.ts).
 *
 * #1694: os guards de review-test-email loop foram movidos de Stage 4 → Stage 5
 * após o split Revisão (Stage 4) + Publicação (Stage 5).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkStage4ReviewCompleted } from "../scripts/lib/invariant-checks/stage-5.ts";
import { blockReasonForMarkingStageDone } from "../scripts/update-stage-status.ts";

function makeEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-review-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function writePublished(
  dir: string,
  pub: { review_completed?: boolean; review_status?: string },
): void {
  writeFileSync(
    resolve(dir, "_internal", "05-published.json"),
    JSON.stringify(pub),
  );
}

function writeReport(dir: string): void {
  writeFileSync(
    resolve(dir, "_internal", "edition-report.html"),
    "<html>report</html>",
  );
}

describe("checkStage4ReviewCompleted (#1577)", () => {
  it("review_completed=true → ok (zero violations)", () => {
    const dir = makeEditionDir();
    try {
      writePublished(dir, { review_completed: true, review_status: "ok" });
      assert.equal(checkStage4ReviewCompleted(dir).length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("review_status=issues_unfixable (terminal explícito) → ok", () => {
    const dir = makeEditionDir();
    try {
      writePublished(dir, {
        review_completed: false,
        review_status: "issues_unfixable",
      });
      assert.equal(checkStage4ReviewCompleted(dir).length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("review_status=inconclusive (terminal explícito) → ok", () => {
    const dir = makeEditionDir();
    try {
      writePublished(dir, {
        review_completed: false,
        review_status: "inconclusive",
      });
      assert.equal(checkStage4ReviewCompleted(dir).length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Cenário 260529: review_completed=false + review_status=pending → violation", () => {
    const dir = makeEditionDir();
    try {
      writePublished(dir, { review_completed: false, review_status: "pending" });
      const violations = checkStage4ReviewCompleted(dir);
      assert.equal(violations.length, 1);
      assert.match(violations[0].message, /Loop verify→fix do test email não rodou/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("ambos os campos ausentes → violation (defensive default)", () => {
    const dir = makeEditionDir();
    try {
      writePublished(dir, {});
      assert.ok(checkStage4ReviewCompleted(dir).length > 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("05-published.json ausente → no-op (outro check pega)", () => {
    const dir = makeEditionDir();
    try {
      assert.equal(checkStage4ReviewCompleted(dir).length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("blockReasonForMarkingStageDone — Stage 5 + #1577 review_completed (#1694)", () => {
  // #1694: guards movidos de Stage 4 → Stage 5 (split Revisão+Publicação)

  it("Stage 5 + report + review_completed=true → null (transição liberada)", () => {
    const dir = makeEditionDir();
    try {
      writeReport(dir);
      writePublished(dir, { review_completed: true });
      assert.equal(blockReasonForMarkingStageDone(dir, 5), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Stage 5 + report + review_completed=false + review_status=pending → block", () => {
    const dir = makeEditionDir();
    try {
      writeReport(dir);
      writePublished(dir, { review_completed: false, review_status: "pending" });
      const reason = blockReasonForMarkingStageDone(dir, 5);
      assert.ok(reason);
      assert.match(reason!, /review-test-email loop/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Stage 5 + report + review_status=issues_unfixable (terminal) → null", () => {
    const dir = makeEditionDir();
    try {
      writeReport(dir);
      writePublished(dir, {
        review_completed: false,
        review_status: "issues_unfixable",
      });
      assert.equal(blockReasonForMarkingStageDone(dir, 5), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Stage 5 + report + 05-published.json ausente → null (não bloqueia)", () => {
    // Compat: edições sem 05-published.json não devem ser bloqueadas
    // (caso Stage 5 abortado antes do publish).
    const dir = makeEditionDir();
    try {
      writeReport(dir);
      assert.equal(blockReasonForMarkingStageDone(dir, 5), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Stage 4 (Revisão) + report presente → null (gate não aplica a Stage 4 após #1694)", () => {
    // Stage 4 = Revisão — não tem o guard de review_completed;
    // marcar done sem restrição de report.
    const dir = makeEditionDir();
    try {
      writeReport(dir);
      writePublished(dir, { review_completed: false, review_status: "pending" });
      assert.equal(blockReasonForMarkingStageDone(dir, 4), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Stage 1-3 → null (gate só aplica a stage 5)", () => {
    const dir = makeEditionDir();
    try {
      assert.equal(blockReasonForMarkingStageDone(dir, 1), null);
      assert.equal(blockReasonForMarkingStageDone(dir, 2), null);
      assert.equal(blockReasonForMarkingStageDone(dir, 3), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
