/**
 * test/clarice-envio-run.test.ts (#5026)
 *
 * Cobre `scripts/clarice-envio-run.ts` — mesmo padrão de harness de
 * `test/clarice-novos-run.test.ts`: `exec` fake, sem spawn real, verificando
 * resultado (exit code, report) E a sequência/args exatos passados a cada
 * sub-script.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runEnvio,
  parseStepJson,
  resolveInheritedSubjects,
  detectMissedWaveToday,
  sendDateBrt,
  EnvioAbort,
  type EnvioRunDeps,
  type StepResult,
  type ExecFn,
} from "../scripts/clarice-envio-run.ts";
import type { WaveProposal, WaveState } from "../scripts/lib/clarice-wave-plan.ts";
import type { ResolveLatestMonthlyCycleResult } from "../scripts/lib/mensal/monthly-paths.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Handler = StepResult | StepResult[] | ((args: string[], callIndex: number) => StepResult);

function jsonResult(obj: unknown, code = 0): StepResult {
  return { code, stdout: JSON.stringify(obj), stderr: "" };
}
function textResult(text: string, code = 0): StepResult {
  return { code, stdout: text, stderr: "" };
}

function makeFakeExec(handlers: Record<string, Handler>): { exec: ExecFn; calls: Array<{ script: string; args: string[] }> } {
  const calls: Array<{ script: string; args: string[] }> = [];
  const counters: Record<string, number> = {};
  const exec: ExecFn = (script, args) => {
    calls.push({ script, args });
    const idx = counters[script] ?? 0;
    counters[script] = idx + 1;
    const h = handlers[script];
    if (h === undefined) throw new Error(`fakeExec: sem handler para "${script}" (chamada #${idx}, args=${args.join(" ")})`);
    if (typeof h === "function") return h(args, idx);
    if (Array.isArray(h)) {
      const r = h[idx];
      if (!r) throw new Error(`fakeExec: handler array esgotado para "${script}" na chamada #${idx}`);
      return r;
    }
    return h;
  };
  return { exec, calls };
}

const NOW = new Date("2026-08-11T22:00:00.000Z"); // 19:00 BRT, 11/08/2026
const CYCLE = "2607-08";
const SEND_DATE = "2026-08-12"; // amanhã BRT

function wave(over: Partial<WaveState> & { key: string }): WaveState {
  return { listId: 1, subject: "Assunto Y", status: "sent", scheduledAt: "2026-08-05T09:00:00.000Z", volume: 100, ...over };
}

/** Proposta "feliz" no caminho travar (1 lista, sem célula) — cada teste sobrescreve o que precisa. */
function goldenProposal(over: Partial<WaveProposal> = {}): WaveProposal {
  return {
    cycle: CYCLE,
    dates: [SEND_DATE],
    volumes: { perDay: [3450], total: 3450, semaphore: "green", flagged: false, baseVolume: 3005, health: {} as any, spamSignal: {} as any },
    abc: { action: "travar", metric: "abertura", winner: "A", caveats: [], rationale: "vencedor claro" },
    state: {
      cycle: CYCLE,
      waves: [wave({ key: "d11-qua12", subject: "Assunto travado", status: "sent", scheduledAt: "2026-08-11T13:45:00.000Z" })],
      volumeSum: 100000,
      volumeComplete: true,
      sentCount: 10,
      scheduledCount: 0,
      unscopedCount: 0,
    },
    availableFirstSend: 5000,
    availableFirstSendByCohort: [],
    mvBacklog: { total: 0, byCohort: [], estimatedCostUsd: 0 },
    nonOpeners: { count: 0, fraction: 0, minSends: 2 },
    brevoCredits: 100000,
    staleNote: null,
    startingWaveNumber: 12,
    committedLookupFailed: false,
    novosFreshness: { status: "fresh", lastRunAt: "2026-08-11T20:00:00.000Z", ageHours: 2 },
    waves: [{ n: 12, date: SEND_DATE, scheduledAt: `${SEND_DATE}T09:00:00.000Z`, volume: 3450, keys: ["d12-qua12"] }],
    blockers: [],
    warnings: [],
    mvOnDemandPlan: { deficit: 0, targetVerifyCount: 0, byCohort: [], totalPlanned: 0, backlogInsufficient: false, estimatedCostUsd: 0 },
    consumedByCohort: [],
    cohortInversion: null,
    ...over,
  } as unknown as WaveProposal;
}

function healthyRisk(over: Partial<Record<string, unknown>> = {}) {
  return {
    brake: { level: "ok", reasons: ["risco de ISP dentro dos limiares."], maxUtil: 0.2 },
    step: 0.15,
    openTrend: { current: 20, previous: 19, deltaPp: 1, verdict: "estavel", sampleDays: 26 },
    freshWindow: { sampleDays: 3, sent: 5000, delivered: 4900 },
    accelWindow: { sampleDays: 20, sent: 50000, delivered: 49000 },
    spamSignal: { source: "postmaster", ratePct: 0.05 },
    staleNote: null,
    ...over,
  };
}

function goldenHandlers(opts: { proposal?: Partial<WaveProposal>; risk?: Record<string, unknown> } = {}): Record<string, Handler> {
  const proposal = goldenProposal(opts.proposal);
  return {
    "scripts/clarice-check-derived-stale.ts": textResult("fresh"),
    "scripts/clarice-build-db.ts": textResult(""),
    "scripts/clarice-plan-wave.ts": jsonResult(proposal),
    "scripts/clarice-envio-risk.ts": jsonResult(healthyRisk(opts.risk)),
    "scripts/clarice-build-segment.ts": jsonResult({ selected: proposal.volumes.baseVolume, cycle: CYCLE, group: "ramp-warm" }),
    "scripts/clarice-split-group-cells.ts": textResult("ok"),
    "scripts/clarice-import-waves.ts": jsonResult({ mode: "execute", results: [] }),
    "scripts/clarice-schedule-group.ts": [
      jsonResult({ key: "d12-qua12", listId: 500, campaignId: 900, phase: "create", status: "draft" }),
      jsonResult({ key: "d12-qua12", listId: 500, campaignId: 900, phase: "schedule", status: "scheduled", scheduledAt: `${SEND_DATE}T09:00:00.000Z` }),
    ],
  };
}

function baseDeps(rootDir: string, overrides: Partial<EnvioRunDeps> = {}): EnvioRunDeps {
  return {
    rootDir,
    now: () => NOW,
    exec: () => {
      throw new Error("exec não deveria ser chamado — configure `handlers`");
    },
    isEnabled: () => true,
    execMode: () => "local",
    resolveLatestCycle: () => ({ cycle: CYCLE, subject: "x", fallback: false, checked: [] }) as ResolveLatestMonthlyCycleResult,
    ...overrides,
  };
}

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "clarice-envio-run-"));
  mkdirSync(resolve(root, "data", "monthly", CYCLE, "_internal"), { recursive: true });
  writeFileSync(resolve(root, "data", "monthly", CYCLE, "_internal", ".step-4-done.json"), "{}", "utf8");
  return root;
}

describe("clarice-envio-run (#5026)", () => {
  let savedApiKey: string | undefined;
  before(() => {
    savedApiKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "test-key";
  });
  after(() => {
    if (savedApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = savedApiKey;
  });

  // ── helpers puros ────────────────────────────────────────────────────

  it("sendDateBrt: 19:00 BRT de 11/08 => amanhã (12/08)", () => {
    assert.equal(sendDateBrt(NOW), "2026-08-12");
  });

  it("parseStepJson extrai JSON mesmo com log antes", () => {
    assert.deepEqual(parseStepJson('log\n{"a":1}'), { a: 1 });
  });

  describe("resolveInheritedSubjects", () => {
    it("travar: herda da onda SEM célula de maior n", () => {
      const waves = [
        wave({ key: "d10-seg10", subject: "Antigo" }),
        wave({ key: "d11-ter11-A", subject: "Nunca (é célula)" }),
        wave({ key: "d12-qua12", subject: "Mais recente sem célula" }),
      ];
      const r = resolveInheritedSubjects(waves, "travar");
      assert.deepEqual(r, { ok: true, single: "Mais recente sem célula" });
    });

    it("travar: sem onda anterior sem célula => falha (nunca inventa)", () => {
      const r = resolveInheritedSubjects([wave({ key: "d10-seg10-A", subject: "x" })], "travar");
      assert.equal(r.ok, false);
    });

    it("continuar: herda por CÉLULA, cada uma da sua onda de maior n", () => {
      const waves = [
        wave({ key: "d5-seg05-A", subject: "A velho" }),
        wave({ key: "d6-ter06-A", subject: "A novo" }),
        wave({ key: "d6-ter06-B", subject: "B novo" }),
        wave({ key: "d6-ter06-C", subject: "C novo" }),
      ];
      const r = resolveInheritedSubjects(waves, "continuar");
      assert.deepEqual(r, { ok: true, byCell: { A: "A novo", B: "B novo", C: "C novo" } });
    });

    it("continuar: falta 1 célula (ex: C nunca rodou) => falha, nunca inventa a 3ª", () => {
      const waves = [wave({ key: "d6-ter06-A", subject: "A" }), wave({ key: "d6-ter06-B", subject: "B" })];
      const r = resolveInheritedSubjects(waves, "continuar");
      assert.equal(r.ok, false);
    });
  });

  describe("detectMissedWaveToday (#4975)", () => {
    it("onda de hoje com scheduledAt no passado e status != sent => detectada", () => {
      const past = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(); // 1h atrás, mesmo dia BRT
      const r = detectMissedWaveToday([wave({ key: "d11-qua11", status: "suspended", scheduledAt: past })], NOW);
      assert.ok(r);
      assert.equal(r!.key, "d11-qua11");
    });

    it("onda de hoje JÁ sent => não é perdida", () => {
      const past = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
      const r = detectMissedWaveToday([wave({ key: "d11-qua11", status: "sent", scheduledAt: past })], NOW);
      assert.equal(r, null);
    });

    it("onda pra AMANHÃ (ainda não deveria ter saído) => não é perdida", () => {
      const r = detectMissedWaveToday([wave({ key: "d12-qua12", status: "scheduled", scheduledAt: `${SEND_DATE}T09:00:00.000Z` })], NOW);
      assert.equal(r, null);
    });

    it("array vazio => null", () => {
      assert.equal(detectMissedWaveToday([], NOW), null);
    });
  });

  // ── fluxo completo (fake exec) ──────────────────────────────────────

  describe("runEnvio — caminhos de parada limpa (code 0, sem tocar Brevo)", () => {
    it("kill switch desligado => pausa sem chamar exec nenhuma vez", async () => {
      const root = freshRoot();
      const { exec, calls } = makeFakeExec({});
      const r = await runEnvio(baseDeps(root, { exec, isEnabled: () => false }));
      assert.equal(r.code, 0);
      assert.equal(calls.length, 0);
      rmSync(root, { recursive: true, force: true });
    });

    it("exec-mode cloud => aborta (code 1) antes de qualquer exec", async () => {
      const root = freshRoot();
      const { exec, calls } = makeFakeExec({});
      const r = await runEnvio(baseDeps(root, { exec, execMode: () => "cloud" }));
      assert.equal(r.code, 1);
      assert.equal(calls.length, 0);
      rmSync(root, { recursive: true, force: true });
    });

    it("ciclo pronto diverge do esperado pelo calendário => pausa (code 0), nunca usa o ciclo antigo", async () => {
      const root = freshRoot();
      const { exec } = makeFakeExec({
        "scripts/clarice-check-derived-stale.ts": textResult("fresh"),
      });
      const r = await runEnvio(
        baseDeps(root, { exec, resolveLatestCycle: () => ({ cycle: "2605-06", subject: "x", fallback: true, checked: [] }) }),
      );
      assert.equal(r.code, 0);
      assert.match(r.reportMarkdown, /nao pronto|não pronto|2605-06/);
      rmSync(root, { recursive: true, force: true });
    });

    it(".step-4-done.json ausente => aborta (code 1)", async () => {
      const root = mkdtempSync(join(tmpdir(), "clarice-envio-run-nostep4-"));
      const { exec } = makeFakeExec({ "scripts/clarice-check-derived-stale.ts": textResult("fresh") });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 1);
      rmSync(root, { recursive: true, force: true });
    });

    it("abc.action='iniciar' => pausa (code 0), nunca decide sozinha", async () => {
      const root = freshRoot();
      const { exec } = makeFakeExec({
        "scripts/clarice-check-derived-stale.ts": textResult("fresh"),
        "scripts/clarice-plan-wave.ts": jsonResult(goldenProposal({ abc: { action: "iniciar", metric: "nenhuma", winner: null, caveats: [], rationale: "sem teste em curso" } })),
      });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 0);
      assert.match(r.reportMarkdown, /iniciar/);
      rmSync(root, { recursive: true, force: true });
    });

    it("fila insuficiente mesmo sem plano de MV disponível => para (code 0), sem agendar", async () => {
      const root = freshRoot();
      const proposal = goldenProposal({ availableFirstSend: 10 }); // bem menor que o volume desejado
      const { exec, calls } = makeFakeExec({
        "scripts/clarice-check-derived-stale.ts": textResult("fresh"),
        "scripts/clarice-plan-wave.ts": jsonResult(proposal),
        "scripts/clarice-envio-risk.ts": jsonResult(healthyRisk()),
      });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 0);
      assert.ok(!calls.some((c) => c.script === "scripts/clarice-build-segment.ts"), "nunca deveria chegar a segmentar");
      rmSync(root, { recursive: true, force: true });
    });

    it("freio STOP => volume final 0, nada agendado (code 0)", async () => {
      const root = freshRoot();
      const { exec, calls } = makeFakeExec(
        goldenHandlers({ risk: { brake: { level: "stop", reasons: ["hard bounce estourou"], maxUtil: 1.2 }, step: 0 } }),
      );
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 0);
      assert.ok(!calls.some((c) => c.script === "scripts/clarice-build-segment.ts"));
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("runEnvio — caminho feliz completo", () => {
    it("travar (1 célula): monta a onda e agenda com sucesso (code 0)", async () => {
      const root = freshRoot();
      const { exec, calls } = makeFakeExec(goldenHandlers());
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 0, r.reportMarkdown);

      const create = calls.find((c) => c.script === "scripts/clarice-schedule-group.ts" && c.args.includes("--create"));
      assert.ok(create, "deveria ter chamado --create");
      assert.ok(create!.args.includes("--subject"));
      assert.equal(create!.args[create!.args.indexOf("--subject") + 1], "Assunto travado", "assunto herdado da onda anterior, nunca digitado");
      assert.ok(!create!.args.includes("--key"), "travar (sem célula) não precisa de --key");

      const schedule = calls.filter((c) => c.script === "scripts/clarice-schedule-group.ts" && c.args.includes("--schedule") && !c.args.includes("--create"));
      assert.equal(schedule.length, 1, "1 célula = 1 chamada --schedule");
      rmSync(root, { recursive: true, force: true });
    });

    it("continuar (3 células): agenda A, B e C cada uma com seu assunto herdado", async () => {
      const root = freshRoot();
      const proposal = goldenProposal({
        abc: { action: "continuar", metric: "abertura", winner: null, caveats: [], rationale: "teste em curso" },
        state: {
          cycle: CYCLE,
          waves: [
            wave({ key: "d11-ter11-A", subject: "Sub A" }),
            wave({ key: "d11-ter11-B", subject: "Sub B" }),
            wave({ key: "d11-ter11-C", subject: "Sub C" }),
          ],
          volumeSum: 1, volumeComplete: true, sentCount: 3, scheduledCount: 0, unscopedCount: 0,
        },
        waves: [{ n: 12, date: SEND_DATE, scheduledAt: `${SEND_DATE}T09:00:00.000Z`, volume: 3450, keys: ["d12-qua12-A", "d12-qua12-B", "d12-qua12-C"] }],
      });
      const scheduleGroupHandler: Handler = (args) => {
        const key = args[args.indexOf("--key") + 1] ?? "?";
        if (args.includes("--create")) return jsonResult({ key, listId: 1, campaignId: 1, phase: "create", status: "draft" });
        return jsonResult({ key, listId: 1, campaignId: 1, phase: "schedule", status: "scheduled" });
      };
      const { exec, calls } = makeFakeExec({
        ...goldenHandlers({ proposal }),
        "scripts/clarice-schedule-group.ts": scheduleGroupHandler,
      });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 0, r.reportMarkdown);

      const creates = calls.filter((c) => c.script === "scripts/clarice-schedule-group.ts" && c.args.includes("--create"));
      assert.equal(creates.length, 3);
      const subjects = creates.map((c) => c.args[c.args.indexOf("--subject") + 1]).sort();
      assert.deepEqual(subjects, ["Sub A", "Sub B", "Sub C"]);
      for (const c of creates) assert.ok(c.args.includes("--key"), "continuar (com célula) sempre passa --key");
      rmSync(root, { recursive: true, force: true });
    });

    it("agendamento INCERTO (exit 2) em 1 célula => code 2, mas não aborta as outras", async () => {
      const root = freshRoot();
      let scheduleCall = 0;
      const scheduleGroupHandler: Handler = (args) => {
        if (args.includes("--create")) return jsonResult({ key: "d12-qua12", listId: 1, campaignId: 1, phase: "create", status: "draft" });
        scheduleCall++;
        return jsonResult({ key: "d12-qua12", listId: 1, campaignId: 1, phase: "schedule", status: "scheduled" }, 2); // incerto
      };
      const { exec } = makeFakeExec({ ...goldenHandlers(), "scripts/clarice-schedule-group.ts": scheduleGroupHandler });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 2);
      assert.equal(scheduleCall, 1);
      rmSync(root, { recursive: true, force: true });
    });

    it("MV on-demand roda quando a fila não cobre mas há backlog verificável, e a rodada segue com a fila atualizada", async () => {
      const root = freshRoot();
      process.env.MILLION_VERIFIER_API_KEY = "test-key";
      const shortProposal = goldenProposal({
        availableFirstSend: 100,
        mvOnDemandPlan: { deficit: 3000, targetVerifyCount: 3334, byCohort: [{ cohort: "leads-2026-07", count: 3334 }], totalPlanned: 3334, backlogInsufficient: false, estimatedCostUsd: 6.33 },
      });
      const replannedProposal = goldenProposal({ availableFirstSend: 5000 });
      const { exec, calls } = makeFakeExec({
        ...goldenHandlers(),
        "scripts/clarice-plan-wave.ts": [jsonResult(shortProposal), jsonResult(replannedProposal)],
        "scripts/clarice-mv-ondemand.ts": jsonResult({ verified: 3000 }),
      });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.ok(calls.some((c) => c.script === "scripts/clarice-mv-ondemand.ts"));
      assert.equal(calls.filter((c) => c.script === "scripts/clarice-plan-wave.ts").length, 2, "replaneja depois do MV");
      delete process.env.MILLION_VERIFIER_API_KEY;
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("runEnvio — blockers estruturais (não dependem do semáforo antigo)", () => {
    it("committedLookupFailed => aborta (code 1)", async () => {
      const root = freshRoot();
      const { exec } = makeFakeExec({
        "scripts/clarice-check-derived-stale.ts": textResult("fresh"),
        "scripts/clarice-plan-wave.ts": jsonResult(goldenProposal({ committedLookupFailed: true })),
      });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 1);
      rmSync(root, { recursive: true, force: true });
    });

    it("brevoCredits null (não consultado) => aborta (code 1)", async () => {
      const root = freshRoot();
      const { exec } = makeFakeExec({
        "scripts/clarice-check-derived-stale.ts": textResult("fresh"),
        "scripts/clarice-plan-wave.ts": jsonResult(goldenProposal({ brevoCredits: null })),
      });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 1);
      rmSync(root, { recursive: true, force: true });
    });

    it("novosFreshness 'never-run' => aborta (code 1)", async () => {
      const root = freshRoot();
      const { exec } = makeFakeExec({
        "scripts/clarice-check-derived-stale.ts": textResult("fresh"),
        "scripts/clarice-plan-wave.ts": jsonResult(goldenProposal({ novosFreshness: { status: "never-run", lastRunAt: null, ageHours: null } })),
      });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 1);
      rmSync(root, { recursive: true, force: true });
    });
  });
});
