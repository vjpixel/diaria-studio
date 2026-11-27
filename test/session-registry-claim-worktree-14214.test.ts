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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  claimWorktreeChecked,
  gcExpiredWorktreeClaims,
  renewWorktreeClaimsForSession,
  unclaimWorktree,
  WORKTREE_CLAIM_TTL_MS,
} from "../scripts/lib/session-registry.ts";
import { SESSION_ID_REQUIRED_SUBCOMMANDS } from "../scripts/lib/session-id-required-subcommands.ts";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(REPO, "scripts", "lib", "session-registry.ts");
const HOOK = join(REPO, ".claude", "hooks", "block-worktree-alien-commit.mjs");
// Import dinâmico por URL: o hook é `.mjs` sem declaração de tipos, e o
// import estático entraria como TS7016 no ratchet de `tsconfig.test.json`.
const hookModule: {
  BLOCK_REASON_BRANCH_DIVERGE: string;
  readWorktreeClaimRecord: (repoRoot: string, checkoutRoot: string) => { sessionId?: string; branch?: string } | null;
  getHeadBranch: (checkoutRoot: string) => string | null;
} = await import(pathToFileURL(HOOK).href);
const { BLOCK_REASON_BRANCH_DIVERGE, readWorktreeClaimRecord, getHeadBranch } = hookModule;
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
      // Sem flag, rodar de novo recusa: regravar a branch em silêncio apagaria
      // a evidência que BLOCK_REASON_BRANCH_DIVERGE mostra.
      const plain = cli(wt, "--session-id", "sessao-dona");
      assert.equal(plain.status, 1);
      assert.match(plain.stdout, /gravou a branch develop\/fix-14214 e o HEAD está em develop\/outra/);
      // --renew estende o prazo e preserva a branch gravada: o commit segue barrado.
      assert.equal(cli(wt, "--session-id", "sessao-dona", "--renew").status, 0);
      assert.ok(hook({ tool_name: "Bash", tool_input: { command: 'git commit -m "x"' }, session_id: "sessao-dona", cwd: wt }));
      // --rebind (o próprio agente fez o checkout) regrava a branch e libera o commit.
      assert.equal(cli(wt, "--session-id", "sessao-dona", "--rebind").status, 0);
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

  it("claim-worktree e unclaim-worktree estão na lista de subcomandos que recebem --session-id injetado", () => {
    assert.ok((SESSION_ID_REQUIRED_SUBCOMMANDS as readonly string[]).includes("claim-worktree"));
    assert.ok((SESSION_ID_REQUIRED_SUBCOMMANDS as readonly string[]).includes("unclaim-worktree"));
  });

  it("TTL de 3h; heartbeat da sessão dona renova sem mexer na branch; claim vencida não ressuscita", () => {
    const { tmp, mainRepo, wt } = setup();
    try {
      const before = Date.now();
      assert.equal(cli(wt, "--session-id", "sessao-dona").status, 0);
      const toplevel = git(["rev-parse", "--show-toplevel"], wt);
      const file = claimFileFor(mainRepo, toplevel);
      const first = JSON.parse(readFileSync(file, "utf8"));
      assert.ok(first.expires_at >= before + WORKTREE_CLAIM_TTL_MS - 1000, "TTL menor que 3h");

      // Faltando 1 min para vencer, o heartbeat empurra para agora + TTL.
      writeFileSync(file, JSON.stringify({ ...first, expires_at: Date.now() + 60_000 }));
      const hb = spawnSync(process.execPath, ["--import", TSX, CLI, "heartbeat", "--kind", "develop", "--session-id", "sessao-dona"], {
        cwd: wt,
        encoding: "utf8",
        env: { ...process.env, DIARIA_INJECTED_SESSION_ID: "" },
      });
      assert.equal(hb.status, 0, (hb.stdout ?? "") + (hb.stderr ?? ""));
      assert.match(hb.stdout ?? "", /1 claim\(s\) de worktree renovada/);
      const renewed = JSON.parse(readFileSync(file, "utf8"));
      assert.ok(renewed.expires_at > Date.now() + WORKTREE_CLAIM_TTL_MS - 60_000);
      assert.equal(renewed.branch, "develop/fix-14214");

      // Heartbeat de outra sessão não toca a claim; claim vencida não volta.
      assert.equal(renewWorktreeClaimsForSession(mainRepo, "outra-sessao"), 0);
      writeFileSync(file, JSON.stringify({ ...renewed, expires_at: Date.now() - 1000 }));
      assert.equal(renewWorktreeClaimsForSession(mainRepo, "sessao-dona"), 0);
      assert.equal(readWorktreeClaimRecord(mainRepo, toplevel), null, "vencida, o hook ignora");
      // --renew sem claim viva não reivindica nada.
      assert.equal(cli(wt, "--session-id", "sessao-dona", "--renew").status, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("unclaim-worktree solta só a claim da própria sessão", () => {
    const { tmp, mainRepo, wt } = setup();
    try {
      assert.equal(cli(wt, "--session-id", "sessao-dona").status, 0);
      const toplevel = git(["rev-parse", "--show-toplevel"], wt);
      assert.equal(unclaimWorktree(toplevel, "outra-sessao", mainRepo), "blocked-by-other");
      assert.ok(readWorktreeClaimRecord(mainRepo, toplevel));
      const r = spawnSync(process.execPath, ["--import", TSX, CLI, "unclaim-worktree", "--session-id", "sessao-dona"], {
        cwd: wt,
        encoding: "utf8",
      });
      assert.equal(r.status, 0, (r.stdout ?? "") + (r.stderr ?? ""));
      assert.equal(readWorktreeClaimRecord(mainRepo, toplevel), null);
      assert.equal(unclaimWorktree(toplevel, "sessao-dona", mainRepo), "no-op-not-claimed");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gc recolhe claim vencida há mais de 7 dias e mantém a recente", () => {
    const { tmp, mainRepo, wt } = setup();
    try {
      assert.equal(cli(wt, "--session-id", "sessao-dona").status, 0);
      const file = claimFileFor(mainRepo, git(["rev-parse", "--show-toplevel"], wt));
      const rec = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...rec, expires_at: Date.now() - 24 * 60 * 60 * 1000 }));
      assert.deepEqual(gcExpiredWorktreeClaims(mainRepo), [], "vencida há 1 dia fica");
      writeFileSync(file, JSON.stringify({ ...rec, expires_at: Date.now() - 8 * 24 * 60 * 60 * 1000 }));
      assert.equal(gcExpiredWorktreeClaims(mainRepo, { dryRun: true }).length, 1);
      assert.ok(existsSync(file), "dry-run não remove");
      assert.equal(gcExpiredWorktreeClaims(mainRepo).length, 1);
      assert.ok(!existsSync(file));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("HEAD destacado (rebase com conflito) não nega o commit da dona — fail-open", () => {
    const { tmp, wt } = setup();
    try {
      assert.equal(cli(wt, "--session-id", "sessao-dona").status, 0);
      git(["checkout", "-q", "--detach"], wt);
      const out = hook({ tool_name: "Bash", tool_input: { command: 'git commit -m "x"' }, session_id: "sessao-dona", cwd: wt });
      assert.equal(out, "");
      assert.equal(getHeadBranch(wt), null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--path manual com outra caixa na letra do drive cai na mesma chave do hook", { skip: process.platform !== "win32" }, () => {
    const { tmp, mainRepo, wt } = setup();
    try {
      const toplevel = git(["rev-parse", "--show-toplevel"], wt);
      const flipped = toplevel[0] === toplevel[0].toUpperCase()
        ? toplevel[0].toLowerCase() + toplevel.slice(1)
        : toplevel[0].toUpperCase() + toplevel.slice(1);
      assert.equal(cli(mainRepo, "--session-id", "sessao-dona", "--path", flipped.replaceAll("/", "\\")).status, 0);
      assert.equal(readWorktreeClaimRecord(mainRepo, toplevel)?.sessionId, "sessao-dona");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/** Caminho do arquivo de claim que o hook lê (mesma chave, cópia do teste). */
function claimFileFor(mainRepo: string, toplevel: string): string {
  const normalized = resolve(toplevel).replaceAll("\\", "/").replace(/\/+$/, "");
  const key = createHash("sha256").update(normalized).digest("hex").slice(0, 20);
  return join(mainRepo, "data", "sessions", ".worktree-claims", `${key}.json`);
}
