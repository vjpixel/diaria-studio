/**
 * test/claude-auth-method-11887.test.ts (#11887)
 *
 * Regressão: em 02/11/2026 o CLI do `300` estava autenticado pela API ("API
 * Usage Billing") sem nenhuma var `ANTHROPIC_*` no ambiente — a credencial
 * gravada passava pelo filtro de env do #5608 sem ninguém notar. Os runners
 * agendados agora perguntam ao CLI (`claude auth status`) com o ambiente do
 * filho e não sobem sessão fora da assinatura claude.ai.
 *
 * Nada aqui chama o `claude` real nem lê o `~/.claude.json` da máquina.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_AUTH_NOT_SUBSCRIPTION,
  authBlocksRun,
  authBlocksScheduledEdicao,
  checkClaudeAuthMethod,
  classifyClaudeAuthStatus,
  collectClaudeAuthEvidence,
  formatClaudeAuthEvidence,
  type ClaudeAuthResult,
} from "../scripts/lib/claude-auth-method.ts";
import { DAILY_REVIEW_SCRIPT, main as chainMain, type NightlyChainDeps } from "../scripts/overnight/run-nightly-chain.ts";
import { main as edicaoMain } from "../scripts/overnight/run-scheduled-edicao.ts";
import { diagnoseExitCode } from "../scripts/diagnose-claude-auth.ts";

type ExecFn = typeof import("node:child_process").execFileSync;

/** Formato real de `claude auth status` 2.1.310 na assinatura (e-mail/org fictícios). */
const SUBSCRIPTION_JSON = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  analyticsDisabled: false,
  email: "pessoa@example.com",
  orgId: "org-123",
  orgName: "Org Secreta",
  subscriptionType: "max",
});

/** O caso da issue: key gravada por `/login` com conta do Console, sem var no ambiente. */
const MANAGED_KEY_JSON = JSON.stringify({
  loggedIn: true,
  authMethod: "api_key",
  apiProvider: "firstParty",
  apiKeySource: "/login managed key",
  email: "pessoa@example.com",
  orgId: "org-123",
  orgName: "Org Secreta",
});

const sub = (): ClaudeAuthResult => classifyClaudeAuthStatus(SUBSCRIPTION_JSON);
const api = (): ClaudeAuthResult => classifyClaudeAuthStatus(MANAGED_KEY_JSON);

describe("classifyClaudeAuthStatus (#11887)", () => {
  it("authMethod claude.ai → subscription, sem e-mail/org no resultado", () => {
    const r = sub();
    assert.equal(r.status, "subscription");
    assert.equal(authBlocksRun(r), false);
    assert.deepEqual(r.fields, { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" });
    assert.doesNotMatch(JSON.stringify(r), /pessoa@example|org-123|Org Secreta/);
  });

  it("o caso da issue — api_key via /login managed key, sem var — bloqueia e nomeia a fonte", () => {
    const r = api();
    assert.equal(r.status, "not-subscription");
    assert.equal(authBlocksRun(r), true);
    assert.match(r.message, /apiKeySource=\/login managed key/);
    assert.match(r.message, /#5608/);
    assert.doesNotMatch(r.message, /pessoa@example|Org Secreta/);
  });

  it("api_key_helper, third_party e rótulo desconhecido também bloqueiam a cadeia (estrito)", () => {
    for (const authMethod of ["api_key_helper", "third_party", "algo_novo"]) {
      const r = classifyClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod, apiProvider: "firstParty" }));
      assert.equal(r.status, "not-subscription", authMethod);
      assert.equal(authBlocksRun(r), true, authMethod);
    }
  });

  it("edição agendada: só o rótulo DESCONHECIDO é fail-soft; fontes de API explícitas seguem bloqueando", () => {
    const novo = classifyClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude_ai_v2", apiProvider: "firstParty" }));
    assert.equal(novo.unrecognizedAuthMethod, true);
    assert.equal(authBlocksScheduledEdicao(novo), false);
    assert.match(novo.message, /rótulo de authMethod desconhecido/);
    for (const authMethod of ["api_key", "api_key_helper", "third_party", "oauth_token"]) {
      const r = classifyClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod, apiProvider: "firstParty" }));
      assert.equal(r.unrecognizedAuthMethod, undefined, authMethod);
      assert.equal(authBlocksScheduledEdicao(r), true, authMethod);
    }
    // Rótulo novo MAS com apiKeySource: é key, bloqueia.
    const novoComKey = classifyClaudeAuthStatus(
      JSON.stringify({ loggedIn: true, authMethod: "algo_novo", apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }),
    );
    assert.equal(authBlocksScheduledEdicao(novoComKey), true);
    // Provider de terceiro com rótulo novo: bloqueia.
    const novoTerceiro = classifyClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "algo_novo", apiProvider: "bedrock" }));
    assert.equal(authBlocksScheduledEdicao(novoTerceiro), true);
    assert.equal(authBlocksScheduledEdicao(classifyClaudeAuthStatus(JSON.stringify({ loggedIn: false }))), true);
    assert.equal(authBlocksScheduledEdicao(api()), true);
  });

  it("provider de terceiro bloqueia mesmo com authMethod claude.ai", () => {
    for (const apiProvider of ["bedrock", "vertex", "gateway"]) {
      const r = classifyClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider }));
      assert.equal(r.status, "not-subscription", apiProvider);
    }
  });

  it("oauth_token: assinatura só via CLAUDE_CODE_OAUTH_TOKEN e sem ANTHROPIC_AUTH_TOKEN (#6714)", () => {
    const raw = JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" });
    assert.equal(classifyClaudeAuthStatus(raw, new Set(["CLAUDE_CODE_OAUTH_TOKEN"])).status, "subscription");
    assert.equal(
      classifyClaudeAuthStatus(raw, new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])).status,
      "not-subscription",
    );
    assert.equal(classifyClaudeAuthStatus(raw, new Set(["ANTHROPIC_AUTH_TOKEN"])).status, "not-subscription");
    assert.equal(classifyClaudeAuthStatus(raw).status, "not-subscription");
  });

  it("loggedIn false / authMethod none → logged-out (bloqueia)", () => {
    for (const j of [{ loggedIn: false, authMethod: "none" }, { loggedIn: true, authMethod: "none" }, { loggedIn: false }]) {
      const r = classifyClaudeAuthStatus(JSON.stringify(j));
      assert.equal(r.status, "logged-out", JSON.stringify(j));
      assert.equal(authBlocksRun(r), true);
    }
  });

  it("saída que não é JSON, JSON não-objeto ou sem authMethod → unknown (não bloqueia)", () => {
    for (const raw of ["Login method: Claude Max", "null", "[1]", JSON.stringify({ loggedIn: true })]) {
      const r = classifyClaudeAuthStatus(raw);
      assert.equal(r.status, "unknown", raw);
      assert.equal(authBlocksRun(r), false);
      assert.match(r.message, /NÃO VERIFICÁVEL/);
    }
  });
});

describe("checkClaudeAuthMethod (#11887)", () => {
  it("chama `auth status --json` com o env dado", () => {
    const seen: { cmd?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {};
    const exec = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      Object.assign(seen, { cmd, args, env: opts.env });
      return SUBSCRIPTION_JSON;
    }) as unknown as ExecFn;
    const env = { PATH: "/usr/bin" };
    const r = checkClaudeAuthMethod("/opt/claude", env, { execFn: exec });
    assert.equal(r.status, "subscription");
    assert.equal(seen.cmd, "/opt/claude");
    assert.deepEqual(seen.args, ["auth", "status", "--json"]);
    assert.equal(seen.env, env);
  });

  it("os nomes de var do env entram no desempate do oauth_token", () => {
    const exec = (() => JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" })) as unknown as ExecFn;
    assert.equal(checkClaudeAuthMethod("c", { CLAUDE_CODE_OAUTH_TOKEN: "x" }, { execFn: exec }).status, "subscription");
    assert.equal(checkClaudeAuthMethod("c", { CLAUDE_CODE_OAUTH_TOKEN: "" }, { execFn: exec }).status, "not-subscription");
  });

  it("ENOENT/timeout → unknown; exit != 0 sem JSON → logged-out; exit != 0 com JSON → classificado", () => {
    const throwing = (err: object) =>
      (() => {
        throw Object.assign(new Error("x"), err);
      }) as unknown as ExecFn;
    assert.equal(checkClaudeAuthMethod("c", {}, { execFn: throwing({ code: "ENOENT" }) }).status, "unknown");
    assert.equal(checkClaudeAuthMethod("c", {}, { execFn: throwing({ code: "ETIMEDOUT", status: null }) }).status, "unknown");
    assert.equal(checkClaudeAuthMethod("c", {}, { execFn: throwing({ status: 1, stdout: "" }) }).status, "logged-out");
    assert.equal(
      checkClaudeAuthMethod("c", {}, { execFn: throwing({ status: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) }) }).status,
      "logged-out",
    );
    assert.equal(checkClaudeAuthMethod("c", {}, { execFn: throwing({ status: 1, stdout: MANAGED_KEY_JSON }) }).status, "not-subscription");
  });
});

describe("collectClaudeAuthEvidence (#11887)", () => {
  it("acusa primaryApiKey, keys aprovadas e var de auth em settings — sem vazar valor", () => {
    const SECRET = "sk-ant-api03-NAO-PODE-APARECER";
    const files: Record<string, string> = {
      "/h/.claude.json": JSON.stringify({ primaryApiKey: SECRET, customApiKeyResponses: { approved: ["abc"], rejected: [] } }),
      "/h/.claude/settings.json": JSON.stringify({ env: { ANTHROPIC_API_KEY: SECRET, OUTRA: "1" } }),
      "/repo/.claude/settings.local.json": JSON.stringify({ apiKeyHelper: "/bin/echo-key" }),
      "/repo/.claude/settings.json": JSON.stringify({ permissions: {} }),
      "/h/.claude/.credentials.json": "{}",
    };
    const e = collectClaudeAuthEvidence({
      env: { ANTHROPIC_BASE_URL: "https://gateway.example", PATH: "/usr/bin" },
      repoRootAbs: "/repo",
      home: "/h",
      exists: (p) => p in files,
      readFile: (p) => files[p],
    });
    assert.deepEqual(e.envVars, ["ANTHROPIC_BASE_URL"]);
    assert.equal(e.globalConfigPrimaryApiKey, true);
    assert.equal(e.globalConfigApprovedEnvKeys, 1);
    assert.deepEqual(e.settings, [
      { path: "/h/.claude/settings.json", apiKeyHelper: false, envVars: ["ANTHROPIC_API_KEY"] },
      { path: "/repo/.claude/settings.local.json", apiKeyHelper: true, envVars: [] },
    ]);
    assert.equal(e.credentialsFile, true);
    assert.equal(e.configDirOverride, false);
    const line = formatClaudeAuthEvidence(e);
    assert.doesNotMatch(`${line}${JSON.stringify(e)}`, /NAO-PODE-APARECER|gateway\.example|echo-key/);
    assert.match(line, /primaryApiKey=true/);
  });

  it("config ausente/ilegível → campos nulos, nunca lança", () => {
    const e = collectClaudeAuthEvidence({
      env: { CLAUDE_CONFIG_DIR: "/cfg" },
      repoRootAbs: "/repo",
      home: "/h",
      exists: (p) => p === "/cfg/.claude.json",
      readFile: () => "{ quebrado",
    });
    assert.equal(e.globalConfigPrimaryApiKey, null);
    assert.equal(e.globalConfigApprovedEnvKeys, null);
    assert.deepEqual(e.settings, []);
    assert.equal(e.credentialsFile, false);
    assert.equal(e.configDirOverride, true);
  });

  it("CLAUDE_CONFIG_DIR não aparece como var de auth em env=[...] — sai separado (review #11887)", () => {
    const e = collectClaudeAuthEvidence({
      env: { CLAUDE_CONFIG_DIR: "/cfg", ANTHROPIC_API_KEY: "x" },
      repoRootAbs: "/repo",
      home: "/h",
      exists: () => false,
      readFile: () => "",
    });
    assert.deepEqual(e.envVars, ["ANTHROPIC_API_KEY"]);
    const line = formatClaudeAuthEvidence(e);
    assert.match(line, /env=\[ANTHROPIC_API_KEY\] /);
    assert.match(line, /configDirOverride=true/);
  });
});

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "auth-11887-repo-")));
  mkdirSync(join(root, "hermes", "scripts"), { recursive: true });
  writeFileSync(join(root, DAILY_REVIEW_SCRIPT), "#!/usr/bin/env bash\nexit 0\n");
  return root;
}

function chainHarness(auth: () => ClaudeAuthResult) {
  const calls: string[] = [];
  const logs: string[] = [];
  const authEnvs: NodeJS.ProcessEnv[] = [];
  const deps: NightlyChainDeps = {
    spawn: ((cmd: string) => {
      calls.push(cmd);
      return { pid: 1, output: [], stdout: "", stderr: cmd === "bash" ? "[daily-review] concluído" : "", status: 0, signal: null };
    }) as unknown as NightlyChainDeps["spawn"],
    resolveClaudeBin: () => "/opt/claude",
    hasActiveOvernight: () => false,
    env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-do-env" },
    log: (l) => logs.push(l),
    checkClaudeAuth: (_root, _bin, env) => {
      authEnvs.push(env);
      return auth();
    },
    describeAuthEvidence: () => "evidência de auth: env=[ANTHROPIC_API_KEY]",
  };
  return { deps, calls, logs, authEnvs };
}

describe("run-nightly-chain: preflight de auth (#11887)", () => {
  it("fora da assinatura: nem o review nem o overnight sobem, exit EXIT_AUTH_NOT_SUBSCRIPTION, evidência no log", () => {
    const { deps, calls, logs } = chainHarness(api);
    assert.equal(chainMain(makeRepo(), deps), EXIT_AUTH_NOT_SUBSCRIPTION);
    assert.deepEqual(calls, [], "nenhum claude pode subir fora da assinatura");
    assert.ok(logs.some((l) => /PULADA — auth do CLI NÃO É A ASSINATURA/.test(l)), logs.join("\n"));
    assert.ok(logs.some((l) => /evidência de auth/.test(l)), logs.join("\n"));
    assert.ok(logs.some((l) => /overnight=auth-not-subscription exit=7/.test(l)), logs.join("\n"));
  });

  it("sem sessão: mesmo desfecho", () => {
    const { deps, calls } = chainHarness(() => classifyClaudeAuthStatus(JSON.stringify({ loggedIn: false, authMethod: "none" })));
    assert.equal(chainMain(makeRepo(), deps), EXIT_AUTH_NOT_SUBSCRIPTION);
    assert.deepEqual(calls, []);
  });

  it("sondado com o ambiente do FILHO (sem ANTHROPIC_API_KEY), não o cru da unit", () => {
    const { deps, authEnvs } = chainHarness(sub);
    chainMain(makeRepo(), deps);
    assert.equal(authEnvs.length, 1);
    assert.equal("ANTHROPIC_API_KEY" in authEnvs[0], false);
  });

  it("assinatura: review e overnight sobem", () => {
    const { deps, calls, logs } = chainHarness(sub);
    chainMain(makeRepo(), deps);
    assert.deepEqual(calls, ["bash", "/opt/claude"]);
    assert.ok(logs.some((l) => /auth do CLI: assinatura claude.ai/.test(l)), logs.join("\n"));
  });

  it("não verificável ou preflight que lança: só avisa, a cadeia segue", () => {
    for (const auth of [
      () => classifyClaudeAuthStatus("lixo"),
      () => {
        throw new Error("boom");
      },
    ]) {
      const { deps, calls, logs } = chainHarness(auth as () => ClaudeAuthResult);
      chainMain(makeRepo(), deps);
      assert.deepEqual(calls, ["bash", "/opt/claude"]);
      assert.ok(logs.some((l) => /AVISO/.test(l)), logs.join("\n"));
    }
  });
});

describe("run-scheduled-edicao: preflight de auth (#11887)", () => {
  const AAMMDD = "260812";
  const notDone = () => ({ ok: false as const, reason: "sentinel_missing" as const });
  const trusted = () => ({ status: "trusted" as const, configPath: "/x", message: "ok" });
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.ANTHROPIC_API_KEY = "sk-ant-do-env-11887";
  // Evidência lê o `.claude.json` daqui, nunca o da máquina.
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "auth-11887-cfg-"));
  after(() => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  });

  function edicaoRepo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "auth-11887-edicao-")));
    mkdirSync(join(root, "data"), { recursive: true });
    return root;
  }

  it("fora da assinatura: nenhum stage, exit 7, FAIL no schedule log sem o valor da key", () => {
    const repo = edicaoRepo();
    let spawned = 0;
    const exec = (() => {
      spawned++;
      return "";
    }) as unknown as ExecFn;
    const envs: NodeJS.ProcessEnv[] = [];
    const code = edicaoMain(repo, exec, AAMMDD, () => "/fake/claude", notDone, trusted, (_bin, env) => {
      envs.push(env);
      return api();
    });
    assert.equal(code, EXIT_AUTH_NOT_SUBSCRIPTION);
    assert.equal(spawned, 0);
    assert.equal("ANTHROPIC_API_KEY" in envs[0], false, "sondagem com o env do filho");
    const log = readFileSync(join(repo, "data", "overnight-schedule.log"), "utf8");
    assert.match(log, /FAIL\s+edition=260812 reason=auth-not-subscription exit=7/);
    assert.match(log, /env=\[ANTHROPIC_API_KEY\]/, "a evidência nomeia a var do ambiente cru, sem CLAUDE_CONFIG_DIR");
    assert.match(log, /configDirOverride=true/);
    assert.doesNotMatch(log, /sk-ant-do-env-11887/);
  });

  it("rótulo de authMethod desconhecido: só alerta (WARN no log), os stages sobem", () => {
    const repo = edicaoRepo();
    let spawned = 0;
    const exec = (() => {
      spawned++;
      return "";
    }) as unknown as ExecFn;
    const code = edicaoMain(repo, exec, AAMMDD, () => "/fake/claude", notDone, trusted, () =>
      classifyClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude_ai_v2", apiProvider: "firstParty" })),
    );
    assert.notEqual(code, EXIT_AUTH_NOT_SUBSCRIPTION);
    assert.ok(spawned > 0);
    const log = readFileSync(join(repo, "data", "overnight-schedule.log"), "utf8");
    assert.match(log, /WARN\s+edition=260812 reason=auth-unrecognized-method/);
  });

  it("assinatura: os stages sobem", () => {
    const repo = edicaoRepo();
    let spawned = 0;
    const exec = (() => {
      spawned++;
      return "";
    }) as unknown as ExecFn;
    edicaoMain(repo, exec, AAMMDD, () => "/fake/claude", notDone, trusted, () => sub());
    assert.ok(spawned > 0);
  });
});

describe("diagnose-claude-auth exit (#11887)", () => {
  it("0 só com assinatura nos dois ambientes; bloqueio vence não-verificável", () => {
    const unknown = classifyClaudeAuthStatus("x");
    assert.equal(diagnoseExitCode([sub(), sub()]), 0);
    assert.equal(diagnoseExitCode([sub(), unknown]), 2);
    assert.equal(diagnoseExitCode([api(), unknown]), 1);
  });
});
