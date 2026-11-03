import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { recordUnitTimeline, recordTrainMergedTimeline } from "../scripts/lib/overnight-unit-timeline.ts";
import { buildTimelineRows } from "../scripts/render-overnight-timeline.ts";

const start = "2026-11-03T12:00:00.000Z";
const end = "2026-11-03T12:10:00.000Z";

it("updates every issue in a batch, preserves prior events and unrelated entries", () => {
  const plan = { issues: [{ number: 1, timeline: { dispatch: start, pr_opened: start } }, { number: 2 }, { number: 3 }] };
  const next = recordUnitTimeline(plan, [1, 2], "dispatch", end) as typeof plan;
  assert.deepEqual(next.issues[0], plan.issues[0]);
  assert.equal(next.issues[1].timeline?.dispatch, end);
  assert.equal(next.issues[2], plan.issues[2]);
  assert.equal(plan.issues[1].timeline, undefined);
  assert.deepEqual(recordUnitTimeline(next, [1, 2], "dispatch", end), next);
});

it("dict identity distinguishes repositories with the same issue number", () => {
  const plan = { issues: { "21": { status: "elegivel" }, "vjpixel/diaria-design#21": { status: "elegivel" } } };
  const next = recordUnitTimeline(plan, ["vjpixel/diaria-design#21"], "merged", end) as any;
  assert.deepEqual(next.issues["21"], plan.issues["21"]);
  assert.equal(next.issues["vjpixel/diaria-design#21"].timeline.merged, end);
  assert.equal(next.issues["vjpixel/diaria-design#21"].number, undefined);
  assert.equal(recordUnitTimeline(plan, [21], "unknown", end), plan);
  assert.equal(recordUnitTimeline(plan, [21], "merged", "invalid"), plan);
});

it("wave CLI and lifecycle CLI populate a renderable timeline without manual plan edits", () => {
  const root = mkdtempSync(join(tmpdir(), "timeline-12011-"));
  const round = join(root, "data/overnight/261103b");
  mkdirSync(round, { recursive: true });
  const path = join(round, "plan.json");
  writeFileSync(path, JSON.stringify({ issues: [{ number: 1, batch: null }, { number: 2, batch: null }] }));
  const run = (script: string, args: string[]) => execFileSync(process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts", script), ...args], { cwd: root, encoding: "utf8" });
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  try {
    run("record-overnight-wave.ts", ["--plan", path, "--units", "1;2"]);
    const dispatch = read().issues[0].timeline.dispatch;
    assert.ok(Number.isFinite(Date.parse(dispatch)));
    // Repeating the wave repairs a legacy missing timestamp with the original time.
    const legacy = read();
    delete legacy.issues[1].timeline;
    writeFileSync(path, JSON.stringify(legacy));
    run("record-overnight-wave.ts", ["--plan", path, "--units", "1;2"]);
    assert.equal(read().issues[1].timeline.dispatch, dispatch);
    assert.equal(read().waves.length, 1);
    for (const message of ["pr_opened", "fix_iteration", "merged"]) {
      run("log-event.ts", ["--edition", "261103b", "--agent", "overnight", "--message", message,
        "--details", JSON.stringify({ issues: [1], pr: 100, tentativa: 3 })]);
    }
    const plan = read();
    assert.equal(plan.issues[0].timeline.dispatch, dispatch);
    assert.ok(plan.issues[0].timeline.pr_opened);
    assert.ok(plan.issues[0].timeline.fix_iteration_3);
    assert.ok(plan.issues[0].timeline.merged);
    assert.equal(plan.issues[1].timeline.merged, undefined);
    const rows = buildTimelineRows(plan);
    assert.notEqual(rows[0].durationMs, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("confirmed train merges persist for every member before report.md exists", () => {
  const root = mkdtempSync(join(tmpdir(), "train-timeline-12011-"));
  const path = join(root, "plan.json");
  writeFileSync(path, JSON.stringify({ issues: {
    "1": { pr: 100, timeline: { dispatch: start } }, "2": { pr: "#100" }, "3": { pr: 101 },
  } }));
  try {
    recordTrainMergedTimeline(path, [100], end);
    recordTrainMergedTimeline(path, [100], "2026-11-03T13:00:00Z");
    const plan = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(plan.issues["1"].timeline.merged, end);
    assert.equal(plan.issues["1"].timeline.dispatch, start);
    assert.equal(plan.issues["2"].timeline.merged, end);
    assert.equal(plan.issues["3"].timeline, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
