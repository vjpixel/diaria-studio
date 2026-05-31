import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  flattenCategorized,
  toCategorized,
  splitRoundRobin,
  chunkCountFor,
  buildChunks,
  type Categorized,
  type Article,
} from "../scripts/split-articles-for-scoring.ts";

const mk = (url: string, category: string): Article => ({ url, title: url, category });

const SAMPLE: Categorized = {
  lancamento: [mk("l1", "lancamento"), mk("l2", "lancamento")],
  radar: [
    mk("p1", "radar"), mk("p2", "radar"), mk("p3", "radar"),
    mk("n1", "radar"), mk("n2", "radar")
  ],
  use_melhor: [],
};

describe("flattenCategorized", () => {
  it("achata na ordem de bucket canônica", () => {
    const flat = flattenCategorized(SAMPLE);
    assert.deepEqual(flat.map((a) => a.url), ["l1", "l2", "p1", "p2", "p3", "n1", "n2"]);
  });

  it("inclui buckets fora da ordem canônica ao final", () => {
    const flat = flattenCategorized({ radar: [mk("n1", "radar")], custom: [mk("x1", "custom")] });
    assert.deepEqual(flat.map((a) => a.url), ["n1", "x1"]);
  });
});

describe("chunkCountFor", () => {
  it("0 artigos → 0 chunks", () => assert.equal(chunkCountFor(0, 30), 0));
  it("<= chunk-size → 1 chunk", () => {
    assert.equal(chunkCountFor(30, 30), 1);
    assert.equal(chunkCountFor(7, 30), 1);
  });
  it("arredonda pra cima", () => {
    assert.equal(chunkCountFor(80, 30), 3);
    assert.equal(chunkCountFor(31, 30), 2);
    assert.equal(chunkCountFor(90, 30), 3);
  });
});

describe("splitRoundRobin", () => {
  it("distribui round-robin (mistura buckets)", () => {
    const flat = flattenCategorized(SAMPLE); // 7 artigos
    // flat = [l1,l2,p1,p2,p3,n1,n2] (idx 0..6)
    const chunks = splitRoundRobin(flat, 3);
    assert.deepEqual(chunks.map((c) => c.map((a) => a.url)), [
      ["l1", "p2", "n2"], // idx 0,3,6
      ["l2", "p3"], //       idx 1,4
      ["p1", "n1"], //       idx 2,5
    ]);
  });

  it("não perde nem duplica artigos", () => {
    const flat = Array.from({ length: 80 }, (_, i) => mk(`a${i}`, "radar"));
    const chunks = splitRoundRobin(flat, 3);
    const all = chunks.flat().map((a) => a.url).sort();
    assert.equal(all.length, 80);
    assert.equal(new Set(all).size, 80);
  });
});

describe("toCategorized", () => {
  it("reconstrói buckets a partir de category, fallback radar", () => {
    const cat = toCategorized([mk("l1", "lancamento"), mk("x", "desconhecido")]);
    assert.deepEqual(cat.lancamento.map((a) => a.url), ["l1"]);
    assert.deepEqual(cat.radar.map((a) => a.url), ["x"]);
  });
});

describe("buildChunks", () => {
  it("80 artigos / chunk-size 30 → 3 chunks shape categorized (#1629)", () => {
    const big: Categorized = {
      lancamento: Array.from({ length: 5 }, (_, i) => mk(`l${i}`, "lancamento")),
      radar: Array.from({ length: 75 }, (_, i) => mk(`r${i}`, "radar")),
      use_melhor: [],
    };
    const chunks = buildChunks(big, 30);
    assert.equal(chunks.length, 3);
    // cada chunk é shape categorized
    for (const c of chunks) {
      assert.ok(Array.isArray(c.lancamento) && Array.isArray(c.radar) && Array.isArray(c.use_melhor));
    }
    // total preservado
    const total = chunks.reduce(
      (a, c) => a + c.lancamento.length + c.radar.length + c.use_melhor.length,
      0,
    );
    assert.equal(total, 80);
  });

  it("pool vazio → 0 chunks", () => {
    assert.deepEqual(buildChunks({ radar: [] }, 30), []);
  });

  it("pool pequeno → 1 chunk com tudo", () => {
    const chunks = buildChunks(SAMPLE, 30);
    assert.equal(chunks.length, 1);
    assert.equal(
      chunks[0].lancamento.length + chunks[0].radar.length + chunks[0].use_melhor.length,
      7,
    );
  });
});
