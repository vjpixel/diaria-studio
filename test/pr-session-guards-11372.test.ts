import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkPrSessionClaims } from "../scripts/lib/pr-session-claim-gate.ts";
import { checkPrOpenForPush } from "../scripts/check-pr-open-for-push.ts";

it("#11372: claim efetiva alheia barra merge de PR órfã, própria passa e expirada libera", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-claims-11372-"));
  const now = Date.parse("2026-10-27T21:00:00Z");
  try {
    mkdirSync(join(root, "data/sessions"), { recursive: true });
    const file = join(root, "data/sessions/develop-Neo-other.json");
    const record = { kind: "develop", sessionId: "other", machineTag: "Neo", startedAt: new Date(now - 3*3600000).toISOString(), lastHeartbeat: new Date(now - 2*3600000).toISOString(), claimed_issues: [11265, 10940] };
    writeFileSync(file, JSON.stringify(record));
    const check = (body: unknown, id = "mine", time = now) => checkPrSessionClaims(root, body, id, undefined, time);
    assert.match(check("Closes #11265\nCloses #10940").reason, /11265.*other.*develop\/Neo/);
    assert.equal(check("Closes #10940", "other").ok, true);
    assert.equal(check("Closes #3\nREFS #11265").ok, true);
    assert.equal(check("Closes #11265", "mine", now + 25*3600000).ok, true);
    assert.equal(check(undefined).ok, false);
    assert.equal(checkPrSessionClaims(root, "Closes #11265", "mine", "vjpixel/diaria-design", now).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("#11372: push só permite estado OPEN; MERGED/CLOSED exigem follow-up", () => {
  assert.equal(checkPrOpenForPush("OPEN").ok, true);
  for (const state of ["MERGED", "CLOSED"]) {
    const result = checkPrOpenForPush(state);
    assert.equal(result.ok, false);
    assert.match(result.reason, /abrir follow-up/);
  }
  for (const state of [undefined, null, "", "open"]) assert.equal(checkPrOpenForPush(state).ok, false);
});

it("#11372: CLI de pré-push consulta gh fresco e falha fechado", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-push-11372-"));
  try {
    const gh = join(root, "gh");
    writeFileSync(gh, `#!/bin/sh
[ "$*" = "pr view 11352 --json state" ] || exit 9
[ "$TEST_PR_STATE" != "FAIL" ] || exit 2
printf '%s\\n' "$TEST_PR_STATE"
`);
    chmodSync(gh, 0o755);
    for (const [payload, exit] of [[{state:"OPEN"},0], [{state:"MERGED"},1], [{state:"CLOSED"},1], [{},1], ["invalid",3], ["FAIL",3]] as const) {
      const r = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/check-pr-open-for-push.ts"), "--pr", "11352"], { encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_PR_STATE: typeof payload === "string" ? payload : JSON.stringify(payload) } });
      assert.equal(r.status, exit, r.stderr);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("#11372: fixer e implementador exigem o guard antes de cada re-push", () => {
  for (const agent of ["dev-fixer", "dev-implementador"]) {
    const text = readFileSync(`.claude/agents/${agent}.md`, "utf8");
    assert.match(text, /imediatamente antes de cada\npush\/re-push/);
    assert.match(text, /check-pr-open-for-push.ts --pr N/);
    assert.match(text, /preservar os commits locais/);
  }
});

it("#11372: gates serial e contínuo consultam claims com identidade da sessão", () => {
  const gate = readFileSync("scripts/check-continuo-merge-gate.ts", "utf8");
  assert.match(gate, /checkPrSessionClaims\(resolveRepoRoot\(\), payload.body, values\["session-id"\]/);
  assert.match(gate, /gateResult.action === "merge" && !claims.ok/);
  const review = readFileSync("hermes/scripts/continuo-pr-review.sh", "utf8");
  assert.match(review, /check-continuo-merge-gate.ts --pr "\$pr" --session-id "\$SESSION_ID"/);
  for (const skill of ["diaria-develop", "diaria-overnight"]) {
    assert.match(readFileSync(`.claude/skills/${skill}/SKILL.md`, "utf8"), /check-pr-session-claims.ts --pr \{N\} --session-id \{sessionId\}/);
  }
});
