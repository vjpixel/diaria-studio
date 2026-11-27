/**
 * test/brevo-diaria-stage5-skip-rapido-13981.test.ts (#13981)
 *
 * Regressão: no regime semanal (#11226), a edição que não é de segunda saía
 * `skipped` só DEPOIS do `brevo-diaria-run.ts --apply` (>5 min de rede: pool
 * Pending, MV, Brevo, Kit). Agora a decisão por data vem antes de qualquer
 * sub-script: zero chamadas a `exec` (o único caminho de rede do dispatch).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runStage5BrevoDispatch, type Stage5BrevoDeps } from "../scripts/brevo-diaria-stage5-dispatch.ts";
import type { BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDailyApply, type DailyApplyDeps } from "../scripts/brevo-diaria-daily-apply.ts";
import { readDailyApplyMarker, writeDailyApplyMarker, type DailyApplyMarker } from "../scripts/lib/brevo-diaria-daily-apply.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

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
// `Diaria-Brevo-Diaria-Evaluate` (05:30), no máximo 1x por dia BRT entre a
// task e o dispatch da Etapa 5.
// ---------------------------------------------------------------------------

/** Terça 24/11/2026, 05:30 BRT. */
const TUE_0530 = new Date("2026-11-24T08:30:00Z");
/** Domingo 22/11/2026, 20:00 BRT — dispatch típico da edição de segunda 261123. */
const SUN_2000 = new Date("2026-11-22T23:00:00Z");
/** Segunda 23/11/2026, 05:30 BRT. */
const MON_0530 = new Date("2026-11-23T08:30:00Z");

function sharedMarker(initial: DailyApplyMarker | null = null) {
  const box = { marker: initial };
  return {
    box,
    readMarker: () => box.marker,
    writeMarker: (m: DailyApplyMarker) => {
      box.marker = m;
    },
  };
}

function taskDeps(calls: string[], m: ReturnType<typeof sharedMarker>, now: Date, code = 0): DailyApplyDeps {
  return {
    exec: (script, args) => {
      calls.push(`${script} ${args.join(" ")}`);
      return { code, stdout: "", stderr: "" };
    },
    now: () => now,
    readMarker: m.readMarker,
    writeMarker: m.writeMarker,
    log: () => {},
  };
}

const applyCount = (calls: string[]) => calls.filter((c) => c.startsWith("scripts/brevo-diaria-run.ts")).length;

describe("task 05:30 roda o --apply diário (#13981)", () => {
  it("registro: o passo da Diaria-Brevo-Diaria-Evaluate é o daily-apply (não mais só o evaluate)", () => {
    const t = getScheduledTaskByName("Diaria-Brevo-Diaria-Evaluate");
    assert.ok(t);
    assert.deepEqual(t.steps.map((s) => s.script), ["scripts/brevo-diaria-daily-apply.ts"]);
    assert.equal(t.guard?.requiredFile, "brevo-diaria/contacts.json");
  });

  it("REGRESSÃO: terça (sem campanha) ⇒ a task roda brevo-diaria-run --apply e grava o marcador do dia", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runDailyApply(taskDeps(calls, m, TUE_0530));
    assert.equal(r.code, 0);
    assert.equal(r.ran, true);
    assert.deepEqual(calls, ["scripts/brevo-diaria-run.ts --apply"]);
    assert.equal(m.box.marker?.day, "2026-11-24");
    assert.equal(m.box.marker?.by, "task-05:30");
  });

  it("marcador de ontem ⇒ roda de novo hoje", () => {
    const calls: string[] = [];
    const m = sharedMarker({ day: "2026-11-23", at: "2026-11-23T08:40:00Z", by: "task-05:30" });
    runDailyApply(taskDeps(calls, m, TUE_0530));
    assert.equal(applyCount(calls), 1);
  });

  it("--apply falhou ⇒ exit propagado e marcador NÃO gravado (o dispatch do dia tenta de novo)", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runDailyApply(taskDeps(calls, m, TUE_0530, 4));
    assert.equal(r.code, 4);
    assert.equal(m.box.marker, null);
  });

  it("dispatch já rodou o --apply hoje ⇒ a task pula (exit 0, zero exec)", () => {
    const calls: string[] = [];
    const m = sharedMarker({ day: "2026-11-23", at: "2026-11-23T03:10:00Z", by: "stage5-dispatch" });
    const r = runDailyApply(taskDeps(calls, m, MON_0530));
    assert.deepEqual({ code: r.code, ran: r.ran }, { code: 0, ran: false });
    assert.deepEqual(calls, []);
  });
});

describe("sem --apply duplicado no dia da edição de segunda (#13981)", () => {
  function dispatchDeps(calls: string[], m: ReturnType<typeof sharedMarker>, now: Date): Stage5BrevoDeps {
    return { ...deps(calls), dailyApply: { now: () => now, readMarker: m.readMarker, writeMarker: m.writeMarker } };
  }

  it("REGRESSÃO: task 05:30 de domingo + dispatch da edição de segunda no domingo à noite ⇒ 1 --apply só, campanha sai", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    runDailyApply(taskDeps(calls, m, new Date("2026-11-22T08:30:00Z")));
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", dispatchDeps(calls, m, SUN_2000));
    assert.equal(r.status, "ok");
    assert.equal(applyCount(calls), 1);
    assert.ok(calls.includes("scripts/publish-daily-brevo.ts"));
  });

  it("dispatch da segunda antes da task do dia (madrugada) ⇒ dispatch roda o --apply, grava o marcador, e a task das 05:30 pula", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", dispatchDeps(calls, m, new Date("2026-11-23T04:00:00Z")));
    assert.equal(r.status, "ok");
    assert.equal(m.box.marker?.by, "stage5-dispatch");
    assert.equal(m.box.marker?.day, "2026-11-23");
    const t = runDailyApply(taskDeps(calls, m, MON_0530));
    assert.equal(t.ran, false);
    assert.equal(applyCount(calls), 1);
  });

  it("dia BRT, não UTC: 23/11 01:00 UTC ainda é 22/11 em BRT", () => {
    const calls: string[] = [];
    const m = sharedMarker({ day: "2026-11-22", at: "2026-11-22T08:40:00Z", by: "task-05:30" });
    runStage5BrevoDispatch("/fake/data/editions/2611/261123", dispatchDeps(calls, m, new Date("2026-11-23T01:00:00Z")));
    assert.equal(applyCount(calls), 0, "marcador de 22/11 BRT vale para 22/11 22:00 BRT");
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
  it("round-trip", () => {
    const p = join(dir, "sub", ".daily-apply.json");
    const mk: DailyApplyMarker = { day: "2026-11-24", at: "2026-11-24T08:41:00.000Z", by: "task-05:30" };
    writeDailyApplyMarker(mk, p);
    assert.deepEqual(readDailyApplyMarker(p), mk);
  });
});
