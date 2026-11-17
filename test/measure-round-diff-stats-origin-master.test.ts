/**
 * test/measure-round-diff-stats-origin-master.test.ts (#13425)
 *
 * Regressão: checkout parado na própria base (ff recusado) gravava `+0/-0`.
 * Sem `--head`, o CLI faz fetch e mede contra origin/master; fetch falho com
 * HEAD atrás do origin/master local recusa.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI = fileURLToPath(new URL("../scripts/measure-round-diff-stats.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(
  fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
).href;
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} falhou: ${r.stderr}`);
  return r.stdout.trim();
}
function init(dir: string) {
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

/** origin (bare) + clone parado na base; origin recebe um commit novo (+2 linhas) depois. */
function makeScenario() {
  const root = mkdtempSync(join(tmpdir(), "round-diff-13425-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const clone = join(root, "clone");
  git(root, ["init", "-q", "--bare", "-b", "master", origin]);
  git(root, ["clone", "-q", origin, work]);
  init(work);
  writeFileSync(join(work, "f.txt"), "1\n");
  git(work, ["add", "f.txt"]);
  git(work, ["commit", "-q", "-m", "A"]);
  git(work, ["push", "-q", "origin", "HEAD:master"]);
  git(root, ["clone", "-q", origin, clone]);
  init(clone);
  const base = git(clone, ["rev-parse", "HEAD"]);
  writeFileSync(join(work, "f.txt"), "1\n2\n3\n");
  git(work, ["commit", "-q", "-am", "B"]);
  git(work, ["push", "-q", "origin", "HEAD:master"]);
  return { root, origin, clone, base };
}
function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI, ...args], { cwd, encoding: "utf8" });
}
function lastEvent(dir: string) {
  const lines = readFileSync(join(dir, "data", "run-log.jsonl"), "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

describe("measure-round-diff-stats mede contra origin/master (#13425)", () => {
  it("checkout na própria base, origin à frente → mede +2/-0, não +0/-0", () => {
    const { clone, base } = makeScenario();
    const r = run(clone, ["--base", base, "--session-kind", "develop"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /atrás de origin\/master/);
    const ev = lastEvent(clone);
    assert.equal(ev.details.added, 2);
    assert.equal(ev.details.removed, 0);
    assert.equal(ev.details.head, "origin/master");
  });

  it("fetch falha e origin/master local está à frente → recusa, nada persistido", () => {
    const { clone, base, origin } = makeScenario();
    git(clone, ["fetch", "-q", "origin"]); // origin/master local à frente de HEAD
    rmSync(origin, { recursive: true, force: true }); // fetch passa a falhar
    const r = run(clone, ["--base", base, "--session-kind", "develop"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /nada persistido/);
    assert.match(r.stderr, /fetch origin falhou/);
    assert.equal(existsSync(join(clone, "data", "run-log.jsonl")), false);
  });

  it("--head explícito não faz fetch nem troca o head", () => {
    const { clone, base } = makeScenario();
    const r = run(clone, ["--base", base, "--head", "HEAD", "--session-kind", "develop", "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /\+0\/-0/);
  });
});
