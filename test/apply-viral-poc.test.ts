/**
 * #8713 — o uso documentado de `--pairs` precisa bater com `parsePair`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePair } from "../scripts/apply-viral-poc.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("parsePair (#8713)", () => {
  it("aceita o separador `|`", () => {
    assert.deepEqual(parsePair("in0.json|scored0.json"), ["in0.json", "scored0.json"]);
  });

  it("aceita path Windows com `:` dentro de cada lado", () => {
    assert.deepEqual(parsePair("C:\\a\\in.json|C:\\a\\out.json"), ["C:\\a\\in.json", "C:\\a\\out.json"]);
  });

  it("recusa par sem `|`", () => {
    assert.throws(() => parsePair("in0.json:scored0.json"), /par inválido/);
  });

  it("todo par do exemplo de uso no cabeçalho é aceito por parsePair", () => {
    const src = readFileSync(resolve(ROOT, "scripts/apply-viral-poc.ts"), "utf8");
    const m = src.match(/--pairs "([^"]+)"/);
    assert.ok(m, "cabeçalho deve ter um exemplo --pairs");
    for (const pair of m![1].split(",")) assert.doesNotThrow(() => parsePair(pair));
    assert.doesNotMatch(src, /--pairs in:scored/);
  });
});
