/**
 * test/lint-newsletter-md-section-counts.test.ts (#907)
 *
 * Cobre `checkSectionCounts` (helper puro) + `--check section-counts` (CLI).
 * Reproduz o caso 260507: 9 itens em OUTRAS NOTÍCIAS quando cap esperado
 * era 4.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkSectionCounts,
  countItemsPerSection,
} from "../scripts/lint-newsletter-md.ts";

describe("countItemsPerSection (#907)", () => {
  it("conta itens distintos por seção (deduplica markdown link [url](url))", () => {
    const md = [
      "LANÇAMENTOS",
      "[A](https://a.com)",
      "Desc A",
      "",
      "[B](https://b.com)",
      "Desc B",
      "",
      "---",
      "PESQUISAS",
      "Paper 1",
      "https://arxiv.org/1",
      "",
      "---",
      "OUTRAS NOTÍCIAS",
      "Item 1",
      "https://n.com/1",
      "",
      "Item 2",
      "https://n.com/2",
    ].join("\n");
    const c = countItemsPerSection(md);
    assert.equal(c.lancamento, 2);
    assert.equal(c.pesquisa, 1);
    assert.equal(c.noticias, 2);
  });

  it("seções vazias retornam 0", () => {
    const md = "DESTAQUE 1 | PRODUTO\n\nhttps://x.com/1\n\nTexto.\n";
    const c = countItemsPerSection(md);
    assert.equal(c.lancamento, 0);
    assert.equal(c.pesquisa, 0);
    assert.equal(c.noticias, 0);
  });
});

describe("checkSectionCounts (#907)", () => {
  it("ok=true quando todas seções respeitam cap", () => {
    const md = [
      "LANÇAMENTOS",
      "https://l.com/1",
      "",
      "---",
      "PESQUISAS",
      "https://p.com/1",
      "",
      "---",
      "OUTRAS NOTÍCIAS",
      "https://n.com/1",
      "",
      "https://n.com/2",
    ].join("\n");
    const approved = {
      highlights: [{ url: "h1" }, { url: "h2" }, { url: "h3" }],
    };
    const r = checkSectionCounts(md, approved);
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
  });

  it("ok=false quando OUTRAS NOTÍCIAS passa cap (caso 260507: 9 > 4)", () => {
    const lines = ["OUTRAS NOTÍCIAS", ""];
    for (let i = 0; i < 9; i++) {
      lines.push(`Item ${i}`);
      lines.push(`https://n.com/${i}`);
      lines.push("");
    }
    // Tem 3 destaques + 2 lançamentos + 3 pesquisas (preencher seções inteiras
    // pra que `checkStage2Caps` calcule cap=max(2, 12-3-2-3)=4)
    const md = [
      "LANÇAMENTOS",
      "[L1](https://l.com/1)",
      "Desc",
      "",
      "[L2](https://l.com/2)",
      "Desc",
      "",
      "---",
      "PESQUISAS",
      "[P1](https://p.com/1)",
      "Desc",
      "",
      "[P2](https://p.com/2)",
      "Desc",
      "",
      "[P3](https://p.com/3)",
      "Desc",
      "",
      "---",
      ...lines,
    ].join("\n");
    const approved = {
      highlights: [{ url: "h1" }, { url: "h2" }, { url: "h3" }],
    };
    const r = checkSectionCounts(md, approved);
    assert.equal(r.ok, false);
    assert.equal(r.counts.lancamento, 2);
    assert.equal(r.counts.pesquisa, 3);
    assert.equal(r.counts.noticias, 9);
    assert.equal(r.caps.noticias, 4); // max(2, 12-3-2-3)
    assert.match(r.violations[0], /OUTRAS NOTÍCIAS: 9 > cap 4/);
  });

  it("ok=false quando LANÇAMENTOS passa cap=5", () => {
    const lines = ["LANÇAMENTOS", ""];
    for (let i = 0; i < 7; i++) {
      lines.push(`[L${i}](https://l.com/${i})`);
      lines.push("Desc");
      lines.push("");
    }
    const md = lines.join("\n");
    const approved = { highlights: [{}, {}, {}] };
    const r = checkSectionCounts(md, approved);
    assert.equal(r.ok, false);
    assert.match(r.violations[0], /LAN.*: 7 > cap 5/);
  });

  it("ok=false quando PESQUISAS passa cap=3", () => {
    const lines = ["PESQUISAS", ""];
    for (let i = 0; i < 4; i++) {
      lines.push(`[P${i}](https://p.com/${i})`);
      lines.push("Desc");
      lines.push("");
    }
    const md = lines.join("\n");
    const approved = { highlights: [{}, {}, {}] };
    const r = checkSectionCounts(md, approved);
    assert.equal(r.ok, false);
    assert.match(r.violations[0], /PESQUISAS: 4 > cap 3/);
  });
});
