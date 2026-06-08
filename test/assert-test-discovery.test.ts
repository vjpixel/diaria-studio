/**
 * test/assert-test-discovery.test.ts (#1948)
 *
 * Cobre o guard anti-vacuidade do `pretest`: a contagem real de arquivos de
 * teste fica acima do piso, e o veredito falha-alto quando a descoberta colapsa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countTestFiles,
  discoveryVerdict,
  TEST_FILE_FLOOR,
} from "../scripts/assert-test-discovery.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("assert-test-discovery — guard anti-vacuidade (#1948)", () => {
  it("conta os arquivos *.test.ts reais do repo (bem acima do piso)", () => {
    const n = countTestFiles(ROOT);
    assert.ok(n > TEST_FILE_FLOOR, `esperado > ${TEST_FILE_FLOOR} arquivos, achou ${n}`);
    // este próprio arquivo deve estar entre eles
    assert.ok(n >= 1);
  });

  it("verdict OK quando a contagem está no/acima do piso", () => {
    assert.equal(discoveryVerdict(TEST_FILE_FLOOR).ok, true);
    assert.equal(discoveryVerdict(TEST_FILE_FLOOR + 100).ok, true);
  });

  it("verdict FALHA quando a descoberta colapsa (abaixo do piso)", () => {
    assert.equal(discoveryVerdict(0).ok, false); // o caso "verde vazio" que o #1948 temia
    assert.equal(discoveryVerdict(TEST_FILE_FLOOR - 1).ok, false);
    assert.match(discoveryVerdict(0).message, /anti-vacuity/);
  });
});
