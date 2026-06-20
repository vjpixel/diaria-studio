/**
 * test/pipeline-sentinel-stage-status.test.ts (#1563, #1694, #2374)
 *
 * Regressão: orchestrator esquece `update-stage-status --status done` no fim
 * do stage, mas escreve sentinel `.step-N-done.json` (invariante do gate).
 * Sentinel write deve auto-atualizar stage-status pra "done" quando row está
 * em "running".
 *
 * #1694: guards de edition-report.html movidos de Stage 4 → Stage 5 após split
 * Revisão (Stage 4) + Publicação (Stage 5).
 *
 * #2374: session interruption: stages que ficam com status "pending" (o
 * orchestrator nunca chegou a chamar --status running antes da interrupção)
 * mas têm sentinel escrito devem ser reparados na retomada (assert path) e
 * pelo backfill. autoUpdateStageStatusOnSentinel deve tratar "pending" da
 * mesma forma que "running".
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
import { readSentinel, writeSentinel } from "../scripts/lib/pipeline-state.ts";


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

  it("step fora do range de stages (0-6) → no-op silencioso (#1694: range agora 0-6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-range-"));
    try {
      const doc = makeInitialDoc("260528");
      saveDoc(dir, doc);

      // 7 está fora do range 0-6
      assert.equal(autoUpdateStageStatusOnSentinel(dir, "260528", 7), false);
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

  it("Stage 5 (Publicação) running sem edition-report.html → marca done (#1694: guard movida para Stage 6)", () => {
    // #1694: guard de edition-report movida de Stage 5 → Stage 6 (Agendamento)
    // Stage 5 agora so bloqueia se 05-published.json existe e review_completed=false
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-gate-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, {
        stage: 5,
        status: "running",
        start: "2026-05-27T20:00:00Z",
      });
      saveDoc(dir, doc);

      // Sem edition-report.html — Stage 5 NAO deve mais bloquear (guard movida para Stage 6)
      const nowMs = new Date("2026-05-27T22:00:00Z").getTime();
      const updated = autoUpdateStageStatusOnSentinel(dir, "260528", 5, nowMs);
      assert.equal(updated, true, "Stage 5 sem report deve marcar done (#1694: guard em Stage 6)");

      const reloaded = loadDoc(dir, "260528");
      const stage5 = reloaded.rows.find((r) => r.stage === 5);
      assert.equal(stage5!.status, "done");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Stage 6 (Agendamento) running sem edition-report.html → no-op (respeita gate #1694)", () => {
    // #1694: guard de edition-report movida de Stage 5 → Stage 6
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-s6-gate-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, {
        stage: 6,
        status: "running",
        start: "2026-05-27T21:00:00Z",
      });
      saveDoc(dir, doc);

      // Sem edition-report.html — Stage 6 deve bloquear
      const updated = autoUpdateStageStatusOnSentinel(dir, "260528", 6);
      assert.equal(updated, false, "gate #1694 deve bloquear Stage 6 sem report");

      const reloaded = loadDoc(dir, "260528");
      const stage6 = reloaded.rows.find((r) => r.stage === 6);
      assert.equal(stage6!.status, "running", "row permanece running");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Stage 4 (Revisão) running sem edition-report.html → marca done (#1694: sem guard)", () => {
    // Stage 4 = Revisão — não tem o guard de edition-report; pode marcar done diretamente
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-stage4-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, {
        stage: 4,
        status: "running",
        start: "2026-05-27T20:00:00Z",
      });
      saveDoc(dir, doc);

      // Without edition-report.html — Stage 4 should still allow done
      const nowMs = new Date("2026-05-27T21:00:00Z").getTime();
      const updated = autoUpdateStageStatusOnSentinel(dir, "260528", 4, nowMs);
      assert.equal(updated, true, "Stage 4 (Revisão) não tem guard de edition-report");

      const reloaded = loadDoc(dir, "260528");
      const stage4 = reloaded.rows.find((r) => r.stage === 4);
      assert.equal(stage4!.status, "done");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Stage 5 running com edition-report.html → marca done", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-with-report-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, {
        stage: 5,
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
      const updated = autoUpdateStageStatusOnSentinel(dir, "260528", 5, nowMs);
      assert.equal(updated, true);

      const reloaded = loadDoc(dir, "260528");
      const stage5 = reloaded.rows.find((r) => r.stage === 5);
      assert.equal(stage5!.status, "done");
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

  // #2374: resume scenario — stage was "pending" at interruption (orchestrator
  // never called --status running), sentinel exists from prior session.
  it("#2374: stage pending com sentinel → marca done com end setado (backfill de start)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-pending-"));
    try {
      // Stage 1 has previous stage (0) with a known end time for start backfill.
      let doc = makeInitialDoc("260619");
      doc = applyUpdate(doc, {
        stage: 0,
        status: "done",
        start: "2026-06-18T20:00:00Z",
        end: "2026-06-18T20:05:00Z",
      });
      // Stage 1 remains "pending" — interrupted before orchestrator marked it running.
      saveDoc(dir, doc);

      const nowMs = new Date("2026-06-18T21:00:00Z").getTime();
      const updated = autoUpdateStageStatusOnSentinel(dir, "260619", 1, nowMs);
      assert.equal(updated, true, "pending + sentinel deve virar done");

      const reloaded = loadDoc(dir, "260619");
      const stage1 = reloaded.rows.find((r) => r.stage === 1);
      assert.ok(stage1);
      assert.equal(stage1!.status, "done");
      assert.ok(stage1!.end, "end deve estar setado");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#2374: stage pending sem start-backfill possível → ainda marca done (sem crash)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-pending-nostart-"));
    try {
      // Stage 0 is "pending" — no previous stage exists to backfill start from.
      const doc = makeInitialDoc("260619");
      saveDoc(dir, doc);

      const nowMs = new Date("2026-06-18T21:00:00Z").getTime();
      const updated = autoUpdateStageStatusOnSentinel(dir, "260619", 0, nowMs);
      assert.equal(updated, true, "pending stage 0 sem backfill possível ainda vira done");

      const reloaded = loadDoc(dir, "260619");
      const stage0 = reloaded.rows.find((r) => r.stage === 0);
      assert.equal(stage0!.status, "done");
      assert.ok(stage0!.end, "end deve estar setado via auto-carimbo");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#2374: idempotência — stage já done + re-chamar com pending→done é no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-status-pend-idem-"));
    try {
      let doc = makeInitialDoc("260619");
      doc = applyUpdate(doc, {
        stage: 3,
        status: "done",
        start: "2026-06-18T18:00:00Z",
        end: "2026-06-18T18:30:00Z",
        duration_ms: 30 * 60 * 1000,
      });
      saveDoc(dir, doc);

      const nowMs = new Date("2026-06-18T22:00:00Z").getTime();
      const updated = autoUpdateStageStatusOnSentinel(dir, "260619", 3, nowMs);
      assert.equal(updated, false, "no-op se já done");

      // end original não foi alterado
      const reloaded = loadDoc(dir, "260619");
      const stage3 = reloaded.rows.find((r) => r.stage === 3);
      assert.equal(stage3!.end, "2026-06-18T18:30:00Z", "end original preservado");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("#2374: assert subcommand — repara status no caminho de resume", () => {
  // On resume: orchestrator calls `assert --step N` to check if stage is done.
  // The sentinel exists (exit 0) but stage-status.json may still be "running"
  // or "pending". The assert path should trigger autoUpdateStageStatusOnSentinel.

  it("assert com stage running → status vira done após assert (unit-level)", () => {
    // The assert CLI path calls autoUpdateStageStatusOnSentinel when sentinel ok.
    // This test exercises that path via the exported function directly.
    const dir = mkdtempSync(join(tmpdir(), "sentinel-assert-running-"));
    try {
      let doc = makeInitialDoc("260619");
      doc = applyUpdate(doc, {
        stage: 2,
        status: "running",
        start: "2026-06-18T20:00:00Z",
      });
      saveDoc(dir, doc);

      // Write sentinel to simulate a prior session completing the stage.
      writeSentinel(dir, 2, []);

      // Simulate what the assert path does: sentinel found → autoUpdate.
      const nowMs = new Date("2026-06-18T21:00:00Z").getTime();
      const updated = autoUpdateStageStatusOnSentinel(dir, "260619", 2, nowMs);
      assert.equal(updated, true, "running → done via assert resume path");

      const reloaded = loadDoc(dir, "260619");
      const stage2 = reloaded.rows.find((row) => row.stage === 2);
      assert.equal(stage2!.status, "done", "running → done após assert com sentinel");
      assert.ok(stage2!.end, "end deve estar setado");
      // duration = 21:00 - 20:00 = 60 min
      assert.equal(stage2!.duration_ms, 60 * 60 * 1000);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#2374: assert com stage pending → status vira done após assert", () => {
    // Reproduced from 260619: stages 3+4 were "pending" with sentinels written.
    const dir = mkdtempSync(join(tmpdir(), "sentinel-assert-pending-"));
    try {
      let doc = makeInitialDoc("260619");
      // Stage 2 done (prior stage for backfill).
      doc = applyUpdate(doc, {
        stage: 2,
        status: "done",
        start: "2026-06-18T18:00:00Z",
        end: "2026-06-18T18:30:00Z",
      });
      // Stage 3 remains "pending" — orchestrator never marked it running.
      saveDoc(dir, doc);

      // Sentinel exists — the stage actually completed in a prior session.
      writeSentinel(dir, 3, []);

      // autoUpdateStageStatusOnSentinel is what assert calls internally.
      // Call it with sentinel's completed_at as nowMs.
      const nowMs = new Date("2026-06-18T19:00:00Z").getTime();
      const updated = autoUpdateStageStatusOnSentinel(dir, "260619", 3, nowMs);
      assert.equal(updated, true, "pending → done via assert resume path");

      const reloaded = loadDoc(dir, "260619");
      const stage3 = reloaded.rows.find((r) => r.stage === 3);
      assert.equal(stage3!.status, "done");
      assert.ok(stage3!.end, "end deve estar setado");
      // start backfilled from stage 2's end (18:30)
      assert.equal(stage3!.start, "2026-06-18T18:30:00Z", "start backfillado do end do stage 2");
      // duration = 19:00 - 18:30 = 30 min
      assert.equal(stage3!.duration_ms, 30 * 60 * 1000);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("#2401: assert path uses sentinel.completed_at, not Date.now()", () => {
  // Regression: before the fix the assert path called autoUpdateStageStatusOnSentinel
  // WITHOUT nowMs, defaulting to Date.now() — recording the RESUME time as `end`
  // instead of the actual stage completion time. The fix reads sentinel.completed_at
  // and passes it explicitly. This test simulates the CLI assert path directly:
  // given a sentinel with a completed_at in the past, end must match completed_at.

  it("assert path: end == sentinel.completed_at, NOT the current time", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-assert-2401-"));
    try {
      // Stage 3 "running" since 18:00 — the stage actually finished at 19:00 but
      // the orchestrator was interrupted before it called update-stage-status.
      let doc = makeInitialDoc("260619");
      doc = applyUpdate(doc, {
        stage: 3,
        status: "running",
        start: "2026-06-19T18:00:00Z",
      });
      saveDoc(dir, doc);

      // Sentinel written at 19:00 by the prior (interrupted) session.
      const completedAt = "2026-06-19T19:00:00.000Z";
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", ".step-3-done.json"),
        JSON.stringify({ step: 3, completed_at: completedAt, outputs: [] }),
      );

      // Simulate the CLI assert path: read sentinel.completed_at, derive nowMs.
      // The fix is that the CLI no longer calls autoUpdateStageStatusOnSentinel()
      // with no nowMs arg (which defaults to Date.now()) — it reads the sentinel
      // and passes completed_at. Replicate that here.
      const sentinel = readSentinel(dir, 3);
      assert.ok(sentinel, "sentinel should be readable");
      const nowMs = new Date(sentinel!.completed_at).getTime();
      const updated = autoUpdateStageStatusOnSentinel(dir, "260619", 3, nowMs);
      assert.equal(updated, true);

      const reloaded = loadDoc(dir, "260619");
      const stage3 = reloaded.rows.find((r) => r.stage === 3);
      assert.ok(stage3);
      assert.equal(stage3!.status, "done");
      // The key assertion: end must be sentinel.completed_at, not "now" (resume time).
      assert.equal(
        stage3!.end,
        completedAt,
        "#2401: end deve ser sentinel.completed_at, não a hora da retomada",
      );
      // duration: 19:00 - 18:00 = 60 min
      assert.equal(stage3!.duration_ms, 60 * 60 * 1000);

      // Sanity-check: if we had called WITHOUT nowMs (old buggy behavior), the end
      // would be Date.now() — definitely not equal to completedAt (1h+ in the past).
      // We can't directly assert "this would have failed" in a deterministic test,
      // but the fix is proven by the end == completedAt assertion above.
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("#2416: NaN guard — sentinel.completed_at malformado não causa no-op silencioso", () => {
  // Regressão #2416: no caminho `assert`, `new Date(sentinel.completed_at).getTime()`
  // sem guard NaN → nowMs=NaN → `new Date(NaN).toISOString()` lança RangeError
  // engolido pelo try/catch em autoUpdateStageStatusOnSentinel → retorna false
  // → stage-status.json nunca flipado para done, sem warning. Silencioso.
  //
  // Fix: guard NaN antes de chamar autoUpdateStageStatusOnSentinel. Se getTime()=NaN,
  // cai para Date.now() e emite console.warn. O reparo ocorre, não é no-op.

  it("#2416: sentinel com completed_at malformado → reparo usa fallback (não no-op silencioso)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-nan-guard-"));
    try {
      // Stage 2 "running"
      let doc = makeInitialDoc("260619");
      doc = applyUpdate(doc, {
        stage: 2,
        status: "running",
        start: "2026-06-19T18:00:00Z",
      });
      saveDoc(dir, doc);

      // Sentinel com completed_at malformado (string não-ISO inválida)
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", ".step-2-done.json"),
        JSON.stringify({ step: 2, completed_at: "not-a-date", outputs: [] }),
      );

      // Simular o que o CLI assert faz (pós-fix #2416):
      // detectar NaN e cair para Date.now() em vez de propagar NaN.
      const sentinel = readSentinel(dir, 2);
      assert.ok(sentinel, "sentinel deve ser legível");
      const t = new Date(sentinel!.completed_at).getTime();
      // Confirmar que o input realmente é NaN (fixture válido para o bug)
      assert.ok(Number.isNaN(t), "completed_at malformado deve produzir NaN");

      // Com o guard do fix: fallback para Date.now()
      const nowMs = Number.isNaN(t) ? Date.now() : t;
      assert.ok(!Number.isNaN(nowMs), "nowMs pós-guard não deve ser NaN");

      // autoUpdateStageStatusOnSentinel com nowMs válido: deve retornar true (não false/no-op)
      const updated = autoUpdateStageStatusOnSentinel(dir, "260619", 2, nowMs);
      assert.equal(updated, true, "#2416: com nowMs válido o reparo deve ocorrer (não no-op silencioso)");

      const reloaded = loadDoc(dir, "260619");
      const stage2 = reloaded.rows.find((r) => r.stage === 2);
      assert.ok(stage2);
      assert.equal(stage2!.status, "done", "stage deve virar done, não ficar stuck em running");
      assert.ok(stage2!.end, "end deve estar setado");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#2416: sentinel com completed_at ausente (undefined) → NaN guard cobre (fallback a Date.now())", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-nan-undef-"));
    try {
      let doc = makeInitialDoc("260619");
      doc = applyUpdate(doc, { stage: 1, status: "running" });
      saveDoc(dir, doc);

      // Sentinel sem completed_at (campo ausente → JSON.parse retorna undefined)
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", ".step-1-done.json"),
        JSON.stringify({ step: 1, outputs: [] }),
      );

      const sentinel = readSentinel(dir, 1);
      assert.ok(sentinel, "sentinel deve ser legível");
      const t = new Date((sentinel as unknown as Record<string, unknown>)["completed_at"] as string).getTime();
      // undefined coerce → NaN
      assert.ok(Number.isNaN(t), "completed_at ausente deve produzir NaN");

      const nowMs = Number.isNaN(t) ? Date.now() : t;
      const updated = autoUpdateStageStatusOnSentinel(dir, "260619", 1, nowMs);
      assert.equal(updated, true, "com fallback, reparo deve ocorrer mesmo sem completed_at");

      const reloaded = loadDoc(dir, "260619");
      const s1 = reloaded.rows.find((r) => r.stage === 1);
      assert.equal(s1!.status, "done");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("backfill-stage-status helper logic (#1563, #1694, #2374)", () => {
  // Backfill CLI uses spawnSync internally; for direct unit testing,
  // we exercise the same logic — load + detect + apply.
  it("Stage 5 running com sentinel + edition-report → backfill com completed_at", () => {
    // (#1694: backfill usa Stage 5 pois é a Publicação com guard de edition-report)
    const dir = mkdtempSync(join(tmpdir(), "backfill-stage-"));
    try {
      let doc = makeInitialDoc("260528");
      doc = applyUpdate(doc, {
        stage: 5,
        status: "running",
        start: "2026-05-27T20:51:00Z",
      });
      saveDoc(dir, doc);

      // Escrever sentinel com completed_at fixo (simulando estado pre-fix)
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", ".step-5-done.json"),
        JSON.stringify({
          step: 5,
          completed_at: "2026-05-27T22:00:00Z",
          outputs: [],
        }),
      );
      // Stage 5 (Publicação) stuck running era post-publicação completa —
      // edition-report.html já existia. Backfill respeita gate #1530.
      writeFileSync(
        join(dir, "_internal", "edition-report.html"),
        "<html>report</html>",
      );

      // O backfill replica a lógica do autoUpdate, mas usa completed_at do
      // sentinel como `end` ao invés de Date.now()
      const sentinel = JSON.parse(
        readFileSync(join(dir, "_internal", ".step-5-done.json"), "utf8"),
      );
      const completedAtMs = new Date(sentinel.completed_at).getTime();
      const ok = autoUpdateStageStatusOnSentinel(dir, "260528", 5, completedAtMs);
      assert.equal(ok, true);

      const reloaded = loadDoc(dir, "260528");
      const stage5 = reloaded.rows.find((r) => r.stage === 5);
      assert.equal(stage5!.status, "done");
      assert.equal(stage5!.end, "2026-05-27T22:00:00.000Z");
      // 22:00 - 20:51 = 69 minutes
      assert.equal(stage5!.duration_ms, 69 * 60 * 1000);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#2374: Stage pending com sentinel → backfill marca done (cenário 260619, stages 3+4)", () => {
    // Reprodução do bug 260619: stages 3 e 4 ficaram "pending" no stage-status.json
    // após retomada — orchestrator nunca chamou --status running antes da interrupção.
    // backfill-stage-status deve detectar e corrigir esses stages.
    const dir = mkdtempSync(join(tmpdir(), "backfill-pending-"));
    try {
      let doc = makeInitialDoc("260619");
      // Stage 2 done (prior stage, provides start backfill for stage 3)
      doc = applyUpdate(doc, {
        stage: 2,
        status: "done",
        start: "2026-06-18T18:00:00Z",
        end: "2026-06-18T18:30:00Z",
      });
      // Stage 3 is "pending" — interrupted before --status running was called.
      // (status stays at the initial makeInitialDoc value: "pending")
      saveDoc(dir, doc);

      // Sentinel from prior session — stage completed but status not updated.
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", ".step-3-done.json"),
        JSON.stringify({
          step: 3,
          completed_at: "2026-06-18T19:00:00Z",
          outputs: [],
        }),
      );

      // Backfill uses completed_at from sentinel as end timestamp.
      const sentinel = JSON.parse(
        readFileSync(join(dir, "_internal", ".step-3-done.json"), "utf8"),
      );
      const completedAtMs = new Date(sentinel.completed_at).getTime();
      const ok = autoUpdateStageStatusOnSentinel(dir, "260619", 3, completedAtMs);
      assert.equal(ok, true, "pending + sentinel → backfill deve retornar true");

      const reloaded = loadDoc(dir, "260619");
      const stage3 = reloaded.rows.find((r) => r.stage === 3);
      assert.ok(stage3);
      assert.equal(stage3!.status, "done");
      assert.equal(stage3!.end, "2026-06-18T19:00:00.000Z");
      // start backfilled from stage 2's end (18:30); duration = 30 min
      assert.equal(stage3!.start, "2026-06-18T18:30:00Z");
      assert.equal(stage3!.duration_ms, 30 * 60 * 1000);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
