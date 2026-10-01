/**
 * test/pr-gates-merge-base-9411.test.ts (#9411)
 *
 * Regressão: os gates de PR listavam arquivos com `BASE_SHA..HEAD_SHA`
 * (2 pontos). `pull_request.base.sha` é o tip ATUAL do master; quando o
 * master avança depois da criação do branch, o diff de 2 pontos arrasta
 * (invertido) tudo que o master mudou — editorial-signoff, agent-eval,
 * bugfix, seed-html-sync e one-off-script disparavam sobre arquivos que a
 * PR nunca tocou. Mesma classe do #9403 (removal declaration). Os gates
 * passaram a medir contra o merge-base (3 pontos) e a ler o conteúdo
 * "antigo" no merge-base.
 *
 * Repo git real e descartável: a semântica 2 vs 3 pontos é do git, um
 * spawn falso não provaria nada.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getChangedFiles as seedGetChangedFiles } from "../scripts/check-seed-html-sync.ts";
import { getAddedScriptRootFiles } from "../scripts/check-one-off-script-validity.ts";
import { gitDiffTouchedLines, gitMergeBase } from "../scripts/lib/diff-touched-lines.ts";

function isolatedEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  return env;
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: isolatedEnv(cwd) });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
  return r.stdout.trim();
}

describe("#9411 — gates de PR medem contra o merge-base", () => {
  let dir: string;
  let forkSha: string; // ponto onde o branch saiu
  let baseSha: string; // tip do master DEPOIS de avançar (o que o evento manda)
  let headSha: string;
  // spawn que roda no repo descartável (as funções dos gates não aceitam cwd).
  const spawnInRepo = ((cmd: string, args: string[], opts: Record<string, unknown>) =>
    spawnSync(cmd, args, { ...opts, cwd: dir, env: isolatedEnv(dir) })) as unknown as typeof spawnSync;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "diaria-9411-"));
    git(dir, "init", "-q", "-b", "master");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "commit.gpgsign", "false");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n");
    writeFileSync(join(dir, "b.txt"), "x\ny\nz\n");
    writeFileSync(join(dir, "scripts/old-one.ts"), "// velho\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    forkSha = git(dir, "rev-parse", "HEAD");

    // Branch da PR: muda a.txt e adiciona 1 script.
    git(dir, "checkout", "-q", "-b", "pr");
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n4\n");
    writeFileSync(join(dir, "scripts/new-pr.ts"), "// pr\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "pr");
    headSha = git(dir, "rev-parse", "HEAD");

    // Master avança: muda b.txt, adiciona e remove scripts. Nada disso é da PR.
    git(dir, "checkout", "-q", "master");
    writeFileSync(join(dir, "b.txt"), "x\nY\nz\n");
    writeFileSync(join(dir, "scripts/master-only.ts"), "// master\n");
    git(dir, "rm", "-q", "scripts/old-one.ts");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "master avança");
    baseSha = git(dir, "rev-parse", "HEAD");
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sanidade: 2 pontos lista arquivos que só o master mudou (o bug)", () => {
    const out = git(dir, "diff", "--name-only", `${baseSha}..${headSha}`).split("\n").sort();
    assert.deepEqual(out, ["a.txt", "b.txt", "scripts/master-only.ts", "scripts/new-pr.ts", "scripts/old-one.ts"]);
  });

  it("check-seed-html-sync lista só o que a PR tocou", () => {
    assert.deepEqual(seedGetChangedFiles(baseSha, headSha, spawnInRepo).sort(), ["a.txt", "scripts/new-pr.ts"]);
  });

  it("check-one-off-script-validity não vê script removido no master como adicionado pela PR", () => {
    assert.deepEqual(getAddedScriptRootFiles(baseSha, headSha, spawnInRepo), ["scripts/new-pr.ts"]);
  });

  it("gitDiffTouchedLines ignora arquivo mudado só no master", () => {
    assert.deepEqual([...gitDiffTouchedLines(dir, baseSha, headSha, "b.txt")], []);
    assert.deepEqual([...gitDiffTouchedLines(dir, baseSha, headSha, "a.txt")], [4]);
  });

  it("gitMergeBase devolve o ponto de fork (conteúdo antigo dos gates de signoff/agent-eval)", () => {
    assert.equal(gitMergeBase(dir, baseSha, headSha), forkSha);
    assert.throws(() => gitMergeBase(dir, "deadbeef", headSha));
  });

  it("nenhum gate de PR usa mais o diff de 2 pontos", () => {
    for (const rel of [
      "../scripts/check-editorial-signoff.ts",
      "../scripts/check-agent-eval-required.ts",
      "../scripts/check-one-off-script-validity.ts",
      "../scripts/check-pr-bugfix.ts",
      "../scripts/check-seed-html-sync.ts",
      "../scripts/lib/diff-touched-lines.ts",
    ]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      assert.doesNotMatch(src, /\$\{baseSha\}\.\.\$\{headSha\}/, `${rel} ainda usa base..head`);
      assert.match(src, /\$\{baseSha\}\.\.\.\$\{headSha\}/, `${rel} deveria usar base...head`);
    }
  });

  it("signoff e agent-eval leem o conteúdo antigo no merge-base, não no tip do master", () => {
    for (const rel of ["../scripts/check-editorial-signoff.ts", "../scripts/check-agent-eval-required.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      assert.doesNotMatch(src, /gitShowFileAtSha\([^,]+, baseSha,/, `${rel} ainda lê o conteúdo antigo em baseSha`);
      assert.match(src, /gitShowFileAtSha\([^,]+, mergeBaseSha,/);
    }
  });
});
