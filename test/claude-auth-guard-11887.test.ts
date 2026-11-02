/**
 * test/claude-auth-guard-11887.test.ts (#11887)
 *
 * Regressão: sessão agendada autenticada por API (pay-per-token, sem
 * conectores claude.ai, #5608) sem nenhuma `ANTHROPIC_*` no ambiente. Os
 * runners agora perguntam `claude auth status` e só sobem com
 * `authMethod === "claude.ai"`; qualquer outra coisa falha fechado, sem
 * vazar e-mail/org da saída do CLI.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_CLAUDE_AUTH_NOT_SUBSCRIPTION,
  checkClaudeAuth,
} from "../scripts/lib/claude-auth-guard.ts";
import {
  DAILY_REVIEW_SCRIPT,
  chainExitCode,
  main as chainMain,
  type NightlyChainDeps,
} from "../scripts/overnight/run-nightly-chain.ts";
import { main as edicaoMain } from "../scripts/overnight/run-scheduled-edicao.ts";

type Exec = typeof import("node:child_process").execFileSync;
const execReturning = (out: string) => (() => out) as unknown as Exec;
const execThrowing = (props: object) =>
  (() => {
    throw Object.assign(new Error("EMAIL_SECRETO@x.com falhou"), props);
  }) as unknown as Exec;

const PII = { email: "alguem@example.com", orgId: "org-segredo-123", orgName: "Org Secreta" };
const status = (authMethod: string) => JSON.stringify({ loggedIn: true, authMethod, ...PII });

describe("checkClaudeAuth (#11887)", () => {
  it("authMethod claude.ai → subscription", () => {
    const r = checkClaudeAuth("/fake/claude", { exec: execReturning(status("claude.ai")) });
    assert.equal(r.status, "subscription");
  });

  it("authMethod diferente → wrong-method, sem vazar e-mail/org", () => {
    for (const m of ["api_key", "console", "oauth_token"]) {
      const r = checkClaudeAuth("/fake/claude", { exec: execReturning(status(m)) });
      assert.equal(r.status, "wrong-method");
      assert.equal(r.authMethod, m);
      assert.doesNotMatch(JSON.stringify(r), /example\.com|org-segredo|Org Secreta/);
    }
  });

  it("authMethod malicioso é sanitizado antes de ecoar", () => {
    const r = checkClaudeAuth("/fake/claude", { exec: execReturning(status("sk-ant-xxx\nINJECT $(rm)")) });
    assert.equal(r.status, "wrong-method");
    assert.match(r.message, /authMethod=sk-ant-xxx\?INJECT\?\?\?rm\?,/);
  });

  it("falha fechado: spawn falha, timeout, não-JSON, sem authMethod, authMethod não-string", () => {
    const cases: Exec[] = [
      execThrowing({ code: "ENOENT" }),
      execThrowing({ code: "ETIMEDOUT" }),
      execThrowing({ status: 1 }),
      execReturning("not json"),
      execReturning(JSON.stringify({ loggedIn: false })),
      execReturning(JSON.stringify({ authMethod: 42 })),
      execReturning("null"),
    ];
    for (const exec of cases) {
      const r = checkClaudeAuth("/fake/claude", { exec });
      assert.equal(r.status, "unverifiable");
      assert.doesNotMatch(r.message, /EMAIL_SECRETO/);
    }
  });

  it("passa o env recebido e nunca herda stdout/stderr do filho", () => {
    let seen: { env?: NodeJS.ProcessEnv; stdio?: unknown; args?: readonly string[] } = {};
    const exec = ((_bin: string, args: readonly string[], o: { env?: NodeJS.ProcessEnv; stdio?: unknown }) => {
      seen = { env: o.env, stdio: o.stdio, args };
      return status("claude.ai");
    }) as unknown as Exec;
    checkClaudeAuth("/fake/claude", { exec, env: { MARCA: "1" } });
    assert.deepEqual(seen.args, ["auth", "status"]);
    assert.equal(seen.env?.MARCA, "1");
    assert.deepEqual(seen.stdio, ["ignore", "pipe", "ignore"]);
  });
});

describe("cadeia noturna (#11887)", () => {
  function makeRepo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "auth-11887-repo-")));
    mkdirSync(join(root, "hermes", "scripts"), { recursive: true });
    writeFileSync(join(root, DAILY_REVIEW_SCRIPT), "#!/usr/bin/env bash\nexit 0\n");
    return root;
  }
  function harness(authMethod: string | null) {
    const calls: string[] = [];
    const lines: string[] = [];
    const deps = {
      spawn: ((cmd: string, args: string[]) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return { status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null };
      }) as unknown as NightlyChainDeps["spawn"],
      resolveClaudeBin: () => "/fake/claude",
      hasActiveOvernight: () => false,
      env: {},
      log: (l: string) => lines.push(l),
      checkClaudeAuth: (bin: string, env: NodeJS.ProcessEnv) =>
        checkClaudeAuth(bin, {
          env,
          exec: authMethod === null ? execThrowing({ code: "ENOENT" }) : execReturning(status(authMethod)),
        }),
    } as NightlyChainDeps;
    return { deps, calls, lines };
  }

  it("auth != claude.ai: overnight não sobe e exit = EXIT_CLAUDE_AUTH_NOT_SUBSCRIPTION", () => {
    const repo = makeRepo();
    const h = harness("api_key");
    const code = chainMain(repo, h.deps);
    assert.equal(code, EXIT_CLAUDE_AUTH_NOT_SUBSCRIPTION);
    assert.ok(!h.calls.some((c) => c.includes("diaria-overnight")), "overnight não pode ter sido despachado");
    assert.ok(h.lines.some((l) => /authMethod=api_key/.test(l)));
    assert.ok(!h.lines.some((l) => /example\.com|org-segredo/.test(l)));
  });

  it("auth não verificável: também não sobe", () => {
    const repo = makeRepo();
    const h = harness(null);
    assert.equal(chainMain(repo, h.deps), EXIT_CLAUDE_AUTH_NOT_SUBSCRIPTION);
    assert.ok(!h.calls.some((c) => c.includes("diaria-overnight")));
  });

  it("chainExitCode mapeia o novo status", () => {
    assert.equal(chainExitCode("ok", { status: "auth-not-subscription", exitCode: null }), EXIT_CLAUDE_AUTH_NOT_SUBSCRIPTION);
  });
});

describe("edição agendada (#11887)", () => {
  const AAMMDD = "260812";
  const notDone = (() => ({ ok: false })) as never;
  function edicaoRepo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "auth-11887-edicao-")));
    mkdirSync(join(root, "data"), { recursive: true });
    return root;
  }
  const trusted = () => ({ status: "trusted" as const, configPath: "x", message: "ok" });

  it("auth != claude.ai: nenhum stage disparado, exit 7 e FAIL no schedule log", () => {
    const repo = edicaoRepo();
    let spawned = 0;
    const exec = (() => {
      spawned++;
      return "";
    }) as unknown as Exec;
    const code = edicaoMain(repo, exec, AAMMDD, () => "/fake/claude", notDone, trusted, (bin) =>
      checkClaudeAuth(bin, { exec: execReturning(status("api_key")) }),
    );
    assert.equal(code, EXIT_CLAUDE_AUTH_NOT_SUBSCRIPTION);
    assert.equal(spawned, 0);
    const log = readFileSync(join(repo, "data", "overnight-schedule.log"), "utf8");
    assert.match(log, /FAIL\s+edition=260812 reason=auth-wrong-method exit=7/);
    assert.doesNotMatch(log, /example\.com|org-segredo/);
  });

  it("binário não resolvido vira auth-unverifiable (não estoura)", () => {
    const repo = edicaoRepo();
    const code = edicaoMain(
      repo,
      (() => "") as unknown as Exec,
      AAMMDD,
      () => {
        throw new Error("sem claude");
      },
      notDone,
      trusted,
      (bin) => checkClaudeAuth(bin, { exec: execReturning(status("claude.ai")) }),
    );
    assert.equal(code, EXIT_CLAUDE_AUTH_NOT_SUBSCRIPTION);
    assert.match(readFileSync(join(repo, "data", "overnight-schedule.log"), "utf8"), /reason=auth-unverifiable/);
  });
});
