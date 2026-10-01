/**
 * test/pr-removal-declaration-merge-base-9403.test.ts (#9403)
 *
 * Regressão: `check-pr-removal-declaration` (#7115) contava as linhas com
 * `BASE_SHA..HEAD_SHA` (2 pontos). Quando o master avança depois da criação
 * do branch, `base.sha` do evento `pull_request` aponta pro master NOVO e o
 * diff de 2 pontos arrasta (invertido) tudo que o master ganhou — PR +10/−7
 * reportada como "adiciona 1114 linhas". O gate passou a medir contra o
 * merge-base (3 pontos).
 *
 * Usa um repo git real e descartável num tmpdir: a semântica 2 vs 3 pontos
 * é do próprio git, um spawn falso não provaria nada.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getDiffLineStats } from "../scripts/lib/diff-line-stats.ts";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
  return r.stdout.trim();
}

describe("#9403 — removal declaration conta contra o merge-base", () => {
  let dir: string;
  let baseSha: string; // tip do master DEPOIS de avançar (o que o evento manda)
  let headSha: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "diaria-9403-"));
    git(dir, "init", "-q", "-b", "master");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n");
    writeFileSync(join(dir, "old.txt"), Array.from({ length: 1000 }, (_, i) => `o${i}`).join("\n") + "\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");

    // Branch da PR: +2 linhas.
    git(dir, "checkout", "-q", "-b", "pr");
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n4\n5\n");
    git(dir, "commit", "-q", "-am", "pr");
    headSha = git(dir, "rev-parse", "HEAD");

    // Master avança depois da criação do branch: remove 1000 linhas (que o
    // diff de 2 pontos enxerga, invertido, como ADIÇÃO da PR).
    git(dir, "checkout", "-q", "master");
    git(dir, "rm", "-q", "old.txt");
    git(dir, "commit", "-q", "-m", "master avança");
    baseSha = git(dir, "rev-parse", "HEAD");
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("2 pontos inclui o avanço do master (o bug)", () => {
    const stats = getDiffLineStats(baseSha, headSha, { cwd: dir });
    assert.equal(stats.added, 1002, "diff de 2 pontos conta o old.txt removido no master como adição da PR");
  });

  it("mergeBase: true conta só o que a PR introduziu", () => {
    const stats = getDiffLineStats(baseSha, headSha, { cwd: dir, mergeBase: true });
    assert.deepEqual(stats, { files: 1, added: 2, removed: 0 });
  });

  it("check-pr-removal-declaration.ts mede com mergeBase: true", () => {
    const src = readFileSync(resolve("scripts/check-pr-removal-declaration.ts"), "utf8");
    assert.match(src, /getDiffLineStats\(baseSha, headSha, \{ mergeBase: true \}\)/);
  });
});
