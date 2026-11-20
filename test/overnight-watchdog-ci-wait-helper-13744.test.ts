/**
 * test/overnight-watchdog-ci-wait-helper-13744.test.ts
 *
 * #13744 (achado do review da #13727) — o heartbeat `ci_wait_running` que o
 * `scripts/lib/wait-pr-checks.sh` grava sozinho (#13725) vem de um processo em
 * background que SOBREVIVE à morte do coordenador. Contado como atividade
 * comum, ele segurava o STALL por até ~2h45 (teto do helper) em vez de 45 min.
 * Agora o evento (`details.source = "wait-pr-checks"`) só conta até
 * `CI_WAIT_SESSION_GRACE_MS` depois do último beacon da sessão (#12676).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_WAIT_SESSION_GRACE_MS,
  ciWaitHelperCap,
  diagnoseWatchdogActivity,
  getLastCiWaitHelperActivity,
  getLastRunLogActivity,
  resolveRunActivity,
  withCiWaitHelperHeartbeat,
  type SessionHeartbeatSource,
} from "../scripts/overnight-watchdog.ts";

const MIN = 60_000;
const SESSION = "e9072c78-6e80-4fee-b8f9-ef521636bf99";
const ED = "261120";

describe("helpers puros (#13744)", () => {
  it("sem beacon da sessão, o heartbeat do helper nunca conta", () => {
    assert.equal(ciWaitHelperCap(null), null);
  });

  it("cap = beacon + graça", () => {
    assert.equal(ciWaitHelperCap({ ts: 1000 }), 1000 + CI_WAIT_SESSION_GRACE_MS);
  });

  it("withCiWaitHelperHeartbeat só vence se for mais recente", () => {
    const a = { ts: 5000, source: "plan.json mtime" };
    assert.deepEqual(withCiWaitHelperHeartbeat(a, null), a);
    assert.deepEqual(withCiWaitHelperHeartbeat(a, 4000), a);
    assert.equal(withCiWaitHelperHeartbeat(a, 6000).ts, 6000);
    assert.match(withCiWaitHelperHeartbeat(a, 6000).source, /wait-pr-checks/);
  });
});

describe("resolveRunActivity com heartbeat do wait-pr-checks (#13744)", () => {
  let root: string;
  let planPath: string;

  const writePlan = (planAgeMin: number) => {
    const dir = join(root, "data", "overnight", ED);
    mkdirSync(dir, { recursive: true });
    planPath = join(dir, "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({ started_at: new Date(Date.now() - 4 * 60 * MIN).toISOString(), stall_events: [], session_id: SESSION }),
      "utf-8",
    );
    const old = new Date(Date.now() - planAgeMin * MIN);
    utimesSync(planPath, old, old);
  };

  const writeLog = (events: Array<{ ageMin: number; source?: string; agent?: string; edition?: string }>) => {
    const lines = events.map((e) =>
      JSON.stringify({
        timestamp: new Date(Date.now() - e.ageMin * MIN).toISOString(),
        level: "info",
        agent: e.agent ?? "overnight",
        edition: e.edition ?? ED,
        message: "ci_wait_running",
        details: e.source ? { source: e.source, pr: "1", elapsed_min: 15, running: 1 } : { pr: "1" },
      }),
    );
    writeFileSync(join(root, "data", "run-log.jsonl"), lines.join("\n") + "\n", "utf-8");
  };

  const sessions = (beaconAgeMin: number | null) => (): readonly SessionHeartbeatSource[] =>
    beaconAgeMin === null
      ? []
      : [{ kind: "overnight", sessionId: SESSION, lastHeartbeat: new Date(Date.now() - beaconAgeMin * MIN).toISOString() }];

  const diagnose = (ts: number, source: string) =>
    diagnoseWatchdogActivity({
      aammdd: ED,
      dryRun: false,
      lastActivityMs: ts,
      lastSource: source,
      nowMs: Date.now(),
      thresholdMin: 45,
      isHealthyIdle: false,
    }).action;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "watchdog-ciwait-13744-"));
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("REGRESSÃO: coordenador morto há 100 min + helper gravando há 2 min = STALL", () => {
    writePlan(100);
    writeLog([{ ageMin: 2, source: "wait-pr-checks" }]);
    const activity = resolveRunActivity(root, "overnight", ED, planPath, sessions(100));
    assert.equal(diagnose(activity.ts, activity.source), "stall", `veio ${activity.source}`);
  });

  it("heartbeat do helper não entra em getLastRunLogActivity", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeLog([{ ageMin: 2, source: "wait-pr-checks" }]);
    assert.equal(getLastRunLogActivity(root, ED, "overnight"), null);
  });

  it("plano sem beacon da sessão: o helper não conta", () => {
    writePlan(100);
    writeLog([{ ageMin: 2, source: "wait-pr-checks" }]);
    const activity = resolveRunActivity(root, "overnight", ED, planPath, sessions(null));
    assert.equal(diagnose(activity.ts, activity.source), "stall");
  });

  it("helper conta até a graça depois do beacon (coordenador vivo esperando CI)", () => {
    writePlan(60);
    // beacon há 50 min; helper há 35 min (15 min depois do beacon, dentro da graça)
    writeLog([{ ageMin: 35, source: "wait-pr-checks" }]);
    const activity = resolveRunActivity(root, "overnight", ED, planPath, sessions(50));
    assert.match(activity.source, /wait-pr-checks/);
    assert.equal(diagnose(activity.ts, activity.source), "no_stall");
  });

  it("só os heartbeats dentro da graça contam: o mais novo fora dela é ignorado", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeLog([
      { ageMin: 40, source: "wait-pr-checks" },
      { ageMin: 2, source: "wait-pr-checks" },
    ]);
    const beacon = Date.now() - 50 * MIN;
    const ts = getLastCiWaitHelperActivity(root, ED, "overnight", ciWaitHelperCap({ ts: beacon }));
    assert.ok(ts !== null && Math.abs(Date.now() - 40 * MIN - ts) < MIN, `veio ${ts}`);
  });

  it("ci_wait_running gravado pelo próprio coordenador (sem source) segue contando", () => {
    writePlan(100);
    writeLog([{ ageMin: 2 }]);
    const activity = resolveRunActivity(root, "overnight", ED, planPath, sessions(null));
    assert.equal(diagnose(activity.ts, activity.source), "no_stall");
  });

  it("heartbeat do helper com agente de outra rodada (develop) não conta pro overnight", () => {
    writePlan(100);
    writeLog([{ ageMin: 2, source: "wait-pr-checks", agent: "develop" }]);
    const activity = resolveRunActivity(root, "overnight", ED, planPath, sessions(1));
    // o beacon fresco (1 min) já cobre — o que importa é a fonte não ser o helper
    assert.doesNotMatch(activity.source, /wait-pr-checks/);
  });
});
