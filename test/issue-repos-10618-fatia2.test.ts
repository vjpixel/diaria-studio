/**
 * #10618, fatia 2 — issues do vjpixel/diaria-design nas rodadas:
 *   1. `session-registry`: claim/is-claimed/unclaim de `owner/repo#N` de repo
 *      da allowlist, SEM colidir com o mesmo número do diaria-studio
 *      (`claimed_foreign_issues`, separado de `claimed_issues: number[]`);
 *   2. `plan.json`: gates de fim de rodada nunca leem uma entrada de outro
 *      repo como número do diaria-studio (`plan-issue-ref.ts`);
 *   3. `route-issue.ts`: `--issue owner/repo#N` escopa todo `gh` com `-R`.
 * (O fetch multi-repo da triagem é coberto em `test/issue-triage-fetch.test.ts`.)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimIssueCheckAndSet,
  claimTargetLabel,
  isIssueClaimedByOther,
  isIssueClaimedByActiveSession,
  listActiveSessions,
  registerSession,
  requireClaimIssue,
  unclaimIssue,
} from "../scripts/lib/session-registry.ts";
import {
  isForeignPlanEntry,
  planEntryKey,
  studioNumberOfPlanEntry,
} from "../scripts/lib/plan-issue-ref.ts";
import { normalizeIssues } from "../scripts/lib/plan-issues-normalize.ts";
import {
  addForeignPendingToPlan,
  addPendingToPlan,
  checkStateChangedPending,
  collectKnownIssueNumbers,
  extractIssueKeys,
  extractIssueNumbers,
  findRetrackedUnworkedIssues,
  removeForeignPendingFromPlan,
  removePendingFromPlan,
} from "../scripts/lib/state-changed-tracker.ts";
import { checkTargetSetCoverageFromPlan, findMissingTargetSetCoverage } from "../scripts/lib/develop-target-set-coverage.ts";
import { parseArgs as parseRouteIssueArgs, routeIssue, type GhRunFn } from "../scripts/route-issue.ts";

const STUDIO = "vjpixel/diaria-studio";
const DESIGN = "vjpixel/diaria-design";
const ALLOW = [STUDIO, DESIGN];
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function tmpRoot(prefix: string): string {
  const r = mkdtempSync(join(tmpdir(), `issue-repos-10618-f2-${prefix}-`));
  roots.push(r);
  return r;
}

describe("#10618 fatia 2 — claims de outro repo no session-registry", () => {
  it("requireClaimIssue: studio vira número; repo da allowlist vira IssueRef; fora da allowlist recusa", () => {
    assert.equal(requireClaimIssue({ issue: "21" }, new Set(), ALLOW), 21);
    assert.equal(requireClaimIssue({ issue: "vjpixel/diaria-studio#21" }, new Set(), ALLOW), 21);
    assert.deepEqual(requireClaimIssue({ issue: "vjpixel/diaria-design#21" }, new Set(), ALLOW), {
      repo: DESIGN,
      number: 21,
    });
    assert.deepEqual(requireClaimIssue({ issue: "21", repo: DESIGN }, new Set(), ALLOW), { repo: DESIGN, number: 21 });
    assert.throws(() => requireClaimIssue({ issue: "vjpixel/outro-repo#21" }, new Set(), ALLOW), /issue_repos/);
    assert.throws(() => requireClaimIssue({ issue: "fork/diaria-design#21" }, new Set(), ALLOW), /issue_repos/);
    assert.throws(() => requireClaimIssue({ issue: "abc" }, new Set(), ALLOW), /--issue/);
    assert.throws(
      () => requireClaimIssue({ issue: "vjpixel/diaria-studio#5", repo: DESIGN }, new Set(), ALLOW),
      /repos diferentes/,
    );
  });

  it("claimTargetLabel: #N legado e owner/repo#N", () => {
    assert.equal(claimTargetLabel(21), "#21");
    assert.equal(claimTargetLabel({ repo: DESIGN, number: 21 }), "vjpixel/diaria-design#21");
    assert.equal(claimTargetLabel({ repo: STUDIO, number: 21 }), "#21");
  });

  it("design#21 e studio#21 NÃO colidem: claim, is-claimed e unclaim independentes", () => {
    const root = tmpRoot("claims");
    const now = new Date().toISOString();
    registerSession(root, "develop", "sess-a", { tag: "host", startedAt: now });
    registerSession(root, "overnight", "sess-b", { tag: "host", startedAt: now });

    // Sessão A pega o diaria-design#21.
    const a = claimIssueCheckAndSet(root, "develop", "sess-a", { repo: DESIGN, number: 21 }, "host", now);
    assert.equal(a.reason, "claimed");

    // O diaria-studio#21 continua livre — a sessão B pega sem `force`.
    assert.equal(isIssueClaimedByOther(root, 21, "sess-b"), null);
    const b = claimIssueCheckAndSet(root, "overnight", "sess-b", 21, "host", now);
    assert.equal(b.reason, "claimed");

    // O design#21 segue da sessão A: B é recusada.
    const bDesign = claimIssueCheckAndSet(root, "overnight", "sess-b", { repo: DESIGN, number: 21 }, "host", now);
    assert.equal(bDesign.reason, "blocked-by-other");
    assert.equal(bDesign.blockedBy?.sessionId, "sess-a");
    assert.equal(isIssueClaimedByOther(root, { repo: DESIGN, number: 21 }, "sess-b")?.sessionId, "sess-a");
    assert.equal(isIssueClaimedByActiveSession(root, { repo: DESIGN, number: 21 }, "sess-b")?.sessionId, "sess-a");

    // Ref qualificada do studio é a MESMA issue que o número legado.
    assert.equal(isIssueClaimedByOther(root, { repo: STUDIO, number: 21 }, "sess-a")?.sessionId, "sess-b");

    // Armazenamento: número legado em `claimed_issues`, ref em `claimed_foreign_issues`.
    const active = listActiveSessions(root);
    const recA = active.find((s) => s.sessionId === "sess-a")!;
    const recB = active.find((s) => s.sessionId === "sess-b")!;
    assert.deepEqual(recA.claimed_issues ?? [], []);
    assert.deepEqual(recA.claimed_foreign_issues, ["vjpixel/diaria-design#21"]);
    assert.deepEqual(recA.claimed_foreign_issues_effective, ["vjpixel/diaria-design#21"]);
    assert.ok(recA.claimed_foreign_issues_at?.["vjpixel/diaria-design#21"]);
    assert.deepEqual(recB.claimed_issues, [21]);
    assert.deepEqual(recB.claimed_foreign_issues ?? [], []);

    // Re-claim da mesma ref = already-own, timestamp preservado (#6436).
    const firstAt = recA.claimed_foreign_issues_at!["vjpixel/diaria-design#21"];
    const again = claimIssueCheckAndSet(root, "develop", "sess-a", { repo: DESIGN, number: 21 }, "host", new Date(Date.now() + 1000).toISOString());
    assert.equal(again.reason, "already-own");
    const recA2 = listActiveSessions(root).find((s) => s.sessionId === "sess-a")!;
    assert.equal(recA2.claimed_foreign_issues_at!["vjpixel/diaria-design#21"], firstAt);

    // Unclaim do design#21 pela sessão B (que não o tem) é no-op; pela A, libera
    // só o design — o studio#21 da B continua reivindicado.
    assert.equal(unclaimIssue(root, "overnight", "sess-b", { repo: DESIGN, number: 21 }, "host").reason, "no-op-not-claimed");
    assert.equal(unclaimIssue(root, "develop", "sess-a", 21, "host").reason, "no-op-not-claimed");
    assert.equal(unclaimIssue(root, "develop", "sess-a", { repo: DESIGN, number: 21 }, "host").reason, "unclaimed");
    assert.equal(isIssueClaimedByOther(root, { repo: DESIGN, number: 21 }, "sess-b"), null);
    assert.equal(isIssueClaimedByOther(root, 21, "sess-a")?.sessionId, "sess-b");
    const recA3 = listActiveSessions(root).find((s) => s.sessionId === "sess-a")!;
    assert.deepEqual(recA3.claimed_foreign_issues, []);
    assert.equal(recA3.claimed_foreign_issues_at?.["vjpixel/diaria-design#21"], undefined);
    assert.deepEqual(recA3.claimed_foreign_issues_ever, ["vjpixel/diaria-design#21"]);
  });

  it("claim de outro repo que só existe numa cópia -safeBackup- entra na união (fail-safe)", () => {
    const root = tmpRoot("backup");
    const now = new Date().toISOString();
    registerSession(root, "develop", "sess-c", { tag: "host", startedAt: now });
    const dir = join(root, "data", "sessions");
    const real = readdirSync(dir).find((f) => f.includes("sess-c") && f.endsWith(".json"))!;
    const record = JSON.parse(readFileSync(join(dir, real), "utf8"));
    writeFileSync(
      join(dir, real.replace(/\.json$/, "-safeBackup-0001.json")),
      JSON.stringify({ ...record, claimed_foreign_issues: ["vjpixel/diaria-design#7"], claimed_foreign_issues_at: { "vjpixel/diaria-design#7": now } }),
    );
    assert.equal(isIssueClaimedByOther(root, { repo: DESIGN, number: 7 }, "outra")?.sessionId, "sess-c");
    // E o studio#7 continua livre.
    assert.equal(isIssueClaimedByOther(root, 7, "outra"), null);
    // Unclaim limpa o backup também.
    assert.equal(unclaimIssue(root, "develop", "sess-c", { repo: DESIGN, number: 7 }, "host").reason, "unclaimed");
    assert.equal(isIssueClaimedByOther(root, { repo: DESIGN, number: 7 }, "outra"), null);
  });
});

describe("#10618 fatia 2 — identidade de entrada do plan.json", () => {
  it("planEntryRef: número = studio; ref/repo de outro repo nunca vira número do studio", () => {
    assert.equal(studioNumberOfPlanEntry(21), 21);
    assert.equal(studioNumberOfPlanEntry({ number: 21 }), 21);
    assert.equal(studioNumberOfPlanEntry({ number: 21, repo: STUDIO }), 21);
    assert.equal(studioNumberOfPlanEntry("vjpixel/diaria-studio#21"), 21);
    assert.equal(studioNumberOfPlanEntry({ number: 21, repo: DESIGN }), null);
    assert.equal(studioNumberOfPlanEntry({ number: 21, ref: "vjpixel/diaria-design#21" }), null);
    assert.equal(studioNumberOfPlanEntry("vjpixel/diaria-design#21"), null);
    // `repo` presente mas ilegível: identidade desconhecida, nunca o default.
    assert.equal(studioNumberOfPlanEntry({ number: 21, repo: "lixo" }), null);
    assert.equal(planEntryKey({ number: 21, repo: DESIGN }), "vjpixel/diaria-design#21");
    assert.equal(isForeignPlanEntry({ number: 21, repo: DESIGN }), true);
    assert.equal(isForeignPlanEntry(21), false);
  });

  it("normalizeIssues: dict com chave qualificada preserva a identidade como `ref`", () => {
    const out = normalizeIssues<{ number: number; ref?: string; status?: string }>({
      issues: { "4800": { status: "mergeada" }, "vjpixel/diaria-design#21": { number: 21, status: "mergeada" } },
    });
    const studio = out.find((i) => i.number === 4800)!;
    assert.equal(studio.ref, undefined);
    const design = out.find((i) => i.ref === "vjpixel/diaria-design#21")!;
    assert.equal(studioNumberOfPlanEntry(design), null);
  });

  it("extractIssueNumbers ignora entrada de outro repo; extractIssueKeys qualifica todas", () => {
    const value = [21, { number: 22 }, "vjpixel/diaria-design#21", { number: 23, repo: DESIGN }];
    assert.deepEqual(extractIssueNumbers(value), [21, 22]);
    assert.deepEqual(extractIssueKeys(value), [
      "vjpixel/diaria-studio#21",
      "vjpixel/diaria-studio#22",
      "vjpixel/diaria-design#21",
      "vjpixel/diaria-design#23",
    ]);
  });

  it("collectKnownIssueNumbers: design#21 no plano NÃO torna o studio#21 conhecido (convergência)", () => {
    const known = collectKnownIssueNumbers({
      goal: { target_set: ["vjpixel/diaria-design#21"] },
      issues: [{ number: 21, repo: DESIGN, status: "mergeada" }],
    });
    assert.equal(known.has(21), false);
  });

  it("findRetrackedUnworkedIssues: entrada de outro repo nunca casa com a issue aberta do studio de mesmo número", () => {
    const plan = { issues: [{ number: 21, repo: DESIGN, status: "pulada", motivo: "deixado-para-o-300" }] };
    const open = [{ number: 21, labels: ["develop-track"], body: "" }];
    assert.deepEqual(findRetrackedUnworkedIssues(plan, open), []);
    // Controle: a mesma entrada sem `repo` (= studio) é pega.
    const planStudio = { issues: [{ number: 21, status: "pulada", motivo: "deixado-para-o-300" }] };
    assert.equal(findRetrackedUnworkedIssues(planStudio, open).length, 1);
  });

  it("target_set: design#21 coberto só por entrada do design; entrada do design não cobre o studio#21", () => {
    // Regressão do furo: `{ number: 21, repo: design }` cobria o studio#21.
    assert.deepEqual(findMissingTargetSetCoverage([21], [{ number: 21, repo: DESIGN, status: "mergeada" } as never]), [21]);
    assert.deepEqual(
      checkTargetSetCoverageFromPlan({
        goal: { target_set: [21, "vjpixel/diaria-design#21"] },
        issues: [{ number: 21, repo: DESIGN, status: "mergeada" }],
      }),
      { status: "missing", issues: [21] },
    );
    assert.deepEqual(
      checkTargetSetCoverageFromPlan({
        goal: { target_set: [21, "vjpixel/diaria-design#21"] },
        issues: [{ number: 21, status: "mergeada" }],
      }),
      { status: "missing", issues: [], foreign: ["vjpixel/diaria-design#21"] },
    );
    assert.deepEqual(
      checkTargetSetCoverageFromPlan({
        goal: { target_set: [21, "vjpixel/diaria-design#21"] },
        issues: { "21": { status: "mergeada" }, "vjpixel/diaria-design#21": { status: "pulada" } },
      }),
      { status: "ok" },
    );
  });

  it("state_changed_issues: pendência de outro repo bloqueia o gate e add/remove preserva os dois espaços", () => {
    const root = tmpRoot("plan");
    const planPath = join(root, "plan.json");
    writeFileSync(planPath, JSON.stringify({ state_changed_issues: [] }));
    addPendingToPlan(planPath, 21);
    addForeignPendingToPlan(planPath, "vjpixel/diaria-design#21");
    addForeignPendingToPlan(planPath, "vjpixel/diaria-design#21"); // idempotente
    assert.deepEqual(JSON.parse(readFileSync(planPath, "utf8")).state_changed_issues, [21, "vjpixel/diaria-design#21"]);
    assert.deepEqual(checkStateChangedPending(planPath), {
      status: "pending",
      issues: [21],
      foreign: ["vjpixel/diaria-design#21"],
    });
    // Remover o studio#21 NÃO apaga a pendência do design (antes a regravação filtrava números).
    removePendingFromPlan(planPath, 21);
    assert.deepEqual(checkStateChangedPending(planPath), {
      status: "pending",
      issues: [],
      foreign: ["vjpixel/diaria-design#21"],
    });
    removeForeignPendingFromPlan(planPath, "vjpixel/diaria-design#21");
    assert.deepEqual(checkStateChangedPending(planPath), { status: "ok" });
  });
});

describe("#10618 fatia 2 — route-issue.ts com --issue owner/repo#N", () => {
  function fakeGh() {
    const state = { labels: [] as string[], body: "", comments: [] as string[] };
    const calls: string[][] = [];
    const run: GhRunFn = (args) => {
      calls.push(args);
      if (args[1] === "view") {
        if (args.includes("-q")) return { status: 0, stdout: `${state.body}\n`, stderr: "" };
        return {
          status: 0,
          stdout: JSON.stringify({
            labels: state.labels.map((name) => ({ name })),
            body: state.body,
            state: "OPEN",
            comments: state.comments.map((body) => ({ body })),
          }),
          stderr: "",
        };
      }
      if (args[1] === "edit") {
        const add = args.indexOf("--add-label");
        if (add !== -1) for (const l of args[add + 1]!.split(",")) if (!state.labels.includes(l)) state.labels.push(l);
        const rm = args.indexOf("--remove-label");
        if (rm !== -1) state.labels = state.labels.filter((l) => !args[rm + 1]!.split(",").includes(l));
        const b = args.indexOf("--body");
        if (b !== -1) state.body = args[b + 1]!;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "comment") {
        state.comments.push(args[args.indexOf("--body") + 1]!);
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    return { run, calls, state };
  }

  it("parseArgs: N = studio (sem repo); owner/repo#N da allowlist leva repo; fora da allowlist é erro", () => {
    const studio = parseRouteIssueArgs(["--issue", "42", "--track", "develop"]);
    assert.ok(!("error" in studio));
    assert.equal((studio as { repo?: string }).repo, undefined);
    assert.equal((studio as { issue: number }).issue, 42);
    const design = parseRouteIssueArgs(["--issue", "vjpixel/diaria-design#21", "--track", "develop"]);
    assert.ok(!("error" in design), JSON.stringify(design));
    assert.equal((design as { repo?: string }).repo, DESIGN);
    assert.equal((design as { issue: number }).issue, 21);
    const outro = parseRouteIssueArgs(["--issue", "fork/diaria-design#21", "--track", "develop"]);
    assert.ok("error" in outro);
    assert.match((outro as { error: string }).error, /issue_repos/);
    assert.ok("error" in parseRouteIssueArgs(["--issue", "abc", "--track", "develop"]));
  });

  it("repo de outro repo: TODA chamada gh leva -R owner/repo", () => {
    const gh = fakeGh();
    const result = routeIssue({ issue: 21, repo: DESIGN, track: "develop", reason: "teste", cwd: "/tmp", ghRun: gh.run });
    assert.equal(result.ok, true, result.error);
    assert.ok(gh.calls.length >= 3);
    for (const c of gh.calls) {
      const i = c.indexOf("-R");
      assert.ok(i !== -1 && c[i + 1] === DESIGN, `chamada sem -R ${DESIGN}: ${c.join(" ")}`);
    }
  });

  it("controle: sem repo (studio) nenhuma chamada leva -R — comportamento de sempre", () => {
    const gh = fakeGh();
    const result = routeIssue({ issue: 21, track: "develop", reason: "teste", cwd: "/tmp", ghRun: gh.run });
    assert.equal(result.ok, true, result.error);
    for (const c of gh.calls) assert.ok(!c.includes("-R"), c.join(" "));
  });

  it("--depends-on com issue de outro repo é recusado antes de qualquer I/O", () => {
    const gh = fakeGh();
    const result = routeIssue({
      issue: 21,
      repo: DESIGN,
      track: "bloqueada",
      reason: "espera outra",
      dependsOn: 5,
      cwd: "/tmp",
      ghRun: gh.run,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /depends-on/);
    assert.equal(gh.calls.length, 0);
  });
});
