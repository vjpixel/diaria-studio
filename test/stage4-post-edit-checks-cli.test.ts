/**
 * test/stage4-post-edit-checks-cli.test.ts (#8123 Fatia 3)
 *
 * Testes de CLI (subprocess) do wrapper `scripts/stage4-post-edit-checks.ts`:
 * exit codes, output barato no stdout (nunca despeja findings), relatório
 * completo escrito em `--out`, e o lock de coalescing sendo liberado ao fim
 * de uma rodada normal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readLock } from "../scripts/lib/stage4-check-lock.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "stage4-post-edit-checks.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    encoding: "utf8",
    cwd: PROJECT_ROOT,
  });
}

const INTRO_LINE =
  "Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 7 artigos. Selecionamos os 2 mais relevantes para as pessoas que assinam a newsletter.";

function buildMd(): string {
  return [
    INTRO_LINE,
    "",
    "---",
    "",
    "**DESTAQUE 1 | PRODUTO**",
    "",
    "**[Título de teste](https://example.com/d1)**",
    "",
    "Corpo curto de teste.",
    "",
    "Por que isso importa:",
    "",
    "Impacto direto pequeno.",
    "",
    "---",
    "",
  ].join("\n");
}

function makeEditionDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "stage4-post-edit-checks-cli-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), buildMd(), "utf8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("stage4-post-edit-checks.ts — CLI", () => {
  it("exit 2 quando --edition-dir está ausente", () => {
    const result = runCli([]);
    assert.equal(result.status, 2);
  });

  it("exit 2 quando --edition-dir não existe", () => {
    const result = runCli(["--edition-dir", "/caminho/inexistente/edicao"]);
    assert.equal(result.status, 2);
  });

  it("roda, escreve o relatório em --out, e o stdout é 1 linha barata (nunca despeja findings)", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      const outPath = join(dir, "_internal", "custom-report.json");
      const result = runCli(["--edition-dir", dir, "--out", outPath]);

      assert.ok(existsSync(outPath), "relatório deveria ter sido escrito em --out");
      const report = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(typeof report.inputs_hash, "string");
      assert.equal(report.findings_count, report.findings.length);

      // Notificação barata: stdout é 1 linha (mais o \n final do console.log).
      const stdoutLines = result.stdout.trim().split("\n");
      assert.equal(stdoutLines.length, 1, `esperava 1 linha de stdout, recebeu: ${result.stdout}`);

      // Exit code reflete gate_blocking do relatório.
      assert.equal(result.status, report.gate_blocking ? 1 : 0);
    } finally {
      cleanup();
    }
  });

  it("libera o lock (running:false) ao final de uma rodada normal", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      runCli(["--edition-dir", dir]);
      const lockPath = join(dir, "_internal", ".stage4-post-edit-checks-lock.json");
      assert.ok(existsSync(lockPath), "lock deveria ter sido criado");
      const lock = readLock(lockPath);
      assert.equal(lock.running, false);
      assert.equal(lock.generation, 1);
    } finally {
      cleanup();
    }
  });

  it("default de --out é {edition-dir}/_internal/stage4-post-edit-checks.json", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      runCli(["--edition-dir", dir]);
      const defaultOutPath = join(dir, "_internal", "stage4-post-edit-checks.json");
      assert.ok(existsSync(defaultOutPath));
    } finally {
      cleanup();
    }
  });

  it("--check-lock: exit 0 e running:false quando nenhuma rodada rodou ainda (lock ausente) — #8123 review", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      const result = runCli(["--edition-dir", dir, "--check-lock"]);
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout.trim());
      assert.equal(parsed.running, false);
      assert.equal(parsed.generation, 0);
    } finally {
      cleanup();
    }
  });

  it("--check-lock: exit 0 e running:false depois de uma rodada normal (lock liberado) — #8123 review", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      runCli(["--edition-dir", dir]); // rodada completa, libera o lock ao final
      const result = runCli(["--edition-dir", dir, "--check-lock"]);
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout.trim());
      assert.equal(parsed.running, false);
      assert.equal(parsed.generation, 1);
    } finally {
      cleanup();
    }
  });

  it("--check-lock nunca escreve o relatório --out (é só leitura do lock) — #8123 review", () => {
    const { dir, cleanup } = makeEditionDir();
    try {
      const defaultOutPath = join(dir, "_internal", "stage4-post-edit-checks.json");
      runCli(["--edition-dir", dir, "--check-lock"]);
      assert.ok(!existsSync(defaultOutPath), "--check-lock não deveria disparar uma rodada de checks");
    } finally {
      cleanup();
    }
  });
});
