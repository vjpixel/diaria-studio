/**
 * test/brevo-diaria-stage5-skip-rapido-13981.test.ts (#13981)
 *
 * Regressão: no regime semanal (#11226), a edição que não é de segunda saía
 * `skipped` só DEPOIS do `brevo-diaria-run.ts --apply` (>5 min de rede: pool
 * Pending, MV, Brevo, Kit). Agora a decisão por data vem antes de qualquer
 * sub-script: zero chamadas a `exec` (o único caminho de rede do dispatch).
 * E o `--apply` segue diário pela task das 05:30 (decisão do editor).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage5BrevoDispatch, type Stage5BrevoDeps } from "../scripts/brevo-diaria-stage5-dispatch.ts";
import type { BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";
import { DAILY_APPLY_WARNINGS_EXIT_CODE, runDailyApply, type DailyApplyDeps } from "../scripts/brevo-diaria-daily-apply.ts";
import { readDailyApplyMarker, withDailyApplyLock, writeDailyApplyMarker, type DailyApplyMarker } from "../scripts/lib/brevo-diaria-daily-apply.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const RUN_OK = JSON.stringify({ code: 0, warnings: [] });

function deps(calls: string[], contacts: readonly BrevoDiariaContact[] = [], semanal: unknown = { enabled: true, desde: "2026-11-02" }): Stage5BrevoDeps {
  return {
    rootDir: "/fake",
    exec: (script) => {
      calls.push(script);
      return { code: 0, stdout: JSON.stringify({ warnings: [] }), stderr: "" };
    },
    storeExists: () => true,
    readContacts: () => contacts,
    readPlatformConfig: () => ({ brevo_diaria: { stage5_target_total: 290, semanal } }),
    readPublished: () => (calls.includes("scripts/publish-daily-brevo.ts") ? { campaign_id: 7 } : null),
  };
}

describe("brevo-diaria stage5 — skip rápido fora da segunda (#13981)", () => {
  for (const edition of ["261124", "261125", "261126", "261127", "261128"]) {
    it(`REGRESSÃO: ${edition} (não é segunda) ⇒ skipped com a mesma saída, ZERO chamadas de sub-script/rede`, () => {
      const calls: string[] = [];
      const r = runStage5BrevoDispatch(`/fake/data/editions/2611/${edition}`, deps(calls));
      assert.deepEqual(r, {
        status: "skipped",
        reason: `regime semanal (#11226): a edição ${edition} não é de segunda — sem campanha Brevo.`,
        warnings: [],
      });
      assert.deepEqual(calls, []);
    });
  }

  it("segunda (261123) ⇒ caminho cheio: --apply e campanha", () => {
    const calls: string[] = [];
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", deps(calls));
    assert.equal(r.status, "ok");
    assert.deepEqual(calls, ["scripts/brevo-diaria-run.ts", "scripts/publish-daily-brevo.ts"]);
  });

  it("guarda de transição (#10533): kit-sem-abertura: em in_brevo ⇒ sem skip rápido, sai diária", () => {
    const calls: string[] = [];
    const residuo = [{ email: "a@x.com", status: "in_brevo", beehiiv_subscription_id: "kit-sem-abertura:123" }] as unknown as BrevoDiariaContact[];
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", deps(calls, residuo));
    assert.equal(r.status, "ok");
    assert.ok(calls.includes("scripts/brevo-diaria-run.ts"));
  });

  it("regime semanal desligado ⇒ diária como antes, --apply roda", () => {
    const calls: string[] = [];
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", deps(calls, [], null));
    assert.equal(r.status, "ok");
    assert.ok(calls.includes("scripts/brevo-diaria-run.ts"));
  });
});

// ---------------------------------------------------------------------------
// #13981 (decisão do editor, 27/11/2026): o --apply segue DIÁRIO pela task
// `Diaria-Brevo-Diaria-Evaluate` (05:30). O dispatch, com campanha, roda
// sempre e grava o marcador; a task pula se o marcador já é do dia BRT.
// ---------------------------------------------------------------------------

/** Terça 24/11/2026, 05:30 BRT. */
const TUE_0530 = new Date("2026-11-24T08:30:00Z");
/** Domingo 22/11/2026, 20:00 BRT — dispatch típico da edição de segunda 261123. */
const SUN_2000 = new Date("2026-11-22T23:00:00Z");
/** Segunda 23/11/2026, 05:30 BRT. */
const MON_0530 = new Date("2026-11-23T08:30:00Z");

function sharedMarker(initial: DailyApplyMarker | null = null, writeThrows = false) {
  const box = { marker: initial, locks: 0 };
  return {
    box,
    readMarker: () => box.marker,
    writeMarker: (m: DailyApplyMarker) => {
      if (writeThrows) throw new Error("EACCES simulado");
      box.marker = m;
    },
    withLock: <T>(fn: () => T): T => {
      box.locks++;
      return fn();
    },
  };
}

const CONFIG_ON = { brevo_diaria: { stage5_target_total: 290 } };

function taskDeps(
  calls: string[],
  m: ReturnType<typeof sharedMarker>,
  now: Date,
  opts: { code?: number; stdout?: string; config?: { brevo_diaria?: { stage5_target_total?: number | null } } } = {},
): DailyApplyDeps {
  return {
    exec: (script, args) => {
      calls.push(`${script} ${args.join(" ")}`);
      return { code: opts.code ?? 0, stdout: opts.stdout ?? RUN_OK, stderr: "" };
    },
    now: () => now,
    readMarker: m.readMarker,
    writeMarker: m.writeMarker,
    withLock: m.withLock,
    readPlatformConfig: () => opts.config ?? CONFIG_ON,
    log: () => {},
  };
}

function dispatchDeps(
  calls: string[],
  m: ReturnType<typeof sharedMarker>,
  now: Date,
  opts: { contacts?: readonly BrevoDiariaContact[]; applyCode?: number; applyStdout?: string } = {},
): Stage5BrevoDeps {
  const base = deps(calls, opts.contacts ?? []);
  return {
    ...base,
    exec: (script, args) => {
      calls.push(script);
      if (script === "scripts/brevo-diaria-run.ts") {
        return { code: opts.applyCode ?? 0, stdout: opts.applyStdout ?? RUN_OK, stderr: opts.applyCode ? "boom no passo 2" : "" };
      }
      return base.exec(script, args);
    },
    dailyApply: { now: () => now, readMarker: m.readMarker, writeMarker: m.writeMarker, withLock: m.withLock },
  };
}

const applyCount = (calls: string[]) => calls.filter((c) => c.startsWith("scripts/brevo-diaria-run.ts")).length;

describe("task 05:30 roda o --apply diário (#13981)", () => {
  it("registro: o passo da Diaria-Brevo-Diaria-Evaluate é o daily-apply, com o guard do store e a issue", () => {
    const t = getScheduledTaskByName("Diaria-Brevo-Diaria-Evaluate");
    assert.ok(t);
    assert.deepEqual(t.steps.map((s) => s.script), ["scripts/brevo-diaria-daily-apply.ts"]);
    assert.equal(t.guard?.requiredFile, "brevo-diaria/contacts.json");
    assert.match(t.issue, /#13981/);
  });

  it("REGRESSÃO: terça (sem campanha) ⇒ a task roda brevo-diaria-run --apply, sob lock, e grava o marcador do dia", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runDailyApply(taskDeps(calls, m, TUE_0530));
    assert.deepEqual({ code: r.code, ran: r.ran }, { code: 0, ran: true });
    assert.deepEqual(calls, ["scripts/brevo-diaria-run.ts --apply"]);
    assert.deepEqual(m.box.marker, { day: "2026-11-24", at: TUE_0530.toISOString(), by: "task-05:30", warnings: [] });
    assert.equal(m.box.locks, 1);
  });

  it("marcador de ontem ⇒ roda de novo hoje", () => {
    const calls: string[] = [];
    const m = sharedMarker({ day: "2026-11-23", at: "2026-11-23T08:40:00Z", by: "task-05:30", warnings: [] });
    runDailyApply(taskDeps(calls, m, TUE_0530));
    assert.equal(applyCount(calls), 1);
  });

  it("--apply falhou ⇒ exit propagado e marcador NÃO gravado", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runDailyApply(taskDeps(calls, m, TUE_0530, { code: 1 }));
    assert.equal(r.code, 1);
    assert.equal(m.box.marker, null);
  });

  it("REGRESSÃO (review P2): aviso do --apply (exit 3 do evaluate vira aviso lá dentro) ⇒ task sai 3, marcador gravado com o aviso", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const w = "Passo 1 (evaluate): 2 contato(s) com falha/skip (exit 3)";
    const r = runDailyApply(taskDeps(calls, m, TUE_0530, { stdout: JSON.stringify({ code: 0, warnings: [w, "sync-kit-frio: Kit 503"] }) }));
    assert.equal(r.code, DAILY_APPLY_WARNINGS_EXIT_CODE);
    assert.notEqual(r.code, 0);
    assert.deepEqual(m.box.marker?.warnings, [w, "sync-kit-frio: Kit 503"]);
  });

  it("stdout sem JSON ⇒ aviso (nunca verde silencioso) ⇒ task sai 3", () => {
    const calls: string[] = [];
    const r = runDailyApply(taskDeps(calls, sharedMarker(), TUE_0530, { stdout: "lixo" }));
    assert.equal(r.code, DAILY_APPLY_WARNINGS_EXIT_CODE);
  });

  it("writeMarker lança ⇒ --apply conta como rodado, aviso, task sai 3", () => {
    const calls: string[] = [];
    const r = runDailyApply(taskDeps(calls, sharedMarker(null, true), TUE_0530));
    assert.equal(r.ran, true);
    assert.equal(r.code, DAILY_APPLY_WARNINGS_EXIT_CODE);
    assert.ok(r.warnings.some((w) => w.includes("marcador do --apply diário não gravado")));
  });

  it("dispatch já rodou o --apply hoje ⇒ a task pula (exit 0, zero exec)", () => {
    const calls: string[] = [];
    const m = sharedMarker({ day: "2026-11-23", at: "2026-11-23T03:10:00Z", by: "stage5-dispatch", warnings: [] });
    const r = runDailyApply(taskDeps(calls, m, MON_0530));
    assert.deepEqual({ code: r.code, ran: r.ran }, { code: 0, ran: false });
    assert.deepEqual(calls, []);
  });

  for (const [label, config] of [
    ["brevo_diaria ausente", {}],
    ["stage5_target_total null", { brevo_diaria: { stage5_target_total: null } }],
    ["stage5_target_total negativo", { brevo_diaria: { stage5_target_total: -1 } }],
  ] as const) {
    it(`kill switch: ${label} ⇒ sai 0 sem rodar nada nem gravar marcador`, () => {
      const calls: string[] = [];
      const m = sharedMarker();
      const r = runDailyApply(taskDeps(calls, m, TUE_0530, { config }));
      assert.deepEqual({ code: r.code, ran: r.ran }, { code: 0, ran: false });
      assert.deepEqual(calls, []);
      assert.equal(m.box.marker, null);
    });
  }
});

describe("dispatch com campanha roda sempre o --apply e grava o marcador (#13981)", () => {
  it("REGRESSÃO (review): task de domingo 05:30 + dispatch da edição de segunda no domingo à noite ⇒ o dispatch roda o --apply de novo antes da campanha", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    runDailyApply(taskDeps(calls, m, new Date("2026-11-22T08:30:00Z")));
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", dispatchDeps(calls, m, SUN_2000));
    assert.equal(r.status, "ok");
    assert.equal(applyCount(calls), 2);
    assert.ok(calls.indexOf("scripts/publish-daily-brevo.ts") > calls.lastIndexOf("scripts/brevo-diaria-run.ts"), "--apply antes da campanha");
    assert.equal(m.box.marker?.by, "stage5-dispatch");
  });

  it("dispatch de madrugada antes da task do dia ⇒ dispatch roda, grava o marcador, e a task das 05:30 pula", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", dispatchDeps(calls, m, new Date("2026-11-23T04:00:00Z")));
    assert.equal(r.status, "ok");
    assert.equal(m.box.marker?.day, "2026-11-23");
    assert.equal(m.box.locks, 1);
    const t = runDailyApply(taskDeps(calls, m, MON_0530));
    assert.equal(t.ran, false);
    assert.equal(applyCount(calls), 1);
  });

  it("dia BRT, não UTC: dispatch em 23/11 01:00 UTC grava o marcador de 22/11", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", dispatchDeps(calls, m, new Date("2026-11-23T01:00:00Z")));
    assert.equal(r.status, "ok");
    assert.equal(m.box.marker?.day, "2026-11-22");
  });

  it("--apply do dispatch falhando ⇒ failed, sem campanha e sem marcador", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", dispatchDeps(calls, m, SUN_2000, { applyCode: 1 }));
    assert.equal(r.status, "failed");
    assert.equal(r.status === "failed" && r.step, "brevo-diaria-run --apply");
    assert.ok(!calls.includes("scripts/publish-daily-brevo.ts"));
    assert.equal(m.box.marker, null);
  });

  it("writeMarker lança no dispatch ⇒ campanha sai, aviso no resultado", () => {
    const calls: string[] = [];
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", dispatchDeps(calls, sharedMarker(null, true), SUN_2000));
    assert.equal(r.status, "ok");
    assert.ok(r.status === "ok" && r.warnings.some((w) => w.includes("marcador do --apply diário não gravado")));
  });

  it("guarda de transição (#10533) com marcador do dia: dispatch de terça roda o --apply mesmo assim e sai diária", () => {
    const calls: string[] = [];
    const m = sharedMarker({ day: "2026-11-24", at: TUE_0530.toISOString(), by: "task-05:30", warnings: [] });
    const residuo = [{ email: "a@x.com", status: "in_brevo", beehiiv_subscription_id: "kit-sem-abertura:1" }] as unknown as BrevoDiariaContact[];
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", dispatchDeps(calls, m, new Date("2026-11-24T20:00:00Z"), { contacts: residuo }));
    assert.equal(r.status, "ok");
    assert.equal(applyCount(calls), 1);
    assert.ok(calls.includes("scripts/publish-daily-brevo.ts"));
  });

  it("lock que não sai ⇒ failed (step daily-apply-lock), nada roda", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const d = dispatchDeps(calls, m, SUN_2000);
    d.dailyApply!.withLock = () => {
      throw new Error("[file-lock] timeout");
    };
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", d);
    assert.equal(r.status, "failed");
    assert.equal(r.status === "failed" && r.step, "daily-apply-lock");
    assert.deepEqual(calls, []);
  });
});

describe("skip rápido repassa os avisos do --apply de hoje (review P2, #13981)", () => {
  it("terça com marcador do dia com aviso ⇒ skipped, zero exec, aviso no resultado", () => {
    const calls: string[] = [];
    const m = sharedMarker({ day: "2026-11-24", at: TUE_0530.toISOString(), by: "task-05:30", warnings: ["sync-kit-frio: Kit 503"] });
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", dispatchDeps(calls, m, new Date("2026-11-24T20:00:00Z")));
    assert.equal(r.status, "skipped");
    assert.deepEqual(calls, []);
    assert.deepEqual(r.status === "skipped" && r.warnings, ["--apply de hoje (task-05:30): sync-kit-frio: Kit 503"]);
  });

  it("marcador de outro dia ⇒ avisos não vêm", () => {
    const calls: string[] = [];
    const m = sharedMarker({ day: "2026-11-23", at: "x", by: "task-05:30", warnings: ["velho"] });
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", dispatchDeps(calls, m, new Date("2026-11-24T20:00:00Z")));
    assert.deepEqual(r.status === "skipped" && r.warnings, []);
  });
});

describe("readDailyApplyMarker é fail-soft (#13981)", () => {
  const dir = mkdtempSync(join(tmpdir(), "daily-apply-13981-"));
  it("ausente ou inválido ⇒ null (o caller roda o --apply)", () => {
    assert.equal(readDailyApplyMarker(join(dir, "nao-existe.json")), null);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{nao json");
    assert.equal(readDailyApplyMarker(bad), null);
    writeFileSync(bad, JSON.stringify({ day: "24/11", at: "x", by: "task-05:30" }));
    assert.equal(readDailyApplyMarker(bad), null);
  });
  it("round-trip; warnings ausente vira []", () => {
    const p = join(dir, "sub", ".daily-apply.json");
    const mk: DailyApplyMarker = { day: "2026-11-24", at: "2026-11-24T08:41:00.000Z", by: "task-05:30", warnings: ["a"] };
    writeDailyApplyMarker(mk, p);
    assert.deepEqual(readDailyApplyMarker(p), mk);
    writeFileSync(p, JSON.stringify({ day: "2026-11-24", at: "x", by: "stage5-dispatch" }));
    assert.deepEqual(readDailyApplyMarker(p)?.warnings, []);
  });
  it("withDailyApplyLock: roda o fn, solta o lock (2ª chamada não espera)", () => {
    const p = join(dir, "lk", ".daily-apply.json");
    assert.equal(withDailyApplyLock(() => 1, p), 1);
    assert.equal(withDailyApplyLock(() => 2, p), 2);
    assert.equal(existsSync(p + ".lock"), false);
  });
});
