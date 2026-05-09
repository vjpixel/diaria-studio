import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression test (#1031): tipo local de lint-newsletter-md.ts deve ter
 * `url?: string` (optional) pra ser compatível com central ApprovedJsonSchema.
 *
 * Bug original (PR #1030): tipo local declarava `url: string` (required), e
 * passar resultado de `parseApprovedJson` (url optional) quebrava typecheck.
 *
 * Inspeção estática: garante que o type stays loose, evitando regressão.
 */

const SRC = readFileSync(
  resolve(import.meta.dirname, "..", "scripts", "lint-newsletter-md.ts"),
  "utf8",
);

describe("lint-newsletter-md tipos (#1031 regression)", () => {
  it("ApprovedArticle.url é optional (matches central schema)", () => {
    // Procura `url?: string` ou `url\?: string`
    const interfaceMatch = SRC.match(/interface ApprovedArticle\s*\{[\s\S]*?\}/);
    assert.ok(interfaceMatch, "interface ApprovedArticle deve existir");
    const body = interfaceMatch[0];
    assert.match(
      body,
      /url\?:\s*string/,
      "ApprovedArticle.url deve ser optional (url?: string) pra compatibilidade com parseApprovedJson",
    );
    assert.doesNotMatch(
      body,
      /^\s*url:\s*string\s*;/m,
      "ApprovedArticle.url NÃO deve ser required (url: string) — quebra typecheck quando passa parseApprovedJson",
    );
  });

  it("smoke-test usa parseApprovedJson (não JSON.parse direto)", () => {
    const smokeSrc = readFileSync(
      resolve(import.meta.dirname, "..", "scripts", "smoke-test.ts"),
      "utf8",
    );
    assert.match(
      smokeSrc,
      /parseApprovedJson\s*\(/,
      "smoke-test deve usar parseApprovedJson em vez de JSON.parse direto",
    );
  });
});
