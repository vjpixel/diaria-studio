/**
 * test/runner-step-timings.test.ts (#14032)
 *
 * Duração por passo dos runners de etapa: o recorder de
 * `scripts/lib/runner-step-timings.ts` e a ligação dele em `stage-0-run.ts`,
 * `stage-1-run.ts` e `stage-2-run.ts`. Relógio injetado (`clockMs`) que anda
 * 10 ms por leitura: todo passo mede exatamente 10 ms, sem depender do tempo
 * real. Nenhum spawn real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emitStepTimings, StepTimingRecorder, stepTimingLabel, type StepTimingsSummary } from "../scripts/lib/runner-step-timings.ts";
import { runStage0, type Stage0RunDeps, type StepResult } from "../scripts/stage-0-run.ts";
import { runStage1, type Stage1RunDeps } from "../scripts/stage-1-run.ts";
import { runStage2, type Stage2RunDeps } from "../scripts/stage-2-run.ts";

type Handler = (args: string[]) => StepResult;
type Call = { script: string; args: string[] };

const ok = (stdout = "{}"): StepResult => ({ code: 0, stdout, stderr: "" });
const fail = (code = 1, stderr = "erro"): StepResult => ({ code, stdout: "", stderr });

/** Relógio que anda 10 ms a cada leitura, a partir de 2026-11-26T09:00:00Z. */
function tickingClock(stepMs = 10): () => number {
  let t = Date.UTC(2026, 10, 26, 9, 0, 0);
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

function isTimingsCall(c: Call): boolean {
  return c.script.endsWith("log-event.ts") && c.args[c.args.indexOf("--message") + 1] === "step_timings";
}

function argOf(c: Call, flag: string): string | undefined {
  const i = c.args.indexOf(flag);
  return i >= 0 ? c.args[i + 1] : undefined;
}

function timingsOf(calls: Call[]): { call: Call; summary: StepTimingsSummary }[] {
  return calls.filter(isTimingsCall).map((call) => ({ call, summary: JSON.parse(argOf(call, "--details") ?? "null") as StepTimingsSummary }));
}

function makeExec(handlers: Record<string, Handler>, calls: Call[]) {
  return (script: string, args: string[]): StepResult => {
    calls.push({ script, args });
    const h = handlers[script.split("/").pop() ?? script];
    return h ? h(args) : ok();
  };
}

/** Captura `console.error` durante `fn` (o aviso de log falho vai pro stderr). */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = orig;
  }
}

// ---------------------------------------------------------------------------
// Recorder puro
// ---------------------------------------------------------------------------

describe("stepTimingLabel", () => {
  it("tira scripts/ e .ts e mantém os argumentos curtos", () => {
    assert.equal(stepTimingLabel("scripts/clarice-healthcheck.ts", ["--real-chunk"]), "clarice-healthcheck --real-chunk");
    assert.equal(stepTimingLabel("scripts/lib/find-current-edition.ts", ["--resolve", "261127"]), "lib/find-current-edition --resolve 261127");
  });

  it("path, texto com espaço e valor longo viram …; log-event não leva a mensagem", () => {
    assert.equal(
      stepTimingLabel("scripts/update-stage-status.ts", ["--edition-dir", "data/editions/2611/261127", "--stage", "0", "--status", "done"]),
      "update-stage-status --edition-dir … --stage 0 --status done",
    );
    assert.equal(stepTimingLabel("scripts/log-event.ts", ["--message", "edition run started"]), "log-event");
    assert.equal(stepTimingLabel("scripts/x.ts", ["--k", "a".repeat(30)]), "x --k …");
  });

  it("corta em 120 caracteres", () => {
    const label = stepTimingLabel("scripts/x.ts", Array.from({ length: 40 }, () => "--flag"));
    assert.equal(label.length, 120);
    assert.ok(label.endsWith("…"));
  });
});

describe("StepTimingRecorder", () => {
  it("mede ms com o relógio injetado e prefere o label explícito", () => {
    const rec = new StepTimingRecorder(tickingClock());
    const exec = rec.wrapExec((_s: string, _a: string[]) => fail(3));
    exec("scripts/a.ts", [], "passo A (0x)");
    exec("scripts/b.ts", ["--x"]);
    assert.deepEqual(rec.steps, [
      { label: "passo A (0x)", ms: 10, code: 3 },
      { label: "b --x", ms: 10, code: 3 },
    ]);
    const s = rec.summary("continue");
    assert.equal(s.phase, "continue");
    assert.equal(s.started_at, "2026-11-26T09:00:00.000Z");
    assert.equal(s.total_ms, 50);
  });

  it("exec que lança: registra code -1 e relança", () => {
    const rec = new StepTimingRecorder(tickingClock());
    const exec = rec.wrapExec((): StepResult => {
      throw new Error("spawn quebrou");
    });
    assert.throws(() => exec("scripts/a.ts", []), /spawn quebrou/);
    assert.deepEqual(rec.steps, [{ label: "a", ms: 10, code: -1 }]);
  });

  it("execAsync marca async: true; rejeição vira code -1 e propaga", async () => {
    const rec = new StepTimingRecorder(tickingClock());
    const okAsync = rec.wrapExecAsync(async () => ok());
    const badAsync = rec.wrapExecAsync(async (): Promise<StepResult> => {
      throw new Error("x");
    });
    await okAsync("scripts/kit-sync.ts", []);
    await assert.rejects(badAsync("scripts/b.ts", []), /x/);
    assert.deepEqual(rec.steps, [
      { label: "kit-sync", ms: 10, code: 0, async: true },
      { label: "b", ms: 10, code: -1, async: true },
    ]);
  });
});

describe("emitStepTimings", () => {
  const summary: StepTimingsSummary = { phase: "p", started_at: "2026-11-26T09:00:00.000Z", total_ms: 1, steps: [] };

  it("grava 1 evento step_timings via log-event com o stage e o agent", () => {
    const calls: Call[] = [];
    emitStepTimings(makeExec({}, calls), { edition: "261127", stage: "0", agent: "orchestrator" }, summary);
    assert.equal(calls.length, 1);
    assert.equal(argOf(calls[0], "--stage"), "0");
    assert.equal(argOf(calls[0], "--agent"), "orchestrator");
    assert.equal(argOf(calls[0], "--level"), "info");
    assert.deepEqual(JSON.parse(argOf(calls[0], "--details") ?? ""), summary);
  });

  it("log-event com exit != 0 ou exceção: nunca lança, avisa no stderr", async () => {
    const { lines } = await captureStderr(async () => {
      emitStepTimings(() => fail(2), { edition: "261127", stage: "1", agent: "orchestrator" }, summary);
      emitStepTimings(
        () => {
          throw new Error("EPERM");
        },
        { edition: "261127", stage: "1", agent: "orchestrator" },
        summary,
      );
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /step_timings.*saiu 2/);
    assert.match(lines[1], /step_timings.*EPERM/);
  });
});

// ---------------------------------------------------------------------------
// Stage 0
// ---------------------------------------------------------------------------

const STAGE0_CONTINUE = ["--edition", "260423", "--phase", "continue", "--mcp-chrome", "true", "--mcp-gmail", "true"];

function stage0Handlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
    "refresh-dedup.ts": () => ok(JSON.stringify({ new_posts: 2, most_recent_date: "2026-04-22" })),
    "check-invariants.ts": () => ok(JSON.stringify({ passed: true, violations: [] })),
    "capture-stage-usage.ts": () => ok(JSON.stringify({ source: "ok" })),
    "find-pending-issue-drafts.ts": () => ok("[]"),
    "find-last-edition-with-fb.ts": () => ok("data/editions/2604/260422\n"),
    "find-last-edition-with-kit.ts": () => ok(""),
    "check-prev-social-status.ts": () => ok(JSON.stringify({ findings: [], total: 0 })),
    "merge-local-pending.ts": () => ok(JSON.stringify({ pending_found: 0, editions: [] })),
    "check-dedup-freshness.ts": () => ok(JSON.stringify({ ok: true })),
    ...overrides,
  };
}

function stage0Deps(handlers: Record<string, Handler>, calls: Call[]): Stage0RunDeps {
  const exec = makeExec(handlers, calls);
  return {
    rootDir: "/fake-root",
    now: () => new Date("2026-04-23T08:00:00Z"),
    clockMs: tickingClock(),
    exec,
    execAsync: async (s, a) => exec(s, a),
    existsSync: () => false,
    mkdirSync: () => {},
    writeFile: () => {},
    readFile: (p) => {
      if (p.endsWith("platform.config.json")) return JSON.stringify({ newsletter_auto_capture: { enabled: false } });
      throw new Error(`readFile não mockado: ${p}`);
    },
  };
}

describe("stage-0-run: step_timings (#14032)", () => {
  it("--phase continue grava 1 evento com label+ms+code de cada step, softStep, exec direto e do lote async", async () => {
    const calls: Call[] = [];
    const deps = stage0Deps(stage0Handlers({ "verify-twitter-posts.ts": () => fail(4) }), calls);
    const result = await runStage0(STAGE0_CONTINUE, deps);

    assert.equal(result.code, 0);
    const events = timingsOf(calls);
    assert.equal(events.length, 1);
    const [{ call, summary }] = events;
    assert.equal(argOf(call, "--stage"), "0");
    assert.equal(argOf(call, "--edition"), "260423");
    assert.equal(summary.phase, "continue");
    assert.equal(summary.started_at, "2026-11-26T09:00:00.000Z");

    const by = (label: string) => summary.steps.find((s) => s.label === label);
    assert.deepEqual(by("refresh-dedup (0d)"), { label: "refresh-dedup (0d)", ms: 10, code: 0 }); // step()
    assert.deepEqual(by("verify-twitter-posts (0k)"), { label: "verify-twitter-posts (0k)", ms: 10, code: 4 }); // softStep()
    assert.deepEqual(by("clarice-healthcheck --real-chunk"), { label: "clarice-healthcheck --real-chunk", ms: 10, code: 0 }); // deps.exec direto
    // Lote 0e-0h: os 4 começam antes de qualquer um terminar, então os ms se
    // sobrepõem: os 4 inícios leem o relógio em t0..t3 e os 4 fins em t4..t7,
    // logo cada passo do lote mede 4 ticks (4 x 10 ms = 40 ms).
    assert.deepEqual(by("kit-sync"), { label: "kit-sync", ms: 40, code: 0, async: true });
    assert.equal(summary.steps.filter((s) => s.async).length, 4);
    // Todo exec da fase foi medido (o próprio step_timings fica de fora).
    assert.equal(summary.steps.length, calls.filter((c) => !isTimingsCall(c)).length);
    assert.ok(summary.steps.filter((s) => !s.async).every((s) => s.ms === 10));
  });

  it("nada de step_timings no JSON de saída", async () => {
    const calls: Call[] = [];
    const result = await runStage0(STAGE0_CONTINUE, stage0Deps(stage0Handlers(), calls));
    assert.doesNotMatch(JSON.stringify(result), /step_timings|"ms":/);
  });

  it("abort no meio (refresh-dedup falha) ainda grava os passos até ali, com o code do passo", async () => {
    const calls: Call[] = [];
    const result = await runStage0(STAGE0_CONTINUE, stage0Deps(stage0Handlers({ "refresh-dedup.ts": () => fail(1) }), calls));
    assert.equal(result.code, 1);
    const [{ summary }] = timingsOf(calls);
    assert.deepEqual(summary.steps.at(-1), { label: "refresh-dedup (0d)", ms: 10, code: 1 });
  });

  it("log do step_timings falhando (exit != 0 ou exceção) não muda code nem JSON", async () => {
    const baseline = await runStage0(STAGE0_CONTINUE, stage0Deps(stage0Handlers(), []));
    for (const broken of [() => fail(1), () => { throw new Error("disco cheio"); }]) {
      const calls: Call[] = [];
      const deps = stage0Deps(stage0Handlers(), calls);
      const inner = deps.exec;
      deps.exec = (s, a) => {
        if (isTimingsCall({ script: s, args: a })) return broken();
        return inner(s, a);
      };
      const { value: result, lines } = await captureStderr(() => runStage0(STAGE0_CONTINUE, deps));
      assert.deepEqual(result, baseline);
      assert.ok(lines.some((l) => /step_timings \(#14032\)/.test(l)));
    }
  });

  it("--phase preflight não grava nada (fase sem escrita)", async () => {
    const calls: Call[] = [];
    const result = await runStage0(["--edition", "260423", "--phase", "preflight"], stage0Deps(stage0Handlers(), calls));
    assert.equal(result.code, 0);
    assert.equal(timingsOf(calls).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Stage 1
// ---------------------------------------------------------------------------

function stage1Deps(handlers: Record<string, Handler>, calls: Call[]): Stage1RunDeps {
  return {
    rootDir: "/fake-root",
    now: () => new Date("2026-04-23T08:00:00Z"),
    clockMs: tickingClock(),
    exec: makeExec(handlers, calls),
    spawnDetached: () => {},
    existsSync: () => false,
    mkdirSync: () => {},
    readFile: (p) => {
      if (p.endsWith("websearch-results.json")) return "[]";
      if (p.endsWith("researcher-results.json")) return "[]";
      throw new Error(`readFile não mockado: ${p}`);
    },
    writeFile: () => {},
    renameFile: () => {},
    hasEnv: () => undefined,
  };
}

const stage1Handlers = (overrides: Record<string, Handler> = {}): Record<string, Handler> => ({
  "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
  "inbox-drain.ts": () => ok(JSON.stringify({ new_entries: 0, urls: [], topics: [], skipped: false })),
  "list-active-sources.ts": () => ok("[]"),
  "fetch-rss-batch.ts": () => ok(JSON.stringify({ articles_total: 0 })),
  "extract-inbox-topics.ts": () => ok("[]"),
  "fetch-websearch-batch.ts": () => ok(JSON.stringify({ ok: true })),
  ...overrides,
});

describe("stage-1-run: step_timings (#14032)", () => {
  it("grava 1 evento por fase com label+ms+code de cada sub-script", async () => {
    const calls: Call[] = [];
    const result = await runStage1(["--phase", "pre-research", "--edition", "260423"], stage1Deps(stage1Handlers(), calls));
    assert.equal(result.code, 0);
    const events = timingsOf(calls);
    assert.equal(events.length, 1);
    const [{ call, summary }] = events;
    assert.equal(argOf(call, "--stage"), "1");
    assert.equal(summary.phase, "pre-research");
    assert.deepEqual(
      summary.steps.find((s) => s.label === "lib/find-current-edition --resolve 260423"),
      { label: "lib/find-current-edition --resolve 260423", ms: 10, code: 0 },
    );
    assert.equal(summary.steps.length, calls.filter((c) => !isTimingsCall(c)).length);
    assert.doesNotMatch(JSON.stringify(result), /step_timings/);
  });

  it("abort (Path A com exit 9) grava o passo com o code; log que lança não propaga", async () => {
    const calls: Call[] = [];
    const deps = stage1Deps(stage1Handlers({ "fetch-websearch-batch.ts": () => fail(9, "boom") }), calls);
    const inner = deps.exec;
    deps.exec = (s, a) => {
      if (isTimingsCall({ script: s, args: a })) {
        calls.push({ script: s, args: a });
        throw new Error("EPERM");
      }
      return inner(s, a);
    };
    const { value: result, lines } = await captureStderr(() => runStage1(["--phase", "pre-research", "--edition", "260423"], deps));
    assert.equal(result.code, 1);
    const [{ summary }] = timingsOf(calls);
    assert.ok(summary.steps.some((s) => s.label.startsWith("fetch-websearch-batch") && s.code === 9 && s.ms === 10));
    assert.ok(lines.some((l) => /step_timings.*EPERM/.test(l)));
  });
});

// ---------------------------------------------------------------------------
// Stage 2
// ---------------------------------------------------------------------------

describe("stage-2-run: step_timings (#14032)", () => {
  it("grava o evento mesmo quando a fase sai cedo, e log com exit != 0 não muda o resultado", async () => {
    const calls: Call[] = [];
    const deps: Stage2RunDeps = {
      now: () => new Date("2026-11-26T09:00:00Z"),
      clockMs: tickingClock(),
      exec: (s, a) => {
        const c = { script: s, args: a };
        calls.push(c);
        if (isTimingsCall(c)) return fail(1);
        if (s.endsWith("find-current-edition.ts")) return fail(2);
        return ok();
      },
    };
    const { value: result, lines } = await captureStderr(() => runStage2(["--phase", "post-checks", "--edition", "261126"], deps));
    assert.equal(result.code, 1);
    const [{ call, summary }] = timingsOf(calls);
    assert.equal(argOf(call, "--stage"), "2");
    assert.equal(argOf(call, "--agent"), "stage-2-run");
    assert.equal(summary.phase, "post-checks");
    assert.deepEqual(summary.steps, [{ label: "lib/find-current-edition --resolve 261126", ms: 10, code: 2 }]);
    assert.ok(lines.some((l) => /step_timings.*saiu 1/.test(l)));
  });

  it("args inválidos (sem fase) não gravam nada", async () => {
    const calls: Call[] = [];
    const result = await runStage2(["--edition", "261126"], { now: () => new Date(), exec: makeExec({}, calls) });
    assert.equal(result.code, 1);
    assert.equal(calls.length, 0);
  });
});
