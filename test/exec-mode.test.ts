/**
 * exec-mode.test.ts (#2643)
 *
 * Testa `detectExecMode` com fs mockado — não depende do ambiente real nem da
 * presença do junction `data/`. Cobre:
 *   - `data/` existe e é diretório → `'local'`
 *   - `data/` não existe (ENOENT) → `'cloud'`
 *   - `data/` existe mas não é diretório (arquivo regular) → `'cloud'`
 *   - statFn lança erro genérico (EACCES) → `'cloud'` (fail-safe)
 *
 * Também testa a regra de classificação de issues:
 *   - issue com label `local` + modo cloud → skip com motivo `requer-sessao-local`
 *   - issue com label `local` + modo local → elegível normalmente
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectExecMode, type ExecMode } from "../scripts/lib/exec-mode.ts";

// ---------------------------------------------------------------------------
// Helpers de mock
// ---------------------------------------------------------------------------

function makeStatFn(isDir: boolean): (path: string) => { isDirectory(): boolean } {
  return (_path: string) => ({ isDirectory: () => isDir });
}

function makeThrowingStatFn(code?: string): (path: string) => { isDirectory(): boolean } {
  return (_path: string) => {
    const err = new Error(`mock error${code ? ` [${code}]` : ""}`);
    (err as NodeJS.ErrnoException).code = code;
    throw err;
  };
}

// ---------------------------------------------------------------------------
// Testes do helper detectExecMode
// ---------------------------------------------------------------------------

describe("detectExecMode", () => {
  it("retorna 'local' quando data/ existe e é diretório", () => {
    const result = detectExecMode({
      statFn: makeStatFn(true),
      projectRoot: "/fake/project",
    });
    assert.equal(result, "local");
  });

  it("retorna 'cloud' quando data/ não existe (ENOENT)", () => {
    const result = detectExecMode({
      statFn: makeThrowingStatFn("ENOENT"),
      projectRoot: "/fake/project",
    });
    assert.equal(result, "cloud");
  });

  it("retorna 'cloud' quando data/ existe mas não é diretório (arquivo)", () => {
    const result = detectExecMode({
      statFn: makeStatFn(false),
      projectRoot: "/fake/project",
    });
    assert.equal(result, "cloud");
  });

  it("retorna 'cloud' quando statFn lança erro genérico (EACCES)", () => {
    const result = detectExecMode({
      statFn: makeThrowingStatFn("EACCES"),
      projectRoot: "/fake/project",
    });
    assert.equal(result, "cloud");
  });

  it("usa process.cwd() e statSync real quando opções são omitidas — não quebra", () => {
    // Apenas verifica que não lança exceção; o valor depende do ambiente real.
    const result = detectExecMode();
    assert.ok(result === "local" || result === "cloud");
  });
});

// ---------------------------------------------------------------------------
// Testes da regra de classificação (overnight/develop Fase 0 passo 4)
// ---------------------------------------------------------------------------

/**
 * Simula a lógica de classificação de issues da Fase 0 do /diaria-overnight:
 *   - Se a issue tem label `local` E o modo é `cloud` → `requer-sessao-local`
 *   - Se a issue tem label `local` E o modo é `local` → `elegivel`
 *   - Se a issue não tem label `local` → não afetada por esta regra
 */
function classifyLocalLabel(
  hasLocalLabel: boolean,
  mode: ExecMode,
): "requer-sessao-local" | "elegivel" | "unaffected" {
  if (!hasLocalLabel) return "unaffected";
  return mode === "cloud" ? "requer-sessao-local" : "elegivel";
}

describe("classificação de label 'local' por modo de execução", () => {
  it("issue com label 'local' em sessão cloud → requer-sessao-local", () => {
    const mode = detectExecMode({
      statFn: makeThrowingStatFn("ENOENT"),
      projectRoot: "/cloud/clone",
    });
    assert.equal(mode, "cloud");
    assert.equal(classifyLocalLabel(true, mode), "requer-sessao-local");
  });

  it("issue com label 'local' em sessão local → elegivel", () => {
    const mode = detectExecMode({
      statFn: makeStatFn(true),
      projectRoot: "/local/project",
    });
    assert.equal(mode, "local");
    assert.equal(classifyLocalLabel(true, mode), "elegivel");
  });

  it("issue sem label 'local' não é afetada pela regra (cloud)", () => {
    const mode = detectExecMode({
      statFn: makeThrowingStatFn("ENOENT"),
      projectRoot: "/cloud/clone",
    });
    assert.equal(classifyLocalLabel(false, mode), "unaffected");
  });

  it("issue sem label 'local' não é afetada pela regra (local)", () => {
    const mode = detectExecMode({
      statFn: makeStatFn(true),
      projectRoot: "/local/project",
    });
    assert.equal(classifyLocalLabel(false, mode), "unaffected");
  });
});
