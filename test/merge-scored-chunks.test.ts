import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractScores,
  mergeChunks,
  loadChunks,
  MAX_BENIGN_MISSING,
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

// #2496 — falso catastrophic quando use_melhor é capado pelo split
//
// Causa: split-articles-for-scoring capa use_melhor via dedupeUseMelhorBucket
// (ex: 31→15). merge-scored-chunks recebia tmp-dates-reviewed.json (pool
// não-capado, 31 use_melhor) e comparava contra os chunks (que só tinham os 15
// capados). Os 16 use_melhor capados apareciam como missing → missing_count=16
// > MAX_BENIGN_MISSING=2 → catastrophic=true (falso positivo).
//
// Fix: split emite o pool capado (--pool-out) e o merge recebe esse arquivo
// como --categorized. O pool comparado é exatamente o que foi pontuado.
describe("#2496 — use_melhor capado não vira catastrophic", () => {
  it("pool capado (15 use_melhor) vs chunks (15 pontuados) → NOT catastrophic", () => {
    // Simula o cenário de 260623: split capou use_melhor de 31 → 15.
    // O merge deve comparar contra os 15 (pool capado), não os 31 (não-capado).
    // Todos os 15 use_melhor + 3 lancamento + 5 radar foram pontuados → exit 0.
    const cappedPool: Categorized = {
      lancamento: [mk("l1", "lancamento"), mk("l2", "lancamento"), mk("l3", "lancamento")],
      radar: [mk("r1", "noticias"), mk("r2", "noticias"), mk("r3", "pesquisa"), mk("r4", "pesquisa"), mk("r5", "noticias")],
      // 15 use_melhor (capado de >15)
      use_melhor: Array.from({ length: 15 }, (_, i) => mk(`um${i}`, "tutorial")),
    };
    // Todos os 23 artigos do pool capado recebem score nos chunks
    const allScores = [
      ...cappedPool.lancamento.map((a) => ({ url: a.url, score: 80 })),
      ...cappedPool.radar.map((a) => ({ url: a.url, score: 70 })),
      ...(cappedPool.use_melhor ?? []).map((a) => ({ url: a.url, score: 60 })),
    ];
    const chunks: ChunkScoreFile[] = [{ all_scored: allScores }];
    const r = mergeChunks(cappedPool, chunks, 15, 0);
    assert.equal(r.pool_size, 23, "pool capado: 3+5+15=23");
    assert.equal(r.scored_count, 23, "todos pontuados");
    assert.equal(r.missing_count, 0);
    assert.equal(r.incomplete, false);
    assert.equal(r.catastrophic, false, "falso catastrophic #2496: pool capado → não deve ser catastrophic");
  });

  it("pool não-capado (31 use_melhor) vs chunks (15 pontuados) → catastrophic (comportamento anterior, agora evitado com fix)", () => {
    // Este teste documenta O PROBLEMA anterior: se o merge recebe o pool
    // não-capado (31 use_melhor) mas os chunks só pontuaram 15, os 16
    // capados aparecem como missing → catastrophic falso.
    // Este teste PASSA catastrophic=true — é O COMPORTAMENTO ERRADO que o fix evita.
    const uncappedPool: Categorized = {
      lancamento: [mk("l1", "lancamento"), mk("l2", "lancamento"), mk("l3", "lancamento")],
      radar: [mk("r1", "noticias"), mk("r2", "noticias"), mk("r3", "pesquisa"), mk("r4", "pesquisa"), mk("r5", "noticias")],
      // 31 use_melhor (NÃO-capado — como estava em tmp-dates-reviewed.json)
      use_melhor: Array.from({ length: 31 }, (_, i) => mk(`um${i}`, "tutorial")),
    };
    // Chunks só pontuam os primeiros 15 use_melhor (os capados)
    const capItems = (uncappedPool.use_melhor ?? []).slice(0, 15);
    const allScores = [
      ...uncappedPool.lancamento.map((a) => ({ url: a.url, score: 80 })),
      ...uncappedPool.radar.map((a) => ({ url: a.url, score: 70 })),
      ...capItems.map((a) => ({ url: a.url, score: 60 })),
    ];
    const chunks: ChunkScoreFile[] = [{ all_scored: allScores }];
    const r = mergeChunks(uncappedPool, chunks, 15, 0);
    // Os 16 use_melhor capados aparecem como missing → catastrophic=true
    assert.equal(r.missing_count, 16, "16 use_melhor capados aparecem como missing no pool não-capado");
    assert.equal(r.catastrophic, true, "comportamento errado (pré-fix): falso catastrophic com pool não-capado");
    // Este teste prova que passar o pool capado (#2496) é necessário:
    // com o pool capado, missing_count=0 e catastrophic=false (teste anterior).
  });

  it("gap benigno (1 lancamento missing ≤ MAX_BENIGN_MISSING) no pool capado → incompleto mas NÃO catastrophic", () => {
    // Fronteira benigna: 1 artigo missing (≤ MAX_BENIGN_MISSING) é gap recuperável,
    // NÃO catastrophic. A detecção REAL de catastrophic está nos 2 testes abaixo
    // (gap > MAX_BENIGN_MISSING e chunk inteiro ilegível).
    const cappedPool: Categorized = {
      // 3 lancamentos, 5 radar, 3 use_melhor — pool pequeno mas representativo
      lancamento: [mk("l1", "lancamento"), mk("l2", "lancamento"), mk("l3", "lancamento")],
      radar: [mk("r1", "noticias"), mk("r2", "noticias"), mk("r3", "pesquisa")],
      use_melhor: [mk("um1", "tutorial"), mk("um2", "tutorial"), mk("um3", "tutorial")],
    };
    // chunk pontuou l1, l2, r1, r2, r3, um1, um2, um3 — MAS NÃO l3 (perdido)
    const allScores = [
      { url: "l1", score: 90 }, { url: "l2", score: 85 },
      // l3 AUSENTE — perda real
      { url: "r1", score: 70 }, { url: "r2", score: 65 }, { url: "r3", score: 60 },
      { url: "um1", score: 55 }, { url: "um2", score: 50 }, { url: "um3", score: 45 },
    ];
    const chunks: ChunkScoreFile[] = [{ all_scored: allScores }];
    const r = mergeChunks(cappedPool, chunks, 15, 0);
    assert.equal(r.pool_size, 9);
    assert.equal(r.scored_count, 8, "1 artigo perdido (l3)");
    assert.equal(r.missing_count, 1);
    // missing_count=1 ≤ MAX_BENIGN_MISSING=2 → não é catastrophic (gap benigno recuperável)
    // MAS se o chunk inteiro falhou → catastrophic via failed_chunks
    assert.ok(MAX_BENIGN_MISSING >= 1, "fixture assume MAX_BENIGN_MISSING >= 1");
    assert.equal(r.catastrophic, false, "1 artigo missing: gap benigno (≤ MAX_BENIGN_MISSING), não catastrophic");
    assert.equal(r.incomplete, true, "mas incompleto — artigo recebe score 0");
  });

  it("catastrophic REAL detectado: gap > MAX_BENIGN_MISSING no pool capado (sem failed_chunks) → catastrophic", () => {
    // O caso crítico que faltava (#2496 review sweep): pool capado + failed_chunks=0
    // + missing_count > MAX_BENIGN_MISSING. Prova que o fix (pool capado) NÃO cega o
    // guard #1669 para perdas REAIS de score (scorer-chunk devolveu all_scored curto,
    // não um chunk ilegível). Se um futuro patch exentasse use_melhor do cálculo de
    // missing pra "consertar" o falso-catastrophic, este teste pega a regressão.
    const cappedPool: Categorized = {
      lancamento: [mk("l1", "lancamento"), mk("l2", "lancamento"), mk("l3", "lancamento")],
      radar: [mk("r1", "noticias"), mk("r2", "noticias"), mk("r3", "pesquisa"), mk("r4", "pesquisa")],
      use_melhor: [mk("um1", "tutorial"), mk("um2", "tutorial"), mk("um3", "tutorial")],
    };
    // pool_size=10; chunk só pontuou 3 → missing_count=7 (>> MAX_BENIGN_MISSING)
    const allScores = [
      { url: "l1", score: 90 }, { url: "r1", score: 70 }, { url: "um1", score: 55 },
    ];
    const chunks: ChunkScoreFile[] = [{ all_scored: allScores }];
    const r = mergeChunks(cappedPool, chunks, 15, /* failedChunks */ 0);
    assert.equal(r.pool_size, 10);
    assert.equal(r.scored_count, 3);
    assert.equal(r.missing_count, 7);
    assert.equal(r.failed_chunks, 0, "nenhum chunk ilegível → gap puro de score");
    assert.ok(r.missing_count > MAX_BENIGN_MISSING, "fixture: gap acima do limite benigno");
    assert.equal(r.catastrophic, true, "gap > MAX_BENIGN_MISSING no pool capado → catastrophic REAL (guard #1669 intacto)");
  });

  it("catastrophic REAL detectado: chunk inteiro ilegível com pool capado → catastrophic", () => {
    // Com pool capado (#2496) E chunk ilegível real → deve continuar sendo catastrophic.
    const cappedPool: Categorized = {
      lancamento: [mk("l1", "lancamento"), mk("l2", "lancamento"), mk("l3", "lancamento")],
      radar: [mk("r1", "noticias"), mk("r2", "noticias")],
      use_melhor: [mk("um1", "tutorial")],
    };
    // 1 chunk pontuou só parte; 1 chunk ilegível → failedChunks=1
    const partialChunks: ChunkScoreFile[] = [
      { all_scored: [{ url: "l1", score: 90 }, { url: "r1", score: 70 }] },
    ];
    const r = mergeChunks(cappedPool, partialChunks, 15, /* failedChunks */ 1);
    assert.equal(r.failed_chunks, 1);
    assert.equal(r.catastrophic, true, "chunk ilegível com pool capado → catastrophic REAL, guard #1669 intacto");
  });
});

describe("mergeChunks — bônus de cobertura (#3920)", () => {
  const withCluster = (url: string, category: string, extraSources: number) => ({
    url,
    title: url,
    category,
    cluster_sources: Array.from({ length: extraSources }, (_, i) => ({ url: `${url}-src${i}` })),
  });

  it("+5 por fonte extra é somado ao score base (empurra pra seleção)", () => {
    const cat: Categorized = {
      lancamento: [],
      radar: [
        { url: "solo", title: "solo", category: "radar" },
        withCluster("cov", "radar", 3), // 3 fontes extras → +15
      ],
      use_melhor: [],
    };
    const chunks: ChunkScoreFile[] = [
      { all_scored: [{ url: "solo", score: 70 }, { url: "cov", score: 60 }] },
    ];
    const r = mergeChunks(cat, chunks, 15);
    // cov: 60 base + 15 bônus = 75 → passa solo (70) no all_scored ordenado
    assert.deepEqual(r.all_scored.map((s) => s.url), ["cov", "solo"]);
    assert.equal(r.all_scored.find((s) => s.url === "cov")?.score, 75);
    assert.equal(r.all_scored.find((s) => s.url === "solo")?.score, 70);
    // finalists refletem a ordem boostada
    assert.equal(r.finalists[0].url, "cov");
  });

  it("stampa score_base + score_bonus_coverage no artigo do finalist (auditoria)", () => {
    const cat: Categorized = {
      lancamento: [],
      radar: [withCluster("cov", "radar", 2)], // +10
      use_melhor: [],
    };
    const chunks: ChunkScoreFile[] = [{ all_scored: [{ url: "cov", score: 50 }] }];
    const r = mergeChunks(cat, chunks, 15);
    const f = r.finalists.find((f) => f.url === "cov")!;
    assert.equal(f.score, 60);
    assert.equal((f.article as { score_base?: number }).score_base, 50);
    assert.equal((f.article as { score_bonus_coverage?: number }).score_bonus_coverage, 10);
  });

  it("artigo sem cluster_sources fica inalterado (sem stamp)", () => {
    const cat: Categorized = {
      lancamento: [],
      radar: [{ url: "plain", title: "plain", category: "radar" }],
      use_melhor: [],
    };
    const chunks: ChunkScoreFile[] = [{ all_scored: [{ url: "plain", score: 42 }] }];
    const r = mergeChunks(cat, chunks, 15);
    assert.equal(r.all_scored[0].score, 42);
    const f = r.finalists[0];
    assert.equal((f.article as { score_bonus_coverage?: number }).score_bonus_coverage, undefined);
  });
});
