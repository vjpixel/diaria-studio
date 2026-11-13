/**
 * test/failover-task-gate-12982.test.ts (#12982)
 *
 * Gate de failover no ponto de entrada comum (`scripts/run-task.ts`): a task
 * `critical` do 300 cede quando o lease é do Neo; o Neo só roda `critical`;
 * config ausente é fail-open no 300 e fail-closed no Neo. Só fakes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runFailoverGate, failoverRole } from "../scripts/lib/failover/task-gate.ts";
import { SCHEDULER_LEASE_KEY, serializeLease } from "../scripts/lib/failover/scheduler-lease.ts";
import { main as runTaskMain } from "../scripts/run-task.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-11-13T12:00:00.000Z");
const PLATFORM = { ops_state_kv: { namespace_id: "ns-fake" } };
const ENV = { CLOUDFLARE_ACCOUNT_ID: "acc-fake", CLOUDFLARE_WORKERS_TOKEN: "tok-fake" };

function kvWith(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    makeKv: () => ({
      get: async (k: string) => (store.has(k) ? store.get(k)! : null),
      put: async (k: string, v: string) => void store.set(k, v),
    }),
  };
}

const neoLease = serializeLease({ host: "neo", until: new Date(T0.getTime() + 5 * 3600_000).toISOString() });
const critical = { name: "Diaria-Shorts-Instagram", failover: "critical" as const };

describe("failoverRole", () => {
  it("sem flag é o 300; --failover-standby é o Neo", () => {
    assert.equal(failoverRole(["--task", "X"]), "300");
    assert.equal(failoverRole(["--task", "X", "--failover-standby"]), "neo");
  });
});

describe("runFailoverGate", () => {
  it("task não-critical no 300 passa direto, sem montar cliente KV", async () => {
    let made = 0;
    const r = await runFailoverGate({ name: "Diaria-GA4-Sync", failover: "catchup" }, ["--task", "Diaria-GA4-Sync"], {
      env: ENV,
      platformConfig: PLATFORM,
      makeKv: () => {
        made++;
        throw new Error("não devia montar");
      },
    });
    assert.equal(r.proceed, true);
    assert.equal(made, 0);
  });

  it("task não-critical no Neo é recusada (exit 1)", async () => {
    const r = await runFailoverGate({ name: "Diaria-GA4-Sync", failover: "catchup" }, ["--failover-standby"], {
      env: ENV,
      platformConfig: PLATFORM,
      makeKv: kvWith({}).makeKv,
    });
    assert.equal(r.proceed, false);
    assert.equal(!r.proceed && r.code, 1);
  });

  it("critical no 300 com lease do Neo: cede com exit 0", async () => {
    const kv = kvWith({ [SCHEDULER_LEASE_KEY]: neoLease });
    const r = await runFailoverGate(critical, [], { env: ENV, platformConfig: PLATFORM, makeKv: kv.makeKv, now: () => T0 });
    assert.equal(r.proceed, false);
    assert.equal(!r.proceed && r.code, 0);
  });

  it("critical no Neo com lease do Neo: roda", async () => {
    const kv = kvWith({ [SCHEDULER_LEASE_KEY]: neoLease });
    const r = await runFailoverGate(critical, ["--failover-standby"], { env: ENV, platformConfig: PLATFORM, makeKv: kv.makeKv, now: () => T0 });
    assert.equal(r.proceed, true);
  });

  it("config do KV ausente: 300 fail-open, Neo fail-closed (exit 1)", async () => {
    const deps = { env: {}, platformConfig: PLATFORM, makeKv: kvWith({}).makeKv, now: () => T0 };
    assert.equal((await runFailoverGate(critical, [], deps)).proceed, true);
    const s = await runFailoverGate(critical, ["--failover-standby"], deps);
    assert.equal(s.proceed, false);
    assert.equal(!s.proceed && s.code, 1);
  });

  it("DIARIA_FAILOVER_LEASE=off só vale no 300", async () => {
    const kv = kvWith({ [SCHEDULER_LEASE_KEY]: neoLease });
    const env = { ...ENV, DIARIA_FAILOVER_LEASE: "off" };
    assert.equal((await runFailoverGate(critical, [], { env, platformConfig: PLATFORM, makeKv: kv.makeKv, now: () => T0 })).proceed, true);
    const kvVazio = kvWith({});
    const s = await runFailoverGate(critical, ["--failover-standby"], { env, platformConfig: PLATFORM, makeKv: kvVazio.makeKv, now: () => T0 });
    assert.equal(s.proceed, false, "no Neo o kill switch é ignorado: sem lease e sem sinal, não age");
  });
});

describe("run-task.ts main — gate integrado", () => {
  it("critical do 300 com lease do Neo: sai 0 sem rodar nenhum passo", async () => {
    const kv = kvWith({ [SCHEDULER_LEASE_KEY]: neoLease });
    let steps = 0;
    const log = console.log;
    console.log = () => {};
    try {
      const code = await runTaskMain(["--task", "Diaria-Shorts-Instagram"], ROOT, {
        gate: { env: ENV, platformConfig: PLATFORM, makeKv: kv.makeKv, now: () => T0 },
        readDotenv: () => ({}),
        runner: {
          syncCode: () => {
            throw new Error("não devia sincronizar");
          },
          execStep: () => {
            steps++;
            return { status: 0, output: "" } as never;
          },
        },
      });
      assert.equal(code, 0);
      assert.equal(steps, 0);
    } finally {
      console.log = log;
    }
  });

  it("task não-critical rodada com --failover-standby: exit 1 sem rodar", async () => {
    const err = console.error;
    console.error = () => {};
    try {
      const code = await runTaskMain(["--task", "Diaria-GA4-Sync", "--failover-standby"], ROOT, {
        gate: { env: ENV, platformConfig: PLATFORM, makeKv: kvWith({}).makeKv },
        readDotenv: () => ({}),
        runner: {
          syncCode: () => {
            throw new Error("não devia sincronizar");
          },
        },
      });
      assert.equal(code, 1);
    } finally {
      console.error = err;
    }
  });
});
