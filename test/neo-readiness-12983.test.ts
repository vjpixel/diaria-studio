/**
 * test/neo-readiness-12983.test.ts (#12983)
 *
 * Prontidão do Neo para a contingência do 300: checagens puras, agregador,
 * registro no KV, alarme do 300 e o CLI com dependências falsas. Nenhum teste
 * toca Doppler, gh, git real, rede ou KV.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateReadiness,
  classifyThreadsReadError,
  CRITICAL_SCRIPT_REQUIREMENTS,
  evaluateDataDir,
  evaluateGhAuth,
  evaluateGit,
  evaluateNodeModules,
  evaluateNodeVersion,
  evaluateSecret,
  evaluateToken,
  formatSummaryLine,
  formatTaskLines,
  NEO_READINESS_KV_KEY,
  parseReadinessRecord,
  serializeReadinessRecord,
  taskCheckIds,
  type CheckResult,
  type ReadinessReport,
} from "../scripts/lib/failover/neo-readiness.ts";
import {
  evaluateNeoReadinessAlarm,
  NEO_READINESS_RED_FINGERPRINT,
  NEO_READINESS_STALE_FINGERPRINT,
} from "../scripts/lib/failover/neo-readiness-alarm.ts";
import { main as readinessMain, parseDopplerNames, type ReadinessDeps } from "../scripts/failover/neo-readiness.ts";
import { isNeoMachine } from "../scripts/lib/machine-id.ts";
import { R2_ENV_VARS } from "../scripts/lib/r2-object-upload.ts";
import { getScheduledTaskByName, resolveFailoverTier, SCHEDULED_TASKS, type ScheduledTaskDefinition } from "../scripts/lib/scheduled-tasks.ts";

const NOW = new Date("2026-11-13T12:00:00Z");
const ok = (id: string): CheckResult => ({ id, status: "ok", detail: `${id} ok` });

describe("evaluateSecret", () => {
  it("presente no local e no Doppler: ok", () => {
    assert.equal(evaluateSecret(["KIT_API_KEY"], { KIT_API_KEY: "x" }, new Set(["KIT_API_KEY"])).status, "ok");
  });
  it("só no Doppler: falta, com a dica do sync-env", () => {
    const r = evaluateSecret(["KIT_API_KEY"], {}, new Set(["KIT_API_KEY"]));
    assert.equal(r.status, "fail");
    assert.match(r.detail, /sync-env/);
  });
  it("ausente nos dois: falta", () => {
    const r = evaluateSecret(["KIT_API_KEY"], { KIT_API_KEY: "  " }, new Set());
    assert.equal(r.status, "fail");
    assert.match(r.detail, /nem no Doppler/);
  });
  it("Doppler não consultado: decide pelo local", () => {
    assert.equal(evaluateSecret(["KIT_API_KEY"], { KIT_API_KEY: "x" }, null).status, "ok");
    assert.equal(evaluateSecret(["KIT_API_KEY"], {}, null).status, "fail");
  });
  it("nome alternativo basta", () => {
    const r = evaluateSecret(["R2_BUCKET", "SHORTS_R2_BUCKET"], { SHORTS_R2_BUCKET: "b" }, null);
    assert.equal(r.status, "ok");
    assert.equal(r.id, "secret:R2_BUCKET");
  });
  it("nunca devolve o valor", () => {
    const r = evaluateSecret(["KIT_API_KEY"], { KIT_API_KEY: "sk-segredo-123" }, new Set());
    assert.doesNotMatch(JSON.stringify(r), /sk-segredo-123/);
  });
});

describe("evaluateNodeVersion / evaluateNodeModules", () => {
  it("major do .nvmrc", () => {
    assert.equal(evaluateNodeVersion("v24.20.0", "24\n", true).status, "ok");
    assert.equal(evaluateNodeVersion("v22.18.0", "24", true).status, "fail");
    assert.equal(evaluateNodeVersion("v20.1.0", "24", false).status, "fail");
    assert.equal(evaluateNodeVersion("v24.1.0", null, true).status, "ok");
  });
  const lock = {
    packages: {
      "": { name: "x" },
      "node_modules/a": { version: "1.0.0" },
      "node_modules/b": { version: "2.0.0" },
      "node_modules/@esbuild/linux-x64": { version: "0.1.0", optional: true },
    },
  };
  it("bate: ok (optional ausente não conta)", () => {
    const hidden = { packages: { "node_modules/a": { version: "1.0.0" }, "node_modules/b": { version: "2.0.0" } } };
    assert.equal(evaluateNodeModules(lock, hidden).status, "ok");
  });
  it("faltando ou versão diferente: falta", () => {
    const r = evaluateNodeModules(lock, { packages: { "node_modules/a": { version: "1.0.1" } } });
    assert.equal(r.status, "fail");
    assert.match(r.detail, /1 pacote\(s\) faltando \(b\)/);
    assert.match(r.detail, /1 com versão diferente \(a\)/);
  });
  it("sem node_modules: falta; lockfile ilegível: não verificado", () => {
    assert.equal(evaluateNodeModules(lock, null).status, "fail");
    assert.equal(evaluateNodeModules(null, null).status, "unverified");
  });
});

describe("evaluateGit / evaluateDataDir / evaluateGhAuth / tokens", () => {
  const base = { branch: "master", behind: 0, dirtyTracked: 0, isAgentWorktree: false };
  it("git", () => {
    assert.equal(evaluateGit(base).status, "ok");
    assert.equal(evaluateGit({ ...base, branch: "develop/x" }).status, "fail");
    assert.equal(evaluateGit({ ...base, behind: 3 }).status, "fail");
    assert.equal(evaluateGit({ ...base, isAgentWorktree: true }).status, "fail");
    assert.equal(evaluateGit({ ...base, branch: null }).status, "unverified");
    assert.equal(evaluateGit({ ...base, behind: null }).status, "unverified");
  });
  it("data/", () => {
    assert.equal(evaluateDataDir({ accessible: true, newestMtimeMs: NOW.getTime() - 3_600_000 }, NOW).status, "ok");
    assert.equal(evaluateDataDir({ accessible: true, newestMtimeMs: NOW.getTime() - 4 * 86_400_000 }, NOW).status, "fail");
    assert.equal(evaluateDataDir({ accessible: false, error: "ENOENT", newestMtimeMs: null }, NOW).status, "fail");
    assert.equal(evaluateDataDir({ accessible: true, newestMtimeMs: null }, NOW).status, "fail");
  });
  it("gh", () => {
    assert.equal(evaluateGhAuth(0).status, "ok");
    assert.equal(evaluateGhAuth(1).status, "fail");
    assert.equal(evaluateGhAuth(null, "ENOENT").status, "fail");
  });
  it("tokens: sem helper e offline viram não verificado, nunca falta", () => {
    assert.equal(evaluateToken("instagram", { state: "no-helper", reason: "x" }).status, "unverified");
    assert.equal(evaluateToken("threads", { state: "skipped", reason: "--offline" }).status, "unverified");
    assert.equal(evaluateToken("linkedin", { state: "invalid", reason: "401" }).status, "fail");
    assert.equal(evaluateToken("linkedin", { state: "valid" }).status, "ok");
  });
  it("erro de leitura do Threads: 4xx de auth é token inválido, rede é incerteza", () => {
    assert.equal(classifyThreadsReadError("threads_profile: leitura do perfil HTTP 401: {}").state, "invalid");
    assert.equal(classifyThreadsReadError('threads_profile: leitura do perfil com erro: {"code": 190}').state, "invalid");
    assert.equal(classifyThreadsReadError("threads_profile: leitura do perfil HTTP 500: x").state, "unknown");
    assert.equal(classifyThreadsReadError("fetch failed").state, "unknown");
  });
});

describe("mapa de segredos por script", () => {
  it("toda task critical do registro tem os scripts mapeados", () => {
    const critical = SCHEDULED_TASKS.filter((t) => resolveFailoverTier(t) === "critical");
    assert.ok(critical.length > 0);
    for (const t of critical) {
      for (const s of t.steps) assert.ok(CRITICAL_SCRIPT_REQUIREMENTS[s.script], `${t.name}: ${s.script} sem entrada em CRITICAL_SCRIPT_REQUIREMENTS`);
    }
  });
  it("todo script mapeado existe", () => {
    for (const s of Object.keys(CRITICAL_SCRIPT_REQUIREMENTS)) assert.ok(existsSync(s), `${s} não existe`);
  });
  it("a lista do R2 bate com R2_ENV_VARS", () => {
    const r2 = CRITICAL_SCRIPT_REQUIREMENTS["scripts/shorts-instagram-timer.ts"].secrets.filter((n) => n[0].startsWith("R2_"));
    assert.deepEqual(r2.map((n) => [...n]), R2_ENV_VARS.map((n) => [...n]));
  });
});

describe("aggregateReadiness", () => {
  const task: ScheduledTaskDefinition = {
    name: "T-Clarice",
    description: "",
    steps: [{ key: "a", script: "scripts/clarice-envio-guard.ts" }],
    logPath: "x.log",
    schedule: { kind: "daily", hour: 1, minute: 0 },
    issue: "#1",
    failover: "critical",
    guard: { requiredFile: "clarice-subscribers/clarice-users.db", abortMessage: "" },
  };

  it("ids esperados: script, segredo, guard", () => {
    assert.deepEqual(taskCheckIds(task), ["script:scripts/clarice-envio-guard.ts", "secret:BREVO_CLARICE_API_KEY", "guard:clarice-subscribers/clarice-users.db"]);
  });

  it("tudo ok: pronto; checagem esperada ausente vira não verificado, não ok", () => {
    const byId = new Map<string, CheckResult>([["script:scripts/clarice-envio-guard.ts", ok("script:scripts/clarice-envio-guard.ts")], ["secret:BREVO_CLARICE_API_KEY", ok("secret:BREVO_CLARICE_API_KEY")]]);
    const r = aggregateReadiness({ tasks: [task], common: [ok("node")], byId, now: NOW, machineId: "Neo" });
    assert.equal(r.ok, true);
    assert.equal(r.tasks[0].ready, true);
    assert.equal(r.tasks[0].unverified.length, 1);
    assert.match(r.tasks[0].unverified[0], /guard:clarice/);
    assert.match(formatTaskLines(r)[0], /^T-Clarice: pronto \(não verificado/);
  });

  it("uma falha comum derruba todas; uma específica só a sua", () => {
    const other = { ...task, name: "T-Outra", steps: [{ key: "a", script: "scripts/onboarding-watch-returning.ts" }], guard: undefined };
    const byId = new Map<string, CheckResult>([
      ["script:scripts/clarice-envio-guard.ts", ok("script:scripts/clarice-envio-guard.ts")],
      ["secret:BREVO_CLARICE_API_KEY", { id: "secret:BREVO_CLARICE_API_KEY", status: "fail", detail: "BREVO_CLARICE_API_KEY: ausente" }],
      ["guard:clarice-subscribers/clarice-users.db", ok("guard:clarice-subscribers/clarice-users.db")],
      ["script:scripts/onboarding-watch-returning.ts", ok("script:scripts/onboarding-watch-returning.ts")],
      ["secret:KIT_API_KEY", ok("secret:KIT_API_KEY")],
    ]);
    const r = aggregateReadiness({ tasks: [task, other], common: [ok("node")], byId, now: NOW, machineId: "Neo" });
    assert.equal(r.ok, false);
    assert.deepEqual(r.tasks.map((t) => t.ready), [false, true]);
    assert.match(formatTaskLines(r)[0], /^T-Clarice: falta BREVO_CLARICE_API_KEY: ausente$/);
    assert.match(formatSummaryLine(r), /1\/2 prontas; falta: BREVO_CLARICE_API_KEY/);

    const red = aggregateReadiness({ tasks: [task, other], common: [{ id: "gh", status: "fail", detail: "gh não autenticado" }], byId, now: NOW, machineId: "Neo" });
    assert.deepEqual(red.tasks.map((t) => t.ready), [false, false]);
  });

  it("script sem mapa de segredos sai não verificado", () => {
    const t = { ...task, steps: [{ key: "a", script: "scripts/novo.ts" }], guard: undefined };
    const r = aggregateReadiness({ tasks: [t], common: [], byId: new Map([["script:scripts/novo.ts", ok("script:scripts/novo.ts")]]), now: NOW, machineId: "Neo" });
    assert.match(r.tasks[0].unverified.join(), /sem mapa/);
  });

  it("task desabilitada sai pronta sem checagem", () => {
    const r = aggregateReadiness({ tasks: [{ ...task, enabled: false }], common: [{ id: "gh", status: "fail", detail: "x" }], byId: new Map(), now: NOW, machineId: "Neo" });
    assert.equal(r.tasks[0].ready, true);
  });
});

function report(over: Partial<ReadinessReport> = {}): ReadinessReport {
  return { schema: 1, checkedAt: NOW.toISOString(), machineId: "Neo", ok: true, tasks: [{ name: "T", ready: true, missing: [], unverified: [] }], checks: [], ...over };
}

describe("registro no KV", () => {
  it("roundtrip e formatos inválidos", () => {
    const r = report();
    const back = parseReadinessRecord(serializeReadinessRecord(r));
    assert.equal(back.kind, "ok");
    assert.deepEqual(back.kind === "ok" ? back.report : null, r);
    assert.equal(parseReadinessRecord(null).kind, "absent");
    assert.equal(parseReadinessRecord("{").kind, "invalid");
    assert.equal(parseReadinessRecord('{"checkedAt":"nada","ok":true,"tasks":[]}').kind, "invalid");
  });
});

describe("evaluateNeoReadinessAlarm", () => {
  it("KV ilegível: não mede (não abre nem fecha)", () => {
    assert.equal(evaluateNeoReadinessAlarm({ kind: "error", error: "rede" }, NOW).kind, "unmeasured");
  });
  it("nunca gravado ou ilegível: stale", () => {
    for (const read of [{ kind: "absent" } as const, { kind: "invalid", error: "x" } as const]) {
      const v = evaluateNeoReadinessAlarm(read, NOW);
      assert.equal(v.kind, "measured");
      assert.deepEqual(v.kind === "measured" ? v.findings.map((f) => f.fingerprint) : [], [NEO_READINESS_STALE_FINGERPRINT]);
    }
  });
  it("verde e recente: nada", () => {
    const v = evaluateNeoReadinessAlarm({ kind: "ok", report: report({ checkedAt: new Date(NOW.getTime() - 6 * 86_400_000).toISOString() }) }, NOW);
    assert.deepEqual(v.kind === "measured" ? v.findings : null, []);
  });
  it("mais de 7 dias: stale; vermelho: red com a lista e assinatura", () => {
    const old = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();
    const r = report({ checkedAt: old, ok: false, tasks: [{ name: "Diaria-Clarice-Envio", ready: false, missing: ["KIT_API_KEY: ausente"], unverified: [] }] });
    const v = evaluateNeoReadinessAlarm({ kind: "ok", report: r }, NOW);
    assert.equal(v.kind, "measured");
    if (v.kind !== "measured") return;
    assert.deepEqual(v.findings.map((f) => f.fingerprint).sort(), [NEO_READINESS_RED_FINGERPRINT, NEO_READINESS_STALE_FINGERPRINT].sort());
    const red = v.findings.find((f) => f.fingerprint === NEO_READINESS_RED_FINGERPRINT)!;
    assert.match(red.body, /Diaria-Clarice-Envio`: falta KIT_API_KEY: ausente/);
    assert.ok(red.contentSignature);
    assert.ok(v.findings.every((f) => f.family === "estado" && f.priority === "P2"));
  });
});

describe("isNeoMachine", () => {
  it("compara o hostname sem caixa", () => {
    assert.equal(isNeoMachine("Neo"), true);
    assert.equal(isNeoMachine("NEO "), true);
    assert.equal(isNeoMachine("predator"), false);
    assert.equal(isNeoMachine(""), false);
  });
});

describe("parseDopplerNames", () => {
  it("objeto de nomes (formato real do --only-names --json) e lixo", () => {
    assert.deepEqual([...(parseDopplerNames('{"A":{},"B":{}}') ?? [])], ["A", "B"]);
    assert.equal(parseDopplerNames("nada"), null);
  });
});

describe("registro da task do alarme", () => {
  it("Diaria-Neo-Readiness-Alarm diária, failover skip, script existe", () => {
    const t = getScheduledTaskByName("Diaria-Neo-Readiness-Alarm");
    assert.ok(t);
    assert.equal(t.failover, "skip");
    assert.equal(t.schedule.kind, "daily");
    assert.ok(existsSync(t.steps[0].script));
  });
});

describe("CLI neo-readiness (deps falsas)", () => {
  const root = mkdtempSync(join(tmpdir(), "neo-readiness-12983-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "onboarding-watch-returning.ts"), "");
  mkdirSync(join(root, "data", "onboarding"), { recursive: true });
  writeFileSync(join(root, "data", "onboarding", "store.json"), "{}");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), `${process.version.slice(1).split(".")[0]}\n`);
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/a": { version: "1.0.0" } } }));
  writeFileSync(join(root, "node_modules", ".package-lock.json"), JSON.stringify({ packages: { "node_modules/a": { version: "1.0.0" } } }));

  const task: ScheduledTaskDefinition = {
    name: "Diaria-Onboarding-Watch-Returning",
    description: "",
    steps: [{ key: "w", script: "scripts/onboarding-watch-returning.ts" }],
    logPath: "x.log",
    schedule: { kind: "daily", hour: 1, minute: 0 },
    issue: "#1",
    failover: "critical",
    guard: { requiredFile: "onboarding/store.json", abortMessage: "" },
  };
  const SECRET = "valor-que-nunca-aparece-9f8e";

  function deps(over: Partial<ReadinessDeps> = {}) {
    const out: string[] = [];
    const puts: Array<{ key: string; value: string }> = [];
    const d: Partial<ReadinessDeps> = {
      root,
      now: () => new Date(),
      machineId: () => "Neo",
      env: {},
      readDotenv: () => ({ KIT_API_KEY: SECRET, CLOUDFLARE_ACCOUNT_ID: SECRET, CLOUDFLARE_WORKERS_TOKEN: SECRET }),
      dopplerNames: () => ({ names: new Set(["KIT_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_WORKERS_TOKEN"]) }),
      run: (cmd, args) => {
        if (cmd === "gh") return { code: 0, stdout: "" };
        if (args[0] === "rev-parse") return { code: 0, stdout: "master\n" };
        if (args[0] === "rev-list") return { code: 0, stdout: "0\n" };
        return { code: 0, stdout: "" };
      },
      fetch: (async () => {
        throw new Error("rede proibida no teste");
      }) as typeof fetch,
      putKv: async (_env, key, value) => {
        puts.push({ key, value });
      },
      tasks: [task],
      log: (m) => out.push(m),
      err: (m) => out.push(m),
      ...over,
    };
    return { d, out, puts };
  }

  it("pronto: exit 0, uma linha por task, sem gravar sem --record", async () => {
    const { d, out, puts } = deps();
    assert.equal(await readinessMain([], d), 0);
    assert.ok(out.some((l) => l === "Diaria-Onboarding-Watch-Returning: pronto"), out.join("\n"));
    assert.equal(puts.length, 0);
  });

  it("--json e --record: grava o relatório na chave certa, sem valor de segredo", async () => {
    const { d, out, puts } = deps();
    assert.equal(await readinessMain(["--json", "--record"], d), 0);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].key, NEO_READINESS_KV_KEY);
    assert.doesNotMatch(puts[0].value + out.join("\n"), new RegExp(SECRET));
    assert.equal(parseReadinessRecord(puts[0].value).kind, "ok");
  });

  it("checagem que lança não derruba as outras e vira não verificado", async () => {
    const { d, out } = deps({
      run: () => {
        throw new Error("spawn explodiu");
      },
    });
    const code = await readinessMain([], d);
    assert.equal(code, 0);
    assert.ok(out.some((l) => /não verificado: gh: checagem falhou/.test(l)), out.join("\n"));
    assert.ok(out.some((l) => /^Diaria-Onboarding-Watch-Returning: pronto/.test(l)), out.join("\n"));
  });

  it("falta segredo: exit 1", async () => {
    const { d, out } = deps({ readDotenv: () => ({ CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_WORKERS_TOKEN: "y" }) });
    assert.equal(await readinessMain([], d), 1);
    assert.ok(out.some((l) => /falta KIT_API_KEY: só no Doppler/.test(l)), out.join("\n"));
  });

  it("--if-neo fora do Neo: não checa nem grava, exit 0", async () => {
    const { d, out, puts } = deps({ machineId: () => "predator" });
    assert.equal(await readinessMain(["--if-neo", "--record"], d), 0);
    assert.equal(puts.length, 0);
    assert.match(out.join("\n"), /não é o Neo/);
  });

  it("--if-neo no Neo: uma linha de resumo e exit 0 mesmo com falta e KV fora", async () => {
    const { d, out } = deps({
      readDotenv: () => ({}),
      putKv: async () => {
        throw new Error("KV fora");
      },
    });
    assert.equal(await readinessMain(["--if-neo", "--record"], d), 0);
    const summary = out.filter((l) => l.startsWith("[neo-readiness] prontidão"));
    assert.equal(summary.length, 1);
    assert.match(summary[0], /NÃO gravado no KV/);
  });

  it("flag desconhecida: exit 2", async () => {
    const { d } = deps();
    assert.equal(await readinessMain(["--armar"], d), 2);
  });
});
