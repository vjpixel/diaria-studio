/**
 * test/sweep-continuo-orphan-sessions.test.ts (#10002)
 *
 * Regressão: ticks do contínuo que morrem cedo deixam
 * `data/sessions/continuo-*.json` sem encerrar (35 arquivos em 10/10/2026).
 * O sweep encerra só os seguros — e os casos "mantém" são o que impede a
 * limpeza de derrubar uma sessão viva ou soltar uma claim.
 *
 * Usa um repoRoot temporário: nunca toca o `data/sessions/` real (junction
 * OneDrive compartilhada entre máquinas).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planContinuoOrphanSweep,
  sweepContinuoOrphanSessions,
} from "../scripts/sweep-continuo-orphan-sessions.ts";
import { SOFT_STALE_MS, type SessionRecord } from "../scripts/lib/session-registry.ts";

const JOB = "5d791ef6fc2c";
const TAG = "300";
const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const OLD = new Date(NOW - SOFT_STALE_MS - 60_000).toISOString();
const FRESH = new Date(NOW - 10 * 60_000).toISOString();

function rec(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    kind: "continuo",
    machineTag: TAG,
    sessionId: `hermes-cron-${JOB}-${id}`,
    startedAt: OLD,
    lastHeartbeat: OLD,
    claimed_issues: [],
    ...over,
  } as SessionRecord;
}

const opts = { jobId: JOB, localTag: TAG, now: NOW, excludeSessionId: `hermes-cron-${JOB}-atual` };

describe("planContinuoOrphanSweep (#10002)", () => {
  it("tick velho sem claims e sem end → encerra (o caso da issue)", () => {
    const [c] = planContinuoOrphanSweep([rec("t1")], opts);
    assert.equal(c!.action, "end");
  });

  it("sessão do tick corrente nunca é encerrada", () => {
    const [c] = planContinuoOrphanSweep([rec("atual")], opts);
    assert.equal(c!.action, "keep");
  });

  it("com claimed_issues → mantém (encerrar soltaria a claim)", () => {
    const [c] = planContinuoOrphanSweep([rec("t2", { claimed_issues: [9912] })], opts);
    assert.equal(c!.action, "keep");
    assert.match(c!.reason, /#9912/);
  });

  it("heartbeat recente → mantém (tick possivelmente vivo)", () => {
    const [c] = planContinuoOrphanSweep([rec("t3", { lastHeartbeat: FRESH })], opts);
    assert.equal(c!.action, "keep");
  });

  it("outra máquina → mantém", () => {
    const [c] = planContinuoOrphanSweep([rec("t4", { machineTag: "neo" })], opts);
    assert.equal(c!.action, "keep");
  });

  it("timestamp ilegível ou no futuro → mantém", () => {
    const r = planContinuoOrphanSweep(
      [
        rec("t5", { lastHeartbeat: "lixo", startedAt: "lixo" }),
        rec("t6", { lastHeartbeat: new Date(NOW + 3_600_000).toISOString() }),
      ],
      opts,
    );
    assert.deepEqual(r.map((c) => c.action), ["keep", "keep"]);
  });

  it("outro job, outro kind ou sessionId sem o prefixo do cron → nem entra no plano", () => {
    const r = planContinuoOrphanSweep(
      [
        rec("x", { sessionId: "hermes-cron-outrojob-x" }),
        rec("y", { kind: "overnight" } as Partial<SessionRecord>),
        rec("z", { sessionId: "continuo-manual-123" }),
      ],
      opts,
    );
    assert.deepEqual(r, []);
  });
});

describe("sweepContinuoOrphanSessions — I/O num repo temporário (#10002)", () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "sweep-continuo-"));
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function write(r: SessionRecord): string {
    const p = join(root, "data", "sessions", `continuo-${r.machineTag}-${r.sessionId}.json`);
    writeFileSync(p, JSON.stringify(r), "utf8");
    return p;
  }

  it("encerra só o órfão; vivo, com claim, atual e ilegível ficam", () => {
    const orphan = write(rec("orfao"));
    const live = write(rec("vivo", { lastHeartbeat: FRESH }));
    const claimed = write(rec("claim", { claimed_issues: [1] }));
    const current = write(rec("atual"));
    const broken = join(root, "data", "sessions", `continuo-${TAG}-hermes-cron-${JOB}-quebrado.json`);
    writeFileSync(broken, "{ não é json", "utf8");

    const r = sweepContinuoOrphanSessions(root, { ...opts });
    assert.deepEqual(r.ended, [`hermes-cron-${JOB}-orfao`]);
    assert.deepEqual(r.errors, []);
    assert.equal(existsSync(orphan), false);
    for (const p of [live, claimed, current, broken]) assert.equal(existsSync(p), true, p);
  });

  it("dry-run não remove nada", () => {
    const p = write(rec("dry"));
    const r = sweepContinuoOrphanSessions(root, { ...opts, dryRun: true });
    assert.ok(r.plan.some((c) => c.action === "end" && c.sessionId.endsWith("-dry")));
    assert.deepEqual(r.ended, []);
    assert.equal(existsSync(p), true);
  });

  it("data/sessions ausente → nada a fazer, sem lançar", () => {
    const empty = mkdtempSync(join(tmpdir(), "sweep-continuo-vazio-"));
    try {
      const r = sweepContinuoOrphanSessions(empty, { ...opts });
      assert.deepEqual(r.ended, []);
      assert.equal(readdirSync(empty).length, 0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
