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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  claimIssueCheckAndSet,
  claimReconciliationHasAdditions,
  claimReleaseMsForKind,
  cleanupReconciledSafeBackups,
  decideClaimReconciliation,
  endSession,
  planClaimReconciliation,
  planSafeBackupCapPrune,
  planSafeBackupCleanup,
  reconcileClaims,
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
  readStateChangedIssues,
  removeForeignPendingFromPlan,
  removePendingFromPlan,
} from "../scripts/lib/state-changed-tracker.ts";
import { loadIssueRepos } from "../scripts/lib/issue-repos.ts";
import { main as reconcileMain } from "../scripts/reconcile-issue-dependencies.ts";
import { ORPHAN_SWEEP_MIN_AGE_MS, planContinuoOrphanSweep } from "../scripts/sweep-continuo-orphan-sessions.ts";
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

  it("studio (sem repo): TODA chamada leva -R vjpixel/diaria-studio — nunca depende do cwd (fleet item 3)", () => {
    const gh = fakeGh();
    const result = routeIssue({ issue: 21, track: "develop", reason: "teste", cwd: "/tmp", ghRun: gh.run });
    assert.equal(result.ok, true, result.error);
    assert.ok(gh.calls.length >= 3);
    for (const c of gh.calls) {
      const i = c.indexOf("-R");
      assert.ok(i !== -1 && c[i + 1] === STUDIO, `chamada sem -R ${STUDIO}: ${c.join(" ")}`);
      // Contrato (self-review 3/6): `-R` só vale pra `gh issue ...`; `gh api` não o aceita.
      assert.equal(c[0], "issue", `chamada gh que não é \`gh issue\`: ${c.join(" ")}`);
    }
  });

  it("--track agendada no diaria-design: as chamadas do wait-until-sync (view -q / edit --body) também levam -R", () => {
    const gh = fakeGh();
    const result = routeIssue({
      issue: 21,
      repo: DESIGN,
      track: "agendada",
      reason: "espera a data",
      until: "2099-01-01",
      cwd: "/tmp",
      ghRun: gh.run,
    });
    assert.equal(result.ok, true, result.error);
    assert.ok(gh.calls.some((c) => c.includes("-q")), "esperava a leitura do corpo do wait-until-sync");
    assert.ok(gh.calls.some((c) => c[1] === "edit" && c.includes("--body")), "esperava a escrita do marcador");
    for (const c of gh.calls) {
      const i = c.indexOf("-R");
      assert.ok(i !== -1 && c[i + 1] === DESIGN, `chamada sem -R ${DESIGN}: ${c.join(" ")}`);
    }
    assert.match(gh.state.body, /aguardando-ate: 2099-01-01/);
  });

  it("mensagem de erro de issue de outro repo usa o rótulo owner/repo#N", () => {
    const run: GhRunFn = () => ({ status: 1, stdout: "", stderr: "gh: not found" });
    const result = routeIssue({ issue: 21, repo: DESIGN, track: "develop", reason: "x", cwd: "/tmp", ghRun: run });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /vjpixel\/diaria-design#21/);
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

// ─── Fleet review do PR #10745 (fixer) ──────────────────────────────────────

function sessionFile(root: string, sessionId: string): string {
  const dir = join(root, "data", "sessions");
  return join(dir, readdirSync(dir).find((f) => f.includes(sessionId) && !f.includes("-safeBackup-") && f.endsWith(".json"))!);
}

describe("#10618 fatia 2 (fleet item 4) — claims de outro repo em reconcile/cleanup/cap-prune", () => {
  const T0 = "2026-10-21T10:00:00.000Z";
  const T1 = "2026-10-21T11:00:00.000Z"; // depois do heartbeat do real

  it("decideClaimReconciliation devolve a claim do design presa só no backup (e respeita a regra #6698)", () => {
    const real = { kind: "develop", machineTag: "h", sessionId: "s", startedAt: T0, lastHeartbeat: T0 } as never;
    const backup = {
      kind: "develop", machineTag: "h", sessionId: "s", startedAt: T0, lastHeartbeat: T1,
      claimed_foreign_issues: ["vjpixel/diaria-design#21"],
      claimed_foreign_issues_at: { "vjpixel/diaria-design#21": T1 },
    } as never;
    const d = decideClaimReconciliation(real, [backup]);
    assert.deepEqual(d.addedIssues, []);
    assert.deepEqual(d.addedForeignIssues, ["vjpixel/diaria-design#21"]);
    assert.equal(claimReconciliationHasAdditions(d), true);
    // Timestamp anterior/igual ao heartbeat do real = removida de propósito (#6698).
    const oldBackup = { ...(backup as object), claimed_foreign_issues_at: { "vjpixel/diaria-design#21": T0 } } as never;
    assert.equal(claimReconciliationHasAdditions(decideClaimReconciliation(real, [oldBackup])), false);
  });

  function setupGroup(prefix: string, backups: number) {
    const root = tmpRoot(prefix);
    registerSession(root, "develop", "sess-r", { tag: "host", startedAt: T0 });
    const real = sessionFile(root, "sess-r");
    const record = JSON.parse(readFileSync(real, "utf8"));
    writeFileSync(real, JSON.stringify({ ...record, lastHeartbeat: T0 }));
    const backupPaths: string[] = [];
    for (let i = 1; i <= backups; i++) {
      const bp = real.replace(/\.json$/, `-safeBackup-000${i}.json`);
      const withClaim = i === 1;
      writeFileSync(
        bp,
        JSON.stringify({
          ...record,
          lastHeartbeat: T0,
          ...(withClaim
            ? {
                claimed_foreign_issues: ["vjpixel/diaria-design#21"],
                claimed_foreign_issues_at: { "vjpixel/diaria-design#21": T1 },
              }
            : {}),
        }),
      );
      backupPaths.push(bp);
    }
    return { root, real, backupPaths };
  }

  it("planSafeBackupCleanup: backup com claim do design NÃO vira removable (antes virava e a claim sumia)", () => {
    const { root } = setupGroup("cleanup", 1);
    const plan = planSafeBackupCleanup(root, { now: Date.parse(T1) });
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.action, "pending-reconciliation", plan[0]!.reason);
    const applied = cleanupReconciledSafeBackups(root, { now: Date.parse(T1) });
    assert.equal(applied[0]!.action, "pending-reconciliation");
  });

  it("planSafeBackupCapPrune: o único backup com a claim do design é preservado mesmo acima do cap", () => {
    const { root, backupPaths } = setupGroup("capprune", 3);
    // O backup com a claim é o mais antigo (o 1º candidato a podar).
    const plan = planSafeBackupCapPrune(root, { now: Date.parse(T1), capPerGroup: 1 });
    const removed = plan.flatMap((r) => r.removed.map((e) => e.path));
    assert.ok(!removed.includes(backupPaths[0]!), `podou o backup com a claim do design: ${JSON.stringify(removed)}`);
  });

  it("reconcileClaims grava a claim do design no real (claimed_foreign_issues, _at, _ever)", () => {
    const { root, real } = setupGroup("reconcile", 1);
    const plan = planClaimReconciliation(root);
    const group = plan.find((e) => e.realPath === real)!;
    assert.equal(group.action, "reconciled", group.reason);
    assert.deepEqual(group.addedForeignIssues, ["vjpixel/diaria-design#21"]);
    reconcileClaims(root);
    const after = JSON.parse(readFileSync(real, "utf8"));
    assert.deepEqual(after.claimed_foreign_issues, ["vjpixel/diaria-design#21"]);
    assert.equal(after.claimed_foreign_issues_at["vjpixel/diaria-design#21"], T1);
    assert.deepEqual(after.claimed_foreign_issues_ever, ["vjpixel/diaria-design#21"]);
    // Depois de reconciliado, o grupo deixa de segurar a limpeza.
    assert.equal(planSafeBackupCleanup(root, { now: Date.parse(T1) })[0]!.action, "removable");
  });
});

describe("#10618 fatia 2 (fleet itens 5, 12, 13) — sweep, lifecycle e janela de retenção", () => {
  it("sweep do contínuo: sessão com claim só do design é mantida", () => {
    const now = Date.parse("2026-10-21T12:00:00.000Z");
    const old = new Date(now - ORPHAN_SWEEP_MIN_AGE_MS - 60_000).toISOString();
    const [c] = planContinuoOrphanSweep(
      [
        {
          kind: "continuo",
          machineTag: "300",
          sessionId: "hermes-cron-job-t1",
          startedAt: old,
          lastHeartbeat: old,
          claimed_issues: [],
          claimed_foreign_issues: ["vjpixel/diaria-design#21"],
        } as never,
      ],
      { jobId: "job", localTag: "300", now, excludeSessionId: "hermes-cron-job-atual" },
    );
    assert.equal(c!.action, "keep");
    assert.match(c!.reason, /vjpixel\/diaria-design#21/);
  });

  it("evento de lifecycle do end leva as claims de outro repo", () => {
    const root = tmpRoot("lifecycle");
    const now = new Date().toISOString();
    registerSession(root, "develop", "sess-l", { tag: "host", startedAt: now });
    claimIssueCheckAndSet(root, "develop", "sess-l", { repo: DESIGN, number: 21 }, "host", now);
    endSession(root, "develop", "sess-l", "host");
    const lines = readFileSync(join(root, "data", "session-lifecycle.jsonl"), "utf8").trim().split("\n");
    const ev = lines.map((l) => JSON.parse(l)).find((e) => e.sessionId === "sess-l");
    assert.deepEqual(ev.claimed_foreign_issues, ["vjpixel/diaria-design#21"]);
    assert.deepEqual(ev.claimed_foreign_issues_ever, ["vjpixel/diaria-design#21"]);
  });

  it("janela de retenção: claim de outro repo de sessão interactive ociosa é liberada como a do studio", () => {
    const root = tmpRoot("retention");
    const t0 = Date.parse("2026-10-21T10:00:00.000Z");
    const iso = new Date(t0).toISOString();
    registerSession(root, "interactive", "sess-i", { tag: "host", startedAt: iso });
    claimIssueCheckAndSet(root, "interactive", "sess-i", { repo: DESIGN, number: 21 }, "host", iso);
    claimIssueCheckAndSet(root, "interactive", "sess-i", 21, "host", iso);
    const real = sessionFile(root, "sess-i");
    writeFileSync(real, JSON.stringify({ ...JSON.parse(readFileSync(real, "utf8")), lastHeartbeat: iso }));
    const inside = t0 + 60_000;
    assert.equal(isIssueClaimedByOther(root, { repo: DESIGN, number: 21 }, "outra", inside)?.sessionId, "sess-i");
    const outside = t0 + claimReleaseMsForKind("interactive") + 60_000;
    const rec = listActiveSessions(root, outside).find((x) => x.sessionId === "sess-i");
    assert.ok(rec, "sessão ainda listada (dentro do maxAge), só com as claims liberadas");
    assert.deepEqual(rec.claimed_foreign_issues_effective, []);
    assert.deepEqual(rec.claimed_issues_effective, []);
    assert.equal(isIssueClaimedByOther(root, { repo: DESIGN, number: 21 }, "outra", outside), null);
  });
});

describe("#10618 fatia 2 (fleet itens 6, 7, 9) — identidade ilegível e formas do studio", () => {
  it("state_changed_issues: strings do studio contam como número; entrada ilegível bloqueia e sobrevive à reescrita", () => {
    const root = tmpRoot("scforms");
    const planPath = join(root, "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({ state_changed_issues: ["vjpixel/diaria-studio#21", "#22", "23", { ref: "vjpixel/diaria-studio#24" }, "lixo"] }),
    );
    assert.deepEqual(checkStateChangedPending(planPath), {
      status: "pending",
      issues: [21, 22, 23, 24],
      unreadable: ['"lixo"'],
    });
    // Remover a #21 (que estava como string qualificada) a remove de fato.
    removePendingFromPlan(planPath, 21);
    const after = JSON.parse(readFileSync(planPath, "utf8")).state_changed_issues;
    assert.deepEqual(after, [22, 23, 24, "lixo"]);
    // Só a ilegível sobrando: o gate continua bloqueando, nunca "ok".
    for (const n of [22, 23, 24]) removePendingFromPlan(planPath, n);
    assert.deepEqual(checkStateChangedPending(planPath), { status: "pending", issues: [], unreadable: ['"lixo"'] });
    assert.deepEqual(readStateChangedIssues({ state_changed_issues: [5, "5", "#5"] }), [5]);
  });

  it("target_set com identidade ilegível vira missing, nunca ok", () => {
    assert.deepEqual(checkTargetSetCoverageFromPlan({ goal: { target_set: ["lixo"] }, issues: [] }), {
      status: "missing",
      issues: [],
      unreadable: ['"lixo"'],
    });
    assert.deepEqual(
      checkTargetSetCoverageFromPlan({
        goal: { target_set: [21, { number: 3, repo: "nao e slug" }] },
        issues: [{ number: 21, status: "mergeada" }],
      }),
      { status: "missing", issues: [], unreadable: ['{"number":3,"repo":"nao e slug"}'] },
    );
  });

  it("normalizeIssues: chave qualificada dá number do #N (sem NaN); findRetracked aceita { ref } do studio sem number", () => {
    const out = normalizeIssues<{ number: number; ref?: string; status?: string }>({
      issues: { "vjpixel/diaria-design#21": { status: "pulada" } },
    });
    assert.equal(out[0]!.number, 21);
    assert.equal(out[0]!.ref, "vjpixel/diaria-design#21");
    const plan = { issues: [{ ref: "vjpixel/diaria-studio#30", status: "pulada", motivo: "deixado-para-o-300" }] };
    const open = [{ number: 30, labels: ["develop-track"], body: "" }];
    assert.deepEqual(findRetrackedUnworkedIssues(plan as never, open).map((r) => r.number), [30]);
  });
});

describe("#10618 fatia 2 (fleet item 8) — loadIssueRepos avisa no fallback", () => {
  it("config com JSON inválido ou slug ilegível → aviso, nunca encolhe a allowlist em silêncio", () => {
    const warns: string[] = [];
    const bad = tmpRoot("badcfg");
    writeFileSync(join(bad, "platform.config.json"), "{ nao e json");
    assert.deepEqual(loadIssueRepos(bad, (m) => warns.push(m)), [STUDIO]);
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /JSON inválido/);
    const slug = tmpRoot("badslug");
    writeFileSync(join(slug, "platform.config.json"), JSON.stringify({ issue_repos: [STUDIO, "lixo", DESIGN] }));
    warns.length = 0;
    assert.deepEqual(loadIssueRepos(slug, (m) => warns.push(m)), [STUDIO, DESIGN]);
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /lixo/);
    // Arquivo AUSENTE: comportamento de sempre, sem aviso.
    warns.length = 0;
    assert.deepEqual(loadIssueRepos(tmpRoot("nocfg"), (m) => warns.push(m)), [STUDIO]);
    assert.equal(warns.length, 0);
  });
});

describe("#10618 fatia 2 (fleet item 3/13) — reconcile-issue-dependencies só no studio, com -R", () => {
  it("fetch restrito ao default, issue do design ignorada, toda chamada gh com -R vjpixel/diaria-studio", async () => {
    const calls: string[][] = [];
    const ghRun: GhRunFn = (args) => {
      calls.push(args);
      if (args[1] === "view") return { status: 0, stdout: JSON.stringify({ state: "CLOSED" }), stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    let fetchOpts: unknown;
    const fetchIssues = ((_cwd: string, opts: unknown) => {
      fetchOpts = opts;
      return {
        issues: [
          { repo: STUDIO, ref: "vjpixel/diaria-studio#40", number: 40, labels: ["dependencia-aberta"], body: "<!-- depends-on: #41 -->" },
          { repo: DESIGN, ref: "vjpixel/diaria-design#21", number: 21, labels: [], body: "<!-- depends-on: #22 -->" },
        ],
      };
    }) as never;
    const log = console.log;
    console.log = () => {};
    try {
      await reconcileMain(["--apply"], { ghRun, fetchIssues, cwd: "/tmp" });
    } finally {
      console.log = log;
    }
    assert.deepEqual(fetchOpts, { repos: [STUDIO] });
    assert.ok(calls.length >= 2, JSON.stringify(calls));
    for (const c of calls) {
      const i = c.indexOf("-R");
      assert.ok(i !== -1 && c[i + 1] === STUDIO, `chamada sem -R ${STUDIO}: ${c.join(" ")}`);
      assert.ok(!c.includes(DESIGN), c.join(" "));
    }
    // A dependência do design (#22) nunca foi consultada.
    assert.ok(!calls.some((c) => c[2] === "22"), JSON.stringify(calls));
    assert.ok(calls.some((c) => c[1] === "edit" && c[2] === "40" && c.includes("--remove-label")));
  });
});

describe("#10618 fatia 2 (fleet item 13) — CLIs com owner/repo#N", () => {
  const SR_CLI = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));
  const SC_CLI = fileURLToPath(new URL("../scripts/check-state-changed-pending.ts", import.meta.url));
  const TSX = pathToFileURL(fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))).href;
  function cli(script: string, cwd: string, args: string[]) {
    const r = spawnSync(process.execPath, ["--import", TSX, script, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("session-registry: claim-issue/is-claimed/unclaim-issue com --issue vjpixel/diaria-design#21", () => {
    const root = tmpRoot("srcli");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "diaria-studio" }));
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ issue_repos: [STUDIO, DESIGN] }));
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    assert.equal(cli(SR_CLI, root, ["register", "--kind", "develop", "--session-id", "cli-a"]).status, 0);
    const claim = cli(SR_CLI, root, ["claim-issue", "--kind", "develop", "--session-id", "cli-a", "--issue", "vjpixel/diaria-design#21"]);
    assert.equal(claim.status, 0, claim.stderr + claim.stdout);
    const design = cli(SR_CLI, root, ["is-claimed", "--issue", "vjpixel/diaria-design#21", "--session-id", "outra"]);
    assert.equal(JSON.parse(design.stdout.trim()).claimed, true, design.stdout);
    const studio = cli(SR_CLI, root, ["is-claimed", "--issue", "21", "--session-id", "outra"]);
    assert.equal(JSON.parse(studio.stdout.trim()).claimed, false, studio.stdout);
    const fork = cli(SR_CLI, root, ["claim-issue", "--kind", "develop", "--session-id", "cli-a", "--issue", "fork/x#1"]);
    assert.notEqual(fork.status, 0);
    const un = cli(SR_CLI, root, ["unclaim-issue", "--kind", "develop", "--session-id", "cli-a", "--issue", "vjpixel/diaria-design#21"]);
    assert.equal(un.status, 0, un.stderr + un.stdout);
    assert.match(un.stdout, /vjpixel\/diaria-design#21 liberada/);
  });

  it("check-state-changed-pending: --add-pending/--remove-pending owner/repo#N e o gate lista a ref", () => {
    const root = tmpRoot("sccli");
    const planPath = join(root, "plan.json");
    writeFileSync(planPath, JSON.stringify({ state_changed_issues: [] }));
    assert.equal(cli(SC_CLI, root, ["--add-pending", "vjpixel/diaria-design#21", "--plan", planPath]).status, 0);
    const gate = cli(SC_CLI, root, ["--plan", planPath, "--skip-convergence"]);
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /vjpixel\/diaria-design#21/);
    assert.equal(cli(SC_CLI, root, ["--remove-pending", "vjpixel/diaria-design#21", "--plan", planPath]).status, 0);
    assert.equal(cli(SC_CLI, root, ["--plan", planPath, "--skip-convergence"]).status, 0);
  });
});
