/**
 * test/issue-triage-fetch.test.ts (#7018 itens 2 e 3)
 *
 * Cobre `scripts/lib/issue-triage-fetch.ts` + o CLI fino
 * `scripts/fetch-open-issues-for-triage.ts`. Mesma técnica de `gh` fake
 * (binário `node` disfarçado, sem `shell: true`) de
 * `test/check-overnight-fila-convergence-gate.test.ts` — reproduzível em
 * Windows/POSIX sem depender de rede.
 *
 * O fake também grava o argv recebido por `gh` num arquivo (`argvFile`,
 * retornado por `setupFakeGh`) — usado pelos testes de `--since` (item 3)
 * pra confirmar que `--search "updated:>=..."` só entra na chamada quando
 * `--since` é passado, e que a chamada sem `--since` (overnight/develop)
 * continua idêntica ao comportamento pré-item-3.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { fetchOpenIssuesForTriage, resolveTriageRepos } from "../scripts/lib/issue-triage-fetch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "scripts/fetch-open-issues-for-triage.ts");

let root: string | null = null;
afterEach(() => {
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.warn(`[issue-triage-fetch.test] cleanup residual de ${root}: ${(e as Error).message}`);
    }
    root = null;
  }
});

/**
 * #10618 — com `--repos`, o CLI varre também os repos extras de
 * `issue_repos`. Toda chamada leva `-R owner/repo` (inclusive a do default);
 * o fake responde `stdout`/`exitCode` para `-R vjpixel/diaria-studio` e
 * `foreignStdout`/`foreignExitCode` (default `[]`/0) para qualquer outro
 * `-R`. `argvLog` acumula o argv de CADA chamada (uma linha JSON por chamada).
 */
function setupFakeGh(ghResponse: {
  stdout?: string;
  exitCode?: number;
  foreignStdout?: string;
  foreignExitCode?: number;
}): { env: NodeJS.ProcessEnv; argvFile: string; argvLog: string } {
  root = mkdtempSync(join(tmpdir(), "issue-triage-fetch-gh-"));
  const ghDir = join(root, "bin");
  mkdirSync(ghDir);
  const ghBinName = process.platform === "win32" ? "gh.exe" : "gh";
  const ghBinPath = join(ghDir, ghBinName);
  copyFileSync(process.execPath, ghBinPath);
  if (process.platform !== "win32") chmodSync(ghBinPath, 0o755);

  const argvFile = join(ghDir, "gh-fake-argv.json");
  const preloadPath = join(ghDir, "gh-fake-preload.cjs");
  writeFileSync(
    preloadPath,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "if (process.argv[1] && path.basename(process.argv[1]) === 'issue') {",
      // Grava os argumentos recebidos (#7018 item 3) pra o teste assertar
      // qual comando `gh` de fato recebeu — ex: se `--search` foi incluído
      // quando `since` é passado, e omitido quando não é.
      "  const argvOutPath = process.env.GH_FAKE_ARGV_FILE;",
      "  if (argvOutPath) fs.writeFileSync(argvOutPath, JSON.stringify(process.argv.slice(1)), 'utf8');",
      "  const argvLogPath = process.env.GH_FAKE_ARGV_LOG;",
      "  if (argvLogPath) fs.appendFileSync(argvLogPath, JSON.stringify(process.argv.slice(1)) + '\\n', 'utf8');",
      "  const rIdx = process.argv.indexOf('-R');",
      "  const foreign = rIdx !== -1 && process.argv[rIdx + 1] !== 'vjpixel/diaria-studio';",
      "  const respPath = foreign ? process.env.GH_FAKE_FOREIGN_RESPONSE_FILE : process.env.GH_FAKE_RESPONSE_FILE;",
      "  if (respPath) process.stdout.write(fs.readFileSync(respPath, 'utf8'));",
      "  process.exit(Number((foreign ? process.env.GH_FAKE_FOREIGN_EXIT_CODE : process.env.GH_FAKE_EXIT_CODE) || 0));",
      "}",
    ].join("\n"),
    "utf8",
  );
  const respPath = join(ghDir, "gh-fake-response.json");
  writeFileSync(respPath, ghResponse.stdout ?? "[]", "utf8");
  const foreignRespPath = join(ghDir, "gh-fake-foreign-response.json");
  writeFileSync(foreignRespPath, ghResponse.foreignStdout ?? "[]", "utf8");
  const argvLog = join(ghDir, "gh-fake-argv.log");

  return {
    argvFile,
    argvLog,
    env: {
      ...process.env,
      PATH: ghDir,
      Path: ghDir,
      NODE_OPTIONS: `--require ${preloadPath}`,
      GH_FAKE_RESPONSE_FILE: respPath,
      GH_FAKE_ARGV_FILE: argvFile,
      GH_FAKE_EXIT_CODE: String(ghResponse.exitCode ?? 0),
      GH_FAKE_FOREIGN_RESPONSE_FILE: foreignRespPath,
      GH_FAKE_FOREIGN_EXIT_CODE: String(ghResponse.foreignExitCode ?? 0),
      GH_FAKE_ARGV_LOG: argvLog,
    },
  };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env,
  });
}

describe("fetch-open-issues-for-triage CLI (#7018)", () => {
  it("gh (fake) devolve issue com body → classificada e impressa em JSON", () => {
    const { env } = setupFakeGh({
      stdout: JSON.stringify([
        {
          number: 6621,
          title: "algo agendado",
          labels: [{ name: "bug" }],
          body: "<!-- aguardando-ate: 2099-01-01 -->",
          url: "https://github.com/x/y/issues/6621",
          updatedAt: "2026-08-29T00:00:00Z",
          state: "OPEN",
        },
      ]),
    });
    const r = run([], env);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].number, 6621);
    assert.equal(parsed[0].execTrack, "agendada");
  });

  it("REGRESSÃO #7018: gh (fake) devolve item SEM a chave 'body' → exit 1, nunca sucesso silencioso", () => {
    const { env } = setupFakeGh({
      stdout: JSON.stringify([
        {
          number: 6621,
          title: "algo agendado",
          labels: [{ name: "bug" }],
          // sem "body" — simula --json sem 'body' na lista de campos
          url: "https://github.com/x/y/issues/6621",
          updatedAt: "2026-08-29T00:00:00Z",
          state: "OPEN",
        },
      ]),
    });
    const r = run([], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /sem a chave "body"/);
    assert.equal(r.stdout.trim(), "");
  });

  it("gh (fake) sem issues → array vazio, exit 0", () => {
    const { env } = setupFakeGh({ stdout: "[]" });
    const r = run([], env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), []);
  });

  it("gh (fake) falha (exit != 0) → fail-soft, exit 1 com mensagem no stderr", () => {
    const { env } = setupFakeGh({ stdout: "", exitCode: 1 });
    const r = run([], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gh issue list saiu com status/);
  });

  it("--bugs filtra pra só label 'bug'", () => {
    const { env } = setupFakeGh({
      stdout: JSON.stringify([
        { number: 1, title: "a", labels: [{ name: "bug" }], body: "", url: "", updatedAt: null, state: "OPEN" },
        { number: 2, title: "b", labels: [{ name: "enhancement" }], body: "", url: "", updatedAt: null, state: "OPEN" },
      ]),
    });
    const r = run(["--bugs"], env);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].number, 1);
  });

  // #7018 item 3 — caminho fail-closed do `/diaria-continuo`: varredura
  // incremental (`--since`), sem forçar o full-scan caro de overnight/develop.
  it("sem --since (regressão): chama 'gh issue list' SEM --search — comportamento antigo intacto", () => {
    const { env, argvFile } = setupFakeGh({ stdout: "[]" });
    const r = run([], env);
    assert.equal(r.status, 0, r.stderr);
    const calledArgv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    assert.ok(!calledArgv.includes("--search"), `esperava sem --search, recebeu ${JSON.stringify(calledArgv)}`);
  });

  it("--since 2026-08-29T10:00:00Z → chama 'gh issue list' com --search \"updated:>=...\"", () => {
    const { env, argvFile } = setupFakeGh({ stdout: "[]" });
    const r = run(["--since", "2026-08-29T10:00:00Z"], env);
    assert.equal(r.status, 0, r.stderr);
    const calledArgv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    const searchIdx = calledArgv.indexOf("--search");
    assert.ok(searchIdx !== -1, `esperava --search no argv, recebeu ${JSON.stringify(calledArgv)}`);
    assert.equal(calledArgv[searchIdx + 1], "updated:>=2026-08-29T10:00:00Z");
  });

  it("REGRESSÃO #7018 (incremental): --since com item SEM 'body' → exit 1, nunca degrada pro track mais permissivo", () => {
    const { env } = setupFakeGh({
      stdout: JSON.stringify([
        {
          number: 6771,
          title: "algo agendado, achado só no delta incremental",
          labels: [{ name: "bug" }],
          // sem "body" — mesmo bug do #7018, agora no --search incremental
          url: "https://github.com/x/y/issues/6771",
          updatedAt: "2026-09-01T00:00:00Z",
          state: "OPEN",
        },
      ]),
    });
    const r = run(["--since", "2026-08-29T00:00:00Z"], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /sem a chave "body"/);
    assert.equal(r.stdout.trim(), "");
  });

  // #10618 (fatia 2) — fila multi-repo, OPT-IN.
  const item = (number: number) => ({
    number,
    title: `t${number}`,
    labels: [{ name: "P2" }],
    body: "",
    url: "",
    updatedAt: null,
    state: "OPEN",
  });
  const readCalls = (argvLog: string) =>
    readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  const repoOf = (call: string[]) => call[call.indexOf("-R") + 1];

  it("#10618: SEM --repos varre SÓ o studio (default opt-in) — uma chamada, com -R vjpixel/diaria-studio", () => {
    const { env, argvLog } = setupFakeGh({
      stdout: JSON.stringify([item(21)]),
      foreignStdout: JSON.stringify([item(21)]),
    });
    const r = run([], env);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(parsed.map((i: { ref: string }) => i.ref), ["vjpixel/diaria-studio#21"]);
    const calls = readCalls(argvLog);
    assert.equal(calls.length, 1, `esperava 1 chamada, recebeu ${JSON.stringify(calls)}`);
    // #10618 item 3: o default vai com -R explícito, nunca pelo cwd.
    assert.equal(repoOf(calls[0]!), "vjpixel/diaria-studio");
  });

  it("#10618: --repos all varre o studio E o diaria-design, cada item com repo/ref", () => {
    const { env, argvLog } = setupFakeGh({
      stdout: JSON.stringify([item(21)]),
      foreignStdout: JSON.stringify([item(21)]),
    });
    const r = run(["--repos", "all"], env);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    // O #21 existe nos dois repos — nunca colapsa nem confunde.
    assert.deepEqual(
      parsed.map((i: { ref: string; repo: string; number: number }) => [i.ref, i.repo, i.number]),
      [
        ["vjpixel/diaria-studio#21", "vjpixel/diaria-studio", 21],
        ["vjpixel/diaria-design#21", "vjpixel/diaria-design", 21],
      ],
    );
    const calls = readCalls(argvLog);
    assert.deepEqual(calls.map(repoOf), ["vjpixel/diaria-studio", "vjpixel/diaria-design"]);
  });

  it("#10618: --repos all --since → as DUAS chamadas levam o mesmo --search", () => {
    const { env, argvLog } = setupFakeGh({ stdout: "[]" });
    const r = run(["--repos", "all", "--since", "2026-10-20T10:00:00Z"], env);
    assert.equal(r.status, 0, r.stderr);
    const calls = readCalls(argvLog);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      const i = c.indexOf("--search");
      assert.ok(i !== -1, `chamada sem --search: ${JSON.stringify(c)}`);
      assert.equal(c[i + 1], "updated:>=2026-10-20T10:00:00Z");
    }
  });

  it("#10618: falha do repo EXTRA → exit 3 (parcial), lista do studio no stdout e aviso no stderr", () => {
    const { env } = setupFakeGh({
      stdout: JSON.stringify([item(7)]),
      foreignStdout: "",
      foreignExitCode: 1,
    });
    const r = run(["--repos", "all"], env);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /AVISO — issues de vjpixel\/diaria-design NÃO entraram/);
    assert.match(r.stderr, /PARCIAL/);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(parsed.map((i: { ref: string }) => i.ref), ["vjpixel/diaria-studio#7"]);
  });

  it("#10618: falha do repo DEFAULT continua exit 1 mesmo com --repos all", () => {
    const { env } = setupFakeGh({ stdout: "", exitCode: 1, foreignStdout: JSON.stringify([item(3)]) });
    const r = run(["--repos", "all"], env);
    assert.equal(r.status, 1);
    assert.equal(r.stdout.trim(), "");
  });

  it("#10618: --repos vjpixel/diaria-studio = uma chamada só", () => {
    const { env, argvLog } = setupFakeGh({ stdout: "[]" });
    const r = run(["--repos", "vjpixel/diaria-studio"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readCalls(argvLog).length, 1);
  });

  it("#10618: --repos com slug ilegível ou fora de issue_repos → exit 1 antes de qualquer gh", () => {
    const { env, argvLog } = setupFakeGh({ stdout: "[]" });
    for (const bad of ["nao-e-slug", "fork/diaria-design"]) {
      const r = run(["--repos", bad], env);
      assert.equal(r.status, 1, `${bad}: ${r.stderr}`);
      assert.match(r.stderr, /--repos/);
      assert.ok(!existsSync(argvLog), `${bad}: gh não devia ter sido chamado`);
    }
  });

  it("--since ausente e vazio (--since=) → erro claro, nunca --search vazio silencioso", () => {
    const { env } = setupFakeGh({ stdout: "[]" });
    const r = run(["--since="], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /valor vazio/);
  });
});

describe("resolveTriageRepos (#10618)", () => {
  const ALLOW = ["vjpixel/diaria-studio", "vjpixel/diaria-design"];
  it("ausente/vazio = só o default (undefined); all = allowlist inteira", () => {
    assert.deepEqual(resolveTriageRepos(undefined, ALLOW), { repos: undefined });
    assert.deepEqual(resolveTriageRepos("  ", ALLOW), { repos: undefined });
    assert.deepEqual(resolveTriageRepos("all", ALLOW), { repos: ALLOW });
  });
  it("lista: normaliza e valida contra a allowlist; ilegível/fora erra alto", () => {
    assert.deepEqual(resolveTriageRepos("VJPIXEL/diaria-design", ALLOW), { repos: ["vjpixel/diaria-design"] });
    assert.match((resolveTriageRepos("lixo", ALLOW) as { error: string }).error, /ilegível/);
    assert.match((resolveTriageRepos("fork/diaria-design", ALLOW) as { error: string }).error, /issue_repos/);
  });
  it("fetchOpenIssuesForTriage com repo ilegível na lista → error fatal, nunca varredura menor", () => {
    assert.match(fetchOpenIssuesForTriage(ROOT, { repos: ["nao e slug"] }).error ?? "", /ilegível/);
  });
});

describe("fetchOpenIssuesForTriage includeDefault=false (#10935)", () => {
  const FAKE_KEYS = [
    "PATH", "Path", "NODE_OPTIONS", "GH_FAKE_RESPONSE_FILE", "GH_FAKE_ARGV_FILE", "GH_FAKE_EXIT_CODE",
    "GH_FAKE_FOREIGN_RESPONSE_FILE", "GH_FAKE_FOREIGN_EXIT_CODE", "GH_FAKE_ARGV_LOG",
  ];
  // O módulo chama `spawnSync("gh")` com o env do processo: troca o env só
  // durante a chamada, pro fake da `setupFakeGh` responder.
  function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
    const prev = Object.fromEntries(FAKE_KEYS.map((k) => [k, process.env[k]]));
    for (const k of FAKE_KEYS) process.env[k] = env[k];
    try {
      return fn();
    } finally {
      for (const k of FAKE_KEYS) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }
  const designItem = { number: 21, title: "t", labels: [], body: "corpo", url: "", updatedAt: null, state: "OPEN" };
  const DESIGN_ONLY = { repos: ["vjpixel/diaria-design"], includeDefault: false } as const;

  it("só o repo pedido é varrido; o studio fora do ar não derruba o design", () => {
    const { env, argvLog } = setupFakeGh({ stdout: "", exitCode: 1, foreignStdout: JSON.stringify([designItem]) });
    const r = withEnv(env, () => fetchOpenIssuesForTriage(ROOT, DESIGN_ONLY));
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.issues.map((i) => [i.repo, i.number]), [["vjpixel/diaria-design", 21]]);
    const calls = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("-R") + 1], "vjpixel/diaria-design");
  });

  it("todos os repos pedidos falham → error (nunca lista vazia como se não houvesse issue)", () => {
    const { env } = setupFakeGh({ stdout: "[]", foreignStdout: "", foreignExitCode: 1 });
    const r = withEnv(env, () => fetchOpenIssuesForTriage(ROOT, DESIGN_ONLY));
    assert.match(r.error ?? "", /vjpixel\/diaria-design/);
  });

  it("includeDefault ausente: falha do studio segue fatal (comportamento de sempre)", () => {
    const { env } = setupFakeGh({ stdout: "", exitCode: 1, foreignStdout: JSON.stringify([designItem]) });
    const r = withEnv(env, () => fetchOpenIssuesForTriage(ROOT, { repos: ["vjpixel/diaria-design"] }));
    assert.ok(r.error);
  });
});
