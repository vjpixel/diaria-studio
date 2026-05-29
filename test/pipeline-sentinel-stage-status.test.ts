/**
 * test/pipeline-sentinel-stage-status.test.ts (#1563)
 *
 * Regressão: orchestrator esquece `update-stage-status --status done` no fim
 * do stage, mas escreve sentinel `.step-N-done.json` (invariante do gate).
 * Sentinel write deve auto-atualizar stage-status pra "done" quando row está
 * em "running".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoUpdateStageStatusOnSentinel } from "../scripts/pipeline-sentinel.ts";
import {
  applyUpdate,
  loadDoc,
  makeInitialDoc,
  saveDoc,
} from "../scripts/update-stage-status.ts";
import { writeSentinel } from "../scripts/lib/pipeline-state.ts";

describe("autoUpdateStageStatusOnSentinel (#1563)", () => {
  it("stage em running com start → marca done com end + duration_ms", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-auto-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, {
        stage: 2,
        status: "running",
        start: "2026-05-27T20:00:00Z",
      });
      saveDoc(dir, doc);

      const nowMs = new Date("2026-05-27T22:00:00Z").getTime();
      const updated = autoUpdateStageStatusOnSentinel(dir, "260528", 2, nowMs);
      assert.equal(updated, true);

      const reloaded = loadDoc(dir, "260528");
      const stage2 = reloaded.rows.find((r) => r.stage === 2);
      assert.ok(stage2);
      assert.equal(stage2!.status, "done");
      assert.equal(stage2!.end, "2026-05-27T22:00:00.000Z");
      assert.equal(stage2!.duration_ms, 2 * 60 * 60 * 1000);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("stage running sem start → marca done sem duration_ms quebrar", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-nostart-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, { stage: 1, status: "running" });
      saveDoc(dir, doc);

      const ok = autoUpdateStageStatusOnSentinel(dir, "260528", 1);
      assert.equal(ok, true);

      const reloaded = loadDoc(dir, "260528");
      const stage1 = reloaded.rows.find((r) => r.stage === 1);
      assert.equal(stage1!.status, "done");
      assert.ok(stage1!.end);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("stage já done → no-op (idempotente, preserva end original)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-done-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, {
        stage: 2,
        status: "done",
        start: "2026-05-27T20:00:00Z",
        end: "2026-05-27T20:30:00Z",
        duration_ms: 30 * 60 * 1000,
      });
      saveDoc(dir, doc);

      const nowMs = new Date("2026-05-27T22:00:00Z").getTime();
      const updated = autoUpdateStageStatusOnSentinel(dir, "260528", 2, nowMs);
      assert.equal(updated, false, "no-op pra stage já done");

      const reloaded = loadDoc(dir, "260528");
      const stage2 = reloaded.rows.find((r) => r.stage === 2);
      assert.equal(stage2!.end, "2026-05-27T20:30:00Z", "end original preservado");
      assert.equal(stage2!.duration_ms, 30 * 60 * 1000);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("step fora do range de stages (0, 5) → no-op silencioso", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-range-"));
    try {
      const doc = makeInitialDoc("260528");
      saveDoc(dir, doc);

      assert.equal(autoUpdateStageStatusOnSentinel(dir, "260528", 5), false);
      assert.equal(autoUpdateStageStatusOnSentinel(dir, "260528", -1), false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("stage-status ausente → no-op (best-effort)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-noexist-"));
    try {
      // makeInitialDoc returns all pending — auto-update should be no-op
      const updated = autoUpdateStageStatusOnSentinel(dir, "260528", 1);
      assert.equal(updated, false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Stage 4 running sem edition-report.html → no-op (respeita gate #1530)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-gate-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, {
        stage: 4,
        status: "running",
        start: "2026-05-27T20:00:00Z",
      });
      saveDoc(dir, doc);

      // No edition-report.html written
      const updated = autoUpdateStageStatusOnSentinel(dir, "260528", 4);
      assert.equal(updated, false, "gate #1530 deve bloquear");

      const reloaded = loadDoc(dir, "260528");
      const stage4 = reloaded.rows.find((r) => r.stage === 4);
      assert.equal(stage4!.status, "running", "row permanece running");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Stage 4 running com edition-report.html → marca done", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-with-report-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, {
        stage: 4,
        status: "running",
        start: "2026-05-27T20:00:00Z",
      });
      saveDoc(dir, doc);

      // Edition report exists
      writeFileSync(
        join(dir, "_internal", "edition-report.html"),
        "<html>report</html>",
      );

      const nowMs = new Date("2026-05-27T22:00:00Z").getTime();
      const updated = autoUpdateStageStatusOnSentinel(dir, "260528", 4, nowMs);
      assert.equal(updated, true);

      const reloaded = loadDoc(dir, "260528");
      const stage4 = reloaded.rows.find((r) => r.stage === 4);
      assert.equal(stage4!.status, "done");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("integração: writeSentinel + autoUpdate em pipeline real", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-integ-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, {
        stage: 3,
        status: "running",
        start: "2026-05-27T18:00:00Z",
      });
      saveDoc(dir, doc);

      writeFileSync(join(dir, "_internal", "image-cache.json"), "{}");
      writeSentinel(dir, 3, ["_internal/image-cache.json"]);
      const nowMs = new Date("2026-05-27T18:05:00Z").getTime();
      autoUpdateStageStatusOnSentinel(dir, "260528", 3, nowMs);

      const reloaded = loadDoc(dir, "260528");
      const stage3 = reloaded.rows.find((r) => r.stage === 3);
      assert.equal(stage3!.status, "done");
      assert.equal(stage3!.duration_ms, 5 * 60 * 1000);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("backfill-stage-status helper logic (#1563)", () => {
  // Backfill CLI uses spawnSync internally; for direct unit testing,
  // we exercise the same logic — load + detect + apply.
  it("running com sentinel manualmente escrito → backfill com completed_at", () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-stage-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, {
        stage: 4,
        status: "running",
        start: "2026-05-27T20:51:00Z",
      });
      saveDoc(dir, doc);

      // Escrever sentinel com completed_at fixo (simulando estado pre-fix)
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", ".step-4-done.json"),
        JSON.stringify({
          step: 4,
          completed_at: "2026-05-27T22:00:00Z",
          outputs: [],
        }),
      );
      // Real-world: stage 4 stuck running era post-publicação completa —
      // edition-report.html já existia. Backfill respeita gate #1530.
      writeFileSync(
        join(dir, "_internal", "edition-report.html"),
        "<html>report</html>",
      );

      // O backfill replica a lógica do autoUpdate, mas usa completed_at do
      // sentinel como `end` ao invés de Date.now()
      const sentinel = JSON.parse(
        readFileSync(join(dir, "_internal", ".step-4-done.json"), "utf8"),
      );
      const completedAtMs = new Date(sentinel.completed_at).getTime();
      const ok = autoUpdateStageStatusOnSentinel(dir, "260528", 4, completedAtMs);
      assert.equal(ok, true);

      const reloaded = loadDoc(dir, "260528");
      const stage4 = reloaded.rows.find((r) => r.stage === 4);
      assert.equal(stage4!.status, "done");
      assert.equal(stage4!.end, "2026-05-27T22:00:00.000Z");
      // 22:00 - 20:51 = 69 minutes
      assert.equal(stage4!.duration_ms, 69 * 60 * 1000);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
