/**
 * test/markdown-primitives-7126.test.ts (#7126, item 6 do plano do #3269)
 *
 * `countDoubleAsterisk`/`isUnpairedBoldMarker`/`scanBalancedParenClose` foram
 * extraídas de `scripts/lib/newsletter-render-html.ts` e
 * `scripts/lib/mensal/monthly-render.ts` (cada uma com cópia byte-idêntica,
 * +`inline-link.ts`/`lint-checks/callout-placement.ts` pro par
 * count/isUnpaired) pra `scripts/lib/shared/markdown-primitives.ts`. Este
 * teste trava:
 *   1. o output das 3 primitivas em si (casos de borda documentados nos
 *      comentários originais — parênteses aninhados, `**` não-sobreposto);
 *   2. que os módulos que antes duplicavam agora resolvem pro MESMO módulo
 *      (nenhum voltou a copiar a lógica).
 *
 * A garantia de que o BYTE do HTML/e-mail renderizado não mudou 1 byte não é
 * feita aqui — é a suíte de goldens existente (`ds-golden-full-render.test.ts`,
 * `ds-golden-components.test.ts`, `monthly-render-*.test.ts`, `inline-link-*
 * .test.ts` etc.) que já cobre isso e passou intocada (nenhum golden precisou
 * de update) depois desta extração.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countDoubleAsterisk,
  isUnpairedBoldMarker,
  scanBalancedParenClose,
} from "../scripts/lib/shared/markdown-primitives.ts";
import { countDoubleAsterisk as calloutCountDoubleAsterisk } from "../scripts/lib/lint-checks/callout-placement.ts";

describe("countDoubleAsterisk (#7126 — shared/markdown-primitives.ts)", () => {
  it("conta pares NÃO sobrepostos — '****' conta como 2, não 3", () => {
    assert.equal(countDoubleAsterisk("****"), 2);
  });

  it("string sem '**' conta 0", () => {
    assert.equal(countDoubleAsterisk("texto plano"), 0);
  });

  it("'**a** e **b**' conta 4", () => {
    assert.equal(countDoubleAsterisk("**a** e **b**"), 4);
  });

  it("lint-checks/callout-placement.ts re-exporta o MESMO helper (back-compat, não uma cópia)", () => {
    assert.equal(calloutCountDoubleAsterisk, countDoubleAsterisk);
  });
});

describe("isUnpairedBoldMarker (#7126)", () => {
  it("contagem PAR (0, 2, ...) no texto adjacente → candidato livre (true)", () => {
    assert.equal(isUnpairedBoldMarker(""), true);
    assert.equal(isUnpairedBoldMarker("**pareado**"), true);
  });

  it("contagem ÍMPAR → candidato já consumido por um marcador anterior (false)", () => {
    assert.equal(isUnpairedBoldMarker("**solto"), false);
  });
});

describe("scanBalancedParenClose (#7126)", () => {
  it("URL simples sem parênteses — fecha no primeiro ')'", () => {
    const s = "https://example.com)resto";
    assert.equal(scanBalancedParenClose(s, 0), "https://example.com".length);
  });

  it("URL com 1 par de parênteses aninhado (ex: PDF '...(1).pdf') — não trunca no ')' interno", () => {
    const s = "https://x.com/arquivo%20(1).pdf)resto";
    const close = scanBalancedParenClose(s, 0);
    assert.equal(s.slice(0, close), "https://x.com/arquivo%20(1).pdf");
  });

  it("sem ')' de fechamento — retorna s.length", () => {
    const s = "https://sem-fechamento.com";
    assert.equal(scanBalancedParenClose(s, 0), s.length);
  });
});
