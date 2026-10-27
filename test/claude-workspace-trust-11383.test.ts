/**
 * test/claude-workspace-trust-11383.test.ts (#11383)
 *
 * Regressão: sem `projects[<repo>].hasTrustDialogAccepted: true` em
 * `~/.claude.json`, `claude -p` ignora a allowlist de `.claude/settings.json`
 * inteira, e a rodada agendada sai com 0 PRs sem alarme nenhum (#11235). Os
 * runners agora conferem a marca antes de subir o `claude` e saem
 * `EXIT_WORKSPACE_UNTRUSTED`; o da cadeia noturna também lê o stderr da run.
 *
 * Fixtures: `HOME` apontando pra um diretório temporário com um
 * `.claude.json` com e sem a marca. Nada lê o `~/.claude.json` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_WORKSPACE_UNTRUSTED,
  checkWorkspaceTrust,
  claudeGlobalConfigPath,
  stderrSaysWorkspaceUntrusted,
} from "../scripts/lib/claude-workspace-trust.ts";
import {
  DAILY_REVIEW_SCRIPT,
  chainExitCode,
  main as chainMain,
  type NightlyChainDeps,
} from "../scripts/overnight/run-nightly-chain.ts";
import { main as edicaoMain } from "../scripts/overnight/run-scheduled-edicao.ts";

/** Linha real do CLI medida na prova do #11235. */
const CLI_UNTRUSTED_LINE =
  "Ignoring 212 permissions.allow entries from .claude/settings.json: this workspace has not been trusted";

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "trust-11383-repo-")));
  mkdirSync(join(root, "hermes", "scripts"), { recursive: true });
  writeFileSync(join(root, DAILY_REVIEW_SCRIPT), "#!/usr/bin/env bash\nexit 0\n");
  return root;
}

/** HOME fixture com `.claude.json`; `content` null = arquivo ausente. */
function makeHome(content: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "trust-11383-home-"));
  if (content !== null) writeFileSync(join(home, ".claude.json"), content);
  return home;
}

function homeWith(projects: Record<string, unknown>): string {
  return makeHome(JSON.stringify({ numStartups: 3, projects }));
}

describe("checkWorkspaceTrust (#11383)", () => {
  it("com a marca no próprio repo → trusted", () => {
    const repo = makeRepo();
    const home = homeWith({ [repo]: { hasTrustDialogAccepted: true } });
    const r = checkWorkspaceTrust(repo, { env: { HOME: home } });
    assert.equal(r.status, "trusted");
    assert.equal(r.trustedBy, repo);
    assert.equal(r.configPath, join(home, ".claude.json"));
  });

  it("worktree sob o checkout confiável herda a confiança do ancestral", () => {
    const repo = makeRepo();
    const wt = join(repo, ".claude", "worktrees", "agent-x");
    mkdirSync(wt, { recursive: true });
    const home = homeWith({ [repo]: { hasTrustDialogAccepted: true } });
    const r = checkWorkspaceTrust(wt, { env: { HOME: home } });
    assert.equal(r.status, "trusted");
    assert.equal(r.trustedBy, repo);
  });

  it("entrada do repo sem a marca (ou false) → untrusted, nunca trusted", () => {
    const repo = makeRepo();
    for (const entry of [{}, { hasTrustDialogAccepted: false }, { hasTrustDialogAccepted: "true" }]) {
      const r = checkWorkspaceTrust(repo, { env: { HOME: homeWith({ [repo]: entry }) } });
      assert.equal(r.status, "untrusted", JSON.stringify(entry));
      assert.match(r.message, /AUSENTE/);
    }
  });

  it("marca só num diretório IRMÃO não vale (clone fora do checkout confiável, o caso da prova do #11235)", () => {
    const repo = makeRepo();
    const other = makeRepo();
    const r = checkWorkspaceTrust(repo, { env: { HOME: homeWith({ [other]: { hasTrustDialogAccepted: true } }) } });
    assert.equal(r.status, "untrusted");
  });

  it("~/.claude.json ausente, JSON inválido ou sem projects → unreadable, com mensagem distinta de 'sem a marca'", () => {
    const repo = makeRepo();
    const cases: [string | null, RegExp][] = [
      [null, /não existe/],
      ["{ isto não é json", /não é JSON válido/],
      [JSON.stringify({ numStartups: 1 }), /não tem o objeto `projects`/],
      [JSON.stringify(null), /não tem o objeto `projects`/],
    ];
    for (const [content, why] of cases) {
      const r = checkWorkspaceTrust(repo, { env: { HOME: makeHome(content) } });
      assert.equal(r.status, "unreadable", String(content));
      assert.match(r.message, /NÃO VERIFICÁVEL/);
      assert.match(r.message, why);
      assert.doesNotMatch(r.message, /AUSENTE/);
    }
  });

  it("erro de leitura que não é ENOENT também é unreadable (nunca fail-soft pra trusted)", () => {
    const repo = makeRepo();
    const r = checkWorkspaceTrust(repo, {
      env: { HOME: "/x" },
      readFile: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    assert.equal(r.status, "unreadable");
    assert.match(r.message, /ilegível \(EACCES/);
  });

  it("chave com barra normal (formato do Windows) casa com o caminho resolvido", () => {
    const r = checkWorkspaceTrust("/repo/x", {
      env: { HOME: "/h" },
      realpath: (p) => p,
      readFile: () => JSON.stringify({ projects: { "/repo/x": { hasTrustDialogAccepted: true } } }),
    });
    assert.equal(r.status, "trusted");
  });

  it("CLAUDE_CONFIG_DIR vence HOME; HOME injetável", () => {
    assert.equal(claudeGlobalConfigPath({ HOME: "/h" }), join("/h", ".claude.json"));
    assert.equal(claudeGlobalConfigPath({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" }), join("/cfg", ".claude.json"));
  });

  it("stderrSaysWorkspaceUntrusted reconhece a linha real do CLI", () => {
    assert.equal(stderrSaysWorkspaceUntrusted(`algo\n${CLI_UNTRUSTED_LINE}\nmais`), true);
    assert.equal(stderrSaysWorkspaceUntrusted(""), false);
    assert.equal(stderrSaysWorkspaceUntrusted(undefined), false);
    assert.equal(stderrSaysWorkspaceUntrusted("Ignoring 0 hooks"), false);
  });
});

/** Harness da cadeia noturna com o preflight PADRÃO ligado e HOME fixture. */
function chainHarness(home: string, overnightStderr = "", overnightStatus = 0) {
  const calls: string[] = [];
  const logs: string[] = [];
  const env = { HOME: home, PATH: "/usr/bin" };
  const deps: NightlyChainDeps = {
    spawn: ((cmd: string) => {
      calls.push(cmd);
      const isReview = cmd === "bash";
      return {
        pid: 1,
        output: [],
        stdout: "",
        stderr: isReview ? "[daily-review] concluído" : overnightStderr,
        status: isReview ? 0 : overnightStatus,
        signal: null,
      };
    }) as unknown as NightlyChainDeps["spawn"],
    resolveClaudeBin: () => "/opt/claude",
    hasActiveOvernight: () => false,
    env,
    log: (l) => logs.push(l),
    checkWorkspaceTrust: (root, e) => checkWorkspaceTrust(root, { env: e }),
  };
  return { deps, calls, logs };
}

describe("run-nightly-chain: preflight de confiança (#11383)", () => {
  it("sem a marca: o review roda, o overnight NÃO sobe, exit EXIT_WORKSPACE_UNTRUSTED", () => {
    const repo = makeRepo();
    const { deps, calls, logs } = chainHarness(homeWith({ [repo]: { hasTrustDialogAccepted: false } }));
    assert.equal(chainMain(repo, deps), EXIT_WORKSPACE_UNTRUSTED);
    assert.deepEqual(calls, ["bash"], "o claude do overnight não pode subir sem a marca");
    assert.ok(logs.some((l) => /overnight: PULADO — confiança do workspace: AUSENTE/.test(l)), logs.join("\n"));
    assert.ok(logs.some((l) => /overnight=untrusted-workspace exit=6/.test(l)), logs.join("\n"));
  });

  it("~/.claude.json ilegível: mesmo desfecho, mensagem própria", () => {
    const repo = makeRepo();
    const { deps, calls, logs } = chainHarness(makeHome("not json"));
    assert.equal(chainMain(repo, deps), EXIT_WORKSPACE_UNTRUSTED);
    assert.deepEqual(calls, ["bash"]);
    assert.ok(logs.some((l) => /NÃO VERIFICÁVEL/.test(l)), logs.join("\n"));
  });

  it("preflight que lança conta como não confiado", () => {
    const repo = makeRepo();
    const { deps, calls } = chainHarness(makeHome(null));
    deps.checkWorkspaceTrust = () => {
      throw new Error("boom");
    };
    assert.equal(chainMain(repo, deps), EXIT_WORKSPACE_UNTRUSTED);
    assert.deepEqual(calls, ["bash"]);
  });

  it("com a marca: o overnight sobe e o preflight loga ok", () => {
    const repo = makeRepo();
    const { deps, calls, logs } = chainHarness(homeWith({ [repo]: { hasTrustDialogAccepted: true } }));
    chainMain(repo, deps);
    assert.deepEqual(calls, ["bash", "/opt/claude"]);
    assert.ok(logs.some((l) => /confiança do workspace: ok/.test(l)), logs.join("\n"));
  });

  it("com a marca mas o CLI avisa no stderr (exit 0): untrusted-workspace, exit 6", () => {
    const repo = makeRepo();
    const { deps, logs } = chainHarness(homeWith({ [repo]: { hasTrustDialogAccepted: true } }), `${CLI_UNTRUSTED_LINE}\n`, 0);
    assert.equal(chainMain(repo, deps), EXIT_WORKSPACE_UNTRUSTED);
    assert.ok(logs.some((l) => /WORKSPACE NÃO CONFIADO/.test(l)), logs.join("\n"));
  });

  it("chainExitCode: untrusted-workspace vence o review falho", () => {
    assert.equal(chainExitCode("failed", { status: "untrusted-workspace", exitCode: null }), EXIT_WORKSPACE_UNTRUSTED);
  });
});

describe("run-scheduled-edicao: preflight de confiança (#11383)", () => {
  const AAMMDD = "260812";
  const notDone = () => ({ ok: false as const, reason: "sentinel_missing" as const });

  function edicaoRepo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "trust-11383-edicao-")));
    mkdirSync(join(root, "data"), { recursive: true });
    return root;
  }

  it("sem a marca: nenhum stage disparado, exit EXIT_WORKSPACE_UNTRUSTED e linha FAIL no schedule log", () => {
    const repo = edicaoRepo();
    const home = homeWith({ [repo]: {} });
    let spawned = 0;
    const exec = (() => {
      spawned++;
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;
    const code = edicaoMain(repo, exec, AAMMDD, () => "/fake/claude", notDone, (root) =>
      checkWorkspaceTrust(root, { env: { HOME: home } }),
    );
    assert.equal(code, EXIT_WORKSPACE_UNTRUSTED);
    assert.equal(spawned, 0);
    const log = readFileSync(join(repo, "data", "overnight-schedule.log"), "utf8");
    assert.match(log, /FAIL\s+edition=260812 reason=workspace-untrusted exit=6/);
  });

  it("~/.claude.json ausente: reason=workspace-unreadable", () => {
    const repo = edicaoRepo();
    const home = makeHome(null);
    const code = edicaoMain(
      repo,
      (() => "") as unknown as typeof import("node:child_process").execFileSync,
      AAMMDD,
      () => "/fake/claude",
      notDone,
      (root) => checkWorkspaceTrust(root, { env: { HOME: home } }),
    );
    assert.equal(code, EXIT_WORKSPACE_UNTRUSTED);
    const log = readFileSync(join(repo, "data", "overnight-schedule.log"), "utf8");
    assert.match(log, /reason=workspace-unreadable/);
  });

  it("stage falha com a linha do CLI no stderr: exit vira EXIT_WORKSPACE_UNTRUSTED", () => {
    const repo = edicaoRepo();
    const home = homeWith({ [repo]: { hasTrustDialogAccepted: true } });
    const exec = (() => {
      throw Object.assign(new Error("falhou"), { status: 1, stdout: "", stderr: CLI_UNTRUSTED_LINE });
    }) as unknown as typeof import("node:child_process").execFileSync;
    const code = edicaoMain(repo, exec, AAMMDD, () => "/fake/claude", notDone, (root) =>
      checkWorkspaceTrust(root, { env: { HOME: home } }),
    );
    assert.equal(code, EXIT_WORKSPACE_UNTRUSTED);
    const log = readFileSync(join(repo, "data", "overnight-schedule.log"), "utf8");
    assert.match(log, /reason=workspace-untrusted-stderr/);
  });
});
