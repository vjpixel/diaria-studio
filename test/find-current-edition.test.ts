import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEditionsInProgress } from "../scripts/lib/find-current-edition.ts";

function setupSandbox(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "find-current-edition-"));
  mkdirSync(join(root, "data/editions"), { recursive: true });
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeEdition(
  root: string,
  aammdd: string,
  files: string[],
): void {
  const editionDir = join(root, "data/editions", aammdd);
  for (const f of files) {
    const full = join(editionDir, f);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "x");
  }
}

describe("findEditionsInProgress", () => {
  it("returns [] when editions dir doesn't exist", () => {
    const { root, cleanup } = setupSandbox();
    try {
      rmSync(join(root, "data/editions"), { recursive: true });
      assert.deepEqual(findEditionsInProgress(2, root), []);
    } finally {
      cleanup();
    }
  });

  it("returns [] when editions dir is empty", () => {
    const { root, cleanup } = setupSandbox();
    try {
      assert.deepEqual(findEditionsInProgress(2, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 2: returns AAMMDD when prereq present, output missing", () => {
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", ["_internal/01-approved.json"]);
      assert.deepEqual(findEditionsInProgress(2, root), ["260505"]);
    } finally {
      cleanup();
    }
  });

  it("Stage 2: skips edition when prereq missing", () => {
    const { root, cleanup } = setupSandbox();
    try {
      // No _internal/01-approved.json
      makeEdition(root, "260505", ["01-categorized.md"]);
      assert.deepEqual(findEditionsInProgress(2, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 2: skips edition when output already exists", () => {
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", [
        "_internal/01-approved.json",
        "02-reviewed.md",
      ]);
      assert.deepEqual(findEditionsInProgress(2, root), []);
    } finally {
      cleanup();
    }
  });

  it("returns multiple candidates sorted", () => {
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260507", ["_internal/01-approved.json"]);
      makeEdition(root, "260505", ["_internal/01-approved.json"]);
      makeEdition(root, "260506", ["_internal/01-approved.json"]);
      assert.deepEqual(findEditionsInProgress(2, root), [
        "260505",
        "260506",
        "260507",
      ]);
    } finally {
      cleanup();
    }
  });

  it("ignores non-AAMMDD directory entries", () => {
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", ["_internal/01-approved.json"]);
      // Create some noise that should be ignored
      mkdirSync(join(root, "data/editions/.tmp"), { recursive: true });
      mkdirSync(join(root, "data/editions/archive"), { recursive: true });
      writeFileSync(join(root, "data/editions/notes.md"), "x");
      assert.deepEqual(findEditionsInProgress(2, root), ["260505"]);
    } finally {
      cleanup();
    }
  });

  it("Stage 3: prereq is _internal/01-approved.json, output is 04-d1-1x1.jpg", () => {
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", ["_internal/01-approved.json"]);
      assert.deepEqual(findEditionsInProgress(3, root), ["260505"]);
      // Now add the output → no longer in progress
      makeEdition(root, "260505", ["04-d1-1x1.jpg"]);
      assert.deepEqual(findEditionsInProgress(3, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 4 (Revisão #1694): requires both 02-reviewed.md AND 03-social.md as prereq, output is .step-4-done.json", () => {
    const { root, cleanup } = setupSandbox();
    try {
      // Only 02-reviewed.md → not enough
      makeEdition(root, "260505", ["02-reviewed.md"]);
      assert.deepEqual(findEditionsInProgress(4, root), []);
      // Add 03-social.md → now in progress
      makeEdition(root, "260505", ["03-social.md"]);
      assert.deepEqual(findEditionsInProgress(4, root), ["260505"]);
      // Add output sentinel → done
      makeEdition(root, "260505", ["_internal/.step-4-done.json"]);
      assert.deepEqual(findEditionsInProgress(4, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 5 (Publicação #1694): requires _internal/.step-4-done.json as prereq, output is _internal/06-social-published.json", () => {
    // #1694 finding 3: output marker is 06-social-published.json (written after social
    // dispatch). 05-published.json is mid-stage and would cause false-done.
    const { root, cleanup } = setupSandbox();
    try {
      // No prereq → not a candidate
      makeEdition(root, "260505", ["02-reviewed.md", "03-social.md"]);
      assert.deepEqual(findEditionsInProgress(5, root), []);
      // Add Stage 4 sentinel → now in progress for Stage 5
      makeEdition(root, "260505", ["_internal/.step-4-done.json"]);
      assert.deepEqual(findEditionsInProgress(5, root), ["260505"]);
      // 05-published.json written mid-stage (newsletter done) → still in progress
      makeEdition(root, "260505", ["_internal/05-published.json"]);
      assert.deepEqual(findEditionsInProgress(5, root), ["260505"]);
      // Stage 5 fully done: 06-social-published.json present
      makeEdition(root, "260505", ["_internal/06-social-published.json"]);
      assert.deepEqual(findEditionsInProgress(5, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 4: skips pre-#1694 edition that has 05-published.json but no .step-4-done.json", () => {
    // Regression for #1694 finding 2: pre-split editions have all Stage 4 prereqs
    // (02-reviewed.md + 03-social.md) but were published before .step-4-done.json existed.
    // Without the guard, they would be false Stage 4 candidates and Revisão would re-run.
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", [
        "02-reviewed.md",
        "03-social.md",
        "_internal/05-published.json", // already published — pre-#1694 edition
      ]);
      assert.deepEqual(findEditionsInProgress(4, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 5: partial run (newsletter done, social pending) still detected as in-progress", () => {
    // Regression for #1694 finding 3: 05-published.json is written mid-Stage 5 (newsletter only).
    // An edition where newsletter dispatched but social failed should still appear as Stage 5
    // in-progress (no 06-social-published.json yet).
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", [
        "_internal/.step-4-done.json",
        "_internal/05-published.json", // newsletter done — but stage NOT complete
        // NOTE: 06-social-published.json is absent → social pending → still in progress
      ]);
      assert.deepEqual(findEditionsInProgress(5, root), ["260505"]);
      // Now social completes → fully done
      makeEdition(root, "260505", ["_internal/06-social-published.json"]);
      assert.deepEqual(findEditionsInProgress(5, root), []);
    } finally {
      cleanup();
    }
  });
});
