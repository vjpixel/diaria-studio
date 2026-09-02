/**
 * test/issue-triage-fetch.test.ts (#7018)
 *
 * Cobre `scripts/lib/issue-triage-fetch.ts` + o CLI fino
 * `scripts/fetch-open-issues-for-triage.ts`. Mesma técnica de `gh` fake
 * (binário `node` disfarçado, sem `shell: true`) de
 * `test/check-overnight-fila-convergence-gate.test.ts` — reproduzível em
 * Windows/POSIX sem depender de rede.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, chmodSync } from "node:fs";
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

function setupFakeGh(ghResponse: { stdout?: string; exitCode?: number }): { env: NodeJS.ProcessEnv } {
  root = mkdtempSync(join(tmpdir(), "issue-triage-fetch-gh-"));
  const ghDir = join(root, "bin");
  mkdirSync(ghDir);
  const ghBinName = process.platform === "win32" ? "gh.exe" : "gh";
  const ghBinPath = join(ghDir, ghBinName);
  copyFileSync(process.execPath, ghBinPath);
  if (process.platform !== "win32") chmodSync(ghBinPath, 0o755);

  const preloadPath = join(ghDir, "gh-fake-preload.cjs");
  writeFileSync(
    preloadPath,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "if (process.argv[1] && path.basename(process.argv[1]) === 'issue') {",
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
    env: {
      ...process.env,
      PATH: ghDir,
      Path: ghDir,
      NODE_OPTIONS: `--require ${preloadPath}`,
      GH_FAKE_RESPONSE_FILE: respPath,
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
});
