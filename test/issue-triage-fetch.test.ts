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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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

function setupFakeGh(ghResponse: { stdout?: string; exitCode?: number }): { env: NodeJS.ProcessEnv; argvFile: string } {
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
      "  const respPath = process.env.GH_FAKE_RESPONSE_FILE;",
      "  if (respPath) process.stdout.write(fs.readFileSync(respPath, 'utf8'));",
      "  process.exit(Number(process.env.GH_FAKE_EXIT_CODE || 0));",
      "}",
    ].join("\n"),
    "utf8",
  );
  const respPath = join(ghDir, "gh-fake-response.json");
  writeFileSync(respPath, ghResponse.stdout ?? "[]", "utf8");

  return {
    argvFile,
    env: {
      ...process.env,
      PATH: ghDir,
      Path: ghDir,
      NODE_OPTIONS: `--require ${preloadPath}`,
      GH_FAKE_RESPONSE_FILE: respPath,
      GH_FAKE_ARGV_FILE: argvFile,
      GH_FAKE_EXIT_CODE: String(ghResponse.exitCode ?? 0),
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

  it("--since ausente e vazio (--since=) → erro claro, nunca --search vazio silencioso", () => {
    const { env } = setupFakeGh({ stdout: "[]" });
    const r = run(["--since="], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /valor vazio/);
  });
});
