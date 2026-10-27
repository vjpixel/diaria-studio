/**
 * test/merge-train-gate-labels-11019.test.ts (#11019, regressão #633)
 *
 * O PR-trem não herdava as labels de gate dos PRs do lote. Rodada 261023,
 * trem 7: o lote com o #11007 (`agent-eval:passed`, mexia no writer-destaque)
 * abriu o PR-trem #11017 sem a label, o `Check agent-eval gate` reprovou a
 * combinação e o trem bissectou até o piso — 2 runs de CI à toa.
 *
 * Cobre a regra pura (`computeTrainGateLabels`), a justificativa no corpo
 * (`buildTrainPrBody`), a leitura de labels/arquivos (`fetchTrainPrInfo`) e a
 * aplicação no PR-trem via `gh-pr-safe-edit.ts --add-label` (nunca
 * `gh pr edit --add-label`, #10429) — tudo com runner fake, sem GitHub real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeTrainGateLabels,
  buildTrainPrBody,
  NO_REGRESSION_TEST_LABEL,
  type TrainPrInfo,
} from "../scripts/lib/merge-train.ts";
import { applyTrainGateLabels, fetchTrainPrInfo, runMergeTrain, type ExecResult, type TrainRunner } from "../scripts/lib/merge-train-live.ts";
import { AGENT_EVAL_LABEL } from "../scripts/check-agent-eval-required.ts";
import { justificationInBody } from "../scripts/check-pr-bugfix.ts";

const WRITER = ".claude/agents/writer-destaque.md";

function info(pr: number, over: Partial<TrainPrInfo> = {}): TrainPrInfo {
  return {
    pr,
    headRefName: `overnight/fix-${pr}`,
    title: `feat: coisa ${pr}`,
    issueNumbers: [pr - 1000],
    labels: [],
    changedFiles: [`scripts/x-${pr}.ts`, `test/x-${pr}.test.ts`],
    ...over,
  };
}

describe("computeTrainGateLabels — agent-eval:passed", () => {
  it("cenário do incidente: 1 PR mexe no writer-destaque com a label, os outros não tocam agent → herda", () => {
    const infos = [
      info(11007, { changedFiles: [WRITER, "test/w.test.ts"], labels: [AGENT_EVAL_LABEL] }),
      info(11009),
      info(11010),
    ];
    assert.deepEqual(computeTrainGateLabels({ prs: [11007, 11009, 11010] }, infos).labels, [AGENT_EVAL_LABEL]);
  });

  it("2 PRs tocam agent mapeado e só 1 tem a label → não herda", () => {
    const infos = [
      info(1, { changedFiles: [WRITER], labels: [AGENT_EVAL_LABEL] }),
      info(2, { changedFiles: [".claude/agents/social-writer.md"], labels: [] }),
    ];
    assert.deepEqual(computeTrainGateLabels({ prs: [1, 2] }, infos).labels, []);
  });

  it("ninguém toca agent mapeado → não herda, mesmo se algum PR tiver a label", () => {
    const infos = [info(1, { labels: [AGENT_EVAL_LABEL] }), info(2)];
    assert.deepEqual(computeTrainGateLabels({ prs: [1, 2] }, infos).labels, []);
  });

  it("agent excluído do gatilho não conta como precisando", () => {
    const infos = [info(1, { changedFiles: [".claude/agents/orchestrator-stage-2.md"] }), info(2, { changedFiles: [WRITER], labels: [AGENT_EVAL_LABEL] })];
    assert.deepEqual(computeTrainGateLabels({ prs: [1, 2] }, infos).labels, [AGENT_EVAL_LABEL]);
  });

  it("arquivos não lidos ou lista incompleta contam como 'precisa' → sem a label, barra a herança", () => {
    const base = info(1, { changedFiles: [WRITER], labels: [AGENT_EVAL_LABEL] });
    assert.deepEqual(computeTrainGateLabels({ prs: [1, 2] }, [base, info(2, { changedFiles: null })]).labels, []);
    assert.deepEqual(computeTrainGateLabels({ prs: [1, 2] }, [base, info(2, { changedFiles: undefined })]).labels, []);
  });

  it("PR sem TrainPrInfo barra a herança", () => {
    const infos = [info(1, { changedFiles: [WRITER], labels: [AGENT_EVAL_LABEL] })];
    assert.deepEqual(computeTrainGateLabels({ prs: [1, 2] }, infos).labels, []);
  });
});

describe("computeTrainGateLabels — no-regression-test", () => {
  const bugfixNoTest = (pr: number, labels: string[]) => info(pr, { title: `fix: bug ${pr}`, changedFiles: [`scripts/y-${pr}.ts`], labels });

  it("todo bugfix sem teste tem a label → herda, e lista os PRs na justificativa", () => {
    const infos = [bugfixNoTest(1, [NO_REGRESSION_TEST_LABEL]), info(2)];
    const d = computeTrainGateLabels({ prs: [1, 2] }, infos);
    assert.deepEqual(d.labels, [NO_REGRESSION_TEST_LABEL]);
    assert.deepEqual(d.noRegressionTestPrs, [1]);
  });

  it("um bugfix sem teste sem a label → não herda", () => {
    const infos = [bugfixNoTest(1, [NO_REGRESSION_TEST_LABEL]), bugfixNoTest(2, [])];
    assert.deepEqual(computeTrainGateLabels({ prs: [1, 2] }, infos).labels, []);
  });

  it("bugfix COM teste não precisa da label", () => {
    const infos = [info(1, { title: "fix: x", changedFiles: ["scripts/a.ts", "test/a.test.ts"] })];
    assert.deepEqual(computeTrainGateLabels({ prs: [1] }, infos).labels, []);
  });

  it("labels não lidas contam como bugfix sem a label → barra a herança", () => {
    const infos = [bugfixNoTest(1, [NO_REGRESSION_TEST_LABEL]), info(2, { labels: undefined, changedFiles: ["scripts/z.ts"] })];
    assert.deepEqual(computeTrainGateLabels({ prs: [1, 2] }, infos).labels, []);
  });

  it("corpo do PR-trem leva a justificativa que o gate do #633 exige junto com a label", () => {
    const infos = [bugfixNoTest(1, [NO_REGRESSION_TEST_LABEL]), info(2)];
    const body = buildTrainPrBody({ prs: [1, 2] }, infos);
    assert.ok(justificationInBody(body), body);
    assert.match(body, /^no-regression-test: herdado do lote \(#11019\) — #1 /m);
  });

  it("sem herança, o corpo não ganha a linha", () => {
    assert.doesNotMatch(buildTrainPrBody({ prs: [2] }, [info(2)]), /no-regression-test/);
  });
});

// --- live: runner fake -------------------------------------------------------

function ok(stdout = ""): ExecResult {
  return { ok: true, stdout, stderr: "" };
}

type Route = { cmd: string; match: (a: string[], cwd?: string) => boolean; res: (a: string[]) => ExecResult };

class Fake implements TrainRunner {
  calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  warnings: string[] = [];
  routes: Route[] = [];
  private clock = 0;
  on(cmd: string, match: Route["match"], res: Route["res"]): this {
    this.routes.push({ cmd, match, res });
    return this;
  }
  exec(cmd: string, args: string[], cwd?: string): ExecResult {
    this.calls.push({ cmd, args, cwd });
    const r = [...this.routes].reverse().find((x) => x.cmd === cmd && x.match(args, cwd));
    if (!r) throw new Error(`não roteirizada: ${cmd} ${args.join(" ")}`);
    return r.res(args);
  }
  async sleep(): Promise<void> {
    this.clock += 1000;
  }
  now(): number {
    return this.clock;
  }
  mkTempDir(prefix: string): string {
    return `/tmp/${prefix}1`;
  }
  warn(m: string): void {
    this.warnings.push(m);
  }
}

const isLabelEdit = (a: string[]) => a[0] === "tsx" && a[1] === "scripts/lib/gh-pr-safe-edit.ts" && a.includes("--add-label");

describe("fetchTrainPrInfo — labels e arquivos (#11019)", () => {
  it("lê labels e files; lista menor que changedFiles vira null (incompleta)", () => {
    const r = new Fake().on("gh", (a) => a[1] === "view" && a.some((x) => x.startsWith("number,headRefName,title,body,labels,files,changedFiles")), (a) =>
      ok(
        JSON.stringify({
          number: Number(a[2]),
          headRefName: "b",
          title: "t",
          body: "Closes #1",
          labels: [{ name: AGENT_EVAL_LABEL }],
          files: [{ path: WRITER }],
          changedFiles: a[2] === "7" ? 1 : 150,
        }),
      ),
    );
    const full = fetchTrainPrInfo(r, 7);
    assert.deepEqual(full.labels, [AGENT_EVAL_LABEL]);
    assert.deepEqual(full.changedFiles, [WRITER]);
    assert.equal(fetchTrainPrInfo(r, 8).changedFiles, null);
  });

  it("payload sem labels/files → ausentes (não lidos)", () => {
    const r = new Fake().on("gh", () => true, () => ok(JSON.stringify({ number: 1, headRefName: "b", title: "t", body: "" })));
    const i = fetchTrainPrInfo(r, 1);
    assert.equal(i.labels, undefined);
    assert.equal(i.changedFiles, undefined);
  });
});

describe("applyTrainGateLabels", () => {
  const infos = [info(1, { changedFiles: [WRITER], labels: [AGENT_EVAL_LABEL] }), info(2)];

  it("aplica via gh-pr-safe-edit.ts --add-label (REST), nunca gh pr edit", () => {
    const r = new Fake().on("npx", isLabelEdit, () => ok());
    assert.deepEqual(applyTrainGateLabels(r, 9001, { prs: [1, 2] }, infos), [AGENT_EVAL_LABEL]);
    assert.deepEqual(r.calls[0].args, ["tsx", "scripts/lib/gh-pr-safe-edit.ts", "--pr", "9001", "--add-label", AGENT_EVAL_LABEL]);
    assert.ok(!r.calls.some((c) => c.cmd === "gh" && c.args[1] === "edit"));
  });

  it("nada a herdar → nenhuma chamada", () => {
    const r = new Fake();
    assert.deepEqual(applyTrainGateLabels(r, 9001, { prs: [2] }, [info(2)]), []);
    assert.equal(r.calls.length, 0);
  });

  it("falha do helper vira aviso, não exceção", () => {
    const r = new Fake().on("npx", isLabelEdit, () => ({ ok: false, stdout: "", stderr: "releitura não bateu" }));
    assert.deepEqual(applyTrainGateLabels(r, 9001, { prs: [1, 2] }, infos), []);
    assert.match(r.warnings[0], /releitura não bateu/);
  });
});

describe("runMergeTrain — PR-trem recebe a label antes do polling de CI (cenário do trem 7)", () => {
  it("lote com o PR agent-eval:passed: label aplicada ao PR-trem e o lote mergeia inteiro", async () => {
    const order: string[] = [];
    const ciPass = JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: "SUCCESS", status: "COMPLETED" }] });
    const r = new Fake()
      .on("git", () => true, () => ok())
      .on("npx", (a) => a.includes("merge-lock-acquire") || a.includes("merge-lock-release"), () => ok())
      .on("npx", isLabelEdit, (a) => {
        order.push(`label:${a[3]}`);
        return ok();
      })
      .on("gh", (a) => a[1] === "create", () => ok("https://github.com/vjpixel/diaria-studio/pull/11017\n"))
      .on("gh", (a) => a[1] === "view" && a.includes("statusCheckRollup"), (a) => {
        order.push(`ci:${a[2]}`);
        return ok(ciPass);
      })
      .on("gh", (a) => a[0] === "api" && a[1] === "graphql", () => ok(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })))
      .on("gh", (a) => a[1] === "view" && a.includes("labels,body"), () => ok(JSON.stringify({ labels: [], body: "" })))
      .on("gh", (a) => a[1] === "merge" || a[1] === "comment" || a[1] === "close", () => ok());

    const infos = [info(11007, { changedFiles: [WRITER, "test/w.test.ts"], labels: [AGENT_EVAL_LABEL] }), info(11009), info(11010)];
    const outcomes = await runMergeTrain(r, { prs: [11007, 11009, 11010] }, infos, { sessionId: "s", kind: "overnight", mainCwd: "/repo", ciPollIntervalMs: 1 });

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "merged");
    assert.equal(order[0], "label:11017", "a label vai pro PR-trem antes da 1ª leitura de CI");
    assert.ok(order.includes("ci:11017"));
  });
});
