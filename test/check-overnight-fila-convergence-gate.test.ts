/**
 * test/check-overnight-fila-convergence-gate.test.ts (#6435)
 *
 * Cobre o cenário real que motivou a issue: a rodada overnight 260827b
 * declarou "fila esgotada" sem rodar o re-scan de convergência da Fase 1
 * passo 1, perdendo a issue #6431 (criada depois da varredura inicial) até
 * o editor perguntar diretamente. Este gate mecânico existe pra fechar essa
 * lacuna — testado ponta-a-ponta via CLI real (mesma técnica de `gh` fake
 * de `test/state-changed-tracker.test.ts`), sem depender de rede.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "scripts/check-overnight-fila-convergence-gate.ts");

let root: string | null = null;
afterEach(() => {
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.warn(`[check-overnight-fila-convergence-gate.test] cleanup residual de ${root}: ${(e as Error).message}`);
    }
    root = null;
  }
});

function writePlanFixture(plan: Record<string, unknown>): string {
  root = mkdtempSync(join(tmpdir(), "overnight-convergence-gate-"));
  const planPath = join(root, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
  return planPath;
}

/** Mesma técnica de `gh` fake de `test/state-changed-tracker.test.ts` —
 * cópia do binário `node` disfarçada de `gh`, com um preload que responde
 * ao invocar `gh issue list ...`, sem depender de `shell: true`
 * (comportamento consistente entre Windows/POSIX, ver docstring de lá). */
function setupFakeGh(ghResponse: { stdout?: string; exitCode?: number }): {
  planPath: string;
  env: NodeJS.ProcessEnv;
} {
  root = mkdtempSync(join(tmpdir(), "overnight-convergence-gate-gh-"));
  const planPath = join(root, "plan.json");
  writeFileSync(planPath, JSON.stringify({ goal: { target_set: [] } }, null, 2), "utf8");

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
    planPath,
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

function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env,
  });
}

describe("check-overnight-fila-convergence-gate CLI (#6435)", () => {
  it("sem --plan → uso + exit 2", () => {
    const r = run([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /uso: --plan/);
  });

  it("plan.json ausente → erro acionável, exit 2", () => {
    root = mkdtempSync(join(tmpdir(), "overnight-convergence-gate-"));
    const missing = join(root, "plan.json");
    const r = run(["--plan", missing]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /plan\.json não encontrado/);
  });

  it("cenário real #6435: gh (fake) acha issue nova fora do plano → exit 1, issue nomeada", () => {
    const { planPath, env } = setupFakeGh({
      stdout: JSON.stringify([{ number: 6431, labels: [{ name: "bug" }], body: null }]),
    });
    const r = run(["--plan", planPath], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /#6431/);
    assert.match(r.stderr, /classifique/);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(written.goal.last_convergence_scan.novas_encontradas, 1);
  });

  it("gh (fake) sem novidade → exit 0, convergência confirmada, grava last_convergence_scan", () => {
    const { planPath, env } = setupFakeGh({ stdout: "[]" });
    const r = run(["--plan", planPath], env);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /convergência confirmada/);
    const written = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(written.goal.last_convergence_scan.novas_encontradas, 0);
  });

  it("issue nova já conhecida (goal.target_set) não dispara achado", () => {
    const planPath = writePlanFixture({ goal: { target_set: [6431] } });
    const { env } = setupFakeGh({
      stdout: JSON.stringify([{ number: 6431, labels: [{ name: "bug" }], body: null }]),
    });
    const r = run(["--plan", planPath], env);
    assert.equal(r.status, 0);
  });

  it("gh indisponível (PATH quebrado) → fail-soft, exit 0, mas avisa que NÃO foi verificado (#738)", () => {
    const planPath = writePlanFixture({ goal: { target_set: [] } });
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "--plan", planPath], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, PATH: "", Path: "" },
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /gh indisponível/);
    assert.match(r.stdout, /não verificado/i);
    // Nunca reivindicar convergência confirmada sem ter checado de verdade.
    assert.doesNotMatch(r.stdout, /convergência confirmada/);
  });
});
