/**
 * test/clarice-envio-engajados-run.test.ts (#6945)
 *
 * Cobre `scripts/clarice-envio-engajados-run.ts` — mesmo padrão de harness
 * de `test/clarice-envio-run.test.ts`/`test/clarice-novos-run.test.ts`:
 * `exec` fake, sem spawn real, verificando resultado (exit code, report) E
 * a sequência/args exatos passados a cada sub-script. `rootDir` é um tmpdir
 * real (não mockado) porque lock/state deste script usam `deps.rootDir`
 * diretamente (mesma convenção dos irmãos ramp-warm/novos).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runEnvioEngajados, type EngajadosRunDeps } from "../scripts/clarice-envio-engajados-run.ts";
import type { StepResult, ExecFn } from "../scripts/clarice-envio-run.ts";
import type { ResolveLatestMonthlyCycleResult } from "../scripts/lib/mensal/monthly-paths.ts";
import type { ClariceAbcStateRead } from "../scripts/lib/clarice-abc-state.ts";
import { readEngajadosState, writeEngajadosState } from "../scripts/lib/clarice-envio-engajados-state.ts";
import { ENGAJADOS_BOOTSTRAP_VOLUME, ENGAJADOS_MAX_DAILY_VOLUME } from "../scripts/lib/clarice-envio-engajados-policy.ts";

type Handler = StepResult | ((args: string[], callIndex: number) => StepResult);

function jsonResult(obj: unknown, code = 0): StepResult {
  return { code, stdout: JSON.stringify(obj), stderr: "" };
}
function okResult(): StepResult {
  return { code: 0, stdout: "", stderr: "" };
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
    return typeof h === "function" ? h(args, idx) : h;
  };
  return { exec, calls };
}

const NOW = new Date("2026-09-02T22:15:00.000Z"); // 19:15 BRT, 02/09/2026
const CYCLE = "2608-09";
const AAMMDD = "260902";
const LOCKED_SUBJECT = "Assunto travado do dia";

// `ResolveLatestMonthlyCycleResult` é união discriminada (ciclo resolvido ×
// ciclo ausente), e `Partial<A | B>` distribui em `Partial<A> | Partial<B>` —
// o spread com o ramo ausente produzia `cycle: string | null`, que não casa
// NENHUM dos dois membros (TS2322). Este helper só monta o ramo RESOLVIDO
// (os dois call sites passam ciclo real ou nada), então o override é tipado
// contra esse membro em vez da união inteira — sem cast.
type ResolvedMonthlyCycle = Extract<ResolveLatestMonthlyCycleResult, { cycle: string }>;

function readiness(over: Partial<ResolvedMonthlyCycle> = {}): ResolveLatestMonthlyCycleResult {
  return { cycle: CYCLE, subject: "x", fallback: false, checked: [], ...over };
}

function abcTravado(): ClariceAbcStateRead {
  return {
    status: "encerrado",
    subject: LOCKED_SUBJECT,
    winner: "A",
    decidedAt: "2026-09-01T09:00:00.000Z",
    decidedBy: "editor",
    rationale: null,
    invalidReason: null,
  };
}

function abcAberto(): ClariceAbcStateRead {
  return {
    status: "aberto",
    subject: null,
    winner: null,
    decidedAt: null,
    decidedBy: null,
    rationale: null,
    invalidReason: null,
  };
}

describe("runEnvioEngajados (#6945)", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "clarice-envio-engajados-run-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function baseDeps(over: Partial<EngajadosRunDeps> = {}): EngajadosRunDeps {
    return {
      rootDir,
      now: () => NOW,
      exec: () => okResult(),
      isEnabled: () => true,
      execMode: () => "local",
      resolveLatestCycle: () => readiness(),
      readAbcState: () => abcTravado(),
      readQueueRows: () => [],
      ...over,
    };
  }

  it("kill switch desligado -> code 0, reportId -paused, nenhuma chamada exec", async () => {
    const { exec, calls } = makeFakeExec({});
    const res = await runEnvioEngajados(baseDeps({ isEnabled: () => false, exec }));
    assert.equal(res.code, 0);
    assert.equal(res.reportId, `envio-engajados-${AAMMDD}-paused`);
    assert.equal(calls.length, 0);
  });

  it("exec-mode != local -> abort, code 1", async () => {
    const res = await runEnvioEngajados(baseDeps({ execMode: () => "cloud" }));
    assert.equal(res.code, 1);
    assert.equal(res.reportId, `envio-engajados-${AAMMDD}-abort`);
  });

  it("ciclo esperado diverge do ciclo pronto -> code 0, reportId -sem-ciclo-elegivel, nenhuma chamada exec", async () => {
    process.env.BREVO_CLARICE_API_KEY = "test-key";
    try {
      const { exec, calls } = makeFakeExec({});
      const res = await runEnvioEngajados(baseDeps({ exec, resolveLatestCycle: () => readiness({ cycle: "2607-08" }) }));
      assert.equal(res.code, 0);
      assert.equal(res.reportId, `envio-engajados-${AAMMDD}-sem-ciclo-elegivel`);
      assert.equal(calls.length, 0);
    } finally {
      delete process.env.BREVO_CLARICE_API_KEY;
    }
  });

  it("assunto do dia ainda não travado (teste A/B/C em curso) -> code 0, -sem-assunto-travado, nenhuma chamada exec", async () => {
    process.env.BREVO_CLARICE_API_KEY = "test-key";
    try {
      const { exec, calls } = makeFakeExec({});
      const res = await runEnvioEngajados(baseDeps({ exec, readAbcState: () => abcAberto() }));
      assert.equal(res.code, 0);
      assert.equal(res.reportId, `envio-engajados-${AAMMDD}-sem-assunto-travado`);
      assert.equal(calls.length, 0);
    } finally {
      delete process.env.BREVO_CLARICE_API_KEY;
    }
  });

  it("--dry-run: calcula tudo, adquire e libera o lock, mas NÃO chama nenhum sub-script", async () => {
    process.env.BREVO_CLARICE_API_KEY = "test-key";
    try {
      const { exec, calls } = makeFakeExec({});
      const res = await runEnvioEngajados(baseDeps({ exec }), { dryRun: true });
      assert.equal(res.code, 0);
      assert.equal(res.reportId, `envio-engajados-${AAMMDD}-dry-run`);
      assert.equal(calls.length, 0);
      assert.equal(readEngajadosState(resolve(rootDir, "data", "clarice-subscribers")), null, "dry-run nunca escreve estado");
    } finally {
      delete process.env.BREVO_CLARICE_API_KEY;
    }
  });

  it("BREVO_CLARICE_API_KEY ausente fora de --dry-run -> abort", async () => {
    delete process.env.BREVO_CLARICE_API_KEY;
    const res = await runEnvioEngajados(baseDeps());
    assert.equal(res.code, 1);
    assert.equal(res.reportId, `envio-engajados-${AAMMDD}-abort`);
  });

  describe("--plan-only/--volume (#7235)", () => {
    function row(email: string, priorityPoints: number, lastSentAt: string | null = null) {
      return {
        email,
        tier: null,
        cohort: "leads-2024h1",
        priority_points: priorityPoints,
        send_eligible: 1,
        ineligible_reason: null,
        sends_count: 3,
        opens_count: 1,
        last_sent_at: lastSentAt,
      };
    }

    it("--plan-only: NÃO exige BREVO_CLARICE_API_KEY, não chama exec, não escreve estado, devolve plan", async () => {
      delete process.env.BREVO_CLARICE_API_KEY;
      const { exec, calls } = makeFakeExec({});
      const rows = [row("a@x.com", 80), row("b@x.com", 60), row("c@x.com", 20)];
      const res = await runEnvioEngajados(baseDeps({ exec, readQueueRows: () => rows }), { planOnly: true });
      assert.equal(res.code, 0, res.reportMarkdown);
      assert.equal(res.reportId, "");
      assert.equal(calls.length, 0, "plan-only nunca chama sub-script (nunca toca a Brevo)");
      assert.equal(readEngajadosState(resolve(rootDir, "data", "clarice-subscribers")), null, "plan-only nunca escreve estado");
      assert.ok(res.plan);
      assert.equal(res.plan!.cycle, CYCLE);
      assert.equal(res.plan!.subject, LOCKED_SUBJECT);
      assert.equal(res.plan!.overrideApplied, false);
      assert.equal(res.plan!.volume, Math.round(ENGAJADOS_BOOTSTRAP_VOLUME * 1.1));
      assert.equal(res.plan!.preview.queueEligible, 3);
      assert.equal(res.plan!.preview.selectedCount, 3, "volume proposto (1650) cobre os 3 elegíveis");
      assert.deepEqual(res.plan!.preview.scoreRange, { min: 20, max: 80 });
      assert.equal(res.plan!.preview.remainingAboveCutoff, 0);
    });

    it("--plan-only exclui quem já recebeu neste mês de envio (excludeSentSince) — mesmo cutoff do #7234", async () => {
      const rows = [
        row("recebeu-este-mes@x.com", 90, "2026-09-01T10:00:00.000Z"), // sendDate = 2026-09-03 → mês 09/2026
        row("elegivel@x.com", 50),
      ];
      const res = await runEnvioEngajados(baseDeps({ readQueueRows: () => rows }), { planOnly: true });
      assert.equal(res.plan!.preview.queueEligible, 2);
      assert.equal(res.plan!.preview.excludedByRecency, 1);
      assert.equal(res.plan!.preview.eligibleForRound, 1);
      assert.equal(res.plan!.preview.selectedCount, 1);
    });

    it("--plan-only corta pelo VOLUME quando a fila elegível excede — sobra vai pra 'amanhã'", async () => {
      const rows = [row("a@x.com", 90), row("b@x.com", 50), row("c@x.com", 10)];
      const res = await runEnvioEngajados(baseDeps({ readQueueRows: () => rows }), { planOnly: true, volume: 2 });
      assert.equal(res.plan!.overrideApplied, true);
      assert.equal(res.plan!.volume, 2);
      assert.equal(res.plan!.preview.selectedCount, 2);
      assert.deepEqual(res.plan!.preview.scoreRange, { min: 50, max: 90 });
      assert.equal(res.plan!.preview.remainingAboveCutoff, 1, "c@x.com (score 10) fica pra amanhã");
    });

    it("--volume acima do teto absoluto ABORTA — nunca corta em silêncio (mesma disciplina do ramp-warm #5985)", async () => {
      const res = await runEnvioEngajados(baseDeps(), { planOnly: true, volume: ENGAJADOS_MAX_DAILY_VOLUME + 1 });
      assert.equal(res.code, 1);
      assert.match(res.reportMarkdown, /acima do teto absoluto/);
    });

    it("--volume (sem --plan-only) substitui o --budget passado a clarice-build-segment", async () => {
      process.env.BREVO_CLARICE_API_KEY = "test-key";
      try {
        const { exec, calls } = makeFakeExec({
          "scripts/clarice-build-segment.ts": () => jsonResult({ selected: 500, budget: 500 }),
          "scripts/clarice-import-waves.ts": () => okResult(),
          "scripts/clarice-schedule-group.ts": () => okResult(),
        });
        const res = await runEnvioEngajados(baseDeps({ exec }), { volume: 500 });
        assert.equal(res.code, 0, res.reportMarkdown);
        const buildSeg = calls.find((c) => c.script === "scripts/clarice-build-segment.ts");
        assert.ok(buildSeg);
        assert.equal(buildSeg!.args[buildSeg!.args.indexOf("--budget") + 1], "500");
      } finally {
        delete process.env.BREVO_CLARICE_API_KEY;
      }
    });
  });

  it("caminho feliz: monta os args corretos em ordem e escreve o estado só após confirmação", async () => {
    process.env.BREVO_CLARICE_API_KEY = "test-key";
    try {
      const { exec, calls } = makeFakeExec({
        "scripts/clarice-build-segment.ts": () => jsonResult({ selected: 1500, budget: ENGAJADOS_BOOTSTRAP_VOLUME + 1 }),
        "scripts/clarice-import-waves.ts": () => okResult(),
        "scripts/clarice-schedule-group.ts": () => okResult(),
      });
      const res = await runEnvioEngajados(baseDeps({ exec }));
      assert.equal(res.code, 0, res.reportMarkdown);
      assert.equal(res.reportId, `envio-engajados-${AAMMDD}`);

      const key = `engajados-${AAMMDD}`;
      const buildSeg = calls.find((c) => c.script === "scripts/clarice-build-segment.ts");
      assert.ok(buildSeg);
      assert.deepEqual(buildSeg!.args.slice(0, 4), ["--group", "engajados", "--cycle", CYCLE]);
      assert.ok(buildSeg!.args.includes("--budget"));
      // #7234 — sem `--send-date`, o build-segment cai no cutoff derivado do
      // CICLO e o 1º envio do mês deixa de resetar a fila por score. O fix é
      // inerte se o orquestrador não passar a data; é aqui que isso trava.
      assert.ok(
        buildSeg!.args.includes("--send-date"),
        "orquestrador precisa passar --send-date pro build-segment (#7234)",
      );
      assert.equal(
        buildSeg!.args[buildSeg!.args.indexOf("--send-date") + 1],
        "2026-09-03",
        "--send-date é a data em que a onda SAI (NOW+1 BRT), não a de execução",
      );

      const importWaves = calls.find((c) => c.script === "scripts/clarice-import-waves.ts");
      assert.ok(importWaves);
      assert.ok(importWaves!.args.includes("--key"));
      assert.equal(importWaves!.args[importWaves!.args.indexOf("--key") + 1], key);
      assert.ok(importWaves!.args.includes("--reuse-existing"));
      assert.ok(importWaves!.args.includes("--execute"));

      const scheduleCalls = calls.filter((c) => c.script === "scripts/clarice-schedule-group.ts");
      assert.equal(scheduleCalls.length, 2, "espera --create seguido de --schedule");
      assert.ok(scheduleCalls[0].args.includes("--create"));
      assert.ok(scheduleCalls[0].args.includes("--subject"));
      assert.equal(scheduleCalls[0].args[scheduleCalls[0].args.indexOf("--subject") + 1], LOCKED_SUBJECT);
      assert.ok(scheduleCalls[0].args.includes("--schedule-at"));
      assert.ok(scheduleCalls[1].args.includes("--schedule"));
      assert.ok(!scheduleCalls[1].args.includes("--create"));

      const state = readEngajadosState(resolve(rootDir, "data", "clarice-subscribers"));
      assert.ok(state, "estado deveria ter sido gravado após confirmação");
      assert.equal(state!.lastCycle, CYCLE);
      assert.equal(state!.lastVolume > 0, true);
    } finally {
      delete process.env.BREVO_CLARICE_API_KEY;
    }
  });

  it("volume escala a partir do estado do dia anterior (base × 1,10)", async () => {
    process.env.BREVO_CLARICE_API_KEY = "test-key";
    try {
      writeEngajadosState(
        { lastVolume: 2000, lastSentAtIso: "2026-09-01T22:00:00.000Z", lastCycle: CYCLE },
        resolve(rootDir, "data", "clarice-subscribers"),
      );
      const { exec, calls } = makeFakeExec({
        "scripts/clarice-build-segment.ts": () => jsonResult({ selected: 2200 }),
        "scripts/clarice-import-waves.ts": () => okResult(),
        "scripts/clarice-schedule-group.ts": () => okResult(),
      });
      await runEnvioEngajados(baseDeps({ exec }));
      const buildSeg = calls.find((c) => c.script === "scripts/clarice-build-segment.ts")!;
      const budgetArg = buildSeg.args[buildSeg.args.indexOf("--budget") + 1];
      assert.equal(Number(budgetArg), 2200); // 2000 * 1.10
    } finally {
      delete process.env.BREVO_CLARICE_API_KEY;
    }
  });

  it("--schedule falha -> abort, estado NÃO avança", async () => {
    process.env.BREVO_CLARICE_API_KEY = "test-key";
    try {
      let scheduleCall = 0;
      const { exec } = makeFakeExec({
        "scripts/clarice-build-segment.ts": () => jsonResult({ selected: 1500 }),
        "scripts/clarice-import-waves.ts": () => okResult(),
        "scripts/clarice-schedule-group.ts": (args) => {
          scheduleCall++;
          if (args.includes("--schedule")) return { code: 1, stdout: "", stderr: "falhou de propósito" };
          return okResult();
        },
      });
      const res = await runEnvioEngajados(baseDeps({ exec }));
      assert.equal(res.code, 1);
      assert.equal(res.reportId, `envio-engajados-${AAMMDD}-abort`);
      assert.equal(readEngajadosState(resolve(rootDir, "data", "clarice-subscribers")), null);
      assert.ok(scheduleCall >= 2);
    } finally {
      delete process.env.BREVO_CLARICE_API_KEY;
    }
  });

  it("lock já detido por rodada concorrente (ramp-warm no mesmo ciclo) -> code 4, reportId -lock-held, NUNCA falha genuína", async () => {
    process.env.BREVO_CLARICE_API_KEY = "test-key";
    try {
      // Simula outra sessão segurando o lock do MESMO ciclo antes desta rodada rodar.
      const { acquireEnvioLock } = await import("../scripts/lib/clarice-envio-lock.ts");
      acquireEnvioLock(rootDir, CYCLE, "sessao-concorrente", NOW);

      const { exec, calls } = makeFakeExec({});
      const res = await runEnvioEngajados(baseDeps({ exec }));
      assert.equal(res.code, 4);
      assert.equal(res.reportId, `envio-engajados-${AAMMDD}-lock-held`);
      assert.equal(calls.length, 0, "nenhuma chamada Brevo quando o lock está detido");
    } finally {
      delete process.env.BREVO_CLARICE_API_KEY;
    }
  });
});

