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
    // #1629: radar acumula RADAR atual + PESQUISAS/OUTRAS NOTÍCIAS legacy
    assert.equal(c.radar, 3);
  });

  it("seções vazias retornam 0", () => {
    const md = "DESTAQUE 1 | PRODUTO\n\nhttps://x.com/1\n\nTexto.\n";
    const c = countItemsPerSection(md);
    assert.equal(c.lancamento, 0);
    assert.equal(c.radar, 0);
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

  it("ok=false quando RADAR passa cap (#1629: cap=max(5, 12-d-l))", () => {
    // 3 destaques + 2 lançamentos → radar cap = max(5, 12-3-2) = 7
    // Render 12 itens em RADAR → viola
    const lines = ["RADAR", ""];
    for (let i = 0; i < 12; i++) {
      lines.push(`[R${i}](https://r.com/${i})`);
      lines.push("Desc");
      lines.push("");
    }
    const md = [
      "LANÇAMENTOS",
      "[L1](https://l.com/1)",
      "Desc",
      "",
      "[L2](https://l.com/2)",
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
    assert.equal(r.counts.radar, 12);
    assert.equal(r.caps.radar, 7);
    assert.match(r.violations[0], /RADAR: 12 > cap 7/);
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
});
