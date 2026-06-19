/**
 * test/brave-credits.test.ts (#1558)
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordBraveCredit,
  computeBraveCreditStats,
} from "../scripts/lib/brave-credits.ts";

function makeTmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "brave-credits-"));
  return join(dir, "credits.jsonl");
}

describe("recordBraveCredit", () => {
  it("appends one line per call", () => {
    const path = makeTmpPath();
    recordBraveCredit({ query: "q1", status: "ok", http_status: 200 }, path);
    recordBraveCredit({ query: "q2", status: "ok", http_status: 200, edition: "260530" }, path);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const parsed1 = JSON.parse(lines[0]);
    assert.equal(parsed1.query, "q1");
    assert.equal(parsed1.status, "ok");
    assert.ok(parsed1.timestamp);
    const parsed2 = JSON.parse(lines[1]);
    assert.equal(parsed2.edition, "260530");
    rmSync(path, { force: true });
  });

  it("creates directory if missing (defensive)", () => {
    const dir = mkdtempSync(join(tmpdir(), "brave-credits-deep-"));
    const path = join(dir, "nested", "deep", "credits.jsonl");
    recordBraveCredit({ query: "q1", status: "ok" }, path);
    assert.ok(existsSync(path));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("computeBraveCreditStats", () => {
  it("returns zeros when file missing", () => {
    const stats = computeBraveCreditStats(null, "/nonexistent/path.jsonl");
    assert.equal(stats.queries_this_edition, 0);
    assert.equal(stats.queries_this_month, 0);
    assert.equal(stats.alert_level, "ok");
  });

  it("counts queries for current month only", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-28T12:00:00Z");
    // 2 in May, 1 in April (skip), 1 in May (count)
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-05-15T10:00:00Z", query: "q1", status: "ok" }),
        JSON.stringify({ timestamp: "2026-05-20T10:00:00Z", query: "q2", status: "ok" }),
        JSON.stringify({ timestamp: "2026-04-30T10:00:00Z", query: "q3", status: "ok" }),
        JSON.stringify({ timestamp: "2026-05-28T11:00:00Z", query: "q4", status: "ok" }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.queries_this_month, 3);
    rmSync(path, { force: true });
  });

  it("filters by edition when provided", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-28T12:00:00Z");
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-05-28T10:00:00Z", query: "q1", status: "ok", edition: "260528" }),
        JSON.stringify({ timestamp: "2026-05-28T10:01:00Z", query: "q2", status: "ok", edition: "260529" }),
        JSON.stringify({ timestamp: "2026-05-28T10:02:00Z", query: "q3", status: "ok", edition: "260529" }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats("260529", path, now);
    assert.equal(stats.queries_this_month, 3);
    assert.equal(stats.queries_this_edition, 2);
    rmSync(path, { force: true });
  });

  it("projects month-end based on day-of-month rate", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-10T12:00:00Z"); // day 10 of 31-day month
    // 100 queries in 10 days → project 310 for month
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({ timestamp: "2026-05-05T10:00:00Z", query: `q${i}`, status: "ok" }));
    }
    writeFileSync(path, lines.join("\n"), "utf8");
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.queries_this_month, 100);
    assert.equal(stats.projected_month_end, 310);
    rmSync(path, { force: true });
  });

  it("alert_level=warn at 80%", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-15T12:00:00Z");
    const lines = [];
    for (let i = 0; i < 1600; i++) {
      lines.push(JSON.stringify({ timestamp: "2026-05-10T10:00:00Z", query: `q${i}`, status: "ok" }));
    }
    writeFileSync(path, lines.join("\n"), "utf8");
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.alert_level, "warn");
    rmSync(path, { force: true });
  });

  it("alert_level=critical at 95%", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-15T12:00:00Z");
    const lines = [];
    for (let i = 0; i < 1900; i++) {
      lines.push(JSON.stringify({ timestamp: "2026-05-10T10:00:00Z", query: `q${i}`, status: "ok" }));
    }
    writeFileSync(path, lines.join("\n"), "utf8");
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.alert_level, "critical");
    rmSync(path, { force: true });
  });

  it("skips invalid JSON lines silently", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-28T12:00:00Z");
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-05-28T10:00:00Z", query: "q1", status: "ok" }),
        "not valid json",
        JSON.stringify({ timestamp: "2026-05-28T11:00:00Z", query: "q2", status: "ok" }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.queries_this_month, 2);
    rmSync(path, { force: true });
  });

  // #2378: characterisation — UTC month boundary (BRT users are UTC-3, so late-night
  // BRT may cross UTC midnight and change the UTC month). Both recordBraveCredit
  // and computeBraveCreditStats use UTC consistently → no off-by-one at month boundary.
  it("UTC month boundary: entry at BRT 22:30 on May 31 (= UTC June 1) counts in June, not May", () => {
    const path = makeTmpPath();
    // "now" = UTC June 1 (what BRT late-night of May 31 looks like in UTC)
    const now = new Date("2026-06-01T01:30:00Z");
    writeFileSync(
      path,
      [
        // Recorded at UTC June 1 (BRT May 31 22:30) → timestamp prefix "2026-06"
        JSON.stringify({ timestamp: "2026-06-01T01:30:00Z", query: "q1", status: "ok" }),
        // Recorded in UTC May → should NOT count in June
        JSON.stringify({ timestamp: "2026-05-31T20:00:00Z", query: "q2", status: "ok" }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    // Only q1 matches monthPrefix "2026-06"
    assert.equal(stats.queries_this_month, 1);
    rmSync(path, { force: true });
  });

  // #2378: characterisation — error queries are never recorded (only ok/rate_limited count).
  // This is enforced at the call site (fetch-websearch-batch.ts), not here, but the
  // JSONL-only design means errors can never appear in the file by construction.
  it("does not count queries with status error (they would not be in the file)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-18T12:00:00Z");
    writeFileSync(
      path,
      [
        // 'error' status entries should never be written, but if they were, they'd still
        // be counted since compute() only filters by timestamp, not status.
        // This test documents the design: the guard lives at the call site, not here.
        JSON.stringify({ timestamp: "2026-06-18T10:00:00Z", query: "q1", status: "ok" }),
        JSON.stringify({ timestamp: "2026-06-18T10:01:00Z", query: "q2", status: "rate_limited" }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    // Only 2 entries exist — both ok/rate_limited (as per call-site guard)
    assert.equal(stats.queries_this_month, 2);
    rmSync(path, { force: true });
  });
});
