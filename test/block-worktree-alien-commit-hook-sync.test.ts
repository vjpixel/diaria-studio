/**
 * test/block-worktree-alien-commit-hook-sync.test.ts (#7895, #7903)
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
 *
 * **#7903**: os testes de claim conflitante/divergência de branch abaixo
 * escrevem no arquivo AUTORITATIVO (`data/sessions/.worktree-claims/
 * <hash>.json`, via `claimWorktree` de `session-registry.ts`), não mais no
 * mirror (`data/sessions/*.json`) — a leitura mudou de fonte, os testes
 * precisam refletir o que o hook de fato lê agora.
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
  readWorktreeClaimRecord,
  getHeadBranch,
  isLinkedWorktree,
} from "../.claude/hooks/block-worktree-alien-commit.mjs";
import { claimWorktree } from "../scripts/lib/session-registry.ts";

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

  it("está registrado em .claude/settings.json sob PreToolUse/hooks[matcher=Bash]/args (não só em algum lugar do arquivo)", () => {
    // Self-review (#7899 finding 9): checagem por substring em qualquer
    // lugar do arquivo não pegaria uma futura regressão de posicionamento
    // (ex: hook movido pra PostToolUse, ou pro matcher errado) — navega o
    // JSON estruturado até o array de args da entrada certa.
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));
    const preToolUse = settings?.hooks?.PreToolUse;
    assert.ok(Array.isArray(preToolUse), "settings.json deve ter hooks.PreToolUse como array");
    const bashGroup = preToolUse.find((g: { matcher?: string }) => g.matcher === "Bash");
    assert.ok(bashGroup, "deve existir um grupo PreToolUse com matcher \"Bash\"");
    const entries: Array<{ args?: string[] }> = bashGroup.hooks ?? [];
    const registered = entries.some((h) =>
      (h.args ?? []).some((a) => a.includes("block-worktree-alien-commit.mjs")),
    );
    assert.ok(
      registered,
      "block-worktree-alien-commit.mjs precisa estar em hooks.PreToolUse[matcher=Bash][].args — #7895 (era código morto, entregue no #7810 sem wiring)",
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

  it("readWorktreeClaimRecord/findConflictingClaimSessionId: lêem o arquivo AUTORITATIVO (data/sessions/.worktree-claims/, #7903), não o mirror", async () => {
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "alien-commit-unit-"));
    try {
      const worktreePath = join(tmp, "worktree-a");

      // sem claim nenhuma: sem conflito, sem record
      assert.equal(findConflictingClaimSessionId(tmp, worktreePath, "me"), null);
      assert.equal(readWorktreeClaimRecord(tmp, worktreePath), null);

      // claim de OUTRO path: sem conflito neste path
      claimWorktree(join(tmp, "worktree-b"), "other-session", tmp);
      assert.equal(findConflictingClaimSessionId(tmp, worktreePath, "me"), null);

      // claim do MESMO path, sessão diferente: conflito — via claimWorktree
      // real (#7892: chave é o hash do path, não o sessionId chamador)
      claimWorktree(worktreePath, "alien-session", tmp);
      assert.equal(findConflictingClaimSessionId(tmp, worktreePath, "me"), "alien-session");

      // a PRÓPRIA sessão reivindicando: nunca é conflito consigo mesma
      assert.equal(findConflictingClaimSessionId(tmp, worktreePath, "alien-session"), null);

      // claim expirado: ignorado (corrompe o TTL direto no disco, mesmo
      // padrão de test/continuo-7722-worktree-guard.test.ts)
      const record = readWorktreeClaimRecord(tmp, worktreePath);
      assert.equal(record.sessionId, "alien-session");
      // 2 claims coexistem no diretório (worktree-a e worktree-b) — localiza
      // o arquivo pelo CONTEÚDO (path), não pelo primeiro da listagem.
      const { readdirSync, readFileSync: readFile } = await import("node:fs");
      const claimDir = join(tmp, "data", "sessions", ".worktree-claims");
      const claimFileName = readdirSync(claimDir).find(
        (name) => JSON.parse(readFile(join(claimDir, name), "utf8")).path === worktreePath,
      );
      assert.ok(claimFileName, "esperava achar o arquivo de claim de worktreePath");
      const claimFile = join(claimDir, claimFileName);
      const raw = JSON.parse(readFile(claimFile, "utf8"));
      raw.expires_at = Date.now() - 1000;
      writeFileSync(claimFile, JSON.stringify(raw));
      assert.equal(findConflictingClaimSessionId(tmp, worktreePath, "me"), null);
      assert.equal(readWorktreeClaimRecord(tmp, worktreePath), null);

      // registro malformado: fail-open, não lança
      writeFileSync(claimFile, "{not json");
      assert.doesNotThrow(() => findConflictingClaimSessionId(tmp, worktreePath, "me"));
      assert.doesNotThrow(() => readWorktreeClaimRecord(tmp, worktreePath));

      // diretório .worktree-claims/ inexistente: fail-open (mkdirSync nunca chamado)
      const tmp2 = join(tmp, "sem-claims-nenhuma");
      mkdirSync(tmp2, { recursive: true });
      assert.equal(readWorktreeClaimRecord(tmp2, join(tmp2, "wt")), null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("readWorktreeClaimRecord expõe o campo branch gravado por claimWorktree (#7903)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "alien-commit-branch-"));
    try {
      const worktreePath = join(tmp, "wt");
      claimWorktree(worktreePath, "session-a", tmp, "fix/7903-example");
      const record = readWorktreeClaimRecord(tmp, worktreePath);
      assert.equal(record.branch, "fix/7903-example");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("block-worktree-alien-commit.mjs — integração com um LINKED WORKTREE real (#7899 findings 1 e 2)", () => {
  // Reproduz de verdade o cenário que a review do PR #7899 achou quebrado:
  // (1) `checkoutRoot` derivado de `import.meta.url` (path do ARQUIVO do
  // hook) em vez de `payload.cwd` — sob `isolation: "worktree"` o harness
  // carrega o hook a partir de `${CLAUDE_PROJECT_DIR}`, fixo na raiz
  // original, não no worktree (#7712); (2) `git rev-parse --git-common-dir`
  // devolve path ABSOLUTO e `path.join(checkoutRoot, commonDir, "..")`
  // (bug anterior) não re-raiza nele, produzindo um path inexistente.
  //
  // Este teste cria um repo git de verdade + um worktree VINCULADO de
  // verdade num diretório temporário (nunca toca o checkout real nem
  // `data/sessions/` real) e roda o hook via `execFileSync` passando
  // `payload.cwd` = path do worktree — exatamente a forma que o harness usa
  // — pra confirmar que `checkoutRoot`/`repoRoot` resolvem corretamente daí,
  // não do `import.meta.url` do arquivo (que aponta pro checkout deste
  // teste, não pro worktree temporário).
  it("detecta conflito de claim quando o claim autoritativo aponta pro worktree TEMPORÁRIO (não pro checkout do hook)", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "alien-commit-worktree-"));
    const mainRepo = join(tmp, "main");
    const linkedWorktree = join(tmp, "wt");
    try {
      mkdirSync(mainRepo, { recursive: true });
      const git = (args: string[], cwd: string) =>
        execFileSync("git", args, { cwd, encoding: "utf8" });
      git(["init", "-q"], mainRepo);
      git(["config", "user.email", "test@example.com"], mainRepo);
      git(["config", "user.name", "Test"], mainRepo);
      writeFileSync(join(mainRepo, "README.md"), "x");
      git(["add", "."], mainRepo);
      git(["commit", "-q", "-m", "init"], mainRepo);
      git(["branch", "feature-branch"], mainRepo);
      git(["worktree", "add", "-q", linkedWorktree, "feature-branch"], mainRepo);

      // data/sessions/ vive no checkout PRINCIPAL (mainRepo), não no
      // worktree. #7903: claim gravado via `claimWorktree` real, no arquivo
      // AUTORITATIVO (`.worktree-claims/`), não no mirror antigo.
      claimWorktree(linkedWorktree, "alien-session-id", mainRepo);

      const { stdout } = runHook({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "test"' },
        session_id: "my-session-id", // diferente de alien-session-id
        cwd: linkedWorktree, // simula o payload.cwd que o harness de fato envia
      });

      assert.ok(stdout.length > 0, "esperava bloqueio (stdout com JSON de deny) — se vazio, os bugs #1/#2 voltaram");
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput?.permissionDecision, "deny");
      assert.match(parsed.hookSpecificOutput?.permissionDecisionReason ?? "", /claim ativo/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("NÃO bloqueia quando o claim é da PRÓPRIA sessão (mesmo cenário de worktree real)", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "alien-commit-worktree-own-"));
    const mainRepo = join(tmp, "main");
    const linkedWorktree = join(tmp, "wt");
    try {
      mkdirSync(mainRepo, { recursive: true });
      const git = (args: string[], cwd: string) =>
        execFileSync("git", args, { cwd, encoding: "utf8" });
      git(["init", "-q"], mainRepo);
      git(["config", "user.email", "test@example.com"], mainRepo);
      git(["config", "user.name", "Test"], mainRepo);
      writeFileSync(join(mainRepo, "README.md"), "x");
      git(["add", "."], mainRepo);
      git(["commit", "-q", "-m", "init"], mainRepo);
      git(["branch", "feature-branch"], mainRepo);
      git(["worktree", "add", "-q", linkedWorktree, "feature-branch"], mainRepo);

      claimWorktree(linkedWorktree, "my-session-id", mainRepo, "feature-branch");

      const { stdout } = runHook({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "test"' },
        session_id: "my-session-id", // mesma sessão do claim
        cwd: linkedWorktree,
      });

      assert.equal(stdout, "");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("#7903: bloqueia por BLOCK_REASON_BRANCH_DIVERGE quando a branch foi trocada por baixo depois do claim", async () => {
    // Cenário que a checagem antiga (git worktree list --porcelain vs. git
    // rev-parse HEAD do MESMO worktree) nunca conseguia detectar, por
    // construção — as duas fontes vinham do mesmo HEAD. Agora comparamos
    // contra o `branch` gravado no CLAIM, que reflete o estado no momento
    // em que a sessão reivindicou o worktree, não o estado atual.
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "alien-commit-branch-diverge-"));
    const mainRepo = join(tmp, "main");
    const linkedWorktree = join(tmp, "wt");
    try {
      mkdirSync(mainRepo, { recursive: true });
      const git = (args: string[], cwd: string) =>
        execFileSync("git", args, { cwd, encoding: "utf8" });
      git(["init", "-q"], mainRepo);
      git(["config", "user.email", "test@example.com"], mainRepo);
      git(["config", "user.name", "Test"], mainRepo);
      writeFileSync(join(mainRepo, "README.md"), "x");
      git(["add", "."], mainRepo);
      git(["commit", "-q", "-m", "init"], mainRepo);
      git(["branch", "feature-branch"], mainRepo);
      git(["worktree", "add", "-q", linkedWorktree, "feature-branch"], mainRepo);

      // A mesma sessão reivindica com a branch original...
      claimWorktree(linkedWorktree, "my-session-id", mainRepo, "feature-branch");
      // ...mas outra sessão troca a branch por baixo (mesmo cenário do
      // incidente de origem do #7722 item 4).
      git(["branch", "outra-branch"], mainRepo);
      git(["checkout", "-q", "outra-branch"], linkedWorktree);

      const { stdout } = runHook({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "test"' },
        session_id: "my-session-id", // mesma sessão do claim — só a branch divergiu
        cwd: linkedWorktree,
      });

      assert.ok(stdout.length > 0, "esperava bloqueio por divergência de branch");
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput?.permissionDecision, "deny");
      assert.match(parsed.hookSpecificOutput?.permissionDecisionReason ?? "", /diverge/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("#7903: NÃO bloqueia por branch quando a branch atual bate com a branch do claim", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "alien-commit-branch-ok-"));
    const mainRepo = join(tmp, "main");
    const linkedWorktree = join(tmp, "wt");
    try {
      mkdirSync(mainRepo, { recursive: true });
      const git = (args: string[], cwd: string) =>
        execFileSync("git", args, { cwd, encoding: "utf8" });
      git(["init", "-q"], mainRepo);
      git(["config", "user.email", "test@example.com"], mainRepo);
      git(["config", "user.name", "Test"], mainRepo);
      writeFileSync(join(mainRepo, "README.md"), "x");
      git(["add", "."], mainRepo);
      git(["commit", "-q", "-m", "init"], mainRepo);
      git(["branch", "feature-branch"], mainRepo);
      git(["worktree", "add", "-q", linkedWorktree, "feature-branch"], mainRepo);

      claimWorktree(linkedWorktree, "my-session-id", mainRepo, "feature-branch");

      const { stdout } = runHook({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "test"' },
        session_id: "my-session-id",
        cwd: linkedWorktree,
      });

      assert.equal(stdout, "");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
