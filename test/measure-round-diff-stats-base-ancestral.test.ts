/**
 * test/measure-round-diff-stats-base-ancestral.test.ts (#10422)
 *
 * Regressão: na sessão /diaria-develop 261018 o checkout local estava 34
 * commits ATRÁS da base da rodada; `git diff base..HEAD` não errou, devolveu
 * o diff invertido (+595/−7573) e o CLI persistiu o evento em
 * `data/run-log.jsonl` como rodada real. Agora o CLI recusa (exit 1, nada
 * persistido) quando `--base` não é ancestral de `--head`.
 *
 * Usa um repositório git temporário como cwd — `logEvent` grava em
 * `{cwd}/data/run-log.jsonl`, então nada toca o run-log real do projeto.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkIsAncestor } from "../scripts/lib/diff-line-stats.ts";
import {
  excludeInvalidatedRoundDiffStats,
  findRoundDiffStatsInvalidation,
  type RoundDiffStatsRecord,
} from "../scripts/lib/round-diff-stats.ts";
import { readAllRoundDiffStatsRecords, readRoundDiffStatsRecords } from "../scripts/round-diff-stats-report.ts";

const CLI = fileURLToPath(new URL("../scripts/measure-round-diff-stats.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(
  fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
).href;

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} falhou: ${r.stderr}`);
  return r.stdout.trim();
}

/** Repo com 2 commits: A (base antiga) → B (base nova). Devolve os shas. */
function makeRepo(): { dir: string; a: string; b: string } {
  const dir = mkdtempSync(join(tmpdir(), "round-diff-10422-"));
  roots.push(dir);
  git(dir, ["init", "-q", "-b", "master"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "f.txt"), "1\n");
  git(dir, ["add", "f.txt"]);
  git(dir, ["commit", "-q", "-m", "A"]);
  const a = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "f.txt"), "1\n2\n3\n");
  git(dir, ["commit", "-q", "-am", "B"]);
  const b = git(dir, ["rev-parse", "HEAD"]);
  return { dir, a, b };
}

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI, ...args], { cwd, encoding: "utf8" });
}

describe("measure-round-diff-stats: base precisa ser ancestral do HEAD (#10422)", () => {
  it("HEAD atrás da base → exit 1 e nada persistido", () => {
    const { dir, a, b } = makeRepo();
    git(dir, ["checkout", "-q", a]); // checkout local ATRÁS da base da rodada
    const r = run(dir, ["--base", b, "--session-kind", "develop"]);
    assert.equal(r.status, 1, `esperava exit 1. stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stderr, /não é ancestral/);
    assert.match(r.stderr, /nada persistido/);
    assert.equal(existsSync(join(dir, "data", "run-log.jsonl")), false, "run-log não pode ter sido criado");
  });

  it("recusa também em --dry-run (não imprime a medida invertida)", () => {
    const { dir, a, b } = makeRepo();
    git(dir, ["checkout", "-q", a]);
    const r = run(dir, ["--base", b, "--session-kind", "develop", "--dry-run"]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /\+\d+\/-\d+/);
  });

  it("base inexistente → exit 1 com erro de verificação, nada persistido", () => {
    const { dir } = makeRepo();
    const r = run(dir, ["--base", "deadbeefdeadbeef", "--session-kind", "develop"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /não foi possível verificar/);
    assert.equal(existsSync(join(dir, "data", "run-log.jsonl")), false);
  });

  it("base ancestral do HEAD → mede e persiste normalmente", () => {
    const { dir, a } = makeRepo();
    const r = run(dir, ["--base", a, "--session-kind", "develop"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const log = readFileSync(join(dir, "data", "run-log.jsonl"), "utf8").trim().split("\n");
    assert.equal(log.length, 1);
    const ev = JSON.parse(log[0]);
    assert.equal(ev.message, "round_diff_stats");
    assert.equal(ev.details.added, 2);
    assert.equal(ev.details.removed, 0);
  });

  it("checkIsAncestor distingue ancestor / not-ancestor / error", () => {
    const { dir, a, b } = makeRepo();
    assert.equal(checkIsAncestor(a, b, { cwd: dir }).verdict, "ancestor");
    assert.equal(checkIsAncestor(b, a, { cwd: dir }).verdict, "not-ancestor");
    assert.equal(checkIsAncestor("nao-existe", b, { cwd: dir }).verdict, "error");
  });
});

describe("round-diff-stats-report ignora o evento inválido de 261018 (#10422)", () => {
  const rec = (sessionKind: RoundDiffStatsRecord["sessionKind"], base: string): RoundDiffStatsRecord => ({
    sessionKind,
    base,
    head: "HEAD",
    files: 138,
    added: 595,
    removed: 7573,
    ratio: 595 / 7573,
    net: 595 - 7573,
    capturedAt: "2026-10-18T18:00:00.000Z",
  });

  it("exclui develop com base 12353910b… (sha curto ou completo), mantém o resto", () => {
    const bad = rec("develop", "12353910b");
    const badFull = rec("develop", "12353910b0123456789abcdef0123456789abcde");
    const otherKind = rec("overnight", "12353910b");
    const ok = rec("develop", "a84349195");
    const { valid, excluded } = excludeInvalidatedRoundDiffStats([bad, badFull, otherKind, ok]);
    assert.deepEqual(excluded, [bad, badFull]);
    assert.deepEqual(valid, [otherKind, ok]);
    assert.match(findRoundDiffStatsInvalidation(bad)!.reason, /#10422/);
    assert.equal(findRoundDiffStatsInvalidation(ok), null);
  });

  it("readRoundDiffStatsRecords não devolve o evento inválido lido do run-log", () => {
    const dir = mkdtempSync(join(tmpdir(), "round-diff-report-10422-"));
    roots.push(dir);
    mkdirSync(join(dir, "data"));
    const line = (r: RoundDiffStatsRecord) =>
      JSON.stringify({ timestamp: r.capturedAt, message: "round_diff_stats", details: r });
    writeFileSync(
      join(dir, "data", "run-log.jsonl"),
      [line(rec("develop", "12353910b")), line(rec("develop", "a84349195"))].join("\n") + "\n",
    );
    assert.equal(readAllRoundDiffStatsRecords(dir).length, 2);
    const records = readRoundDiffStatsRecords(dir);
    assert.deepEqual(records.map((r) => r.base), ["a84349195"]);
  });
});
