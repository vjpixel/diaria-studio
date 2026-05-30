import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractScores,
  mergeChunks,
  loadChunks,
  type ChunkScoreFile,
} from "../scripts/merge-scored-chunks.ts";
import type { Categorized } from "../scripts/split-articles-for-scoring.ts";

const mk = (url: string, category: string) => ({ url, title: url, category });

const CAT: Categorized = {
  lancamento: [mk("l1", "lancamento")],
  pesquisa: [mk("p1", "pesquisa"), mk("p2", "pesquisa")],
  noticias: [mk("n1", "noticias"), mk("n2", "noticias")],
  tutorial: [],
};

describe("extractScores", () => {
  it("aceita all_scored", () => {
    assert.deepEqual(extractScores({ all_scored: [{ url: "a", score: 9 }] }), [{ url: "a", score: 9 }]);
  });
  it("aceita scored", () => {
    assert.deepEqual(extractScores({ scored: [{ url: "a", score: 9 }] }), [{ url: "a", score: 9 }]);
  });
  it("descarta entradas sem url; score ausente vira 0", () => {
    const out = extractScores({ scored: [{ score: 5 } as never, { url: "b" } as never] });
    assert.deepEqual(out, [{ url: "b", score: 0 }]);
  });
});

describe("loadChunks (resiliência a chunk corrompido #1611)", () => {
  // reader fake: mapeia path → conteúdo; lança pra paths "ausentes".
  const reader = (store: Record<string, string>) => (p: string) => {
    if (!(p in store)) throw new Error("ENOENT");
    return store[p];
  };

  it("lê todos os chunks válidos", () => {
    const store = {
      a: JSON.stringify({ scored: [{ url: "x", score: 1 }] }),
      b: JSON.stringify({ scored: [{ url: "y", score: 2 }] }),
    };
    const { chunks, failed } = loadChunks(["a", "b"], reader(store));
    assert.equal(chunks.length, 2);
    assert.deepEqual(failed, []);
  });

  it("pula chunk com JSON truncado (socket error) sem derrubar os demais", () => {
    const store = {
      a: JSON.stringify({ scored: [{ url: "x", score: 1 }] }),
      b: '{"scored":[{"url":"y","sco', // truncado
      c: JSON.stringify({ scored: [{ url: "z", score: 3 }] }),
    };
    const { chunks, failed } = loadChunks(["a", "b", "c"], reader(store));
    assert.equal(chunks.length, 2); // a e c sobrevivem
    assert.deepEqual(failed, ["b"]);
  });

  it("pula chunk ausente", () => {
    const store = { a: JSON.stringify({ scored: [] }) };
    const { chunks, failed } = loadChunks(["a", "missing"], reader(store));
    assert.equal(chunks.length, 1);
    assert.deepEqual(failed, ["missing"]);
  });

  it("merge com chunk faltando → demais sobrevivem + incomplete", () => {
    const store = {
      a: JSON.stringify({ scored: [{ url: "p2", score: 90 }, { url: "n1", score: 80 }] }),
      b: "{corrompido",
    };
    const { chunks } = loadChunks(["a", "b"], reader(store));
    const r = mergeChunks(CAT, chunks, 15);
    assert.equal(r.scored_count, 2); // só do chunk válido
    assert.equal(r.incomplete, true);
    assert.equal(r.all_scored.length, 5); // pool inteiro ainda presente
  });
});

describe("mergeChunks", () => {
  const chunks: ChunkScoreFile[] = [
    { scored: [{ url: "l1", score: 50 }, { url: "p2", score: 90 }, { url: "n2", score: 30 }] },
    { scored: [{ url: "p1", score: 70 }, { url: "n1", score: 80 }] },
  ];

  it("all_scored cobre todo o pool, ordenado desc", () => {
    const r = mergeChunks(CAT, chunks, 15);
    assert.equal(r.all_scored.length, 5);
    assert.deepEqual(r.all_scored.map((s) => s.url), ["p2", "n1", "p1", "l1", "n2"]);
    assert.deepEqual(r.all_scored.map((s) => s.score), [90, 80, 70, 50, 30]);
  });

  it("finalists = top-N completos com bucket", () => {
    const r = mergeChunks(CAT, chunks, 3);
    assert.equal(r.finalists.length, 3);
    assert.deepEqual(r.finalists.map((f) => f.url), ["p2", "n1", "p1"]);
    assert.equal(r.finalists[0].bucket, "pesquisa");
    assert.equal(r.finalists[1].bucket, "noticias");
    assert.ok(r.finalists[0].article.title); // artigo completo presente
  });

  it("scored_count == pool_size quando tudo pontuado (not incomplete)", () => {
    const r = mergeChunks(CAT, chunks, 15);
    assert.equal(r.pool_size, 5);
    assert.equal(r.scored_count, 5);
    assert.equal(r.incomplete, false);
  });

  it("chunk faltando → artigos sem score viram 0 + incomplete", () => {
    const partial: ChunkScoreFile[] = [{ scored: [{ url: "p2", score: 90 }, { url: "n1", score: 80 }] }];
    const r = mergeChunks(CAT, partial, 15);
    assert.equal(r.scored_count, 2);
    assert.equal(r.incomplete, true);
    // os 3 não-pontuados aparecem com score 0 (nunca somem)
    assert.equal(r.all_scored.length, 5);
    const zeros = r.all_scored.filter((s) => s.score === 0).map((s) => s.url).sort();
    assert.deepEqual(zeros, ["l1", "n2", "p1"]);
  });

  it("URL duplicada entre chunks → maior score vence", () => {
    const dup: ChunkScoreFile[] = [
      { scored: [{ url: "p2", score: 40 }] },
      { scored: [{ url: "p2", score: 95 }] },
    ];
    const r = mergeChunks(CAT, dup, 15);
    assert.equal(r.all_scored.find((s) => s.url === "p2")?.score, 95);
  });

  it("top maior que pool não quebra", () => {
    const r = mergeChunks(CAT, chunks, 999);
    assert.equal(r.finalists.length, 5);
  });
});
