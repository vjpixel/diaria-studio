/**
 * test/lint-checks-approved-item-removal.test.ts (#8121)
 *
 * Core puro `detectRemovedApprovedItems` — compara o snapshot pós-Stage 1/2
 * (baseline) contra o estado atual de `01-approved.json` no gate do Stage 4.
 * Deve distinguir REMOÇÃO (item some de TODOS os buckets, o caso que a
 * issue quer detectar) de RECATEGORIZAÇÃO legítima (item muda de bucket —
 * nunca deveria disparar, é o fluxo normal do editor no Stage 4).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRemovedApprovedItems } from "../scripts/lib/lint-checks/approved-item-removal.ts";

describe("detectRemovedApprovedItems (#8121)", () => {
  it("item movido de bucket (RADAR → LANÇAMENTOS) NÃO conta como removido", () => {
    const baseline = {
      radar: [{ url: "https://example.com/a", title: "Item A" }],
    };
    const current = {
      lancamento: [{ url: "https://example.com/a", title: "Item A" }],
    };
    assert.deepEqual(detectRemovedApprovedItems(baseline, current), []);
  });

  it("item que some de TODOS os buckets conta como removido", () => {
    const baseline = {
      radar: [{ url: "https://example.com/a", title: "Item A" }],
    };
    const current = { radar: [] };
    const removed = detectRemovedApprovedItems(baseline, current);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].url, "https://example.com/a");
    assert.equal(removed[0].title, "Item A");
    assert.equal(removed[0].bucket, "radar");
  });

  it("item ainda presente no MESMO bucket não conta como removido", () => {
    const baseline = {
      radar: [{ url: "https://example.com/a", title: "Item A" }],
    };
    const current = {
      radar: [{ url: "https://example.com/a", title: "Item A" }],
    };
    assert.deepEqual(detectRemovedApprovedItems(baseline, current), []);
  });

  it("item que sai do pool e vira destaque (highlights) NÃO conta como removido (mesma URL, bucket diferente)", () => {
    const baseline = {
      radar: [{ url: "https://example.com/a", title: "Item A" }],
    };
    const current = {
      highlights: [{ article: { url: "https://example.com/a", title: "Item A" } }],
    };
    assert.deepEqual(detectRemovedApprovedItems(baseline, current), []);
  });

  it("highlights nested (article.url/article.title) são lidos corretamente dos dois lados", () => {
    const baseline = {
      highlights: [{ article: { url: "https://example.com/d1", title: "Destaque 1" } }],
    };
    const current = { highlights: [] };
    const removed = detectRemovedApprovedItems(baseline, current);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].url, "https://example.com/d1");
    assert.equal(removed[0].title, "Destaque 1");
    assert.equal(removed[0].bucket, "highlights");
  });

  it("múltiplos itens removidos: todos reportados, cada um com o bucket ORIGINAL (baseline)", () => {
    const baseline = {
      radar: [{ url: "https://example.com/a", title: "A" }],
      lancamento: [{ url: "https://example.com/b", title: "B" }],
      use_melhor: [{ url: "https://example.com/c", title: "C" }],
    };
    const current = { radar: [{ url: "https://example.com/a", title: "A" }] }; // só A sobrevive
    const removed = detectRemovedApprovedItems(baseline, current);
    const byUrl = new Map(removed.map((r) => [r.url, r]));
    assert.equal(removed.length, 2);
    assert.equal(byUrl.get("https://example.com/b")?.bucket, "lancamento");
    assert.equal(byUrl.get("https://example.com/c")?.bucket, "use_melhor");
  });

  it("item novo no ATUAL sem existir no baseline não é reportado (não é remoção, é adição)", () => {
    const baseline = { radar: [{ url: "https://example.com/a", title: "A" }] };
    const current = {
      radar: [
        { url: "https://example.com/a", title: "A" },
        { url: "https://example.com/novo", title: "Novo" },
      ],
    };
    assert.deepEqual(detectRemovedApprovedItems(baseline, current), []);
  });

  it("item sem URL (dado malformado) é ignorado nos dois lados, sem lançar", () => {
    const baseline = { radar: [{ title: "sem url" }, { url: "https://example.com/a", title: "A" }] };
    const current = { radar: [{ url: "https://example.com/a", title: "A" }] };
    assert.deepEqual(detectRemovedApprovedItems(baseline, current), []);
  });

  it("baseline/current vazios ou com shape ausente: [], nunca lança", () => {
    assert.deepEqual(detectRemovedApprovedItems({}, {}), []);
    assert.deepEqual(detectRemovedApprovedItems(null, null), []);
    assert.deepEqual(detectRemovedApprovedItems(undefined, undefined), []);
  });

  it("item sem título usa a URL como fallback de título", () => {
    const baseline = { radar: [{ url: "https://example.com/sem-titulo" }] };
    const current = { radar: [] };
    const removed = detectRemovedApprovedItems(baseline, current);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].title, "https://example.com/sem-titulo");
  });
});
