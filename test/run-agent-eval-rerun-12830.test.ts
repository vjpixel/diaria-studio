/**
 * test/run-agent-eval-rerun-12830.test.ts (#12830)
 *
 * Regressão: `run-agent-eval-for-pr.ts --live` aplicava a label
 * `agent-eval:passed` e devolvia sucesso com o check `Check agent-eval gate`
 * ainda vermelho (PR #12649 só ficou verde com `gh run rerun` à mão; na #12426
 * o rerun foi recusado). `ensureAgentEvalCheckGreen` reexecuta o check e só
 * devolve sucesso com ele verde. Runner `gh` falso, nunca rede real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureAgentEvalCheckGreen,
  listAgentEvalRuns,
  latestRun,
  requestWorkflowRerun,
  retriggerViaLabelToggle,
  AGENT_EVAL_WORKFLOW_FILE,
  type CommandRunner,
  type CommandRunnerResult,
} from "../scripts/run-agent-eval-for-pr.ts";

const SHA = "a".repeat(40);
const LABEL = "agent-eval:passed";

type Run = { id: number; status: string; conclusion: string | null; run_attempt: number };

/**
 * Simula o GitHub: `runs` é o estado atual; cada consulta de runs avança o
 * relógio de transições pendentes (o rerun pedido vira `queued` na consulta
 * seguinte e `success` na outra, como o Actions faz).
 */
function fakeGithub(opts: {
  runs: Run[];
  rerunFails?: string;
  rerunResult?: "success" | "failure";
  labeledRunResult?: "success" | "failure";
}) {
  const runs = opts.runs.map((r) => ({ ...r }));
  const calls: string[][] = [];
  const pending: Array<() => void> = [];
  let labels = [LABEL];
  let nextId = Math.max(0, ...runs.map((r) => r.id)) + 100;
  const ok = (stdout = ""): CommandRunnerResult => ({ status: 0, stdout, stderr: "" });
  const runner: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const joined = args.join(" ");
    if (joined.includes(`actions/workflows/${AGENT_EVAL_WORKFLOW_FILE}/runs`)) {
      const step = pending.shift();
      if (step) step();
      return ok(JSON.stringify(runs));
    }
    if (joined.includes("/rerun")) {
      if (opts.rerunFails) return { status: 1, stdout: "", stderr: opts.rerunFails };
      const id = Number(/runs\/(\d+)\/rerun/.exec(joined)![1]);
      const run = runs.find((r) => r.id === id)!;
      pending.push(() => {
        run.status = "queued";
        run.conclusion = null;
        run.run_attempt += 1;
      });
      pending.push(() => {
        run.status = "completed";
        run.conclusion = opts.rerunResult ?? "success";
      });
      return ok();
    }
    if (args.includes("DELETE")) {
      labels = labels.filter((l) => l !== LABEL);
      return ok();
    }
    if (args.includes("POST") && joined.includes("/labels")) {
      labels.push(LABEL);
      const id = nextId++;
      pending.push(() => runs.push({ id, status: "in_progress", conclusion: null, run_attempt: 1 }));
      pending.push(() => {
        const r = runs.find((x) => x.id === id)!;
        r.status = "completed";
        r.conclusion = opts.labeledRunResult ?? "success";
      });
      return ok();
    }
    if (joined.includes("/labels")) return ok(labels.join("\n"));
    return { status: 1, stdout: "", stderr: `comando inesperado: ${joined}` };
  };
  return { runner, calls, runs };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const quiet = () => {};

describe("ensureAgentEvalCheckGreen (#12830)", () => {
  it("regressão #12830 (PR #12649): check vermelho depois da label → pede rerun e só devolve ok com o check verde", async () => {
    const gh = fakeGithub({ runs: [{ id: 10, status: "completed", conclusion: "failure", run_attempt: 1 }] });
    const c = clock();
    const res = await ensureAgentEvalCheckGreen({ prNumber: "42", headSha: SHA, label: LABEL, runner: gh.runner, ...c, log: quiet });
    assert.deepEqual(res, { ok: true, runId: 10, action: "rerun" });
    assert.ok(gh.calls.some((c) => c.join(" ").includes("-X POST repos/{owner}/{repo}/actions/runs/10/rerun")), "rerun via REST do run vermelho");
    assert.ok(!gh.calls.some((c) => c.includes("DELETE")), "rerun aceito não mexe na label");
  });

  it("check já verde (o workflow rodou com o labeled): ok sem ação", async () => {
    const gh = fakeGithub({ runs: [{ id: 10, status: "completed", conclusion: "success", run_attempt: 1 }] });
    const res = await ensureAgentEvalCheckGreen({ prNumber: "42", headSha: SHA, label: LABEL, runner: gh.runner, ...clock(), log: quiet });
    assert.deepEqual(res, { ok: true, runId: 10, action: "none" });
    assert.ok(!gh.calls.some((c) => c.join(" ").includes("/rerun")));
  });

  it("run em andamento (labeled) mais novo que o vermelho: espera ele, sem pedir rerun", async () => {
    const gh = fakeGithub({
      runs: [
        { id: 10, status: "completed", conclusion: "failure", run_attempt: 1 },
        { id: 11, status: "in_progress", conclusion: null, run_attempt: 1 },
      ],
    });
    let polls = 0;
    const c = clock();
    const res = await ensureAgentEvalCheckGreen({
      prNumber: "42",
      headSha: SHA,
      label: LABEL,
      runner: gh.runner,
      now: c.now,
      sleep: async (ms) => {
        polls++;
        if (polls === 2) {
          gh.runs[1].status = "completed";
          gh.runs[1].conclusion = "success";
        }
        await c.sleep(ms);
      },
      log: quiet,
    });
    assert.deepEqual(res, { ok: true, runId: 11, action: "none" });
    assert.ok(!gh.calls.some((c) => c.join(" ").includes("/rerun")));
  });

  it("regressão #12830 (PR #12426): rerun recusado → tira e repõe a label, espera o run novo verde", async () => {
    const gh = fakeGithub({
      runs: [{ id: 10, status: "completed", conclusion: "failure", run_attempt: 1 }],
      rerunFails: "run 10 cannot be rerun; its workflow file may be broken",
    });
    const res = await ensureAgentEvalCheckGreen({ prNumber: "42", headSha: SHA, label: LABEL, runner: gh.runner, ...clock(), log: quiet });
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.action, "label-toggle");
    assert.ok(res.ok && res.runId > 10, "verde num run NOVO, não no vermelho antigo");
    const del = gh.calls.findIndex((c) => c.includes("DELETE"));
    const post = gh.calls.findIndex((c) => c.includes("POST") && c.join(" ").includes("/labels"));
    assert.ok(del >= 0 && post > del, "remove e depois repõe a label");
  });

  it("nenhum run no head: dispara via label e espera", async () => {
    const gh = fakeGithub({ runs: [] });
    const res = await ensureAgentEvalCheckGreen({ prNumber: "42", headSha: SHA, label: LABEL, runner: gh.runner, ...clock(), log: quiet });
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.action, "label-toggle");
  });

  it("rerun roda e termina vermelho de novo: falha (nunca devolve sucesso com check vermelho)", async () => {
    const gh = fakeGithub({ runs: [{ id: 10, status: "completed", conclusion: "failure", run_attempt: 1 }], rerunResult: "failure" });
    const res = await ensureAgentEvalCheckGreen({ prNumber: "42", headSha: SHA, label: LABEL, runner: gh.runner, ...clock(), log: quiet });
    assert.equal(res.ok, false);
    assert.match(!res.ok ? res.error : "", /rodou de novo.*failure/);
    assert.equal(gh.calls.filter((c) => c.join(" ").includes("/rerun")).length, 1, "um rerun só, sem laço de reruns");
  });

  it("rerun aceito mas o run não sai do vermelho antigo até o prazo: falha por timeout", async () => {
    const base = fakeGithub({ runs: [{ id: 10, status: "completed", conclusion: "failure", run_attempt: 1 }] });
    const runner: CommandRunner = (cmd, args) => (args.join(" ").includes("/rerun") ? { status: 0, stdout: "", stderr: "" } : base.runner(cmd, args));
    const res = await ensureAgentEvalCheckGreen({ prNumber: "42", headSha: SHA, label: LABEL, runner, ...clock(), timeoutMs: 60_000, pollMs: 15_000, log: quiet });
    assert.equal(res.ok, false);
    assert.match(!res.ok ? res.error : "", /não ficou verde em 60s/);
  });

  it("consulta dos runs falhando propaga (nunca vira 'nenhum run')", async () => {
    const runner: CommandRunner = () => ({ status: 1, stdout: "", stderr: "HTTP 502" });
    await assert.rejects(ensureAgentEvalCheckGreen({ prNumber: "42", headSha: SHA, label: LABEL, runner, ...clock(), log: quiet }), /502/);
  });
});

describe("helpers de rerun (#12830)", () => {
  it("listAgentEvalRuns: consulta o workflow do gate filtrado pelo head SHA", () => {
    let seen: string[] = [];
    const runner: CommandRunner = (_c, args) => {
      seen = args;
      return { status: 0, stdout: JSON.stringify([{ id: 5, status: "completed", conclusion: "success", run_attempt: 2 }]), stderr: "" };
    };
    assert.deepEqual(listAgentEvalRuns(SHA, runner), [{ id: 5, status: "completed", conclusion: "success", runAttempt: 2 }]);
    assert.ok(seen.join(" ").includes(`actions/workflows/agent-eval-required.yml/runs?head_sha=${SHA}`));
  });

  it("latestRun: maior id; vazio → null", () => {
    assert.equal(latestRun([]), null);
    assert.equal(latestRun([{ id: 3, status: "x", conclusion: null, runAttempt: 1 }, { id: 9, status: "y", conclusion: null, runAttempt: 1 }])!.id, 9);
  });

  it("requestWorkflowRerun: erro vira { ok: false } com a mensagem", () => {
    const res = requestWorkflowRerun(7, () => ({ status: 1, stdout: "", stderr: "cannot be rerun" }));
    assert.deepEqual(res, { ok: false, error: "cannot be rerun" });
  });

  it("retriggerViaLabelToggle: reposição que não aparece na releitura lança com aviso de reaplicar à mão", () => {
    const runner: CommandRunner = (_c, args) => (args.join(" ").includes("labels?per_page") ? { status: 0, stdout: "outra", stderr: "" } : { status: 0, stdout: "", stderr: "" });
    assert.throws(() => retriggerViaLabelToggle("42", LABEL, runner), /reaplicar à mão/);
  });

  it("retriggerViaLabelToggle: DELETE com 404 (label já ausente) segue para a reposição", () => {
    const runner: CommandRunner = (_c, args) => {
      if (args.includes("DELETE")) return { status: 1, stdout: "", stderr: "HTTP 404: Label does not exist" };
      if (args.join(" ").includes("labels?per_page")) return { status: 0, stdout: LABEL, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    assert.doesNotThrow(() => retriggerViaLabelToggle("42", LABEL, runner));
  });
});
