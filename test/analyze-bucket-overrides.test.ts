import { describe, it, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffBucketOverrides,
  diffDestaqueMoves,
  analyzeEditionsUnderRoot,
  summarize,
  type CategorizedBucketsInput,
  type ApprovedBucketsInput,
} from "../scripts/analyze-bucket-overrides.ts";

describe("diffBucketOverrides", () => {
  it("detecta movimento radar -> use_melhor quando o editor corrige o bucket", () => {
    const categorized: CategorizedBucketsInput = {
      lancamento: [],
      radar: [{ url: "https://techtudo.com.br/guia/como-treinar-oratoria", title: "Como treinar oratória com ChatGPT" }],
      use_melhor: [],
      video: [],
    };
    const approved: ApprovedBucketsInput = {
      highlights: [],
      runners_up: [],
      lancamento: [],
      radar: [],
      use_melhor: [{ url: "https://techtudo.com.br/guia/como-treinar-oratoria", title: "Como treinar oratória com ChatGPT" }],
      video: [],
    };

    const moves = diffBucketOverrides(categorized, approved);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].direction, "radar->use_melhor");
    assert.equal(moves[0].from, "radar");
    assert.equal(moves[0].to, "use_melhor");
  });

  it("não conta artigo que some dos 3 buckets (promovido a destaque)", () => {
    const categorized: CategorizedBucketsInput = {
      lancamento: [{ url: "https://openai.com/index/thing", title: "Thing" }],
      radar: [],
      use_melhor: [],
      video: [],
    };
    const approved: ApprovedBucketsInput = {
      highlights: [{ url: "https://openai.com/index/thing" }],
      runners_up: [],
      lancamento: [],
      radar: [],
      use_melhor: [],
      video: [],
    };

    const moves = diffBucketOverrides(categorized, approved);
    assert.equal(moves.length, 0);
  });

  it("não conta artigo cujo bucket não mudou", () => {
    const categorized: CategorizedBucketsInput = {
      lancamento: [],
      radar: [{ url: "https://exame.com/piece", title: "Piece" }],
      use_melhor: [],
    };
    const approved: ApprovedBucketsInput = {
      lancamento: [],
      radar: [{ url: "https://exame.com/piece", title: "Piece" }],
      use_melhor: [],
    };

    assert.equal(diffBucketOverrides(categorized, approved).length, 0);
  });

  it("join por URL canonicalizada (trailing slash não quebra o match)", () => {
    const categorized: CategorizedBucketsInput = {
      radar: [{ url: "https://canaltech.com.br/ia/9-aplicacoes", title: "9 aplicações práticas" }],
      use_melhor: [],
      lancamento: [],
    };
    const approved: ApprovedBucketsInput = {
      radar: [],
      use_melhor: [{ url: "https://canaltech.com.br/ia/9-aplicacoes/", title: "9 aplicações práticas" }],
      lancamento: [],
    };

    const moves = diffBucketOverrides(categorized, approved);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].direction, "radar->use_melhor");
  });

  // #8121 item 3: itens recategorizados no STAGE 4 (marcados com
  // `stage4_recategorized_note` em 01-approved.json) não são "correção do
  // gate do Stage 1" — não devem contar na taxa medida por esta função.
  it("#8121: item com stage4_recategorized_note NÃO conta como movimento (recategorização do Stage 4, não do gate Stage 1)", () => {
    const categorized: CategorizedBucketsInput = {
      lancamento: [],
      radar: [{ url: "https://example.com/artigo-x", title: "Artigo X" }],
      use_melhor: [],
      video: [],
    };
    const approved: ApprovedBucketsInput = {
      highlights: [],
      runners_up: [],
      lancamento: [
        {
          url: "https://example.com/artigo-x",
          title: "Artigo X",
          stage4_recategorized_note: "movido pelo editor no Stage 4, edição 260915",
        },
      ],
      radar: [],
      use_melhor: [],
      video: [],
    };

    const moves = diffBucketOverrides(categorized, approved);
    assert.deepEqual(moves, [], "item com stage4_recategorized_note não deveria gerar BucketMove");
  });

  it("#8121: item SEM stage4_recategorized_note continua contando normalmente (regressão — a exclusão é seletiva, não desliga a métrica inteira)", () => {
    const categorized: CategorizedBucketsInput = {
      lancamento: [],
      radar: [
        { url: "https://example.com/artigo-x", title: "Artigo X" },
        { url: "https://example.com/artigo-y", title: "Artigo Y" },
      ],
      use_melhor: [],
      video: [],
    };
    const approved: ApprovedBucketsInput = {
      highlights: [],
      runners_up: [],
      lancamento: [
        { url: "https://example.com/artigo-x", title: "Artigo X", stage4_recategorized_note: "Stage 4" },
        { url: "https://example.com/artigo-y", title: "Artigo Y" }, // sem o marcador — conta normalmente
      ],
      radar: [],
      use_melhor: [],
      video: [],
    };

    const moves = diffBucketOverrides(categorized, approved);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].url, "https://example.com/artigo-y");
  });
});

describe("summarize", () => {
  it("agrega direções e conta edições com movimento", () => {
    const editionMoves = [
      {
        edition: "260807",
        moves: [
          { url: "a", title: "A", from: "radar" as const, to: "use_melhor" as const, direction: "radar->use_melhor" },
          { url: "b", title: "B", from: "lancamento" as const, to: "radar" as const, direction: "lancamento->radar" },
        ],
      },
      { edition: "260808", moves: [] },
    ];

    const summary = summarize(editionMoves, 5);
    assert.equal(summary.editionsScanned, 2);
    assert.equal(summary.editionsWithMoves, 1);
    assert.equal(summary.totalMoves, 2);
    // todas as 6 direções ordenadas aparecem, mesmo com contagem 0
    assert.equal(summary.directions.length, 6);
    const radarToUseMelhor = summary.directions.find((d) => d.direction === "radar->use_melhor");
    assert.equal(radarToUseMelhor?.count, 1);
  });

  it("#8233 — destaqueMoves ausente (edição de antes do fix) não quebra: conta como 0 promoções/rebaixamentos", () => {
    const editionMoves = [{ edition: "260807", moves: [] }];
    const summary = summarize(editionMoves, 5);
    assert.equal(summary.destaque.total, 0);
    assert.equal(summary.destaque.promotions, 0);
    assert.equal(summary.destaque.demotions, 0);
    assert.equal(summary.destaque.editionsWithDestaqueMove, 0);
  });

  it("#8233 — agrega promoções e rebaixamentos de destaqueMoves, separado da matriz de bucket", () => {
    const editionMoves = [
      {
        edition: "260807",
        moves: [],
        destaqueMoves: [
          { url: "a", title: "A", direction: "promote" as const },
          { url: "b", title: "B", direction: "demote" as const },
          { url: "c", title: "C", direction: "promote" as const },
        ],
      },
      { edition: "260808", moves: [], destaqueMoves: [] },
    ];
    const summary = summarize(editionMoves, 5);
    assert.equal(summary.destaque.promotions, 2);
    assert.equal(summary.destaque.demotions, 1);
    assert.equal(summary.destaque.total, 3);
    assert.equal(summary.destaque.editionsWithDestaqueMove, 1);
    assert.equal(summary.destaque.promoteExamples.length, 2);
    assert.equal(summary.destaque.demoteExamples.length, 1);
    // a matriz de bucket original continua zerada — os dois fenômenos não se misturam
    assert.equal(summary.totalMoves, 0);
  });
});

describe("diffDestaqueMoves (#8233 — cruzada POOL↔destaque, ponto cego que a #5995 mediu em 11/25 edições)", () => {
  it("URL que sai do pool (categorizado) e entra em highlights (aprovado) é 'promote'", () => {
    const categorized: CategorizedBucketsInput = {
      radar: [{ url: "https://exemplo.com/a", title: "Notícia A" }],
    };
    const approved: ApprovedBucketsInput = {
      highlights: [{ url: "https://exemplo.com/a", title: "Notícia A promovida" }],
    };
    const moves = diffDestaqueMoves(categorized, approved);
    assert.deepEqual(moves, [{ url: "https://exemplo.com/a", title: "Notícia A promovida", direction: "promote" }]);
  });

  it("URL que sai de highlights (categorizado) e entra no pool (aprovado) é 'demote'", () => {
    const categorized: CategorizedBucketsInput = {
      highlights: [{ url: "https://exemplo.com/b", title: "Notícia B" }],
    };
    const approved: ApprovedBucketsInput = {
      use_melhor: [{ url: "https://exemplo.com/b", title: "Notícia B rebaixada" }],
    };
    const moves = diffDestaqueMoves(categorized, approved);
    assert.deepEqual(moves, [{ url: "https://exemplo.com/b", title: "Notícia B rebaixada", direction: "demote" }]);
  });

  it("URL em highlights nos DOIS lados não conta como movimento", () => {
    const categorized: CategorizedBucketsInput = {
      highlights: [{ url: "https://exemplo.com/c", title: "Notícia C" }],
    };
    const approved: ApprovedBucketsInput = {
      highlights: [{ url: "https://exemplo.com/c", title: "Notícia C" }],
    };
    assert.deepEqual(diffDestaqueMoves(categorized, approved), []);
  });

  it("URL que sai do pool mas não aparece em highlights do aprovado (cortada de verdade) não conta como destaqueMove", () => {
    const categorized: CategorizedBucketsInput = {
      radar: [{ url: "https://exemplo.com/d", title: "Notícia D" }],
    };
    const approved: ApprovedBucketsInput = {};
    assert.deepEqual(diffDestaqueMoves(categorized, approved), []);
  });

  it("movimento DENTRO do pool (radar->use_melhor) nunca aparece aqui — é diffBucketOverrides, não isto", () => {
    const categorized: CategorizedBucketsInput = {
      radar: [{ url: "https://exemplo.com/e", title: "Notícia E" }],
    };
    const approved: ApprovedBucketsInput = {
      use_melhor: [{ url: "https://exemplo.com/e", title: "Notícia E" }],
    };
    // Sem highlights em nenhum dos dois lados — a URL nunca cruza a
    // fronteira pool<->destaque, então diffDestaqueMoves não reporta nada
    // (mesmo movimento que diffBucketOverrides já cobre).
    assert.deepEqual(diffDestaqueMoves(categorized, approved), []);
  });

  it("URL em highlights via article.url (shape de 01-categorized.json) é reconhecida igual a url direto", () => {
    const categorized: CategorizedBucketsInput = {
      highlights: [{ article: { url: "https://exemplo.com/f", title: "Notícia F" } }],
    };
    const approved: ApprovedBucketsInput = {
      radar: [{ url: "https://exemplo.com/f", title: "Notícia F rebaixada" }],
    };
    const moves = diffDestaqueMoves(categorized, approved);
    assert.deepEqual(moves, [{ url: "https://exemplo.com/f", title: "Notícia F rebaixada", direction: "demote" }]);
  });
});

describe("analyzeEditionsUnderRoot", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function makeEditionsRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "bucket-overrides-"));
    dirs.push(root);
    return root;
  }

  it("varre múltiplas edições e ignora as sem os dois arquivos", () => {
    const root = makeEditionsRoot();

    // Edição 1: tem os dois arquivos, com 1 movimento.
    const ed1Internal = join(root, "260807", "_internal");
    mkdirSync(ed1Internal, { recursive: true });
    writeFileSync(
      join(ed1Internal, "01-categorized.json"),
      JSON.stringify({
        lancamento: [],
        radar: [{ url: "https://techtudo.com.br/guia/x", title: "Como fazer X" }],
        use_melhor: [],
        video: [],
      }),
    );
    writeFileSync(
      join(ed1Internal, "01-approved.json"),
      JSON.stringify({
        highlights: [],
        runners_up: [],
        lancamento: [],
        radar: [],
        use_melhor: [{ url: "https://techtudo.com.br/guia/x", title: "Como fazer X" }],
        video: [],
      }),
    );

    // Edição 2: só tem categorized (sem gate ainda) — deve ser pulada.
    const ed2Internal = join(root, "260808", "_internal");
    mkdirSync(ed2Internal, { recursive: true });
    writeFileSync(join(ed2Internal, "01-categorized.json"), JSON.stringify({ lancamento: [], radar: [], use_melhor: [] }));

    // Diretório que não é edição (não bate no padrão AAMMDD) — ignorado.
    mkdirSync(join(root, "_arquivo"), { recursive: true });

    const result = analyzeEditionsUnderRoot(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].edition, "260807");
    assert.equal(result[0].moves.length, 1);
    // #8233 — sem highlights nos fixtures acima, destaqueMoves fica vazio
    // (não populado com undefined/ausente — é sempre um array).
    assert.deepEqual(result[0].destaqueMoves, []);
  });

  it("#8233 — popula destaqueMoves quando o categorizado/aprovado tem highlights cruzando com o pool", () => {
    const root = makeEditionsRoot();
    const edInternal = join(root, "260907", "_internal");
    mkdirSync(edInternal, { recursive: true });
    writeFileSync(
      join(edInternal, "01-categorized.json"),
      JSON.stringify({
        lancamento: [],
        radar: [{ url: "https://exemplo.com/promovida", title: "História promovida" }],
        use_melhor: [],
        video: [],
        highlights: [],
      }),
    );
    writeFileSync(
      join(edInternal, "01-approved.json"),
      JSON.stringify({
        highlights: [{ url: "https://exemplo.com/promovida", title: "História promovida" }],
        runners_up: [],
        lancamento: [],
        radar: [],
        use_melhor: [],
        video: [],
      }),
    );

    const result = analyzeEditionsUnderRoot(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].moves.length, 0);
    assert.deepEqual(result[0].destaqueMoves, [
      { url: "https://exemplo.com/promovida", title: "História promovida", direction: "promote" },
    ]);
  });

  it("retorna [] quando o diretório de edições não existe", () => {
    const missing = join(tmpdir(), "does-not-exist-bucket-overrides-" + Date.now());
    assert.deepEqual(analyzeEditionsUnderRoot(missing), []);
  });

  function writeEditionFiles(editionDir: string): void {
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      join(editionDir, "_internal", "01-categorized.json"),
      JSON.stringify({ lancamento: [], radar: [{ url: "https://a.com/x", title: "X" }], use_melhor: [], video: [] }),
    );
    writeFileSync(
      join(editionDir, "_internal", "01-approved.json"),
      JSON.stringify({
        highlights: [],
        runners_up: [],
        lancamento: [],
        radar: [],
        use_melhor: [{ url: "https://a.com/x", title: "X" }],
        video: [],
      }),
    );
  }

  it("varre pastas de mês YYMM com subpastas de edição AAMMDD aninhadas", () => {
    const root = makeEditionsRoot();
    writeEditionFiles(join(root, "2608", "260810"));
    writeEditionFiles(join(root, "2608", "260811"));
    writeEditionFiles(join(root, "2609", "260901"));

    const result = analyzeEditionsUnderRoot(root);
    assert.deepEqual(
      result.map((r) => r.edition).sort(),
      ["260810", "260811", "260901"],
    );
    for (const r of result) assert.equal(r.moves.length, 1);
  });

  it("varre formato legado (AAMMDD solta na raiz) e formato YYMM aninhado juntos, sem dupla-contagem", () => {
    const root = makeEditionsRoot();
    writeEditionFiles(join(root, "260708")); // legado, solto na raiz
    writeEditionFiles(join(root, "2608", "260810")); // aninhado sob mês

    const result = analyzeEditionsUnderRoot(root);
    assert.deepEqual(
      result.map((r) => r.edition).sort(),
      ["260708", "260810"],
    );
  });

  it("ignora pastas replay-* mesmo que contenham os arquivos esperados", () => {
    const root = makeEditionsRoot();
    writeEditionFiles(join(root, "260810")); // edição real
    writeEditionFiles(join(root, "replay-scorer-a")); // artefato de replay/debug — não é edição
    writeEditionFiles(join(root, "replay-stage1-b"));

    const result = analyzeEditionsUnderRoot(root);
    assert.deepEqual(
      result.map((r) => r.edition),
      ["260810"],
    );
  });

  it("ignora pastas dentro de um diretório YYMM que não batem no padrão AAMMDD", () => {
    const root = makeEditionsRoot();
    writeEditionFiles(join(root, "2608", "260810"));
    mkdirSync(join(root, "2608", "_scratch"), { recursive: true });

    const result = analyzeEditionsUnderRoot(root);
    assert.deepEqual(
      result.map((r) => r.edition),
      ["260810"],
    );
  });
});
