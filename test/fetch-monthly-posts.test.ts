/**
 * test/fetch-monthly-posts.test.ts (#11817)
 *
 * `posts_with_html_fallback` precisa contar só o post gravado como HTML bruto.
 * Até o #11817 o contador subia para todo post com HTML, convertesse ou não,
 * e por isso nunca caía a 0 num ciclo Kit, mesmo com a conversão funcionando.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRawPostText } from "../scripts/fetch-monthly-posts.ts";

const KIT_HTML = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/kit-broadcast-261001-excerpt.html"),
  "utf8",
);

describe("prepareRawPostText", () => {
  it("broadcast real do Kit converte: grava markdown, sem fallback de HTML bruto", () => {
    const r = prepareRawPostText(KIT_HTML, "post_26179209_261001.txt");
    assert.equal(r.rawHtmlFallback, false);
    assert.match(r.text, /^##### LANÇAMENTO/);
    assert.ok(!r.text.includes("<table"), "não pode gravar HTML");
    assert.ok(!r.warnings.some((w) => /gravado HTML bruto/.test(w)));
  });

  it("HTML sem destaque: mantém o HTML bruto, marca o fallback e avisa", () => {
    const html = "<html><body><p>só um parágrafo</p></body></html>";
    const r = prepareRawPostText(html, "post_x_261001.txt");
    assert.equal(r.rawHtmlFallback, true);
    assert.equal(r.text, html);
    assert.ok(r.warnings.some((w) => /post_x_261001\.txt: gravado HTML bruto/.test(w)));
  });
});
