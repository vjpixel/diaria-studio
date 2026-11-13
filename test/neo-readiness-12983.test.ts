/**
 * test/neo-readiness-12983.test.ts (#12983)
 *
 * Prontidão do Neo para a contingência do 300: checagens puras, agregador,
 * registro no KV, alarme do 300 e os dois CLIs com dependências falsas. Nenhum
 * teste toca Doppler, gh, git real, rede ou KV.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AlarmFinding, AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";
import {
  aggregateReadiness,
  CHECK_ID,
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
  syncSignalLogPaths,
  taskCheckIds,
  type CheckResult,
  type ReadinessReport,
} from "../scripts/lib/failover/neo-readiness.ts";
import {
  EMPTY_UNVERIFIED_STREAK,
  evaluateNeoReadinessAlarm,
  NEO_READINESS_RED_FINGERPRINT,
  NEO_READINESS_STALE_FINGERPRINT,
  NEO_READINESS_UNVERIFIED_FINGERPRINT,
  UNVERIFIED_STREAK_THRESHOLD,
  updateUnverifiedStreak,
} from "../scripts/lib/failover/neo-readiness-alarm.ts";
import { main as readinessMain, parseDopplerNames, probeInstagram, probeLinkedIn, probeThreads, withTimeout, type ReadinessDeps } from "../scripts/failover/neo-readiness.ts";
import { classifyInstagramProfileResponse, probeInstagramToken } from "../scripts/lib/instagram-token-probe.ts";
import { missingYouTubeCredentials } from "../scripts/lib/diaria/youtube-upload.ts";
import { main as alarmMain, type AlarmDeps } from "../scripts/neo-readiness-alarm.ts";
import { isNeoMachine } from "../scripts/lib/machine-id.ts";
import { R2_ENV_VARS } from "../scripts/lib/r2-object-upload.ts";
import { getScheduledTaskByName, resolveFailoverTier, SCHEDULED_TASKS, type ScheduledTaskDefinition } from "../scripts/lib/scheduled-tasks.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-11-13T12:00:00Z");
const ok = (id: string): CheckResult => ({ id, status: "ok", detail: `${id} ok` });

describe("evaluateSecret (só o .env decide)", () => {
  it("presente no .env e no Doppler: ok", () => {
    assert.equal(evaluateSecret(["KIT_API_KEY"], { KIT_API_KEY: "x" }, {}, new Set(["KIT_API_KEY"])).status, "ok");
  });
  it("no .env e ausente do Doppler: ok, com aviso", () => {
    const r = evaluateSecret(["KIT_API_KEY"], { KIT_API_KEY: "x" }, {}, new Set());
    assert.equal(r.status, "ok");
    assert.match(r.detail, /no \.env, mas ausente do Doppler/);
  });
  it("só no Doppler: falta, com a dica do sync-env", () => {
    const r = evaluateSecret(["KIT_API_KEY"], {}, {}, new Set(["KIT_API_KEY"]));
    assert.equal(r.status, "fail");
    assert.match(r.detail, /sync-env/);
  });
  it("ausente nos dois: falta", () => {
    const r = evaluateSecret(["KIT_API_KEY"], { KIT_API_KEY: "  " }, {}, new Set());
    assert.equal(r.status, "fail");
    assert.match(r.detail, /e do Doppler/);
  });
  it("só no ambiente da sessão (ex.: GOOGLE_* injetado pelo app): falta, com o aviso", () => {
    const r = evaluateSecret(["GOOGLE_CLIENT_ID"], {}, { GOOGLE_CLIENT_ID: "falso" }, null);
    assert.equal(r.status, "fail");
    assert.match(r.detail, /só no ambiente da sessão/);
  });
  it("Doppler não consultado: decide pelo .env", () => {
    assert.equal(evaluateSecret(["KIT_API_KEY"], { KIT_API_KEY: "x" }, {}, null).status, "ok");
    assert.equal(evaluateSecret(["KIT_API_KEY"], {}, {}, null).status, "fail");
  });
  it("nome alternativo basta; id pelo nome preferido", () => {
    const r = evaluateSecret(["R2_BUCKET", "SHORTS_R2_BUCKET"], { SHORTS_R2_BUCKET: "b" }, {}, null);
    assert.equal(r.status, "ok");
    assert.equal(r.id, CHECK_ID.secret(["R2_BUCKET"]));
  });
  it("nunca devolve o valor", () => {
    const r = evaluateSecret(["KIT_API_KEY"], { KIT_API_KEY: "sk-segredo-123" }, { KIT_API_KEY: "sk-outro-456" }, new Set());
    assert.doesNotMatch(JSON.stringify(r), /sk-segredo-123|sk-outro-456/);
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
  it("sem node_modules ou lockfile oculto ilegível: falta; lockfile ilegível: não verificado", () => {
    assert.equal(evaluateNodeModules(lock, null).status, "fail");
    assert.equal(evaluateNodeModules(lock, {}).status, "fail");
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
  it("data/: inacessível é falta; sem sinal ou sinal velho do 300 é não verificado", () => {
    assert.equal(evaluateDataDir({ accessible: true, syncSignalMtimeMs: NOW.getTime() - 3_600_000 }, NOW).status, "ok");
    const old = evaluateDataDir({ accessible: true, syncSignalMtimeMs: NOW.getTime() - 4 * 86_400_000 }, NOW);
    assert.equal(old.status, "unverified");
    assert.match(old.detail, /sem log novo do 300 há 96 h/);
    assert.equal(evaluateDataDir({ accessible: false, error: "ENOENT", syncSignalMtimeMs: null }, NOW).status, "fail");
    const none = evaluateDataDir({ accessible: true, syncSignalMtimeMs: null }, NOW);
    assert.equal(none.status, "unverified");
    assert.match(none.detail, /nenhum log de task do 300/);
  });
  it("sinal de sync: só logs de task skip habilitada (nunca rodam no Neo)", () => {
    const t = (name: string, failover: ScheduledTaskDefinition["failover"], logPath: string, enabled?: boolean) =>
      ({ name, failover, logPath, enabled, steps: [], description: "", schedule: { kind: "daily", hour: 1, minute: 0 }, issue: "#1" }) as ScheduledTaskDefinition;
    assert.deepEqual(syncSignalLogPaths([t("a", "skip", "z/.a.log"), t("b", "critical", "b.log"), t("c", "catchup", "c.log"), t("d", "skip", "d.log", false), t("e", "skip", "z/.a.log")]), ["z/.a.log"]);
    assert.ok(syncSignalLogPaths(SCHEDULED_TASKS).length > 10, "o registro real precisa dar sinal");
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

describe("probes de token (fetch falso)", () => {
  const respond = (status: number, body = "{}") => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const li = { LINKEDIN_PERSONAL_ACCESS_TOKEN: "t", LINKEDIN_PERSONAL_PERSON_URN: "urn:li:person:abc" };
  const th = { THREADS_PERSONAL_ACCESS_TOKEN: "t", THREADS_PERSONAL_USER_ID: "123" };

  it("LinkedIn: 401 é falta, 200 é válido, 500 é incerto, não configurado é pulado, vencido é falta", async () => {
    assert.equal(evaluateToken("linkedin", await probeLinkedIn(li, NOW, respond(401))).status, "fail");
    assert.equal((await probeLinkedIn(li, NOW, respond(401))).state, "invalid");
    assert.equal((await probeLinkedIn(li, NOW, respond(200))).state, "valid");
    assert.equal((await probeLinkedIn(li, NOW, respond(500))).state, "unknown");
    assert.equal((await probeLinkedIn({}, NOW, respond(200))).state, "skipped");
    const expired = { ...li, LINKEDIN_PERSONAL_TOKEN_EXPIRES_AT: "2026-11-01T00:00:00Z" };
    assert.equal((await probeLinkedIn(expired, NOW, respond(200))).state, "invalid");
  });
  it("Threads: 401 é falta, lista vazia é válido, não configurado é pulado, vencido é falta", async () => {
    assert.equal(evaluateToken("threads", await probeThreads(th, NOW, respond(401))).status, "fail");
    assert.equal((await probeThreads(th, NOW, respond(200, '{"data":[]}'))).state, "valid");
    assert.equal((await probeThreads({}, NOW, respond(200))).state, "skipped");
    const expired = { ...th, THREADS_PERSONAL_TOKEN_EXPIRES_AT: "2026-11-01T00:00:00Z" };
    assert.equal((await probeThreads(expired, NOW, respond(200, '{"data":[]}'))).state, "invalid");
  });
});

describe("withTimeout", () => {
  it("aborta a chamada que passa do teto", async () => {
    const hang = ((_u: unknown, i?: RequestInit) =>
      new Promise((_res, rej) => {
        i?.signal?.addEventListener("abort", () => rej(new Error("abortado")));
      })) as unknown as typeof fetch;
    const t0 = Date.now();
    await assert.rejects(withTimeout(hang, 50)("https://x"), /abortado/);
    assert.ok(Date.now() - t0 < 5_000);
  });
  it("respeita o signal do chamador", async () => {
    let got: AbortSignal | undefined;
    const spy = (async (_u: unknown, i?: RequestInit) => {
      got = i?.signal ?? undefined;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const own = new AbortController().signal;
    await withTimeout(spy, 50)("https://x", { signal: own });
    assert.equal(got, own);
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
    for (const s of Object.keys(CRITICAL_SCRIPT_REQUIREMENTS)) assert.ok(existsSync(join(REPO_ROOT, s)), `${s} não existe`);
  });
  it("#12993: video-d1-link-watch exige a lista inteira de missingYouTubeCredentials e a página do Facebook", () => {
    const names = CRITICAL_SCRIPT_REQUIREMENTS["scripts/video-d1-link-watch.ts"].secrets.map((n) => n[0]);
    for (const n of missingYouTubeCredentials({})) assert.ok(names.includes(n), `${n} fora do mapa`);
    assert.ok(names.includes("YOUTUBE_CHANNEL_ID"));
    const cfg = JSON.parse(readFileSync(join(REPO_ROOT, "platform.config.json"), "utf8")) as {
      publishing: { social: { facebook: { pages: Array<{ slug: string; page_id_env: string; token_env: string }> } } };
    };
    const diaria = cfg.publishing.social.facebook.pages.find((p) => p.slug === "diaria");
    assert.ok(diaria);
    assert.ok(names.includes(diaria.page_id_env) && names.includes(diaria.token_env), "envs da página diaria no mapa");
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

  it("ids esperados saem do builder único", () => {
    assert.deepEqual(taskCheckIds(task), [
      CHECK_ID.script("scripts/clarice-envio-guard.ts"),
      CHECK_ID.secret(["BREVO_CLARICE_API_KEY"]),
      CHECK_ID.guard("clarice-subscribers/clarice-users.db"),
    ]);
    assert.deepEqual(taskCheckIds(task), ["script:scripts/clarice-envio-guard.ts", "secret:BREVO_CLARICE_API_KEY", "guard:clarice-subscribers/clarice-users.db"]);
  });

  it("checagem esperada ausente (falha do coletor) é falta, não pronto calado", () => {
    const byId = new Map<string, CheckResult>([["script:scripts/clarice-envio-guard.ts", ok("script:scripts/clarice-envio-guard.ts")], ["secret:BREVO_CLARICE_API_KEY", ok("secret:BREVO_CLARICE_API_KEY")]]);
    const r = aggregateReadiness({ tasks: [task], common: [ok("node")], byId, now: NOW, machineId: "Neo" });
    assert.equal(r.ok, false);
    assert.deepEqual(r.tasks[0].missingIds, ["guard:clarice-subscribers/clarice-users.db"]);
    assert.match(formatTaskLines(r)[0], /^T-Clarice: falta guard:clarice.*não checado/);
  });

  it("unverified por desenho não impede pronto", () => {
    const byId = new Map<string, CheckResult>([
      ["script:scripts/clarice-envio-guard.ts", ok("script:scripts/clarice-envio-guard.ts")],
      ["secret:BREVO_CLARICE_API_KEY", ok("secret:BREVO_CLARICE_API_KEY")],
      ["guard:clarice-subscribers/clarice-users.db", ok("guard:clarice-subscribers/clarice-users.db")],
    ]);
    const r = aggregateReadiness({ tasks: [task], common: [{ id: "doppler", status: "unverified", detail: "Doppler não consultado: x" }], byId, now: NOW, machineId: "Neo" });
    assert.equal(r.tasks[0].ready, true);
    assert.match(formatTaskLines(r)[0], /^T-Clarice: pronto \(não verificado: Doppler/);
    assert.deepEqual(r.commonIds, ["doppler"]);
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

  it("script sem mapa de segredos é falta", () => {
    const t = { ...task, steps: [{ key: "a", script: "scripts/novo.ts" }], guard: undefined };
    const r = aggregateReadiness({ tasks: [t], common: [], byId: new Map([["script:scripts/novo.ts", ok("script:scripts/novo.ts")]]), now: NOW, machineId: "Neo" });
    assert.equal(r.tasks[0].ready, false);
    assert.match(r.tasks[0].missing.join(), /sem mapa/);
  });

  it("task desabilitada sai pronta sem checagem", () => {
    const r = aggregateReadiness({ tasks: [{ ...task, enabled: false }], common: [{ id: "gh", status: "fail", detail: "x" }], byId: new Map(), now: NOW, machineId: "Neo" });
    assert.equal(r.tasks[0].ready, true);
  });
});

function report(over: Partial<ReadinessReport> = {}): ReadinessReport {
  return { schema: 1, checkedAt: NOW.toISOString(), machineId: "Neo", ok: true, tasks: [{ name: "T", ready: true, missing: [], missingIds: [], unverified: [] }], checks: [], commonIds: [], ...over };
}

describe("registro no KV", () => {
  it("roundtrip e formatos inválidos", () => {
    const r = report();
    const back = parseReadinessRecord(serializeReadinessRecord(r), NOW);
    assert.equal(back.kind, "ok");
    assert.deepEqual(back.kind === "ok" ? back.report : null, r);
    assert.equal(parseReadinessRecord(null, NOW).kind, "absent");
    assert.equal(parseReadinessRecord("{", NOW).kind, "invalid");
    assert.equal(parseReadinessRecord('{"checkedAt":"nada","ok":true,"tasks":[]}', NOW).kind, "invalid");
  });
  it("ready/ok recalculados de missing: ok:true com falta listada não passa por verde", () => {
    const lie = JSON.stringify({ ...report(), ok: true, tasks: [{ name: "T", ready: true, missing: ["KIT_API_KEY: ausente"], unverified: [] }] });
    const back = parseReadinessRecord(lie, NOW);
    assert.equal(back.kind, "ok");
    if (back.kind !== "ok") return;
    assert.equal(back.report.ok, false);
    assert.equal(back.report.tasks[0].ready, false);
    // registro sem missingIds: o detalhe serve de id
    assert.deepEqual(back.report.tasks[0].missingIds, ["KIT_API_KEY: ausente"]);
  });
  it("checkedAt no futuro além da tolerância é inválido", () => {
    assert.equal(parseReadinessRecord(serializeReadinessRecord(report({ checkedAt: new Date(NOW.getTime() + 5 * 60_000).toISOString() })), NOW).kind, "ok");
    assert.equal(parseReadinessRecord(serializeReadinessRecord(report({ checkedAt: new Date(NOW.getTime() + 2 * 86_400_000).toISOString() })), NOW).kind, "invalid");
  });
});

describe("evaluateNeoReadinessAlarm", () => {
  const fps = (v: ReturnType<typeof evaluateNeoReadinessAlarm>) => (v.kind === "measured" ? v.findings.map((f) => f.fingerprint).sort() : null);
  const redReport = (detail: string, over: Partial<ReadinessReport> = {}) =>
    report({
      ok: false,
      commonIds: ["gh", "data"],
      checks: [
        { id: "gh", status: "fail", detail: "gh não autenticado" },
        { id: "data", status: "ok", detail: "ok" },
        { id: "secret:KIT_API_KEY", status: "fail", detail },
      ],
      tasks: [
        { name: "Diaria-Clarice-Envio", ready: false, missing: ["gh não autenticado", detail], missingIds: ["gh", "secret:KIT_API_KEY"], unverified: [] },
        { name: "Diaria-Outra", ready: false, missing: ["gh não autenticado"], missingIds: ["gh"], unverified: [] },
      ],
      ...over,
    });

  it("KV ilegível: não mede (não abre nem fecha)", () => {
    assert.equal(evaluateNeoReadinessAlarm({ kind: "error", error: "rede" }, NOW).kind, "unmeasured");
  });
  it("nunca gravado ou corrompido: stale", () => {
    for (const read of [{ kind: "absent" } as const, { kind: "invalid", error: "x" } as const]) {
      assert.deepEqual(fps(evaluateNeoReadinessAlarm(read, NOW)), [NEO_READINESS_STALE_FINGERPRINT]);
    }
  });
  it("registro de outra máquina: stale, mesmo verde e recente", () => {
    const v = evaluateNeoReadinessAlarm({ kind: "ok", report: report({ machineId: "predator" }) }, NOW);
    assert.deepEqual(fps(v), [NEO_READINESS_STALE_FINGERPRINT]);
    assert.match(v.kind === "measured" ? v.summary : "", /predator/);
  });
  it("verde e recente: nada", () => {
    const v = evaluateNeoReadinessAlarm({ kind: "ok", report: report({ checkedAt: new Date(NOW.getTime() - 6 * 86_400_000).toISOString() }) }, NOW);
    assert.deepEqual(fps(v), []);
  });
  it("vermelho e recente: só red; falhas comuns listadas uma vez", () => {
    const v = evaluateNeoReadinessAlarm({ kind: "ok", report: redReport("KIT_API_KEY: ausente") }, NOW);
    assert.deepEqual(fps(v), [NEO_READINESS_RED_FINGERPRINT]);
    if (v.kind !== "measured") return;
    const red = v.findings[0];
    assert.equal(red.body.match(/gh não autenticado/g)?.length, 1);
    assert.match(red.body, /Diaria-Clarice-Envio`: falta KIT_API_KEY: ausente/);
    assert.match(red.body, /Diaria-Outra`: só as falhas comuns/);
    assert.ok(red.family === "estado" && red.priority === "P2");
  });
  it("assinatura por task + id: detalhe que muda não muda a assinatura; falta nova muda", () => {
    const sig = (r: ReadinessReport) => {
      const v = evaluateNeoReadinessAlarm({ kind: "ok", report: r }, NOW);
      return v.kind === "measured" ? v.findings.find((f: AlarmFinding) => f.fingerprint === NEO_READINESS_RED_FINGERPRINT)?.contentSignature : undefined;
    };
    const a = sig(redReport("KIT_API_KEY: ausente (há 5 h)"));
    assert.ok(a);
    assert.equal(sig(redReport("KIT_API_KEY: ausente (há 9 h)")), a);
    const more = redReport("KIT_API_KEY: ausente");
    more.tasks[1] = { ...more.tasks[1], missing: ["gh não autenticado", "x"], missingIds: ["gh", "secret:STRIPE_API_KEY"] };
    assert.notEqual(sig(more), a);
  });
  it("mais de 7 dias e vermelho: stale + red", () => {
    const old = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();
    const v = evaluateNeoReadinessAlarm({ kind: "ok", report: redReport("KIT_API_KEY: ausente", { checkedAt: old }) }, NOW);
    assert.deepEqual(fps(v), [NEO_READINESS_RED_FINGERPRINT, NEO_READINESS_STALE_FINGERPRINT].sort());
  });
  const at = (i: number) => new Date(NOW.getTime() - (20 - i) * 3_600_000).toISOString();
  it("Doppler indisponível (transitório) em N checks seguidos: achado unverified", () => {
    let streak = EMPTY_UNVERIFIED_STREAK;
    const unv = (i: number) => report({ checkedAt: at(i), checks: [{ id: "doppler", status: "unverified", detail: "Doppler não consultado: sem login" }] });
    for (let i = 0; i < UNVERIFIED_STREAK_THRESHOLD - 1; i++) streak = updateUnverifiedStreak(streak, unv(i));
    // o mesmo check lido de novo não conta
    assert.equal(updateUnverifiedStreak(streak, unv(UNVERIFIED_STREAK_THRESHOLD - 2)), streak);
    assert.deepEqual(fps(evaluateNeoReadinessAlarm({ kind: "ok", report: unv(0) }, NOW, undefined, streak)), []);
    streak = updateUnverifiedStreak(streak, unv(UNVERIFIED_STREAK_THRESHOLD - 1));
    assert.equal(UNVERIFIED_STREAK_THRESHOLD, 4);
    const v = evaluateNeoReadinessAlarm({ kind: "ok", report: unv(0) }, NOW, undefined, streak);
    assert.deepEqual(fps(v), [NEO_READINESS_UNVERIFIED_FINGERPRINT]);
    // um check verificado zera
    streak = updateUnverifiedStreak(streak, report({ checkedAt: NOW.toISOString(), checks: [{ id: "doppler", status: "ok", detail: "ok" }] }));
    assert.deepEqual(streak.streaks, {});
  });
  it("Instagram sem helper (estrutural) por 10 checks não abre achado; token unknown por rede conta", () => {
    let streak = EMPTY_UNVERIFIED_STREAK;
    const ig = evaluateToken("instagram", { state: "no-helper", reason: "sem helper de leitura seguro no repo" });
    assert.equal(ig.structural, true);
    assert.equal(evaluateToken("threads", { state: "skipped", reason: "--offline" }).structural, true);
    const net = evaluateToken("threads", { state: "unknown", reason: "HTTP 503" });
    assert.notEqual(net.structural, true);
    for (let i = 0; i < 10; i++) streak = updateUnverifiedStreak(streak, report({ checkedAt: at(i), checks: [ig] }));
    assert.deepEqual(streak.streaks, {});
    assert.deepEqual(fps(evaluateNeoReadinessAlarm({ kind: "ok", report: report() }, NOW, undefined, streak)), []);
    // o registro no KV preserva a marca (o alarme lê do KV)
    const back = parseReadinessRecord(serializeReadinessRecord(report({ checks: [ig, net] })), NOW);
    assert.equal(back.kind === "ok" ? back.report.checks[0].structural : null, true);
    for (let i = 10; i < 14; i++) streak = updateUnverifiedStreak(streak, report({ checkedAt: at(i), checks: [ig, net] }));
    assert.deepEqual(Object.keys(streak.streaks), ["token:threads"]);
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
    assert.ok(existsSync(join(REPO_ROOT, t.steps[0].script)));
  });
});

describe("CLI neo-readiness (deps falsas)", () => {
  const root = mkdtempSync(join(tmpdir(), "neo-readiness-12983-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "onboarding-watch-returning.ts"), "");
  writeFileSync(join(root, "scripts", "video-d1-link-watch.ts"), "");
  mkdirSync(join(root, "data", "onboarding"), { recursive: true });
  writeFileSync(join(root, "data", "onboarding", "store.json"), "{}");
  mkdirSync(join(root, "data", "alarme-do-300"), { recursive: true });
  writeFileSync(join(root, "data", "alarme-do-300", ".check.log"), "x");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), `${process.version.slice(1).split(".")[0]}\n`);
  const LOCK = JSON.stringify({ packages: { "node_modules/a": { version: "1.0.0" } } });
  writeFileSync(join(root, "package-lock.json"), LOCK);
  writeFileSync(join(root, "node_modules", ".package-lock.json"), LOCK);

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
  const skipTask: ScheduledTaskDefinition = { ...task, name: "Diaria-Do-300", steps: [], guard: undefined, failover: "skip", logPath: "alarme-do-300/.check.log" };
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
      tasks: [task, skipTask],
      log: (m) => out.push(m),
      err: (m) => out.push(m),
      ...over,
    };
    return { d, out, puts };
  }

  it("pronto: exit 0, uma linha por task (só as critical), sem gravar sem --record", async () => {
    const { d, out, puts } = deps();
    assert.equal(await readinessMain([], d), 0);
    assert.ok(out.some((l) => l === "Diaria-Onboarding-Watch-Returning: pronto"), out.join("\n"));
    assert.ok(!out.some((l) => l.startsWith("Diaria-Do-300")), out.join("\n"));
    assert.equal(puts.length, 0);
  });

  it("data/: o mtime vem do log do 300, não da escrita da própria sessão", async () => {
    const old = new Date(Date.now() - 5 * 86_400_000);
    utimesSync(join(root, "data", "alarme-do-300", ".check.log"), old, old);
    // escrita local recente (ex.: run-log.jsonl do Passo 0) não salva o check
    writeFileSync(join(root, "data", "run-log.jsonl"), "{}\n");
    try {
      const { d, out } = deps();
      assert.equal(await readinessMain(["--json"], d), 0);
      const r = JSON.parse(out[0]) as ReadinessReport;
      const data = r.checks.find((c) => c.id === "data");
      assert.equal(data?.status, "unverified");
      assert.match(data?.detail ?? "", /sem log novo do 300/);
    } finally {
      const now = new Date();
      utimesSync(join(root, "data", "alarme-do-300", ".check.log"), now, now);
      rmSync(join(root, "data", "run-log.jsonl"), { force: true });
    }
  });

  it("--json e --record no Neo: grava o relatório na chave certa, sem valor de segredo", async () => {
    const { d, out, puts } = deps();
    assert.equal(await readinessMain(["--json", "--record"], d), 0);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].key, NEO_READINESS_KV_KEY);
    assert.doesNotMatch(puts[0].value + out.join("\n"), new RegExp(SECRET));
    assert.equal(parseReadinessRecord(puts[0].value).kind, "ok");
  });

  it("--record fora do Neo: recusado (exit 2, nada gravado); com --force grava", async () => {
    const a = deps({ machineId: () => "predator" });
    assert.equal(await readinessMain(["--record"], a.d), 2);
    assert.equal(a.puts.length, 0);
    assert.match(a.out.join("\n"), /--record recusado/);
    const b = deps({ machineId: () => "predator" });
    assert.equal(await readinessMain(["--record", "--force"], b.d), 0);
    assert.equal(b.puts.length, 1);
  });

  it("--record falhando fora do --if-neo: exit 1", async () => {
    const { d } = deps({
      putKv: async () => {
        throw new Error("KV fora");
      },
    });
    assert.equal(await readinessMain(["--record"], d), 1);
  });

  it("checagem que lança é falta (falha do coletor), sem derrubar as outras", async () => {
    const { d, out } = deps({
      run: () => {
        throw new Error("spawn explodiu");
      },
    });
    assert.equal(await readinessMain([], d), 1);
    assert.ok(out.some((l) => /FALHA: gh: checagem falhou/.test(l)), out.join("\n"));
    assert.ok(out.some((l) => /^Diaria-Onboarding-Watch-Returning: falta gh: checagem falhou/.test(l)), out.join("\n"));
    assert.ok(!out.some((l) => /FALHA: node_modules/.test(l)), out.join("\n"));
  });

  it("node_modules/.package-lock.json corrompido: falta (rode npm ci)", async () => {
    writeFileSync(join(root, "node_modules", ".package-lock.json"), "{corrompido");
    try {
      const { d, out } = deps();
      assert.equal(await readinessMain([], d), 1);
      assert.ok(out.some((l) => /FALHA: node_modules\/\.package-lock\.json ilegível \(rode npm ci\)/.test(l)), out.join("\n"));
    } finally {
      writeFileSync(join(root, "node_modules", ".package-lock.json"), LOCK);
    }
  });

  it("falta segredo: exit 1", async () => {
    const { d, out } = deps({ readDotenv: () => ({ CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_WORKERS_TOKEN: "y" }) });
    assert.equal(await readinessMain([], d), 1);
    assert.ok(out.some((l) => /falta KIT_API_KEY: só no Doppler/.test(l)), out.join("\n"));
  });

  it("segredo só no ambiente da sessão (GOOGLE_* do app) não deixa a task pronta", async () => {
    const watch: ScheduledTaskDefinition = { ...task, name: "Diaria-Video-D1-Link-Watch", steps: [{ key: "w", script: "scripts/video-d1-link-watch.ts" }], guard: undefined };
    const sessionEnv = { GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "x", YOUTUBE_REFRESH_TOKEN: "x", DIARIA_LINKEDIN_CRON_URL: "x", DIARIA_LINKEDIN_CRON_TOKEN: "x" };
    const { d, out } = deps({ tasks: [watch, skipTask], env: sessionEnv, dopplerNames: () => ({ error: "sem login" }) });
    assert.equal(await readinessMain([], d), 1);
    assert.ok(out.some((l) => /^Diaria-Video-D1-Link-Watch: falta GOOGLE_CLIENT_ID: ausente do \.env; existe só no ambiente da sessão/.test(l)), out.join("\n"));
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

  it("--if-neo: tetos curtos e prazo global; o que sobra sai não verificado, pulada por prazo", async () => {
    // Relógio falso: cada leitura avança 1,5 s, então o prazo de 30 s estoura no meio da coleta.
    let t = Date.parse("2026-11-13T12:00:00Z");
    const spawnTimeouts: number[] = [];
    const { d, out, puts } = deps({
      now: () => new Date((t += 1_500)),
      run: (cmd, args, _cwd, timeoutMs) => {
        spawnTimeouts.push(timeoutMs);
        if (cmd === "gh") return { code: 0, stdout: "" };
        if (args[0] === "rev-parse") return { code: 0, stdout: "master\n" };
        if (args[0] === "rev-list") return { code: 0, stdout: "0\n" };
        return { code: 0, stdout: "" };
      },
    });
    assert.equal(await readinessMain(["--if-neo", "--record"], d), 0);
    assert.ok(spawnTimeouts.length > 0 && spawnTimeouts.every((ms) => ms <= 12_000), String(spawnTimeouts));
    const rec = parseReadinessRecord(puts[0].value);
    assert.equal(rec.kind, "ok");
    if (rec.kind !== "ok") return;
    const skippedChecks = rec.report.checks.filter((c) => /pulada por prazo/.test(c.detail));
    assert.ok(skippedChecks.length > 0, JSON.stringify(rec.report.checks));
    assert.ok(skippedChecks.every((c) => c.status === "unverified"));
    assert.match(out.join("\n"), /\[neo-readiness\] prontidão/);
  });

  it("flag desconhecida: exit 2", async () => {
    const { d } = deps();
    assert.equal(await readinessMain(["--armar"], d), 2);
  });
});

describe("CLI neo-readiness-alarm (deps falsas)", () => {
  function deps(over: Partial<AlarmDeps> = {}) {
    const calls = { saveIssues: 0, saveStreak: 0, apply: 0 };
    const out: string[] = [];
    const d: Partial<AlarmDeps> = {
      now: () => NOW,
      loadEnv: () => {},
      readRecord: async () => ({ kind: "ok", report: report() }),
      loadIssues: () => ({}) as AlarmIssuesState,
      saveIssues: () => {
        calls.saveIssues++;
      },
      loadStreak: () => EMPTY_UNVERIFIED_STREAK,
      saveStreak: () => {
        calls.saveStreak++;
      },
      apply: (_f, state) => {
        calls.apply++;
        return { nextState: state, findingOutcomes: [] };
      },
      log: (m) => out.push(m),
      err: (m) => out.push(m),
      ...over,
    };
    return { d, calls, out };
  }

  it("KV ilegível: exit 1 sem reconciliar nem salvar estado", async () => {
    const { d, calls, out } = deps({ readRecord: async () => ({ kind: "error", error: "rede fora" }) });
    assert.equal(await alarmMain([], d), 1);
    assert.deepEqual(calls, { saveIssues: 0, saveStreak: 0, apply: 0 });
    assert.match(out.join("\n"), /KV ilegível \(rede fora\)/);
  });

  it("verde: reconcilia e salva; --dry-run não salva nada", async () => {
    const a = deps();
    assert.equal(await alarmMain([], a.d), 0);
    assert.equal(a.calls.apply, 1);
    assert.equal(a.calls.saveIssues, 1);
    assert.equal(a.calls.saveStreak, 1);
    const b = deps();
    assert.equal(await alarmMain(["--dry-run"], b.d), 0);
    assert.deepEqual(b.calls, { saveIssues: 0, saveStreak: 0, apply: 0 });
  });
});

describe("#13002: token do Instagram pela leitura do perfil", () => {
  const ENV_IG = { INSTAGRAM_ACCESS_TOKEN: "tok-ig-secreto-77", INSTAGRAM_BUSINESS_ACCOUNT_ID: "1784" };
  const resp = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("classifica: 200 com id válido; 190/401/403/400 inválido; limite, 5xx e sem id desconhecido", () => {
    assert.equal(classifyInstagramProfileResponse(200, { id: "1784", username: "diar.ia.br" }).state, "valid");
    assert.equal(classifyInstagramProfileResponse(400, { error: { code: 190, message: "Error validating access token: Session has expired" } }).state, "invalid");
    assert.equal(classifyInstagramProfileResponse(401, {}).state, "invalid");
    assert.equal(classifyInstagramProfileResponse(403, null).state, "invalid");
    assert.equal(classifyInstagramProfileResponse(400, { error: { code: 100, message: "Unsupported get request" } }).state, "invalid");
    assert.equal(classifyInstagramProfileResponse(400, { error: { code: 4, message: "Application request limit reached" } }).state, "unknown");
    assert.equal(classifyInstagramProfileResponse(500, null).state, "unknown");
    assert.equal(classifyInstagramProfileResponse(200, {}).state, "unknown");
  });

  it("GET só de leitura no perfil da conta, token no header e nunca na URL", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (u: string, i?: RequestInit) => {
      calls.push({ url: String(u), init: i });
      return new Response(JSON.stringify({ id: "1784" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await probeInstagramToken({ env: { ...ENV_IG, FACEBOOK_API_VERSION: "v99.0" }, fetch: f });
    assert.equal(r.state, "valid");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init?.method, "GET");
    assert.equal(calls[0].url, "https://graph.facebook.com/v99.0/1784?fields=id,username");
    assert.doesNotMatch(calls[0].url, /tok-ig-secreto-77/);
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer tok-ig-secreto-77");
  });

  it("credencial ausente: skipped (o segredo já sai como falta); rede caída: unknown", async () => {
    assert.equal((await probeInstagramToken({ env: {}, fetch: resp(200, { id: "x" }) })).state, "skipped");
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    assert.equal((await probeInstagramToken({ env: ENV_IG, fetch: down })).state, "unknown");
  });

  it("probeInstagram + evaluateToken: token vencido vira FALTA (não mais 'não verificado' estrutural)", async () => {
    const expired = await probeInstagram(ENV_IG, resp(400, { error: { code: 190, message: "Session has expired" } }));
    const c = evaluateToken("instagram", expired);
    assert.equal(c.status, "fail");
    assert.notEqual(c.structural, true);
    assert.equal(evaluateToken("instagram", await probeInstagram(ENV_IG, resp(200, { id: "1784" }))).status, "ok");
  });

  it("coletor: task com token instagram vencido não fica pronta", async () => {
    const root = mkdtempSync(join(tmpdir(), "neo-readiness-ig-13002-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts", "shorts-instagram-timer.ts"), "");
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(join(root, ".nvmrc"), `${process.version.slice(1).split(".")[0]}\n`);
      const LOCK = JSON.stringify({ packages: {} });
      writeFileSync(join(root, "package-lock.json"), LOCK);
      writeFileSync(join(root, "node_modules", ".package-lock.json"), LOCK);
      mkdirSync(join(root, "data"), { recursive: true });
      const req = CRITICAL_SCRIPT_REQUIREMENTS["scripts/shorts-instagram-timer.ts"];
      const dotenv: Record<string, string> = { CLOUDFLARE_ACCOUNT_ID: "x", CLOUDFLARE_WORKERS_TOKEN: "x", ...ENV_IG };
      for (const names of req.secrets) dotenv[names[0]] ??= "x";
      const task: ScheduledTaskDefinition = {
        name: "Diaria-Shorts-Instagram",
        description: "",
        steps: [{ key: "s", script: "scripts/shorts-instagram-timer.ts" }],
        logPath: "x.log",
        schedule: { kind: "daily", hour: 1, minute: 0 },
        issue: "#1",
        failover: "critical",
      };
      const out: string[] = [];
      const code = await readinessMain([], {
        root,
        now: () => new Date(),
        machineId: () => "Neo",
        env: {},
        readDotenv: () => dotenv,
        dopplerNames: () => ({ error: "sem login" }),
        run: (cmd, args) => (cmd === "git" && args[0] === "rev-parse" ? { code: 0, stdout: "master\n" } : { code: 0, stdout: cmd === "git" && args[0] === "rev-list" ? "0\n" : "" }),
        fetch: resp(400, { error: { code: 190, message: "Session has expired" } }),
        putKv: async () => {},
        tasks: [task],
        log: (m) => out.push(m),
        err: (m) => out.push(m),
      });
      assert.equal(code, 1);
      assert.ok(out.some((l) => /^Diaria-Shorts-Instagram: falta .*token instagram inválido/.test(l)), out.join("\n"));
      assert.doesNotMatch(out.join("\n"), /tok-ig-secreto-77/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
