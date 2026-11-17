import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { leakedClaims, planClaimLeaks, type ClaimLookup } from "../scripts/lib/continuo-claim-leak.ts";
import { sessionsFromRegistry } from "../scripts/check-continuo-claim-leaks.ts";

const table: Record<string, ClaimLookup> = {
  "#13386": { state: "open", hasOpenPr: true },
  "#13387": { state: "closed", hasOpenPr: false },
  "#13388": { state: "closed", hasOpenPr: false },
  "#1": { state: "open", hasOpenPr: false },
  "#2": { state: null, hasOpenPr: null },
};
const lookup = (c: string) => table[c];

describe("claim leak (#13418)", () => {
  it("caso real: PR aberto + issues fechadas não vazam", () => {
    assert.deepEqual(leakedClaims(["#13386", "#13387", "#13388"], lookup), []);
  });
  it("issue aberta sem PR vaza; indeterminado não", () => {
    assert.deepEqual(leakedClaims(["#1", "#2", "#13386"], lookup), ["#1"]);
  });
  it("heartbeat recente não alarma", () => {
    assert.deepEqual(planClaimLeaks([{ sessionId: "s", claims: ["#1"], heartbeatAgeMin: 10 }], lookup), []);
    const r = planClaimLeaks([{ sessionId: "s", claims: ["#1"], heartbeatAgeMin: 90 }], lookup);
    assert.equal(r[0].leaked[0], "#1");
  });
  it("parse do registry une claims locais e de outro repo", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    const s = sessionsFromRegistry(
      JSON.stringify({
        sessions: [
          { sessionId: "a", claimed_issues: [5], claimed_foreign_issues: ["o/r#7"], lastHeartbeat: "2026-11-17T10:00:00Z" },
          { sessionId: "b", claimed_issues: [], lastHeartbeat: "2026-11-17T10:00:00Z" },
        ],
      }),
      now,
    );
    assert.equal(s.length, 1);
    assert.deepEqual(s[0].claims, ["#5", "o/r#7"]);
    assert.equal(s[0].heartbeatAgeMin, 120);
  });
});
