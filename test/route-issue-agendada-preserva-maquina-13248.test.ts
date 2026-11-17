/**
 * test/route-issue-agendada-preserva-maquina-13248.test.ts (#13248)
 *
 * `route-issue --track agendada --until DATA` removia `windows`/`develop-track`
 * (e `claude-dir`), porque o plano de todo veredito tira as labels roteáveis
 * que não são do destino. Quando o marcador `aguardando-ate:` desarmava, a
 * issue caía no default `overnight` num servidor sem Chrome logado (caso
 * real: #13237, `"labelsRemoved": ["windows"]`).
 *
 * Sempre com `GhRunFn` em memória — nunca `gh` real, nunca issue real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENDADA_PRESERVED_LABELS,
  applyRouteLabelPlan,
  planRouteLabels,
  ROUTE_TRACKS,
} from "../scripts/lib/issue-route.ts";
import { classifyExecTrack } from "../scripts/lib/issue-exec-track.ts";
import { routeIssue, type GhRunFn } from "../scripts/route-issue.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

interface FakeIssueState {
  labels: string[];
  body: string;
  state: string;
  comments: string[];
}

function fakeGh(initial: FakeIssueState): { run: GhRunFn; state: FakeIssueState } {
  const state: FakeIssueState = { ...initial, labels: [...initial.labels], comments: [...initial.comments] };
  const run: GhRunFn = (args): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("-q") && args.includes(".body")) {
        return { status: 0, stdout: `${state.body}\n`, stderr: "" };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          labels: state.labels.map((name) => ({ name })),
          body: state.body,
          state: state.state,
          comments: state.comments.map((body) => ({ body })),
        }),
        stderr: "",
      };
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const addIdx = args.indexOf("--add-label");
      if (addIdx !== -1) {
        for (const l of args[addIdx + 1].split(",")) if (!state.labels.includes(l)) state.labels.push(l);
      }
      const removeIdx = args.indexOf("--remove-label");
      if (removeIdx !== -1) {
        const toRemove = new Set(args[removeIdx + 1].split(","));
        state.labels = state.labels.filter((l) => !toRemove.has(l));
      }
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx !== -1) state.body = args[bodyIdx + 1];
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      state.comments.push(args[args.indexOf("--body") + 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  return { run, state };
}

const NOW = new Date("2026-11-16T12:00:00Z");
const AFTER_DATE = new Date("2026-12-02T12:00:00Z");

describe("#13248 — planRouteLabels('agendada') preserva labels de máquina", () => {
  it("o conjunto preservado é exatamente windows, develop-track e claude-dir", () => {
    assert.deepEqual([...AGENDADA_PRESERVED_LABELS].sort(), ["claude-dir", "develop-track", "windows"]);
  });

  it("agendada não remove nenhuma label de máquina", () => {
    const plan = planRouteLabels("agendada");
    for (const l of AGENDADA_PRESERVED_LABELS) {
      assert.ok(!plan.remove.includes(l), `agendada não deveria remover "${l}"`);
    }
  });

  it("agendada continua removendo bloqueio e deferimento vago (só a máquina é preservada)", () => {
    const plan = planRouteLabels("agendada");
    for (const l of ["bloqueio-execucao", "external-blocker", "not-this-week", "on-hold", "trade-off-real"]) {
      assert.ok(plan.remove.includes(l), `agendada deveria remover "${l}"`);
    }
  });

  it("os outros tracks que não são develop seguem removendo windows (a preservação é só de agendada)", () => {
    for (const track of ROUTE_TRACKS.filter((t) => t !== "agendada")) {
      const plan = planRouteLabels(track);
      if (plan.add.includes("windows")) continue;
      assert.ok(plan.remove.includes("windows"), `--track ${track} deveria remover "windows"`);
    }
  });
});

describe("#13248 — round-trip agendada com label de máquina → data passa → develop", () => {
  for (const machineLabel of AGENDADA_PRESERVED_LABELS) {
    it(`issue com "${machineLabel}" agendada volta como develop depois da data`, () => {
      const gh = fakeGh({ labels: ["bug", machineLabel], body: "Corpo.", state: "OPEN", comments: [] });
      const result = routeIssue({
        issue: 13237,
        track: "agendada",
        until: "2026-11-30",
        reason: "reler o resultado do Testar e comparar em 30/11",
        cwd: "/tmp",
        ghRun: gh.run,
        now: NOW,
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.resolvedTrack, "agendada");
      assert.ok(!result.labelsRemoved.includes(machineLabel), `labelsRemoved não deveria ter "${machineLabel}"`);
      assert.ok(gh.state.labels.includes(machineLabel));
      assert.match(gh.state.body, /aguardando-ate: 2026-11-30/);

      const depois = classifyExecTrack({ labels: gh.state.labels, body: gh.state.body, state: "OPEN", now: AFTER_DATE });
      assert.equal(depois, "develop");
    });
  }

  it("sem label de máquina, a issue agendada volta como overnight depois da data (comportamento de sempre)", () => {
    const labels = applyRouteLabelPlan(["bug", "not-this-week"], planRouteLabels("agendada"));
    assert.deepEqual(labels, ["bug"]);
    const depois = classifyExecTrack({
      labels,
      body: "<!-- aguardando-ate: 2026-11-30 -->",
      state: "OPEN",
      now: AFTER_DATE,
    });
    assert.equal(depois, "overnight");
  });
});
