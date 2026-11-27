/**
 * #14214 — `claimWorktree` não tinha chamador em produção: o hook
 * `.claude/hooks/block-worktree-alien-commit.mjs` lia
 * `data/sessions/.worktree-claims/`, que ninguém gravava, e a proteção do
 * #7722/#7892/#7903 estava inerte. O subcomando `claim-worktree` do CLI é o
 * chamador; estes testes rodam o CLI de verdade num repo git temporário com
 * worktree vinculado e conferem que o HOOK enxerga a claim gravada (a chave
 * do arquivo tem de bater com a que o hook calcula a partir do
 * `git rev-parse --show-toplevel`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claimWorktreeChecked } from "../scripts/lib/session-registry.ts";
import { SESSION_ID_REQUIRED_SUBCOMMANDS } from "../scripts/lib/session-id-required-subcommands.ts";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(REPO, "scripts", "lib", "session-registry.ts");
const HOOK = join(REPO, ".claude", "hooks", "block-worktree-alien-commit.mjs");
// Import dinâmico por URL: o hook é `.mjs` sem declaração de tipos, e o
// import estático entraria como TS7016 no ratchet de `tsconfig.test.json`.
const hookModule: {
  BLOCK_REASON_BRANCH_DIVERGE: string;
  readWorktreeClaimRecord: (repoRoot: string, checkoutRoot: string) => { sessionId?: string; branch?: string } | null;
} = await import(pathToFileURL(HOOK).href);
const { BLOCK_REASON_BRANCH_DIVERGE, readWorktreeClaimRecord } = hookModule;
// `--import tsx` resolve a partir do cwd; o cwd destes testes é um repo
// temporário sem node_modules, então o loader vai por URL absoluta.
const TSX = import.meta.resolve("tsx");

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function setup(): { tmp: string; mainRepo: string; wt: string } {
  const tmp = mkdtempSync(join(tmpdir(), "claim-worktree-14214-"));
  const mainRepo = join(tmp, "main");
  const wt = join(tmp, "wt");
  mkdirSync(mainRepo, { recursive: true });
  git(["init", "-q"], mainRepo);
  git(["config", "user.email", "test@example.com"], mainRepo);
  git(["config", "user.name", "Test"], mainRepo);
  writeFileSync(join(mainRepo, "README.md"), "x");
  git(["add", "."], mainRepo);
  git(["commit", "-q", "-m", "init"], mainRepo);
  git(["branch", "develop/fix-14214"], mainRepo);
  git(["worktree", "add", "-q", wt, "develop/fix-14214"], mainRepo);
  return { tmp, mainRepo, wt };
}

function cli(cwd: string, ...args: string[]) {
  const res = spawnSync(process.execPath, ["--import", TSX, CLI, "claim-worktree", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DIARIA_INJECTED_SESSION_ID: "" },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function hook(payload: Record<string, unknown>): string {
  const res = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: "utf8" });
  return (res.stdout ?? "").trim();
}

describe("session-registry claim-worktree (#14214)", () => {
  it("grava a claim onde o hook a procura, com a branch do HEAD, e o hook barra o commit de outra sessão", () => {
    const { tmp, mainRepo, wt } = setup();
    try {
      const r = cli(wt, "--session-id", "sessao-dona");
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /claim-worktree ok \(claimed\)/);
      assert.match(r.stdout, /branch=develop\/fix-14214/);

      // O hook resolve o worktree pelo toplevel do git, não pelo path do teste.
      const toplevel = git(["rev-parse", "--show-toplevel"], wt);
      const record = readWorktreeClaimRecord(mainRepo, toplevel);
      assert.ok(record, "o hook não achou a claim gravada pelo CLI");
      assert.equal(record.sessionId, "sessao-dona");
      assert.equal(record.branch, "develop/fix-14214");

      const alien = hook({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "x"' },
        session_id: "outra-sessao",
        cwd: wt,
      });
      assert.ok(alien, "esperava deny para a sessão que não é dona do worktree");
      assert.equal(JSON.parse(alien).hookSpecificOutput?.permissionDecision, "deny");

      const own = hook({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "x"' },
        session_id: "sessao-dona",
        cwd: wt,
      });
      assert.equal(own, "", "a dona do worktree commita sem bloqueio");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("recusa (exit 1) quando outra sessão já segura o worktree, e a dona renova", () => {
    const { tmp, wt } = setup();
    try {
      assert.equal(cli(wt, "--session-id", "sessao-dona").status, 0);
      const intrusa = cli(wt, "--session-id", "sessao-intrusa");
      assert.equal(intrusa.status, 1);
      assert.match(intrusa.stdout, /RECUSADO .* sessao-dona/);
      assert.equal(cli(wt, "--session-id", "sessao-dona").status, 0, "reconfirmar é idempotente");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("claim feita antes do checkout da branch de trabalho barra o commit na branch nova (por isso roda depois)", () => {
    const { tmp, wt } = setup();
    try {
      assert.equal(cli(wt, "--session-id", "sessao-dona").status, 0);
      git(["checkout", "-q", "-b", "develop/outra"], wt);
      const out = hook({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "x"' },
        session_id: "sessao-dona",
        cwd: wt,
      });
      assert.ok(out);
      assert.equal(JSON.parse(out).hookSpecificOutput?.permissionDecisionReason, BLOCK_REASON_BRANCH_DIVERGE);
      // Rodar de novo depois do checkout regrava a branch e libera o commit.
      assert.equal(cli(wt, "--session-id", "sessao-dona").status, 0);
      const again = hook({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "x"' },
        session_id: "sessao-dona",
        cwd: wt,
      });
      assert.equal(again, "");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("nunca reivindica o checkout principal (exit 1, nada gravado)", () => {
    const { tmp, mainRepo } = setup();
    try {
      const r = cli(mainRepo, "--session-id", "sessao-dona");
      assert.equal(r.status, 1);
      assert.match(r.stdout, /não é worktree vinculado/);
      assert.equal(readWorktreeClaimRecord(mainRepo, mainRepo), null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sem --session-id falha alto (a injeção do hook é obrigatória)", () => {
    const { tmp, wt } = setup();
    try {
      const r = cli(wt);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr + r.stdout, /session-id/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("não deixa arquivo de sessão de outro kind em data/sessions/ (o espelho continuo-* do #14214)", () => {
    const { tmp, mainRepo, wt } = setup();
    try {
      assert.equal(cli(wt, "--session-id", "sessao-dona").status, 0);
      const sessions = join(mainRepo, "data", "sessions");
      const files = readdirSync(sessions).filter((f) => f.endsWith(".json"));
      assert.deepEqual(files, [], `arquivos de sessão inesperados: ${files.join(", ")}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("claimWorktreeChecked normaliza caminho relativo para o mesmo hash do hook", () => {
    const { tmp, mainRepo, wt } = setup();
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      const r = claimWorktreeChecked("wt", "sessao-dona", mainRepo);
      assert.equal(r.outcome, "claimed");
      process.chdir(prev);
      assert.equal(readWorktreeClaimRecord(mainRepo, git(["rev-parse", "--show-toplevel"], wt))?.sessionId, "sessao-dona");
    } finally {
      process.chdir(prev);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("claim-worktree está na lista de subcomandos que recebem --session-id injetado", () => {
    assert.ok((SESSION_ID_REQUIRED_SUBCOMMANDS as readonly string[]).includes("claim-worktree"));
  });
});
