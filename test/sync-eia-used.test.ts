/**
 * Tests for scripts/sync-eia-used.ts (#865 — JSON shape consistente).
 *
 * Bug original: o campo `dry_run` era populado via `dryRun || undefined`,
 * que omitia o campo do JSON output quando `dryRun === false`. Shape variável
 * quebrava parsing downstream que usava `result.dry_run` direto.
 *
 * Fix: emitir `dry_run: dryRun` (boolean explícito sempre presente).
 *
 * Este teste roda o script via CLI nos dois modos (com e sem `--dry-run`)
 * e valida que o set de keys do JSON output é idêntico — `dry_run` sempre
 * presente, valor diferente.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { NPX, isWindows } from "./_helpers/spawn-npx.ts";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  cpSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("sync-eia-used.ts — JSON shape (#865)", () => {
  let sandboxRoot: string;

  before(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "sync-eia-"));
    cpSync(resolve(ROOT, "scripts"), join(sandboxRoot, "scripts"), {
      recursive: true,
    });
    cpSync(resolve(ROOT, "package.json"), join(sandboxRoot, "package.json"));
    cpSync(resolve(ROOT, "tsconfig.json"), join(sandboxRoot, "tsconfig.json"));
    if (existsSync(resolve(ROOT, "node_modules"))) {
      try {
        symlinkSync(
          resolve(ROOT, "node_modules"),
          join(sandboxRoot, "node_modules"),
          isWindows ? "junction" : "dir",
        );
      } catch {
        cpSync(resolve(ROOT, "node_modules"), join(sandboxRoot, "node_modules"), {
          recursive: true,
        });
      }
    }
    mkdirSync(join(sandboxRoot, "data"), { recursive: true });
    mkdirSync(join(sandboxRoot, "data/editions"), { recursive: true });
    // Edição vazia (sem _internal/01-eia-meta.json) — não vai adicionar nada.
    // Garante saída JSON com `scanned: 0, added: 0, ...` em ambos os modos.
  });

  after(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  function runScript(extraArgs: string[]): unknown {
    const out = execFileSync(
      NPX,
      ["tsx", "scripts/sync-eia-used.ts", "--editions-dir", "data/editions/", ...extraArgs],
      { cwd: sandboxRoot, stdio: "pipe", shell: isWindows },
    ).toString();
    return JSON.parse(out.trim().split("\n").pop() ?? "{}");
  }

  it("dry_run=true: JSON inclui dry_run: true", () => {
    const result = runScript(["--dry-run"]) as Record<string, unknown>;
    assert.equal(result.dry_run, true, "dry_run deve ser true em --dry-run mode");
    assert.ok("dry_run" in result, "campo dry_run deve estar presente");
  });

  it("dry_run=false: JSON inclui dry_run: false (NÃO omite)", () => {
    const result = runScript([]) as Record<string, unknown>;
    assert.equal(result.dry_run, false, "dry_run deve ser false em modo normal");
    assert.ok("dry_run" in result, "campo dry_run NÃO pode ser omitido (#865)");
  });

  it("set de keys é idêntico em ambos os modos (shape estável)", () => {
    const dry = runScript(["--dry-run"]) as Record<string, unknown>;
    const wet = runScript([]) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(dry).sort(),
      Object.keys(wet).sort(),
      "JSON output deve ter o mesmo shape (set de keys) em dry-run e modo normal",
    );
  });
});
