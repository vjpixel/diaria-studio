/**
 * #10618, fatia 4 — o diaria-design ligado por padrão nas rodadas.
 *
 * Cobre o que esta fatia mudou de comportamento:
 * - convergência (Fase 1 e Fase 2) varre todo repo de `issue_repos`, mesmo
 *   sem entrada dele no plano (o pré-requisito da virada do default);
 * - gates que liam `number` cru (`check-exec-track-coverage`,
 *   `check-overnight-plan-motivo`, ondas, timeline) rotulam por chave;
 * - preflights por issue (`check-issue-duplicate-preflight`,
 *   `check-issue-open-pr`, `check-trade-off-label-cleared`) aceitam
 *   `owner/repo#N` e consultam o repo da issue;
 * - `pr-em-voo` com PR citado em OUTRO repo;
 * - os três gates que pulavam a entrada do design com aviso
 *   (`check-develop-label-cleared`, `check-overnight-comment-coverage`,
 *   `check-decision-label-drift-gate`) passam a avaliá-la no repo dela;
 * - painel `/triagem` lendo todos os repos de `issue_repos`;
 * - claims de outro repo no beacon e no watch do contínuo;
 * - `sync-issue-labels.ts` (lista derivada do código, idempotente).
 *
 * Todo CLI roda com `cwd` num diretório temporário com o próprio
 * `platform.config.json` (fixture), nunca o do checkout, e um `gh` fake que
 * loga o argv e responde por (comando, repo, número, campos).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { convergenceReposOfPlan, type PlanWithGoal } from "../scripts/lib/state-changed-tracker.ts";
import { scanForeignConvergence } from "../scripts/check-state-changed-pending.ts";
import { findMissingExecTrack, checkExecTrackCoverageFromPlan } from "../scripts/lib/develop-exec-track-coverage.ts";
import { checkOvernightPlanMotivosFromIssues } from "../scripts/lib/overnight-plan-motivo.ts";
import { buildWaveRecord, findDuplicateWave } from "../scripts/lib/overnight-waves.ts";
import { computeWaveUnitDurations } from "../scripts/lib/overnight-waves-report.ts";
import { parseUnits } from "../scripts/record-overnight-wave.ts";
import { buildTimelineRows } from "../scripts/render-overnight-timeline.ts";
import { main as duplicatePreflightMain } from "../scripts/check-issue-duplicate-preflight.ts";
import { main as openPrMain } from "../scripts/check-issue-open-pr.ts";
import { fetchRepoCommitsForIssue } from "../scripts/lib/master-commit-fetch.ts";
import {
  extractPrRef,
  findStaleBlocks,
  type BlockStalenessConsultor,
  type BlockStalenessPlanIssue,
} from "../scripts/lib/block-staleness.ts";
import {
  groupPlanEntriesByRepo,
  isLocalViewPlanEntry,
  labelInRepo,
  localNumberOfPlanEntry,
  planEntryKey,
  studioNumberOfPlanEntry,
} from "../scripts/lib/plan-issue-ref.ts";
import { requireStudioIssueNumber } from "../scripts/lib/issue-key.ts";
import { checkDevelopLabelCleared } from "../scripts/lib/develop-label-gate.ts";
import { normalizeIssues, type IssuesBearing } from "../scripts/lib/plan-issues-normalize.ts";
import { attachClaims, clearTriageCache, fetchTriageData, parseIssues, type GhRunFn } from "../scripts/studio-ui/studio-issues.ts";
// TS7016 — hook `.mjs` puro sem `.d.ts` (mesmo padrão dos testes que importam
// de `scripts/studio-ui/public/*.js`): arquivo de teste NOVO suprime localmente.
// @ts-expect-error TS7016
import { buildBeaconRecord } from "../.claude/hooks/session-beacon.mjs";
import { planLabelSync, requiredIssueLabels } from "../scripts/lib/issue-label-sync.ts";
import { resolvePrTargetRepo, resolveRepoFlag } from "../scripts/lib/issue-repos.ts";
import { main as syncLabelsMain, type GhRunner } from "../scripts/sync-issue-labels.ts";
import { ROUTABLE_LABELS } from "../scripts/lib/issue-route.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DESIGN = "vjpixel/diaria-design";
const STUDIO = "vjpixel/diaria-studio";
/** `--import tsx` resolve a partir do cwd; o cwd destes CLIs é um tmp sem node_modules. */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const tmpRoots: string[] = [];
afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      // No Windows o gh.exe fake às vezes ainda segura o diretório.
      console.warn(`[issue-repos-10618-fatia4.test] cleanup residual de ${dir}: ${(e as Error).message}`);
    }
  }
});

/** Diretório temporário com `platform.config.json` próprio. */
function tmpRepoRoot(issueRepos: string[] = [STUDIO, DESIGN]): string {
  const dir = mkdtempSync(join(tmpdir(), "fatia4-"));
  tmpRoots.push(dir);
  writeFileSync(join(dir, "platform.config.json"), JSON.stringify({ issue_repos: issueRepos }));
  return dir;
}

/**
 * `gh` fake: loga o argv e responde por chave `{cmd}_{sub}_{repo}_{n|list}_{json}`
 * (repo = `default` sem `-R`). Chave sem resposta → exit 1.
 */
function fakeGh(root: string, responses: Record<string, unknown>) {
  const ghDir = join(root, "bin");
  mkdirSync(ghDir, { recursive: true });
  const ghBin = join(ghDir, process.platform === "win32" ? "gh.exe" : "gh");
  copyFileSync(process.execPath, ghBin);
  if (process.platform !== "win32") chmodSync(ghBin, 0o755);
  const respPath = join(root, "gh-responses.json");
  writeFileSync(respPath, JSON.stringify(responses));
  const logPath = join(root, "gh-calls.log");
  const preload = join(ghDir, "preload.cjs");
  writeFileSync(
    preload,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const sub = process.argv[1] ? path.basename(process.argv[1]) : '';",
      "if (sub === 'issue' || sub === 'pr' || sub === 'api' || sub === 'label') {",
      "  const args = process.argv.slice(2);",
      "  fs.appendFileSync(process.env.GH_FAKE_LOG, JSON.stringify([sub, ...args]) + '\\n');",
      "  const ri = args.indexOf('-R');",
      "  const repo = ri === -1 ? 'default' : args[ri + 1];",
      "  const ji = args.indexOf('--json');",
      "  const json = ji === -1 ? '' : args[ji + 1];",
      "  const n = /^\\d+$/.test(args[1] || '') ? args[1] : 'list';",
      "  const key = [sub, args[0], repo, n, json].join('_');",
      "  const map = JSON.parse(fs.readFileSync(process.env.GH_FAKE_RESP, 'utf8'));",
      "  if (!(key in map)) { process.stderr.write('sem resposta: ' + key); process.exit(1); }",
      // Falha de PROCESSO (não de API): stdout acima do maxBuffer do spawnSync
      // vira `result.error` (ENOBUFS) — o mesmo caminho de spawn/timeout.
      "  if (map[key] === '__PROCESS_FAILURE__') { process.stdout.write('x'.repeat(2 * 1024 * 1024)); process.exit(0); }",
      "  process.stdout.write(JSON.stringify(map[key]));",
      "  process.exit(0);",
      "}",
    ].join("\n"),
  );
  const env = {
    ...process.env,
    PATH: ghDir,
    Path: ghDir,
    NODE_OPTIONS: `--require ${preload}`,
    GH_FAKE_RESP: respPath,
    GH_FAKE_LOG: logPath,
  };
  const calls = (): string[][] => {
    try {
      return readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  return { env, calls };
}

function runCli(root: string, env: NodeJS.ProcessEnv, script: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, join(ROOT, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

function writePlan(root: string, plan: unknown, sub = "overnight/261022"): string {
  const dir = join(root, "data", ...sub.split("/"));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "plan.json");
  writeFileSync(p, JSON.stringify(plan));
  return p;
}

// ---------------------------------------------------------------------------
// Pré-requisito: convergência varre todo repo de issue_repos
// ---------------------------------------------------------------------------

describe("#10618 fatia 4 — convergência varre todo repo de issue_repos", () => {
  it("convergenceReposOfPlan: plano só-studio ainda varre o design da allowlist; fork citado continua na lista", () => {
    assert.deepEqual(convergenceReposOfPlan({ goal: { target_set: [22] } }, [STUDIO, DESIGN]), [DESIGN]);
    assert.deepEqual(convergenceReposOfPlan({ goal: { target_set: [22] } }, [STUDIO]), []);
    assert.deepEqual(
      convergenceReposOfPlan({ goal: { target_set: ["fork/diaria-design#3"] } }, [STUDIO, DESIGN]),
      ["fork/diaria-design", DESIGN],
    );
  });

  it("scanForeignConvergence: issue nova do design num plano só-studio é acusada; fork nunca é consultado", () => {
    const root = tmpRepoRoot();
    const asked: string[] = [];
    const scan = scanForeignConvergence(
      { goal: { target_set: [22, "fork/diaria-design#3"] } } as PlanWithGoal,
      root,
      {},
      (_cwd, repo) => {
        asked.push(repo);
        return { issues: [{ number: 5, labels: [], body: "" }] };
      },
    );
    assert.deepEqual(asked, [DESIGN]);
    assert.deepEqual(scan.missing, [`${DESIGN}#5`]);
    assert.deepEqual(scan.notScanned, ["fork/diaria-design (fora de issue_repos)"]);
  });

  it("scanForeignConvergence: falha do gh no design vira notScanned, nunca 'nenhuma issue nova'", () => {
    const root = tmpRepoRoot();
    const scan = scanForeignConvergence({ goal: { target_set: [22] } } as PlanWithGoal, root, {}, () => ({
      issues: [],
      error: "gh issue list saiu com status 1",
    }));
    assert.deepEqual(scan.missing, []);
    assert.equal(scan.notScanned.length, 1);
    assert.match(scan.notScanned[0], /^vjpixel\/diaria-design \(gh issue list saiu/);
  });

  it("CLI check-overnight-fila-convergence-gate: plano só-studio, issue nova no design → exit 1 com owner/repo#N", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, { goal: { target_set: [22] } });
    const { env, calls } = fakeGh(root, {
      issue_list_default_list_: [{ number: 22, labels: [], body: "" }],
      [`issue_list_${DESIGN}_list_number,labels,body`]: [{ number: 5, labels: [], body: "" }],
      "issue_list_default_list_number,labels,body": [{ number: 22, labels: [], body: "" }],
    });
    const r = runCli(root, env, "check-overnight-fila-convergence-gate.ts", ["--plan", planPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /vjpixel\/diaria-design#5/);
    assert.doesNotMatch(r.stderr, /(?<!diaria-design)#5\b/);
    assert.ok(calls().some((c) => c.includes("-R") && c.includes(DESIGN)), "o design foi varrido com -R");
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(written.goal.last_convergence_scan.novas_encontradas, 1);
  });

  it("CLI check-overnight-fila-convergence-gate: design falhando → 'ok PARCIAL' e repos_nao_varridos gravado", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, { goal: { target_set: [22] } });
    const { env } = fakeGh(root, {
      "issue_list_default_list_number,labels,body": [{ number: 22, labels: [], body: "" }],
    });
    const r = runCli(root, env, "check-overnight-fila-convergence-gate.ts", ["--plan", planPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ok PARCIAL/);
    assert.match(r.stderr, /re-scan NÃO executado para: vjpixel\/diaria-design/);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(written.goal.last_convergence_scan.repos_nao_varridos.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Gates que liam `number` cru
// ---------------------------------------------------------------------------

describe("#10618 fatia 4 — gates sem consulta ao GitHub rotulam por chave", () => {
  it("findMissingExecTrack: design#21 sem track não se funde com a studio#21 coberta", () => {
    const r = findMissingExecTrack([
      { number: 21, exec_track_painel: "overnight" },
      { ref: `${DESIGN}#21`, number: 21 },
      { ref: `${DESIGN}#30`, number: 30, exec_track_painel: "Overnight" },
    ] as never);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.missingForeign, [`${DESIGN}#21`]);
    assert.deepEqual(r.invalid, [{ number: 30, value: "Overnight", ref: `${DESIGN}#30` }]);
    const verdict = checkExecTrackCoverageFromPlan({ issues: { [`${DESIGN}#21`]: { status: "pulada" } } } as never);
    assert.deepEqual(verdict, { status: "missing", numbers: [], foreign: [`${DESIGN}#21`] });
  });

  it("findMissingExecTrack: entrada com repo ilegível sem track não some em silêncio", () => {
    const r = findMissingExecTrack([{ number: 5, repo: 42 } as never]);
    assert.deepEqual(r.missing, []);
    assert.equal(r.missingForeign?.length, 1);
    assert.match(r.missingForeign![0], /^\(identidade desconhecida: .*repo=42/);
    // Entrada SEM número nem repo/ref continua ignorada (contrato de sempre).
    assert.deepEqual(findMissingExecTrack([{ status: "x" } as never]), { missing: [], invalid: [] });
  });

  it("findMissingExecTrack: plano só-studio mantém o shape de sempre (sem missingForeign)", () => {
    assert.deepEqual(findMissingExecTrack([{ number: 5 } as never]), { missing: [5], invalid: [] });
  });

  it("check-overnight-plan-motivo: entrada do design com motivo inválido sai como owner/repo#N", () => {
    const r = checkOvernightPlanMotivosFromIssues(
      normalizeIssues({
        issues: {
          [`${DESIGN}#21`]: { status: "pulada", motivo: "inventado" },
          "21": { status: "pulada", motivo: "outro-inventado" },
        },
      } as never),
    );
    assert.equal(r.status, "invalid");
    if (r.status !== "invalid") return;
    const refs = r.entries.map((e) => e.ref ?? `#${e.number}`).sort();
    assert.deepEqual(refs, ["#21", `${DESIGN}#21`]);
  });

  it("ondas: parseUnits aceita owner/repo#N; studio qualificado vira número; dedup por chave", () => {
    assert.deepEqual(parseUnits(`8290,${DESIGN}#21;${STUDIO}#8300`), [[8290, `${DESIGN}#21`], [8300]]);
    assert.throws(() => parseUnits("abc"), /token inválido/);
    const w1 = buildWaveRecord({ units: [[21], [`${DESIGN}#21`]], now: new Date("2026-10-22T10:00:00Z") });
    const sameSet = { units: [{ issues: [`${DESIGN}#21`] }, { issues: [21] }], composed_at: "2026-10-22T10:05:00Z" };
    assert.equal(findDuplicateWave([w1], sameSet), w1);
    const onlyStudio = { units: [{ issues: [21] }], composed_at: "2026-10-22T10:05:00Z" };
    assert.equal(findDuplicateWave([w1], onlyStudio), null, "design#21 + studio#21 ≠ só studio#21");
    assert.throws(() => buildWaveRecord({ units: [["fork"]] }), /unidade inválida/);
  });

  it("ondas: duração por unidade usa o timeline da issue certa (design#21 ≠ studio#21)", () => {
    const wave = buildWaveRecord({ units: [[`${DESIGN}#21`]], now: new Date("2026-10-22T10:00:00Z") });
    const durations = computeWaveUnitDurations([wave], [
      { number: 21, timeline: { pr_opened: "2026-10-22T10:00:00Z", merged: "2026-10-22T13:00:00Z" } },
      { number: 21, ref: `${DESIGN}#21`, timeline: { pr_opened: "2026-10-22T10:00:00Z", merged: "2026-10-22T10:30:00Z" } },
    ] as never);
    assert.equal(durations[0].duration_ms, 30 * 60 * 1000);
  });

  it("timeline: unidade do design rotulada owner/repo#N", () => {
    const rows = buildTimelineRows({
      issues: [{ number: 21, ref: `${DESIGN}#21`, status: "mergeada" }, { number: 22, status: "mergeada" }],
    } as never);
    assert.deepEqual(rows.map((r) => r.unidade), [`${DESIGN}#21`, "#22"]);
  });
});

// ---------------------------------------------------------------------------
// Preflights por issue aceitam owner/repo#N
// ---------------------------------------------------------------------------

describe("#10618 fatia 4 — preflights por issue consultam o repo da issue", () => {
  it("fetchRepoCommitsForIssue: lê a branch default do repo via gh api, com boundary de dígito", () => {
    const seen: string[][] = [];
    const r = fetchRepoCommitsForIssue("/x", DESIGN, 21, (cmd, args) => {
      seen.push([cmd, ...args]);
      return {
        status: 0,
        stdout: [
          JSON.stringify({ sha: "a1", message: "fix: x (#210)\n\ncorpo", date: "2026-10-20T00:00:00Z" }),
          JSON.stringify({ sha: "b2", message: "fix: y\n\nCloses #21", date: "2026-10-21T00:00:00Z" }),
        ].join("\n"),
      };
    });
    assert.deepEqual(r.commits.map((c) => c.sha), ["b2"]);
    assert.ok(seen[0].includes(`repos/${DESIGN}/commits?per_page=100`));
    const fail = fetchRepoCommitsForIssue("/x", DESIGN, 21, () => ({ status: 1, stderr: "boom" }));
    assert.match(fail.error ?? "", /saiu com status 1: boom/);
  });

  it("check-issue-duplicate-preflight --issue design#21: commit 'Closes #21' do design → exit 1, ref no output", () => {
    const root = tmpRepoRoot();
    const out: string[] = [];
    const orig = console.log;
    console.log = (s: string) => out.push(s);
    try {
      const code = duplicatePreflightMain(["--issue", `${DESIGN}#21`], root, () => ({
        status: 0,
        stdout: JSON.stringify({ sha: "b2", message: "fix: y\n\nCloses #21", date: "2026-10-21T00:00:00Z" }),
      }));
      assert.equal(code, 1);
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(out.join("\n"));
    assert.equal(parsed.verdict, "closes-should-be-closed");
    assert.equal(parsed.ref, `${DESIGN}#21`);
  });

  it("check-issue-duplicate-preflight: repo fora de issue_repos → exit 2 sem consultar nada", () => {
    const root = tmpRepoRoot();
    let called = false;
    const orig = console.error;
    console.error = () => {};
    try {
      const code = duplicatePreflightMain(["--issue", "fork/diaria-design#21"], root, () => {
        called = true;
        return { status: 0, stdout: "" };
      });
      assert.equal(code, 2);
    } finally {
      console.error = orig;
    }
    assert.equal(called, false);
  });

  it("check-issue-open-pr --issue design#21: gh pr list com -R do design; PR fix-21 de lá cobre o escopo", () => {
    const root = tmpRepoRoot();
    const seen: string[][] = [];
    const out: string[] = [];
    const orig = console.log;
    console.log = (s: string) => out.push(s);
    try {
      const code = openPrMain(["--issue", `${DESIGN}#21`], root, (cmd, args) => {
        seen.push([cmd, ...args]);
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 23, title: "x", body: "Closes #21", headRefName: "develop/fix-21", author: { login: "vjpixel" }, updatedAt: "2026-10-22T00:00:00Z", statusCheckRollup: [] },
          ]),
          stderr: "",
        };
      });
      assert.equal(code, 1);
    } finally {
      console.log = orig;
    }
    assert.deepEqual(seen[0].slice(seen[0].indexOf("-R"), seen[0].indexOf("-R") + 2), ["-R", DESIGN]);
    assert.equal(JSON.parse(out.join("\n")).ref, `${DESIGN}#21`);
  });

  it("check-issue-open-pr --issue 21 (studio): chamada de sempre, sem -R", () => {
    const root = tmpRepoRoot();
    const seen: string[][] = [];
    const orig = console.log;
    console.log = () => {};
    try {
      openPrMain(["--issue", "21"], root, (cmd, args) => {
        seen.push([cmd, ...args]);
        return { status: 0, stdout: "[]", stderr: "" };
      });
    } finally {
      console.log = orig;
    }
    assert.equal(seen[0].includes("-R"), false);
  });

  it("CLI check-trade-off-label-cleared --issue design#21: labels e comentários lidos com -R", () => {
    const root = tmpRepoRoot();
    const { env, calls } = fakeGh(root, {
      [`issue_view_${DESIGN}_21_labels`]: { labels: [{ name: "trade-off-real" }] },
      [`issue_view_${DESIGN}_21_comments`]: { comments: [] },
    });
    const r = runCli(root, env, "check-trade-off-label-cleared.ts", ["--issue", `${DESIGN}#21`]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /vjpixel\/diaria-design#21: nenhuma decisão registrada/);
    assert.equal(calls().length, 2);
    assert.ok(calls().every((c) => c.includes("-R") && c.includes(DESIGN)));
  });
});

// ---------------------------------------------------------------------------
// Gates de PR que autorizam merge: `--repo`
// ---------------------------------------------------------------------------

describe("#10618 fatia 4 — gates de PR com --repo leem o PR do repo certo", () => {
  it("check-pr-retido-gate --pr 23 --repo design: gh pr view com -R, repo no JSON", () => {
    const root = tmpRepoRoot();
    const { env, calls } = fakeGh(root, {
      [`pr_view_${DESIGN}_23_labels,body`]: { labels: [], body: "corpo" },
    });
    const r = runCli(root, env, "check-pr-retido-gate.ts", ["--pr", "23", "--repo", DESIGN]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).repo, DESIGN);
    assert.deepEqual(calls()[0].slice(calls()[0].indexOf("-R"), calls()[0].indexOf("-R") + 2), ["-R", DESIGN]);
  });

  it("check-pr-review-authenticity --repo design: prefixo nomeia o repo e consulta com -R", () => {
    const root = tmpRepoRoot();
    const { env, calls } = fakeGh(root, { [`pr_view_${DESIGN}_23_comments`]: { comments: [] } });
    const r = runCli(root, env, "check-pr-review-authenticity.ts", ["--pr", "23", "--repo", DESIGN]);
    assert.match(r.stderr, /vjpixel\/diaria-design PR #23: verdict=/);
    assert.ok(calls()[0].includes("-R") && calls()[0].includes(DESIGN));
  });

  it("check-pr-checks-gate: --repo fora de issue_repos ou sem valor → erro de uso, nunca o studio em silêncio", () => {
    const root = tmpRepoRoot();
    const { env, calls } = fakeGh(root, {});
    const fork = runCli(root, env, "check-pr-checks-gate.ts", ["--pr", "23", "--repo", "fork/diaria-design"]);
    assert.equal(fork.status, 2);
    assert.match(fork.stderr, /fora de platform\.config\.json/);
    const empty = runCli(root, env, "check-pr-checks-gate.ts", ["--pr", "23", "--repo"]);
    assert.equal(empty.status, 2);
    assert.equal(calls().length, 0);
  });
});

describe("#10618 fatia 4 (review J/L) — repo do PR nos gates de merge", () => {
  const PASS_PAYLOAD = {
    statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    mergeable: "MERGEABLE",
    commits: [{ committedDate: "2026-01-01T00:00:00Z" }],
  };

  it("check-pr-checks-gate --repo design (caminho válido): gh pr view com -R do design → pass", () => {
    const root = tmpRepoRoot();
    const { env, calls } = fakeGh(root, {
      [`pr_view_${DESIGN}_23_statusCheckRollup,mergeable,commits`]: PASS_PAYLOAD,
    });
    const r = runCli(root, env, "check-pr-checks-gate.ts", ["--pr", "23", "--repo", DESIGN]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /vjpixel\/diaria-design PR #23: verdict=pass/);
    assert.equal(calls().length, 1);
    const c = calls()[0];
    assert.deepEqual(c.slice(c.indexOf("-R"), c.indexOf("-R") + 2), ["-R", DESIGN]);
  });

  it("check-pr-checks-gate --issue design#21: repo do PR derivado da issue (sem --repo)", () => {
    const root = tmpRepoRoot();
    const { env, calls } = fakeGh(root, {
      [`pr_view_${DESIGN}_23_statusCheckRollup,mergeable,commits`]: PASS_PAYLOAD,
    });
    const r = runCli(root, env, "check-pr-checks-gate.ts", ["--pr", "23", "--issue", `${DESIGN}#21`]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(calls()[0].includes("-R") && calls()[0].includes(DESIGN));
  });

  it("gates de PR: --issue do design com --repo do studio divergem → erro de uso, sem consultar nada", () => {
    const root = tmpRepoRoot();
    const { env, calls } = fakeGh(root, {});
    const checks = runCli(root, env, "check-pr-checks-gate.ts", ["--pr", "23", "--issue", `${DESIGN}#21`, "--repo", STUDIO]);
    assert.equal(checks.status, 2);
    assert.match(checks.stderr, /diverge do repo da --issue/);
    const retido = runCli(root, env, "check-pr-retido-gate.ts", ["--pr", "23", "--issue", `${DESIGN}#21`, "--repo", STUDIO]);
    assert.equal(retido.status, 3);
    const auth = runCli(root, env, "check-pr-review-authenticity.ts", ["--pr", "23", "--issue", "fork/x#1"]);
    assert.equal(auth.status, 4);
    assert.match(auth.stderr, /fora de platform\.config\.json/);
    assert.equal(calls().length, 0);
  });

  it("resolveRepoFlag: tabela de entradas", () => {
    const root = tmpRepoRoot();
    const none = new Set<string>();
    assert.deepEqual(resolveRepoFlag({}, none, root), { repo: undefined });
    assert.deepEqual(resolveRepoFlag({ repo: DESIGN }, none, root), { repo: DESIGN });
    assert.deepEqual(resolveRepoFlag({ repo: "VJPixel/Diaria-Design" }, none, root), { repo: DESIGN });
    assert.deepEqual(resolveRepoFlag({ repo: `https://github.com/${DESIGN}.git` }, none, root), { repo: DESIGN });
    assert.deepEqual(resolveRepoFlag({ repo: STUDIO }, none, root), { repo: undefined }, "default explícito = chamada de sempre");
    assert.ok("error" in resolveRepoFlag({ repo: "" }, none, root));
    assert.ok("error" in resolveRepoFlag({}, new Set(["repo"]), root));
    assert.ok("error" in resolveRepoFlag({ repo: "não-é-slug" }, none, root));
    assert.ok("error" in resolveRepoFlag({ repo: "fork/diaria-design" }, none, root));
    assert.ok("error" in resolveRepoFlag({ repo: DESIGN }, none, tmpRepoRoot([STUDIO])), "fora da allowlist do config");
  });

  it("resolvePrTargetRepo: --issue deriva, concorda ou diverge do --repo", () => {
    const root = tmpRepoRoot();
    const none = new Set<string>();
    assert.deepEqual(resolvePrTargetRepo({ issue: `${DESIGN}#21` }, none, root), { repo: DESIGN });
    assert.deepEqual(resolvePrTargetRepo({ issue: "21" }, none, root), { repo: undefined });
    assert.deepEqual(resolvePrTargetRepo({ issue: `${DESIGN}#21`, repo: DESIGN }, none, root), { repo: DESIGN });
    assert.ok("error" in resolvePrTargetRepo({ issue: "21", repo: DESIGN }, none, root));
    assert.ok("error" in resolvePrTargetRepo({ issue: "lixo" }, none, root));
    assert.ok("error" in resolvePrTargetRepo({}, new Set(["issue"]), root));
  });

  it("check-issue-duplicate-preflight: erro do gh api no design → exit 2 (nunca 'not-in-master')", () => {
    const root = tmpRepoRoot();
    const out: string[] = [];
    const errs: string[] = [];
    const [origLog, origErr] = [console.log, console.error];
    console.log = (s: string) => out.push(s);
    console.error = (s: string) => errs.push(s);
    try {
      const code = duplicatePreflightMain(["--issue", `${DESIGN}#21`], root, () => ({ status: 1, stderr: "HTTP 403" }));
      assert.equal(code, 2);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.ok(!out.join("\n").includes("not-in-master"));
    assert.match(errs.join("\n"), /403/);
  });
});

// ---------------------------------------------------------------------------
// pr-em-voo: PR de repo diferente do da issue
// ---------------------------------------------------------------------------

describe("#10618 fatia 4 — pr-em-voo com PR citado em outro repo", () => {
  it("extractPrRef: número, ref qualificada, URL e as formas da nota", () => {
    const e = (over: Partial<BlockStalenessPlanIssue>) => ({ number: 1, ...over }) as BlockStalenessPlanIssue;
    const both = [STUDIO, DESIGN];
    assert.deepEqual(extractPrRef(e({ pr: 6216 }), both), { number: 6216, repo: null });
    assert.deepEqual(extractPrRef(e({ pr: `${DESIGN}#23` }), both), { number: 23, repo: DESIGN });
    assert.deepEqual(extractPrRef(e({ pr: `https://github.com/${DESIGN}/pull/23` }), both), { number: 23, repo: DESIGN });
    assert.deepEqual(extractPrRef(e({ nota: `aguarda o ${DESIGN} PR #23 mergear` }), both), { number: 23, repo: DESIGN });
    assert.deepEqual(extractPrRef(e({ nota: `PR ${DESIGN}#23 aberto` }), both), { number: 23, repo: DESIGN });
    assert.deepEqual(extractPrRef(e({ nota: `ver https://github.com/${DESIGN}/pull/23` }), both), { number: 23, repo: DESIGN });
    assert.deepEqual(extractPrRef(e({ nota: "PR #6216 aberto por outra sessão" }), both), { number: 6216, repo: null });
    assert.equal(extractPrRef(e({ nota: "sem pr" }), both), null);
  });

  it("extractPrRef (review I): branch/caminho na nota nunca vira repo — cai no PR #N do repo da issue", () => {
    const e = (over: Partial<BlockStalenessPlanIssue>) => ({ number: 1, ...over }) as BlockStalenessPlanIssue;
    const both = [STUDIO, DESIGN];
    assert.deepEqual(extractPrRef(e({ nota: "develop/fix-10618 PR #10895 aberto" }), both), { number: 10895, repo: null });
    assert.deepEqual(extractPrRef(e({ nota: "mexe em scripts/lib PR #500" }), both), { number: 500, repo: null });
    // branch antes, repo de verdade depois: o da allowlist vence.
    assert.deepEqual(extractPrRef(e({ nota: `develop/fix-x PR #9; ver ${DESIGN} PR #23` }), both), { number: 23, repo: DESIGN });
    // sem a allowlist (default = só studio), o design citado não é aceito como repo do PR.
    assert.deepEqual(extractPrRef(e({ nota: `aguarda ${DESIGN} PR #23` })), { number: 23, repo: null });
    // citação ESTRUTURADA de repo fora da allowlist → não verificável, nunca o repo da issue.
    assert.equal(extractPrRef(e({ pr: "fork/diaria-design#23" }), both), null);
    assert.equal(extractPrRef(e({ nota: "ver https://github.com/fork/diaria-design/pull/23" }), both), null);
  });

  it("issue do studio esperando PR do design: o estado é lido no design (repo citado), não no studio", () => {
    const asked: Array<[number, string | undefined]> = [];
    const consultor: BlockStalenessConsultor = {
      multiRepo: true,
      issueRepos: [STUDIO, DESIGN],
      getPrState: (n, repo) => {
        asked.push([n, repo]);
        return repo === DESIGN ? "MERGED" : "OPEN";
      },
      isIssueClaimedActive: () => true,
      hasLabel: () => true,
      getIssueState: () => "OPEN",
    };
    const findings = findStaleBlocks(
      [{ number: 500, status: "pulada", motivo: "pr-em-voo", nota: `aguarda ${DESIGN} PR #23` }],
      consultor,
    );
    assert.deepEqual(asked, [[23, DESIGN]]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].reason, `${DESIGN} PR #23 já está mergeado — bloqueio caducou`);
  });

  it("issue do design esperando PR do studio: consulta o studio (sem repo)", () => {
    const asked: Array<[number, string | undefined]> = [];
    const consultor: BlockStalenessConsultor = {
      multiRepo: true,
      issueRepos: [STUDIO, DESIGN],
      getPrState: (n, repo) => {
        asked.push([n, repo]);
        return "OPEN";
      },
      isIssueClaimedActive: () => true,
      hasLabel: () => true,
      getIssueState: () => "OPEN",
    };
    findStaleBlocks(
      normalizeIssues<BlockStalenessPlanIssue>({
        issues: { [`${DESIGN}#21`]: { status: "pulada", motivo: "pr-em-voo", pr: `${STUDIO}#10900` } },
      } as never),
      consultor,
    );
    assert.deepEqual(asked, [[10900, undefined]]);
  });

  it("consultor só-studio nunca responde por PR de outro repo: vira 'não verificável'", () => {
    const seen: string[] = [];
    const findings = findStaleBlocks(
      [{ number: 500, status: "pulada", motivo: "pr-em-voo", pr: `${DESIGN}#23` }],
      {
        issueRepos: [STUDIO, DESIGN],
        getPrState: () => "MERGED",
        isIssueClaimedActive: () => true,
        hasLabel: () => true,
        getIssueState: () => "OPEN",
      },
      (k, what) => seen.push(`${k}: ${what}`),
    );
    assert.deepEqual(findings, []);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /vjpixel\/diaria-design PR #23 \(consultor só-studio\)/);
  });
});

// ---------------------------------------------------------------------------
// Gates que pulavam com aviso agora avaliam o repo da entrada
// ---------------------------------------------------------------------------

describe("#10618 fatia 4 — groupPlanEntriesByRepo", () => {
  it("separa por repo em visão local, default primeiro, identidade desconhecida à parte", () => {
    const { groups, unknown } = groupPlanEntriesByRepo([
      { number: 21, ref: `${DESIGN}#21`, status: "pulada" },
      { number: 21, status: "mergeada" },
      { number: 5, repo: 42 },
    ]);
    assert.deepEqual(groups.map((g) => g.repo), [STUDIO, DESIGN]);
    assert.equal(groups[1].entries.length, 1);
    assert.equal(groups[1].entries[0].number, 21);
    assert.equal(groups[1].entries[0].status, "pulada");
    assert.equal(groups[0].isDefault, true);
    assert.deepEqual(unknown, ["entrada [2] (repo=42, number=5) (identidade desconhecida)"]);
    assert.equal(labelInRepo(STUDIO, 21), "#21");
    assert.equal(labelInRepo(DESIGN, 21), `${DESIGN}#21`);
  });
});

describe("#10618 fatia 4 (review H) — visão local nunca volta a ser a studio#N", () => {
  it("cópia do design mantém a identidade: resolvedores veem owner/repo#N, guard local vê o número", () => {
    const { groups } = groupPlanEntriesByRepo([
      { number: 21, repo: DESIGN, status: "pulada" },
      `${DESIGN}#22`,
    ]);
    const [a] = groups[0].entries as Array<{ number: number }>;
    assert.equal(groups[0].repo, DESIGN);
    assert.equal(planEntryKey(a), `${DESIGN}#21`);
    assert.equal(studioNumberOfPlanEntry(a), null, "nunca a studio#21");
    assert.throws(() => requireStudioIssueNumber(a, "teste"), /diaria-design#21/);
    assert.equal(localNumberOfPlanEntry(a), 21);
    assert.equal(isLocalViewPlanEntry(a), true);
    // JSON não carrega a marca, mas carrega `ref`: a identidade sobrevive.
    const roundTrip = JSON.parse(JSON.stringify(a));
    assert.equal(planEntryKey(roundTrip), `${DESIGN}#21`);
    assert.equal(localNumberOfPlanEntry(roundTrip), null);
  });

  it("checkDevelopLabelCleared: entrada do design fora de um grupo (sem a marca) nunca é avaliada como studio#N", () => {
    const r = checkDevelopLabelCleared(
      [{ number: 21, ref: `${DESIGN}#21`, status: "mergeada" }],
      [{ number: 21, labels: ["windows"], body: "" }],
    );
    assert.equal(r.findings.length, 0);
    const { groups } = groupPlanEntriesByRepo([{ number: 21, ref: `${DESIGN}#21`, status: "mergeada" }]);
    const local = checkDevelopLabelCleared(groups[0].entries, [{ number: 21, labels: ["windows"], body: "" }]);
    assert.equal(local.findings.length, 1, "dentro do grupo, a cópia local é avaliada");
  });
});

describe("#10618 fatia 4 — gates de fim de rodada avaliam a entrada do design no repo dela", () => {
  it("check-develop-label-cleared: design#21 com windows acusada como owner/repo#N; studio#21 limpa", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(
      root,
      { issues: { [`${DESIGN}#21`]: { status: "mergeada" }, "21": { status: "mergeada" } } },
      "develop/261022",
    );
    const { env, calls } = fakeGh(root, {
      "issue_view_default_21_labels,body": { labels: [{ name: "bug" }], body: "" },
      [`issue_view_${DESIGN}_21_labels,body`]: { labels: [{ name: "windows" }], body: "" },
    });
    const r = runCli(root, env, "check-develop-label-cleared.ts", ["--plan", planPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /vjpixel\/diaria-design#21 \(status: mergeada\)/);
    assert.match(r.stdout, /--issue vjpixel\/diaria-design#21 --track/);
    assert.doesNotMatch(r.stdout, /^\s+#21 \(status/m, "a studio#21 não é acusada");
    assert.equal(calls().length, 2);
  });

  it("check-overnight-comment-coverage: design#21 pulada sem comentário → acusada como owner/repo#N", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, {
      issues: { [`${DESIGN}#21`]: { status: "pulada", motivo: "bloqueio-externo" } },
    });
    const { env, calls } = fakeGh(root, {
      [`issue_view_${DESIGN}_21_comments,labels`]: { comments: [], labels: [] },
    });
    const r = runCli(root, env, "check-overnight-comment-coverage.ts", ["--plan", planPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /cobertura de comentário faltando: vjpixel\/diaria-design#21 \(pulada\)/);
    assert.ok(calls().every((c) => c.includes("-R") && c.includes(DESIGN)), "só o design consultado, com -R");
  });

  it("check-decision-label-drift-gate: falha só no design NÃO descarta o drift achado no studio", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, {
      issues: {
        "7": { status: "pulada", motivo: "x", scope_note: "bloqueio externo: falta conta do painel", in_round: false },
        [`${DESIGN}#21`]: { status: "pulada", motivo: "x", scope_note: "y", in_round: false },
      },
    });
    const { env } = fakeGh(root, {
      "issue_list_default_list_number,labels,body": [{ number: 7, labels: [], body: "" }],
    });
    const r = runCli(root, env, "check-decision-label-drift-gate.ts", ["--plan", planPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^#7\texternal-blocker/m);
    assert.match(r.stderr, /vjpixel\/diaria-design: lista de issues abertas indisponível/);
  });

  it("check-decision-label-drift-gate: sem drift e design falhando → 'ok PARCIAL' nomeando o repo", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, {
      issues: {
        "7": { status: "pulada", motivo: "x", scope_note: "nada", in_round: false },
        [`${DESIGN}#21`]: { status: "pulada", motivo: "x", scope_note: "y", in_round: false },
      },
    });
    const { env } = fakeGh(root, {
      "issue_list_default_list_number,labels,body": [{ number: 7, labels: [], body: "" }],
    });
    const r = runCli(root, env, "check-decision-label-drift-gate.ts", ["--plan", planPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok PARCIAL .*NÃO avaliado\(s\): vjpixel\/diaria-design/);
  });

  it("check-decision-label-drift-gate: lista de issues abertas do design buscada com -R", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, {
      issues: { [`${DESIGN}#21`]: { status: "pulada", motivo: "bloqueio-externo" } },
    });
    const { env, calls } = fakeGh(root, {
      [`issue_list_${DESIGN}_list_number,labels,body`]: [{ number: 21, labels: [{ name: "external-blocker" }], body: "" }],
      [`issue_view_${DESIGN}_21_comments`]: { comments: [] },
    });
    const r = runCli(root, env, "check-decision-label-drift-gate.ts", ["--plan", planPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok/);
    assert.ok(calls().length >= 1);
    assert.ok(calls().every((c) => c.includes("-R") && c.includes(DESIGN)), "só o design consultado, com -R");
  });
});

describe("#10618 fatia 4 (review) — falha num repo extra nunca descarta o veredito do studio", () => {
  const PF = "__PROCESS_FAILURE__";

  it("drift-gate: falha de PROCESSO ao ler comentários do design não descarta o drift do studio", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, {
      issues: {
        "7": { status: "pulada", motivo: "x", scope_note: "bloqueio externo: falta conta do painel", in_round: false },
        [`${DESIGN}#21`]: { status: "pulada", motivo: "bloqueio-externo" },
      },
    });
    const { env, calls } = fakeGh(root, {
      "issue_list_default_list_number,labels,body": [{ number: 7, labels: [], body: "" }],
      // Sem label: a #21 do design classifica `overnight` e precisa dos comentários.
      [`issue_list_${DESIGN}_list_number,labels,body`]: [{ number: 21, labels: [], body: "" }],
      [`issue_view_${DESIGN}_21_comments`]: PF,
    });
    const r = runCli(root, env, "check-decision-label-drift-gate.ts", ["--plan", planPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^#7	external-blocker/m);
    assert.match(r.stderr, /vjpixel\/diaria-design: gh falhou ao ler comentários/);
    assert.ok(calls().some((c) => c[0] === "issue" && c[1] === "view" && c.includes(DESIGN)), "o design foi de fato consultado");
  });

  it("drift-gate: sem drift no studio e falha de processo no design → 'ok PARCIAL' nomeando o repo", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, {
      issues: {
        "7": { status: "pulada", motivo: "x", scope_note: "nada", in_round: false },
        [`${DESIGN}#21`]: { status: "pulada", motivo: "bloqueio-externo" },
      },
    });
    const { env } = fakeGh(root, {
      "issue_list_default_list_number,labels,body": [{ number: 7, labels: [], body: "" }],
      // Sem label: a #21 do design classifica `overnight` e precisa dos comentários.
      [`issue_list_${DESIGN}_list_number,labels,body`]: [{ number: 21, labels: [], body: "" }],
      [`issue_view_${DESIGN}_21_comments`]: PF,
    });
    const r = runCli(root, env, "check-decision-label-drift-gate.ts", ["--plan", planPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok PARCIAL .*NÃO avaliado\(s\): vjpixel\/diaria-design/);
  });

  it("comment-coverage: falha de PROCESSO no design não descarta a pendência do studio", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, {
      issues: {
        "5": { status: "pulada", motivo: "outro" },
        [`${DESIGN}#21`]: { status: "pulada", motivo: "outro" },
      },
    });
    const { env } = fakeGh(root, {
      "issue_view_default_5_comments,labels": { comments: [], labels: [] },
      [`issue_view_${DESIGN}_21_comments,labels`]: PF,
    });
    const r = runCli(root, env, "check-overnight-comment-coverage.ts", ["--plan", planPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /cobertura de comentário faltando: #5 \(pulada\)/);
    assert.match(r.stderr, /vjpixel\/diaria-design: gh falhou ao executar/);
    assert.match(r.stderr, /PARCIAL — NÃO avaliados: vjpixel\/diaria-design \(gh falhou\)/);
  });

  it("comment-coverage: studio limpo e falha de processo no design → 'ok PARCIAL' nomeando o repo", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, {
      issues: { [`${DESIGN}#21`]: { status: "pulada", motivo: "outro" } },
    });
    const { env } = fakeGh(root, { [`issue_view_${DESIGN}_21_comments,labels`]: PF });
    const r = runCli(root, env, "check-overnight-comment-coverage.ts", ["--plan", planPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok PARCIAL .*NÃO avaliados: vjpixel\/diaria-design \(gh falhou\)/);
  });

  it("comment-coverage: PR do design inacessível (erro de API) → 'ok PARCIAL', nunca 'ok' limpo", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, {
      issues: { [`${DESIGN}#21`]: { status: "mergeada", pr: 23 } },
    });
    const { env } = fakeGh(root, {}); // pr view do design → exit 1 (404/403)
    const r = runCli(root, env, "check-overnight-comment-coverage.ts", ["--plan", planPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok PARCIAL .*NÃO avaliados: vjpixel\/diaria-design \(1 consulta\(s\) com erro\)/);
  });

  it("trade-off-label-cleared: label presente e comentários ilegíveis → exit 3 (não verificável), nunca 'nenhuma decisão'", () => {
    const root = tmpRepoRoot();
    const { env } = fakeGh(root, {
      [`issue_view_${DESIGN}_21_labels`]: { labels: [{ name: "trade-off-real" }] },
      // comments → sem resposta → gh sai 1 (403/404)
    });
    const r = runCli(root, env, "check-trade-off-label-cleared.ts", ["--issue", `${DESIGN}#21`]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /NÃO verificável/);
    assert.doesNotMatch(r.stdout, /nenhuma decisão registrada/);
  });

  it("trade-off-label-cleared: sem a label, falha nos comentários não muda o veredito (exit 0)", () => {
    const root = tmpRepoRoot();
    const { env } = fakeGh(root, { [`issue_view_${DESIGN}_21_labels`]: { labels: [] } });
    const r = runCli(root, env, "check-trade-off-label-cleared.ts", ["--issue", `${DESIGN}#21`]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it("comment-coverage: design mergeada com REFS-NÃO-CLOSES — body lido com -R e comentário cobrado no design", () => {
    const root = tmpRepoRoot();
    const planPath = writePlan(root, {
      issues: { [`${DESIGN}#21`]: { status: "mergeada", pr: 23 } },
    });
    const { env, calls } = fakeGh(root, {
      [`pr_view_${DESIGN}_23_body`]: { body: "REFS #21, NÃO CLOSES (parcial)" },
      [`issue_view_${DESIGN}_21_comments,labels`]: { comments: [], labels: [] },
    });
    const r = runCli(root, env, "check-overnight-comment-coverage.ts", ["--plan", planPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /vjpixel\/diaria-design#21 \(vjpixel\/diaria-design PR #23 REFS-NÃO-CLOSES\)/);
    assert.ok(calls().length === 2 && calls().every((c) => c.includes("-R") && c.includes(DESIGN)));
  });
});

// ---------------------------------------------------------------------------
// Painel /triagem
// ---------------------------------------------------------------------------

describe("#10618 fatia 4 — painel /triagem lê todos os repos de issue_repos", () => {
  it("issues do design entram com repo/ref; studio mantém o shape; falha do design vira repoErrors", () => {
    clearTriageCache();
    const root = tmpRepoRoot();
    const seen: string[][] = [];
    const run: GhRunFn = (args) => {
      seen.push(args);
      const isDesign = args.includes("-R");
      if (args[0] === "issue") {
        return {
          status: 0,
          stdout: JSON.stringify([{ number: 21, title: isDesign ? "design" : "studio", url: "u", state: "OPEN", labels: [], body: "" }]),
          stderr: "",
        };
      }
      return isDesign ? { status: 1, stdout: "", stderr: "boom" } : { status: 0, stdout: "[]", stderr: "" };
    };
    const data = fetchTriageData(root, { run, now: () => 1000, forceRefresh: true });
    assert.equal(data.error, null);
    // O design falhou no `pr list`: o repo inteiro fica de fora, com aviso.
    assert.equal(data.issues.length, 1);
    assert.deepEqual(data.repoErrors?.length, 1);
    assert.match(data.repoErrors![0], /^vjpixel\/diaria-design: /);
    assert.equal("ref" in data.issues[0], false, "studio sem ref");
    assert.ok(seen.some((a) => a.includes("-R") && a.includes(DESIGN)));
  });

  it("design respondendo: issue do design com ref, sem colidir com a studio#21", () => {
    clearTriageCache();
    const root = tmpRepoRoot();
    const run: GhRunFn = (args) => {
      const isDesign = args.includes("-R");
      if (args[0] === "issue") {
        return {
          status: 0,
          stdout: JSON.stringify([{ number: 21, title: isDesign ? "design" : "studio", url: "u", state: "OPEN", labels: [], body: "" }]),
          stderr: "",
        };
      }
      return { status: 0, stdout: "[]", stderr: "" };
    };
    const data = fetchTriageData(root, { run, now: () => 1000, forceRefresh: true });
    assert.equal(data.repoErrors, undefined);
    assert.deepEqual(
      data.issues.map((i) => [i.ref ?? `#${i.number}`, i.title]),
      [["#21", "studio"], [`${DESIGN}#21`, "design"]],
    );
  });

  it("attachClaims: claim do design (claimed_foreign_issues) cai na design#21, nunca na studio#21", () => {
    const issues = [
      ...parseIssues([{ number: 21, title: "s", url: "u", state: "OPEN", labels: [], body: "" }]),
      ...parseIssues([{ number: 21, title: "d", url: "u", state: "OPEN", labels: [], body: "" }], DESIGN),
    ];
    const out = attachClaims(issues, [
      { kind: "develop", machineTag: "neo", sessionId: "s1", claimed_issues: [], claimed_foreign_issues: [`${DESIGN}#21`] },
    ]);
    assert.equal(out[0].claim, null);
    assert.equal(out[1].claim?.sessionId, "s1");
  });
});

// ---------------------------------------------------------------------------
// Claims de outro repo: beacon e watch do contínuo
// ---------------------------------------------------------------------------

describe("#10618 fatia 4 — claims de outro repo fora do session-registry", () => {
  it("session-beacon preserva claimed_foreign_issues ao reescrever o registro", () => {
    const previous = {
      kind: "develop",
      machineTag: "neo",
      sessionId: "s1",
      lastHeartbeat: "2026-10-22T10:00:00.000Z",
      claimed_issues: [5],
      claimed_foreign_issues: [`${DESIGN}#21`],
      claimed_foreign_issues_at: { [`${DESIGN}#21`]: "2026-10-22T09:00:00.000Z" },
    };
    const record = buildBeaconRecord(previous, {
      kind: "interactive",
      machineTag: "neo",
      sessionId: "s1",
      branch: "master",
      newPaths: ["scripts/a.ts"],
      verb: null,
      nowIso: "2026-10-22T10:10:00.000Z",
      pid: 1,
    }) as Record<string, unknown>;
    assert.deepEqual(record.claimed_foreign_issues, [`${DESIGN}#21`]);
    assert.deepEqual(record.claimed_foreign_issues_at, { [`${DESIGN}#21`]: "2026-10-22T09:00:00.000Z" });
    assert.deepEqual(record.claimed_issues, [5]);
  });

  it("watch-continuo-health: checagem de claims presos soma claimed_foreign_issues", () => {
    const source = readFileSync(join(ROOT, "hermes", "scripts", "watch-continuo-health.sh"), "utf8");
    const snippet = source.slice(source.indexOf("# ── 3. claims vazando"), source.indexOf("# ── 4."));
    assert.match(snippet, /s\.get\('claimed_issues'\) or \[\]\) \+ \(s\.get\('claimed_foreign_issues'\) or \[\]\)/);
  });
});

// ---------------------------------------------------------------------------
// sync-issue-labels
// ---------------------------------------------------------------------------

describe("#10618 fatia 4 — sync-issue-labels", () => {
  it("requiredIssueLabels deriva do código: prioridade, tipo e toda label roteável", () => {
    const req = requiredIssueLabels();
    for (const l of ["P0", "P1", "P2", "P3", "bug", "enhancement", ...ROUTABLE_LABELS]) {
      assert.ok(req.includes(l), `falta ${l}`);
    }
    assert.equal(new Set(req).size, req.length);
  });

  it("planLabelSync: só cria o que falta, sem diferenciar caixa, com cor/descrição da origem", () => {
    const plan = planLabelSync(
      ["P2", "windows", "nova"],
      [{ name: "p2" }],
      [{ name: "windows", color: "0052cc", description: "Requer a máquina Windows" }],
    );
    assert.deepEqual(plan.present, ["P2"]);
    assert.deepEqual(plan.create, [
      { name: "windows", color: "0052cc", description: "Requer a máquina Windows", fromSource: true },
      { name: "nova", color: "ededed", description: "", fromSource: false },
    ]);
    // Idempotente: depois de aplicar, nada a criar.
    assert.deepEqual(
      planLabelSync(["P2", "windows"], [{ name: "P2" }, { name: "windows" }], []).create,
      [],
    );
  });

  function fakeRunner(target: Array<{ name: string }>) {
    const calls: string[][] = [];
    const run: GhRunner = (args) => {
      calls.push(args);
      if (args[0] === "label" && args[1] === "list") {
        const repo = args[args.indexOf("-R") + 1];
        const labels = repo === DESIGN ? target : [{ name: "windows", color: "0052cc", description: "Win" }];
        return { status: 0, stdout: JSON.stringify(labels), stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    return { run, calls };
  }

  it("dry-run (default) não cria nada; --apply cria só as que faltam", () => {
    const root = tmpRepoRoot();
    const log = console.log;
    console.log = () => {};
    try {
      const dry = fakeRunner([{ name: "P2" }]);
      assert.equal(syncLabelsMain(["--repo", DESIGN, "--dry-run"], root, dry.run), 0);
      assert.equal(dry.calls.some((c) => c[1] === "create"), false);

      const apply = fakeRunner([{ name: "P2" }]);
      assert.equal(syncLabelsMain(["--repo", DESIGN, "--apply"], root, apply.run), 0);
      const created = apply.calls.filter((c) => c[1] === "create").map((c) => c[2]);
      assert.equal(created.includes("P2"), false);
      assert.ok(created.includes("windows"));
      const win = apply.calls.find((c) => c[1] === "create" && c[2] === "windows")!;
      assert.deepEqual(win.slice(3, 7), ["-R", DESIGN, "--color", "0052cc"]);
    } finally {
      console.log = log;
    }
  });

  it("repo fora de issue_repos → exit 2 sem chamar gh", () => {
    const root = tmpRepoRoot();
    const { run, calls } = fakeRunner([]);
    const err = console.error;
    console.error = () => {};
    try {
      assert.equal(syncLabelsMain(["--repo", "fork/diaria-design", "--dry-run"], root, run), 2);
    } finally {
      console.error = err;
    }
    assert.equal(calls.length, 0);
  });
});
