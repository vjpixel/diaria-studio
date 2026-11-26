/**
 * test/stage-2-run.test.ts (#14031, #14029)
 *
 * Runner da Etapa 2: cada exit code do runner (0/1/2/3) tem teste, e a
 * escolha do teto da Clarice (90 s com o ping real do Stage 0 falho) é
 * conferida no argv do `clarice-correct.ts`. `exec` é fake (nenhum
 * sub-script real roda, nenhuma chamada à Clarice); o FS é um diretório
 * temporário.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runStage2,
  socialClariceDeadlineMs,
  readRunState,
  CLARICE_PHASE_BUDGET_MS,
  CLARICE_SOCIAL_MIN_MS,
  STAGE2_SNAPSHOTS,
  type StepResult,
  type Stage2RunDeps,
} from "../scripts/stage-2-run.ts";
import {
  resolveClariceStage2DeadlineMs,
  CLARICE_DEGRADED_DEADLINE_MS,
  CLARICE_NORMAL_DEADLINE_MS,
} from "../scripts/lib/clarice-stage2-deadline.ts";
import { CLARICE_TOTAL_DEADLINE_MS } from "../scripts/clarice-correct.ts";

type Handler = (args: string[]) => StepResult;
interface Call {
  script: string;
  args: string[];
}

const ok = (stdout = ""): StepResult => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stdout = "", stderr = ""): StepResult => ({ code, stdout, stderr });

let dir: string;

function makeDeps(handlers: Record<string, Handler> = {}): { deps: Stage2RunDeps; calls: Call[] } {
  const calls: Call[] = [];
  const all: Record<string, Handler> = {
    "find-current-edition.ts": () => ok(dir + "\n"),
    ...handlers,
  };
  return {
    calls,
    deps: {
      now: () => new Date(Date.now() - 60_000),
      exec: (script, args) => {
        calls.push({ script, args });
        const base = script.split("/").pop() ?? script;
        const h = all[base];
        return h ? h(args) : ok();
      },
    },
  };
}

function write(rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text, "utf8");
}

function highlights(n: number): string {
  return JSON.stringify({
    highlights: Array.from({ length: n }, (_, i) => ({
      bucket: "radar",
      article: { url: `https://ex.com/${i + 1}`, title: `T${i + 1}`, category: "noticias" },
    })),
  });
}

function argOf(call: Call | undefined, flag: string): string | undefined {
  if (!call) return undefined;
  const i = call.args.indexOf(flag);
  return i >= 0 ? call.args[i + 1] : undefined;
}

const E = "261126";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stage2-run-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  write("_internal/01-approved.json", highlights(3));
  write("_internal/01-approved-capped.json", highlights(3));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("teto da Clarice na Etapa 2 (#14029)", () => {
  it("ping real falho → 90 s; ok ou nunca sondado → 480 s", () => {
    assert.equal(resolveClariceStage2DeadlineMs({ clariceRealProbe: false }).deadlineMs, 90_000);
    assert.equal(resolveClariceStage2DeadlineMs({ clariceRealProbe: false }).degraded, true);
    assert.equal(resolveClariceStage2DeadlineMs({ clariceRealProbe: true }).deadlineMs, 480_000);
    assert.equal(resolveClariceStage2DeadlineMs({ clariceRealProbe: null }).deadlineMs, 480_000);
    assert.equal(CLARICE_DEGRADED_DEADLINE_MS, 90_000);
  });

  it("o teto normal é o mesmo do clarice-correct.ts", () => {
    assert.equal(CLARICE_NORMAL_DEADLINE_MS, CLARICE_TOTAL_DEADLINE_MS);
  });

  it("o social recebe o que sobra do orçamento da fase, com piso de 60 s", () => {
    assert.equal(socialClariceDeadlineMs(480_000, 10_000), 480_000);
    assert.equal(socialClariceDeadlineMs(480_000, 480_000), CLARICE_PHASE_BUDGET_MS - 480_000);
    assert.equal(socialClariceDeadlineMs(480_000, 530_000), CLARICE_SOCIAL_MIN_MS);
    assert.equal(socialClariceDeadlineMs(90_000, 90_000), 90_000);
  });
});

describe("runStage2 — args (code 1)", () => {
  it("--phase inválida → code 1", async () => {
    const { deps } = makeDeps();
    const r = await runStage2(["--phase", "x", "--edition", E], deps);
    assert.equal(r.code, 1);
    assert.equal(r.phase, "invalid");
  });
});

describe("--phase pre-dispatch", () => {
  it("sentinel do Stage 1 ausente → code 2 (halt)", async () => {
    const { deps } = makeDeps({ "pipeline-sentinel.ts": () => fail(1) });
    const r = await runStage2(["--phase", "pre-dispatch", "--edition", E], deps);
    assert.equal(r.code, 2);
    assert.ok(r.haltRequired);
  });

  it("apply-stage2-caps falho → code 1", async () => {
    const { deps } = makeDeps({ "apply-stage2-caps.ts": () => fail(1, "", "sem input") });
    const r = await runStage2(["--phase", "pre-dispatch", "--edition", E], deps);
    assert.equal(r.code, 1);
  });

  it("3 destaques → writer-destaque × 3 + social-writer + social-curto, numa mensagem", async () => {
    const { deps } = makeDeps({
      "refresh-destaque-sources.ts": () =>
        ok(JSON.stringify({ sources: [{ destaque: 1, path: "d1.txt" }, { destaque: 2, error: "403" }, { destaque: 3, path: "d3.txt" }] })),
      "youtube-title-research.ts": () => ok(JSON.stringify({ status: "ok" })),
      "select-use-melhor-post.ts": () => ok(JSON.stringify({ enabled: true, item: { source_text_path: "_internal/use-melhor-source.txt" } })),
    });
    const r = await runStage2(["--phase", "pre-dispatch", "--edition", E], deps);
    assert.equal(r.code, 0);
    assert.equal(r.mode, "parallel");
    assert.equal(r.dispatchTogether, true);
    assert.deepEqual(
      r.pendingAgentDispatch.map((d) => d.agent),
      ["writer-destaque", "writer-destaque", "writer-destaque", "social-writer", "social-curto"],
    );
    const [d1, d2] = r.pendingAgentDispatch;
    assert.equal(d1.params.source_text_path, "d1.txt");
    assert.ok(d1.params.youtube_title_research_path, "só o D1 recebe a pesquisa do YouTube");
    assert.equal(d2.params.source_text_path, undefined, "fonte com error fica de fora");
    assert.equal(d2.params.youtube_title_research_path, undefined);
    const social = r.pendingAgentDispatch[3].params as { source_text_paths: Record<string, string>; use_melhor_post_path?: string };
    assert.deepEqual(Object.keys(social.source_text_paths).sort(), ["d1", "d3", "um"]);
    assert.ok(social.use_melhor_post_path);
    const st = readRunState(dir);
    assert.equal(st?.destaqueCount, 3);
    assert.ok(st?.writersDispatchAt);
  });

  it("4 destaques → writer único (fallback)", async () => {
    write("_internal/01-approved-capped.json", highlights(4));
    const { deps } = makeDeps();
    const r = await runStage2(["--phase", "pre-dispatch", "--edition", E], deps);
    assert.equal(r.mode, "fallback");
    assert.equal(r.pendingAgentDispatch[0].agent, "writer");
  });

  it("ping real falho no Stage 0 aparece no resultado e no gate", async () => {
    write("_internal/preflight-state.json", JSON.stringify({ clariceRest: true, clariceRealProbe: false }));
    const { deps } = makeDeps();
    const r = await runStage2(["--phase", "pre-dispatch", "--edition", E], deps);
    assert.equal(r.clarice?.deadlineMs, 90_000);
    assert.ok(r.gateNotes.some((n) => /90 s/.test(n)));
  });
});

async function preDispatch(handlers: Record<string, Handler> = {}): Promise<void> {
  const { deps } = makeDeps(handlers);
  const r = await runStage2(["--phase", "pre-dispatch", "--edition", E], deps);
  assert.equal(r.code, 0);
}

describe("--phase post-writers", () => {
  it("sem estado do pre-dispatch → code 1", async () => {
    const { deps } = makeDeps();
    const r = await runStage2(["--phase", "post-writers", "--edition", E], deps);
    assert.equal(r.code, 1);
  });

  it("output de agente ausente → code 3, re-rodar post-writers", async () => {
    await preDispatch();
    const { deps, calls } = makeDeps({
      "verify-agent-outputs.ts": () => fail(1, JSON.stringify({ results: [{ path: "x/02-d1-draft.md", status: "missing" }] })),
    });
    const r = await runStage2(["--phase", "post-writers", "--edition", E], deps);
    assert.equal(r.code, 3);
    assert.equal(r.rerunPhase, "post-writers");
    assert.ok(!calls.some((c) => c.script.includes("stitch-newsletter")), "nunca stitch com arquivo faltando");
    const verify = calls.find((c) => c.script.includes("verify-agent-outputs"));
    assert.ok(!argOf(verify, "--paths")!.includes("03-curto"), "Curto é warn-only (#3992)");
  });

  it("happy → stitch, merge e writer-pool quando há item", async () => {
    await preDispatch();
    const { deps, calls } = makeDeps({
      "pool-descriptions.ts": (args) => (args.includes("--input") ? ok(JSON.stringify({ input_path: "in.json", items: 4, skipped: [] })) : ok()),
    });
    const r = await runStage2(["--phase", "post-writers", "--edition", E], deps);
    assert.equal(r.code, 0);
    for (const s of ["stitch-newsletter", "validate-stage-2-outputs", "merge-social-md"]) {
      assert.ok(calls.some((c) => c.script.includes(s)), s);
    }
    assert.equal(r.pendingAgentDispatch[0]?.agent, "writer-pool");
    assert.ok(readRunState(dir)?.poolDispatchAt);
  });

  it("# Social duplicado → code 1", async () => {
    await preDispatch();
    const { deps } = makeDeps({ "lint-social-md.ts": () => fail(1, "", "2 headers") });
    const r = await runStage2(["--phase", "post-writers", "--edition", E], deps);
    assert.equal(r.code, 1);
  });
});

function seedWriterOutputs(): void {
  write("_internal/02-draft.md", "draft\n");
  write("03-social.md", "# Social\n\n## d1\n\nA\n\n## d2\n\nB\n\n## d3\n\nC\n");
}

describe("--phase post-pool", () => {
  it("lint gate-blocking → code 3, re-rodar post-writers", async () => {
    await preDispatch();
    seedWriterOutputs();
    const { deps } = makeDeps({
      "lint-newsletter-md.ts": () => fail(1, JSON.stringify({ passed: false, checks: [{ id: "destaque-min-chars", ok: false }] })),
    });
    const r = await runStage2(["--phase", "post-pool", "--edition", E], deps);
    assert.equal(r.code, 3);
    assert.equal(r.rerunPhase, "post-writers");
  });

  it("happy → os dois humanizadores na mesma mensagem + snapshot do social", async () => {
    await preDispatch();
    seedWriterOutputs();
    const { deps } = makeDeps({
      "lint-newsletter-md.ts": () => ok(JSON.stringify({ passed: true, checks: [] })),
      "normalize-newsletter.ts": () => {
        write("_internal/02-normalized.md", "normalized\n");
        return ok();
      },
    });
    const r = await runStage2(["--phase", "post-pool", "--edition", E], deps);
    assert.equal(r.code, 0);
    assert.equal(r.dispatchTogether, true);
    assert.equal(r.pendingAgentDispatch.length, 2);
    assert.ok(existsSync(join(dir, "_internal/03-social-pre-humanizador.md")));
  });
});

async function upToHumanize(): Promise<void> {
  await preDispatch();
  seedWriterOutputs();
  const { deps } = makeDeps({
    "lint-newsletter-md.ts": () => ok(JSON.stringify({ passed: true, checks: [] })),
    "normalize-newsletter.ts": () => {
      write("_internal/02-normalized.md", "normalized\n");
      return ok();
    },
  });
  assert.equal((await runStage2(["--phase", "post-pool", "--edition", E], deps)).code, 0);
}

function humanizeDone(): void {
  write("_internal/02-humanized.md", "humanized\n");
  write("03-social.md", "# Social\n\n## d1\n\nA2\n\n## d2\n\nB2\n\n## d3\n\nC2\n");
}

const happyChecks: Record<string, Handler> = {
  "resolve-clarice-input.ts": () => {
    write("_internal/02-clarice-input.txt", "02-humanized.md\n");
    return ok();
  },
  "lint-social-md.ts": () => ok(JSON.stringify({ passed: true, checks: [] })),
};

describe("--phase post-humanize", () => {
  it("humanizador no-op na newsletter → code 3, sem chamar a Clarice", async () => {
    await upToHumanize();
    write("_internal/02-humanized.md", "normalized\n");
    write("03-social.md", "# Social\n\n## d1\n\nA2\n");
    const { deps, calls } = makeDeps(happyChecks);
    const r = await runStage2(["--phase", "post-humanize", "--edition", E], deps);
    assert.equal(r.code, 3);
    assert.equal(r.rerunPhase, "post-humanize");
    assert.ok(!calls.some((c) => c.script.includes("clarice-correct")));
  });

  it("ping real falho + exit 6 → --deadline-ms 90000 e clarice-pending skip (#14029)", async () => {
    await upToHumanize();
    humanizeDone();
    write("_internal/preflight-state.json", JSON.stringify({ clariceRest: true, clariceRealProbe: false }));
    const { deps, calls } = makeDeps({
      ...happyChecks,
      "clarice-correct.ts": () => fail(6, JSON.stringify({ failure: { kind: "deadline", message: "90s" } })),
      "clarice-pending.ts": (args) => {
        if (args[0] === "skip") write("02-reviewed.md", "humanized\n");
        return ok();
      },
    });
    const r = await runStage2(["--phase", "post-humanize", "--edition", E], deps);
    const clariceCalls = calls.filter((c) => c.script.includes("clarice-correct"));
    assert.equal(clariceCalls.length, 2, "newsletter e social, em série");
    assert.equal(argOf(clariceCalls[0], "--deadline-ms"), "90000");
    assert.equal(argOf(clariceCalls[1], "--deadline-ms"), "90000");
    const skip = calls.find((c) => c.script.includes("clarice-pending") && c.args[0] === "skip");
    assert.equal(argOf(skip, "--reason"), "clarice_unavailable");
    assert.equal(r.clarice?.newsletter, "unavailable-skipped");
    assert.equal(r.clarice?.social, "unavailable-skipped");
    assert.ok(r.gateNotes.some((n) => /clarice-pending\.ts resume/.test(n)));
    assert.equal(r.code, 0);
  });

  it("ping real ok → teto normal de 480 s", async () => {
    await upToHumanize();
    humanizeDone();
    write("_internal/preflight-state.json", JSON.stringify({ clariceRest: true, clariceRealProbe: true }));
    const { deps, calls } = makeDeps({ ...happyChecks, "clarice-correct.ts": () => fail(6) });
    await runStage2(["--phase", "post-humanize", "--edition", E], deps);
    const first = calls.find((c) => c.script.includes("clarice-correct"));
    assert.equal(argOf(first, "--deadline-ms"), "480000");
  });

  it("Clarice exit 3 → code 2 (halt)", async () => {
    await upToHumanize();
    humanizeDone();
    const { deps } = makeDeps({ ...happyChecks, "clarice-correct.ts": () => fail(3, JSON.stringify({ failure: { kind: "http", message: "401" } })) });
    const r = await runStage2(["--phase", "post-humanize", "--edition", E], deps);
    assert.equal(r.code, 2);
    assert.match(r.haltRequired!.reason, /401/);
  });

  it("Clarice ok → 02-reviewed.md = texto corrigido; social aplicado com cabeçalhos", async () => {
    await upToHumanize();
    humanizeDone();
    const { deps, calls } = makeDeps({
      ...happyChecks,
      "clarice-correct.ts": (args) => {
        const out = argOf({ script: "", args }, "--corrected-out")!;
        writeFileSync(out, out.includes("02-") ? "corrigido\n" : "# Social\n\n## d1\n\nA3\n\n## d2\n\nB3\n\n## d3\n\nC3\n", "utf8");
        return ok();
      },
    });
    const r = await runStage2(["--phase", "post-humanize", "--edition", E], deps);
    assert.equal(r.code, 0);
    assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "corrigido\n");
    assert.match(readFileSync(join(dir, "03-social.md"), "utf8"), /A3/);
    assert.equal(r.clarice?.social, "applied");
    assert.ok(calls.some((c) => c.script.includes("clarice-pending") && c.args[0] === "clear"));
    assert.equal(r.nextPhase, "post-gate");
  });
});

describe("--phase post-checks", () => {
  it("check-stage2-invariants exit 1 → code 3, re-rodar post-checks", async () => {
    await preDispatch();
    write("02-reviewed.md", "x\n");
    const { deps } = makeDeps({ ...happyChecks, "check-stage2-invariants.ts": () => fail(1, "", "humanizer-ran") });
    const r = await runStage2(["--phase", "post-checks", "--edition", E], deps);
    assert.equal(r.code, 3);
    assert.equal(r.rerunPhase, "post-checks");
  });

  it("plantio só com --no-gates", async () => {
    await preDispatch();
    write("02-reviewed.md", "x\n");
    const a = makeDeps(happyChecks);
    await runStage2(["--phase", "post-checks", "--edition", E], a.deps);
    assert.ok(!a.calls.some((c) => c.script.includes("plant-intentional-error")));
    const b = makeDeps(happyChecks);
    await runStage2(["--phase", "post-checks", "--edition", E, "--no-gates"], b.deps);
    assert.ok(b.calls.some((c) => c.script.includes("plant-intentional-error")));
  });
});

describe("--phase post-gate", () => {
  it("destaque com 3 títulos → title-picker; depois sentinel e limpeza dos snapshots", async () => {
    await preDispatch();
    write("02-reviewed.md", "x\n");
    for (const rel of STAGE2_SNAPSHOTS) write(rel, "snap\n");
    const first = makeDeps({ "lint-newsletter-md.ts": () => fail(1) });
    const r1 = await runStage2(["--phase", "post-gate", "--edition", E], first.deps);
    assert.equal(r1.code, 0);
    assert.equal(r1.pendingAgentDispatch[0]?.agent, "title-picker");
    assert.ok(!first.calls.some((c) => c.script.includes("pipeline-sentinel")));

    const second = makeDeps();
    const r2 = await runStage2(["--phase", "post-gate", "--edition", E, "--after-title-picker"], second.deps);
    assert.equal(r2.code, 0);
    const w = second.calls.find((c) => c.script.includes("pipeline-sentinel"));
    assert.equal(w?.args[0], "write");
    for (const rel of STAGE2_SNAPSHOTS) assert.ok(!existsSync(join(dir, rel)), `${rel} removido depois do sentinel`);
  });

  it("sentinel recusado por invariante → code 3 e snapshots preservados", async () => {
    await preDispatch();
    write("02-reviewed.md", "x\n");
    write("_internal/02-pre-title-picker.md", "x\n");
    write("_internal/02-humanized.md", "h\n");
    const { deps } = makeDeps({ "pipeline-sentinel.ts": () => fail(1, "", "humanizer-ran") });
    const r = await runStage2(["--phase", "post-gate", "--edition", E, "--after-title-picker"], deps);
    assert.equal(r.code, 3);
    assert.ok(existsSync(join(dir, "_internal/02-humanized.md")));
  });

  it("selo do social com hash divergente (editor editou no gate) → regrava com bypass", async () => {
    await preDispatch();
    write("02-reviewed.md", "x\n");
    write("_internal/02-pre-title-picker.md", "x\n");
    let n = 0;
    const { deps, calls } = makeDeps({ "check-humanizer-social.ts": () => (n++ === 0 ? fail(3) : ok()) });
    await runStage2(["--phase", "post-gate", "--edition", E, "--after-title-picker"], deps);
    const bypass = calls.find((c) => c.script.includes("check-humanizer-social") && c.args.includes("--bypass-reason"));
    assert.ok(bypass);
  });
});
