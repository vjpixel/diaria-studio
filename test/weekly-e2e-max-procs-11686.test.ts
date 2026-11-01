/**
 * #11686 — regressão: o step "Run unit tests" do weekly-e2e.yml roda o mesmo
 * `npm test` do ci.yml, mas sem RUN_TESTS_MAX_PROCS o run-tests usa o teto de
 * 300s por batch sem limitar processos concorrentes. Em 30/10/2026 dois
 * batches de 150 arquivos estouraram 300s (0 testes falhos, cobertura
 * incompleta, exit 1). O ci.yml escala o teto via RUN_TESTS_MAX_PROCS; o
 * weekly precisa do mesmo env.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function testsStep(file: string): string {
  const yml = readFileSync(resolve(root, ".github/workflows", file), "utf8");
  const start = yml.indexOf("- name: Run unit tests");
  assert.ok(start >= 0, `${file}: step "Run unit tests" não encontrado`);
  const next = yml.indexOf("\n      - ", start + 1);
  return yml.slice(start, next === -1 ? undefined : next);
}

describe("weekly-e2e.yml limita processos do npm test (#11686)", () => {
  it("step Run unit tests define RUN_TESTS_MAX_PROCS", () => {
    assert.match(testsStep("weekly-e2e.yml"), /RUN_TESTS_MAX_PROCS:\s*\d+/);
  });

  it("mesmo valor do ci.yml", () => {
    const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8").match(/RUN_TESTS_MAX_PROCS:\s*(\d+)/);
    const weekly = testsStep("weekly-e2e.yml").match(/RUN_TESTS_MAX_PROCS:\s*(\d+)/);
    assert.ok(ci && weekly);
    assert.equal(weekly[1], ci[1]);
  });
});
