/**
 * #10908: conflito semântico #10890 × #10892. Submissão do editor cujo
 * enriquecimento falhou com `<title>Found</title>` e resumo "Object moved to
 * here" fica no pool (`categorize`, #10796) marcada `title_unresolved`. Desde
 * o #10881 item 4 a palavra solta "Found" não casa `isPlaceholderHighlightTitle`,
 * e nada lia o marcador: se o `scorer-select` ranqueasse o item alto, ele
 * virava D1 intitulado "Found" — backstop do `assemble-scored` e invariante
 * `no-placeholder-title-highlights` deixavam passar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { categorizeArticles } from "../scripts/categorize.ts";
import {
  demotePlaceholderTitleHighlights,
  isPlaceholderHighlightItem,
  isPlaceholderHighlightTitle,
  isPlaceholderHighlightTitleOrUnresolved,
} from "../scripts/lib/placeholder-title-guard.ts";
import { checkNoPlaceholderTitleHighlights } from "../scripts/lib/invariant-checks/stage-1.ts";
import { needsEnrichment } from "../scripts/enrich-inbox-articles.ts";

const STUB_URL = "https://example.com/artigo-do-editor";

/** Cenário da issue, passando pelo categorize real (não um objeto montado à mão). */
function keptFoundSubmission(): Record<string, unknown> {
  const buckets = categorizeArticles([
    { url: STUB_URL, title: "Found", summary: "Object moved to here", flag: "editor_submitted" },
  ]);
  const kept = Object.values(buckets).flat();
  assert.equal(kept.length, 1, "submissão do editor fica no pool (#10796)");
  assert.equal(kept[0].title_unresolved, "redirect_stub");
  // Pré-condição do bug: o guard só de título não reconhece a palavra solta.
  assert.equal(isPlaceholderHighlightTitle(kept[0].title), false);
  return kept[0] as unknown as Record<string, unknown>;
}

describe("#10908 — title_unresolved barra destaque com título de stub ambíguo", () => {
  it("backstop do assemble-scored demove o D1 'Found' marcado e promove o melhor finalista real", () => {
    const stub = keptFoundSubmission();
    const real = { url: "https://b.com/real", title: "OpenAI lança modelo novo" };
    const highlights = [
      { rank: 1, score: 98, url: STUB_URL, article: stub },
      { rank: 2, score: 80, url: "https://c.com/d2", article: { url: "https://c.com/d2", title: "D2 real" } },
    ];
    const finalists = [
      { url: STUB_URL, score: 98, article: stub },
      { url: real.url, score: 75, article: real },
    ];
    const { highlights: out, demotions } = demotePlaceholderTitleHighlights(highlights, finalists);
    assert.equal(demotions.length, 1);
    assert.equal(demotions[0].demoted_url, STUB_URL);
    assert.equal(demotions[0].promoted_url, real.url);
    assert.equal(out[0].url, real.url);
    assert.ok(!out.some((h) => h.url === STUB_URL));
  });

  it("finalista 'Found' marcado nunca é escolhido como substituto de outro placeholder", () => {
    const stub = keptFoundSubmission();
    const { highlights: out, demotions } = demotePlaceholderTitleHighlights(
      [{ rank: 1, score: 90, url: "https://x.com/i", article: { url: "https://x.com/i", title: "(inbox)" } }],
      [{ url: STUB_URL, score: 99, article: stub }],
    );
    assert.equal(out.length, 0, "sem substituto válido: remove em vez de promover o stub");
    assert.equal(demotions[0].promoted_url, undefined);
  });

  it("invariante no-placeholder-title-highlights acusa o destaque 'Found' marcado em 01-approved.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-10908-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ bucket: "radar", url: STUB_URL, article: keptFoundSubmission() }] }),
      );
      const v = checkNoPlaceholderTitleHighlights(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /artigo-do-editor/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("título corrigido pelo editor no gate não é barrado pelo marcador velho", () => {
    const stub = keptFoundSubmission();
    const fixed = { ...stub, title: "Found: o modelo que acha bugs sozinho" };
    assert.equal(isPlaceholderHighlightItem({ article: fixed }), false);
    const dir = mkdtempSync(join(tmpdir(), "inv-10908-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ bucket: "radar", url: STUB_URL, article: fixed }] }),
      );
      assert.equal(checkNoPlaceholderTitleHighlights(dir).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("'Found' SEM o marcador continua título real (não regride o #10881 item 4)", () => {
    assert.equal(isPlaceholderHighlightTitleOrUnresolved("Found", undefined), false);
    assert.equal(isPlaceholderHighlightItem({ article: { title: "Found" } }), false);
    assert.equal(isPlaceholderHighlightTitleOrUnresolved("Found", "redirect_stub"), true);
    assert.equal(isPlaceholderHighlightTitleOrUnresolved("Moved", "redirect_stub"), true);
    // marcador top-level (highlight sem `article`) também conta
    assert.equal(isPlaceholderHighlightItem({ title: "Redirect", title_unresolved: "redirect_stub" } as never), true);
    // placeholder clássico segue barrado independente do marcador
    assert.equal(isPlaceholderHighlightTitleOrUnresolved("(inbox)", undefined), true);
  });
});

describe("#10908 — enrich-inbox refaz o fetch de submissão com a palavra solta", () => {
  const SUMMARY = "Resumo longo de uma matéria real sobre IA para não depender do summary vazio.";

  it("submissão do inbox com título 'Found'/'Moved'/'Redirect' precisa de enrichment", () => {
    for (const title of ["Found", "Moved", "Redirect"]) {
      assert.equal(
        needsEnrichment({ url: STUB_URL, title, summary: SUMMARY, flag: "editor_submitted" }),
        true,
        title,
      );
    }
  });

  it("fonte regular com título 'Found' e summary não é tratada como placeholder", () => {
    assert.equal(needsEnrichment({ url: STUB_URL, title: "Found", summary: SUMMARY }), false);
  });
});
