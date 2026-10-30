/**
 * #11690 — Stage 4/5 não podem re-rodar por cima de edição aprovada em outra
 * máquina quando data/ (OneDrive) está defasado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assessStaleEdition } from "../scripts/lib/stale-edition-guard.ts";
import { decideEditionLock, EDITION_LOCK_TTL_MS } from "../scripts/lib/edition-lock.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = (host: string, stage = 4) => ({
  session_id: "s", host, stage, acquired_at: "", heartbeat_at: "2026-10-29T10:00:00Z",
});

describe("assessStaleEdition", () => {
  it("sentinel ausente + lock de outro host → bloqueia", () => {
    const v = assessStaleEdition({ step: 4, sentinelSteps: [1, 2, 3], lock: lock("neo"), localHost: "300" });
    assert.equal(v.ok, false);
    assert.equal(v.signals[0].kind, "remote_lock");
  });
  it("sentinel do stage seguinte presente → bloqueia", () => {
    const v = assessStaleEdition({ step: 4, sentinelSteps: [1, 2, 3, 5], lock: null, localHost: "300" });
    assert.equal(v.ok, false);
    assert.deepEqual(v.signals, [{ kind: "later_sentinel", step: 5 }]);
  });
  it("mesma máquina, estado consistente → ok", () => {
    assert.equal(assessStaleEdition({ step: 4, sentinelSteps: [1, 2, 3], lock: lock("300"), localHost: "300" }).ok, true);
    assert.equal(assessStaleEdition({ step: 4, sentinelSteps: [1, 2, 3], lock: null, localHost: "300" }).ok, true);
  });
  it("lock de outro host de stage anterior não bloqueia", () => {
    assert.equal(assessStaleEdition({ step: 4, sentinelSteps: [1, 2, 3], lock: lock("neo", 2), localHost: "300" }).ok, true);
  });
});

describe("edition-lock: took_stale de host diferente", () => {
  const base = { stage: 4, now: Date.parse("2026-10-30T15:00:00Z") + EDITION_LOCK_TTL_MS };
  it("host diferente → stale_other_host, nada gravado; --force assume", () => {
    const d = decideEditionLock(lock("neo"), { ...base, sessionId: "n", host: "300" });
    assert.equal(d.action, "stale_other_host");
    assert.equal(d.record, undefined);
    assert.equal(decideEditionLock(lock("neo"), { ...base, sessionId: "n", host: "300", force: true }).action, "took_stale");
  });
  it("mesmo host vencido segue took_stale", () => {
    assert.equal(decideEditionLock(lock("300"), { ...base, sessionId: "n", host: "300" }).action, "took_stale");
  });
});

describe("CLI", () => {
  it("exit 4 com sentinel ausente e stage seguinte presente; 0 no caminho normal", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const run = () =>
      spawnSync("npx", ["tsx", "scripts/stale-edition-guard.ts", "check", "--edition-dir", dir, "--step", "4"], {
        cwd: ROOT, encoding: "utf8",
      });
    assert.equal(run().status, 0);
    writeFileSync(join(dir, "_internal", ".step-5-done.json"), "{}");
    const r = run();
    assert.equal(r.status, 4);
    assert.match(r.stderr, /Aguardar o sync/);
  });
  it("lock de outro host: exit 4; --force sai 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "edition-lock.json"), JSON.stringify(lock("outro-host")));
    const run = (extra: string[]) =>
      spawnSync("npx", ["tsx", "scripts/stale-edition-guard.ts", "check", "--edition-dir", dir, "--step", "4", ...extra], {
        cwd: ROOT, encoding: "utf8",
      });
    assert.equal(run([]).status, 4);
    assert.equal(run(["--force"]).status, 0);
  });
});
