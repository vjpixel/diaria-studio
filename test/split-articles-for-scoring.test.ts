import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  flattenCategorized,
  toCategorized,
  splitRoundRobin,
  chunkCountFor,
  buildChunks,
  main as splitMain,
  type Categorized,
  type Article,
} from "../scripts/split-articles-for-scoring.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

// Helper to run splitMain() with argv override + stdout capture
function runSplitMain(
  args: { categorizedPath: string; outDir: string; chunkSize?: number; poolOut?: string },
): { stdout: string } {
  const origArgv = process.argv;
  const origWrite = process.stdout.write.bind(process.stdout);
  let stdoutCapture = "";
  process.stdout.write = (s: string | Uint8Array) => {
    stdoutCapture += s.toString();
    return true;
  };
  process.argv = [
    "node",
    "split-articles-for-scoring.ts",
    "--categorized", args.categorizedPath,
    "--out-dir", args.outDir,
    "--chunk-size", String(args.chunkSize ?? 30),
    ...(args.poolOut ? ["--pool-out", args.poolOut] : []),
  ];
  try {
    splitMain();
  } finally {
    process.stdout.write = origWrite;
    process.argv = origArgv;
  }
  return { stdout: stdoutCapture };
}

const MINIMAL_CATEGORIZED = {
  categorized: {
    lancamento: [{ url: "https://example.com/1", title: "T1", category: "lancamento" }],
    radar: [],
    use_melhor: [],
    video: [],
  },
};

describe("#2287 — split-articles-for-scoring limpa scoring-chunks/ antes de escrever", () => {
  // Regressão: antes de #2287, chunks de runs anteriores ficavam no dir.
  // scorer-chunk podia ler scored-chunk-*.json stale (de outra edição) e mesclar
  // com dados do run atual. Agora split-articles-for-scoring limpa o dir primeiro.
  //
  // #6 safety: scored-chunk-*.json são output do scorer paralelo. Apagá-los
  // incondicionalmente destrói scoring em andamento num retry. A guarda:
  //   - Se tmp-allscored.json (output do merge) EXISTE no pai → merge completou
  //     → scored-chunk-*.json já foram consumidos → seguro remover.
  //   - Se tmp-allscored.json AUSENTE → merge ainda não rodou → PRESERVAR
  //     scored-chunk-*.json para não forçar re-scoring.

  it("scoring-chunk-*.json stale de run anterior são sempre removidos", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "diaria-split-test-"));
    const chunksDir = join(tmpBase, "scoring-chunks");
    const categorizedPath = join(tmpBase, "categorized.json");
    mkdirSync(chunksDir, { recursive: true });
    try {
      writeFileSync(join(chunksDir, "scoring-chunk-0.json"), '{"stale":"old-0"}');
      writeFileSync(join(chunksDir, "scoring-chunk-1.json"), '{"stale":"old-1"}');
      writeFileSync(join(chunksDir, "other-file.txt"), "keep-me");
      writeFileSync(categorizedPath, JSON.stringify(MINIMAL_CATEGORIZED));

      runSplitMain({ categorizedPath, outDir: chunksDir });

      // Arquivos não-relacionados preservados
      assert.ok(existsSync(join(chunksDir, "other-file.txt")), "other-file.txt preservado");
      // Novos scoring-chunk escritos
      const files = readdirSync(chunksDir).filter((f) => f.startsWith("scoring-chunk-"));
      assert.ok(files.length >= 1, "novo scoring-chunk-*.json escrito");
      const content = JSON.parse(readFileSync(join(chunksDir, "scoring-chunk-0.json"), "utf8"));
      assert.ok(content.categorized, "novo chunk tem shape categorized");
      assert.ok(!JSON.stringify(content).includes('"stale"'), "stale data não presente");
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("#6 guarda: scored-chunk-*.json PRESERVADOS quando merge ainda não completou (tmp-allscored.json ausente)", () => {
    // Cenário: pipeline interrompida após scoring, antes do merge.
    // Re-rodar split não deve destruir os scored-chunk-*.json.
    const tmpBase = mkdtempSync(join(tmpdir(), "diaria-split-test-"));
    const chunksDir = join(tmpBase, "scoring-chunks");
    const categorizedPath = join(tmpBase, "categorized.json");
    mkdirSync(chunksDir, { recursive: true });
    try {
      // scored-chunk-*.json existem (scoring completou mas merge não rodou ainda)
      writeFileSync(join(chunksDir, "scored-chunk-0.json"), '{"scored":"chunk-0-data"}');
      writeFileSync(join(chunksDir, "scored-chunk-1.json"), '{"scored":"chunk-1-data"}');
      // tmp-allscored.json AUSENTE no pai (merge não rodou)
      // (NÃO criar join(tmpBase, "tmp-allscored.json"))
      writeFileSync(categorizedPath, JSON.stringify(MINIMAL_CATEGORIZED));

      runSplitMain({ categorizedPath, outDir: chunksDir });

      // scored-chunk-*.json devem estar PRESERVADOS
      assert.ok(
        existsSync(join(chunksDir, "scored-chunk-0.json")),
        "scored-chunk-0.json PRESERVADO quando merge não completou (#6)",
      );
      assert.ok(
        existsSync(join(chunksDir, "scored-chunk-1.json")),
        "scored-chunk-1.json PRESERVADO quando merge não completou (#6)",
      );
      // Conteúdo preservado (não zerado)
      const scored = JSON.parse(readFileSync(join(chunksDir, "scored-chunk-0.json"), "utf8"));
      assert.deepEqual(scored, { scored: "chunk-0-data" }, "conteúdo do scored-chunk preservado");
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("#6 guarda: scored-chunk-*.json REMOVIDOS quando merge completou (tmp-allscored.json presente)", () => {
    // Cenário: pipeline completou até o merge. scored-chunk-*.json já foram
    // consumidos — seguro remover numa nova rodada.
    const tmpBase = mkdtempSync(join(tmpdir(), "diaria-split-test-"));
    const chunksDir = join(tmpBase, "scoring-chunks");
    const categorizedPath = join(tmpBase, "categorized.json");
    mkdirSync(chunksDir, { recursive: true });
    try {
      writeFileSync(join(chunksDir, "scored-chunk-0.json"), '{"scored":"stale-0"}');
      writeFileSync(join(chunksDir, "scored-chunk-1.json"), '{"scored":"stale-1"}');
      // tmp-allscored.json PRESENTE no pai (merge completou)
      writeFileSync(join(tmpBase, "tmp-allscored.json"), '{"all_scored":[]}');
      writeFileSync(categorizedPath, JSON.stringify(MINIMAL_CATEGORIZED));

      runSplitMain({ categorizedPath, outDir: chunksDir });

      // scored-chunk-*.json devem ter sido REMOVIDOS (merge já os consumiu)
      assert.ok(
        !existsSync(join(chunksDir, "scored-chunk-0.json")),
        "scored-chunk-0.json removido quando merge completou (#6)",
      );
      assert.ok(
        !existsSync(join(chunksDir, "scored-chunk-1.json")),
        "scored-chunk-1.json removido quando merge completou (#6)",
      );
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("stdout: manifest JSON válido após limpeza", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "diaria-split-test-"));
    const chunksDir = join(tmpBase, "scoring-chunks");
    const categorizedPath = join(tmpBase, "categorized.json");
    mkdirSync(chunksDir, { recursive: true });
    try {
      writeFileSync(categorizedPath, JSON.stringify(MINIMAL_CATEGORIZED));
      const { stdout } = runSplitMain({ categorizedPath, outDir: chunksDir });
      const manifest = JSON.parse(stdout.trim());
      assert.ok(typeof manifest.total_articles === "number");
      assert.ok(typeof manifest.chunk_count === "number");
      assert.ok(Array.isArray(manifest.chunk_files));
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

// #2496 — --pool-out emite pool capado (pós dedup/cap use_melhor) para merge
describe("#2496 — split emite pool capado via --pool-out", () => {
  // Categorized com muitos use_melhor (simulando o caso 260623: 31→15 após cap).
  // Quando --pool-out é passado, o arquivo deve conter só os artigos que de fato
  // foram distribuídos nos chunks (i.e., o pool capado, não o não-capado).
  const MANY_USE_MELHOR = {
    categorized: {
      lancamento: [{ url: "https://example.com/l1", title: "L1", category: "lancamento" }],
      radar: [{ url: "https://example.com/r1", title: "R1", category: "noticias" }],
      // 20 use_melhor do mesmo domínio (serão capados a maxPerDomain=2)
      use_melhor: Array.from({ length: 20 }, (_, i) => ({
        url: `https://same-domain.com/tutorial-${i}`,
        title: `Tutorial ${i}`,
        category: "tutorial",
      })),
      video: [],
    },
  };

  it("--pool-out grava arquivo com shape { categorized } e conteúdo capado", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "diaria-split-2496-"));
    const chunksDir = join(tmpBase, "scoring-chunks");
    const categorizedPath = join(tmpBase, "categorized.json");
    const poolOutPath = join(tmpBase, "tmp-scoring-pool.json");
    mkdirSync(chunksDir, { recursive: true });
    try {
      writeFileSync(categorizedPath, JSON.stringify(MANY_USE_MELHOR));
      const { stdout } = runSplitMain({ categorizedPath, outDir: chunksDir, poolOut: poolOutPath });

      // O arquivo deve existir
      assert.ok(existsSync(poolOutPath), "--pool-out criou tmp-scoring-pool.json");

      // Shape válido: { categorized: { lancamento, radar, use_melhor, video } }
      const pool = JSON.parse(readFileSync(poolOutPath, "utf8"));
      assert.ok(pool.categorized, "pool-out tem campo categorized");
      assert.ok(Array.isArray(pool.categorized.use_melhor), "pool-out.categorized.use_melhor é array");

      // use_melhor foi capado (maxPerDomain=2): 20 do mesmo domínio → ≤ 2
      assert.ok(
        pool.categorized.use_melhor.length <= 2,
        `pool capado: use_melhor.length=${pool.categorized.use_melhor.length} (esperado ≤ 2 do mesmo domínio)`,
      );

      // manifest inclui pool_out quando flag passado
      const manifest = JSON.parse(stdout.trim());
      // #2496: pool_out é normalizado pra forward-slash (igual chunk_files[]) —
      // comparar contra o path normalizado (no Windows, poolOutPath tem `\`).
      assert.equal(
        manifest.pool_out,
        poolOutPath.replaceAll("\\", "/"),
        "manifest.pool_out aponta pro arquivo gravado (forward-slash normalizado)",
      );

      // total_articles no manifest reflete o pool CAPADO (não o não-capado)
      const poolTotal =
        pool.categorized.lancamento.length +
        pool.categorized.radar.length +
        pool.categorized.use_melhor.length +
        (pool.categorized.video ?? []).length;
      assert.equal(
        manifest.total_articles,
        poolTotal,
        "manifest.total_articles == pool capado (não o não-capado)",
      );
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("sem --pool-out: manifest.pool_out ausente, comportamento inalterado", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "diaria-split-2496-nopool-"));
    const chunksDir = join(tmpBase, "scoring-chunks");
    const categorizedPath = join(tmpBase, "categorized.json");
    mkdirSync(chunksDir, { recursive: true });
    try {
      writeFileSync(categorizedPath, JSON.stringify(MINIMAL_CATEGORIZED));
      const { stdout } = runSplitMain({ categorizedPath, outDir: chunksDir });
      const manifest = JSON.parse(stdout.trim());
      // pool_out não deve aparecer no manifest quando flag não foi passado
      assert.equal(manifest.pool_out, undefined, "sem --pool-out: pool_out ausente no manifest");
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  // #2519 fix: re-split SEM --pool-out deve PRESERVAR tmp-scoring-pool.json
  // pré-existente — sem --pool-out o PASSO 3 não reescreve o arquivo, então
  // deletar aqui o deixaria ausente → merge (1q.3, hardcoda --categorized
  // .../tmp-scoring-pool.json) recebe ENOENT → exit 1 → HALT.
  it("#2519: re-split sem --pool-out PRESERVA tmp-scoring-pool.json pré-existente", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "diaria-split-2519-preserve-"));
    const chunksDir = join(tmpBase, "scoring-chunks");
    const categorizedPath = join(tmpBase, "categorized.json");
    // tmp-scoring-pool.json mora no PARENT de scoring-chunks/ (= _internal/).
    const poolPath = join(tmpBase, "tmp-scoring-pool.json");
    mkdirSync(chunksDir, { recursive: true });
    try {
      // Simula pool fresco de run anterior (ex: produção passa --pool-out,
      // retry manual omite — o pool gerado pela 1ª invocação deve sobreviver).
      writeFileSync(poolPath, JSON.stringify({ categorized: { lancamento: [], radar: [{ url: "pool-url" }], use_melhor: [], video: [] } }));
      writeFileSync(categorizedPath, JSON.stringify(MINIMAL_CATEGORIZED));

      // Re-split SEM --pool-out.
      runSplitMain({ categorizedPath, outDir: chunksDir });

      // O arquivo deve ser PRESERVADO (não deletado sem reescrita).
      assert.ok(
        existsSync(poolPath),
        "#2519: tmp-scoring-pool.json PRESERVADO quando --pool-out não foi passado",
      );
      // Conteúdo intacto (não zerado).
      const pool = JSON.parse(readFileSync(poolPath, "utf8"));
      assert.ok(pool.categorized.radar.some((a: { url: string }) => a.url === "pool-url"),
        "#2519: conteúdo do pool preservado após re-split sem --pool-out");
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  // #2496 review sweep: re-split COM --pool-out sobrescreve com o pool fresco
  // (nao deixa o stale → writeFileSync trunca).
  it("re-split com --pool-out sobrescreve tmp-scoring-pool.json com pool fresco (#2496)", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "diaria-split-2496-fresh-"));
    const chunksDir = join(tmpBase, "scoring-chunks");
    const categorizedPath = join(tmpBase, "categorized.json");
    const poolOutPath = join(tmpBase, "tmp-scoring-pool.json");
    mkdirSync(chunksDir, { recursive: true });
    try {
      // Pool stale de run anterior contendo uma URL que NAO esta no input atual.
      writeFileSync(poolOutPath, JSON.stringify({ categorized: { lancamento: [{ url: "stale-url" }], radar: [], use_melhor: [], video: [] } }));
      writeFileSync(categorizedPath, JSON.stringify(MINIMAL_CATEGORIZED));

      runSplitMain({ categorizedPath, outDir: chunksDir, poolOut: poolOutPath });

      const pool = JSON.parse(readFileSync(poolOutPath, "utf8"));
      const allUrls = [
        ...pool.categorized.lancamento,
        ...pool.categorized.radar,
        ...pool.categorized.use_melhor,
        ...(pool.categorized.video ?? []),
      ].map((a: { url: string }) => a.url);
      assert.ok(!allUrls.includes("stale-url"), "pool fresco nao contem a stale-url do run anterior");
      assert.ok(allUrls.includes("https://example.com/1"), "pool fresco contem a URL do input atual");
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  // #2519 fix (atualiza #2509): mesmo sem scoring-chunks/ pré-existente (fresh
  // edition), sem --pool-out o arquivo pré-existente DEVE SER PRESERVADO.
  // (Antes de #2519, o cleanup era incondicional; agora só apaga quando --pool-out
  // está presente, pois só então o PASSO 3 reescreve o arquivo.)
  it("#2519/#2509: re-split sem --pool-out preserva pool mesmo sem scoring-chunks/ pré-existente", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "diaria-split-2519-nochunkdir-"));
    const chunksDir = join(tmpBase, "scoring-chunks");
    const categorizedPath = join(tmpBase, "categorized.json");
    const poolPath = join(tmpBase, "tmp-scoring-pool.json");
    // NAO criar chunksDir de proposito — o split o cria via mkdirSync.
    try {
      writeFileSync(poolPath, JSON.stringify({ categorized: { lancamento: [], radar: [{ url: "existing-pool" }], use_melhor: [], video: [] } }));
      writeFileSync(categorizedPath, JSON.stringify(MINIMAL_CATEGORIZED));

      runSplitMain({ categorizedPath, outDir: chunksDir });

      assert.ok(
        existsSync(poolPath),
        "#2519: tmp-scoring-pool.json PRESERVADO sem --pool-out (mesmo fresh edition)",
      );
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
