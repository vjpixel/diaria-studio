/**
 * test/stack-preview-doc-views-13050-13055.test.ts
 *
 * #13050: o número de views do vídeo da semana não aparece nas prévias nem nos
 * logs dos produtos semanais (decisão do editor, 13/11/2026). `video.views`
 * segue existindo como critério de escolha.
 *
 * #13055: as prévias publicadas no Artifact são documento completo (doctype,
 * charset, viewport); sem doctype a página abria em quirks mode.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCircleStackPreviewHtml } from "../scripts/lib/circle-stack-preview-html.ts";
import type { CircleStackSelection } from "../scripts/lib/circle-stack-render.ts";
import { buildHtmlDocument, ensureHtmlDocument, hasHtmlDoctype } from "../scripts/lib/shared/html-document.ts";
import { ensureHtmlDocumentFiles } from "../scripts/ensure-html-document.ts";

const sel = (): CircleStackSelection => ({
  cycle: "26w46",
  contentWindow: ["261109", "261110", "261111", "261112", "261113"],
  destaques: [
    { editionDate: "261111", url: "https://ex.com/d1", title: "Destaque um", body: "Corpo.", why: "Porque.", destaqueN: 1 },
  ],
  lancamentos: [],
  useMelhor: [],
  radar: [],
  weeklyEditions: [],
  video: { title: "Vídeo comentado", url: "https://www.youtube.com/watch?v=abc", editionDate: "261111", views: 38 },
});

const render = () =>
  renderCircleStackPreviewHtml({
    selection: sel(),
    previewTitle: "Título",
    publishMonday: "261116",
    publishState: "draft",
    warnings: [],
    mdPath: "data/weekly/26w46/circle-stack-26w46.md",
  });

describe("#13050 — views do vídeo não aparecem", () => {
  it("prévia HTML da Stack mostra a edição do vídeo e não o número de views", () => {
    const html = render();
    assert.match(html, /<div class="small">Edição de 11\/11<\/div>/);
    assert.doesNotMatch(html, /\bviews?\b/i);
    assert.doesNotMatch(html, /visualiza/i);
    assert.doesNotMatch(html, /\b38\b/);
  });

  it("logs de terminal do publish-circle-stack e do render-linkedin-weekly não imprimem views", () => {
    for (const f of ["scripts/publish-circle-stack.ts", "scripts/render-linkedin-weekly.ts"]) {
      const src = readFileSync(f, "utf8");
      const logs = src.split("\n").filter((l) => /console\.(log|error|warn)\(.*Vídeo da semana/.test(l));
      assert.ok(logs.length > 0, `${f}: log do vídeo da semana sumiu (o teste precisa ser atualizado)`);
      for (const l of logs) assert.doesNotMatch(l, /views/i, `${f}: ${l.trim()}`);
    }
  });
});

describe("#13055 — prévia como documento completo", () => {
  it("prévia da Stack abre com doctype, charset e viewport, com title e style no head", () => {
    const html = render();
    assert.ok(html.startsWith("<!doctype html>\n<html lang=\"pt-BR\">"), html.slice(0, 80));
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
    assert.match(head, /<meta charset="utf-8">/);
    assert.match(head, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(head, /<title>Stack 26w46<\/title>/);
    assert.match(head, /<style>/);
    assert.match(html, /<body>\n<main>[\s\S]*<\/main>\n<\/body>\n<\/html>\n$/);
  });

  it("buildHtmlDocument monta o esqueleto", () => {
    assert.equal(
      buildHtmlDocument({ head: "<title>X</title>", body: "<p>a</p>\n" }),
      '<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>X</title>\n</head>\n<body>\n<p>a</p>\n</body>\n</html>\n',
    );
  });

  it("ensureHtmlDocument embrulha fragmento e leva title/style do começo para o head", () => {
    const out = ensureHtmlDocument('<title>LinkedIn Semanal</title>\n<style>p{}</style>\n<h1>Artigo</h1><p>corpo</p>');
    assert.ok(hasHtmlDoctype(out));
    const head = /<head>([\s\S]*?)<\/head>/.exec(out)?.[1] ?? "";
    assert.match(head, /<meta charset="utf-8">/);
    assert.match(head, /name="viewport"/);
    assert.match(head, /<title>LinkedIn Semanal<\/title>/);
    assert.match(head, /<style>p\{\}<\/style>/);
    assert.match(out, /<body>\n<h1>Artigo<\/h1><p>corpo<\/p>\n<\/body>/);
  });

  it("ensureHtmlDocument completa <html> sem doctype e sem duplicar meta existente", () => {
    const out = ensureHtmlDocument('<html lang="pt-BR"><head><meta charset="UTF-8"><title>T</title></head><body>x</body></html>');
    assert.ok(out.startsWith("<!doctype html>\n<html"));
    assert.equal(out.match(/charset/gi)?.length, 1);
    assert.match(out, /name="viewport"/);
    const semHead = ensureHtmlDocument("<html><body>x</body></html>");
    assert.match(semHead, /^<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport"[^>]*>\n<\/head><body>x<\/body><\/html>$/);
  });

  it("ensureHtmlDocument é idempotente (doctype em qualquer caixa, com BOM ou espaço)", () => {
    for (const doc of ["<!DOCTYPE html><html><body>x</body></html>", "﻿<!doctype html>\n<p>x</p>", "  \n<!doctype HTML><p>x</p>"]) {
      assert.equal(ensureHtmlDocument(doc), doc);
    }
    const once = ensureHtmlDocument("<p>x</p>");
    assert.equal(ensureHtmlDocument(once), once);
  });

  it("ensureHtmlDocumentFiles reescreve só o que não tem doctype", () => {
    const dir = mkdtempSync(join(tmpdir(), "ensure-html-13055-"));
    const frag = join(dir, "ln.html");
    const doc = join(dir, "index.html");
    writeFileSync(frag, "<p>prévia</p>", "utf8");
    writeFileSync(doc, "<!doctype html><p>ok</p>", "utf8");
    const r = ensureHtmlDocumentFiles([frag, doc]);
    assert.deepEqual(r, { changed: [frag], unchanged: [doc] });
    assert.ok(hasHtmlDoctype(readFileSync(frag, "utf8")));
    assert.match(readFileSync(frag, "utf8"), /<p>prévia<\/p>/);
    assert.equal(readFileSync(doc, "utf8"), "<!doctype html><p>ok</p>");
  });
});
