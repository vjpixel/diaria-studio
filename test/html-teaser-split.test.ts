/**
 * test/html-teaser-split.test.ts (#7030)
 *
 * Cobre o corte de teaser no servidor — a peça pura de
 * `scripts/lib/shared/html-teaser-split.ts`. Regressão de "gate de mentira"
 * (#7030): garante que o teaser NUNCA contém o texto que vem depois do
 * marcador, e que o documento resultante é HTML fechado (div balanceado).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GATE_CUT_MARKER,
  splitAtMarker,
  countUnclosedDivs,
  buildTeaserDocument,
} from "../scripts/lib/shared/html-teaser-split.ts";

describe("splitAtMarker (#7030)", () => {
  it("divide corretamente em before/after, sem incluir o marcador em nenhum dos dois", () => {
    const html = `<p>abertura</p>${GATE_CUT_MARKER}<p>pago</p>`;
    const result = splitAtMarker(html);
    assert.ok(result);
    assert.equal(result!.before, "<p>abertura</p>");
    assert.equal(result!.after, "<p>pago</p>");
    assert.equal(result!.before.includes(GATE_CUT_MARKER), false);
  });

  it("retorna null quando o marcador não existe — nunca corta 'no meio' por acidente", () => {
    const html = "<p>sem marcador nenhum</p>";
    assert.equal(splitAtMarker(html), null);
  });
});

describe("countUnclosedDivs (#7030)", () => {
  it("conta divs abertos sem fechamento correspondente", () => {
    assert.equal(countUnclosedDivs("<div><div><p>x</p></div>"), 1);
  });

  it("zero quando tudo está balanceado", () => {
    assert.equal(countUnclosedDivs("<div><p>x</p></div>"), 0);
  });

  it("nunca vai negativo (mais fechamentos que aberturas não deveria acontecer, mas não lança)", () => {
    assert.equal(countUnclosedDivs("</div></div>"), 0);
  });
});

describe("buildTeaserDocument (#7030) — REGRESSÃO: teaser nunca vaza o conteúdo pago", () => {
  it("o teaser NUNCA contém texto que vinha depois do marcador no source", () => {
    const source = `<div class="sheet"><div class="manuscript"><p>gratis</p>${GATE_CUT_MARKER}<p>SEGREDO PAGO</p></div></div>`;
    const split = splitAtMarker(source)!;
    const teaser = buildTeaserDocument(split.before, "<div>CTA</div>");
    assert.equal(teaser.includes("SEGREDO PAGO"), false);
    assert.equal(teaser.includes("gratis"), true);
    assert.equal(teaser.includes("CTA"), true);
  });

  it("fecha todos os <div> abertos antes do corte (documento bem-formado)", () => {
    const before = '<div class="a"><div class="b"><p>x</p>';
    const teaser = buildTeaserDocument(before, "<div>cta</div>");
    const opens = (teaser.match(/<div\b/gi) ?? []).length;
    const closes = (teaser.match(/<\/div>/gi) ?? []).length;
    assert.equal(opens, closes);
    assert.match(teaser, /<\/body>\s*<\/html>\s*$/);
  });
});
