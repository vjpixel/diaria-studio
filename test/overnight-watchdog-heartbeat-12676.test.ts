/**
 * test/overnight-watchdog-heartbeat-12676.test.ts
 *
 * #12676 — rodada overnight 261110c: o watchdog abriu o alarme #12644 ("STALL
 * detectado", P1, fonte `plan.json mtime`, 50 min) com a rodada viva. O
 * coordenador esperava CI e 10 subagentes de uma onda sem gravar `plan.json`
 * nem run-log; o heartbeat do session-registry estava fresco.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diagnoseWatchdogActivity,
  findActiveRun,
  resolveRunActivity,
  sessionHeartbeatActivity,
  withSessionHeartbeat,
  type SessionHeartbeatSource,
} from "../scripts/overnight-watchdog.ts";
import { registerSession, heartbeat } from "../scripts/lib/session-registry.ts";

const MIN = 60_000;
const SESSION = "dc129be3-ef1a-4b7c-aa8c-9ea975967929";

describe("sessionHeartbeatActivity / withSessionHeartbeat (#12676)", () => {
  const now = Date.parse("2026-11-10T09:10:00Z");
  const rec = (over: Partial<SessionHeartbeatSource>): SessionHeartbeatSource => ({
    kind: "overnight",
    sessionId: SESSION,
    lastHeartbeat: new Date(now - 2 * MIN).toISOString(),
    active_worktrees: 10,
    ...over,
  });

  it("acha o heartbeat da sessão do plan.json, com os worktrees em voo", () => {
    const hb = sessionHeartbeatActivity([rec({})], "overnight", SESSION);
    assert.deepEqual(hb, { ts: now - 2 * MIN, activeWorktrees: 10 });
  });

  it("outra sessão do mesmo kind (outra rodada, outra máquina) não conta", () => {
    assert.equal(sessionHeartbeatActivity([rec({ sessionId: "outra" })], "overnight", SESSION), null);
  });

  it("kind diferente não conta", () => {
    assert.equal(sessionHeartbeatActivity([rec({ kind: "develop" })], "overnight", SESSION), null);
  });

  it("plan.json sem session_id (legado) → null, comportamento anterior", () => {
    assert.equal(sessionHeartbeatActivity([rec({})], "overnight", undefined), null);
    assert.equal(sessionHeartbeatActivity([rec({})], "overnight", ""), null);
  });

  it("heartbeat ilegível é ignorado", () => {
    assert.equal(sessionHeartbeatActivity([rec({ lastHeartbeat: "lixo" })], "overnight", SESSION), null);
  });

  it("heartbeat mais recente vence o mtime do plan.json e nomeia a fonte", () => {
    const out = withSessionHeartbeat(
      { ts: now - 50 * MIN, source: "plan.json mtime" },
      { ts: now - 2 * MIN, activeWorktrees: 10 },
    );
    assert.equal(out.ts, now - 2 * MIN);
    assert.match(out.source, /session-registry heartbeat, 10 worktree\(s\) em voo/);
  });

  it("heartbeat mais velho que o plan.json não muda nada", () => {
    const fileActivity = { ts: now - 5 * MIN, source: "plan.json mtime" };
    assert.deepEqual(withSessionHeartbeat(fileActivity, { ts: now - 60 * MIN, activeWorktrees: 0 }), fileActivity);
    assert.deepEqual(withSessionHeartbeat(fileActivity, null), fileActivity);
  });
});

describe("resolveRunActivity com o session-registry real (#12676)", () => {
  let root: string;
  let planPath: string;

  const writePlan = (sessionId: string | undefined, planAgeMin: number) => {
    const dir = join(root, "data", "overnight", "261110c");
    mkdirSync(dir, { recursive: true });
    planPath = join(dir, "plan.json");
    const plan: Record<string, unknown> = {
      started_at: new Date(Date.now() - 4 * 60 * MIN).toISOString(),
      stall_events: [],
    };
    if (sessionId) plan.session_id = sessionId;
    writeFileSync(planPath, JSON.stringify(plan), "utf-8");
    const old = new Date(Date.now() - planAgeMin * MIN);
    utimesSync(planPath, old, old);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "watchdog-hb-12676-"));
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("REGRESSÃO: plan parado 50 min + heartbeat recente + 10 worktrees = sem alarme", () => {
    writePlan(SESSION, 50);
    const startedAt = new Date(Date.now() - 4 * 60 * MIN).toISOString();
    registerSession(root, "overnight", SESSION, { tag: "host-300", startedAt });
    heartbeat(root, "overnight", SESSION, { active_worktrees: 10 }, "host-300", new Date(Date.now() - 2 * MIN).toISOString());

    const activity = resolveRunActivity(root, "overnight", "261110c", planPath);
    assert.ok(Date.now() - activity.ts < 5 * MIN, `veio ${(Date.now() - activity.ts) / MIN} min (${activity.source})`);
    assert.match(activity.source, /session-registry heartbeat, 10 worktree\(s\) em voo/);

    const diagnosis = diagnoseWatchdogActivity({
      aammdd: "261110c",
      dryRun: false,
      lastActivityMs: activity.ts,
      lastSource: activity.source,
      nowMs: Date.now(),
      thresholdMin: 45,
      isHealthyIdle: false,
    });
    assert.equal(diagnosis.action, "no_stall");
    assert.notEqual(findActiveRun(root, "overnight"), null, "rodada viva continua vigiada");
  });

  it("controle: heartbeat também parado há 50 min → continua STALL (o sinal não mascara rodada morta)", () => {
    writePlan(SESSION, 50);
    registerSession(root, "overnight", SESSION, { tag: "host-300", startedAt: new Date(Date.now() - 4 * 60 * MIN).toISOString() });
    heartbeat(root, "overnight", SESSION, { active_worktrees: 10 }, "host-300", new Date(Date.now() - 55 * MIN).toISOString());

    const activity = resolveRunActivity(root, "overnight", "261110c", planPath);
    const diagnosis = diagnoseWatchdogActivity({
      aammdd: "261110c",
      dryRun: false,
      lastActivityMs: activity.ts,
      lastSource: activity.source,
      nowMs: Date.now(),
      thresholdMin: 45,
      isHealthyIdle: false,
    });
    assert.equal(diagnosis.action, "stall");
    assert.equal(activity.source, "plan.json mtime");
  });

  it("heartbeat fresco de OUTRA sessão overnight não mascara o stall desta rodada", () => {
    writePlan(SESSION, 50);
    registerSession(root, "overnight", "sessao-de-outra-maquina", { tag: "host-neo", startedAt: new Date(Date.now() - 60 * MIN).toISOString() });
    heartbeat(root, "overnight", "sessao-de-outra-maquina", {}, "host-neo", new Date(Date.now() - 1 * MIN).toISOString());

    const activity = resolveRunActivity(root, "overnight", "261110c", planPath);
    assert.equal(activity.source, "plan.json mtime");
    assert.ok(Date.now() - activity.ts >= 49 * MIN);
  });

  it("leitor de sessões injetável: plan sem session_id ignora o registry", () => {
    writePlan(undefined, 50);
    const fake = () => [{ kind: "overnight" as const, sessionId: SESSION, lastHeartbeat: new Date().toISOString() }];
    const activity = resolveRunActivity(root, "overnight", "261110c", planPath, fake);
    assert.equal(activity.source, "plan.json mtime");
  });
});
