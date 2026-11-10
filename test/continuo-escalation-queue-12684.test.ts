import { it } from "node:test";
import assert from "node:assert/strict";
import { overdueEscalation } from "../scripts/list-continuo-escalation-queue.ts";
const now = Date.parse("2026-11-10T15:00:00Z");
const labeled = (created_at: string, event = "labeled") => ({ event, label: { name: "continuo-escalado" }, created_at });
it("only escalations older than 24h enter the briefing queue", () => {
  assert.equal(overdueEscalation([labeled("2026-11-09T14:59:59Z")], now), "2026-11-09T14:59:59Z");
  assert.equal(overdueEscalation([labeled("2026-11-09T15:00:00Z")], now), null);
  assert.equal(overdueEscalation([], now), null);
});
it("removal clears the clock; reapplication starts a new clock", () => {
  const events = [labeled("2026-11-08T10:00:00Z"), labeled("2026-11-09T12:00:00Z", "unlabeled")];
  assert.equal(overdueEscalation(events, now), null);
  assert.equal(overdueEscalation([...events, labeled("2026-11-10T10:00:00Z")], now), null);
});

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
it("actual bash attention block preserves reason on first and recurring escalation", () => {
  const script = readFileSync(new URL("../hermes/scripts/continuo-pr-review.sh", import.meta.url), "utf8");
  const start = script.indexOf('      GATE_REASON=', script.indexOf('ESCALATE_STDERR_TMP="$(mktemp)"'));
  const block = script.slice(start, script.indexOf('      ;;', start));
  assert.ok(block.includes('ATENÇÃO:'));
  for (const firstTime of ["true", "false"]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail
redact_public_text() { printf '%s' "$1"; }
${block}
printf '%s' "$ESCALATED_RECURRING_PRS"`], {
      encoding: "utf8",
      env: { ...process.env, GATE_JSON: JSON.stringify({ reason: "draft — CI: pending\nrevisar" }), FIRST_TIME: firstTime, pr: "12351", ESCALATED_NEW: "0", ESCALATED_RECURRING: "0", ESCALATED_RECURRING_PRS: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("#12351 (draft — CI: pending revisar)"), result.stdout);
  }
});
