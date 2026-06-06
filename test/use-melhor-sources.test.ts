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
  loadUseMelhorHosts,
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

describe("loadUseMelhorHosts (seed real, #1899)", () => {
  const hosts = loadUseMelhorHosts();
  it("retorna os hosts das fontes flagueadas (não-vazio, sem www)", () => {
    assert.ok(hosts.length > 0, "deve haver fontes Use Melhor no seed");
    assert.ok(hosts.every((h) => !h.startsWith("www.")), "hosts sem www");
    // fontes-semente conhecidas (Tipo=Tutoriais)
    assert.ok(hosts.includes("fast.ai"), "fast.ai marcada");
    assert.ok(hosts.includes("huggingface.co"), "huggingface marcada");
  });
  it("não inclui uma fonte de notícia (ex: canaltech)", () => {
    assert.ok(!hosts.includes("canaltech.com.br"), "fonte de notícia não é Use Melhor");
  });
});
