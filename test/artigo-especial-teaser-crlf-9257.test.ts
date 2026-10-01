/**
 * #9257 — fonte `articles-src/{slug}.html` salva no Windows (CRLF) gerava
 * `{slug}-full.generated.ts` com `\r\n` embutido; o Git normaliza o .html
 * pra LF no commit e o teste de drift quebrava no CI.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ARTICLES,
  articleSourcePath,
  buildArticleArtifacts,
  renderGeneratedTsModule,
} from "../scripts/build-artigo-especial-teaser.ts";

describe("build-artigo-especial-teaser: fonte CRLF (#9257)", () => {
  const article = ARTICLES[0];
  const lf = readFileSync(articleSourcePath(article), "utf8").replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");

  it("fonte CRLF produz exatamente os mesmos artefatos da fonte LF", () => {
    const fromLf = buildArticleArtifacts(lf, article);
    const fromCrlf = buildArticleArtifacts(crlf, article);
    assert.equal(fromCrlf.full, fromLf.full);
    assert.equal(fromCrlf.teaser, fromLf.teaser);
  });

  it("nenhum \\r no .generated.ts nem no teaser gerados a partir de fonte CRLF", () => {
    const fromCrlf = buildArticleArtifacts(crlf, article);
    assert.ok(!fromCrlf.teaser.includes("\r"));
    assert.ok(!renderGeneratedTsModule(article, fromCrlf.full).includes("\r"));
  });
});
