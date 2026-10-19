/**
 * test/hermes-codex-lane-10560.test.ts (#10560)
 *
 * Elo `codex exec` (Sol 6.1, esforço low, plano OpenAI) na cadeia de
 * implementação do contínuo, ANTES dos `:free`, DESLIGADO por padrão. Nunca
 * roda `codex` real (cota compartilhada com o orquestrador): `codex`, `claude`
 * e `gh` são stubs no PATH.
 *
 * Trava:
 *   1. Ordem da cadeia — desligado: nada de codex; ligado: codex primeiro,
 *      fallback nos elos de sempre quando falha.
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
      "  quota) echo \"You've hit your usage limit. Try again later.\" >&2; exit 1 ;;",
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

function runWrapper(env: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync("bash", [WRAPPER, "--cwd", repo, "--timeout", "20", ...args], {
    input: "implemente a issue de teste",
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

function attemptOrder(stderr: string): string[] {
  return [...stderr.matchAll(/\[claude-openrouter\] tentando model=(\S+)/g)].map((m) => m[1]);
}

const FIRST_NON_CODEX = new Set(["dots-studio/dots-3-note-preview:free", "sonnet"]);

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

  it("ligado: codex é o 1º elo e, com sucesso, nenhum claude roda", () => {
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
});

describe("#10560 — invocação e ambiente do processo codex", () => {
  it("argv pinado: exec -m gpt-6.1-sol -c model_reasoning_effort=\"low\" --sandbox ... -C <cwd> -", () => {
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

  before(() => {
    r = join(tmp, "ghrepo");
    initRepo(r);
    realGhDir = join(tmp, "realgh");
    mkdirSync(realGhDir);
    ghLog = join(tmp, "realgh.log");
    writeFileSync(
      join(realGhDir, "gh"),
      `#!/usr/bin/env bash\necho "$*" >> '${ghLog}'\nif [ "$1 $2" = "pr create" ]; then echo "https://github.com/o/r/pull/42"; fi\nexit 0\n`,
    );
    chmodSync(join(realGhDir, "gh"), 0o755);
  });

  function gh(args: string[]) {
    return spawnSync("bash", [join(GH_SHIM_DIR, "gh"), ...args], {
      cwd: r,
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

  it("merge via gh api (REST e GraphQL) é recusado", () => {
    assert.equal(gh(["api", "-X", "PUT", "repos/o/r/pulls/5/merge"]).status, 3);
    assert.equal(gh(["api", "graphql", "-f", "query=mutation { mergePullRequest(input:{}) { clientMutationId } }"]).status, 3);
    assert.doesNotMatch(realCalls(), /merge/i);
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
