/**
 * #12678 — PR que muda prompt de agent com eval de replay (#8144) fica presa
 * no `Check agent-eval gate` sem aviso estruturado no relatório da rodada.
 * O bloco de reconciliação do `report.md` passa a marcar a PR aberta como
 * "aguarda agent-eval" e listar a pendência abaixo da tabela.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_EVAL_CHECK_NAME,
  AGENT_EVAL_PASSED_LABEL,
  classifyPr,
  isAwaitingAgentEval,
  renderReconcileBody,
} from "../scripts/lib/overnight-report-reconcile.ts";
import { reconcileReport, type GhJson } from "../scripts/reconcile-overnight-report.ts";

const evalCheck = (conclusion: string | null, status = "COMPLETED") => ({ name: AGENT_EVAL_CHECK_NAME, status, conclusion });
const otherCheck = { name: "test", status: "COMPLETED", conclusion: "SUCCESS" };

describe("isAwaitingAgentEval (#12678)", () => {
  it("cenário 261110c: check do gate vermelho, sem label → retida", () => {
    assert.equal(isAwaitingAgentEval({ statusCheckRollup: [otherCheck, evalCheck("FAILURE")], labels: [] }), true);
  });

  it("label agent-eval:passed presente → nunca retida, mesmo com check vermelho de um run antigo", () => {
    assert.equal(
      isAwaitingAgentEval({ statusCheckRollup: [evalCheck("FAILURE")], labels: [{ name: AGENT_EVAL_PASSED_LABEL }] }),
      false,
    );
  });

  it("check verde (nada elegível tocado) → não retida, mesmo com a declaração no corpo", () => {
    assert.equal(isAwaitingAgentEval({ statusCheckRollup: [evalCheck("SUCCESS")], body: "requer agent-eval: writer-destaque" }), false);
  });

  it("check ainda pendente ou ausente → decide pela declaração do implementador no corpo", () => {
    const body = "Closes #12552\n\nrequer agent-eval: writer-destaque (corpo do prompt mudou)\n";
    assert.equal(isAwaitingAgentEval({ statusCheckRollup: [evalCheck(null, "IN_PROGRESS")], body }), true);
    assert.equal(isAwaitingAgentEval({ statusCheckRollup: [], body }), true);
    assert.equal(isAwaitingAgentEval({ statusCheckRollup: [], body: "Closes #1" }), false);
    assert.equal(isAwaitingAgentEval({}), false);
  });

  it("menção em prosa no meio da linha não conta como declaração", () => {
    assert.equal(isAwaitingAgentEval({ body: "Esta PR não requer agent-eval nenhum." }), false);
  });

  it("classifyPr só marca PR aberta", () => {
    const base = { number: 12649, title: "t", url: "u", mergedAt: null, comments: [], statusCheckRollup: [evalCheck("FAILURE")] };
    assert.equal(classifyPr({ ...base, state: "OPEN" }, new Map()).awaitingAgentEval, true);
    assert.equal(classifyPr({ ...base, state: "MERGED", mergedAt: "x" }, new Map()).awaitingAgentEval, undefined);
  });
});

describe("bloco de reconciliação lista a pendência (#12678)", () => {
  it("renderReconcileBody: estado 'aguarda agent-eval' + linha de pendência com o comando do coordenador", () => {
    const body = renderReconcileBody(
      [
        { number: 12649, title: "títulos do YouTube", url: "u", state: "open", awaitingAgentEval: true },
        { number: 12650, title: "outra", url: "u", state: "open" },
      ],
      "",
    );
    assert.match(body, /\| \[#12649\]\(u\) \| aberta, aguarda agent-eval \|/);
    assert.match(body, /\| \[#12650\]\(u\) \| aberta \|/);
    assert.match(body, /Pendência: #12649 retida\(s\) no agent-eval gate/);
    assert.match(body, /run-agent-eval-for-pr\.ts --pr N --live/);
  });

  it("sem PR retida, nenhuma linha de pendência", () => {
    assert.doesNotMatch(renderReconcileBody([{ number: 1, title: "t", url: "u", state: "open" }], ""), /Pendência/);
  });

  it("reconcileReport pede labels/statusCheckRollup/body ao gh e grava a pendência", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-12678-"));
    try {
      const reportPath = join(dir, "report.md");
      writeFileSync(reportPath, "# overnight 261110c\n");
      writeFileSync(join(dir, "plan.json"), JSON.stringify({ issues: [{ number: 12552, in_round: true, pr: 12649 }] }));
      const seen: string[][] = [];
      const gh: GhJson = (args) => {
        seen.push(args);
        return {
          ok: true,
          data: { number: 12649, title: "PR 12649", url: "https://x/12649", state: "OPEN", mergedAt: null, comments: [], body: "Closes #12552", labels: [], statusCheckRollup: [evalCheck("FAILURE")] },
        };
      };
      const r = reconcileReport({ reportPath, planPath: join(dir, "plan.json"), extraPrs: [], discover: false, check: false, gh, now: () => "2026-11-10T05:00:00Z" });
      assert.equal(r.exitCode, 0);
      assert.match(seen[0].join(" "), /labels/);
      assert.match(seen[0].join(" "), /statusCheckRollup/);
      assert.match(readFileSync(reportPath, "utf8"), /Pendência: #12649 retida\(s\) no agent-eval gate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
