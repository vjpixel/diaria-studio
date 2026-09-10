/**
 * test/block-worktree-alien-commit-hook-sync.test.ts (#7895)
 *
 * `test/continuo-7722-worktree-guard.test.ts` só valida conteúdo ESTÁTICO
 * de `.claude/hooks/block-worktree-alien-commit.mjs` (grep de funções/
 * exports) — nunca simulou um payload `PreToolUse` real contra o hook. Foi
 * assim que a entrega do #7810 ficou fora do ar em produção por dois
 * motivos ao mesmo tempo sem nenhum teste pegar: (1) o hook nunca estava
 * registrado em `.claude/settings.json`, e (2) mesmo registrado, a versão
 * anterior não lia `stdin`/`tool_input` — rodava sua lógica em TODA
 * invocação de `Bash`, não só em `git commit`.
 *
 * Este arquivo cobre a metade que o teste estático não cobre: spawna o hook
 * de verdade com um payload `PreToolUse` via stdin (mesmo padrão de
 * `test/session-id-required-subcommands-hook-sync.test.ts`) e confere o
 * comportamento observável — nunca bloqueia comando que não é `git commit`,
 * nunca lança em payload malformado, e bloqueia (emite
 * `hookSpecificOutput.permissionDecision: "deny"`) só quando há de fato um
 * claim conflitante de OUTRA sessão para este mesmo worktree.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandHasGitCommit,
  isGitCommitCommand,
  findConflictingClaimSessionId,
  getWorktreeListedBranch,
  getHeadBranch,
  isLinkedWorktree,
} from "../.claude/hooks/block-worktree-alien-commit.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_PATH = join(ROOT, ".claude", "hooks", "block-worktree-alien-commit.mjs");

function runHook(payload: unknown): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
  }
}

describe(".claude/hooks/block-worktree-alien-commit.mjs existe e é registrado (#7895)", () => {
  it("o arquivo do hook existe neste checkout", () => {
    assert.ok(existsSync(HOOK_PATH), `esperado existir: ${HOOK_PATH}`);
  });

  it("está registrado em .claude/settings.json sob PreToolUse/Bash", () => {
    const settings = readFileSync(join(ROOT, ".claude", "settings.json"), "utf8");
    assert.ok(
      settings.includes("block-worktree-alien-commit.mjs"),
      "block-worktree-alien-commit.mjs precisa aparecer em .claude/settings.json — #7895 (era código morto, entregue no #7810 sem wiring)",
    );
  });
});

describe("block-worktree-alien-commit.mjs — payload PreToolUse real via stdin (#7895)", () => {
  it("comando não-Bash: não bloqueia, sem output", () => {
    const { stdout, exitCode } = runHook({ tool_name: "Edit", tool_input: { file_path: "x" } });
    assert.equal(stdout, "");
    assert.equal(exitCode, 0);
  });

  it("Bash que não é git commit (ex: ls): não bloqueia, sem output", () => {
    const { stdout, exitCode } = runHook({ tool_name: "Bash", tool_input: { command: "ls -la" } });
    assert.equal(stdout, "");
    assert.equal(exitCode, 0);
  });

  it("git status (não é commit): não bloqueia, sem output", () => {
    const { stdout, exitCode } = runHook({ tool_name: "Bash", tool_input: { command: "git status" } });
    assert.equal(stdout, "");
    assert.equal(exitCode, 0);
  });

  it("git commit-graph write (subcomando de nome parecido, não é commit real): não bloqueia", () => {
    const { stdout, exitCode } = runHook({
      tool_name: "Bash",
      tool_input: { command: "git commit-graph write" },
    });
    assert.equal(stdout, "");
    assert.equal(exitCode, 0);
  });

  it("git commit real, sem claim conflitante registrado: não bloqueia (passa)", () => {
    const { stdout, exitCode } = runHook({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "test"' },
      session_id: "test-session-sem-conflito",
    });
    assert.equal(stdout, "");
    assert.equal(exitCode, 0);
  });

  it("payload JSON inválido: fail-open via stdin cru, sem lançar", () => {
    const out = execFileSync(process.execPath, [HOOK_PATH], {
      input: "not json",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.equal(out, "");
  });

  it("payload vazio: fail-open, sem lançar", () => {
    const out = execFileSync(process.execPath, [HOOK_PATH], {
      input: "",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.equal(out, "");
  });
});

describe("block-worktree-alien-commit.mjs — funções puras exportadas (#7895)", () => {
  it("isGitCommitCommand/commandHasGitCommit distinguem git commit real de subcomandos parecidos", () => {
    assert.equal(commandHasGitCommit("git commit -m x"), true);
    assert.equal(commandHasGitCommit("git commit-graph write"), false);
    assert.equal(commandHasGitCommit("git status"), false);
    assert.equal(commandHasGitCommit("npm test && git commit -m done"), true);
    assert.equal(isGitCommitCommand(["git", "commit"]), true);
    assert.equal(isGitCommitCommand(["git", "commit-graph"]), false);
  });

  it("commandHasGitCommit ignora git commit dentro de aspas (não é comando real)", () => {
    assert.equal(commandHasGitCommit('echo "lembrete: rode git commit depois"'), false);
  });

  it("isLinkedWorktree/getHeadBranch não lançam sobre o próprio checkout de teste", () => {
    assert.doesNotThrow(() => isLinkedWorktree(ROOT));
    assert.doesNotThrow(() => getHeadBranch(ROOT));
  });

  it("getWorktreeListedBranch faz parse correto do formato porcelain", () => {
    const porcelain = [
      "worktree /repo/main",
      "HEAD abc123",
      "branch refs/heads/master",
      "",
      "worktree /repo/.claude/worktrees/agent-x",
      "HEAD def456",
      "branch refs/heads/overnight/fix-7895-registrar-hook-worktree-alien-commit",
      "",
    ].join("\n");
    assert.equal(
      getWorktreeListedBranch("/repo/.claude/worktrees/agent-x", porcelain),
      "overnight/fix-7895-registrar-hook-worktree-alien-commit",
    );
    assert.equal(getWorktreeListedBranch("/repo/nao-existe", porcelain), null);
  });

  it("findConflictingClaimSessionId: só sinaliza quando OUTRA sessão reivindica o MESMO path, com claim não-expirado", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "alien-commit-unit-"));
    try {
      const sessionsDir = join(tmp, "data", "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const worktreePath = join(tmp, "worktree-a");

      // sem registros: sem conflito
      assert.equal(findConflictingClaimSessionId(tmp, worktreePath, "me"), null);

      // claim de OUTRO path: sem conflito
      writeFileSync(
        join(sessionsDir, "other.json"),
        JSON.stringify({
          session_id: "other-session",
          worktree_claim: { path: join(tmp, "worktree-b"), expires_at: Date.now() + 100000 },
        }),
      );
      assert.equal(findConflictingClaimSessionId(tmp, worktreePath, "me"), null);

      // claim do MESMO path, sessão diferente: conflito
      writeFileSync(
        join(sessionsDir, "conflict.json"),
        JSON.stringify({
          session_id: "alien-session",
          worktree_claim: { path: worktreePath, expires_at: Date.now() + 100000 },
        }),
      );
      assert.equal(findConflictingClaimSessionId(tmp, worktreePath, "me"), "alien-session");

      // a PRÓPRIA sessão reivindicando: nunca é conflito consigo mesma
      assert.equal(findConflictingClaimSessionId(tmp, worktreePath, "alien-session"), null);

      // claim expirado: ignorado
      writeFileSync(
        join(sessionsDir, "conflict.json"),
        JSON.stringify({
          session_id: "alien-session",
          worktree_claim: { path: worktreePath, expires_at: Date.now() - 1000 },
        }),
      );
      assert.equal(findConflictingClaimSessionId(tmp, worktreePath, "me"), null);

      // registro malformado: fail-open, não lança
      writeFileSync(join(sessionsDir, "bad.json"), "{not json");
      assert.doesNotThrow(() => findConflictingClaimSessionId(tmp, worktreePath, "me"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
