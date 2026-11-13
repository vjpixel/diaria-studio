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
import { parseMode } from "../scripts/failover/neo-takeover.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
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
