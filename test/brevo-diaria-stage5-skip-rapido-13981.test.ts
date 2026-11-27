/**
 * test/brevo-diaria-stage5-skip-rapido-13981.test.ts (#13981)
 *
 * Regressão: no regime semanal (#11226), a edição que não é de segunda saía
 * `skipped` só DEPOIS do `brevo-diaria-run.ts --apply` (>5 min de rede: pool
 * Pending, MV, Brevo, Kit). Agora a decisão por data vem antes de qualquer
 * sub-script: zero chamadas a `exec` (o único caminho de rede do dispatch).
 * E o `--apply` segue diário pela task das 05:30 (decisão do editor).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  productionDeps,
  realExec,
  runStage5BrevoDispatch,
  skipRapidoApplyWarnings,
  type Stage5BrevoDeps,
} from "../scripts/brevo-diaria-stage5-dispatch.ts";
import type { BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";
import {
  DAILY_APPLY_WARNINGS_EXIT_CODE,
  resolveDailyApplyMode,
  runDailyApply,
  type DailyApplyDeps,
} from "../scripts/brevo-diaria-daily-apply.ts";
import {
  DAILY_APPLY_LOCK_PATH,
  readDailyApplyMarker,
  withDailyApplyLock,
  writeDailyApplyMarker,
  type DailyApplyMarker,
} from "../scripts/lib/brevo-diaria-daily-apply.ts";
import { isValidStage5TargetTotal } from "../scripts/lib/brevo-diaria-max-add.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import { TRANSIENT_NETWORK_EXIT_CODE } from "../scripts/lib/transient-network-failure.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const RESIDUO = [{ email: "a@x.com", status: "in_brevo", beehiiv_subscription_id: "kit-sem-abertura:123" }] as unknown as BrevoDiariaContact[];

describe("brevo-diaria stage5 — skip rápido fora da segunda (#13981)", () => {
  for (const edition of ["261124", "261125", "261126", "261127", "261128"]) {
    it(`REGRESSÃO: ${edition} (não é segunda) ⇒ skipped, ZERO chamadas de sub-script/rede`, () => {
      const calls: string[] = [];
      const r = runStage5BrevoDispatch(`/fake/data/editions/2611/${edition}`, deps(calls));
      assert.equal(r.status, "skipped");
      assert.match(r.status === "skipped" ? r.reason : "", new RegExp(`regime semanal \\(#11226\\).*${edition}.*não é de segunda`));
      assert.deepEqual(r.status === "skipped" && r.warnings, []);
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
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", deps(calls, RESIDUO));
    assert.equal(r.status, "ok");
    assert.ok(calls.includes("scripts/brevo-diaria-run.ts"));
  });

  it("resíduo que zera depois do --apply numa terça ⇒ --apply roda, campanha não sai (decisão pós-apply, como antes)", () => {
    const calls: string[] = [];
    const d = deps(calls);
    d.readContacts = () => (calls.includes("scripts/brevo-diaria-run.ts") ? [] : RESIDUO);
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", d);
    assert.equal(r.status, "skipped");
    assert.deepEqual(calls, ["scripts/brevo-diaria-run.ts"]);
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
/** Terça 24/11/2026, 17:00 BRT. */
const TUE_1700 = new Date("2026-11-24T20:00:00Z");
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
  opts: { code?: number; stdout?: string; stderr?: string; config?: { brevo_diaria?: { stage5_target_total?: unknown } } } = {},
): DailyApplyDeps {
  return {
    exec: (script, args) => {
      calls.push(`${script} ${args.join(" ")}`);
      return { code: opts.code ?? 0, stdout: opts.stdout ?? RUN_OK, stderr: opts.stderr ?? "" };
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
  opts: { contacts?: readonly BrevoDiariaContact[]; applyCode?: number; applyStdout?: string; applyThrows?: boolean } = {},
): Stage5BrevoDeps {
  const base = deps(calls, opts.contacts ?? []);
  return {
    ...base,
    exec: (script, args) => {
      calls.push(script);
      if (script === "scripts/brevo-diaria-run.ts") {
        if (opts.applyThrows) throw new Error("spawn quebrou");
        return { code: opts.applyCode ?? 0, stdout: opts.applyStdout ?? RUN_OK, stderr: opts.applyCode ? "boom no passo 2" : "" };
      }
      return base.exec(script, args);
    },
    dailyApply: { now: () => now, readMarker: m.readMarker, writeMarker: m.writeMarker, withLock: m.withLock },
  };
}

const applyCount = (calls: string[]) => calls.filter((c) => c.startsWith("scripts/brevo-diaria-run.ts")).length;
const marker = (over: Partial<DailyApplyMarker> = {}): DailyApplyMarker => ({
  day: "2026-11-24",
  at: TUE_0530.toISOString(),
  by: "task-05:30",
  warnings: [],
  ...over,
});

describe("task 05:30 roda o --apply diário (#13981)", () => {
  it("registro: passo daily-apply, guard do store, retry por rede declarado pelo passo, issue", () => {
    const t = getScheduledTaskByName("Diaria-Brevo-Diaria-Evaluate");
    assert.ok(t);
    assert.deepEqual(t.steps.map((s) => s.script), ["scripts/brevo-diaria-daily-apply.ts"]);
    assert.equal(t.guard?.requiredFile, "brevo-diaria/contacts.json");
    assert.match(t.guard?.abortMessage ?? "", /--apply diario/);
    assert.equal(t.retryOnTransientNetwork, "step-declares");
    assert.match(t.issue, /#13981/);
  });

  it("REGRESSÃO: terça (sem campanha) ⇒ a task roda brevo-diaria-run --apply, sob lock, e grava o marcador do dia", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runDailyApply(taskDeps(calls, m, TUE_0530));
    assert.deepEqual({ code: r.code, ran: r.ran }, { code: 0, ran: "apply" });
    assert.deepEqual(calls, ["scripts/brevo-diaria-run.ts --apply"]);
    assert.deepEqual(m.box.marker, marker());
    assert.equal(m.box.locks, 1);
  });

  it("marcador de ontem ⇒ roda de novo hoje", () => {
    const calls: string[] = [];
    runDailyApply(taskDeps(calls, sharedMarker(marker({ day: "2026-11-23" })), TUE_0530));
    assert.equal(applyCount(calls), 1);
  });

  it("--apply falhou ⇒ exit propagado e marcador NÃO gravado", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runDailyApply(taskDeps(calls, m, TUE_0530, { code: 1 }));
    assert.equal(r.code, 1);
    assert.equal(m.box.marker, null);
  });

  it("--apply falhou SÓ por rede ⇒ 105 (retry da unit), sem marcador", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runDailyApply(taskDeps(calls, m, TUE_0530, { code: 1, stderr: "TypeError: fetch failed" }));
    assert.equal(r.code, TRANSIENT_NETWORK_EXIT_CODE);
    assert.equal(m.box.marker, null);
  });

  it("REGRESSÃO (review P2): aviso do --apply (exit 3 do evaluate vira aviso lá dentro) ⇒ task sai 3, marcador gravado com o aviso", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const w = "Passo 1 (evaluate): 2 contato(s) com falha/skip (exit 3)";
    const r = runDailyApply(taskDeps(calls, m, TUE_0530, { stdout: JSON.stringify({ code: 0, warnings: [w, "sync-kit-frio: Kit 503"] }) }));
    assert.equal(r.code, DAILY_APPLY_WARNINGS_EXIT_CODE);
    assert.deepEqual(m.box.marker?.warnings, [w, "sync-kit-frio: Kit 503"]);
  });

  it("stdout sem JSON ⇒ aviso (nunca verde silencioso) ⇒ task sai 3", () => {
    const r = runDailyApply(taskDeps([], sharedMarker(), TUE_0530, { stdout: "lixo" }));
    assert.equal(r.code, DAILY_APPLY_WARNINGS_EXIT_CODE);
  });

  it("writeMarker lança ⇒ --apply conta como rodado, aviso, task sai 3", () => {
    const r = runDailyApply(taskDeps([], sharedMarker(null, true), TUE_0530));
    assert.equal(r.ran, "apply");
    assert.equal(r.code, DAILY_APPLY_WARNINGS_EXIT_CODE);
    assert.ok(r.warnings.some((w) => /marcador do --apply diário não gravado/.test(w)));
  });

  it("dispatch já rodou o --apply hoje SEM aviso ⇒ a task pula (exit 0, zero exec)", () => {
    const calls: string[] = [];
    const m = sharedMarker(marker({ day: "2026-11-23", at: "2026-11-23T03:10:00.000Z", by: "stage5-dispatch" }));
    const r = runDailyApply(taskDeps(calls, m, MON_0530));
    assert.deepEqual({ code: r.code, ran: r.ran }, { code: 0, ran: "none" });
    assert.deepEqual(calls, []);
  });

  it("marcador do dia COM aviso ⇒ a task roda o --apply de novo (review P3)", () => {
    const calls: string[] = [];
    const m = sharedMarker(marker({ day: "2026-11-23", by: "stage5-dispatch", warnings: ["pool Kit: 503"] }));
    const r = runDailyApply(taskDeps(calls, m, MON_0530));
    assert.equal(r.ran, "apply");
    assert.equal(applyCount(calls), 1);
    assert.equal(m.box.marker?.by, "task-05:30");
  });

  it("lock que não sai ⇒ code 1, step daily-apply-lock, nada roda", () => {
    const calls: string[] = [];
    const d = taskDeps(calls, sharedMarker(), TUE_0530);
    d.withLock = () => {
      throw new Error("[file-lock] timeout");
    };
    const r = runDailyApply(d);
    assert.deepEqual({ code: r.code, step: r.step, ran: r.ran }, { code: 1, step: "daily-apply-lock", ran: "none" });
    assert.deepEqual(calls, []);
  });
});

describe("kill switch da task (review P2, #13981)", () => {
  it("stage5_target_total: null ⇒ roda SÓ o evaluate --push (comportamento anterior), sem marcador", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runDailyApply(taskDeps(calls, m, TUE_0530, { config: { brevo_diaria: { stage5_target_total: null } } }));
    assert.deepEqual({ code: r.code, ran: r.ran }, { code: 0, ran: "evaluate-only" });
    assert.deepEqual(calls, ["scripts/evaluate-brevo-diaria.ts --push"]);
    assert.equal(m.box.marker, null);
  });

  it("brevo_diaria ausente ⇒ evaluate-only (o evaluate decide o exit, como antes)", () => {
    const calls: string[] = [];
    const r = runDailyApply(taskDeps(calls, sharedMarker(), TUE_0530, { config: {}, code: 2 }));
    assert.deepEqual({ code: r.code, ran: r.ran }, { code: 2, ran: "evaluate-only" });
    assert.deepEqual(calls, ["scripts/evaluate-brevo-diaria.ts --push"]);
  });

  it("evaluate do kill switch sai 3 ⇒ task sai 3 (nunca 105, mesmo com 'fetch failed' na saída)", () => {
    const r = runDailyApply(
      taskDeps([], sharedMarker(), TUE_0530, { config: { brevo_diaria: { stage5_target_total: null } }, code: 3, stderr: "fetch failed" }),
    );
    assert.equal(r.code, 3);
  });

  for (const [label, t] of [
    ["string", "290"],
    ["NaN", Number.NaN],
    ["negativo", -1],
    ["chave ausente", undefined],
  ] as const) {
    it(`stage5_target_total ${label} ⇒ exit 1 com motivo, nada roda`, () => {
      const calls: string[] = [];
      const r = runDailyApply(taskDeps(calls, sharedMarker(), TUE_0530, { config: { brevo_diaria: { stage5_target_total: t } } }));
      assert.deepEqual({ code: r.code, step: r.step }, { code: 1, step: "config" });
      assert.match(r.reason, /stage5_target_total inválido/);
      assert.deepEqual(calls, []);
    });
  }

  it("resolveDailyApplyMode e isValidStage5TargetTotal concordam (fonte única)", () => {
    assert.deepEqual(resolveDailyApplyMode(CONFIG_ON), { mode: "apply" });
    assert.equal(isValidStage5TargetTotal(0), true);
    assert.equal(isValidStage5TargetTotal(null), false);
    assert.equal(isValidStage5TargetTotal(Number.POSITIVE_INFINITY), false);
  });
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
    assert.equal(t.ran, "none");
    assert.equal(applyCount(calls), 1);
  });

  it("avisos do --apply do dispatch vão para o marcador e para o resultado", () => {
    const calls: string[] = [];
    const m = sharedMarker();
    const r = runStage5BrevoDispatch(
      "/fake/data/editions/2611/261123",
      dispatchDeps(calls, m, SUN_2000, { applyStdout: JSON.stringify({ warnings: ["pool Kit: 503"] }) }),
    );
    assert.equal(r.status, "ok");
    assert.deepEqual(r.status === "ok" && r.warnings, ["pool Kit: 503"]);
    assert.deepEqual(m.box.marker?.warnings, ["pool Kit: 503"]);
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

  it("exceção no CORPO do --apply ⇒ failed com step do --apply (não daily-apply-lock)", () => {
    const calls: string[] = [];
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", dispatchDeps(calls, sharedMarker(), SUN_2000, { applyThrows: true }));
    assert.equal(r.status === "failed" && r.step, "brevo-diaria-run --apply");
    assert.match(r.status === "failed" ? r.reason : "", /spawn quebrou/);
  });

  it("writeMarker lança no dispatch ⇒ campanha sai, aviso no resultado", () => {
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", dispatchDeps([], sharedMarker(null, true), SUN_2000));
    assert.equal(r.status, "ok");
    assert.ok(r.status === "ok" && r.warnings.some((w) => /marcador do --apply diário não gravado/.test(w)));
  });

  it("guarda de transição (#10533) com marcador do dia: dispatch de terça roda o --apply mesmo assim e sai diária", () => {
    const calls: string[] = [];
    const m = sharedMarker(marker());
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", dispatchDeps(calls, m, TUE_1700, { contacts: RESIDUO }));
    assert.equal(r.status, "ok");
    assert.equal(applyCount(calls), 1);
    assert.ok(calls.includes("scripts/publish-daily-brevo.ts"));
  });

  it("lock que não sai ⇒ failed (step daily-apply-lock), nada roda", () => {
    const calls: string[] = [];
    const d = dispatchDeps(calls, sharedMarker(), SUN_2000);
    d.dailyApply!.withLock = () => {
      throw new Error("[file-lock] timeout");
    };
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261123", d);
    assert.equal(r.status === "failed" && r.step, "daily-apply-lock");
    assert.deepEqual(calls, []);
  });

  it("productionDeps liga o marcador e o lock reais", () => {
    const p = productionDeps(ROOT);
    assert.ok(p.dailyApply);
    assert.equal(typeof p.dailyApply.writeMarker, "function");
    assert.equal(typeof p.dailyApply.readMarker, "function");
    assert.equal(typeof p.dailyApply.withLock, "function");
  });
});

describe("skip rápido leva o estado do --apply de hoje (review P2, #13981)", () => {
  it("terça com marcador do dia com aviso ⇒ skipped, zero exec, aviso no resultado", () => {
    const calls: string[] = [];
    const m = sharedMarker(marker({ warnings: ["sync-kit-frio: Kit 503"] }));
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", dispatchDeps(calls, m, TUE_1700));
    assert.equal(r.status, "skipped");
    assert.deepEqual(calls, []);
    assert.deepEqual(r.status === "skipped" && r.warnings, ["--apply de hoje (task-05:30): sync-kit-frio: Kit 503"]);
  });

  it("marcador do dia sem aviso ⇒ warnings vazio", () => {
    assert.deepEqual(skipRapidoApplyWarnings(marker(), TUE_1700), []);
  });

  it("marcador de outro dia, depois das 06:00 ⇒ aviso de --apply de hoje NÃO registrado", () => {
    const calls: string[] = [];
    const m = sharedMarker(marker({ day: "2026-11-23", warnings: ["velho"] }));
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261125", dispatchDeps(calls, m, TUE_1700));
    assert.equal(r.status, "skipped");
    const w = r.status === "skipped" ? (r.warnings ?? []) : [];
    assert.equal(w.length, 1);
    assert.match(w[0], /--apply de hoje NÃO registrado.*Diaria-Brevo-Diaria-Evaluate.*\.evaluate\.log/);
  });

  it("sem marcador nenhum, depois das 06:00 ⇒ mesmo aviso", () => {
    assert.match(skipRapidoApplyWarnings(null, TUE_1700)[0] ?? "", /NÃO registrado/);
  });

  it("antes das 05:30 com o marcador de ontem limpo ⇒ nada (#14320; casos completos em brevo-diaria-followups-14320)", () => {
    assert.deepEqual(skipRapidoApplyWarnings(marker({ day: "2026-11-23" }), new Date("2026-11-24T07:00:00Z")), []);
  });

  it("entre 05:30 e 06:00 sem marcador do dia ⇒ nada (a task pode estar rodando)", () => {
    assert.deepEqual(skipRapidoApplyWarnings(null, new Date("2026-11-24T08:45:00Z")), []);
  });
});

describe("marcador, lock e exec reais (#13981)", () => {
  const dir = mkdtempSync(join(tmpdir(), "daily-apply-13981-"));
  // Script de teste dentro do repo: o `--import tsx` do realExec resolve o
  // tsx a partir do cwd, então o diretório precisa estar sob o node_modules.
  const execDir = mkdtempSync(join(ROOT, ".tmp-13981-exec-"));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(execDir, { recursive: true, force: true });
  });

  it("ausente ou inválido ⇒ null (o caller roda o --apply)", () => {
    assert.equal(readDailyApplyMarker(join(dir, "nao-existe.json")), null);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{nao json");
    assert.equal(readDailyApplyMarker(bad), null);
    writeFileSync(bad, JSON.stringify({ day: "24/11", at: "2026-11-24T08:41:00.000Z", by: "task-05:30" }));
    assert.equal(readDailyApplyMarker(bad), null);
    writeFileSync(bad, JSON.stringify({ day: "2026-11-24", at: "ontem", by: "task-05:30" }));
    assert.equal(readDailyApplyMarker(bad), null, "at inválido");
    writeFileSync(bad, JSON.stringify({ day: "2026-11-24", at: "2026-11-24T08:41:00.000Z", by: "cron" }));
    assert.equal(readDailyApplyMarker(bad), null, "by inválido");
  });

  it("round-trip; warnings ausente vira []", () => {
    const p = join(dir, "sub", ".daily-apply.json");
    const mk = marker({ warnings: ["a"] });
    writeDailyApplyMarker(mk, p);
    assert.deepEqual(readDailyApplyMarker(p), mk);
    writeFileSync(p, JSON.stringify({ day: "2026-11-24", at: "2026-11-24T08:41:00.000Z", by: "stage5-dispatch" }));
    assert.deepEqual(readDailyApplyMarker(p)?.warnings, []);
  });

  it("lock fica FORA de data/ (local da máquina), e withDailyApplyLock solta o lock", () => {
    assert.ok(DAILY_APPLY_LOCK_PATH.startsWith(tmpdir()));
    assert.ok(!/[\\/]data[\\/]/.test(DAILY_APPLY_LOCK_PATH));
    const lk = join(dir, "x.lock");
    assert.equal(withDailyApplyLock(() => 1, 1000, lk), 1);
    assert.equal(withDailyApplyLock(() => 2, 1000, lk), 2);
    assert.equal(existsSync(lk), false);
  });

  it("realExec aguenta stdout de ~2 MiB (maxBuffer 64 MiB, acima do 1 MiB default)", () => {
    mkdirSync(join(execDir, "s"), { recursive: true });
    writeFileSync(join(execDir, "s", "big.mjs"), "process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\\nOK');\n");
    const r = realExec(execDir)("s/big.mjs", []);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.endsWith("OK"));
    assert.ok(r.stdout.length > 2 * 1024 * 1024);
  });
});
