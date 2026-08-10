import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractHighlightUrl,
  extractHighlightArticle,
  buildScoredUrlSet,
  classifyOrigin,
  diagnoseEdition,
  makeSourceFailureLookup,
  renderReport,
  runDiagnosis,
  type OriginContext,
  type ApprovedJsonLike,
  type ScoredJsonLike,
} from "../scripts/diagnose-unscored-highlights.ts";

function fixedCtx(overrides: Partial<OriginContext> = {}): OriginContext {
  return {
    activeSourceNames: new Set(["TechCrunch"]),
    sourceFailedThisEdition: () => false,
    ...overrides,
  };
}

describe("extractHighlightUrl", () => {
  it("resolve shape flat (url direto)", () => {
    assert.equal(extractHighlightUrl({ url: "https://a.com/x" }), "https://a.com/x");
  });
  it("resolve shape nested (article.url)", () => {
    assert.equal(
      extractHighlightUrl({ article: { url: "https://a.com/y" } }),
      "https://a.com/y",
    );
  });
  it("nested tem prioridade sobre flat quando ambos presentes", () => {
    assert.equal(
      extractHighlightUrl({ url: "https://flat.com", article: { url: "https://nested.com" } }),
      "https://nested.com",
    );
  });
  it("undefined quando nenhum url presente", () => {
    assert.equal(extractHighlightUrl({}), undefined);
  });
});

describe("extractHighlightArticle", () => {
  it("retorna article aninhado quando presente", () => {
    const h = { article: { url: "https://a.com", source: "X" } };
    assert.deepEqual(extractHighlightArticle(h), { url: "https://a.com", source: "X" });
  });
  it("retorna o próprio highlight quando flat", () => {
    const h = { url: "https://a.com", source: "X" };
    assert.deepEqual(extractHighlightArticle(h), h);
  });
});

describe("buildScoredUrlSet", () => {
  it("canonicaliza URLs de all_scored", () => {
    const set = buildScoredUrlSet({ all_scored: [{ url: "https://A.com/x?utm_source=y", score: 80 }] });
    assert.ok(set!.has("https://a.com/x"));
  });
  it("retorna null quando all_scored ausente/inválido (edição sem dado)", () => {
    assert.equal(buildScoredUrlSet({}), null);
    assert.equal(buildScoredUrlSet(null), null);
  });
  it("Set vazio quando all_scored é array vazio (edição com dado, 0 scored — não confundir com null)", () => {
    const set = buildScoredUrlSet({ all_scored: [] });
    assert.notEqual(set, null);
    assert.equal(set!.size, 0);
  });
});

describe("classifyOrigin", () => {
  it("editor_submitted:true -> inbox", () => {
    assert.equal(
      classifyOrigin({ editor_submitted: true, source: "TechCrunch" }, "260101", fixedCtx()),
      "inbox",
    );
  });
  it("discovered_source:true -> discovery_open_query", () => {
    assert.equal(
      classifyOrigin({ discovered_source: true }, "260101", fixedCtx()),
      "discovery_open_query",
    );
  });
  it("source fora do seed atual -> source_outside_seed", () => {
    assert.equal(
      classifyOrigin({ source: "Blog Desconhecido" }, "260101", fixedCtx()),
      "source_outside_seed",
    );
  });
  it("source cadastrada + falha logada naquele dia -> registered_source_failed_that_day", () => {
    const ctx = fixedCtx({ sourceFailedThisEdition: (name, ed) => name === "TechCrunch" && ed === "260101" });
    assert.equal(
      classifyOrigin({ source: "TechCrunch" }, "260101", ctx),
      "registered_source_failed_that_day",
    );
  });
  it("source cadastrada + sem falha logada -> registered_source_pool_gap", () => {
    assert.equal(
      classifyOrigin({ source: "TechCrunch" }, "260101", fixedCtx()),
      "registered_source_pool_gap",
    );
  });
  it("sem source/editor_submitted/discovered_source -> unknown_origin", () => {
    assert.equal(classifyOrigin({}, "260101", fixedCtx()), "unknown_origin");
  });
  it("editor_submitted tem prioridade sobre source", () => {
    assert.equal(
      classifyOrigin({ editor_submitted: true, source: "Blog Desconhecido" }, "260101", fixedCtx()),
      "inbox",
    );
  });
});

describe("diagnoseEdition", () => {
  const ctx = fixedCtx();

  it("marca edição como skipped quando approved.json ausente", () => {
    const r = diagnoseEdition("260101", null, { all_scored: [] }, ctx);
    assert.equal(r.skipped, "approved_json_missing_or_invalid");
    assert.equal(r.unscored.length, 0);
  });

  it("marca edição como skipped quando tmp-scored.json ausente", () => {
    const approved: ApprovedJsonLike = { highlights: [{ rank: 1, url: "https://a.com" }] };
    const r = diagnoseEdition("260101", approved, null, ctx);
    assert.equal(r.skipped, "scored_json_missing_or_invalid");
  });

  it("highlight presente em all_scored não conta como caso", () => {
    const approved: ApprovedJsonLike = {
      highlights: [{ rank: 1, url: "https://a.com/x" }],
    };
    const scored: ScoredJsonLike = { all_scored: [{ url: "https://a.com/x", score: 70 }] };
    const r = diagnoseEdition("260101", approved, scored, ctx);
    assert.equal(r.unscored.length, 0);
    assert.equal(r.highlights_total, 1);
  });

  it("highlight AUSENTE de all_scored vira caso classificado", () => {
    const approved: ApprovedJsonLike = {
      highlights: [
        { rank: 1, url: "https://a.com/x", article: { source: "TechCrunch" } },
        { rank: 2, url: "https://b.com/y", article: { editor_submitted: true } },
      ],
    };
    const scored: ScoredJsonLike = { all_scored: [{ url: "https://other.com", score: 50 }] };
    const r = diagnoseEdition("260101", approved, scored, ctx);
    assert.equal(r.unscored.length, 2);
    assert.equal(r.unscored[0].origin, "registered_source_pool_gap");
    assert.equal(r.unscored[1].origin, "inbox");
  });

  it("canonicaliza antes de comparar (utm_source não conta como divergência)", () => {
    const approved: ApprovedJsonLike = {
      highlights: [{ rank: 1, url: "https://a.com/x?utm_source=foo" }],
    };
    const scored: ScoredJsonLike = { all_scored: [{ url: "https://a.com/x" }] };
    const r = diagnoseEdition("260101", approved, scored, ctx);
    assert.equal(r.unscored.length, 0);
  });
});

describe("makeSourceFailureLookup", () => {
  let dir: string;

  function withTmpDir(fn: (dir: string) => void): void {
    dir = mkdtempSync(join(tmpdir(), "diag-source-log-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("detecta fail/timeout logado na edição exata", () => {
    withTmpDir((d) => {
      writeFileSync(
        join(d, "techcrunch.jsonl"),
        [
          JSON.stringify({ edition: "260101", outcome: "fail" }),
          JSON.stringify({ edition: "260102", outcome: "ok" }),
        ].join("\n") + "\n",
      );
      const lookup = makeSourceFailureLookup(d);
      assert.equal(lookup("TechCrunch", "260101"), true);
      assert.equal(lookup("TechCrunch", "260102"), false);
      assert.equal(lookup("TechCrunch", "260103"), false);
    });
  });

  it("outcome 'empty' não conta como falha (isHardFailure)", () => {
    withTmpDir((d) => {
      writeFileSync(join(d, "techcrunch.jsonl"), JSON.stringify({ edition: "260101", outcome: "empty" }) + "\n");
      const lookup = makeSourceFailureLookup(d);
      assert.equal(lookup("TechCrunch", "260101"), false);
    });
  });

  it("fonte sem log -> false, nunca lança", () => {
    withTmpDir((d) => {
      const lookup = makeSourceFailureLookup(d);
      assert.equal(lookup("Fonte Inexistente", "260101"), false);
    });
  });

  it("linha corrompida no jsonl não derruba o parse das demais", () => {
    withTmpDir((d) => {
      writeFileSync(
        join(d, "techcrunch.jsonl"),
        ["not-json", JSON.stringify({ edition: "260101", outcome: "timeout" })].join("\n") + "\n",
      );
      const lookup = makeSourceFailureLookup(d);
      assert.equal(lookup("TechCrunch", "260101"), true);
    });
  });
});

describe("renderReport", () => {
  it("computa taxa e agrupa por origem, exclui skipped do denominador", () => {
    const report = renderReport([
      {
        edition: "260101",
        highlights_total: 2,
        unscored: [
          { edition: "260101", rank: 1, url: "https://a.com", origin: "inbox" },
          { edition: "260101", rank: 2, url: "https://b.com", origin: "unknown_origin" },
        ],
      },
      { edition: "260102", highlights_total: 0, unscored: [], skipped: "approved_json_missing_or_invalid" },
    ]);
    assert.match(report, /2 destaque\(s\) avaliado\(s\)/);
    assert.match(report, /100\.0%/);
    assert.match(report, /Edições excluídas da amostra/);
    assert.match(report, /260102/);
  });

  it("não quebra com lista vazia", () => {
    const report = renderReport([]);
    assert.match(report, /0 destaque\(s\) avaliado\(s\)/);
  });
});

describe("runDiagnosis (integração via fixture em disco)", () => {
  it("varre editions-dir e produz resultado consistente", () => {
    const root = mkdtempSync(join(tmpdir(), "diag-run-"));
    try {
      const editionsDir = join(root, "editions");
      const edDir = join(editionsDir, "260101", "_internal");
      mkdirSync(edDir, { recursive: true });
      writeFileSync(
        join(edDir, "01-approved.json"),
        JSON.stringify({
          highlights: [
            { rank: 1, url: "https://scored.com/a" },
            { rank: 2, url: "https://unscored.com/b", article: { discovered_source: true } },
          ],
        }),
      );
      writeFileSync(
        join(edDir, "tmp-scored.json"),
        JSON.stringify({ all_scored: [{ url: "https://scored.com/a", score: 60 }] }),
      );

      const sourcesMdPath = join(root, "sources.md");
      writeFileSync(sourcesMdPath, "### TechCrunch\n- URL: https://techcrunch.com\n");

      const sourcesLogDir = join(root, "sources-log");
      mkdirSync(sourcesLogDir, { recursive: true });

      const results = runDiagnosis({ editionsDir, sourcesMdPath, sourcesLogDir });
      assert.equal(results.length, 1);
      assert.equal(results[0].edition, "260101");
      assert.equal(results[0].unscored.length, 1);
      assert.equal(results[0].unscored[0].origin, "discovery_open_query");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sources-md ausente não quebra (Set de fontes ativas vazio)", () => {
    const root = mkdtempSync(join(tmpdir(), "diag-run-nomd-"));
    try {
      const editionsDir = join(root, "editions");
      mkdirSync(editionsDir, { recursive: true });
      const results = runDiagnosis({
        editionsDir,
        sourcesMdPath: join(root, "does-not-exist.md"),
        sourcesLogDir: join(root, "does-not-exist-dir"),
      });
      assert.equal(results.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
