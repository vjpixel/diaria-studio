/**
 * test/hooks-foreign-checkout-12951.test.ts (#12951)
 *
 * Na /diaria-develop 261112 (PR vjpixel/dossiemaster#2) o guard do snapshot do
 * orquestrador (#8732) rodou no worktree do dossiemaster e bloqueou o
 * `gh pr create` por não achar `test/orchestrator-prompt.test.ts`, que só
 * existe no studio; o `origin` daquele checkout não identificava o repo, e
 * alvo indeterminado caía na regra do studio. A linha de log do bloqueio foi
 * para `data/run-log.jsonl` DENTRO do worktree externo e travou o
 * `git worktree remove`.
 *
 * Aqui: `isStudioCheckout`/`studioLogRoot` em repos git reais num tmpdir, e o
 * hook do snapshot rodando de ponta a ponta a partir de uma cópia de
 * `.claude/hooks` num "studio" falso (o log nunca toca o `data/` real).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitCommonDir, isStudioCheckout, studioLogRoot } from "../.claude/hooks/lib/studio-checkout.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

describe("#12951: hooks do studio reconhecem checkout de outro repo", () => {
  let tmp = "";
  let studio = "";
  let studioWt = "";
  let foreign = "";
  let studioClone = "";
  let hookDir = "";

  before(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "hooks-foreign-12951-")));
    studio = join(tmp, "studio");
    foreign = join(tmp, "dossiemaster");
    studioClone = join(tmp, "studio-clone");
    for (const d of [studio, foreign, studioClone]) {
      mkdirSync(d, { recursive: true });
      git(d, "init", "-q");
      git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    }
    // `origin` que não identifica o repo (clone local): o alvo fica indeterminado.
    git(foreign, "remote", "add", "origin", join(tmp, "algum-clone-local"));
    cpSync(join(ROOT, ".claude", "hooks"), join(studio, ".claude", "hooks"), { recursive: true });
    cpSync(join(ROOT, ".claude", "hooks"), join(studioClone, ".claude", "hooks"), { recursive: true });
    studioWt = join(tmp, "studio-wt");
    git(studio, "worktree", "add", "-q", "-b", "wt", studioWt);
    // Os hooks copiados não foram commitados: o worktree só ganha o diretório.
    mkdirSync(join(studioWt, ".claude", "hooks"), { recursive: true });
    hookDir = join(studio, ".claude", "hooks");
  });

  after(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("gitCommonDir: o worktree aponta para o .git do checkout principal", () => {
    assert.equal(gitCommonDir(studioWt), gitCommonDir(studio));
    assert.equal(gitCommonDir(join(tmp, "nao-existe")), null);
  });

  it("studioLogRoot: sempre o checkout principal do studio", () => {
    assert.equal(studioLogRoot(hookDir), studio);
    assert.equal(studioLogRoot(join(studioWt, ".claude", "hooks")), studio);
  });

  it("isStudioCheckout: worktree do studio, clone do studio e repo de fora", () => {
    assert.equal(isStudioCheckout(studio, hookDir), true);
    assert.equal(isStudioCheckout(studioWt, hookDir), true);
    assert.equal(isStudioCheckout(studioClone, hookDir), true, "clone próprio (item 33) traz a assinatura do studio");
    assert.equal(isStudioCheckout(foreign, hookDir), false);
    assert.equal(isStudioCheckout(join(tmp, "nao-existe"), hookDir), null, "indeterminado mantém a regra");
  });

  it("hook do snapshot: PR saindo do dossiemaster passa e o log vai para o data/ do studio", { timeout: 60_000 }, () => {
    const payload = {
      tool_name: "Bash",
      cwd: foreign,
      tool_input: { command: "gh pr create --title t --body b" },
    };
    const r = spawnSync(process.execPath, [join(hookDir, "block-pr-create-orchestrator-snapshot-stale.mjs")], {
      cwd: foreign,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 50_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /deny/, "não bloqueia PR de outro repo");
    assert.equal(existsSync(join(foreign, "data")), false, "nada gravado no checkout externo");
    const log = readFileSync(join(studio, "data", "run-log.jsonl"), "utf8");
    assert.match(log, /orchestrator_snapshot_pr_guard_skipped_foreign_checkout/);
  });

  it("os guards de typecheck e de test runner usam a mesma checagem", () => {
    const tsc = readFileSync(join(ROOT, ".claude/hooks/block-pr-create-tsc-failure.mjs"), "utf8");
    assert.match(tsc, /isStudioCheckout\(cwd, hookDir\) === false/);
    assert.doesNotMatch(tsc, /repoRoot: cwd/, "log do tsc guard nunca no cwd");
    const runner = readFileSync(join(ROOT, ".claude/hooks/block-pr-create-test-runner-import.mjs"), "utf8");
    assert.match(runner, /isStudioCheckout\(cwd, hookDir\) === false/);
    const snap = readFileSync(join(ROOT, ".claude/hooks/block-pr-create-orchestrator-snapshot-stale.mjs"), "utf8");
    assert.doesNotMatch(snap, /repoRoot: cwd/, "log do snapshot guard nunca no cwd");
  });
});
