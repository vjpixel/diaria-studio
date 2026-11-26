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
  planSocialClarice,
  readRunState,
  CLARICE_PHASE_BUDGET_MS,
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

  it("o reason degradado fala da newsletter e não promete skip no social (#14084)", () => {
    const { reason } = resolveClariceStage2DeadlineMs({ clariceRealProbe: false });
    assert.match(reason, /newsletter/);
    assert.match(reason, /social mantém o teto normal/);
    assert.doesNotMatch(reason, /social[^.]*skip/);
  });

  it("estado ilegível → teto normal com stateError e reason verdadeiro", () => {
    const d = resolveClariceStage2DeadlineMs({ clariceRealProbe: null }, "JSON inválido em x");
    assert.equal(d.deadlineMs, 480_000);
    assert.equal(d.stateError, "JSON inválido em x");
    assert.match(d.reason, /ilegível/);
  });

  it("o teto normal é o mesmo do clarice-correct.ts", () => {
    assert.equal(CLARICE_NORMAL_DEADLINE_MS, CLARICE_TOTAL_DEADLINE_MS);
  });

  it("o social roda na mesma chamada só com o teto inteiro; senão, chamada própria (#14093)", () => {
    assert.deepEqual(planSocialClarice(480_000, 10_000), { mode: "inline", deadlineMs: 480_000 });
    assert.deepEqual(planSocialClarice(480_000, CLARICE_PHASE_BUDGET_MS - 480_000), { mode: "inline", deadlineMs: 480_000 });
    assert.deepEqual(planSocialClarice(480_000, 90_000), { mode: "own-call", remainingMs: 450_000 });
    assert.deepEqual(planSocialClarice(480_000, 450_000), { mode: "own-call", remainingMs: 90_000 });
    assert.deepEqual(planSocialClarice(480_000, -5), { mode: "inline", deadlineMs: 480_000 }, "relógio que volta não dá teto maior");
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

  it("Curto ausente: 1ª vez re-dispatch (code 3), 2ª vez aviso no gate (#14084)", async () => {
    await preDispatch();
    const curtoFails: Handler = (args) => (args.includes("social-curto") ? fail(1, "", "03-curto.tmp.md missing") : ok());
    const first = makeDeps({ "verify-agent-outputs.ts": curtoFails });
    const r1 = await runStage2(["--phase", "post-writers", "--edition", E], first.deps);
    assert.equal(r1.code, 3);
    assert.match(r1.fixes[0].action, /social-curto/);
    assert.equal(r1.pendingAgentDispatch[0]?.agent, "social-curto", "o fix traz o dispatch gravado no pre-dispatch");
    assert.ok(r1.pendingAgentDispatch[0]?.params.approved_json_path);
    const second = makeDeps({ "verify-agent-outputs.ts": curtoFails });
    const r2 = await runStage2(["--phase", "post-writers", "--edition", E], second.deps);
    assert.equal(r2.code, 0);
    assert.ok(r2.gateNotes.some((n) => /Curto ausente/.test(n)));
    assert.ok(readRunState(dir)?.curtoWarn);
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
    assert.equal(r.rerunPhase, "post-pool");
    assert.deepEqual(r.rerunArgs, ["--restitch"]);
  });

  it("--restitch refaz stitch e reaplica o pool sem novo writer-pool nem post-writers", async () => {
    await preDispatch();
    const pw = makeDeps({
      "pool-descriptions.ts": (args) => (args.includes("--input") ? ok(JSON.stringify({ input_path: "in.json", items: 2 })) : ok()),
    });
    assert.equal((await runStage2(["--phase", "post-writers", "--edition", E], pw.deps)).code, 0);
    seedWriterOutputs();
    write("_internal/02-pool-descriptions.json", "{}");
    const lintFail = makeDeps({ "lint-newsletter-md.ts": () => fail(1, JSON.stringify({ passed: false, checks: [{ id: "x", ok: false }] })) });
    assert.equal((await runStage2(["--phase", "post-pool", "--edition", E], lintFail.deps)).code, 3);

    const { deps, calls } = makeDeps({
      "lint-newsletter-md.ts": () => ok(JSON.stringify({ passed: true, checks: [] })),
      "normalize-newsletter.ts": () => {
        write("_internal/02-normalized.md", "normalized\n");
        return ok();
      },
    });
    const r = await runStage2(["--phase", "post-pool", "--edition", E, "--restitch"], deps);
    assert.equal(r.code, 0);
    assert.ok(calls.some((c) => c.script.includes("stitch-newsletter")));
    assert.ok(calls.some((c) => c.script.includes("pool-descriptions") && c.args.includes("--apply")));
    assert.ok(!calls.some((c) => c.script.includes("verify-agent-outputs")));
    assert.ok(!calls.some((c) => c.script.includes("merge-social-md")), "post-writers não roda de novo");
    assert.ok(!r.pendingAgentDispatch.some((d) => d.agent === "writer-pool"));
  });

  it("--scope explícito vence o escopo gravado; sem --scope herda", async () => {
    const pre = makeDeps();
    await runStage2(["--phase", "pre-dispatch", "--edition", E, "--scope", "newsletter"], pre.deps);
    const inherit = makeDeps();
    const a = await runStage2(["--phase", "post-writers", "--edition", E], inherit.deps);
    assert.equal(a.scope, "newsletter");
    assert.ok(!inherit.calls.some((c) => c.script.includes("merge-social-md")));
    write("_internal/03-social.tmp.md", "x");
    const explicit = makeDeps();
    const b = await runStage2(["--phase", "post-writers", "--edition", E, "--scope", "all"], explicit.deps);
    assert.equal(b.scope, "all");
    assert.ok(explicit.calls.some((c) => c.script.includes("merge-social-md")));
  });

  it("happy → os dois humanizadores na mesma mensagem + snapshot do social", async () => {
    await preDispatch();
    seedWriterOutputs();
    const st0 = readRunState(dir)!;
    writeFileSync(
      join(dir, "_internal", "02-stage2-run-state.json"),
      JSON.stringify({ ...st0, clariceDone: { newsletter: "applied" }, postChecksDone: true, clariceWarns: ["velho"] }),
    );
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
    const st = readRunState(dir)!;
    assert.equal(st.clariceDone, undefined, "post-pool limpa clariceDone");
    assert.equal(st.postChecksDone, false);
    assert.deepEqual(st.clariceWarns, []);
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

  const writeCorrected: Handler = (args) => {
    const out = argOf({ script: "", args }, "--corrected-out")!;
    writeFileSync(out, out.includes("02-") ? "corrigido\n" : "# Social\n\n## d1\n\nA3\n\n## d2\n\nB3\n\n## d3\n\nC3\n", "utf8");
    return ok();
  };
  const isSocial = (args: string[]): boolean => (argOf({ script: "", args }, "--in") ?? "").endsWith("03-social.md");

  it("ping real falho + exit 6 na newsletter → --deadline-ms 90000 e clarice-pending skip (#14029)", async () => {
    await upToHumanize();
    humanizeDone();
    write("_internal/preflight-state.json", JSON.stringify({ clariceRest: true, clariceRealProbe: false }));
    const { deps, calls } = makeDeps({
      ...happyChecks,
      "clarice-correct.ts": (args) => (isSocial(args) ? writeCorrected(args) : fail(6, JSON.stringify({ failure: { kind: "deadline", message: "90s" } }))),
      "clarice-pending.ts": (args) => {
        if (args[0] === "skip") write("02-reviewed.md", "humanized\n");
        return ok();
      },
    });
    const r = await runStage2(["--phase", "post-humanize", "--edition", E], deps);
    const clariceCalls = calls.filter((c) => c.script.includes("clarice-correct"));
    assert.equal(clariceCalls.length, 2, "newsletter e social, em série");
    assert.equal(argOf(clariceCalls[0], "--deadline-ms"), "90000");
    assert.ok(Number(argOf(clariceCalls[1], "--deadline-ms")) > 90_000, "o social não herda o teto degradado da newsletter (#14084)");
    assert.equal(r.nextPhase, "post-checks", "a fase termina depois da prova do social (#14084)");
    assert.ok(!calls.some((c) => c.script.includes("check-stage2-invariants")), "post-checks é outra chamada");
    const skip = calls.find((c) => c.script.includes("clarice-pending") && c.args[0] === "skip");
    assert.equal(argOf(skip, "--reason"), "clarice_unavailable");
    assert.equal(r.clarice?.newsletter, "unavailable-skipped");
    assert.equal(r.clarice?.social, "applied");
    assert.ok(r.gateNotes.some((n) => /clarice-pending\.ts resume/.test(n)));
    assert.equal(r.code, 0);
  });

  it("Clarice do social com exit 6 → halt (code 2), nunca skip silencioso; retomada só do social", async () => {
    await upToHumanize();
    humanizeDone();
    const first = makeDeps({
      ...happyChecks,
      "clarice-correct.ts": (args) => (isSocial(args) ? fail(6) : writeCorrected(args)),
    });
    const r = await runStage2(["--phase", "post-humanize", "--edition", E], first.deps);
    assert.equal(r.code, 2);
    assert.match(r.haltRequired!.reason, /social.*clarice_unavailable/);
    assert.match(r.haltRequired!.action, /--social-clarice-only/);
    assert.ok(!first.calls.some((c) => c.script.includes("check-humanizer-social")), "sem prova de Clarice gravada");

    assert.equal(readRunState(dir)?.clariceDone?.newsletter, "applied", "a newsletter fica registrada mesmo com o halt do social");
    const retry = makeDeps({ ...happyChecks, "clarice-correct.ts": writeCorrected });
    const r2 = await runStage2(["--phase", "post-humanize", "--edition", E, "--social-clarice-only", "--deadline-ms", "300000"], retry.deps);
    assert.equal(r2.code, 0);
    const clariceCalls = retry.calls.filter((c) => c.script.includes("clarice-correct"));
    assert.equal(clariceCalls.length, 1, "a newsletter não roda de novo");
    assert.ok(isSocial(clariceCalls[0].args));
    assert.equal(argOf(clariceCalls[0], "--deadline-ms"), "300000", "override do teto na retomada");
    assert.equal(r2.clarice?.social, "applied");
  });

  it("retomada do social com ping real falho usa o teto normal, não 90 s (#14084 P1)", async () => {
    await upToHumanize();
    humanizeDone();
    write("_internal/preflight-state.json", JSON.stringify({ clariceRealProbe: false }));
    const { deps, calls } = makeDeps({ ...happyChecks, "clarice-correct.ts": writeCorrected });
    await runStage2(["--phase", "post-humanize", "--edition", E, "--social-clarice-only"], deps);
    assert.equal(argOf(calls.find((c) => c.script.includes("clarice-correct")), "--deadline-ms"), "480000");
  });

  it("--deadline-ms acima de 540000 → code 1 (#14084)", async () => {
    const { deps } = makeDeps();
    const r = await runStage2(["--phase", "post-humanize", "--edition", E, "--social-clarice-only", "--deadline-ms", "600000"], deps);
    assert.equal(r.code, 1);
  });

  it("--deadline-ms sem --social-clarice-only → code 1", async () => {
    const { deps } = makeDeps();
    const r = await runStage2(["--phase", "post-humanize", "--edition", E, "--deadline-ms", "1000"], deps);
    assert.equal(r.code, 1);
  });

  it("preflight-state.json corrompido → teto normal com aviso no gate e log (#14084)", async () => {
    await upToHumanize();
    humanizeDone();
    write("_internal/preflight-state.json", "{corrompido");
    const { deps, calls } = makeDeps({ ...happyChecks, "clarice-correct.ts": writeCorrected });
    const r = await runStage2(["--phase", "post-humanize", "--edition", E], deps);
    assert.ok(r.clarice?.stateError);
    assert.ok(r.gateNotes.some((n) => /ilegível/.test(n)));
    assert.ok(calls.some((c) => c.script.includes("log-event") && c.args.join(" ").includes("preflight-state ilegível")));
    assert.equal(argOf(calls.find((c) => c.script.includes("clarice-correct")), "--deadline-ms"), "480000");
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
    assert.equal(r.nextPhase, "post-checks");
    assert.deepEqual(readRunState(dir)?.clariceDone, { newsletter: "applied", social: "applied" });
  });
});

function isSocialArg(args: string[]): boolean {
  return (argOf({ script: "", args }, "--in") ?? "").endsWith("03-social.md");
}
function writeCorrectedSocial(args: string[]): StepResult {
  writeFileSync(argOf({ script: "", args }, "--corrected-out")!, "# Social\n\n## d1\n\nA3\n\n## d2\n\nB3\n\n## d3\n\nC3\n", "utf8");
  return ok();
}

function markClariceDone(): void {
  const st = readRunState(dir)!;
  writeFileSync(join(dir, "_internal", "02-stage2-run-state.json"), JSON.stringify({ ...st, clariceDone: { newsletter: "applied", social: "applied" } }));
}

describe("--phase post-humanize — orçamento da Clarice do social (#14093)", () => {
  const writeCorrectedB: Handler = (args) => {
    const out = argOf({ script: "", args }, "--corrected-out")!;
    writeFileSync(out, out.includes("02-") ? "corrigido\n" : "# Social\n\n## d1\n\nA3\n\n## d2\n\nB3\n\n## d3\n\nC3\n", "utf8");
    return ok();
  };
  const isSocialB = (args: string[]): boolean => (argOf({ script: "", args }, "--in") ?? "").endsWith("03-social.md");

  /** Relógio injetado: a Clarice da newsletter "leva" `newsletterMs` sem esperar de verdade. */
  function clockedDeps(newsletterMs: number, handlers: Record<string, Handler>): ReturnType<typeof makeDeps> {
    let t = Date.UTC(2026, 10, 26, 3, 0, 0);
    const clarice = handlers["clarice-correct.ts"];
    const made = makeDeps({
      ...handlers,
      "clarice-correct.ts": (args) => {
        if (!isSocialB(args)) t += newsletterMs;
        return clarice(args);
      },
    });
    made.deps.now = () => new Date(t);
    return made;
  }
  const clariceCalls = (calls: Call[]): Call[] => calls.filter((c) => c.script.includes("clarice-correct"));

  it("dia rápido (newsletter em 30 s): as duas Clarices na mesma chamada, social com 480 s", async () => {
    await upToHumanize();
    humanizeDone();
    const { deps, calls } = clockedDeps(30_000, { ...happyChecks, "clarice-correct.ts": writeCorrectedB });
    const r = await runStage2(["--phase", "post-humanize", "--edition", E], deps);
    assert.equal(r.code, 0);
    assert.equal(r.nextPhase, "post-checks");
    const cc = clariceCalls(calls);
    assert.equal(cc.length, 2);
    assert.equal(argOf(cc[1], "--deadline-ms"), "480000");
    assert.equal(r.clarice?.social, "applied");
  });

  it("dia lento (newsletter em 450 s): social NÃO roda com a sobra de 90 s; vai para chamada própria com 480 s", async () => {
    await upToHumanize();
    humanizeDone();
    const first = clockedDeps(450_000, { ...happyChecks, "clarice-correct.ts": writeCorrectedB });
    const r = await runStage2(["--phase", "post-humanize", "--edition", E], first.deps);
    assert.equal(r.code, 3, "nem halt nem sucesso: re-rodar só o social");
    assert.equal(r.rerunPhase, "post-humanize");
    assert.deepEqual(r.rerunArgs, ["--social-clarice-only"]);
    assert.ok(r.fixes.some((f) => f.check === "clarice-social-own-call"));
    assert.equal(r.haltRequired, undefined);
    assert.equal(clariceCalls(first.calls).length, 1, "só a newsletter nesta chamada");
    assert.ok(!first.calls.some((c) => c.script.includes("check-humanizer-social")), "o social ainda não tem prova de Clarice");
    assert.equal(readRunState(dir)?.clariceDone?.newsletter, "applied");
    assert.equal(readRunState(dir)?.clariceDone?.social, undefined);

    const second = clockedDeps(0, { ...happyChecks, "clarice-correct.ts": writeCorrectedB });
    const r2 = await runStage2(["--phase", "post-humanize", "--edition", E, ...r.rerunArgs!], second.deps);
    assert.equal(r2.code, 0);
    assert.equal(r2.nextPhase, "post-checks");
    const cc = clariceCalls(second.calls);
    assert.equal(cc.length, 1);
    assert.ok(isSocialB(cc[0].args));
    assert.equal(argOf(cc[0], "--deadline-ms"), "480000", "teto inteiro, não a sobra");
    assert.equal(readRunState(dir)?.clariceDone?.newsletter, "applied");
    assert.equal(readRunState(dir)?.clariceDone?.social, "applied");
  });

  it("dia degradado: newsletter pulada em 90 s, social em chamada própria; se falhar, halt que cita o ping (nunca skip)", async () => {
    await upToHumanize();
    humanizeDone();
    write("_internal/preflight-state.json", JSON.stringify({ clariceRealProbe: false }));
    const pending: Handler = (args) => {
      if (args[0] === "skip") write("02-reviewed.md", "humanized\n");
      return ok();
    };
    const first = clockedDeps(90_000, {
      ...happyChecks,
      "clarice-correct.ts": (args) => (isSocialB(args) ? writeCorrectedB(args) : fail(6)),
      "clarice-pending.ts": pending,
    });
    const r = await runStage2(["--phase", "post-humanize", "--edition", E], first.deps);
    assert.equal(r.code, 3);
    assert.deepEqual(r.rerunArgs, ["--social-clarice-only"]);
    assert.equal(r.clarice?.newsletter, "unavailable-skipped");
    assert.ok((readRunState(dir)?.clariceWarns ?? []).some((n) => /clarice-pending\.ts resume/.test(n)), "o aviso do resume fica no estado");

    const second = clockedDeps(0, { ...happyChecks, "clarice-correct.ts": () => fail(6), "clarice-pending.ts": pending });
    const r2 = await runStage2(["--phase", "post-humanize", "--edition", E, "--social-clarice-only"], second.deps);
    assert.equal(r2.code, 2);
    assert.match(r2.haltRequired!.reason, /clarice_unavailable.*ping real/);
    assert.ok(!second.calls.some((c) => c.script.includes("clarice-pending") && c.args[0] === "skip"), "o social nunca vira skip");
  });
});

describe("--phase post-checks", () => {
  it("sem as Clarices registradas pelo post-humanize → code 1", async () => {
    await preDispatch();
    const { deps } = makeDeps(happyChecks);
    const r = await runStage2(["--phase", "post-checks", "--edition", E], deps);
    assert.equal(r.code, 1);
  });

  it("--no-gates do pre-dispatch vale no re-run sem a flag (#14084)", async () => {
    const pre = makeDeps();
    await runStage2(["--phase", "pre-dispatch", "--edition", E, "--no-gates"], pre.deps);
    markClariceDone();
    write("02-reviewed.md", "x\n");
    const { deps, calls } = makeDeps(happyChecks);
    await runStage2(["--phase", "post-checks", "--edition", E], deps);
    assert.ok(calls.some((c) => c.script.includes("plant-intentional-error")));
  });

  it("check-stage2-invariants exit 1 → code 3, re-rodar post-checks", async () => {
    await preDispatch();
    markClariceDone();
    write("02-reviewed.md", "x\n");
    const { deps } = makeDeps({ ...happyChecks, "check-stage2-invariants.ts": () => fail(1, "", "humanizer-ran") });
    const r = await runStage2(["--phase", "post-checks", "--edition", E], deps);
    assert.equal(r.code, 3);
    assert.equal(r.rerunPhase, "post-checks");
  });

  it("avisos da Clarice do post-humanize voltam no gate do post-checks; postChecksDone gravado (#14084)", async () => {
    await upToHumanize();
    humanizeDone();
    write("_internal/preflight-state.json", JSON.stringify({ clariceRealProbe: false }));
    const ph = makeDeps({
      ...happyChecks,
      "clarice-correct.ts": (args) => (isSocialArg(args) ? writeCorrectedSocial(args) : fail(6)),
      "clarice-pending.ts": (args) => {
        if (args[0] === "skip") write("02-reviewed.md", "humanized\n");
        return ok();
      },
    });
    assert.equal((await runStage2(["--phase", "post-humanize", "--edition", E], ph.deps)).code, 0);
    const { deps } = makeDeps(happyChecks);
    const r = await runStage2(["--phase", "post-checks", "--edition", E], deps);
    assert.equal(r.code, 0);
    assert.ok(r.gateNotes.some((n) => /clarice-pending\.ts resume/.test(n)), "linha de resume no gate");
    assert.ok(r.gateNotes.some((n) => /90 s/.test(n)), "modo degradado no gate");
    assert.equal(readRunState(dir)?.postChecksDone, true);
  });

  it("plantio só com --no-gates", async () => {
    await preDispatch();
    markClariceDone();
    write("02-reviewed.md", "x\n");
    const a = makeDeps(happyChecks);
    await runStage2(["--phase", "post-checks", "--edition", E], a.deps);
    assert.ok(!a.calls.some((c) => c.script.includes("plant-intentional-error")));
    const b = makeDeps(happyChecks);
    await runStage2(["--phase", "post-checks", "--edition", E, "--no-gates"], b.deps);
    assert.ok(b.calls.some((c) => c.script.includes("plant-intentional-error")));
  });
});

function markChecksDone(): void {
  const st = readRunState(dir)!;
  writeFileSync(join(dir, "_internal", "02-stage2-run-state.json"), JSON.stringify({ ...st, postChecksDone: true }));
}

describe("--phase post-gate", () => {
  it("sem post-checks que passou → code 1 (#14084)", async () => {
    await preDispatch();
    write("02-reviewed.md", "x\n");
    const { deps, calls } = makeDeps();
    const r = await runStage2(["--phase", "post-gate", "--edition", E], deps);
    assert.equal(r.code, 1);
    assert.ok(!calls.some((c) => c.script.includes("pipeline-sentinel")));
  });

  it("destaque com 3 títulos → title-picker; depois sentinel e limpeza dos snapshots", async () => {
    await preDispatch();
    markChecksDone();
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

  it("intentional-error.json incompleto: interativo para antes do sentinel; --no-gates segue (#14084)", async () => {
    await preDispatch();
    markChecksDone();
    write("02-reviewed.md", "x\n");
    write("_internal/02-pre-title-picker.md", "x\n");
    const a = makeDeps({ "validate-frontmatter-yaml.ts": () => fail(1, "", "{PREENCHER}") });
    const r = await runStage2(["--phase", "post-gate", "--edition", E, "--after-title-picker"], a.deps);
    assert.equal(r.code, 3);
    assert.deepEqual(r.rerunArgs, ["--after-title-picker"]);
    assert.ok(!a.calls.some((c) => c.script.includes("pipeline-sentinel")));
    const b = makeDeps({ "validate-frontmatter-yaml.ts": () => fail(1, "", "{PREENCHER}") });
    const r2 = await runStage2(["--phase", "post-gate", "--edition", E, "--after-title-picker", "--no-gates"], b.deps);
    assert.equal(r2.code, 0);
    assert.ok(b.calls.some((c) => c.script.includes("pipeline-sentinel")));
  });

  it("sentinel recusado por invariante → code 3 e snapshots preservados", async () => {
    await preDispatch();
    markChecksDone();
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
    markChecksDone();
    write("02-reviewed.md", "x\n");
    write("_internal/02-pre-title-picker.md", "x\n");
    let n = 0;
    const { deps, calls } = makeDeps({ "check-humanizer-social.ts": () => (n++ === 0 ? fail(3) : ok()) });
    await runStage2(["--phase", "post-gate", "--edition", E, "--after-title-picker"], deps);
    const bypass = calls.find((c) => c.script.includes("check-humanizer-social") && c.args.includes("--bypass-reason"));
    assert.ok(bypass);
  });
});
