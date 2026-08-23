import { describe, it, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffBucketOverrides,
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
