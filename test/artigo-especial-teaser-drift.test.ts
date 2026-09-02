/**
 * test/artigo-especial-teaser-drift.test.ts (#7030)
 *
 * Garante que os 2 artefatos gerados pra cada Artigo Especial —
 * `workers/artigos/public/{ano}/{slug}/index.html` (teaser) e
 * `workers/artigos/src/{slug}-full.generated.ts` (conteúdo completo) —
 * refletem a fonte canônica em `workers/artigos/articles-src/{slug}.html`.
 * Mesmo espírito de `test/cursos-full-drift.test.ts` (#4052).
 *
 * Fix do drift: `npx tsx scripts/build-artigo-especial-teaser.ts`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import {
  ARTICLES,
  articleSourcePath,
  publicHtmlPath,
  generatedTsPath,
  buildArticleArtifacts,
  renderGeneratedTsModule,
  checkDrift,
} from "../scripts/build-artigo-especial-teaser.ts";
import { GATE_CUT_MARKER } from "../scripts/lib/shared/html-teaser-split.ts";

describe("artigo especial teaser/full gerados (#7030)", () => {
  it("checkDrift() não acusa nada — artefatos committed refletem a fonte", () => {
    const drift = checkDrift();
    assert.deepEqual(drift, [], JSON.stringify(drift));
  });

  for (const article of ARTICLES) {
    describe(article.slug, () => {
      it("articles-src/{slug}.html existe e contém o marcador de corte", () => {
        const srcPath = articleSourcePath(article);
        assert.ok(existsSync(srcPath), `${srcPath} ausente`);
        const source = readFileSync(srcPath, "utf8");
        assert.ok(source.includes(GATE_CUT_MARKER), "marcador ausente na fonte");
      });

      it("o teaser committed bate com um build fresco da fonte", () => {
        const source = readFileSync(articleSourcePath(article), "utf8");
        const fresh = buildArticleArtifacts(source, article);
        const actualTeaser = readFileSync(publicHtmlPath(article), "utf8");
        assert.equal(actualTeaser, fresh.teaser);
      });

      it("o .generated.ts committed bate com um build fresco da fonte", () => {
        const source = readFileSync(articleSourcePath(article), "utf8");
        const fresh = buildArticleArtifacts(source, article);
        const expected = renderGeneratedTsModule(article, fresh.full);
        const actual = readFileSync(generatedTsPath(article), "utf8");
        assert.equal(actual, expected);
      });

      it("REGRESSÃO CENTRAL (#7030): o teaser committed NÃO contém o texto completo do artigo", () => {
        const source = readFileSync(articleSourcePath(article), "utf8");
        const split = source.split(GATE_CUT_MARKER);
        assert.equal(split.length, 2, "marcador precisa aparecer exatamente 1x na fonte");
        const afterMarker = split[1].trim();
        // Pega um trecho não-trivial do conteúdo pago (depois do 1º parágrafo
        // após o marcador) e garante que ele NÃO aparece no teaser servido.
        const firstPaidParagraph = afterMarker.match(/<p[^>]*>([^<]{40,})/);
        assert.ok(firstPaidParagraph, "não achou um parágrafo pago pra usar como sonda");
        const teaser = readFileSync(publicHtmlPath(article), "utf8");
        assert.equal(teaser.includes(firstPaidParagraph![1]), false, "teaser vazou conteúdo pago");
      });

      it("o .generated.ts (full) CONTÉM o conteúdo pago que o teaser omite", () => {
        const source = readFileSync(articleSourcePath(article), "utf8");
        const afterMarker = source.split(GATE_CUT_MARKER)[1];
        const firstPaidParagraph = afterMarker.match(/<p[^>]*>([^<]{40,})/);
        assert.ok(firstPaidParagraph);
        const generated = readFileSync(generatedTsPath(article), "utf8");
        assert.equal(generated.includes(firstPaidParagraph![1]), true);
      });
    });
  }
});
