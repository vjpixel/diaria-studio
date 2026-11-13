/**
 * test/neo-takeover-plan-12982.test.ts (#12982)
 *
 * Planejamento puro do `scripts/failover/neo-takeover.ts`. Nenhum teste roda
 * PowerShell nem toca o KV.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildArmPlan,
  buildDisarmScript,
  buildTriggerPs,
  decideArmPrecondition,
  failoverTaskName,
  isAgentWorktreePath,
  parseStatusOutput,
  planLeaseRelease,
  psQuote,
  toLocalSchedule,
} from "../scripts/lib/failover/neo-takeover-plan.ts";
import { main as takeoverMain, parseMode } from "../scripts/failover/neo-takeover.ts";
import { SCHEDULER_LEASE_KEY } from "../scripts/lib/failover/scheduler-lease.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import { assessCodeFreshness } from "../scripts/lib/sync-code-freshness.ts";
import { standbySkippedSync } from "../scripts/run-task.ts";

const REPO = "C:\\Users\\editor\\Projects\\diaria-studio";
const NODE = "C:\\Program Files\\nodejs\\node.exe";

describe("buildArmPlan", () => {
  const plan = buildArmPlan({ tasks: SCHEDULED_TASKS, nodePath: NODE, repoRoot: REPO, localOffsetMin: -180 });

  it("arma exatamente as tasks critical, com prefixo Diaria-Failover-", () => {
    const critical = SCHEDULED_TASKS.filter((t) => t.failover === "critical").map((t) => t.name);
    assert.deepEqual(plan.entries.map((e) => e.registryName).sort(), [...critical].sort());
    for (const e of plan.entries) assert.match(e.windowsName, /^Diaria-Failover-/);
    assert.equal(failoverTaskName("Diaria-Clarice-Novos"), "Diaria-Failover-Clarice-Novos");
  });

  it("nenhuma task catchup/skip entra no script", () => {
    for (const t of SCHEDULED_TASKS.filter((x) => x.failover !== "critical")) {
      assert.doesNotMatch(plan.script, new RegExp(`--task ${t.name} `), t.name);
    }
  });

  it("toda ação passa --failover-standby e o diretório de trabalho do repo", () => {
    const actions = plan.script.split("\n").filter((l) => l.startsWith("$action"));
    assert.equal(actions.length, plan.entries.length);
    for (const a of actions) {
      assert.match(a, /--failover-standby/);
      assert.match(a, /-WorkingDirectory 'C:\\Users\\editor\\Projects\\diaria-studio'/);
      assert.match(a, /scripts\\run-task\.ts/);
    }
  });

  it("remove as Diaria-Failover-* antigas antes de registrar (task que deixou de ser critical não sobra)", () => {
    const lines = plan.script.split("\n");
    const unreg = lines.findIndex((l) => l.includes("Unregister-ScheduledTask"));
    const reg = lines.findIndex((l) => l.startsWith("Register-ScheduledTask"));
    assert.ok(unreg >= 0 && reg > unreg);
  });

  it("Brasília não gera aviso; outro fuso gera", () => {
    assert.deepEqual(plan.warnings, []);
    const lis = buildArmPlan({ tasks: SCHEDULED_TASKS, nodePath: NODE, repoRoot: REPO, localOffsetMin: 0 });
    assert.equal(lis.warnings.length, 1);
  });
});

describe("toLocalSchedule / buildTriggerPs", () => {
  it("daily 06:31 BRT em Lisboa (UTC+0) vira 09:31", () => {
    assert.deepEqual(toLocalSchedule({ kind: "daily", hour: 6, minute: 31 }, 0), { kind: "daily", hour: 9, minute: 31 });
  });

  it("weekly segunda 06:00 BRT em Tóquio (UTC+9) vira segunda 18:00; 23:00 BRT vira terça", () => {
    assert.deepEqual(toLocalSchedule({ kind: "weekly", dayOfWeek: "Monday", hour: 6, minute: 0 }, 540), {
      kind: "weekly",
      dayOfWeek: "Monday",
      hour: 18,
      minute: 0,
    });
    assert.deepEqual(toLocalSchedule({ kind: "weekly", dayOfWeek: "Monday", hour: 23, minute: 0 }, 0), {
      kind: "weekly",
      dayOfWeek: "Tuesday",
      hour: 2,
      minute: 0,
    });
  });

  it("daily 01:00 BRT em Nova York (UTC-5) vira 23:00 (dia anterior, irrelevante para daily)", () => {
    assert.deepEqual(toLocalSchedule({ kind: "daily", hour: 1, minute: 0 }, -300), { kind: "daily", hour: 23, minute: 0 });
  });

  it("weekly domingo 00:30 BRT em UTC-5 recua para sábado", () => {
    assert.equal(
      (toLocalSchedule({ kind: "weekly", dayOfWeek: "Sunday", hour: 0, minute: 30 }, -300) as { dayOfWeek: string }).dayOfWeek,
      "Saturday",
    );
  });

  it("interval não muda; monthly não tem trigger", () => {
    assert.deepEqual(toLocalSchedule({ kind: "interval", hours: 1 }, 0), { kind: "interval", hours: 1 });
    assert.match(buildTriggerPs({ kind: "interval", hours: 1 }), /-RepetitionInterval \(New-TimeSpan -Hours 1\)/);
    assert.match(buildTriggerPs({ kind: "daily", hour: 6, minute: 5 }), /-Daily -At '06:05'/);
    assert.match(buildTriggerPs({ kind: "weekly", dayOfWeek: "Monday", hour: 6, minute: 0 }), /-Weekly -DaysOfWeek Monday -At '06:00'/);
    assert.throws(() => buildTriggerPs({ kind: "monthly", day: 1, hour: 9, minute: 0 }));
  });

  it("psQuote dobra aspa simples", () => {
    assert.equal(psQuote("C:\\O'Brien"), "'C:\\O''Brien'");
  });
});

describe("pré-condição do --arm", () => {
  it("sinal presente passa; ausente/ilegível/indisponível exige --force", () => {
    assert.equal(decideArmPrecondition({ kind: "present", since: "2026-11-13T10:00:00Z" }, false).ok, true);
    assert.equal(decideArmPrecondition({ kind: "absent" }, false).ok, false);
    assert.equal(decideArmPrecondition({ kind: "error", error: "HTTP 500" }, false).ok, false);
    assert.equal(decideArmPrecondition({ kind: "unavailable", reason: "sem token" }, false).ok, false);
    assert.equal(decideArmPrecondition({ kind: "absent" }, true).ok, true);
  });
});

describe("--disarm: liberação do lease", () => {
  it("só apaga lease do Neo", () => {
    assert.equal(planLeaseRelease({ kind: "ok", lease: { host: "neo", until: "2026-11-13T18:00:00Z" } }).action, "delete");
    assert.equal(planLeaseRelease({ kind: "ok", lease: { host: "300", until: "2026-11-13T18:00:00Z" } }).action, "keep");
    assert.equal(planLeaseRelease({ kind: "absent" }).action, "keep");
    assert.equal(planLeaseRelease({ kind: "error", error: "x" }).action, "keep");
  });

  it("o script de disarm só remove Diaria-Failover-*", () => {
    assert.match(buildDisarmScript(), /-TaskName 'Diaria-Failover-\*'/);
  });
});

describe("parseStatusOutput", () => {
  it("vazio, objeto único, array; ignora nome fora do prefixo", () => {
    assert.deepEqual(parseStatusOutput(""), []);
    assert.deepEqual(parseStatusOutput('{"name":"Diaria-Failover-Shorts-Instagram","state":"Ready"}'), [
      { name: "Diaria-Failover-Shorts-Instagram", state: "Ready" },
    ]);
    assert.equal(parseStatusOutput('[{"name":"Diaria-Failover-A","state":"Ready"},{"name":"Outra","state":"Ready"}]').length, 1);
  });
});

describe("isAgentWorktreePath", () => {
  it("reconhece worktree de agente nos dois separadores", () => {
    assert.equal(isAgentWorktreePath("C:\\Users\\x\\diaria-studio\\.claude\\worktrees\\agent-1"), true);
    assert.equal(isAgentWorktreePath("/home/x/diaria-studio/.claude/worktrees/agent-1"), true);
    assert.equal(isAgentWorktreePath(REPO), false);
  });
});

describe("run-task.ts: run do Neo não sincroniza o checkout", () => {
  it("standbySkippedSync não é sucesso disfarçado: up_to_date=false e WARN no log", () => {
    const r = standbySkippedSync();
    assert.equal(r.up_to_date, false);
    assert.equal(r.commits_behind, -1);
    assert.match(r.warnings.join("\n"), /pulado no Neo/);
  });
});

describe("parseMode", () => {
  it("exige exatamente um modo; --force só com --arm; flag desconhecida recusa", () => {
    assert.equal(parseMode([]).ok, false);
    assert.equal(parseMode(["--arm", "--disarm"]).ok, false);
    assert.equal(parseMode(["--disarm", "--force"]).ok, false);
    assert.equal(parseMode(["--arm", "--forca"]).ok, false);
    const ok = parseMode(["--arm", "--force", "--dry-run"]);
    assert.ok(ok.ok && ok.mode === "arm" && ok.force && ok.dryRun);
  });
});

describe("standbySkippedSync tem outcome próprio (#12982)", () => {
  it("outcome 'skipped', nunca 'already_up_to_date' falso", () => {
    assert.equal(standbySkippedSync().outcome, "skipped");
  });
});

describe("F6: parar antes de remover", () => {
  it("disarm e arm param as Running e esperam antes do Unregister", () => {
    for (const script of [buildDisarmScript(), buildArmPlan({ tasks: SCHEDULED_TASKS, nodePath: NODE, repoRoot: REPO, localOffsetMin: -180 }).script]) {
      const lines = script.split("\n");
      const stop = lines.findIndex((l) => l.includes("Stop-ScheduledTask"));
      const wait = lines.findIndex((l) => l.startsWith("while ("));
      const unreg = lines.findIndex((l) => l.includes("Unregister-ScheduledTask"));
      assert.ok(stop >= 0 && wait > stop && unreg > wait, script);
    }
  });

  it("lease corrompido não é liberado pelo --disarm", () => {
    assert.equal(planLeaseRelease({ kind: "invalid", error: "x" }).action, "keep");
  });
});

describe("neo-takeover main — orquestração com runPowerShell/openKv fingidos", () => {
  type Ps = { ok: boolean; stdout: string; stderr: string };
  function harness(opts: { ps?: (script: string, n: number) => Ps; kv?: Record<string, string>; kvOk?: boolean; put?: (k: string, v: string, store: Map<string, string>) => Promise<void> } = {}) {
    const store = new Map(Object.entries(opts.kv ?? {}));
    const scripts: string[] = [];
    const out: string[] = [];
    const deleted: string[] = [];
    const kv = {
      get: async (k: string) => (store.has(k) ? store.get(k)! : null),
      put: async (k: string, v: string) => (opts.put ? opts.put(k, v, store) : void store.set(k, v)),
      delete: async (k: string) => {
        deleted.push(k);
        store.delete(k);
      },
    };
    const deps = {
      runPowerShell: (s: string) => {
        scripts.push(s);
        return opts.ps ? opts.ps(s, scripts.length) : { ok: true, stdout: "", stderr: "" };
      },
      openKv: () => (opts.kvOk === false ? ({ ok: false, reason: "sem token" } as const) : ({ ok: true, kv } as const)),
      platform: "win32" as const,
      root: REPO,
      now: () => new Date("2026-11-13T12:00:00Z"),
      lastKnownLease: () => null,
      log: (m: string) => void out.push(m),
      err: (m: string) => void out.push(m),
    };
    return { store, scripts, out, deleted, deps };
  }

  it("--arm --dry-run mostra o plano sem sinal e sem --force, avisando", async () => {
    const h = harness();
    assert.equal(await takeoverMain(["--arm", "--dry-run"], h.deps), 0);
    assert.equal(h.scripts.length, 0);
    assert.match(h.out.join("\n"), /exigiria --force/);
  });

  it("--arm sem sinal e sem --force recusa", async () => {
    const h = harness();
    assert.equal(await takeoverMain(["--arm"], h.deps), 1);
    assert.equal(h.scripts.length, 0);
  });

  it("--arm --force: registra e grava o lease do Neo", async () => {
    const h = harness();
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 0);
    assert.equal(JSON.parse(h.store.get(SCHEDULER_LEASE_KEY)!).host, "neo");
  });

  it("F4: releitura mostra outro dono -> remove tarefas e NÃO apaga o lease alheio", async () => {
    const h = harness({
      put: async (k, _v, store) => void store.set(k, JSON.stringify({ host: "300", until: "2026-11-13T15:00:00Z" })),
    });
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.equal(h.deleted.length, 0);
    assert.match(h.scripts.at(-1)!, /Unregister-ScheduledTask/);
  });

  it("F4: releitura inconclusiva -> rollback apaga o lease", async () => {
    const h = harness({ put: async () => {} });
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.deepEqual(h.deleted, [SCHEDULER_LEASE_KEY]);
  });

  it("F4: gravação do lease lança -> rollback apaga o lease (a escrita pode ter chegado)", async () => {
    const h = harness({
      put: async () => {
        throw new Error("timeout");
      },
    });
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.deepEqual(h.deleted, [SCHEDULER_LEASE_KEY]);
  });

  it("F4: rollback do PowerShell que falha é logado", async () => {
    const h = harness({
      put: async () => {},
      ps: (_s, n) => (n === 1 ? { ok: true, stdout: "", stderr: "" } : { ok: false, stdout: "", stderr: "acesso negado" }),
    });
    assert.equal(await takeoverMain(["--arm", "--force"], h.deps), 1);
    assert.match(h.out.join("\n"), /remoção das tarefas FALHOU \(acesso negado\)/);
  });

  it("--disarm: não libera o lease se o Unregister falhou", async () => {
    const h = harness({
      kv: { [SCHEDULER_LEASE_KEY]: JSON.stringify({ host: "neo", until: "2026-11-13T15:00:00Z" }) },
      ps: () => ({ ok: false, stdout: "", stderr: "ainda em execução" }),
    });
    assert.equal(await takeoverMain(["--disarm"], h.deps), 1);
    assert.equal(h.deleted.length, 0);
  });

  it("--disarm: remove e libera o lease do Neo", async () => {
    const h = harness({ kv: { [SCHEDULER_LEASE_KEY]: JSON.stringify({ host: "neo", until: "2026-11-13T15:00:00Z" }) } });
    assert.equal(await takeoverMain(["--disarm"], h.deps), 0);
    assert.deepEqual(h.deleted, [SCHEDULER_LEASE_KEY]);
  });

  it("F5: --disarm com KV inacessível sai 1 com o horário de expiração", async () => {
    const h = harness({ kvOk: false });
    const d = {
      ...h.deps,
      lastKnownLease: () => ({ kind: "ok" as const, lease: { host: "neo" as const, until: "2026-11-13T18:00:00Z" }, seenAt: "x" }),
    };
    assert.equal(await takeoverMain(["--disarm"], d), 1);
    assert.match(h.out.join("\n"), /2026-11-13T18:00:00Z/);
  });
});

describe("sync pulado no Neo conta como sucesso no runner e como não verificado na frescura", () => {
  it("assessCodeFreshness(skipped) é unknown", () => {
    assert.equal(assessCodeFreshness({ outcome: "skipped", commits_behind: 0, up_to_date: true }).status, "unknown");
  });
});
