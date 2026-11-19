/**
 * test/measure-round-diff-stats-own-shas.test.ts (#13606)
 *
 * Rodada com 1 merge próprio e 2 merges alheios no mesmo intervalo mede só o
 * próprio quando `--own-shas` é passado; sem PR da sessão (`--own-shas ""`) o
 * diff é zero; sem a flag, o comportamento `base..head` não muda.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const CLI = resolve(ROOT, "scripts/measure-round-diff-stats.ts");

let repo: string;
let base: string;
let own: string;
let head: string;

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function commit(file: string, lines: number, msg: string): string {
  writeFileSync(join(repo, file), Array.from({ length: lines }, (_, i) => `l${i}`).join("\n") + "\n");
  git("add", file);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
}
function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX, CLI, ...args, "--dry-run"], { encoding: "utf8", cwd: repo });
}

describe("measure-round-diff-stats --own-shas (#13606)", () => {
  before(() => {
    repo = mkdtempSync(join(tmpdir(), "rds-own-"));
    git("init", "-q");
    base = commit("seed.txt", 1, "seed");
    commit("foreign1.txt", 100, "alheio 1");
    own = commit("own.txt", 5, "próprio");
    head = commit("foreign2.txt", 200, "alheio 2");
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it("mede só o commit próprio entre 2 alheios", () => {
    const r = run(["--base", base, "--head", head, "--session-kind", "develop", "--own-shas", own]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\+5\/-0 \(1 arquivo/);
  });

  it("SHA repetido (lote do trem: várias PRs, 1 commit) conta uma vez só (#13672)", () => {
    const r = run(["--base", base, "--head", head, "--session-kind", "develop", "--own-shas", `${own},${own},${own}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\+5\/-0 \(1 arquivo/);
  });

  it("sem PR da sessão o diff é zero", () => {
    const r = run(["--base", base, "--head", head, "--session-kind", "develop", "--own-shas", ""]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\+0\/-0 \(0 arquivo/);
  });

  it("sem a flag mantém base..head inteiro", () => {
    const r = run(["--base", base, "--head", head, "--session-kind", "develop"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\+305\/-0 \(3 arquivo/);
  });
});
