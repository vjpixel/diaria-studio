/**
 * test/monthly-click-sections.test.ts (#1901/#1902)
 *
 * Regressão do ranking por cliques das seções mensais Use Melhor (3) e Radar (7):
 *  - normalização de URL (strip utm/hash/barra final, case-insensitive)
 *  - classificação de seção do 02-reviewed.md (destaque / use_melhor / outro)
 *    + filtro de links não-editoriais (beehiiv)
 *  - seleção: Use Melhor top-3 (incl. fonte emprestada), Radar top-7 excluindo
 *    Destaques (temas) e qualquer link de Use Melhor, de-dup por baseUrl, cap N.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  baseUrl,
  parseEdition,
  selectSections,
  type LinkItem,
} from "../scripts/monthly-click-sections.ts";

describe("baseUrl", () => {
  it("strips query, hash e barra final, e normaliza case", () => {
    assert.equal(
      baseUrl("https://Example.com/Path/?utm_source=x&a=1#frag"),
      "https://example.com/path",
    );
  });
  it("é idempotente p/ URL já limpa", () => {
    assert.equal(baseUrl("https://foo.com/bar"), "https://foo.com/bar");
  });
  it("casa a URL clicada (com utm) contra a URL limpa do 02-reviewed", () => {
    const clean = "https://canaltech.com.br/ia/artigo";
    const tracked =
      "https://canaltech.com.br/ia/artigo?utm_source=diaria.beehiiv.com&utm_medium=newsletter";
    assert.equal(baseUrl(clean), baseUrl(tracked));
  });
});

describe("parseEdition", () => {
  const md = [
    "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    "",
    "[**Foo lança bar**](https://foo.com/bar)",
    "",
    "corpo do destaque",
    "",
    "Por que isso importa:",
    "",
    "porque sim",
    "",
    "---",
    "",
    "**🛠️ USE MELHOR**",
    "",
    "[**Tutorial X: como usar**](https://tut.com/x)  ",
    "Passo a passo pra usar X.",
    "",
    "---",
    "",
    "**📰 OUTRAS NOTÍCIAS**",
    "",
    "[**Notícia Y**](https://news.com/y)  ",
    "Resumo da notícia Y.",
    "",
    "[**link interno**](https://diaria.beehiiv.com/p/foo)  ",
    "",
  ].join("\n");

  const items = parseEdition("260601", md);
  const bySection = (s: string) => items.filter((i) => i.section === s);

  it("classifica o destaque", () => {
    const d = bySection("destaque");
    assert.equal(d.length, 1);
    assert.equal(d[0].baseUrl, "https://foo.com/bar");
    assert.equal(d[0].title, "Foo lança bar");
  });
  it("classifica o use_melhor com título e descrição", () => {
    const u = bySection("use_melhor");
    assert.equal(u.length, 1);
    assert.equal(u[0].baseUrl, "https://tut.com/x");
    assert.equal(u[0].title, "Tutorial X: como usar");
    assert.equal(u[0].desc, "Passo a passo pra usar X.");
  });
  it("classifica notícia como 'outro'", () => {
    const o = bySection("outro");
    assert.equal(o.length, 1);
    assert.equal(o[0].baseUrl, "https://news.com/y");
  });
  it("filtra link não-editorial (beehiiv)", () => {
    assert.equal(
      items.some((i) => i.baseUrl.includes("beehiiv.com")),
      false,
    );
  });
  it("carrega a edição em cada item", () => {
    assert.ok(items.every((i) => i.edition === "260601"));
  });
});

describe("selectSections", () => {
  const item = (
    baseUrlStr: string,
    section: LinkItem["section"],
    edition = "260510",
    title = baseUrlStr,
  ): LinkItem => ({
    url: baseUrlStr,
    baseUrl: baseUrlStr,
    title,
    desc: "",
    section,
    edition,
  });

  it("Use Melhor: top-3 por cliques, incluindo fonte emprestada", () => {
    const monthItems = [
      item("https://t.com/a", "use_melhor"),
      item("https://t.com/b", "use_melhor"),
    ];
    const sourceItems = [item("https://t.com/borrowed", "use_melhor", "260601")];
    const clicks = new Map([
      ["https://t.com/a", 1],
      ["https://t.com/b", 5],
      ["https://t.com/borrowed", 9],
    ]);
    const r = selectSections(monthItems, sourceItems, clicks, new Set());
    assert.deepEqual(
      r.use_melhor.map((x) => x.url),
      ["https://t.com/borrowed", "https://t.com/b", "https://t.com/a"],
    );
  });

  it("Radar exclui Destaques (temas) e qualquer link de Use Melhor", () => {
    const monthItems = [
      item("https://x.com/theme", "destaque"), // tema → excluído
      item("https://x.com/tut", "use_melhor"), // use_melhor → excluído do radar
      item("https://x.com/n1", "outro"),
      item("https://x.com/n2", "outro"),
    ];
    const clicks = new Map([
      ["https://x.com/theme", 99],
      ["https://x.com/tut", 50],
      ["https://x.com/n1", 3],
      ["https://x.com/n2", 7],
    ]);
    const themeUrls = new Set(["https://x.com/theme"]);
    const r = selectSections(monthItems, [], clicks, themeUrls);
    assert.deepEqual(
      r.radar.map((x) => x.url),
      ["https://x.com/n2", "https://x.com/n1"],
    );
  });

  it("Radar é capado em 7 e ordenado por cliques desc", () => {
    const monthItems = Array.from({ length: 10 }, (_, i) =>
      item(`https://r.com/${i}`, "outro"),
    );
    const clicks = new Map(monthItems.map((it, i) => [it.baseUrl, i]));
    const r = selectSections(monthItems, [], clicks, new Set());
    assert.equal(r.radar.length, 7);
    assert.equal(r.radar[0].url, "https://r.com/9");
    assert.equal(r.radar[6].url, "https://r.com/3");
  });

  it("de-dup por baseUrl: link repetido em 2 edições é 1 item", () => {
    const monthItems = [
      item("https://d.com/x", "outro", "260505"),
      item("https://d.com/x", "outro", "260512"),
    ];
    const clicks = new Map([["https://d.com/x", 4]]);
    const r = selectSections(monthItems, [], clicks, new Set());
    assert.equal(r.radar.length, 1);
    assert.deepEqual(r.radar[0].editions, ["260505", "260512"]);
  });

  it("emite warning quando há menos candidatos que o esperado", () => {
    const r = selectSections([item("https://w.com/1", "outro")], [], new Map(), new Set());
    assert.ok(r.warnings.some((w) => w.includes("Use Melhor")));
    assert.ok(r.warnings.some((w) => w.includes("Radar")));
  });
});
