import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractScores,
  mergeChunks,
  loadChunks,
  type ChunkScoreFile,
} from "../scripts/merge-scored-chunks.ts";
import type { Categorized } from "../scripts/split-articles-for-scoring.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const mk = (url: string, category: string) => ({ url, title: url, category });

const CAT: Categorized = {
  lancamento: [mk("l1", "lancamento")],
  radar: [
    mk("p1", "radar"), mk("p2", "radar"),
    mk("n1", "radar"), mk("n2", "radar")
  ],
  use_melhor: [],
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
    assert.equal(r.finalists[0].bucket, "radar");
    assert.equal(r.finalists[1].bucket, "radar");
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

// #1567 audit (finding F): distinguir perda CATASTRÓFICA (chunk inteiro perdido)
// de gap benigno (1-2 artigos). O split é round-robin, então um chunk perdido
// leva uma fatia dos MELHORES artigos — não pode sumir com só um warning.
describe("mergeChunks — sinal catastrophic (#1567 finding F)", () => {
  // pool = 5 artigos: l1, p1, p2, n1, n2
  it("failed_chunks > 0 ⇒ catastrophic, mesmo com gap pequeno", () => {
    // só 1 artigo sem score (gap benigno), MAS um chunk file não carregou
    const chunks: ChunkScoreFile[] = [
      { all_scored: [{ url: "l1", score: 50 }, { url: "p1", score: 60 }, { url: "p2", score: 70 }, { url: "n1", score: 40 }] },
    ];
    const r = mergeChunks(CAT, chunks, 15, /* failedChunks */ 1);
    assert.equal(r.missing_count, 1);
    assert.equal(r.failed_chunks, 1);
    assert.equal(r.catastrophic, true); // chunk ilegível ⇒ não confiar, retry/fallback
  });

  it("gap grande (> MAX_BENIGN_MISSING) ⇒ catastrophic mesmo sem failed file", () => {
    // chunk "sucedeu" mas devolveu quase nada (agent escreveu all_scored curto)
    const chunks: ChunkScoreFile[] = [{ all_scored: [{ url: "l1", score: 50 }] }];
    const r = mergeChunks(CAT, chunks, 15, 0);
    assert.equal(r.missing_count, 4); // 5 - 1
    assert.equal(r.failed_chunks, 0);
    assert.equal(r.catastrophic, true);
  });

  it("gap pequeno (≤ MAX_BENIGN_MISSING) ⇒ incomplete mas NÃO catastrophic", () => {
    // 4 de 5 pontuados — 1 artigo omitido por um agent que senão funcionou
    const chunks: ChunkScoreFile[] = [
      { all_scored: [{ url: "l1", score: 50 }, { url: "p1", score: 60 }, { url: "p2", score: 70 }, { url: "n1", score: 40 }] },
    ];
    const r = mergeChunks(CAT, chunks, 15, 0);
    assert.equal(r.missing_count, 1);
    assert.equal(r.incomplete, true);
    assert.equal(r.catastrophic, false); // recuperável — segue com warning
  });

  it("pool completo ⇒ nem incomplete nem catastrophic", () => {
    const chunks: ChunkScoreFile[] = [
      { all_scored: [{ url: "l1", score: 50 }, { url: "p1", score: 60 }, { url: "p2", score: 70 }, { url: "n1", score: 40 }, { url: "n2", score: 30 }] },
    ];
    const r = mergeChunks(CAT, chunks, 15, 0);
    assert.equal(r.missing_count, 0);
    assert.equal(r.incomplete, false);
    assert.equal(r.catastrophic, false);
  });
});

describe("main() CLI — exit code determinístico (#1669)", () => {
  const ROOT = resolve(import.meta.dirname, "..");
  const POOL = {
    lancamento: [mk("l1", "lancamento")],
    radar: [mk("p1", "radar"), mk("p2", "radar"), mk("n1", "radar"), mk("n2", "radar")],
    use_melhor: [],
  };

  function runMerge(chunkContents: string[]): { status: number; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), "msc-cli-"));
    try {
      const catPath = join(dir, "cat.json");
      writeFileSync(catPath, JSON.stringify({ categorized: POOL }));
      const chunkPaths = chunkContents.map((c, i) => {
        const p = join(dir, `chunk-${i}.json`);
        writeFileSync(p, c);
        return p;
      });
      const r = spawnSync(
        "npx",
        [
          "tsx", "scripts/merge-scored-chunks.ts",
          "--categorized", catPath,
          "--chunk-scores", chunkPaths.join(","),
          "--allscored-out", join(dir, "all.json"),
          "--finalists-out", join(dir, "fin.json"),
          "--top", "15",
        ],
        { cwd: ROOT, encoding: "utf8", shell: true },
      );
      return { status: r.status ?? -1, stdout: r.stdout ?? "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("chunk ilegível (catastrophic) → exit 2 + manifest de diagnóstico no stdout (#1669)", () => {
    // JSON inválido → loadChunks marca failed → catastrophic. Pré-fix saía 0.
    const r = runMerge(["{corrompido"]);
    assert.equal(r.status, 2, "perda catastrófica deve sair com exit 2");
    // Manifest de diagnóstico é emitido no stdout mesmo no exit catastrófico.
    // (NB: o manifest é pequeno e drena sync mesmo sob process.exit; o uso de
    // process.exitCode — não exit() — é robustez contra truncar writes maiores e
    // NÃO é distinguível por este assert; é uma decisão documentada no script.)
    assert.match(r.stdout, /"catastrophic":true/, "manifest de diagnóstico presente no stdout");
  });

  it("args ausentes → exit 1 (erro de invocação, distinto de catastrophic) (#1669)", () => {
    // Exit 1 ≠ exit 2: 1q.3 deve HALT (não 'seguir'), pois nenhum output novo é
    // escrito (process.exit(1) acontece antes dos writeFileSync).
    const r = spawnSync("npx", ["tsx", "scripts/merge-scored-chunks.ts"], {
      cwd: ROOT, encoding: "utf8", shell: true,
    });
    assert.equal(r.status ?? -1, 1);
  });

  it("todos os artigos pontuados → exit 0", () => {
    const valid = JSON.stringify({
      scored: [
        { url: "l1", score: 9 }, { url: "p1", score: 8 }, { url: "p2", score: 7 },
        { url: "n1", score: 6 }, { url: "n2", score: 5 },
      ],
    });
    assert.equal(runMerge([valid]).status, 0);
  });
});
