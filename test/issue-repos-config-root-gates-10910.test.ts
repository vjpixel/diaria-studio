/**
 * test/issue-repos-config-root-gates-10910.test.ts (#10910)
 *
 * O #10901 fez os gates `check-pr-*` resolverem a allowlist `issue_repos` pela
 * raiz do módulo (`ISSUE_REPOS_CONFIG_ROOT`), mas os gates de fim de rodada
 * seguiam em `loadIssueRepos(cwd)`. Rodados do worktree do diaria-design (sem
 * `platform.config.json`), a allowlist caía no default só-studio: o preflight
 * de duplicidade dava exit 2 "fora de issue_repos" pra issue legítima do
 * design, e os gates de cobertura/drift deixavam as issues do design sem
 * auditoria. Este teste roda os gates de um cwd SEM config.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fakeGhEnv, writeFakeGh } from "./_helpers/fake-gh.ts";
import { loadIssueRepos } from "../scripts/lib/issue-repos.ts";
import { main as duplicatePreflightMain } from "../scripts/check-issue-duplicate-preflight.ts";
import { main as openPrMain } from "../scripts/check-issue-open-pr.ts";
import { scanForeignConvergence } from "../scripts/check-state-changed-pending.ts";
import type { PlanWithGoal } from "../scripts/lib/state-changed-tracker.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN = "vjpixel/diaria-design";
const GATES = [
  "check-overnight-comment-coverage.ts",
  "check-decision-label-drift-gate.ts",
  "check-develop-label-cleared.ts",
  "check-state-changed-pending.ts",
  "check-issue-duplicate-preflight.ts",
  "check-issue-open-pr.ts",
  "check-trade-off-label-cleared.ts",
];
// O cenário só existe se o config real permite o design (ligado no #10618 fatia 4).
const SKIP = !loadIssueRepos(ROOT).includes(DESIGN);

const tmpDirs: string[] = [];
function cwdWithoutConfig(): string {
  const d = mkdtempSync(join(tmpdir(), "gate-cwd-10910-"));
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  const lines: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = () => {};
  try {
    return { result: fn(), stderr: lines.join("\n") };
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
}

describe("#10910 — gates de fim de rodada resolvem issue_repos pela raiz do módulo", () => {
  for (const gate of GATES) {
    it(`${gate} não resolve a allowlist pelo cwd`, () => {
      const src = readFileSync(join(ROOT, "scripts", gate), "utf8");
      assert.match(src, /loadIssueRepos\(ISSUE_REPOS_CONFIG_ROOT\)/);
      assert.doesNotMatch(src, /loadIssueRepos\((cwd|process\.cwd\(\))\)/);
    });
  }

  it("check-issue-duplicate-preflight: issue do design de um cwd sem config consulta o repo (não é 'fora de issue_repos')", { skip: SKIP }, () => {
    const cwd = cwdWithoutConfig();
    const asked: string[][] = [];
    const { stderr } = captureStderr(() =>
      duplicatePreflightMain(["--issue", `${DESIGN}#21`], cwd, (cmd, args) => {
        asked.push([cmd, ...args]);
        return { status: 0, stdout: "[]" };
      }),
    );
    assert.doesNotMatch(stderr, /fora de issue_repos/, stderr);
    assert.ok(asked.length > 0, "o repo do design foi consultado");
  });

  it("check-issue-open-pr: issue do design de um cwd sem config lista as PRs do design", { skip: SKIP }, () => {
    const cwd = cwdWithoutConfig();
    const asked: string[][] = [];
    const { result, stderr } = captureStderr(() =>
      openPrMain(["--issue", `${DESIGN}#21`], cwd, (cmd, args) => {
        asked.push([cmd, ...args]);
        return { status: 0, stdout: "[]", stderr: "" };
      }),
    );
    assert.doesNotMatch(stderr, /fora de issue_repos/, stderr);
    assert.equal(result, 0);
    assert.ok(asked.some((a) => a.includes(DESIGN)), "busca com -R do design");
  });

  it("scanForeignConvergence: de um cwd sem config, o design ainda é varrido", { skip: SKIP }, () => {
    const cwd = cwdWithoutConfig();
    const asked: string[] = [];
    const scan = scanForeignConvergence({ goal: { target_set: [22] } } as PlanWithGoal, cwd, {}, (_c, repo) => {
      asked.push(repo);
      return { issues: [] };
    });
    assert.deepEqual(asked, [DESIGN]);
    assert.deepEqual(scan.notScanned, []);
  });

  it(
    "CLI check-trade-off-label-cleared de um cwd sem config: issue do design não vira erro de allowlist",
    { skip: SKIP || process.platform === "win32" },
    () => {
      const cwd = cwdWithoutConfig();
      // `gh` falso que falha: o gate segue até a leitura das labels (fail-soft
      // de gh) sem tocar a rede.
      writeFakeGh(cwd, "#!/usr/bin/env bash\necho 'gh falso: offline' >&2\nexit 1\n");
      const tsx = join(ROOT, "node_modules", ".bin", "tsx");
      const r = spawnSync(tsx, [join(ROOT, "scripts", "check-trade-off-label-cleared.ts"), "--issue", `${DESIGN}#21`], {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: fakeGhEnv(cwd),
      });
      assert.doesNotMatch(r.stderr, /fora de issue_repos/, r.stderr);
      assert.match(r.stderr, /gh indisponível/, r.stderr);
    },
  );
});
