/**
 * test/stage4-compound-14116.test.ts (#14116)
 *
 * Comandos compostos da Etapa 4: `stage4-factcheck-post.ts` (item 1) e
 * `stage4-social-reseal.ts` (item 2). Tudo com deps injetadas: nenhum spawn
 * real, nenhum fact-checker, humanizador ou Clarice de verdade.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runFactCheckPost,
  classifyCheckBlocking,
  OUTCOME_EXIT,
  SOCIAL_POST_AUTOFIX_LINTS,
  type FactCheckPostDeps,
} from "../scripts/stage4-factcheck-post.ts";
import {
  runPrepare,
  runAfterHumanizer,
  runSeal,
  main as resealMain,
  PRE_SNAPSHOT,
  POST_HUMANIZER_SNAPSHOT,
  STAGE2_PRE_HUMANIZER,
  CLARICE_NO_SUGGESTIONS_NOTE,
  type ResealDeps,
} from "../scripts/stage4-social-reseal.ts";
import type { StepResult } from "../scripts/stage-0-run.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ED = "/ed/261126";

type Call = { script: string; args: string[] };
type Responder = (script: string, args: string[]) => Partial<StepResult> | undefined;

function fakeExec(responder: Responder) {
  const calls: Call[] = [];
  const exec = (script: string, args: string[]): StepResult => {
    calls.push({ script, args });
    const r = responder(script, args) ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}

const isLint = (c: Call, check: string) => c.script.endsWith("lint-social-md.ts") && c.args[1] === check;

// ---------------------------------------------------------------------------
// fact-check
// ---------------------------------------------------------------------------

function fcDeps(responder: Responder, autofixJson?: unknown) {
  const { exec, calls } = fakeExec(responder);
  const copies: Array<[string, string]> = [];
  const deps: FactCheckPostDeps = {
    exec,
    readText: (p) =>
      p.endsWith("fact-check-autofix.json") && autofixJson !== undefined ? JSON.stringify(autofixJson) : undefined,
    copyFile: (a, b) => copies.push([a, b]),
  };
  return { deps, calls, copies };
}

describe("#14116 stage4-factcheck-post", () => {
  it("caminho limpo: check-blocking 0, autofix sem nada aplicado, sem re-checagens", () => {
    const { deps, calls } = fcDeps(
      (s) => (s.endsWith("run-fact-checker.ts") ? { stdout: "━━━ FACT-CHECK\n  ok" } : undefined),
      { summary: { applied: 0 }, social_modified: false, entries: [] },
    );
    const r = runFactCheckPost({ editionDir: ED }, deps);
    assert.equal(r.outcome, "ok");
    assert.equal(r.exit, 0);
    assert.equal(r.fact_check.summary, "━━━ FACT-CHECK\n  ok");
    assert.deepEqual(r.rerender, { newsletter: false, social: false });
    assert.deepEqual(calls.map((c) => c.script), ["scripts/run-fact-checker.ts", "scripts/apply-factcheck-autofix.ts"]);
    assert.deepEqual(calls[0].args, ["--edition-dir", ED, "--input-json", join(ED, "_internal", "fact-check.json"), "--check-blocking"]);
  });

  it("merge-partial usa o JSON parcial por default e repassa a flag", () => {
    const { deps, calls } = fcDeps(() => undefined, { summary: { applied: 0 } });
    runFactCheckPost({ editionDir: ED, mergePartial: true }, deps);
    assert.deepEqual(calls[0].args, [
      "--edition-dir", ED, "--input-json", join(ED, "_internal", "fact-check.partial.json"), "--merge-partial", "--check-blocking",
    ]);
  });

  it("--copy-from copia o JSON do scratchpad para a entrada antes do check (#5083)", () => {
    const { deps, copies } = fcDeps(() => undefined, { summary: { applied: 0 } });
    const r = runFactCheckPost({ editionDir: ED, copyFrom: "/scratch/fc.json" }, deps);
    assert.deepEqual(copies, [["/scratch/fc.json", join(ED, "_internal", "fact-check.json")]]);
    assert.equal(r.copied_from, "/scratch/fc.json");
  });

  for (const [label, res, outcome] of [
    ["exit 2 → blocking", { code: 2, stderr: "GATE-BLOCKING" }, "blocking"],
    ["exit 1 DEFASADO → stale", { code: 1, stderr: "x\n[run-fact-checker] FACT-CHECK DEFASADO (#11685): 1 claim" }, "stale"],
    ["exit 1 merge recusado → partial-refused", { code: 1, stderr: "[run-fact-checker] --merge-partial recusado (#14035): x" }, "partial-refused"],
    ["exit 1 genérico → unavailable", { code: 1, stderr: "--input-json não encontrado" }, "unavailable"],
  ] as const) {
    it(`${label}, sem autofix`, () => {
      const { deps, calls } = fcDeps((s) => (s.endsWith("run-fact-checker.ts") ? res : undefined));
      const r = runFactCheckPost({ editionDir: ED }, deps);
      assert.equal(r.outcome, outcome);
      assert.equal(r.exit, OUTCOME_EXIT[outcome]);
      assert.equal(calls.length, 1, "nada roda depois de um check-blocking ≠ 0");
      assert.equal(r.autofix, undefined);
    });
  }

  it("classifyCheckBlocking dá prioridade ao exit 2 sobre marcadores no stderr", () => {
    assert.equal(classifyCheckBlocking({ code: 2, stdout: "", stderr: "FACT-CHECK DEFASADO (#11685)" }), "blocking");
  });

  it("autofix na newsletter e no social: re-render dos dois + callout + selo + 5 lints", () => {
    const { deps, calls } = fcDeps(() => undefined, {
      summary: { applied: 2 },
      social_modified: true,
      entries: [{ social_residual_sections: ["Curto/d1"] }, { social_residual_sections: ["Curto/d1", "d2"] }],
    });
    const r = runFactCheckPost({ editionDir: ED }, deps);
    assert.equal(r.exit, 0);
    assert.deepEqual(r.rerender, { newsletter: true, social: true });
    assert.deepEqual(r.autofix?.social_residual_sections, ["Curto/d1", "d2"]);
    assert.deepEqual(r.checks.map((c) => c.name), ["callout-placement", "humanizer-social-check", ...SOCIAL_POST_AUTOFIX_LINTS]);
    assert.ok(calls.some((c) => c.script.endsWith("check-humanizer-social.ts") && c.args[0] === "--check"));
  });

  it("lint estrutural quebrado pelo autofix → exit 5 com a saída do lint", () => {
    const { deps } = fcDeps(
      (s, a) => (s.endsWith("lint-social-md.ts") && a[1] === "no-antithesis-reveal" ? { code: 1, stderr: "linha 4: não é X, é Y" } : undefined),
      { summary: { applied: 1 }, social_modified: true },
    );
    const r = runFactCheckPost({ editionDir: ED }, deps);
    assert.equal(r.outcome, "post-autofix-broken");
    assert.equal(r.exit, 5);
    const bad = r.checks.find((c) => c.code !== 0);
    assert.equal(bad?.name, "no-antithesis-reveal");
    assert.match(bad?.output ?? "", /não é X/);
  });

  it("autofix com exit 1 não bloqueia: segue ok, sem re-checagens, stderr no relatório", () => {
    const { deps } = fcDeps((s) => (s.endsWith("apply-factcheck-autofix.ts") ? { code: 1, stderr: "boom" } : undefined));
    const r = runFactCheckPost({ editionDir: ED }, deps);
    assert.equal(r.exit, 0);
    assert.equal(r.autofix?.code, 1);
    assert.equal(r.autofix?.stderr, "boom");
    assert.deepEqual(r.checks, []);
  });

  for (const [label, json] of [
    ["ausente", undefined],
    ["ilegível", "{não é json"],
    ["sem summary.applied", { social_modified: false, entries: [] }],
  ] as const) {
    it(`regressão: autofix exit 0 com JSON ${label} → exit 7 e re-checagens nos DOIS arquivos (fail-closed)`, () => {
      const { exec, calls } = fakeExec(() => undefined);
      const deps: FactCheckPostDeps = {
        exec,
        readText: (p) =>
          p.endsWith("fact-check-autofix.json") && json !== undefined
            ? typeof json === "string" ? json : JSON.stringify(json)
            : undefined,
        copyFile: () => {},
      };
      const r = runFactCheckPost({ editionDir: ED }, deps);
      assert.equal(r.outcome, "autofix-unreadable");
      assert.equal(r.exit, 7);
      assert.notEqual(r.exit, 0);
      assert.ok(r.autofix?.unreadable, "motivo em autofix.unreadable");
      assert.deepEqual(r.rerender, { newsletter: true, social: true });
      assert.deepEqual(r.checks.map((c) => c.name), ["callout-placement", "humanizer-social-check", ...SOCIAL_POST_AUTOFIX_LINTS]);
      assert.ok(calls.some((c) => c.script.endsWith("lint-newsletter-md.ts")));
    });
  }

  it("JSON legível com applied 0 segue sendo o único 'nada aplicado' que pula re-render", () => {
    const { deps } = fcDeps(() => undefined, { summary: { applied: 0 }, social_modified: false });
    const r = runFactCheckPost({ editionDir: ED }, deps);
    assert.equal(r.exit, 0);
    assert.equal(r.autofix?.unreadable, undefined);
    assert.deepEqual(r.checks, []);
  });
});

// ---------------------------------------------------------------------------
// social reseal
// ---------------------------------------------------------------------------

function rsDeps(responder: Responder, existing: string[] = []) {
  const { exec, calls } = fakeExec(responder);
  const copies: Array<[string, string]> = [];
  const deps: ResealDeps = {
    exec,
    exists: (p) => existing.includes(p),
    copyFile: (a, b) => copies.push([a, b]),
  };
  return { deps, calls, copies };
}

describe("#14116 stage4-social-reseal prepare", () => {
  it("selo batendo: nada a fazer, sem snapshot", () => {
    const { deps, copies } = rsDeps(() => undefined);
    const r = runPrepare(ED, deps);
    assert.equal(r.state, "sealed");
    assert.equal(r.exit, 0);
    assert.deepEqual(copies, []);
  });

  it("hash diverge (scoped): lê changed_sections e grava o snapshot pré", () => {
    const { deps, copies } = rsDeps(() => ({
      code: 2,
      stdout: JSON.stringify({ ok: false, reason: "hash_mismatch", legacy: false, changed_sections: ["main_d1", "main_d1-cards"] }),
      stderr: "FAIL",
    }));
    const r = runPrepare(ED, deps);
    assert.equal(r.state, "changed");
    assert.equal(r.flow, "scoped");
    assert.deepEqual(r.changed_sections, ["main_d1", "main_d1-cards"]);
    assert.deepEqual(copies, [[join(ED, "03-social.md"), join(ED, PRE_SNAPSHOT)]]);
  });

  it("selo legacy → full-file; sentinel ausente → full-file", () => {
    const legacy = runPrepare(ED, rsDeps(() => ({ code: 2, stdout: JSON.stringify({ legacy: true, changed_sections: [] }) })).deps);
    assert.equal(legacy.flow, "full-file");
    const missing = runPrepare(ED, rsDeps(() => ({ code: 1, stderr: "[check-humanizer-social] FAIL — sentinel ausente: x" })).deps);
    assert.equal(missing.state, "sentinel-missing");
    assert.equal(missing.flow, "full-file");
    assert.equal(missing.exit, 0);
  });

  it("erro do check (exit 1 sem 'sentinel ausente') → exit 1, sem snapshot", () => {
    const { deps, copies } = rsDeps(() => ({ code: 1, stderr: "ERRO no check: EACCES" }));
    const r = runPrepare(ED, deps);
    assert.equal(r.state, "error");
    assert.equal(r.exit, 1);
    assert.deepEqual(copies, []);
  });
});

describe("#14116 stage4-social-reseal after-humanizer", () => {
  it("scoped: lint de abertura, snapshot pós, record-run com --sections/--note, verify com --note", () => {
    const { deps, calls, copies } = rsDeps((s) =>
      s.endsWith("verify-scoped-humanization.ts") ? { stdout: JSON.stringify({ untouchedTargets: [], unexpectedChanges: [] }) } : undefined,
    );
    const r = runAfterHumanizer(ED, { sections: ["main_d1"], note: "humanizador sem mudanças" }, deps);
    assert.equal(r.exit, 0);
    assert.deepEqual(copies, [[join(ED, "03-social.md"), join(ED, POST_HUMANIZER_SNAPSHOT)]]);
    assert.ok(isLint(calls[0], "no-unanchored-opening"));
    assert.deepEqual(calls[1].args, [
      "--record-run", "--step", "humanizador",
      "--pre", join(ED, PRE_SNAPSHOT), "--post", join(ED, POST_HUMANIZER_SNAPSHOT),
      "--sections", "main_d1", "--note", "humanizador sem mudanças", "--edition-dir", ED,
    ]);
    assert.deepEqual(calls[2].args, [
      "--pre", join(ED, PRE_SNAPSHOT), "--post", join(ED, POST_HUMANIZER_SNAPSHOT), "--sections", "main_d1", "--note", "humanizador sem mudanças",
    ]);
  });

  it("full-file: sem --sections e sem verify", () => {
    const { deps, calls } = rsDeps(() => undefined);
    const r = runAfterHumanizer(ED, { sections: [] }, deps);
    assert.equal(r.exit, 0);
    assert.equal(calls.length, 2);
    assert.ok(!calls[1].args.includes("--sections"));
  });

  it("record-run recusado → exit 2, sem verify", () => {
    const { deps, calls } = rsDeps((s, a) => (a[0] === "--record-run" ? { code: 1, stderr: "recusado" } : undefined));
    const r = runAfterHumanizer(ED, { sections: ["main_d2"] }, deps);
    assert.equal(r.exit, 2);
    assert.ok(!calls.some((c) => c.script.endsWith("verify-scoped-humanization.ts")));
  });

  it("verify com untouchedTargets → exit 3; só unexpectedChanges → exit 0 com scope_warning", () => {
    const untouched = runAfterHumanizer(ED, { sections: ["main_d2"] }, rsDeps((s) =>
      s.endsWith("verify-scoped-humanization.ts") ? { code: 1, stdout: JSON.stringify({ untouchedTargets: ["main_d2"], unexpectedChanges: [] }) } : undefined,
    ).deps);
    assert.equal(untouched.exit, 3);
    assert.deepEqual(untouched.untouched_targets, ["main_d2"]);
    const extra = runAfterHumanizer(ED, { sections: ["main_d2"] }, rsDeps((s) =>
      s.endsWith("verify-scoped-humanization.ts") ? { code: 1, stdout: JSON.stringify({ untouchedTargets: [], unexpectedChanges: ["main_d3"] }) } : undefined,
    ).deps);
    assert.equal(extra.exit, 0);
    assert.deepEqual(extra.scope_warning, ["main_d3"]);
  });

  it("regressão: verify com erro de I/O (exit 1 sem veredito) → exit 7, nunca o exit 3 de 'rode o humanizador'", () => {
    const r = runAfterHumanizer(ED, { sections: ["main_d2"] }, rsDeps((s) =>
      s.endsWith("verify-scoped-humanization.ts")
        ? { code: 1, stderr: "[verify-scoped-humanization] ERRO: arquivo ausente — pre=false post=true" }
        : undefined,
    ).deps);
    assert.equal(r.exit, 7);
    assert.notEqual(r.exit, 3);
    assert.deepEqual(r.untouched_targets, []);
    assert.match(r.verify_error ?? "", /arquivo ausente/);
  });
});

describe("#14116 stage4-social-reseal seal", () => {
  const existing = [join(ED, STAGE2_PRE_HUMANIZER), join(ED, POST_HUMANIZER_SNAPSHOT)];

  it("caminho limpo: clarice → write → 7 lints → check final", () => {
    const { deps, calls } = rsDeps(() => undefined, existing);
    const r = runSeal(ED, { reason: "humanizador re-rodou (scoped: main_d1) após ajuste X no Stage 4", sections: ["main_d1"] }, deps);
    assert.equal(r.exit, 0);
    assert.deepEqual(calls[0].args, [
      "--record-run", "--step", "clarice", "--pre", join(ED, POST_HUMANIZER_SNAPSHOT), "--post", join(ED, "03-social.md"), "--edition-dir", ED,
    ]);
    assert.deepEqual(calls[1].args.slice(0, 3), ["--write", "--bypass-reason", "humanizador re-rodou (scoped: main_d1) após ajuste X no Stage 4"]);
    const lintCalls = calls.filter((c) => c.script.endsWith("lint-social-md.ts"));
    assert.equal(lintCalls.length, 7);
    const coverage = lintCalls.find((c) => c.args[1] === "humanizer-section-coverage");
    assert.deepEqual(coverage?.args, ["--check", "humanizer-section-coverage", "--pre", join(ED, STAGE2_PRE_HUMANIZER), "--md", join(ED, POST_HUMANIZER_SNAPSHOT)]);
    assert.deepEqual(calls[calls.length - 1].args, ["--check", "--edition-dir", ED]);
  });

  it("--clarice-no-suggestions passa a nota do #11674", () => {
    const { deps, calls } = rsDeps(() => undefined, existing);
    runSeal(ED, { reason: "r", sections: [], clariceNoSuggestions: true }, deps);
    assert.ok(calls[0].args.includes("--note"));
    assert.equal(calls[0].args[calls[0].args.indexOf("--note") + 1], CLARICE_NO_SUGGESTIONS_NOTE);
  });

  it("--clarice-pending usa --record-clarice-pending com --sections (#13848)", () => {
    const { deps, calls } = rsDeps(() => undefined, existing);
    runSeal(ED, { reason: "r", sections: ["main_d1"], claricePending: "exit 6 clarice_unavailable" }, deps);
    assert.deepEqual(calls[0].args, [
      "--record-clarice-pending", "--reason", "clarice_unavailable", "--detail", "exit 6 clarice_unavailable", "--sections", "main_d1", "--edition-dir", ED,
    ]);
  });

  it("registro da Clarice recusado → exit 2, nada de --write", () => {
    const { deps, calls } = rsDeps((s, a) => (a[0] === "--record-run" ? { code: 1, stderr: "pre e post iguais (#11674)" } : undefined), existing);
    const r = runSeal(ED, { reason: "r", sections: [] }, deps);
    assert.equal(r.exit, 2);
    assert.equal(calls.length, 1);
    assert.match(r.steps[0].output ?? "", /#11674/);
  });

  it("--write com exit 4 (seção sem prova) → exit 3, sem lints", () => {
    const { deps, calls } = rsDeps((s, a) => (a[0] === "--write" ? { code: 4, stderr: "main_d2 sem prova" } : undefined), existing);
    const r = runSeal(ED, { reason: "r", sections: [] }, deps);
    assert.equal(r.exit, 3);
    assert.equal(r.steps[1].code, 4);
    assert.ok(!calls.some((c) => c.script.endsWith("lint-social-md.ts")));
  });

  it("lint GATE-BLOCKING falhou → exit 4, sem check final; informativo só vira warning", () => {
    const blocking = rsDeps((s, a) => (s.endsWith("lint-social-md.ts") && a[1] === "no-xml-artifacts" ? { code: 1 } : undefined), existing);
    const r = runSeal(ED, { reason: "r", sections: [] }, blocking.deps);
    assert.equal(r.exit, 4);
    assert.ok(!blocking.calls.some((c) => c.args[0] === "--check" && c.script.endsWith("check-humanizer-social.ts")));

    const info = rsDeps((s, a) => (s.endsWith("lint-social-md.ts") && a[1] === "relative-time" ? { code: 1 } : undefined), existing);
    const r2 = runSeal(ED, { reason: "r", sections: [] }, info.deps);
    assert.equal(r2.exit, 0);
    assert.deepEqual(r2.warnings, ["relative-time"]);
  });

  it("sem o snapshot do Stage 2, a cobertura é pulada (não quebra o selo)", () => {
    const { deps } = rsDeps(() => undefined, []);
    const r = runSeal(ED, { reason: "r", sections: [] }, deps);
    assert.equal(r.exit, 0);
    assert.ok(r.steps.find((s) => s.step === "humanizer-section-coverage")?.skipped);
  });

  it("check final ≠ 0 → exit 5", () => {
    let writes = 0;
    const { deps } = rsDeps((s, a) => {
      if (a[0] === "--write") writes++;
      return s.endsWith("check-humanizer-social.ts") && a[0] === "--check" && writes > 0 ? { code: 2 } : undefined;
    }, existing);
    assert.equal(runSeal(ED, { reason: "r", sections: [] }, deps).exit, 5);
  });

  it("CLI: seal sem --reason e flags exclusivas saem 6 sem rodar nada", () => {
    const { deps, calls } = rsDeps(() => undefined, existing);
    const errs: string[] = [];
    const orig = console.error;
    console.error = (m: string) => errs.push(m);
    try {
      assert.equal(resealMain(["seal", "--edition-dir", ED], deps), 6);
      assert.equal(resealMain(["seal", "--edition-dir", ED, "--reason", "r", "--clarice-pending", "x", "--clarice-no-suggestions"], deps), 6);
      assert.equal(resealMain(["seal", "--edition-dir", ED, "--reason", "r", "--clarice-pending"], deps), 6);
      assert.equal(resealMain(["bogus", "--edition-dir", ED], deps), 6);
    } finally {
      console.error = orig;
    }
    assert.equal(calls.length, 0);
  });
});

describe("#14116 playbook chama os compostos", () => {
  const pre = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-4.md"), "utf8");
  const gate = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-4-gate.md"), "utf8");
  const recipes = readFileSync(resolve(ROOT, "context/stage-4-gate-receitas.md"), "utf8");

  it("§4c.6 usa stage4-factcheck-post.ts depois do agente", () => {
    assert.match(pre, /npx tsx scripts\/stage4-factcheck-post\.ts --edition-dir/);
  });

  it("§4d.1 passo 6 e a receita K usam os 3 subcomandos do stage4-social-reseal.ts", () => {
    for (const sub of ["prepare", "after-humanizer", "seal"]) {
      assert.match(gate, new RegExp(`stage4-social-reseal\\.ts ${sub}`), `gate sem ${sub}`);
      assert.match(recipes, new RegExp(`stage4-social-reseal\\.ts ${sub}`), `receitas sem ${sub}`);
    }
  });
});
