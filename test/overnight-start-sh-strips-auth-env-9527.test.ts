/**
 * #9527 (review do PR #9529) — `scripts/overnight/start.sh` lança `claude` e
 * precisa remover do ambiente TODAS as vars de `CLAUDE_CLI_STRIPPED_ENV_VARS`
 * (regra #5608/#6714: sessão de Claude Code nunca autentica pela API/gateway).
 * Bash não importa a lista TS, então ela é espelhada no script; este guard
 * falha se a lista crescer sem o launcher acompanhar. Também trava o par-alvo
 * do launcher (#9530).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_CLI_STRIPPED_ENV_VARS } from "../scripts/overnight/run-scheduled-edicao.ts";
import { EXPECTED_EFFORT, EXPECTED_MODEL } from "../scripts/lib/effective-model-probe.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(resolve(ROOT, "scripts/overnight/start.sh"), "utf8");
const code = src
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

describe("scripts/overnight/start.sh (#9527)", () => {
  for (const key of CLAUDE_CLI_STRIPPED_ENV_VARS) {
    it(`remove ${key} antes de lançar claude`, () => {
      assert.match(code, new RegExp(`-u ${key}\\b`), `start.sh não remove ${key} (#5608/#6714)`);
    });
  }
  it("lança claude com o par-alvo da sonda (#9530)", () => {
    assert.match(code, new RegExp(`claude --model ${EXPECTED_MODEL} --effort ${EXPECTED_EFFORT}\\b`));
  });
  it("usa exec env (filtro aplicado ao processo claude, não só ao shell)", () => {
    assert.match(code, /exec env\b/);
  });
});
