/**
 * list-active-sources.test.ts (#1270)
 *
 * Tests do parser de context/sources.md.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSourcesMd } from "../scripts/list-active-sources.ts";

describe("parseSourcesMd (#1270)", () => {
  it("parsea fonte simples com URL + RSS", () => {
    const md = [
      "# Sources",
      "",
      "## Brasil",
      "",
      "### Canaltech (IA)",
      "- URL: https://canaltech.com.br/inteligencia-artificial/",
      "- Site query: `site:canaltech.com.br/inteligencia-artificial`",
      "- RSS: https://canaltech.com.br/rss/",
      "- Topic filter: AI,IA,inteligência artificial",
    ].join("\n");

    const sources = parseSourcesMd(md);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].name, "Canaltech (IA)");
    assert.equal(sources[0].url, "https://canaltech.com.br/inteligencia-artificial/");
    assert.equal(sources[0].site_query, "site:canaltech.com.br/inteligencia-artificial");
    assert.equal(sources[0].rss, "https://canaltech.com.br/rss/");
    assert.equal(sources[0].filter, "AI,IA,inteligência artificial");
  });

  it("parsea múltiplas fontes em diferentes seções", () => {
    const md = [
      "## Brasil",
      "",
      "### Canaltech (IA)",
      "- RSS: https://canaltech.com.br/rss/",
      "",
      "### Exame",
      "- RSS: https://exame.com/feed/",
      "",
      "## Primária",
      "",
      "### OpenAI",
      "- RSS: https://openai.com/news/rss.xml",
    ].join("\n");

    const sources = parseSourcesMd(md);
    assert.equal(sources.length, 3);
    assert.deepEqual(sources.map((s) => s.name), ["Canaltech (IA)", "Exame", "OpenAI"]);
  });

  it("inclui fontes sem RSS (caller filtra)", () => {
    const md = [
      "### Source A",
      "- URL: https://a.com/",
      "- Site query: `site:a.com`",
      "",
      "### Source B",
      "- URL: https://b.com/",
      "- RSS: https://b.com/feed",
    ].join("\n");

    const sources = parseSourcesMd(md);
    assert.equal(sources.length, 2);
    assert.equal(sources[0].rss, undefined);
    assert.equal(sources[1].rss, "https://b.com/feed");
  });

  it("ignora linhas entre fontes que não são bullets reconhecidos", () => {
    const md = [
      "### Foo",
      "- URL: https://foo.com/",
      "",
      "Notas livres aqui não devem quebrar parse.",
      "",
      "- RSS: https://foo.com/feed",
    ].join("\n");

    const sources = parseSourcesMd(md);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].rss, "https://foo.com/feed");
  });

  it("preserva ordem de aparição", () => {
    const md = [
      "### Z First",
      "- RSS: z",
      "### A Second",
      "- RSS: a",
      "### M Third",
      "- RSS: m",
    ].join("\n");

    const sources = parseSourcesMd(md);
    assert.deepEqual(sources.map((s) => s.name), ["Z First", "A Second", "M Third"]);
  });

  it("retorna [] para md vazio", () => {
    assert.deepEqual(parseSourcesMd(""), []);
  });

  it("retorna [] para md sem seções h3", () => {
    const md = "# Title\n\n## Section\n\nText only.";
    assert.deepEqual(parseSourcesMd(md), []);
  });
});
