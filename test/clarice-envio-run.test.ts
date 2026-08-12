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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runEnvio,
  parseStepJson,
  resolveInheritedSubjects,
  detectMissedWaveToday,
  detectExistingWaveForSendDate,
  sendDateBrt,
  EnvioAbort,
  type EnvioRunDeps,
  type StepResult,
  type ExecFn,
} from "../scripts/clarice-envio-run.ts";
import type { WaveProposal, WaveState } from "../scripts/lib/clarice-wave-plan.ts";
import type { ResolveLatestMonthlyCycleResult } from "../scripts/lib/mensal/monthly-paths.ts";
import type { ClariceAbcStateRead } from "../scripts/lib/clarice-abc-state.ts";
import { acquireEnvioLock } from "../scripts/lib/clarice-envio-lock.ts";

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
    // #5055 — default ABERTO (o do arquivo ausente). Injetado em vez de lido
    // de `rootDir`: sem este seam, estes testes leriam `data/clarice-abc-state.json`
    // da máquina real e o assunto travado em produção vazaria pras asserções.
    readAbcState: () => abcAberto(),
    // #5058 — sleep FAKE que não espera de verdade: resolve na hora, mas
    // registra a chamada (via override em cada teste que precisa inspecionar
    // quanto tempo o retry pediu pra esperar).
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

/** Estado "teste A/B/C aberto" — o default de arquivo ausente. */
function abcAberto(): ClariceAbcStateRead {
  return { status: "aberto", subject: null, winner: null, decidedAt: null, decidedBy: null, rationale: null, invalidReason: null };
}

/** Estado "teste A/B/C encerrado" com o assunto travado pelo editor. */
function abcEncerrado(subject: string): ClariceAbcStateRead {
  return {
    status: "encerrado",
    subject,
    winner: null,
    decidedAt: "2026-08-12T00:00:00.000Z",
    decidedBy: "editor",
    rationale: "encerrado no chat",
    invalidReason: null,
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
      const r = resolveInheritedSubjects({ waves, abcAction: "travar" });
      assert.deepEqual(r, { ok: true, mode: "single", subject: "Mais recente sem célula" });
    });

    it("travar: sem onda anterior sem célula E sem winner => falha (nunca inventa)", () => {
      const r = resolveInheritedSubjects({ waves: [wave({ key: "d10-seg10-A", subject: "x" })], abcAction: "travar" });
      assert.equal(r.ok, false);
    });

    it("REGRESSÃO (achado do code-reviewer): travar SEM precedente sem-célula, mas COM winner, herda da célula vencedora (destrava o bootstrap do teste A/B/C)", () => {
      // Cenário exato do deadlock: a 1ª vez que abc.action vira 'travar',
      // state.waves só tem entradas -A/-B/-C (o não-célula que o ramo
      // 'travar' normalmente procura só existiria DEPOIS de uma rodada
      // 'travar' bem-sucedida) — sem este fallback, a automação abortaria
      // pra sempre nesse ponto.
      const waves = [
        wave({ key: "d5-seg05-A", subject: "Perdedor A" }),
        wave({ key: "d5-seg05-B", subject: "Vencedor B" }),
        wave({ key: "d5-seg05-C", subject: "Perdedor C" }),
      ];
      const r = resolveInheritedSubjects({ waves, abcAction: "travar", winner: "B" });
      assert.deepEqual(r, { ok: true, mode: "single", subject: "Vencedor B" });
    });

    it("#5055: lockedSubject do estado gravado vence TUDO — não herda por inferência o que já está escrito", () => {
      const waves = [
        wave({ key: "d5-seg05-B", subject: "Assunto da célula B" }),
        wave({ key: "d7-qui07", subject: "Assunto herdado da onda sem célula" }),
      ];
      const r = resolveInheritedSubjects({ waves, abcAction: "travar", winner: "B", lockedSubject: "Assunto travado pelo editor" });
      assert.deepEqual(r, { ok: true, mode: "single", subject: "Assunto travado pelo editor" });
    });

    it('#5055: lockedSubject é IGNORADO no ramo "continuar" — pinado porque o guard de divergência é a única defesa', () => {
      // Achado do pr-test-analyzer no review da PR #5057: esta combinação é
      // inalcançável em produção (o guard bidirecional de `runEnvio` aborta
      // antes), mas se alguém enfraquecer o guard num refactor, esta função
      // NÃO é um segundo backstop — ela devolve 3 assuntos por célula mesmo
      // com o teste encerrado. Pinar isso deixa a rede de proteção visível:
      // quem mudar o guard tem que ler este teste.
      const waves = [
        wave({ key: "d5-seg05-A", subject: "Sub A" }),
        wave({ key: "d5-seg05-B", subject: "Sub B" }),
        wave({ key: "d5-seg05-C", subject: "Sub C" }),
      ];
      const r = resolveInheritedSubjects({ waves, abcAction: "continuar", lockedSubject: "Assunto travado" });
      assert.deepEqual(r, { ok: true, mode: "byCell", subjects: { A: "Sub A", B: "Sub B", C: "Sub C" } });
    });

    it("#5055: com lockedSubject, travar NUNCA falha por falta de precedente (deadlock de bootstrap impossível)", () => {
      // Sem estado gravado este mesmo input falha (teste acima). Com o estado,
      // não há o que herdar — o assunto já é conhecido.
      const r = resolveInheritedSubjects({ waves: [], abcAction: "travar", lockedSubject: "Assunto travado pelo editor" });
      assert.deepEqual(r, { ok: true, mode: "single", subject: "Assunto travado pelo editor" });
      assert.equal(resolveInheritedSubjects({ waves: [], abcAction: "travar" }).ok, false, "pré-condição: sem trava, falharia");
    });

    it("travar: onda sem-célula (mais recente) vence sobre o winner quando os dois existem", () => {
      const waves = [
        wave({ key: "d5-seg05-B", subject: "Assunto da célula B (antigo)" }),
        wave({ key: "d7-qui07", subject: "Assunto travado mais recente" }),
      ];
      const r = resolveInheritedSubjects({ waves, abcAction: "travar", winner: "B" });
      assert.deepEqual(r, { ok: true, mode: "single", subject: "Assunto travado mais recente" });
    });

    it("continuar: herda por CÉLULA, cada uma da sua onda de maior n", () => {
      const waves = [
        wave({ key: "d5-seg05-A", subject: "A velho" }),
        wave({ key: "d6-ter06-A", subject: "A novo" }),
        wave({ key: "d6-ter06-B", subject: "B novo" }),
        wave({ key: "d6-ter06-C", subject: "C novo" }),
      ];
      const r = resolveInheritedSubjects({ waves, abcAction: "continuar" });
      assert.deepEqual(r, { ok: true, mode: "byCell", subjects: { A: "A novo", B: "B novo", C: "C novo" } });
    });

    it("continuar: falta 1 célula (ex: C nunca rodou) => falha, nunca inventa a 3ª", () => {
      const waves = [wave({ key: "d6-ter06-A", subject: "A" }), wave({ key: "d6-ter06-B", subject: "B" })];
      const r = resolveInheritedSubjects({ waves, abcAction: "continuar" });
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

  describe("detectExistingWaveForSendDate (#5058, nota relacionada)", () => {
    it("onda já agendada pro sendDate (status queued) => detectada", () => {
      const r = detectExistingWaveForSendDate(
        [wave({ key: "d12-qua12", status: "queued", scheduledAt: `${SEND_DATE}T09:00:00.000Z` })],
        SEND_DATE,
      );
      assert.equal(r.length, 1);
      assert.equal(r[0].key, "d12-qua12");
    });

    it("onda já ENVIADA pro sendDate (status sent) => também detectada — não é só 'agendada'", () => {
      const r = detectExistingWaveForSendDate(
        [wave({ key: "d12-qua12", status: "sent", scheduledAt: `${SEND_DATE}T09:00:00.000Z` })],
        SEND_DATE,
      );
      assert.equal(r.length, 1);
    });

    it("onda CANCELADA (status suspended) pro sendDate => NÃO conta — não é uma onda viva competindo pelo dia", () => {
      const r = detectExistingWaveForSendDate(
        [wave({ key: "d12-qua12", status: "suspended", scheduledAt: `${SEND_DATE}T09:00:00.000Z` })],
        SEND_DATE,
      );
      assert.equal(r.length, 0);
    });

    it("onda pra outro dia => não detectada", () => {
      const r = detectExistingWaveForSendDate(
        [wave({ key: "d11-ter11", status: "sent", scheduledAt: "2026-08-11T09:00:00.000Z" })],
        SEND_DATE,
      );
      assert.equal(r.length, 0);
    });

    it("array vazio => []", () => {
      assert.deepEqual(detectExistingWaveForSendDate([], SEND_DATE), []);
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

    it("lock detido por outra rodada => aborta ANTES do Passo 1 (code 1), zero exec, guard #4765", async () => {
      // Fecha o gap de teste do pr-test-analyzer: a trava de concorrência
      // (scripts/lib/clarice-envio-lock.ts) existe especificamente pra
      // prevenir o incidente real do #4765 (52/1.963 contatos escaparam do
      // dedup por escrita concorrente) — mas nunca tinha teste de ponta a
      // ponta confirmando que runEnvio de fato respeita o lock.
      const root = freshRoot();
      acquireEnvioLock(root, CYCLE, "sessao-manual-concorrente", new Date(NOW.getTime() - 60_000));
      const { exec, calls } = makeFakeExec({ "scripts/clarice-check-derived-stale.ts": textResult("fresh") });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 1);
      assert.match(r.reportMarkdown, /concorrente/);
      assert.ok(!calls.some((c) => c.script === "scripts/clarice-plan-wave.ts"), "lock detido aborta ANTES de qualquer chamada de rede");
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

      // Achado do pr-test-analyzer no review da PR: verificar SÓ que o script
      // foi chamado não pega um --budget/--no-cells invertido num refactor
      // futuro — checar os argumentos exatos de cada sub-script do Passo 6.
      // Volume esperado: baseVolume 3005 × (1 + step 0.15) = round(3455,75) = 3456
      // (sem cap de fila/crédito nesta fixture, ambos bem acima).
      const segment = calls.find((c) => c.script === "scripts/clarice-build-segment.ts");
      assert.ok(segment);
      assert.deepEqual(segment!.args, ["--group", "ramp-warm", "--cycle", CYCLE, "--budget", "3456"]);

      const split = calls.find((c) => c.script === "scripts/clarice-split-group-cells.ts");
      assert.ok(split);
      assert.ok(split!.args.includes("--no-cells"), "travar => 1 lista só, --no-cells presente");
      assert.deepEqual(split!.args, ["--cycle", CYCLE, "--wave", "12", "--date", SEND_DATE, "--from", "segments/ramp-warm.csv", "--no-cells"]);

      const importCall = calls.find((c) => c.script === "scripts/clarice-import-waves.ts");
      assert.ok(importCall);
      assert.deepEqual(importCall!.args, ["--cycle", CYCLE, "--group", "d12-qua12", "--label", `${CYCLE} d12-qua12`, "--execute"]);
      rmSync(root, { recursive: true, force: true });
    });

    // -----------------------------------------------------------------------
    // #5055 — estado durável do teste A/B/C no orquestrador
    // -----------------------------------------------------------------------

    it("#5055: teste ENCERRADO => assunto do estado vence a herança, e a onda sai com --no-cells", async () => {
      // `metric: "nenhuma"` não é detalhe do fixture: é a ASSINATURA do ramo
      // `lockedSubject` de `recommendAbcAction`, e é justamente o que o guard
      // bidirecional compara contra o estado. Um `travar` com `metric:
      // "clique"` (calculado) junto de um estado encerrado é a divergência que
      // o guard existe pra pegar — testada logo abaixo.
      const root = freshRoot();
      const proposal = goldenProposal({
        abc: { action: "travar", metric: "nenhuma", winner: null, caveats: [], rationale: "assunto travado em ciclos anteriores" },
      });
      const { exec, calls } = makeFakeExec({
        ...goldenHandlers(),
        "scripts/clarice-plan-wave.ts": jsonResult(proposal),
      });
      const r = await runEnvio(
        baseDeps(root, { exec, readAbcState: () => abcEncerrado("Assunto travado pelo editor") }),
      );
      assert.equal(r.code, 0, r.reportMarkdown);

      const create = calls.find((c) => c.script === "scripts/clarice-schedule-group.ts" && c.args.includes("--create"));
      assert.equal(
        create!.args[create!.args.indexOf("--subject") + 1],
        "Assunto travado pelo editor",
        "o assunto do ESTADO vence o herdado da onda anterior ('Assunto travado')",
      );
      assert.ok(!create!.args.includes("--key"), "onda única não precisa de --key (simetria com o teste 'travar (1 célula)')");
      const split = calls.find((c) => c.script === "scripts/clarice-split-group-cells.ts");
      assert.ok(split!.args.includes("--no-cells"), "teste encerrado => 1 lista só");
      assert.match(r.reportMarkdown, /ENCERRADO/, "o relatório precisa dizer de onde veio a decisão (item 5 da #5055)");
      assert.match(
        r.reportMarkdown,
        /encerrado no chat/,
        "o MOTIVO registrado pelo editor precisa chegar ao relatório verbatim, não só a palavra ENCERRADO",
      );
      rmSync(root, { recursive: true, force: true });
    });

    it('#5055: estado ENCERRADO + planejador devolvendo "iniciar" => ABORTA com diagnóstico, não pausa em silêncio', async () => {
      // Achado HIGH do silent-failure-hunter no review da PR #5057: o ramo
      // `iniciar` retornava code 0 ANTES do guard, e `iniciar` é justamente o
      // que `recommendAbcAction` devolve quando o lock não foi aplicado E o
      // ciclo ainda não tem 2 células amostradas (estado NORMAL no começo de
      // um ciclo). A pausa sai com a mesma mensagem da espera rotineira pelo
      // editor — divergência disfarçada de operação normal. O guard agora
      // roda ANTES do ramo `iniciar`.
      const root = freshRoot();
      const proposal = goldenProposal({
        abc: { action: "iniciar", metric: "nenhuma", winner: null, caveats: [], rationale: "nenhuma célula amostrada" },
      });
      const { exec, calls } = makeFakeExec({
        ...goldenHandlers(),
        "scripts/clarice-plan-wave.ts": jsonResult(proposal),
      });
      const r = await runEnvio(baseDeps(root, { exec, readAbcState: () => abcEncerrado("Assunto travado") }));
      assert.equal(r.code, 1, "divergência é erro duro, não pausa limpa");
      assert.match(r.reportMarkdown, /ENCERRADO/);
      assert.doesNotMatch(r.reportMarkdown, /Pausando/, "não pode sair pela mensagem de espera rotineira");
      assert.equal(calls.filter((c) => c.script === "scripts/clarice-schedule-group.ts").length, 0);
      rmSync(root, { recursive: true, force: true });
    });

    it("#5055: planejador travou o assunto mas o estado agora diz ABERTO (reopen concorrente) => ABORTA", async () => {
      // A outra direção do TOCTOU (achado do code-reviewer): sem este ramo,
      // `lockedSubject` viria null, o guard antigo não dispararia, e
      // `resolveInheritedSubjects` reusaria em silêncio o assunto que o editor
      // ACABOU de destravar.
      const root = freshRoot();
      const proposal = goldenProposal({
        abc: { action: "travar", metric: "nenhuma", winner: null, caveats: [], rationale: "assunto travado" },
      });
      const { exec, calls } = makeFakeExec({
        ...goldenHandlers(),
        "scripts/clarice-plan-wave.ts": jsonResult(proposal),
      });
      const r = await runEnvio(baseDeps(root, { exec, readAbcState: () => abcAberto() }));
      assert.equal(r.code, 1, r.reportMarkdown);
      assert.match(r.reportMarkdown, /ABERTO/);
      assert.equal(calls.filter((c) => c.script === "scripts/clarice-schedule-group.ts").length, 0);
      rmSync(root, { recursive: true, force: true });
    });

    it('#5055: estado ENCERRADO mas planejador devolveu "continuar" => ABORTA, nunca manda 3 assuntos', async () => {
      // Divergência = bug (cwd errado no spawn, script defasado). Seguir seria
      // reabrir o teste depois de o editor tê-lo encerrado — a falha exata que
      // a issue existe pra impedir.
      const root = freshRoot();
      const proposal = goldenProposal({
        abc: { action: "continuar", metric: "clique", winner: null, caveats: [], rationale: "p 0,27" },
        state: {
          cycle: CYCLE,
          waves: [
            wave({ key: "d11-ter11-A", subject: "Sub A" }),
            wave({ key: "d11-ter11-B", subject: "Sub B" }),
            wave({ key: "d11-ter11-C", subject: "Sub C" }),
          ],
          generatedAt: NOW.toISOString(),
        } as unknown as WaveProposal["state"],
      });
      const { exec, calls } = makeFakeExec({
        ...goldenHandlers(),
        "scripts/clarice-plan-wave.ts": jsonResult(proposal),
      });
      const r = await runEnvio(baseDeps(root, { exec, readAbcState: () => abcEncerrado("Assunto travado") }));
      assert.equal(r.code, 1, r.reportMarkdown);
      assert.match(r.reportMarkdown, /ENCERRADO/);
      assert.equal(
        calls.filter((c) => c.script === "scripts/clarice-schedule-group.ts").length,
        0,
        "nenhuma campanha pode ser criada quando o estado diverge",
      );
      rmSync(root, { recursive: true, force: true });
    });

    it("#5055: estado ILEGÍVEL => segue como ABERTO, mas registra o aviso no relatório", async () => {
      const root = freshRoot();
      const { exec } = makeFakeExec(goldenHandlers());
      const r = await runEnvio(
        baseDeps(root, {
          exec,
          readAbcState: () => ({ ...abcAberto(), invalidReason: "JSON inválido (data/clarice-abc-state.json)" }),
        }),
      );
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.match(r.reportMarkdown, /ileg[íi]vel/i, "queda pro default nunca pode ser silenciosa");
      rmSync(root, { recursive: true, force: true });
    });

    it("continuar (3 células): --no-cells AUSENTE em clarice-split-group-cells.ts", async () => {
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
        return args.includes("--create")
          ? jsonResult({ key, listId: 1, campaignId: 1, phase: "create", status: "draft" })
          : jsonResult({ key, listId: 1, campaignId: 1, phase: "schedule", status: "scheduled" });
      };
      const { exec, calls } = makeFakeExec({ ...goldenHandlers({ proposal }), "scripts/clarice-schedule-group.ts": scheduleGroupHandler });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 0, r.reportMarkdown);
      const split = calls.find((c) => c.script === "scripts/clarice-split-group-cells.ts");
      assert.ok(split && !split.args.includes("--no-cells"), "continuar (3 células) NUNCA passa --no-cells");
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

    it("corte por crédito Brevo (volume > 0) => rodada SEGUE e agenda o volume reduzido, sem parar (#5042)", async () => {
      // Cobre a assimetria documentada no Passo 4/5 de clarice-envio-run.ts:
      // fila insuficiente PARA a rodada (teste acima); crédito insuficiente
      // (mas > 0) é só um corte de volume dentro do MESMO público já
      // elegível — a rodada segue e agenda o volume reduzido. Antes deste
      // teste, esse caminho só era exercitado nos testes puros de
      // `proposeNextVolume` (clarice-envio-policy.test.ts), nunca no
      // orquestrador.
      const root = freshRoot();
      // baseVolume 3005, step 0.15 (healthyRisk) => volume proposto = 3456.
      // availableFirstSend bem acima (não corta pela fila) — só o crédito,
      // deliberadamente abaixo do proposto, corta.
      const proposal = goldenProposal({ availableFirstSend: 5000, brevoCredits: 2000 });
      const { exec, calls } = makeFakeExec(goldenHandlers({ proposal }));
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 0, r.reportMarkdown);

      // A rodada SEGUIU: chegou a segmentar/montar a onda (não parou como no
      // caminho "fila insuficiente").
      const segment = calls.find((c) => c.script === "scripts/clarice-build-segment.ts");
      assert.ok(segment, "corte por crédito não deveria parar a rodada — deveria segmentar com o volume reduzido");
      assert.deepEqual(segment!.args, ["--group", "ramp-warm", "--cycle", CYCLE, "--budget", "2000"]);

      const schedule = calls.filter((c) => c.script === "scripts/clarice-schedule-group.ts" && c.args.includes("--schedule") && !c.args.includes("--create"));
      assert.equal(schedule.length, 1, "onda com o volume cortado por crédito ainda é agendada");

      assert.match(r.reportMarkdown, /cappedBy: credit/, "relatório registra que o crédito foi quem cortou o volume final");
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

  // -----------------------------------------------------------------------
  // #5058 — guard de onda já existente pra `sendDate`
  // -----------------------------------------------------------------------

  describe("runEnvio — guard de onda JÁ EXISTENTE pra sendDate (#5058)", () => {
    it("proposal.state.waves já tem onda pra sendDate (queued) => PARA a rodada (code 0), nunca segmenta de novo", async () => {
      const root = freshRoot();
      const proposal = goldenProposal({
        state: {
          cycle: CYCLE,
          waves: [
            wave({ key: "d11-qua11", subject: "Antiga", status: "sent", scheduledAt: "2026-08-11T13:45:00.000Z" }),
            wave({ key: "d12-qua12", subject: "Já montada nesta janela", status: "queued", scheduledAt: `${SEND_DATE}T09:00:00.000Z` }),
          ],
          volumeSum: 100000, volumeComplete: true, sentCount: 10, scheduledCount: 1, unscopedCount: 0,
        },
      });
      const { exec, calls } = makeFakeExec({
        "scripts/clarice-check-derived-stale.ts": textResult("fresh"),
        "scripts/clarice-plan-wave.ts": jsonResult(proposal),
      });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.match(r.reportMarkdown, /ONDA JÁ EXISTE/);
      assert.match(r.reportMarkdown, /d12-qua12/);
      assert.ok(
        !calls.some((c) => c.script === "scripts/clarice-envio-risk.ts" || c.script === "scripts/clarice-build-segment.ts"),
        "onda já existente pra sendDate deve parar ANTES de calcular risco/volume — nunca monta uma 2ª onda",
      );
      rmSync(root, { recursive: true, force: true });
    });

    it("onda existente pro sendDate com status suspended (cancelada) => NÃO bloqueia, segue normal", async () => {
      const root = freshRoot();
      const proposal = goldenProposal({
        state: {
          cycle: CYCLE,
          waves: [
            wave({ key: "d12-qua12", subject: "Cancelada pelo freio", status: "suspended", scheduledAt: `${SEND_DATE}T09:00:00.000Z` }),
          ],
          volumeSum: 100000, volumeComplete: true, sentCount: 10, scheduledCount: 0, unscopedCount: 0,
        },
      });
      const { exec, calls } = makeFakeExec({ ...goldenHandlers({ proposal }) });
      const r = await runEnvio(baseDeps(root, { exec }));
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.ok(calls.some((c) => c.script === "scripts/clarice-build-segment.ts"), "onda cancelada não deve travar a rodada");
      rmSync(root, { recursive: true, force: true });
    });
  });

  // -----------------------------------------------------------------------
  // #5058 — retry com backoff de clarice-plan-wave transitório (429/503)
  // -----------------------------------------------------------------------

  describe("runEnvio — retry transitório de clarice-plan-wave (#5058)", () => {
    function transientResult(retryAfterSecs: number | null, reason = "GET .../api/campaigns falhou (503)"): StepResult {
      return { code: 3, stdout: JSON.stringify({ transient: true, retryAfterSecs, status: 503, reason }), stderr: reason };
    }

    it("1ª tentativa TRANSITÓRIA (503) seguida de sucesso => retenta e completa a rodada (code 0), honrando retryAfterSecs no sleep", async () => {
      const root = freshRoot();
      const sleeps: number[] = [];
      const { exec, calls } = makeFakeExec({
        ...goldenHandlers(),
        "scripts/clarice-plan-wave.ts": [transientResult(5), jsonResult(goldenProposal())],
      });
      const r = await runEnvio(baseDeps(root, { exec, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } }));
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.equal(calls.filter((c) => c.script === "scripts/clarice-plan-wave.ts").length, 2, "retentou 1× e a 2ª chamada teve sucesso");
      assert.deepEqual(sleeps, [5000], "esperou exatamente retryAfterSecs*1000, não um fallback arbitrário");
      assert.match(r.reportMarkdown, /TRANSITÓRIA/);
      rmSync(root, { recursive: true, force: true });
    });

    it("retryAfterSecs ausente => usa o fallback (1min), nunca espera 0/undefined", async () => {
      const root = freshRoot();
      const sleeps: number[] = [];
      const { exec } = makeFakeExec({
        ...goldenHandlers(),
        "scripts/clarice-plan-wave.ts": [transientResult(null), jsonResult(goldenProposal())],
      });
      const r = await runEnvio(baseDeps(root, { exec, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } }));
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.deepEqual(sleeps, [60_000]);
      rmSync(root, { recursive: true, force: true });
    });

    it("retryAfterSecs absurdamente alto => capped em 35min, nunca pendura a rodada", async () => {
      const root = freshRoot();
      const sleeps: number[] = [];
      const { exec } = makeFakeExec({
        ...goldenHandlers(),
        "scripts/clarice-plan-wave.ts": [transientResult(3600), jsonResult(goldenProposal())], // 1h
      });
      const r = await runEnvio(baseDeps(root, { exec, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } }));
      assert.equal(r.code, 0, r.reportMarkdown);
      assert.deepEqual(sleeps, [35 * 60_000], "capped em 35min mesmo com retryAfterSecs de 1h");
      rmSync(root, { recursive: true, force: true });
    });

    it("falha TRANSITÓRIA persiste nas 3 tentativas => desiste (code 1), nunca fica em loop infinito", async () => {
      const root = freshRoot();
      let sleepCalls = 0;
      const { exec, calls } = makeFakeExec({
        "scripts/clarice-check-derived-stale.ts": textResult("fresh"),
        "scripts/clarice-plan-wave.ts": [transientResult(1), transientResult(1), transientResult(1)],
      });
      const r = await runEnvio(baseDeps(root, { exec, sleep: () => { sleepCalls++; return Promise.resolve(); } }));
      assert.equal(r.code, 1, r.reportMarkdown);
      assert.equal(calls.filter((c) => c.script === "scripts/clarice-plan-wave.ts").length, 3, "exatamente 3 tentativas, não mais");
      assert.equal(sleepCalls, 2, "espera ENTRE tentativas (2 esperas pra 3 tentativas), nunca depois da última");
      assert.match(r.reportMarkdown, /falha TRANSITÓRIA persistiu/);
      rmSync(root, { recursive: true, force: true });
    });

    it("falha NÃO-transitória (exit 1 genérico) => aborta na 1ª tentativa, sem retry nem sleep", async () => {
      const root = freshRoot();
      let sleepCalls = 0;
      const { exec, calls } = makeFakeExec({
        "scripts/clarice-check-derived-stale.ts": textResult("fresh"),
        "scripts/clarice-plan-wave.ts": textResult("erro de config qualquer", 1),
      });
      const r = await runEnvio(baseDeps(root, { exec, sleep: () => { sleepCalls++; return Promise.resolve(); } }));
      assert.equal(r.code, 1, r.reportMarkdown);
      assert.equal(calls.filter((c) => c.script === "scripts/clarice-plan-wave.ts").length, 1, "erro não-transitório NUNCA retenta");
      assert.equal(sleepCalls, 0);
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

  // ── #5048: mesmo achado do #4983, script irmão ──────────────────────────
  //
  // Achado ao vivo na 1ª invocação real da task agendada (260811 22:00 UTC):
  // este orquestrador nunca chamava `loadProjectEnv()` — igual ao #4983 em
  // `clarice-novos-run.ts`, mas ninguém replicou o fix aqui quando o script
  // foi escrito. Sob systemd --user (sem herdar o `.env` do shell), o
  // preflight abortava com "BREVO_CLARICE_API_KEY não definida" mesmo com a
  // key presente em `.env` — a onda do dia seguinte não era planejada.
  //
  // Teste ESTÁTICO (regex sobre o source), não comportamental — mesmo
  // racional do #4983: `loadProjectEnv()` resolve a raiz do projeto a partir
  // do próprio `import.meta.url` do env-loader, sem ponto de override, e a
  // execução de módulo ESM (corpo do módulo roda inteiro na 1ª importação)
  // faria um teste comportamental passar mesmo com a chamada movida pra
  // depois do preflight — porque a essa altura o módulo já carregou. O
  // invariante real é sintático: a chamada aparece ANTES do bloco que lê
  // `process.env.BREVO_CLARICE_API_KEY`.
  describe("#5048 — loadProjectEnv() no orquestrador (não só nos sub-scripts)", () => {
    const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "clarice-envio-run.ts");
    const src = readFileSync(SCRIPT_PATH, "utf8");

    it("importa loadProjectEnv de lib/env-loader.ts", () => {
      assert.match(
        src,
        /import\s+\{\s*loadProjectEnv\s*\}\s+from\s+["']\.\/lib\/env-loader\.ts["']/,
        "scripts/clarice-envio-run.ts deve importar loadProjectEnv de ./lib/env-loader.ts",
      );
    });

    it("chama loadProjectEnv() em scope top-level (não dentro de runEnvio/função)", () => {
      assert.match(
        src,
        /^loadProjectEnv\(\);?\s*$/m,
        "scripts/clarice-envio-run.ts deve chamar loadProjectEnv() em scope top-level — guarda contra " +
          "remoção acidental (ex: mover pra dentro de runEnvio, ou apagar achando redundante).",
      );
    });

    it("a chamada de loadProjectEnv() aparece ANTES do bloco de preflight que lê " +
      "process.env.BREVO_CLARICE_API_KEY — trava a ORDEM, não só o comportamento final", () => {
      const callMatch = src.match(/^loadProjectEnv\(\);?\s*$/m);
      const preflightMatch = src.match(/if\s*\(\s*!process\.env\.BREVO_CLARICE_API_KEY\s*\)/);
      assert.ok(callMatch, "chamada explícita loadProjectEnv() não encontrada");
      assert.ok(preflightMatch, "bloco de preflight (if (!process.env.BREVO_CLARICE_API_KEY)) não encontrado — arquivo mudou de forma inesperada?");
      assert.ok(
        (callMatch!.index as number) < (preflightMatch!.index as number),
        "loadProjectEnv() deve vir ANTES do bloco de preflight no arquivo — uma reordenação de " +
          "imports/código que mova a chamada pra depois do preflight desfaz o fix do #5048 sem quebrar " +
          "nenhum teste comportamental (os outros testes desta suíte setam a key direto em process.env, " +
          "não via .env).",
      );
    });
  });
});
