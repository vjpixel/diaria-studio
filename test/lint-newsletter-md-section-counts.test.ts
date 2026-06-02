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
    // #1693: novos campos também 0 quando ausentes
    assert.equal(c.use_melhor, 0);
    assert.equal(c.video, 0);
  });

  it("#1693: conta USE MELHOR + VÍDEOS (formato real bold+emoji)", () => {
    // Formato de produção (verificado em 02-reviewed.md): **🛠️ USE MELHOR**,
    // não emoji solto. Guarda o wrapper `(?:\*\*)?` do sectionHeaderRe contra
    // regressão #1691 — sem o bold, o count voltaria a 0 e o cap viraria no-op.
    const md = [
      "**🛠️ USE MELHOR**",
      "[Guia A](https://u.com/a)",
      "Desc",
      "",
      "[Guia B](https://u.com/b)",
      "Desc",
      "",
      "---",
      "**🎬 VÍDEOS**",
      "[Vid 1](https://yt.com/1)",
      "Desc",
      "",
      "[Vid 2](https://yt.com/2)",
      "Desc",
    ].join("\n");
    const c = countItemsPerSection(md);
    assert.equal(c.use_melhor, 2);
    assert.equal(c.video, 2);
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
    // #1693: cap de vídeos exposto mesmo no caminho ok (sem VÍDEOS na edição).
    assert.equal(r.caps.video, 2);
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

  it("#1693: ok=false quando VÍDEOS passa cap=2 (formato real bold+emoji)", () => {
    const md = [
      "**🎬 VÍDEOS**",
      "[V1](https://yt.com/1)",
      "Desc",
      "",
      "[V2](https://yt.com/2)",
      "Desc",
      "",
      "[V3](https://yt.com/3)",
      "Desc",
    ].join("\n");
    const approved = { highlights: [{}, {}, {}] };
    const r = checkSectionCounts(md, approved);
    assert.equal(r.ok, false);
    assert.equal(r.counts.video, 3);
    assert.equal(r.caps.video, 2);
    // Accent fixado (impl emite "VÍDEOS:" com Í) — não usar [ÍI] tolerante.
    assert.match(r.violations[0], /VÍDEOS: 3 > cap 2/);
  });

  it("#1693: USE MELHOR com muitos itens NÃO viola (só observabilidade)", () => {
    const lines = ["🛠️ USE MELHOR", ""];
    for (let i = 0; i < 8; i++) {
      lines.push(`[U${i}](https://u.com/${i})`);
      lines.push("Desc");
      lines.push("");
    }
    const md = lines.join("\n");
    const approved = { highlights: [{}, {}, {}] };
    const r = checkSectionCounts(md, approved);
    assert.equal(r.counts.use_melhor, 8);
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
  });
});
