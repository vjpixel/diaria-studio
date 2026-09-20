/**
 * test/block-pr-create-test-runner-import.test.ts (#8526)
 *
 * Teste de regressão (#633) do hook
 * `.claude/hooks/block-pr-create-test-runner-import.mjs` — a camada rápida
 * pre-`gh pr create` que move a detecção de `test/test-runner-import-guard.test.ts`
 * (#7807) de "descoberta só depois de a PR abrir" pra "bloqueada antes de
 * existir".
 *
 * Cobre os 3 cenários do critério de aceite da #8526:
 *   1. arquivo com `vitest` → bloqueia;
 *   2. arquivo correto com `node:test` → passa;
 *   3. branch sem arquivo de teste novo (nenhuma violação em test/) → passa.
 *
 * `runTestRunnerImportCheck` roda contra um diretório `test/` FIXTURE (nunca
 * o `test/` real deste repo — isolamento, mesmo padrão do resto da suíte) e
 * aceita o módulo de checagem injetado, então este teste nunca dispara um
 * `import()` dinâmico de verdade.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  runTestRunnerImportCheck,
  buildTestRunnerImportDenyMessage,
} from "../.claude/hooks/block-pr-create-test-runner-import.mjs";
import { checkTestRunnerImports } from "../scripts/lib/test-runner-import-guard.ts";

const fakeImportGuardModule = { checkTestRunnerImports };

function withFixtureRepo<T>(files: Record<string, string>, fn: (repoRoot: string) => T | Promise<T>): T | Promise<T> {
  const repoRoot = mkdtempSync(join(tmpdir(), "test-runner-import-guard-hook-"));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(repoRoot, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
    }
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe("runTestRunnerImportCheck (#8526)", () => {
  it("branch sem test/ (repo sem diretório de teste) → fail-open, null", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "test-runner-import-guard-hook-empty-"));
    try {
      const result = await runTestRunnerImportCheck(repoRoot, fakeImportGuardModule);
      assert.equal(result, null);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("arquivo com vitest → detecta violação (bloquearia)", async () => {
    await withFixtureRepo(
      { "test/bad.test.ts": 'import { describe, it, expect } from "vitest";\n\ndescribe("x", () => {});\n' },
      async (repoRoot) => {
        const result = await runTestRunnerImportCheck(repoRoot, fakeImportGuardModule);
        assert.deepEqual(result.runnerProibido, ["test/bad.test.ts → vitest"]);
        // O mesmo arquivo também usa describe() sem importar de node:test —
        // esperado: importar de vitest não conta como "importar de node:test".
        assert.deepEqual(result.importAusenteNodeTest, ["test/bad.test.ts"]);
      },
    );
  });

  it("arquivo correto com node:test → nenhuma violação (passaria)", async () => {
    await withFixtureRepo(
      {
        "test/good.test.ts":
          'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\n\n' +
          'describe("x", () => { it("y", () => { assert.ok(true); }); });\n',
      },
      async (repoRoot) => {
        const result = await runTestRunnerImportCheck(repoRoot, fakeImportGuardModule);
        assert.deepEqual(result.runnerProibido, []);
        assert.deepEqual(result.importAusenteNodeTest, []);
      },
    );
  });

  it("branch sem arquivo de teste novo (test/ existe, mas todos limpos) → nenhuma violação", async () => {
    await withFixtureRepo(
      {
        "test/existing.test.ts":
          'import { describe, it } from "node:test";\n\ndescribe("x", () => {});\n',
      },
      async (repoRoot) => {
        const result = await runTestRunnerImportCheck(repoRoot, fakeImportGuardModule);
        assert.deepEqual(result.runnerProibido, []);
        assert.deepEqual(result.importAusenteNodeTest, []);
      },
    );
  });

  it("describe()/it() sem import de node:test → detecta violação (caso PR #7771)", async () => {
    await withFixtureRepo(
      { "test/missing-import.test.ts": 'describe("x", () => { it("y", () => {}); });\n' },
      async (repoRoot) => {
        const result = await runTestRunnerImportCheck(repoRoot, fakeImportGuardModule);
        assert.deepEqual(result.runnerProibido, []);
        assert.deepEqual(result.importAusenteNodeTest, ["test/missing-import.test.ts"]);
      },
    );
  });
});

describe("buildTestRunnerImportDenyMessage (#8526)", () => {
  it("nomeia o arquivo e o runner proibido na mensagem", () => {
    const msg = buildTestRunnerImportDenyMessage({
      runnerProibido: ["test/8507-alarm-dedup.test.ts → vitest"],
      importAusenteNodeTest: [],
    });
    assert.match(msg, /test\/8507-alarm-dedup\.test\.ts → vitest/);
    assert.match(msg, /node:test/);
  });

  it("nomeia o arquivo com describe\\(\\)\\/it\\(\\) sem import de node:test", () => {
    const msg = buildTestRunnerImportDenyMessage({
      runnerProibido: [],
      importAusenteNodeTest: ["test/clarice-novos-html-state-4347.test.ts"],
    });
    assert.match(msg, /test\/clarice-novos-html-state-4347\.test\.ts/);
    assert.match(msg, /describe\(\)\/it\(\)/);
  });
});
