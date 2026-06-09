/**
 * test/use-melhor-sources.test.ts (#1899)
 *
 * Cobre o helper da flag `use_melhor` (lista-semente de fontes da seção
 * Use Melhor) e o loader de hosts a partir do seed real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isUseMelhorSource,
  sourceHost,
  sourcePrefix,
  loadUseMelhorPrefixes,
  matchesUseMelhorPrefix,
} from "../scripts/lib/use-melhor-sources.ts";

describe("isUseMelhorSource (#1899)", () => {
  it('só é true quando use_melhor == "1"', () => {
    assert.equal(isUseMelhorSource({ use_melhor: "1" }), true);
    assert.equal(isUseMelhorSource({ use_melhor: " 1 " }), true);
    assert.equal(isUseMelhorSource({ use_melhor: "" }), false);
    assert.equal(isUseMelhorSource({ use_melhor: "0" }), false);
    assert.equal(isUseMelhorSource({}), false);
  });
});

describe("sourceHost (#1899)", () => {
  it("normaliza host (lower, sem www)", () => {
    assert.equal(sourceHost("https://WWW.Fast.ai/"), "fast.ai");
    assert.equal(sourceHost("https://huggingface.co/learn"), "huggingface.co");
  });
  it("'' pra inválida", () => {
    assert.equal(sourceHost("nope"), "");
  });
});

describe("sourcePrefix (#1927 review)", () => {
  it("host dedicado → só host; host largo → host/path", () => {
    assert.equal(sourcePrefix("https://www.fast.ai/"), "fast.ai");
    assert.equal(
      sourcePrefix("https://github.com/anthropics/anthropic-cookbook"),
      "github.com/anthropics/anthropic-cookbook",
    );
    assert.equal(sourcePrefix("nope"), "");
  });
});

describe("loadUseMelhorPrefixes (seed real, #1899)", () => {
  const prefixes = loadUseMelhorPrefixes();
  it("retorna prefixos host/path das fontes flagueadas (path-aware)", () => {
    assert.ok(prefixes.length > 0, "deve haver fontes Use Melhor no seed");
    // host dedicado = só host (#1971: era fast.ai, desativada; eugeneyan.com segue no seed)
    assert.ok(prefixes.includes("eugeneyan.com"), "host dedicado = só host");
    // host largo (github) deve vir com path, não nu
    assert.ok(
      prefixes.some((p) => p.startsWith("github.com/")),
      "github vem com path, não host nu",
    );
    assert.ok(!prefixes.includes("github.com"), "github.com NU não pode estar (over-match)");
  });
});

describe("matchesUseMelhorPrefix (#1927 review)", () => {
  const prefixes = ["fast.ai", "github.com/anthropics/anthropic-cookbook"];
  it("casa artigo sob o prefixo", () => {
    assert.equal(matchesUseMelhorPrefix("https://www.fast.ai/posts/x.html", prefixes), true);
    assert.equal(
      matchesUseMelhorPrefix("https://github.com/anthropics/anthropic-cookbook/blob/main/x.ipynb", prefixes),
      true,
    );
  });
  it("NÃO casa outro path do mesmo host largo (boundary-safe)", () => {
    assert.equal(matchesUseMelhorPrefix("https://github.com/openai/whatever", prefixes), false);
    assert.equal(matchesUseMelhorPrefix("https://github.com/anthropics-other/x", prefixes), false);
  });
  it("não casa fonte de notícia", () => {
    assert.equal(matchesUseMelhorPrefix("https://canaltech.com.br/ia/x", prefixes), false);
  });
});
