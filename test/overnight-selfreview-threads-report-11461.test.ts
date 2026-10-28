/**
 * test/overnight-selfreview-threads-report-11461.test.ts
 *
 * #11461 — rodada agendada 261028:
 *  (1) threads de self-review P3 da própria automação ficavam abertas e o
 *      ruleset (`required_review_thread_resolution`) travava o merge;
 *  (2) o `report.md` dizia "Nenhuma unidade mergeada" e o trem mergeou
 *      #11436/#11438 depois, sem ninguém reconciliar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_BLOCKING,
  EXIT_OK,
  EXIT_USAGE,
  classifyFindingSeverity,
  findingExcerpt,
  resolveReviewThreads,
  runCli,
  type GhRunFn,
} from "../scripts/resolve-review-threads.ts";
import { AUTO_REVIEW_MARKER } from "../scripts/lib/auto-review-marker.ts";
import {
  RECONCILE_END,
  RECONCILE_START,
  classifyPr,
  discoverRoundPrs,
  existingReconcileBody,
  extractTrainPr,
  prsFromPlan,
  renderReconcileBody,
  upsertReconcileBlock,
} from "../scripts/lib/overnight-report-reconcile.ts";
import { reconcileReport, type GhJson } from "../scripts/reconcile-overnight-report.ts";

// ── (1) severidade do finding ──

describe("classifyFindingSeverity (#11461)", () => {
  it("texto real do self-review: 'Confiança média, P3' é low", () => {
    assert.equal(classifyFindingSeverity("Self-review (sessão autora). Confiança média, P3: transição. ..."), "low");
    assert.equal(classifyFindingSeverity("Confiança baixa, P2: nit"), "low");
  });
  it("P0/P1 e confiança alta são high (seguram o merge)", () => {
    assert.equal(classifyFindingSeverity("Confiança média, P1: bug"), "high");
    assert.equal(classifyFindingSeverity("P0 — leak"), "high");
    assert.equal(classifyFindingSeverity("Confiança alta, P3: perda de cobertura aceita"), "high");
    assert.equal(classifyFindingSeverity("confianca: alta / P2"), "high");
  });
  it("sem severidade reconhecível é untagged (fail-closed)", () => {
    assert.equal(classifyFindingSeverity("achado sem tag"), "untagged");
    assert.equal(classifyFindingSeverity(undefined), "untagged");
    assert.equal(classifyFindingSeverity("HTTP3 e SP33"), "untagged");
  });
  it("findingExcerpt tira o marcador e corta em 200", () => {
    assert.equal(findingExcerpt(`a\n b\n\n${AUTO_REVIEW_MARKER}`), "a b");
    assert.equal(findingExcerpt("x".repeat(300)).length, 200);
  });
});

type T = { id: string; isResolved: boolean; viewerCanResolve?: boolean; comments?: unknown };
const auto = (body: string) => ({ totalCount: 1, nodes: [{ body: `${body}\n\n${AUTO_REVIEW_MARKER}` }] });
const human = (body: string) => ({ totalCount: 1, nodes: [{ body }] });
const threadsJson = (nodes: T[]) =>
  JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } });
const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
const resolvedJson = (id: string) => JSON.stringify({ data: { resolveReviewThread: { thread: { id, isResolved: true } } } });

function fakeGh(queries: string[]) {
  const mutated: string[] = [];
  let q = 0;
  const run: GhRunFn = (args) => {
    const tid = args.find((a) => a.startsWith("tid="));
    if (tid) {
      mutated.push(tid.slice(4));
      return ok(resolvedJson(tid.slice(4)));
    }
    return ok(queries[q++] ?? "");
  };
  return { run, mutated };
}

describe("resolveReviewThreads lowSeverityOnly (#11461)", () => {
  const before = [
    { id: "p3", isResolved: false, viewerCanResolve: true, comments: auto("Confiança média, P3: transição") },
    { id: "p1", isResolved: false, viewerCanResolve: true, comments: auto("Confiança média, P1: bug real") },
    { id: "alta", isResolved: false, viewerCanResolve: true, comments: auto("Confiança alta, P3: x") },
    { id: "ed", isResolved: false, viewerCanResolve: true, comments: human("P3: comentário do editor") },
  ];

  it("cenário 261028: só P3 sem confiança alta é resolvido; P1/alta ficam retidas, do editor fica em skipped", () => {
    const after = before.map((t) => (t.id === "p3" ? { ...t, isResolved: true } : t));
    const gh = fakeGh([threadsJson(before), threadsJson(after)]);
    const r = resolveReviewThreads("vjpixel/diaria-studio", 11437, gh.run, null, { lowSeverityOnly: true });
    assert.deepEqual(gh.mutated, ["p3"]);
    assert.deepEqual(r.resolved, ["p3"]);
    assert.deepEqual(r.held, ["p1", "alta"]);
    assert.deepEqual(r.skipped, ["ed"]);
    assert.deepEqual(r.resolvedFindings, [{ id: "p3", excerpt: "Confiança média, P3: transição" }]);
    assert.equal(r.exitCode, EXIT_BLOCKING);
  });

  it("todas P3 → nada bloqueia, merge liberado", () => {
    const only = [before[0]];
    const gh = fakeGh([threadsJson(only), threadsJson([{ ...only[0], isResolved: true }])]);
    const r = resolveReviewThreads("vjpixel/diaria-studio", 1, gh.run, null, { lowSeverityOnly: true });
    assert.equal(r.exitCode, EXIT_OK);
  });

  it("modo padrão (sem a opção) continua resolvendo toda thread da automação", () => {
    const autos = before.slice(0, 3);
    const gh = fakeGh([threadsJson(autos), threadsJson(autos.map((t) => ({ ...t, isResolved: true })))]);
    const r = resolveReviewThreads("vjpixel/diaria-studio", 1, gh.run);
    assert.deepEqual(gh.mutated, ["p3", "p1", "alta"]);
    assert.deepEqual(r.held, []);
  });

  it("CLI: --low-severity-only é exclusivo e não leva valor", () => {
    const gh = fakeGh([]);
    assert.equal(runCli(["--pr", "1", "--low-severity-only", "--check"], gh.run).exitCode, EXIT_USAGE);
    assert.equal(runCli(["--pr", "1", "--low-severity-only", "x"], gh.run).exitCode, EXIT_USAGE);
  });
});

// ── (2) reconciliação do report.md ──

const trusted = (body: string) => ({ body, authorAssociation: "OWNER" });
const trainComment = (n: number) => `Mergeado via trem de merge (#6300) — PR-trem #${n}, commit squash \`x\`.`;

describe("overnight-report-reconcile (#11461)", () => {
  it("extractTrainPr ignora comentário de autor sem vínculo", () => {
    assert.equal(extractTrainPr([{ body: trainComment(11442), authorAssociation: "NONE" }]), null);
    assert.equal(extractTrainPr([trusted(trainComment(11442))]), 11442);
  });

  it("PR fechada pelo trem só conta como mergeada se o PR-trem estiver MERGED", () => {
    const v = { number: 11437, title: "t", url: "u", state: "CLOSED", mergedAt: null, comments: [trusted(trainComment(11442))] };
    assert.equal(classifyPr(v, new Map([[11442, "MERGED"]])).state, "merged-via-train");
    assert.equal(classifyPr(v, new Map([[11442, "CLOSED"]])).state, "closed");
    assert.equal(classifyPr({ ...v, comments: [] }, new Map()).state, "closed");
  });

  it("prsFromPlan e discoverRoundPrs (plano com pr: null, como na 261028)", () => {
    assert.deepEqual(prsFromPlan({ issues: [{ pr: 5 }, { pr: "#7" }, { pr: null }] }), [5, 7]);
    const list = [
      { number: 11436, createdAt: "2026-10-28T03:00:00Z", body: "Closes #11433" },
      { number: 11440, createdAt: "2026-10-28T03:10:00Z", body: "closes #11430, closes #11429" },
      { number: 11441, createdAt: "2026-10-28T03:20:00Z", body: "REFS #11431, NÃO CLOSES (parcial)" },
      { number: 11300, createdAt: "2026-10-27T03:00:00Z", body: "Closes #11433" }, // antes da rodada
      { number: 11999, createdAt: "2026-10-28T04:00:00Z", body: "Closes #1" }, // outra issue
    ];
    assert.deepEqual(discoverRoundPrs(list, "2026-10-28T02:00:00Z", new Set([11433, 11429, 11431])), [11436, 11440, 11441]);
  });

  it("bloco é idempotente e desmente 'Nenhuma unidade mergeada'", () => {
    const prs = [{ number: 11436, title: "a|b", url: "u", state: "merged" as const }];
    const body = renderReconcileBody(prs, "Nenhuma unidade mergeada ainda.");
    assert.match(body, /1 mergeada\(s\)/);
    assert.match(body, /a\\\|b/);
    assert.match(body, /Vale esta tabela/);
    const once = upsertReconcileBlock("relatório", `${RECONCILE_START}\nx\n${RECONCILE_END}`);
    const twice = upsertReconcileBlock(once, `${RECONCILE_START}\ny\n${RECONCILE_END}`);
    assert.equal(twice.split(RECONCILE_START).length, 2);
    assert.match(twice, /\ny\n/);
  });

  it("reconcileReport ponta a ponta: grava o estado real, --check acusa defasagem depois de novo merge", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-11461-"));
    try {
      const reportPath = join(dir, "report.md");
      writeFileSync(reportPath, "# overnight 261028\n\nNenhuma unidade mergeada ainda.\n");
      writeFileSync(
        join(dir, "plan.json"),
        JSON.stringify({ started_at: "2026-10-28T02:00:00Z", issues: [{ number: 11433, in_round: true, pr: null }, { number: 11435, in_round: true, pr: null }] }),
      );
      const states: Record<number, { state: string; comments: unknown[] }> = {
        11436: { state: "MERGED", comments: [] },
        11437: { state: "OPEN", comments: [] },
      };
      const gh: GhJson = (args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return { ok: true, data: [
            { number: 11436, createdAt: "2026-10-28T03:00:00Z", body: "Closes #11433" },
            { number: 11437, createdAt: "2026-10-28T03:05:00Z", body: "Closes #11435" },
          ] };
        }
        const n = Number(args[2]);
        const s = states[n];
        if (!s) return { ok: false, error: `pr ${n} inexistente` };
        return { ok: true, data: { number: n, title: `PR ${n}`, url: `https://x/${n}`, state: s.state, mergedAt: s.state === "MERGED" ? "2026-10-28T04:00:00Z" : null, comments: s.comments } };
      };
      const base = { reportPath, planPath: join(dir, "plan.json"), extraPrs: [], discover: true, gh, now: () => "2026-10-28T05:00:00Z" };

      assert.equal(reconcileReport({ ...base, check: true }).exitCode, 1, "sem bloco = defasado");
      const w = reconcileReport({ ...base, check: false });
      assert.equal(w.exitCode, 0);
      const text = readFileSync(reportPath, "utf8");
      assert.match(text, /Nenhuma unidade mergeada ainda\./, "prosa original preservada");
      assert.match(text, /1 mergeada\(s\), 1 aberta\(s\)/);
      assert.equal(reconcileReport({ ...base, check: true }).exitCode, 0, "em dia");
      assert.notEqual(existingReconcileBody(text), null);

      // o trem mergeia a #11437 depois: o relatório volta a ficar defasado
      states[11437] = { state: "CLOSED", comments: [trusted(trainComment(11442))] };
      states[11442] = { state: "MERGED", comments: [] };
      assert.equal(reconcileReport({ ...base, check: true }).exitCode, 1);
      reconcileReport({ ...base, check: false });
      assert.match(readFileSync(reportPath, "utf8"), /2 mergeada\(s\), 0 aberta\(s\)[\s\S]*mergeada via trem #11442/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run-merge-train liga as duas peças: resolve P2/P3 antes dos lotes e reconcilia o relatório no fim", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "run-merge-train.ts"), "utf8");
    assert.match(src, /flags\.has\("resolve-low-severity-threads"\)/);
    assert.match(src, /resolveReviewThreads\(TRAIN_REPO, pr, gh, null, \{ lowSeverityOnly: true \}\)/);
    assert.match(src, /finish\(hasRealFailure \? 1 : 0\)/);
    assert.doesNotMatch(src, /process\.exit\(hasRealFailure/);
  });

  it("falha de gh nunca vira 'nenhuma PR' e não toca o arquivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-11461-"));
    try {
      const reportPath = join(dir, "report.md");
      writeFileSync(reportPath, "orig\n");
      writeFileSync(join(dir, "plan.json"), JSON.stringify({ started_at: "2026-10-28T02:00:00Z", issues: [{ number: 1, in_round: true }] }));
      const r = reconcileReport({ reportPath, planPath: join(dir, "plan.json"), extraPrs: [], discover: true, check: false, gh: () => ({ ok: false, error: "rate limit" }) });
      assert.equal(r.exitCode, 3);
      assert.equal(readFileSync(reportPath, "utf8"), "orig\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
