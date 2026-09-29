/**
 * test/run-edition-stages-intentional-error-warning-8592.test.ts (#8592)
 *
 * Issue #8592: rodadas headless de `/diaria-edicao --no-gates` (ou qualquer
 * invocação de `scripts/run-edition-stages.ts` que alcance o Stage 2) podiam
 * terminar sem NENHUM erro intencional declarado — o placeholder `{PREENCHER}`
 * segue em `_internal/intentional-error.json` e ninguém percebe até o Stage 4/5.
 *
 * Este teste chama `main()` de ponta a ponta com `execFn`/`assertSentinelFn`
 * fake (nunca spawna `claude` real, mesmo padrão de
 * `run-edition-stages-jev-env-8564.test.ts`) e confirma que o aviso aparece
 * no stderr injetado quando o plano alcança o Stage 2 e o JSON do erro
 * intencional ainda está pendente — sem nunca mudar o `exitCode` (não é
 * bloqueante).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../scripts/run-edition-stages.ts";

/** Mesmo padrão de `run-edition-stages-jev-env-8564.test.ts`: 1ª chamada
 * (pré-spawn) = sentinel ausente (deixa o laço spawnar); 2ª (pós-spawn) = ok. */
function fakeAssertSentinelFn(): () => { ok: true } | { ok: false; reason: "sentinel_missing" } {
  let calls = 0;
  return () => {
    calls++;
    return calls % 2 === 1 ? { ok: false, reason: "sentinel_missing" } : { ok: true };
  };
}

function fakeExecFn() {
  return ((..._args: unknown[]) =>
    JSON.stringify({ result: "ok", total_cost_usd: 0, usage: {} })) as unknown as typeof import("node:child_process").execFileSync;
}

function runMain(argv: string[], repoRootAbs: string): { exitCode: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = main(argv, {
    execFn: fakeExecFn(),
    resolveClaudeBinFn: () => "claude",
    assertSentinelFn: fakeAssertSentinelFn(),
    env: {},
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    repoRootAbs,
  });
  return { exitCode, out, err };
}

describe("#8592: run-edition-stages avisa quando o headless termina sem erro intencional declarado", () => {
  it("plano alcança o Stage 2 e o JSON não existe → aviso no stderr, exitCode inalterado", () => {
    const repoRootAbs = mkdtempSync(join(tmpdir(), "diaria-run-edition-stages-ie-"));
    try {
      const { exitCode, err } = runMain(["--edition", "260928", "--through", "2"], repoRootAbs);
      assert.equal(exitCode, 0);
      assert.ok(
        err.some((l) => /sem erro intencional declarado/.test(l)),
        `esperava aviso no stderr, recebeu: ${JSON.stringify(err)}`,
      );
    } finally {
      rmSync(repoRootAbs, { recursive: true, force: true });
    }
  });

  it("plano alcança o Stage 2 e o JSON ainda tem placeholder → aviso no stderr", () => {
    const repoRootAbs = mkdtempSync(join(tmpdir(), "diaria-run-edition-stages-ie-"));
    try {
      const ed = join(repoRootAbs, "data", "editions", "260928");
      mkdirSync(join(ed, "_internal"), { recursive: true });
      writeFileSync(
        join(ed, "_internal", "intentional-error.json"),
        JSON.stringify({
          description: "{PREENCHER — o que o assinante deve identificar}",
          location: "{PREENCHER}",
          category: "{PREENCHER}",
          correct_value: "{PREENCHER}",
          reveal: "{PREENCHER}",
        }),
      );
      const { exitCode, err } = runMain(["--edition", "260928", "--through", "2"], repoRootAbs);
      assert.equal(exitCode, 0);
      assert.ok(err.some((l) => /sem erro intencional declarado/.test(l)));
    } finally {
      rmSync(repoRootAbs, { recursive: true, force: true });
    }
  });

  it("JSON completo (sem placeholder) → SEM aviso", () => {
    const repoRootAbs = mkdtempSync(join(tmpdir(), "diaria-run-edition-stages-ie-"));
    try {
      const ed = join(repoRootAbs, "data", "editions", "260928");
      mkdirSync(join(ed, "_internal"), { recursive: true });
      writeFileSync(
        join(ed, "_internal", "intentional-error.json"),
        JSON.stringify({
          description: "Uma marca conhecida aparece com o nome errado.",
          location: "RADAR",
          category: "ortografico",
          correct_value: "Anthropic",
          wrong_value: "Anthropik",
          reveal: "Na última edição, escrevi \"Anthropik\" onde o correto é \"Anthropic\".",
        }),
      );
      const { exitCode, err } = runMain(["--edition", "260928", "--through", "2"], repoRootAbs);
      assert.equal(exitCode, 0);
      assert.ok(!err.some((l) => /sem erro intencional declarado/.test(l)));
    } finally {
      rmSync(repoRootAbs, { recursive: true, force: true });
    }
  });

  it("{no_error: true} → SEM aviso (editor declarou explicitamente)", () => {
    const repoRootAbs = mkdtempSync(join(tmpdir(), "diaria-run-edition-stages-ie-"));
    try {
      const ed = join(repoRootAbs, "data", "editions", "260928");
      mkdirSync(join(ed, "_internal"), { recursive: true });
      writeFileSync(join(ed, "_internal", "intentional-error.json"), JSON.stringify({ no_error: true }));
      const { exitCode, err } = runMain(["--edition", "260928", "--through", "2"], repoRootAbs);
      assert.equal(exitCode, 0);
      assert.ok(!err.some((l) => /sem erro intencional declarado/.test(l)));
    } finally {
      rmSync(repoRootAbs, { recursive: true, force: true });
    }
  });

  it("plano NÃO alcança o Stage 2 (--through 1) → nunca checa, sem aviso mesmo com JSON pendente", () => {
    const repoRootAbs = mkdtempSync(join(tmpdir(), "diaria-run-edition-stages-ie-"));
    try {
      const { exitCode, err } = runMain(["--edition", "260928", "--through", "1"], repoRootAbs);
      assert.equal(exitCode, 0);
      assert.ok(!err.some((l) => /sem erro intencional declarado/.test(l)));
    } finally {
      rmSync(repoRootAbs, { recursive: true, force: true });
    }
  });
});
