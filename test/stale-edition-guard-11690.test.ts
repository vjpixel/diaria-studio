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
import {
  acquireEditionLock, decideEditionLock, EDITION_LOCK_TTL_MS, formatLockAge, readEditionLock, releaseEditionLock,
} from "../scripts/lib/edition-lock.ts";

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
      spawnSync(process.execPath, ["--import", "tsx", "scripts/stale-edition-guard.ts", "check", "--edition-dir", dir, "--step", "4"], {
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
      spawnSync(process.execPath, ["--import", "tsx", "scripts/stale-edition-guard.ts", "check", "--edition-dir", dir, "--step", "4", ...extra], {
        cwd: ROOT, encoding: "utf8",
      });
    assert.equal(run([]).status, 4);
    assert.equal(run(["--force"]).status, 0);
  });
});

describe("tombstone de conclusão (release --complete-stage)", () => {
  const tomb = (host: string, completed_stage = 4) => ({
    ...lock(host), released_at: "2026-10-30T15:00:00Z", completed_stage,
  });
  const guard = (dir: string, extra: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/stale-edition-guard.ts", "check", "--edition-dir", dir, "--step", "4", ...extra], {
      cwd: ROOT, encoding: "utf8",
    });
  it("tombstone de outro host + sentinel ausente → remote_completed", () => {
    const v = assessStaleEdition({ step: 4, sentinelSteps: [1, 2, 3], lock: tomb("neo"), localHost: "300" });
    assert.equal(v.ok, false);
    assert.equal(v.signals[0].kind, "remote_completed");
  });
  it("tombstone da mesma máquina, ou de stage anterior, não bloqueia", () => {
    assert.equal(assessStaleEdition({ step: 4, sentinelSteps: [1, 2, 3], lock: tomb("300"), localHost: "300" }).ok, true);
    assert.equal(assessStaleEdition({ step: 4, sentinelSteps: [1, 2, 3], lock: tomb("neo", 3), localHost: "300" }).ok, true);
  });
  it("sentinel presente sem outputs: tombstone remoto bloqueia só com outputsMissing", () => {
    const base = { step: 4, sentinelSteps: [1, 2, 3, 4], lock: tomb("neo"), localHost: "300" };
    assert.equal(assessStaleEdition(base).ok, true);
    assert.equal(assessStaleEdition({ ...base, outputsMissing: true }).ok, false);
  });
  it("release com completedStage regrava tombstone; acquire o trata como ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-"));
    acquireEditionLock(dir, { sessionId: "a", stage: 4, host: "neo" });
    assert.equal(releaseEditionLock(dir, { sessionId: "a", completedStage: 4, host: "neo" }), "released");
    const r = readEditionLock(dir)!;
    assert.equal(r.completed_stage, 4);
    assert.ok(r.released_at);
    assert.equal(acquireEditionLock(dir, { sessionId: "b", stage: 4, host: "300" }).action, "acquired");
    assert.equal(readEditionLock(dir)!.released_at, undefined);
  });
  it("release sem completedStage segue apagando", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-"));
    acquireEditionLock(dir, { sessionId: "a", stage: 4 });
    releaseEditionLock(dir, { sessionId: "a" });
    assert.equal(readEditionLock(dir), null);
  });
  it("CLI: tombstone de outro host → exit 4; sentinel presente só bloqueia com --outputs-missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "edition-lock.json"), JSON.stringify(tomb("outro-host")));
    assert.equal(guard(dir, []).status, 4);
    writeFileSync(join(dir, "_internal", ".step-4-done.json"), "{}");
    assert.equal(guard(dir, []).status, 0);
    assert.equal(guard(dir, ["--outputs-missing"]).status, 4);
  });
});

describe("lock malformado e idade", () => {
  it("host não-string na trava lida vira host desconhecido e bloqueia (fail-closed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "edition-lock.json"), JSON.stringify({ ...lock("x"), host: 42, stage: "4" }));
    const l = readEditionLock(dir)!;
    assert.equal(l.host, "");
    assert.equal(assessStaleEdition({ step: 4, sentinelSteps: [], lock: l, localHost: "300" }).ok, false);
  });
  it("trava vencida de host desconhecido → stale_other_host", () => {
    const l = { ...lock("x"), host: "" };
    const d = decideEditionLock(l, { stage: 4, now: Date.parse("2026-10-30T10:00:00Z") + EDITION_LOCK_TTL_MS + 1, sessionId: "n", host: "300" });
    assert.equal(d.action, "stale_other_host");
  });
  it("formatLockAge: Infinity/negativo/curto não viram número enganoso", () => {
    assert.equal(formatLockAge(Number.POSITIVE_INFINITY), "ilegível");
    assert.match(formatLockAge(-5000), /futuro/);
    assert.equal(formatLockAge(20_000), "há menos de 1 min");
    assert.equal(formatLockAge(10 * 60_000), "há 10 min");
    assert.equal(formatLockAge(5 * 3_600_000 + 1), "há 5 h");
  });
});

describe("assessStaleEdition: lock com stage ilegível", () => {
  it("stage não numérico de outro host bloqueia (fail-closed)", () => {
    const l = { ...lock("outro-host"), stage: "x" as unknown as number };
    assert.equal(assessStaleEdition({ step: 4, sentinelSteps: [], lock: l, localHost: "300" }).ok, false);
  });
});
