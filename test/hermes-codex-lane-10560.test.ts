/**
 * test/hermes-codex-lane-10560.test.ts (#10560)
 *
 * Elo `codex exec` (Sol 6.1, esforço low, plano OpenAI) na cadeia de
 * implementação do contínuo, DEPOIS dos `:free` e ANTES do elo de assinatura
 * (decisão do editor, 20/10/2026), só com `CLAUDE_DELEGATE_CODEX_LANE=1`.
 * Nunca roda `codex` real (cota compartilhada com o orquestrador): `codex`,
 * `claude` e `gh` são stubs no PATH. O auth.json do Hermes é apontado por
 * `CLAUDE_DELEGATE_HERMES_AUTH_JSON` — ausente por padrão (cadeia sem os
 * `:free`, como no CI), ou um arquivo falso com `sk-or-*` nos testes da ordem
 * completa, pra o resultado não depender da máquina.
 *
 * Trava:
 *   1. Ordem da cadeia — desligado: nada de codex; ligado: `:free` → codex →
 *      assinatura, com fallback no `sonnet` quando o codex falha ou está com a
 *      cota marcada como esgotada.
 *   2. Invocação pinada (`exec -m gpt-6.1-sol -c model_reasoning_effort="low"`).
 *   3. Ambiente do processo codex: sem OPENAI_API_KEY/ANTHROPIC_*, com
 *      core.hooksPath por env, gh shim na frente do PATH e o session-id do tick.
 *   4. Preflight fail-closed — sem session-id, com GIT_CONFIG_COUNT herdado ou
 *      com cota marcada como esgotada, o elo é pulado (e `--model codex:...`
 *      explícito é recusado).
 *   5. Os guards em si: reference-transaction recusa master/main (inclusive com
 *      --no-verify) e encadeia pros hooks originais; gh shim recusa merge e
 *      `pr create` fora de `continuo/*`, e roda o guard de PII.
 *   6. Injeção de --session-id por env em session-registry.ts (só claim/lease).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENV_INJECTABLE_SUBCOMMANDS,
  ENV_INJECTED_SESSION_ID_VAR,
  SESSION_ID_REQUIRED_SUBCOMMANDS,
  resolveEnvInjectedSessionId,
} from "../scripts/lib/session-id-required-subcommands.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER = join(ROOT, "hermes/scripts/claude-delegate.sh");
const LANE_DIR = join(ROOT, "hermes/scripts/codex-lane");
const HOOKS_DIR = join(LANE_DIR, "hooks");
const GH_SHIM_DIR = join(LANE_DIR, "bin");

let tmp = "";
let fakeBin = "";
let repo = "";
let runTmp = "";

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
}

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmp };
  for (const args of [
    ["init", "-q", "-b", "master"],
    ["config", "user.email", "t@example.com"],
    ["config", "user.name", "t"],
    ["config", "commit.gpgsign", "false"],
  ]) {
    const r = sh("git", args, dir, env);
    assert.equal(r.status, 0, r.stderr);
  }
  writeFileSync(join(dir, "README.md"), "x\n");
  assert.equal(sh("git", ["add", "."], dir, env).status, 0);
  const c = sh("git", ["commit", "-q", "-m", "init"], dir, env);
  assert.equal(c.status, 0, c.stderr);
}

function hookEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: tmp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: HOOKS_DIR,
  };
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "codex-lane-10560-"));
  fakeBin = join(tmp, "bin");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "claude"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "--version" ]; then echo "1.0.0 (fake)"; exit 0; fi',
      'echo "$*" >> "$TMPDIR/claude-calls.log"',
      // #10560 (ordem de 20/10): os `:free` falham sob demanda, pra cadeia
      // chegar ao codex.
      'case "$*" in *:free*) if [ "${FAKE_CLAUDE_FREE_FAIL:-0}" = 1 ]; then echo "erro qualquer do free" >&2; exit 1; fi ;; esac',
      'echo "resposta fake claude"',
      "exit 0",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fakeBin, "codex"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$@" > "$TMPDIR/codex-argv.log"',
      "cat > \"$TMPDIR/codex-stdin.log\"",
      "{",
      '  echo "OPENAI_API_KEY=${OPENAI_API_KEY:-}"',
      '  echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}"',
      '  echo "GIT_CONFIG_KEY_0=${GIT_CONFIG_KEY_0:-}"',
      '  echo "GIT_CONFIG_VALUE_0=${GIT_CONFIG_VALUE_0:-}"',
      '  echo "DIARIA_INJECTED_SESSION_ID=${DIARIA_INJECTED_SESSION_ID:-}"',
      '  echo "DIARIA_SESSION_KIND=${DIARIA_SESSION_KIND:-}"',
      '  echo "PATH_HEAD=${PATH%%:*}"',
      '} > "$TMPDIR/codex-env.log"',
      'case "${CODEX_STUB_MODE:-ok}" in',
      '  ok) echo "resposta codex"; exit 0 ;;',
      '  fail) echo "erro qualquer" >&2; exit 1 ;;',
      // Erro da própria Codex CLI: linha `ERROR: ...` (evento de erro do
      // `codex exec`), com ou sem `[timestamp] ` na frente (#10586).
      "  quota) echo \"[2026-10-19T00:00:00] ERROR: You've hit your usage limit. Try again later.\" >&2; exit 1 ;;",
      // #10586 item 1: a TRANSCRIÇÃO de progresso também vai pro stderr e,
      // neste repo, fala de \"rate limit\"/\"model not found\" o tempo todo.
      '  transcript-noise) { echo "thinking"; echo "Vou tratar o rate limit do Brevo (usage limit 100/h) e o erro model not found do #6617."; echo "exec bash -lc \\"npm test\\""; echo "Error: rate limit exceeded (saída de um teste no meio da transcrição)"; echo "ERROR: stream disconnected before completion"; } >&2; exit 1 ;;',
      // Review da PR #10583 (P2): trabalho parcial antes de falhar.
      '  partial-branch) git -C "$CODEX_STUB_REPO" branch "continuo/fix-10560-parcial-$$" >/dev/null 2>&1; echo "timeout no meio" >&2; exit 1 ;;',
      '  partial-pr) echo "2026-10-19T00:00:00+00:00 https://github.com/o/r/pull/77 continuo/fix-10560-y" >> "$TMPDIR/codex-lane-pr-created.log"; exit 1 ;;',
      "  partial-quota) git -C \"$CODEX_STUB_REPO\" branch \"continuo/fix-10560-quota-$$\" >/dev/null 2>&1; echo \"ERROR: You've hit your usage limit.\" >&2; exit 1 ;;",
      '  partial-transcript-quota) git -C "$CODEX_STUB_REPO" branch "continuo/fix-10560-tq-$$" >/dev/null 2>&1; echo "o teste cobre o caso de rate limit / usage limit" >&2; exit 1 ;;',
      // #10586 item 2: branch FORA de continuo/* + commit no checkout.
      '  partial-plain-branch) git -C "$CODEX_STUB_REPO" checkout -q -b "fix-123-$$" && echo z > "$CODEX_STUB_REPO/z-$$.txt" && git -C "$CODEX_STUB_REPO" add . && git -C "$CODEX_STUB_REPO" -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q -m parcial; echo "timeout no meio" >&2; exit 1 ;;',
      '  partial-commit-current) echo w > "$CODEX_STUB_REPO/w-$$.txt" && git -C "$CODEX_STUB_REPO" add . && git -C "$CODEX_STUB_REPO" -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q -m parcial; echo "timeout no meio" >&2; exit 1 ;;',
      // #10588 (P2): atividade de OUTRA sessão durante a tentativa — commit
      // num worktree pré-existente e remoção de branch — não é trabalho do
      // codex; a cadeia segue.
      '  foreign-activity) G="git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false"; echo f > "$CODEX_STUB_WT/f-$$.txt" && $G -C "$CODEX_STUB_WT" add . && $G -C "$CODEX_STUB_WT" commit -q -m alheio; git -C "$CODEX_STUB_REPO" branch -D "$CODEX_STUB_DEL" >/dev/null 2>&1; echo "erro qualquer" >&2; exit 1 ;;',
      // #10591: simula pull de outra sessão, sem o hook do subprocesso codex.
      '  foreign-head-advance) next=$(printf "alheio\\n" | git -C "$CODEX_STUB_REPO" -c user.name=t -c user.email=t@example.com commit-tree "HEAD^{tree}" -p HEAD); git -C "$CODEX_STUB_REPO" -c core.hooksPath=/dev/null update-ref HEAD "$next"; echo "erro qualquer" >&2; exit 1 ;;',
      '  transcript-error-adjacent) { echo "ERROR: Brevo rate limit exceeded"; echo "Error: stream disconnected"; } >&2; exit 1 ;;',
      // #10560: stderr verbatim do codex-rs (tag rust-v0.159.1), escrito pelo teste.
      '  stderr-file) cat "$CODEX_STUB_STDERR_FILE" >&2; exit 1 ;;',
      '  partial-stderr-file) git -C "$CODEX_STUB_REPO" branch "continuo/fix-10560-sf-$$" >/dev/null 2>&1; cat "$CODEX_STUB_STDERR_FILE" >&2; exit 1 ;;',
      '  partial-new-worktree) git -C "$CODEX_STUB_REPO" worktree add -q --detach "$TMPDIR/wt-novo-$$" >/dev/null 2>&1; echo "timeout no meio" >&2; exit 1 ;;',
      // #10588 item a: `ERROR:` de script no MEIO da transcrição não é erro da CLI.
      '  transcript-error-mid) { echo "exec bash -lc npx-tsx-scripts-x"; echo "ERROR: Brevo rate limit exceeded (429) — usage limit"; echo "vou tentar de novo mais tarde"; echo "timeout no meio"; } >&2; exit 1 ;;',
      // #10584: commit em master num repo descartável (como os testes que
      // fazem `git init` em tmp) passa; no checkout-alvo continua recusado.
      "  master-scope)",
      '    u="$TMPDIR/unrelated-$$"; mkdir -p "$u"',
      '    G="git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false"',
      '    $G -C "$u" init -q -b master && echo a > "$u/a" && $G -C "$u" add a && $G -C "$u" commit -q -m init 2> "$TMPDIR/unrelated-commit.err"; echo $? > "$TMPDIR/unrelated-commit.rc"',
      '    $G -C "$CODEX_STUB_REPO" checkout -q master; echo b > "$CODEX_STUB_REPO/b-$$" && $G -C "$CODEX_STUB_REPO" add . && $G -C "$CODEX_STUB_REPO" commit -q -m x 2> "$TMPDIR/target-commit.err"; echo $? > "$TMPDIR/target-commit.rc"',
      '    echo "resposta codex"; exit 0 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBin, "claude"), 0o755);
  chmodSync(join(fakeBin, "codex"), 0o755);
  repo = join(tmp, "repo");
  initRepo(repo);
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  runTmp = mkdtempSync(join(tmp, "run-"));
});

function wrapperEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    CLAUDE_BINARY_PREFLIGHT_CMD: "claude",
    TMPDIR: runTmp,
    CODEX_BIN: join(fakeBin, "codex"),
    // Sem chave OpenRouter por padrão (arquivo inexistente): a cadeia é só o
    // elo de assinatura, com o codex na frente dele quando ligado.
    CLAUDE_DELEGATE_HERMES_AUTH_JSON: join(tmp, "auth-ausente.json"),
    ...extra,
  };
  delete env.GIT_CONFIG_COUNT;
  delete env.CLAUDE_DELEGATE_CODEX_LANE;
  delete env.DIARIA_CONTINUO_SESSION_ID;
  Object.assign(env, extra);
  return env;
}

function writeSessionFile(id = "hermes-cron-test-20261019T000000Z") {
  writeFileSync(join(runTmp, "hermes-continuo-current-session-id"), `${id}\n`);
  return id;
}

function runWrapper(env: NodeJS.ProcessEnv, args: string[] = [], cwd = repo) {
  return spawnSync("bash", [WRAPPER, "--cwd", cwd, "--timeout", "20", ...args], {
    input: "implemente a issue de teste",
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

function attemptOrder(stderr: string): string[] {
  return [...stderr.matchAll(/\[claude-openrouter\] tentando model=(\S+)/g)].map((m) => m[1]);
}

// Sem chave OpenRouter (default de wrapperEnv) o elo seguinte ao codex é
// sempre o de assinatura.
const FIRST_NON_CODEX = new Set(["sonnet"]);

describe("#10560 — ordem da cadeia", () => {
  it("desligado por padrão: codex nunca é chamado", () => {
    writeSessionFile();
    const r = runWrapper(wrapperEnv());
    assert.equal(r.status, 0, r.stderr);
    const order = attemptOrder(r.stderr);
    assert.ok(order.length > 0, r.stderr);
    assert.ok(!order.includes("codex:gpt-6.1-sol"), `codex apareceu na cadeia desligada: ${order}`);
    assert.equal(existsSync(join(runTmp, "codex-argv.log")), false);
  });

  it("ligado, sem chave OpenRouter: codex é o 1º elo e, com sucesso, nenhum claude roda", () => {
    writeSessionFile();
    const r = runWrapper(wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1" }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /resposta codex/);
    assert.deepEqual(attemptOrder(r.stderr), ["codex:gpt-6.1-sol"]);
    assert.equal(existsSync(join(runTmp, "claude-calls.log")), false, "claude rodou depois de codex OK");
  });

  it("ligado: falha do codex cai no elo seguinte da cadeia atual", () => {
    writeSessionFile();
    const r = runWrapper(wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "fail" }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /resposta fake claude/);
    const order = attemptOrder(r.stderr);
    assert.equal(order[0], "codex:gpt-6.1-sol");
    assert.ok(FIRST_NON_CODEX.has(order[1]), `2º elo inesperado: ${order}`);
  });

  // Review da PR #10583 (P2): o MESMO prompt no elo seguinte reimplementaria
  // e podia abrir uma 2ª PR.
  it("falha do codex DEPOIS de criar branch continuo/*: aborta com exit 95, sem próximo elo", () => {
    writeSessionFile();
    const r = runWrapper(
      wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "partial-branch", CODEX_STUB_REPO: repo }),
    );
    assert.equal(r.status, 95, r.stderr);
    assert.match(r.stderr, /trabalho parcial — .*branch continuo\/fix-10560-parcial-/);
    assert.deepEqual(attemptOrder(r.stderr), ["codex:gpt-6.1-sol"]);
    assert.equal(existsSync(join(runTmp, "claude-calls.log")), false, "claude rodou depois de trabalho parcial do codex");
  });

  it("falha do codex DEPOIS de abrir PR (log do gh shim): aborta com exit 95", () => {
    writeSessionFile();
    const r = runWrapper(wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "partial-pr" }));
    assert.equal(r.status, 95, r.stderr);
    assert.match(r.stderr, /prlog-lines 1/);
    assert.equal(existsSync(join(runTmp, "claude-calls.log")), false);
  });

  it("trabalho parcial + usage limit: aborta E grava o marcador de cota", () => {
    writeSessionFile();
    const r = runWrapper(
      wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "partial-quota", CODEX_STUB_REPO: repo }),
    );
    assert.equal(r.status, 95, r.stderr);
    assert.ok(existsSync(join(runTmp, "codex-lane-quota-exhausted-until")));
  });

  // #10586 item 1: "rate limit" só na transcrição não é sinal de cota.
  it("trabalho parcial + 'rate limit' só na transcrição: aborta SEM gravar o marcador de cota", () => {
    writeSessionFile();
    const r = runWrapper(
      wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "partial-transcript-quota", CODEX_STUB_REPO: repo }),
    );
    assert.equal(r.status, 95, r.stderr);
    assert.equal(existsSync(join(runTmp, "codex-lane-quota-exhausted-until")), false);
  });

  // #10586 item 2: a foto olhava só refs/heads/continuo/*.
  it("falha do codex DEPOIS de `checkout -b fix-123` + commit (fora de continuo/*): aborta com exit 95", () => {
    const r2 = join(tmp, `repo-plain-${Date.now()}`);
    initRepo(r2);
    writeSessionFile();
    const r = runWrapper(
      wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "partial-plain-branch", CODEX_STUB_REPO: r2 }),
      [],
      r2,
    );
    assert.equal(r.status, 95, r.stderr);
    assert.match(r.stderr, /trabalho parcial — .*head-ref refs\/heads\/fix-123-/);
    assert.match(r.stderr, /branch fix-123-\d+ [0-9a-f]{40}/);
    assert.equal(existsSync(join(runTmp, "claude-calls.log")), false);
  });

  // #10588 (P2): o $CWD default é o checkout compartilhado do `300`, onde
  // overnight/develop commitam nos próprios worktrees o tempo todo.
  it("commit de outra sessão num worktree pré-existente + branch removida: NÃO é trabalho parcial, cadeia segue", () => {
    const r2 = join(tmp, `repo-foreign-${Date.now()}`);
    initRepo(r2);
    const wt = join(tmp, `wt-foreign-${Date.now()}`);
    assert.equal(sh("git", ["worktree", "add", "-q", "-b", "dev-outra-sessao", wt], r2).status, 0);
    assert.equal(sh("git", ["branch", "branch-que-some"], r2).status, 0);
    writeSessionFile();
    const r = runWrapper(
      wrapperEnv({
        CLAUDE_DELEGATE_CODEX_LANE: "1",
        CODEX_STUB_MODE: "foreign-activity",
        CODEX_STUB_REPO: r2,
        CODEX_STUB_WT: wt,
        CODEX_STUB_DEL: "branch-que-some",
      }),
      [],
      r2,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /trabalho parcial/);
    assert.match(r.stdout, /resposta fake claude/);
    // A atividade alheia aconteceu de fato (senão o teste não discrimina).
    assert.match(sh("git", ["log", "-1", "--format=%s", "dev-outra-sessao"], r2).stdout, /alheio/);
    assert.notEqual(sh("git", ["rev-parse", "-q", "--verify", "refs/heads/branch-que-some"], r2).status, 0);
    const order = attemptOrder(r.stderr);
    assert.equal(order[0], "codex:gpt-6.1-sol");
    assert.ok(FIRST_NON_CODEX.has(order[1]), `2º elo inesperado: ${order}`);
  });

  for (const branch of ["master", "main"]) {
    it(`#10591: avanço alheio de ${branch} no CWD permite fallback`, () => {
      const target = join(tmp, `repo-head-${branch}-${Date.now()}`);
      initRepo(target);
      if (branch === "main") assert.equal(sh("git", ["branch", "-m", "main"], target).status, 0);
      const before = sh("git", ["rev-parse", "HEAD"], target).stdout.trim();
      writeSessionFile();
      const r = runWrapper(wrapperEnv({
        CLAUDE_DELEGATE_CODEX_LANE: "1",
        CODEX_STUB_MODE: "foreign-head-advance",
        CODEX_STUB_REPO: target,
      }), [], target);
      assert.notEqual(sh("git", ["rev-parse", "HEAD"], target).stdout.trim(), before);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /trabalho parcial/);
      assert.match(r.stdout, /resposta fake claude/);
    });
  }

  it("falha do codex DEPOIS de abrir worktree NOVO: aborta com exit 95", () => {
    const r2 = join(tmp, `repo-newwt-${Date.now()}`);
    initRepo(r2);
    writeSessionFile();
    const r = runWrapper(
      wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "partial-new-worktree", CODEX_STUB_REPO: r2 }),
      [],
      r2,
    );
    assert.equal(r.status, 95, r.stderr);
    assert.match(r.stderr, /trabalho parcial — .*wt \S*wt-novo-/);
  });

  it("falha do codex DEPOIS de commitar na branch atual (sem branch nova): aborta com exit 95", () => {
    const r2 = join(tmp, `repo-cur-${Date.now()}`);
    initRepo(r2);
    assert.equal(sh("git", ["checkout", "-q", "-b", "feature-x"], r2).status, 0);
    writeSessionFile();
    const r = runWrapper(
      wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "partial-commit-current", CODEX_STUB_REPO: r2 }),
      [],
      r2,
    );
    assert.equal(r.status, 95, r.stderr);
    assert.match(r.stderr, /trabalho parcial — .*head-sha [0-9a-f]{40}/);
  });
});

// Decisão do editor de 20/10/2026 (/diaria-desbloqueia): `:free` → codex →
// assinatura. A 1ª versão (PR #10583) punha o codex na frente dos `:free`.
describe("#10560 — ordem :free → codex → sonnet (decisão de 20/10)", () => {
  const FREE = [
    "dots-studio/dots-3-note-preview:free",
    "thinkingmachines/inkling-small:free",
    "poolside/laguna-s-2.1:free",
  ];

  function keyEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const auth = join(runTmp, "auth-fake.json");
    writeFileSync(
      auth,
      JSON.stringify({ credential_pool: { openrouter: [{ access_token: "sk-or-fake-10560" }] } }),
    );
    return wrapperEnv({ CLAUDE_DELEGATE_HERMES_AUTH_JSON: auth, ...extra });
  }

  it("ligado, :free falham: tenta os 3 :free, depois o codex, que responde", () => {
    writeSessionFile();
    const r = runWrapper(keyEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", FAKE_CLAUDE_FREE_FAIL: "1" }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /resposta codex/);
    assert.deepEqual(attemptOrder(r.stderr), [...FREE, "codex:gpt-6.1-sol"]);
    const calls = readFileSync(join(runTmp, "claude-calls.log"), "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, 3, calls.join("\n"));
    assert.ok(calls.every((c) => c.includes(":free")), `claude rodou fora dos :free: ${calls.join("\n")}`);
  });

  it("ligado, 1º :free responde: codex nunca é chamado (a cota do plano fica pro orquestrador)", () => {
    writeSessionFile();
    const r = runWrapper(keyEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1" }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /resposta fake claude/);
    assert.deepEqual(attemptOrder(r.stderr), [FREE[0]]);
    assert.equal(existsSync(join(runTmp, "codex-argv.log")), false, "codex rodou antes de os :free falharem");
  });

  it("ligado, :free e codex falham: cai no elo de assinatura por último", () => {
    writeSessionFile();
    const r = runWrapper(
      keyEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", FAKE_CLAUDE_FREE_FAIL: "1", CODEX_STUB_MODE: "fail" }),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /resposta fake claude/);
    assert.deepEqual(attemptOrder(r.stderr), [...FREE, "codex:gpt-6.1-sol", "sonnet"]);
  });

  it("ligado, codex com cota esgotada: grava o marcador, cai no sonnet e a invocação seguinte pula o codex", () => {
    writeSessionFile();
    const env = keyEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", FAKE_CLAUDE_FREE_FAIL: "1", CODEX_STUB_MODE: "quota" });
    const r1 = runWrapper(env);
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual(attemptOrder(r1.stderr), [...FREE, "codex:gpt-6.1-sol", "sonnet"]);
    assert.match(r1.stderr, /falhou model=codex:gpt-6\.1-sol rc=1: RATE-LIMIT\/QUOTA/);
    assert.ok(existsSync(join(runTmp, "codex-lane-quota-exhausted-until")));

    rmSync(join(runTmp, "codex-argv.log"), { force: true });
    const r2 = runWrapper(env);
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(attemptOrder(r2.stderr), [...FREE, "sonnet"]);
    assert.match(r2.stderr, /elo codex ligado mas NÃO armado .*cota do plano marcada como esgotada/);
    assert.equal(existsSync(join(runTmp, "codex-argv.log")), false, "codex rodou com a cota marcada como esgotada");
  });

  it("cota free marcada como exaurida: cadeia vira codex → sonnet (o codex não depende da cota free)", () => {
    writeSessionFile();
    writeFileSync(
      join(runTmp, "claude-openrouter-free-quota-exhausted-until"),
      `${Math.floor(Date.now() / 1000) + 3600}\n`,
    );
    const r = runWrapper(keyEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "fail" }));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(attemptOrder(r.stderr), ["codex:gpt-6.1-sol", "sonnet"]);
  });

  it("desligado, com chave: cadeia de sempre, sem codex", () => {
    writeSessionFile();
    const r = runWrapper(keyEnv({ FAKE_CLAUDE_FREE_FAIL: "1" }));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(attemptOrder(r.stderr), [...FREE, "sonnet"]);
    assert.equal(existsSync(join(runTmp, "codex-argv.log")), false);
  });

  it("codex_lane_insert_before_subscription: posição pura do sentinela", () => {
    const lib = join(ROOT, "hermes/scripts/lib/codex-lane.sh");
    const run = (models: string[]) => {
      const r = spawnSync(
        "bash",
        [
          "-c",
          'is_subscription_lane_model() { [ "$1" = sonnet ]; }; source "$0"; codex_lane_insert_before_subscription "$@"',
          lib,
          "codex:gpt-6.1-sol",
          ...models,
        ],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.split("\n").filter(Boolean);
    };
    assert.deepEqual(run(["a:free", "b:free", "sonnet"]), ["a:free", "b:free", "codex:gpt-6.1-sol", "sonnet"]);
    assert.deepEqual(run(["sonnet"]), ["codex:gpt-6.1-sol", "sonnet"]);
    assert.deepEqual(run(["a:free"]), ["a:free", "codex:gpt-6.1-sol"]);
    assert.deepEqual(run(["a:free", "codex:gpt-6.1-sol", "sonnet"]), ["a:free", "codex:gpt-6.1-sol", "sonnet"]);
  });

  it("call site do contínuo (SKILL.md §2) liga o elo na linha da chamada", () => {
    const skill = readFileSync(join(ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md"), "utf8");
    assert.match(skill, /\|\s*\\?\n\s*CLAUDE_DELEGATE_CODEX_LANE=1 ~\/\.hermes\/scripts\/claude-delegate\.sh \\/);
  });
});

describe("#10586 — classificação só sobre linhas de erro da Codex CLI", () => {
  it("'rate limit'/'model not found' na transcrição do stderr: nem marcador de cota, nem config inválida", () => {
    writeSessionFile();
    const r = runWrapper(wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "transcript-noise" }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /resposta fake claude/);
    assert.equal(existsSync(join(runTmp, "codex-lane-quota-exhausted-until")), false, "transcrição marcou a cota como esgotada");
    assert.doesNotMatch(r.stderr, /falhou model=codex:gpt-6\.1-sol rc=1: (RATE-LIMIT|Codex CLI recusou)/);
    assert.match(r.stderr, /falhou model=codex:gpt-6\.1-sol rc=1 — sem sinal claro/);
  });

  it("linha `ERROR:` da CLI com usage limit continua classificada como cota", () => {
    writeSessionFile();
    const r = runWrapper(wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "quota" }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /falhou model=codex:gpt-6\.1-sol rc=1: RATE-LIMIT\/QUOTA/);
    assert.ok(existsSync(join(runTmp, "codex-lane-quota-exhausted-until")));
  });

  // #10588 item a: scripts do repo imprimem `ERROR: ...` em coluna 0.
  it("'ERROR: ... rate limit' de script no MEIO da transcrição: sem marcador de cota", () => {
    writeSessionFile();
    const r = runWrapper(wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "transcript-error-mid" }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(runTmp, "codex-lane-quota-exhausted-until")), false, "ERROR: do meio marcou a cota");
    assert.doesNotMatch(r.stderr, /falhou model=codex:gpt-6\.1-sol rc=1: RATE-LIMIT/);
  });

  it("#10591: ERROR de script colado ao Error final não marca cota", () => {
    writeSessionFile();
    const r = runWrapper(wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "transcript-error-adjacent" }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /resposta fake claude/);
    assert.equal(existsSync(join(runTmp, "codex-lane-quota-exhausted-until")), false);
    assert.doesNotMatch(r.stderr, /falhou model=codex:gpt-6\.1-sol rc=1: RATE-LIMIT/);
  });

  it("codex_lane_cli_error_lines: só o bloco final de `ERROR:` em coluna 0", () => {
    const f = join(runTmp, "stderr-mid.txt");
    const run = (lines: string[]) => {
      writeFileSync(f, lines.join("\n"));
      const res = spawnSync(
        "bash",
        ["-c", `source '${join(ROOT, "hermes/scripts/lib/codex-lane.sh")}'; codex_lane_cli_error_lines '${f}'`],
        { encoding: "utf8" },
      );
      assert.equal(res.status, 0, res.stderr);
      return res.stdout.trimEnd();
    };
    assert.equal(
      run(["thinking", "ERROR: Brevo rate limit exceeded", "seguindo", "ERROR: stream disconnected", ""]),
      "ERROR: stream disconnected",
    );
    assert.equal(run(["thinking", "ERROR: Brevo rate limit exceeded", "seguindo com outra coisa"]), "");
    assert.equal(run(["thinking", "  ERROR: indentado (saída de comando)"]), "");
    assert.equal(run([]), "");
  });

  it("codex_lane_cli_error_lines: `Error:` final é a única linha considerada", () => {
    const f = join(runTmp, "stderr.txt");
    writeFileSync(
      f,
      [
        "thinking",
        "rate limit da Brevo",
        "Error: no meio (saída de comando)",
        "[2026-10-19T01:02:03] ERROR: unexpected status 429 Too Many Requests",
        "ERROR: model not found",
        "",
        "Error: falha de topo da CLI",
        "",
      ].join("\n"),
    );
    const res = spawnSync(
      "bash",
      ["-c", `source '${join(ROOT, "hermes/scripts/lib/codex-lane.sh")}'; codex_lane_cli_error_lines '${f}'`],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(res.stdout.trimEnd().split("\n"), [
      "Error: falha de topo da CLI",
    ]);
  });
});

// #10560 (resíduo): formato REAL do stderr de cota esgotada. Strings verbatim
// do codex-rs na tag rust-v0.159.1 (a versão instalada no `300`):
//   - mensagem: protocol/src/error.rs, `impl Display for UsageLimitReachedError`
//     (ramo `KnownPlan::Free | KnownPlan::Go`, o plano das contas do pool) e o
//     teste upstream `usage_limit_reached_error_formats_go_plan`
//     (protocol/src/error_tests.rs). Apóstrofo U+2019, não ASCII.
//   - formato da linha: exec/src/event_processor_with_human_output.rs —
//     `ERROR: <msg>` sem timestamp, impresso 2x (ServerNotification::Error e
//     TurnStatus::Failed), e depois `print_final_output` imprime `tokens used`
//     + total (separador do locale) se o turno consumiu token antes de falhar.
const UPSTREAM_GO_QUOTA =
  "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 16th, 2026 9:36 PM.";
const UPSTREAM_GO_QUOTA_NO_RESET =
  "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again later.";
const UPSTREAM_OTHER_LIMIT =
  "You’ve hit your usage limit for codex_other. Switch to another model now, or try again at Nov 16th, 2026 9:36 PM.";
const UPSTREAM_WORKSPACE_CREDITS = "Your workspace is out of credits. Add credits to continue.";
const UPSTREAM_SPEND_CAP = "You hit your spend cap set in your workspace. Increase your spend cap to continue.";

function upstreamStderr(msg: string, opts: { tokens?: string; transcript?: boolean; ansi?: boolean } = {}): string {
  const err = opts.ansi ? `\u001b[1m\u001b[31mERROR:\u001b[0m\u001b[0m ${msg}` : `ERROR: ${msg}`;
  const lines = [
    ...(opts.transcript
      ? ["thinking", "Vou tratar o rate limit do Brevo (usage limit 100/h).", "exec bash -lc 'npx tsx --test test/x.test.ts'", "succeeded in 3.2s:"]
      : []),
    err,
    err,
    ...(opts.tokens ? [opts.ansi ? "\u001b[2mtokens used\u001b[0m" : "tokens used", opts.tokens] : []),
  ];
  return `${lines.join("\n")}\n`;
}

describe("#10560 — stderr real de cota esgotada (codex-rs rust-v0.159.1)", () => {
  const cliLines = (content: string): string => {
    const f = join(runTmp, "stderr-upstream.txt");
    writeFileSync(f, content, "utf8");
    const res = spawnSync(
      "bash",
      ["-c", `source '${join(ROOT, "hermes/scripts/lib/codex-lane.sh")}'; codex_lane_cli_error_lines '${f}'`],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trimEnd();
  };

  it("codex_lane_cli_error_lines: rodapé `tokens used` depois do ERROR não esvazia o bloco", () => {
    for (const tokens of ["2,004", "2.004", "12 345", "987"]) {
      assert.equal(
        cliLines(upstreamStderr(UPSTREAM_GO_QUOTA, { tokens, transcript: true })),
        [`ERROR: ${UPSTREAM_GO_QUOTA}`, `ERROR: ${UPSTREAM_GO_QUOTA}`].join("\n"),
        `tokens=${tokens}`,
      );
    }
  });

  it("codex_lane_cli_error_lines: ANSI forçado (FORCE_COLOR) não esconde o ERROR", () => {
    assert.equal(
      cliLines(upstreamStderr(UPSTREAM_GO_QUOTA, { tokens: "2,004", ansi: true })),
      [`ERROR: ${UPSTREAM_GO_QUOTA}`, `ERROR: ${UPSTREAM_GO_QUOTA}`].join("\n"),
    );
  });

  it("rodapé sem ERROR antes (sucesso que saiu rc≠0 por outro motivo) não vira cota", () => {
    assert.equal(cliLines(["thinking", "rate limit da Brevo", "tokens used", "2,004", ""].join("\n")), "");
  });

  for (const [nome, msg, tokens] of [
    ["plano go, com data de retorno, cota no 1º request", UPSTREAM_GO_QUOTA, undefined],
    ["plano go, cota esgotada NO MEIO da tarefa (rodapé tokens used)", UPSTREAM_GO_QUOTA, "2.004"],
    ["plano go, sem data de retorno", UPSTREAM_GO_QUOTA_NO_RESET, "2,004"],
    ["limite de outro modelo", UPSTREAM_OTHER_LIMIT, undefined],
    ["workspace sem crédito (sem 'usage limit' no texto)", UPSTREAM_WORKSPACE_CREDITS, "2,004"],
    ["spend cap do workspace", UPSTREAM_SPEND_CAP, undefined],
  ] as const) {
    it(`e2e: ${nome} → RATE-LIMIT/QUOTA, marcador gravado, cai no próximo elo`, () => {
      writeSessionFile();
      const f = join(runTmp, "codex-stderr.txt");
      writeFileSync(f, upstreamStderr(msg, { tokens, transcript: true }), "utf8");
      const r = runWrapper(
        wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "stderr-file", CODEX_STUB_STDERR_FILE: f }),
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /resposta fake claude/);
      assert.match(r.stderr, /falhou model=codex:gpt-6\.1-sol rc=1: RATE-LIMIT\/QUOTA/);
      assert.ok(existsSync(join(runTmp, "codex-lane-quota-exhausted-until")), "marcador de cota não gravado");
    });
  }

  it("e2e: trabalho parcial + cota esgotada no meio (rodapé tokens used): aborta E grava o marcador", () => {
    writeSessionFile();
    const f = join(runTmp, "codex-stderr.txt");
    writeFileSync(f, upstreamStderr(UPSTREAM_GO_QUOTA, { tokens: "2.004", transcript: true }), "utf8");
    const r = runWrapper(
      wrapperEnv({
        CLAUDE_DELEGATE_CODEX_LANE: "1",
        CODEX_STUB_MODE: "partial-stderr-file",
        CODEX_STUB_STDERR_FILE: f,
        CODEX_STUB_REPO: repo,
      }),
    );
    assert.equal(r.status, 95, r.stderr);
    assert.ok(existsSync(join(runTmp, "codex-lane-quota-exhausted-until")), "marcador de cota não gravado");
  });
});

describe("#10584 — guard de master só no checkout-alvo", () => {
  it("e2e: dentro do codex, commit em master de repo descartável passa; no checkout-alvo é recusado", () => {
    const target = join(tmp, `repo-scope-${Date.now()}`);
    initRepo(target);
    writeSessionFile();
    const r = runWrapper(
      wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "master-scope", CODEX_STUB_REPO: target }),
      [],
      target,
    );
    assert.equal(r.status, 0, r.stderr);
    const unrelatedRc = readFileSync(join(runTmp, "unrelated-commit.rc"), "utf8").trim();
    assert.equal(unrelatedRc, "0", readFileSync(join(runTmp, "unrelated-commit.err"), "utf8"));
    const targetRc = readFileSync(join(runTmp, "target-commit.rc"), "utf8").trim();
    assert.notEqual(targetRc, "0");
    assert.match(readFileSync(join(runTmp, "target-commit.err"), "utf8"), /codex-lane #10560\] recusado/);
  });

  it("hook com CODEX_LANE_GUARDED_COMMON_DIR: repo não relacionado commita em master; worktree do alvo segue guardado", () => {
    const target = join(tmp, `repo-guarded-${Date.now()}`);
    initRepo(target);
    const other = join(tmp, `repo-other-${Date.now()}`);
    initRepo(other);
    const env = { ...hookEnv(), CODEX_LANE_GUARDED_COMMON_DIR: join(target, ".git") };
    writeFileSync(join(other, "o.txt"), "1\n");
    assert.equal(sh("git", ["add", "o.txt"], other, env).status, 0);
    const c = sh("git", ["commit", "-q", "-m", "o"], other, env);
    assert.equal(c.status, 0, c.stderr);

    const wt = join(tmp, `wt-guarded-${Date.now()}`);
    assert.equal(sh("git", ["worktree", "add", "-q", "-b", "continuo/fix-10584-wt", wt], target).status, 0);
    writeFileSync(join(wt, "w.txt"), "1\n");
    assert.equal(sh("git", ["add", "w.txt"], wt, env).status, 0);
    const cw = sh("git", ["commit", "-q", "-m", "w"], wt, env);
    assert.equal(cw.status, 0, cw.stderr);
    const head = sh("git", ["rev-parse", "HEAD"], wt).stdout.trim();
    const u = sh("git", ["update-ref", "refs/heads/master", head], wt, env);
    assert.notEqual(u.status, 0);
    assert.match(u.stderr, /codex-lane #10560\] recusado/);
  });

  // #10588 item c: alvo inválido deixava in_scope=0 (fail-open).
  it("hook com CODEX_LANE_GUARDED_COMMON_DIR inexistente: commit em master continua recusado", () => {
    const target = join(tmp, `repo-badguard-${Date.now()}`);
    initRepo(target);
    const env = { ...hookEnv(), CODEX_LANE_GUARDED_COMMON_DIR: join(tmp, "nao-existe", ".git") };
    writeFileSync(join(target, "x.txt"), "1\n");
    assert.equal(sh("git", ["add", "x.txt"], target, env).status, 0);
    const c = sh("git", ["commit", "-q", "-m", "x"], target, env);
    assert.notEqual(c.status, 0);
    assert.match(c.stderr, /codex-lane #10560\] recusado/);
  });
});

describe("#10560 — invocação e ambiente do processo codex", () => {
  it("argv pinado: exec -m gpt-6.1-sol -c model_reasoning_effort=\"low\" --sandbox ... --color never -C <cwd> -", () => {
    writeSessionFile();
    const r = runWrapper(wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1" }), ["--effort", "high"]);
    assert.equal(r.status, 0, r.stderr);
    const argv = readFileSync(join(runTmp, "codex-argv.log"), "utf8").trimEnd().split("\n");
    assert.deepEqual(argv, [
      "exec",
      "-m",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="low"',
      "--sandbox",
      "danger-full-access",
      "--color",
      "never",
      "-C",
      repo,
      "-",
    ]);
  });

  it("ambiente: sem chaves de API, com hooksPath por env, gh shim na frente e session-id do tick", () => {
    const sid = writeSessionFile("hermes-cron-abc-20261019T010203Z");
    const r = runWrapper(
      wrapperEnv({
        CLAUDE_DELEGATE_CODEX_LANE: "1",
        OPENAI_API_KEY: "sk-proj-NAO-DEVE-CHEGAR",
        ANTHROPIC_API_KEY: "sk-ant-NAO-DEVE-CHEGAR",
      }),
    );
    assert.equal(r.status, 0, r.stderr);
    const env = readFileSync(join(runTmp, "codex-env.log"), "utf8");
    assert.match(env, /^OPENAI_API_KEY=$/m);
    assert.match(env, /^ANTHROPIC_API_KEY=$/m);
    assert.match(env, /^GIT_CONFIG_KEY_0=core\.hooksPath$/m);
    assert.ok(env.includes(`GIT_CONFIG_VALUE_0=${HOOKS_DIR}`), env);
    assert.ok(env.includes(`DIARIA_INJECTED_SESSION_ID=${sid}`), env);
    assert.match(env, /^DIARIA_SESSION_KIND=continuo$/m);
    assert.ok(env.includes(`PATH_HEAD=${GH_SHIM_DIR}`), env);
    const stdin = readFileSync(join(runTmp, "codex-stdin.log"), "utf8");
    assert.match(stdin, /Elo codex exec do contínuo — #10560/);
    assert.match(stdin, /leia o\s+CLAUDE\.md/);
    assert.match(stdin, /implemente a issue de teste/);
  });
});

describe("#10560 — preflight fail-closed", () => {
  it("sem session-id do tick: elo não arma e a cadeia segue sem codex", () => {
    const r = runWrapper(wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1" }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /elo codex ligado mas NÃO armado \(#10560\): session-id do tick ausente/);
    assert.equal(existsSync(join(runTmp, "codex-argv.log")), false);
  });

  it("GIT_CONFIG_COUNT herdado: elo não arma (não sobrescreve config alheia)", () => {
    writeSessionFile();
    const r = runWrapper(
      wrapperEnv({
        CLAUDE_DELEGATE_CODEX_LANE: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "x",
      }),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /NÃO armado.*GIT_CONFIG_COUNT/);
    assert.equal(existsSync(join(runTmp, "codex-argv.log")), false);
  });

  it("--model codex:gpt-6.1-sol explícito sem guard armável é recusado com exit 2", () => {
    const r = runWrapper(wrapperEnv(), ["--model", "codex:gpt-6.1-sol"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /recusado \(#10560\)/);
    assert.equal(existsSync(join(runTmp, "codex-argv.log")), false);
  });

  it("--model codex:gpt-6.1-sol explícito com guard armado roda (passa no portão #10387)", () => {
    writeSessionFile();
    const r = runWrapper(wrapperEnv(), ["--model", "codex:gpt-6.1-sol"]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /recusado \(#10387\)/);
    assert.match(r.stdout, /resposta codex/);
  });

  it("usage limit do plano grava marcador e a invocação seguinte pula o elo", () => {
    writeSessionFile();
    const env = wrapperEnv({ CLAUDE_DELEGATE_CODEX_LANE: "1", CODEX_STUB_MODE: "quota" });
    const r1 = runWrapper(env);
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stderr, /RATE-LIMIT\/QUOTA/);
    const marker = join(runTmp, "codex-lane-quota-exhausted-until");
    assert.ok(existsSync(marker), "marcador de cota do codex não foi gravado");
    assert.ok(Number(readFileSync(marker, "utf8").trim()) > Date.now() / 1000);
    rmSync(join(runTmp, "codex-argv.log"));
    const r2 = runWrapper(env);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stderr, /NÃO armado.*cota do plano marcada como esgotada/);
    assert.equal(existsSync(join(runTmp, "codex-argv.log")), false);
  });
});

describe("#10560 — guard de master/main (reference-transaction por core.hooksPath)", () => {
  let r: string;
  before(() => {
    r = join(tmp, "hookrepo");
    initRepo(r);
  });

  it("commit em master é recusado — inclusive com --no-verify", () => {
    writeFileSync(join(r, "a.txt"), "1\n");
    assert.equal(sh("git", ["add", "a.txt"], r, hookEnv()).status, 0);
    const c1 = sh("git", ["commit", "-q", "-m", "x"], r, hookEnv());
    assert.notEqual(c1.status, 0);
    assert.match(c1.stderr, /codex-lane #10560\] recusado/);
    const c2 = sh("git", ["commit", "-q", "--no-verify", "-m", "x"], r, hookEnv());
    assert.notEqual(c2.status, 0);
    assert.match(c2.stderr, /refs\/heads\/master/);
  });

  it("update-ref e branch -f em master/main são recusados", () => {
    const head = sh("git", ["rev-parse", "HEAD"], r).stdout.trim();
    const u = sh("git", ["update-ref", "refs/heads/master", head], r, hookEnv());
    assert.notEqual(u.status, 0);
    const b = sh("git", ["branch", "-f", "main", head], r, hookEnv());
    assert.notEqual(b.status, 0);
    assert.match(b.stderr, /refs\/heads\/main/);
  });

  it("branch continuo/* commita normalmente e encadeia pro pre-commit original do repo", () => {
    const marker = join(tmp, "orig-pre-commit-ran");
    writeFileSync(join(r, ".git/hooks/pre-commit"), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(r, ".git/hooks/pre-commit"), 0o755);
    assert.equal(sh("git", ["checkout", "-q", "-b", "continuo/fix-10560-teste"], r, hookEnv()).status, 0);
    const c = sh("git", ["commit", "-q", "-m", "ok"], r, hookEnv());
    assert.equal(c.status, 0, c.stderr);
    assert.ok(existsSync(marker), "pre-commit original não foi encadeado");
    const orig = sh("git", ["rev-parse", "master"], r).stdout.trim();
    const cur = sh("git", ["rev-parse", "HEAD"], r).stdout.trim();
    assert.notEqual(orig, cur);
  });

  it("pre-commit original que recusa continua recusando dentro do elo", () => {
    writeFileSync(join(r, ".git/hooks/pre-commit"), "#!/bin/sh\necho 'orig recusou' >&2\nexit 1\n");
    writeFileSync(join(r, "b.txt"), "2\n");
    assert.equal(sh("git", ["add", "b.txt"], r, hookEnv()).status, 0);
    const c = sh("git", ["commit", "-q", "-m", "y"], r, hookEnv());
    assert.notEqual(c.status, 0);
    assert.match(c.stderr, /orig recusou/);
    rmSync(join(r, ".git/hooks/pre-commit"));
  });
});

describe("#10560 — gh shim (merge recusado, pr create só de continuo/*, guard de PII)", () => {
  let r: string;
  let realGhDir: string;
  let ghLog: string;
  let ghStdinLog: string;

  before(() => {
    r = join(tmp, "ghrepo");
    initRepo(r);
    realGhDir = join(tmp, "realgh");
    mkdirSync(realGhDir);
    ghLog = join(tmp, "realgh.log");
    ghStdinLog = join(tmp, "realgh-stdin.log");
    writeFileSync(
      join(realGhDir, "gh"),
      [
        "#!/usr/bin/env bash",
        `echo "$*" >> '${ghLog}'`,
        'if [ "$1 $2" = "pr create" ]; then echo "https://github.com/o/r/pull/42"; fi',
        // #10585: alias já gravado na config do gh real.
        'if [ "$1 $2" = "alias list" ]; then echo "m: pr merge"; echo "co: pr checkout"; echo "m+: pr merge"; fi',
        `case " $* " in *" --input - "*) cat > '${ghStdinLog}' ;; esac`,
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(realGhDir, "gh"), 0o755);
  });

  function gh(args: string[], cwd = r, input?: string) {
    return spawnSync("bash", [join(GH_SHIM_DIR, "gh"), ...args], {
      cwd,
      input,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PATH: `${GH_SHIM_DIR}:${realGhDir}:${process.env.PATH ?? ""}`, TMPDIR: tmp },
    });
  }

  function realCalls(): string {
    return existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "";
  }

  it("gh pr merge é recusado sem chegar ao gh real", () => {
    const res = gh(["pr", "merge", "5", "--squash"]);
    assert.equal(res.status, 3, res.stderr);
    assert.doesNotMatch(realCalls(), /merge/);
  });

  // Review da PR #10583 (P2): o valor de -R/--repo era lido como subcomando.
  it("gh pr -R/--repo owner/repo merge é recusado (valor da flag não vira subcomando)", () => {
    for (const args of [
      ["pr", "-R", "o/r", "merge", "5"],
      ["pr", "--repo", "o/r", "merge", "5", "--squash"],
      ["pr", "--repo=o/r", "merge", "5"],
      ["-R", "o/r", "pr", "merge", "5"],
      ["pr", "--hostname", "github.com", "-R", "o/r", "merge", "5"],
    ]) {
      const res = gh(args);
      assert.equal(res.status, 3, `${args.join(" ")}: ${res.stderr}`);
    }
    assert.doesNotMatch(realCalls(), /merge/);
  });

  it("gh pr -R owner/repo list passa direto (o pulo do valor não recusa outros subcomandos)", () => {
    const res = gh(["pr", "-R", "o/r", "list"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(realCalls(), /pr -R o\/r list/);
  });

  it("merge via gh api (REST e GraphQL) é recusado", () => {
    assert.equal(gh(["api", "-X", "PUT", "repos/o/r/pulls/5/merge"]).status, 3);
    assert.equal(gh(["api", "graphql", "-f", "query=mutation { mergePullRequest(input:{}) { clientMutationId } }"]).status, 3);
    assert.doesNotMatch(realCalls(), /merge/i);
  });

  // #10585: corpo vindo de arquivo/stdin escapava da varredura do argv.
  it("merge via gh api com corpo em --input <arq> / -F campo=@arq / --input - (stdin) é recusado", () => {
    // Nome neutro: a recusa tem que vir do CONTEÚDO, não do path no argv.
    const q = join(tmp, "q1.graphql");
    writeFileSync(q, "mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }\n");
    const before = realCalls();
    for (const args of [
      ["api", "graphql", "--input", q],
      ["api", "graphql", `--input=${q}`],
      ["api", "graphql", "-F", `query=@${q}`],
      ["api", "graphql", `--field=query=@${q}`],
      ["api", "graphql", `-Fquery=@${q}`],
    ]) {
      const res = gh(args);
      assert.equal(res.status, 3, `${args.join(" ")}: ${res.stderr}`);
    }
    const viaStdin = gh(["api", "graphql", "--input", "-"], r, '{"query":"mutation { enablePullRequestAutoMerge(input:{}) { clientMutationId } }"}');
    assert.equal(viaStdin.status, 3, viaStdin.stderr);
    const viaStdinField = gh(["api", "graphql", "-F", "query=@-"], r, "mutation { mergeBranch(input:{}) { clientMutationId } }");
    assert.equal(viaStdinField.status, 3, viaStdinField.stderr);
    assert.equal(realCalls(), before);
  });

  it("gh api com --input benigno passa, com argv intacto e stdin repassado ao gh real", () => {
    const q = join(tmp, "ok.graphql");
    writeFileSync(q, "query { viewer { login } }\n");
    assert.equal(gh(["api", "graphql", "--input", q]).status, 0);
    assert.ok(realCalls().includes(`api graphql --input ${q}`));
    const res = gh(["api", "graphql", "--input", "-"], r, '{"query":"query { viewer { login } }"}');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(ghStdinLog, "utf8"), '{"query":"query { viewer { login } }"}');
  });

  it("gh api com corpo em arquivo ilegível é recusado (não dá pra checar)", () => {
    const res = gh(["api", "graphql", "--input", join(tmp, "nao-existe.graphql")]);
    assert.equal(res.status, 3, res.stderr);
  });

  it("criação de PR via gh api (POST em pulls, explícito ou implícito, e createPullRequest) é recusada", () => {
    const before = realCalls();
    for (const args of [
      ["api", "repos/o/r/pulls", "-f", "head=fix-1", "-f", "base=master", "-f", "title=t"],
      ["api", "-X", "POST", "repos/{owner}/{repo}/pulls"],
      ["api", "--method=post", "/repos/o/r/pulls/"],
      ["api", "-R", "o/r", "repos/o/r/pulls", "-F", "draft=true"],
      ["api", "graphql", "-f", "query=mutation { createPullRequest(input:{}) { pullRequest { url } } }"],
    ]) {
      const res = gh(args);
      assert.equal(res.status, 3, `${args.join(" ")}: ${res.stderr}`);
    }
    assert.equal(realCalls(), before);
  });

  it("leitura de pulls e PATCH numa PR existente passam", () => {
    for (const args of [
      ["api", "repos/o/r/pulls"],
      ["api", "-X", "GET", "repos/o/r/pulls", "-f", "state=open"],
      ["api", "-X", "PATCH", "repos/o/r/pulls/5", "-f", "body=novo corpo"],
      ["api", "repos/o/r/issues/1/comments", "-f", "body=@fulano veja"],
      ["api", "repos/o/r/git/refs/heads/master"],
    ]) {
      const res = gh(args);
      assert.equal(res.status, 0, `${args.join(" ")}: ${res.stderr}`);
    }
  });

  it("merge sem PR via REST (merges, escrita em git/refs/heads/master) é recusado", () => {
    for (const args of [
      ["api", "-X", "POST", "repos/o/r/merges", "-f", "base=master", "-f", "head=x"],
      ["api", "-X", "PATCH", "repos/o/r/git/refs/heads/master", "-f", "sha=abc", "-F", "force=true"],
      ["api", "repos/o/r/git/refs/heads/main", "-f", "sha=abc"],
    ]) {
      const res = gh(args);
      assert.equal(res.status, 3, `${args.join(" ")}: ${res.stderr}`);
    }
  });

  it("gh alias (set/import) e invocação de alias já existente são recusados", () => {
    const before = realCalls();
    assert.equal(gh(["alias", "set", "m", "pr merge"]).status, 3);
    assert.equal(gh(["alias", "import", "-"], r, "m: pr merge\n").status, 3);
    assert.doesNotMatch(realCalls().slice(before.length), /alias set|alias import/);
    const res = gh(["m", "5"]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /alias do gh 'm'/);
    assert.doesNotMatch(realCalls(), /^m 5$/m);
  });

  // #10588 item b: o escape por sed deixava `+` cru — alias `m+` não casava.
  it("alias com metacaractere ERE no nome (m+) é recusado; nome parecido que não é alias passa", () => {
    const res = gh(["m+", "5"]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /alias do gh 'm\+'/);
    assert.doesNotMatch(realCalls(), /^m\+ 5$/m);
    const ok = gh(["mm+", "5"]);
    assert.equal(ok.status, 0, ok.stderr);
  });

  it("comando fora da lista embutida que não é alias passa direto", () => {
    const res = gh(["minha-extensao", "x"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(realCalls(), /^minha-extensao x$/m);
  });

  it("gh pr create em master é recusado", () => {
    const res = gh(["pr", "create", "--title", "t", "--body", "b"]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /continuo\/fix/);
    assert.doesNotMatch(realCalls(), /pr create/);
  });

  it("gh pr create de continuo/* passa pro gh real e registra a PR", () => {
    assert.equal(sh("git", ["checkout", "-q", "-b", "continuo/fix-10560-x"], r).status, 0);
    const res = gh(["pr", "create", "--title", "t", "--body", "b"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(realCalls(), /pr create --title t --body b/);
    assert.match(readFileSync(join(tmp, "codex-lane-pr-created.log"), "utf8"), /pull\/42 continuo\/fix-10560-x/);
  });

  it("guard de PII/artefato de runtime do .claude/hooks barra gh pr create", () => {
    mkdirSync(join(r, ".claude/hooks/lib"), { recursive: true });
    cpSync(
      join(ROOT, ".claude/hooks/block-pr-create-pii-runtime-artifacts.mjs"),
      join(r, ".claude/hooks/block-pr-create-pii-runtime-artifacts.mjs"),
    );
    cpSync(join(ROOT, ".claude/hooks/lib/shell-quote-strip.mjs"), join(r, ".claude/hooks/lib/shell-quote-strip.mjs"));
    writeFileSync(join(r, "_prbody.md"), "corpo solto\n");
    assert.equal(sh("git", ["add", "_prbody.md"], r).status, 0);
    assert.equal(sh("git", ["commit", "-q", "-m", "artefato"], r).status, 0);
    const before = realCalls();
    const res = gh(["pr", "create", "--title", "t2", "--body", "b"]);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /guard de PII\/artefato de runtime/);
    assert.equal(realCalls(), before);
  });

  // Review da PR #10583 (P3): fail-open continua, mas com rastro em stderr.
  it("guard de PII que quebra: gh pr create segue (fail-open) com AVISO em stderr", () => {
    const r2 = join(tmp, "ghrepo-piibroken");
    initRepo(r2);
    mkdirSync(join(r2, ".claude/hooks"), { recursive: true });
    writeFileSync(join(r2, ".claude/hooks/block-pr-create-pii-runtime-artifacts.mjs"), 'throw new Error("boom-pii");\n');
    assert.equal(sh("git", ["checkout", "-q", "-b", "continuo/fix-10560-pii"], r2).status, 0);
    const res = gh(["pr", "create", "--title", "t3", "--body", "b"], r2);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /AVISO: guard de PII\/artefato de runtime falhou \(rc=\d+\).*boom-pii/);
    assert.match(realCalls(), /pr create --title t3/);
  });

  it("comando qualquer passa direto (argv intacto)", () => {
    const res = gh(["issue", "list", "--state", "open"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(realCalls(), /issue list --state open/);
  });
});

describe("#10560 — --session-id por env em session-registry.ts", () => {
  it("injeta o id do tick só em claim/lease, sem sobrescrever --session-id explícito", () => {
    const env = { [ENV_INJECTED_SESSION_ID_VAR]: "tick-1" };
    assert.equal(resolveEnvInjectedSessionId("claim-issue", {}, env), "tick-1");
    assert.equal(resolveEnvInjectedSessionId("is-claimed", {}, env), "tick-1");
    assert.equal(resolveEnvInjectedSessionId("claim-issue", { "session-id": "explicito" }, env), undefined);
    assert.equal(resolveEnvInjectedSessionId("claim-issue", {}, {}), undefined);
    assert.equal(resolveEnvInjectedSessionId("claim-issue", {}, { [ENV_INJECTED_SESSION_ID_VAR]: "  " }), undefined);
    assert.equal(resolveEnvInjectedSessionId(undefined, {}, env), undefined);
  });

  it("nunca injeta em merge nem no ciclo de vida da sessão", () => {
    const env = { [ENV_INJECTED_SESSION_ID_VAR]: "tick-1" };
    for (const sub of [
      "register",
      "end",
      "grant-merge",
      "check-merge-grant",
      "consume-merge-grant",
      "merge-lock-acquire",
      "merge-lock-release",
      "merge-lock-renew",
      "self-authorize-merge",
    ]) {
      assert.equal(resolveEnvInjectedSessionId(sub, {}, env), undefined, sub);
    }
  });

  it("lista injetável é subconjunto de SESSION_ID_REQUIRED_SUBCOMMANDS", () => {
    for (const sub of ENV_INJECTABLE_SUBCOMMANDS) {
      assert.ok((SESSION_ID_REQUIRED_SUBCOMMANDS as readonly string[]).includes(sub), sub);
    }
  });

  it("session-registry.ts aplica a injeção antes do switch de subcomandos", () => {
    const src = readFileSync(join(ROOT, "scripts/lib/session-registry.ts"), "utf8");
    const mainIdx = src.indexOf("function main(): void");
    const injectIdx = src.indexOf("resolveEnvInjectedSessionId(command, values, process.env)", mainIdx);
    const switchIdx = src.indexOf("switch (command)", mainIdx);
    assert.ok(mainIdx > 0 && injectIdx > mainIdx && injectIdx < switchIdx, "injeção por env fora de main() ou depois do switch");
  });
});
