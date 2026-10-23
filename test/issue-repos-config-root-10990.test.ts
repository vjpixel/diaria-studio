/**
 * test/issue-repos-config-root-10990.test.ts (#10990)
 *
 * Resíduo do #10901/#10910: `check-pr-terminal-state`, `check-skipped-develop-track`
 * e `sync-issue-labels` ainda liam a allowlist `issue_repos` de
 * `process.cwd()`. Rodados do worktree do diaria-design (sem
 * `platform.config.json`), o ENOENT era silencioso e a allowlist virava só o
 * studio: o design era "não verificado" (exit 2), "NÃO avaliado" (PARCIAL) ou
 * recusado. Este teste roda os três de um cwd SEM config, com `gh` falso.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadIssueRepos } from "../scripts/lib/issue-repos.ts";
import { main as syncLabelsMain, type GhRunner } from "../scripts/sync-issue-labels.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN = "vjpixel/diaria-design";
const SCRIPTS = ["check-pr-terminal-state.ts", "check-skipped-develop-track.ts", "sync-issue-labels.ts"];
// O cenário só existe se o config real permite o design (#10618 fatia 4).
const SKIP = !loadIssueRepos(ROOT).includes(DESIGN);
const SKIP_CLI = SKIP || process.platform === "win32";

const tmpDirs: string[] = [];
function cwdWithoutConfig(): string {
  const d = mkdtempSync(join(tmpdir(), "gate-cwd-10990-"));
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** `gh` falso no PATH: grava cada invocação em `calls.log` e responde pelo
 * subcomando (`pr list` → `[]`; `api repos/.../issues/N` → issue aberta com
 * `develop-track`). Nada toca a rede. */
function installFakeGh(dir: string): string {
  const log = join(dir, "calls.log");
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env bash",
      `echo "$*" >> "${log}"`,
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi',
      'if [ "$1" = "api" ]; then echo \'{"labels":[{"name":"develop-track"}],"body":"","state":"open"}\'; exit 0; fi',
      "echo 'gh falso: comando inesperado' >&2",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  return log;
}

function runCli(script: string, args: string[], cwd: string) {
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  return spawnSync(tsx, [join(ROOT, "scripts", script), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PATH: `${cwd}${delimiter}${process.env.PATH ?? ""}` },
  });
}

describe("#10990 — check-pr-terminal-state, check-skipped-develop-track e sync-issue-labels resolvem issue_repos pela raiz do módulo", () => {
  for (const script of SCRIPTS) {
    it(`${script} não resolve a allowlist pelo cwd`, () => {
      const src = readFileSync(join(ROOT, "scripts", script), "utf8");
      assert.match(src, /loadIssueRepos\(ISSUE_REPOS_CONFIG_ROOT\)/);
      assert.doesNotMatch(src, /loadIssueRepos\((cwd|_cwd|process\.cwd\(\))\)/);
    });
  }

  it("sync-issue-labels: --repo do design aceito de um cwd sem config (não recusa como fora de issue_repos)", { skip: SKIP }, () => {
    const cwd = cwdWithoutConfig();
    const calls: string[][] = [];
    const run: GhRunner = (args) => {
      calls.push(args);
      return { status: 0, stdout: "[]", stderr: "" };
    };
    const errs: string[] = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
    console.log = () => {};
    let code: number;
    try {
      code = syncLabelsMain(["--repo", DESIGN, "--dry-run"], cwd, run);
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
    assert.doesNotMatch(errs.join("\n"), /fora de platform\.config\.json/, errs.join("\n"));
    assert.equal(code, 0);
    assert.ok(calls.some((c) => c.includes(DESIGN)), "listou as labels do design");
  });

  it("CLI check-skipped-develop-track de um cwd sem config: entrada do design é verificada (não exit 2)", { skip: SKIP_CLI }, () => {
    const cwd = cwdWithoutConfig();
    const log = installFakeGh(cwd);
    const plan = join(cwd, "plan.json");
    writeFileSync(
      plan,
      JSON.stringify({ issues: [{ number: 21, ref: `${DESIGN}#21`, status: "pulada", motivo: "requer-sessao-local" }] }),
    );
    const r = runCli("check-skipped-develop-track.ts", ["--plan", plan], cwd);
    assert.doesNotMatch(r.stderr, /fora de issue_repos/, r.stderr);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(readFileSync(log, "utf8"), /api repos\/vjpixel\/diaria-design\/issues\/21/);
  });

  it("CLI check-pr-terminal-state de um cwd sem config: PRs do design são consultados (sem ressalva PARCIAL)", { skip: SKIP_CLI }, () => {
    const cwd = cwdWithoutConfig();
    const log = installFakeGh(cwd);
    const plan = join(cwd, "plan.json");
    writeFileSync(plan, JSON.stringify({ issues: [{ number: 21, ref: `${DESIGN}#21`, status: "mergeada" }] }));
    const r = runCli("check-pr-terminal-state.ts", ["--plan", plan, "--root", cwd], cwd);
    assert.doesNotMatch(r.stderr, /fora de issue_repos/, r.stderr);
    assert.match(readFileSync(log, "utf8"), /pr list -R vjpixel\/diaria-design/);
  });
});
