/**
 * test/failover-task-gate-12982.test.ts (#12982)
 *
 * Gate de failover no ponto de entrada comum (`scripts/run-task.ts`): a task
 * `critical` do 300 cede quando o lease é do Neo; o Neo só roda `critical`;
 * config ausente é fail-open no 300 e fail-closed no Neo. Só fakes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  failoverRole,
  mergeDotenvUnderEnv,
  readPlatformConfigFile,
  runFailoverGate,
  type FailoverGateDeps,
} from "../scripts/lib/failover/task-gate.ts";
import { SCHEDULER_LEASE_KEY, serializeLease, type LastKnownLease } from "../scripts/lib/failover/scheduler-lease.ts";
import { execTsxStep } from "../scripts/lib/task-runner.ts";
import { GATE_KV_TIMEOUT_MS, main as runTaskMain, standbyCheckoutRefusal } from "../scripts/run-task.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Raiz fingida com data/editions (guard das tasks dos Shorts) para os testes que rodam passos. */
function fakeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "run-task-root-12982-"));
  mkdirSync(join(dir, "data", "editions"), { recursive: true });
  return dir;
}
const T0 = new Date("2026-11-13T12:00:00.000Z");
const PLATFORM = { kind: "ok" as const, value: { ops_state_kv: { namespace_id: "ns-fake" } } };
const ENV = { CLOUDFLARE_ACCOUNT_ID: "acc-fake", CLOUDFLARE_WORKERS_TOKEN: "tok-fake" };

function kvWith(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const seen: { accountId?: string }[] = [];
  return {
    store,
    seen,
    makeKv: (cfg: { accountId: string }) => {
      seen.push(cfg);
      return {
        get: async (k: string) => (store.has(k) ? store.get(k)! : null),
        put: async (k: string, v: string) => void store.set(k, v),
      };
    },
  };
}

function memMemory(initial: LastKnownLease | null = null) {
  const m = { value: initial, load: () => m.value, save: (v: LastKnownLease) => void (m.value = v) };
  return m;
}

const neoLease = serializeLease({ host: "neo", until: new Date(T0.getTime() + 5 * 3600_000).toISOString() });
const critical = { name: "Diaria-Shorts-Instagram", failover: "critical" as const };
const linux = { platform: "linux" as const };

function deps(over: Partial<FailoverGateDeps> = {}): FailoverGateDeps {
  return { env: ENV, platformConfig: PLATFORM, makeKv: kvWith({}).makeKv, now: () => T0, ...linux, memory: memMemory(), ...over };
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; out: string[]; err: string[] }> {
  const log = console.log;
  const error = console.error;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    return { value: await fn(), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("failoverRole", () => {
  it("sem flag é o 300; --failover-standby é o Neo", () => {
    assert.equal(failoverRole(["--task", "X"]), "300");
    assert.equal(failoverRole(["--task", "X", "--failover-standby"]), "neo");
  });
});

describe("mergeDotenvUnderEnv / readPlatformConfigFile", () => {
  it("ambiente vence o .env, mas valor vazio do ambiente não apaga o do arquivo", () => {
    const m = mergeDotenvUnderEnv({ A: "arquivo", B: "arquivo", C: "arquivo" }, { A: "env", B: "", C: "   ", D: "só-env" });
    assert.equal(m.A, "env");
    assert.equal(m.B, "arquivo");
    assert.equal(m.C, "arquivo");
    assert.equal(m.D, "só-env");
  });

  it("F9: distingue platform.config.json ausente de ilegível", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-12982-"));
    try {
      assert.equal(readPlatformConfigFile(dir).kind, "absent");
      writeFileSync(join(dir, "platform.config.json"), "{nope");
      assert.equal(readPlatformConfigFile(dir).kind, "unreadable");
      writeFileSync(join(dir, "platform.config.json"), "{}");
      assert.equal(readPlatformConfigFile(dir).kind, "ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runFailoverGate", () => {
  it("task não-critical no 300 passa direto, sem montar cliente KV", async () => {
    let made = 0;
    const r = await runFailoverGate({ name: "Diaria-GA4-Sync", failover: "catchup" }, "300", deps({
      makeKv: () => {
        made++;
        throw new Error("não devia montar");
      },
    }));
    assert.equal(r.proceed, true);
    assert.equal(made, 0);
  });

  it("task não-critical no Neo é recusada (exit 1)", async () => {
    const r = await runFailoverGate({ name: "Diaria-GA4-Sync", failover: "catchup" }, "neo", deps());
    assert.equal(!r.proceed && r.code, 1);
  });

  it("F10: task critical no Windows sem --failover-standby é recusada", async () => {
    const r = await runFailoverGate(critical, "300", deps({ platform: "win32" }));
    assert.equal(!r.proceed && r.code, 1);
    assert.match(r.message ?? "", /--failover-standby/);
    const naoCritical = await runFailoverGate({ name: "Diaria-GA4-Sync", failover: "catchup" }, "300", deps({ platform: "win32" }));
    assert.equal(naoCritical.proceed, true, "só a critical é recusada no Windows");
  });

  it("F2: critical no 300 com lease do Neo cede com exit 0, em stderr (warn)", async () => {
    const kv = kvWith({ [SCHEDULER_LEASE_KEY]: neoLease });
    const r = await runFailoverGate(critical, "300", deps({ makeKv: kv.makeKv }));
    assert.equal(!r.proceed && r.code, 0);
    assert.equal(r.level, "warn");
  });

  it("F2: lease do Neo renovado com o 300 rodando: exit 1 com a instrução de --disarm", async () => {
    const memory = memMemory({
      kind: "ok",
      lease: { host: "neo", until: new Date(T0.getTime() + 3600_000).toISOString() },
      seenAt: T0.toISOString(),
    });
    const kv = kvWith({ [SCHEDULER_LEASE_KEY]: neoLease });
    const r = await runFailoverGate(critical, "300", deps({ makeKv: kv.makeKv, memory }));
    assert.equal(!r.proceed && r.code, 1);
    assert.match(r.message ?? "", /300 de pé cedendo para o Neo/);
  });

  it("critical no Neo com lease do Neo: roda", async () => {
    const kv = kvWith({ [SCHEDULER_LEASE_KEY]: neoLease });
    assert.equal((await runFailoverGate(critical, "neo", deps({ makeKv: kv.makeKv }))).proceed, true);
  });

  it("F1: Neo armado sem lease e sem sinal de queda: exit 1 em stderr, não 0 silencioso", async () => {
    const r = await runFailoverGate(critical, "neo", deps({ makeKv: kvWith({}).makeKv }));
    assert.equal(!r.proceed && r.code, 1);
    assert.equal(r.level, "error");
  });

  it("Neo cedendo ao lease ativo do 300: exit 0 (o 300 voltou)", async () => {
    const lease300 = serializeLease({ host: "300", until: new Date(T0.getTime() + 3600_000).toISOString() });
    const r = await runFailoverGate(critical, "neo", deps({ makeKv: kvWith({ [SCHEDULER_LEASE_KEY]: lease300 }).makeKv }));
    assert.equal(!r.proceed && r.code, 0);
  });

  it("F9: config do KV ausente: 300 fail-open com WARN, Neo fail-closed (exit 1)", async () => {
    const p = await runFailoverGate(critical, "300", deps({ env: {} }));
    assert.equal(p.proceed, true);
    assert.equal(p.level, "warn");
    const s = await runFailoverGate(critical, "neo", deps({ env: {} }));
    assert.equal(!s.proceed && s.code, 1);
  });

  it("F9: platform.config.json ausente e ilegível aparecem distintos na mensagem", async () => {
    const a = await runFailoverGate(critical, "300", deps({ platformConfig: { kind: "absent" } }));
    assert.match(a.message ?? "", /ausente/);
    const u = await runFailoverGate(critical, "300", deps({ platformConfig: { kind: "unreadable", error: "EACCES" } }));
    assert.match(u.message ?? "", /ilegível \(EACCES\)/);
  });

  it("F3: config ausente no 300 com último lease conhecido do Neo é fail-closed", async () => {
    const memory = memMemory({ kind: "ok", lease: { host: "neo", until: T0.toISOString() }, seenAt: T0.toISOString() });
    const r = await runFailoverGate(critical, "300", deps({ env: {}, memory }));
    assert.equal(!r.proceed && r.code, 1);
  });

  it("DIARIA_FAILOVER_LEASE=off só vale no 300", async () => {
    const env = { ...ENV, DIARIA_FAILOVER_LEASE: "off" };
    assert.equal((await runFailoverGate(critical, "300", deps({ env, makeKv: kvWith({ [SCHEDULER_LEASE_KEY]: neoLease }).makeKv }))).proceed, true);
    const s = await runFailoverGate(critical, "neo", deps({ env }));
    assert.equal(s.proceed, false, "no Neo o kill switch é ignorado: sem lease e sem sinal, não age");
  });
});

describe("run-task.ts main — gate integrado", () => {
  it("critical do 300 com lease do Neo: sai 0 sem rodar nenhum passo, WARN no stderr", async () => {
    const kv = kvWith({ [SCHEDULER_LEASE_KEY]: neoLease });
    let steps = 0;
    const { value: code, err } = await quiet(() =>
      runTaskMain(["--task", "Diaria-Shorts-Instagram"], ROOT, {
        gate: { env: ENV, platformConfig: PLATFORM, makeKv: kv.makeKv, now: () => T0, platform: "linux", memory: memMemory() },
        readDotenv: () => ({}),
        runner: {
          syncCode: () => {
            throw new Error("não devia sincronizar");
          },
          execStep: () => {
            steps++;
            return { code: 0, output: "" };
          },
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(steps, 0);
    assert.ok(err.some((l) => l.includes("cede")));
  });

  it("task não-critical rodada com --failover-standby: exit 1 sem rodar", async () => {
    const { value: code } = await quiet(() =>
      runTaskMain(["--task", "Diaria-GA4-Sync", "--failover-standby"], fakeRoot(), {
        gate: { env: ENV, platformConfig: PLATFORM, makeKv: kvWith({}).makeKv, platform: "linux", memory: memMemory() },
        readDotenv: () => ({}),
        readGitBranch: () => "master",
        runner: {
          syncCode: () => {
            throw new Error("não devia sincronizar");
          },
        },
      }),
    );
    assert.equal(code, 1);
  });

  it("run do Neo: env do gate vem do .env, sem syncCode no runner, e os passos veem var só do .env", async () => {
    const root = fakeRoot();
    const kv = kvWith({ [SCHEDULER_LEASE_KEY]: neoLease });
    const stepEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const { value: code } = await quiet(() =>
      runTaskMain(["--task", "Diaria-Shorts-Instagram", "--failover-standby"], root, {
        // Sem gate.env: o env do gate sai do .env + processEnv.
        gate: { platformConfig: PLATFORM, makeKv: kv.makeKv, now: () => T0, platform: "linux", memory: memMemory() },
        readDotenv: () => ({ ...ENV, SO_NO_DOTENV_12982: "do-arquivo", CLOUDFLARE_ACCOUNT_ID: "acc-do-arquivo" }),
        readGitBranch: () => "master",
        processEnv: { CLOUDFLARE_ACCOUNT_ID: "acc-do-ambiente", CLOUDFLARE_WORKERS_TOKEN: "" },
        execTsxStep: (_s, _a, _c, _m, env) => {
          stepEnvs.push(env);
          return { code: 0, output: "" };
        },
        // Sem syncCode aqui: sob node:test o runner lança se o sync real fosse usado.
        runner: { logPathOverride: join(tmpdir(), `run-task-12982-${process.pid}.log`) },
      }),
    );
    assert.equal(code, 0);
    assert.ok(stepEnvs.length > 0, "os passos rodaram");
    for (const env of stepEnvs) {
      assert.equal(env?.SO_NO_DOTENV_12982, "do-arquivo", "passo standby vê var só do .env");
      assert.equal(env?.CLOUDFLARE_ACCOUNT_ID, "acc-do-ambiente", "process.env vence o arquivo");
      assert.equal(env?.CLOUDFLARE_WORKERS_TOKEN, "tok-fake", "valor vazio do ambiente não apaga o do arquivo");
    }
    assert.equal(kv.seen[0]?.accountId, "acc-do-ambiente", "o gate usou o env mesclado");
    rmSync(join(tmpdir(), `run-task-12982-${process.pid}.log`), { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("run do 300 de task critical não passa env próprio aos passos", async () => {
    const root = fakeRoot();
    const kv = kvWith({});
    let usedReal = 0;
    const { value: code } = await quiet(() =>
      runTaskMain(["--task", "Diaria-Shorts-Instagram"], root, {
        gate: { env: ENV, platformConfig: PLATFORM, makeKv: kv.makeKv, now: () => T0, platform: "linux", memory: memMemory() },
        readDotenv: () => ({}),
        execTsxStep: () => {
          usedReal++;
          return { code: 0, output: "" };
        },
        runner: {
          syncCode: () => ({ ...{ outcome: "already_up_to_date" as const }, message: "", branch_before: "master", warnings: [], proceed: true, up_to_date: true, commits_behind: 0, preserved_stash: null, stale_autostash_count: 0 }),
          execStep: () => ({ code: 0, output: "" }),
          logPathOverride: join(tmpdir(), `run-task-12982b-${process.pid}.log`),
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(usedReal, 0, "o wrapper com env só existe na run do Neo");
    rmSync(join(tmpdir(), `run-task-12982b-${process.pid}.log`), { force: true });
    rmSync(root, { recursive: true, force: true });
  });
});

describe("#12993: run do Neo — checkout, .env e KV", () => {
  const standbyDeps = (over: Record<string, unknown> = {}) => ({
    gate: { platformConfig: PLATFORM, makeKv: kvWith({ [SCHEDULER_LEASE_KEY]: neoLease }).makeKv, now: () => T0, platform: "linux" as const, memory: memMemory() },
    readDotenv: () => ({ ...ENV }),
    readGitBranch: () => "master",
    execTsxStep: () => {
      throw new Error("não devia rodar passo");
    },
    runner: {
      syncCode: () => {
        throw new Error("não devia sincronizar");
      },
    },
    ...over,
  });

  it("checkout do Neo fora de master: exit 1 sem tocar o lease nem rodar passo", async () => {
    const root = fakeRoot();
    try {
      const kv = kvWith({ [SCHEDULER_LEASE_KEY]: neoLease });
      const { value: code, err } = await quiet(() =>
        runTaskMain(["--task", "Diaria-Shorts-Instagram", "--failover-standby"], root, {
          ...standbyDeps({ readGitBranch: () => "overnight/fix-123-x" }),
          gate: { platformConfig: PLATFORM, makeKv: kv.makeKv, now: () => T0, platform: "linux", memory: memMemory() },
        }),
      );
      assert.equal(code, 1);
      assert.equal(kv.seen.length, 0, "recusa antes do gate: o lease nem é lido");
      assert.ok(err.some((l) => /checkout em overnight\/fix-123-x, não em master/.test(l)), err.join("\n"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("branch não lida no Neo: exit 1 (fail-closed)", async () => {
    const root = fakeRoot();
    try {
      const { value: code } = await quiet(() => runTaskMain(["--task", "Diaria-Shorts-Instagram", "--failover-standby"], root, standbyDeps({ readGitBranch: () => null })));
      assert.equal(code, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("standbyCheckoutRefusal: master passa; feature branch, null e worktree de agente recusam", () => {
    assert.equal(standbyCheckoutRefusal("master", "C:\\repo"), null);
    assert.match(standbyCheckoutRefusal("feat/x", "C:\\repo") ?? "", /não em master/);
    assert.match(standbyCheckoutRefusal(null, "C:\\repo") ?? "", /não lida/);
    assert.match(standbyCheckoutRefusal("master", "C:\\repo\\.claude\\worktrees\\a") ?? "", /worktree de agente/);
  });

  it(".env ilegível (não ENOENT) no Neo: exit 1 com a causa real, não 'configuração do KV ausente'", async () => {
    const root = fakeRoot();
    try {
      const { value: code, err } = await quiet(() =>
        runTaskMain(["--task", "Diaria-Shorts-Instagram", "--failover-standby"], root, standbyDeps({
          readDotenv: () => {
            throw new Error(".env ilegível em X: EACCES: permission denied");
          },
        })),
      );
      assert.equal(code, 1);
      const all = err.join("\n");
      assert.match(all, /EACCES/);
      assert.doesNotMatch(all, /configuração do KV ausente/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(".env ilegível no 300: segue com WARN (o .env é complemento do EnvironmentFile)", async () => {
    const root = fakeRoot();
    try {
      const kv = kvWith({ [SCHEDULER_LEASE_KEY]: neoLease });
      const { value: code, err } = await quiet(() =>
        runTaskMain(["--task", "Diaria-Shorts-Instagram"], root, {
          gate: { env: ENV, platformConfig: PLATFORM, makeKv: kv.makeKv, now: () => T0, platform: "linux", memory: memMemory() },
          readDotenv: () => {
            throw new Error(".env ilegível em X: EACCES");
          },
        }),
      );
      assert.equal(code, 0, "cede ao lease do Neo como antes, sem quebrar pelo .env");
      assert.ok(err.some((l) => /WARN \.env ilegível/.test(l)), err.join("\n"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("teto do KV no caminho do gate é menor que o default de 30 s do cliente", () => {
    assert.ok(GATE_KV_TIMEOUT_MS <= 10_000);
  });
});

describe("execTsxStep com env (#12982)", () => {
  it("o processo do passo vê a variável passada no env", () => {
    const dir = mkdtempSync(join(tmpdir(), "step-env-12982-"));
    try {
      const script = join(dir, "print.ts");
      writeFileSync(script, "process.stdout.write(String(process.env.SO_NO_DOTENV_12982));\n");
      const r = execTsxStep(script, [], ROOT, undefined, { ...process.env, SO_NO_DOTENV_12982: "visto" });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /visto/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
