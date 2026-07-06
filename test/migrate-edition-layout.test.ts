import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planForward,
  planUndo,
  executeMigration,
} from "../scripts/migrate-edition-layout.ts";

function setupFlatFixture(): { root: string; editionsRoot: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "migrate-edition-layout-"));
  const editionsRoot = join(root, "data", "editions");
  mkdirSync(editionsRoot, { recursive: true });

  // Regular flat editions
  for (const aammdd of ["260505", "260706"]) {
    const dir = join(editionsRoot, aammdd);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), "conteudo");
    writeFileSync(join(dir, "_internal", "01-approved.json"), "{}");
  }

  // *-backup-* variant
  const backupDir = join(editionsRoot, "260420-backup-antes-fix");
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, "02-reviewed.md"), "backup conteudo");

  return {
    root,
    editionsRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("migrate-edition-layout: dry-run (planForward)", () => {
  it("plans moves for flat dirs including *-backup-* variant, touches nothing", () => {
    const { editionsRoot, cleanup } = setupFlatFixture();
    try {
      const plan = planForward(editionsRoot);
      const migrate = plan.filter((e) => e.status === "migrate");
      assert.equal(migrate.length, 3);

      const byFrom = Object.fromEntries(migrate.map((e) => [e.from, e]));
      assert.equal(byFrom["260505"].to, join("2605", "260505"));
      assert.equal(byFrom["260706"].to, join("2607", "260706"));
      assert.equal(
        byFrom["260420-backup-antes-fix"].to,
        join("2604", "260420-backup-antes-fix"),
      );

      // Dry-run: filesystem untouched — still flat.
      assert.ok(existsSync(join(editionsRoot, "260505")));
      assert.ok(!existsSync(join(editionsRoot, "2605")));
    } finally {
      cleanup();
    }
  });

  it("rejects malformed dir names as skip-unknown", () => {
    const { editionsRoot, cleanup } = setupFlatFixture();
    try {
      mkdirSync(join(editionsRoot, "notes-and-stuff"), { recursive: true });
      const plan = planForward(editionsRoot);
      const unknown = plan.find((e) => e.from === "notes-and-stuff");
      assert.equal(unknown?.status, "skip-unknown");
    } finally {
      cleanup();
    }
  });
});

describe("migrate-edition-layout: real run + idempotency", () => {
  it("actually moves dirs to nested layout via execute, and re-running is a no-op", () => {
    const { editionsRoot, cleanup } = setupFlatFixture();
    try {
      const plan1 = planForward(editionsRoot);
      const { ok, failed } = executeMigration(plan1);
      assert.equal(failed, 0);
      assert.equal(ok, 3);

      // Verify nested layout on disk, content preserved
      assert.ok(existsSync(join(editionsRoot, "2605", "260505", "02-reviewed.md")));
      assert.ok(
        existsSync(
          join(editionsRoot, "2605", "260505", "_internal", "01-approved.json"),
        ),
      );
      assert.ok(
        existsSync(
          join(editionsRoot, "2604", "260420-backup-antes-fix", "02-reviewed.md"),
        ),
      );
      // Old flat dirs gone (renamed, not copied)
      assert.ok(!existsSync(join(editionsRoot, "260505")));
      assert.ok(!existsSync(join(editionsRoot, "260420-backup-antes-fix")));

      // Re-running: plan should now be empty (already nested, AAMM dirs skipped as non-candidates)
      const plan2 = planForward(editionsRoot);
      const migrate2 = plan2.filter((e) => e.status === "migrate");
      assert.equal(migrate2.length, 0);

      // Executing again is a true no-op
      const { ok: ok2, failed: failed2 } = executeMigration(plan2);
      assert.equal(ok2, 0);
      assert.equal(failed2, 0);
    } finally {
      cleanup();
    }
  });

  it("skip-dest-exists when target already present (does not clobber)", () => {
    const { editionsRoot, cleanup } = setupFlatFixture();
    try {
      // Pre-create nested destination for 260505
      mkdirSync(join(editionsRoot, "2605", "260505"), { recursive: true });
      writeFileSync(
        join(editionsRoot, "2605", "260505", "existing.txt"),
        "already there",
      );

      const plan = planForward(editionsRoot);
      const entry = plan.find((e) => e.from === "260505");
      assert.equal(entry?.status, "skip-dest-exists");

      executeMigration(plan);
      // Original flat dir untouched since it wasn't in the migrate set
      assert.ok(existsSync(join(editionsRoot, "260505")));
    } finally {
      cleanup();
    }
  });
});

describe("migrate-edition-layout: undo (planUndo)", () => {
  it("reverses nested back to flat, including *-backup-* variant", () => {
    const { editionsRoot, cleanup } = setupFlatFixture();
    try {
      // First migrate forward for real
      const forwardPlan = planForward(editionsRoot);
      executeMigration(forwardPlan);
      assert.ok(existsSync(join(editionsRoot, "2605", "260505")));

      // Now plan + execute undo
      const undoPlan = planUndo(editionsRoot);
      const migrate = undoPlan.filter((e) => e.status === "migrate");
      assert.equal(migrate.length, 3);

      const { ok, failed } = executeMigration(undoPlan);
      assert.equal(failed, 0);
      assert.equal(ok, 3);

      assert.ok(existsSync(join(editionsRoot, "260505", "02-reviewed.md")));
      assert.ok(
        existsSync(join(editionsRoot, "260420-backup-antes-fix", "02-reviewed.md")),
      );
      // Nested AAMM dirs now empty (or gone) — no leftover AAMMDD subdirs
      const remaining2605 = existsSync(join(editionsRoot, "2605"))
        ? readdirSync(join(editionsRoot, "2605"))
        : [];
      assert.deepEqual(remaining2605, []);
    } finally {
      cleanup();
    }
  });
});
