/**
 * test/site-nav-arrow-exception-9743.test.ts (#9743, regressão #633)
 *
 * Decisão do editor (06/10/2026): exceção ESTREITA à regra "sem seta" do
 * site (#9721/#9723), só pra seta de direção da navegação:
 *   - nav entre edições: `← Anterior: {título}` / `Próxima: {título} →`;
 *   - paginação do acervo: `← anterior` / `próxima →`.
 * A exceção é contextual (link `rel="prev"`/`rel="next"`, seta na ponta que
 * aponta pro lado certo), não allowlist por arquivo. Este arquivo trava:
 *  1. o check aceita a seta no lugar certo e reprova em qualquer outro;
 *  2. `normalizeArrowsForSite` preserva a seta da nav e remove o resto;
 *  3. a página `/p/` gerada do zero sai com a nav com seta e passa no check;
 *  4. os geradores continuam sem literal com seta (a seta vem do helper).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findArrowGlyphs,
  maskSiteNavArrows,
  navNextLinkText,
  navPrevLinkText,
  normalizeArrowsForSite,
} from "../scripts/lib/shared/arrow-glyph.ts";
import { scanGeneratorSource, scanPublishedText, scanSnippet } from "../scripts/lib/no-arrow-glyph-scan.ts";
import { buildArchivePageHtml } from "../scripts/lib/site-archive-pages.ts";
import { refreshArchiveNeighborNav } from "../scripts/lib/site-archive-page-backfill.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "workers/site/public/p/x/index.html";
const PREV = '<a href="https://diar.ia.br/p/a" rel="prev">← Anterior: Edição A</a>';
const NEXT = '<a href="https://diar.ia.br/p/b" rel="next">Próxima: Edição B →</a>';
const PAG_PREV = '<a class="page-nav" rel="prev" href="/archive">← anterior</a>';
const PAG_NEXT = '<a class="page-nav" rel="next" href="/archive/3">próxima →</a>';

describe("#9743 check: seta de direção na nav passa, fora dela reprova", () => {
  it("nav entre edições e paginação no formato do builder passam", () => {
    for (const html of [PREV, NEXT, PAG_PREV, PAG_NEXT, `<nav>${PREV}${NEXT}</nav>`]) {
      assert.deepEqual(scanPublishedText(PAGE, html, []), [], html);
    }
  });

  it("REGRESSÃO: seta trocada de lado ou fora da ponta continua reprovando", () => {
    const bad = [
      '<a href="/p/a" rel="prev">→ Anterior: A</a>', // → no link anterior
      '<a href="/p/b" rel="next">Próxima: B ←</a>', // ← no próximo
      '<a href="/p/a" rel="prev">Anterior: A ←</a>', // ← no fim do anterior
      '<a href="/p/b" rel="next">→ Próxima: B</a>', // → no início do próximo
      '<a href="/" class="back">← Voltar</a>', // link sem rel=prev
      '<a href="/x">Ver mais →</a>', // CTA sem rel=next
      "<p>← Anterior</p>", // fora de link
      '<a href="/p/a" rel="prev"><b>←</b> A</a>', // rótulo com tag
    ];
    for (const html of bad) {
      assert.equal(scanPublishedText(PAGE, html, []).length, 1, html);
    }
    // seta no meio do rótulo: a da ponta passa, a do meio reprova
    assert.equal(scanPublishedText(PAGE, '<a href="/p/a" rel="prev">← Anterior: A → B</a>', []).length, 1);
  });

  it("a exceção vale só pro HTML publicado: caixas e literais de gerador seguem reprovando", () => {
    assert.equal(scanSnippet("data/snippets/x.md", PREV).length, 1);
    assert.equal(scanGeneratorSource("scripts/lib/site-x.ts", `export const a = '${PREV}';`).length, 1);
    assert.equal(findArrowGlyphs(PREV).length, 1); // sem a opção, nada muda
  });
});

describe("#9743 normalizeArrowsForSite preserva só a seta da nav", () => {
  it("nav fica intacta; seta editorial e CTA no mesmo HTML somem; idempotente", () => {
    const html = `<nav>${PREV}${NEXT}</nav><p>A → B</p><a href="/x">Ver →</a>${PAG_PREV}${PAG_NEXT}`;
    const out = normalizeArrowsForSite(html);
    for (const frag of [PREV, NEXT, PAG_PREV, PAG_NEXT]) assert.ok(out.includes(frag), `${frag}\n${out}`);
    assert.match(out, /<p>A – B<\/p>/);
    assert.match(out, /<a href="\/x">Ver<\/a>/);
    assert.equal(normalizeArrowsForSite(out), out);
    assert.deepEqual(scanPublishedText(PAGE, out, []), []);
  });

  it("seta do lado errado na nav é removida como qualquer outra", () => {
    assert.equal(
      normalizeArrowsForSite('<a href="/p/a" rel="prev">Anterior: A →</a>'),
      '<a href="/p/a" rel="prev">Anterior: A</a>',
    );
  });

  it("maskSiteNavArrows mantém o comprimento (índices do check)", () => {
    const html = `${PREV}${NEXT}`;
    const masked = maskSiteNavArrows(html, "x", "y");
    assert.equal(masked.length, html.length);
    assert.ok(!masked.includes("←") && !masked.includes("→"), masked);
  });

  it("helpers põem a seta na ponta certa", () => {
    assert.equal(navPrevLinkText("anterior"), "← anterior");
    assert.equal(navNextLinkText("próxima"), "próxima →");
  });
});

describe("#9743 página /p/ e geradores", () => {
  it("buildArchivePageHtml sai com a nav com seta e passa no check", () => {
    const html = buildArchivePageHtml(
      {
        slug: "s",
        title: "A → B",
        subtitle: null,
        status: "confirmed",
        web_url: "https://diar.ia.br/p/s",
        publish_date: 1791190800,
        content: { free: { web: '<!doctype html><html><head></head><body><p>x → y</p><a href="/">Ver →</a></body></html>' } },
      },
      { neighbors: { prev: { slug: "p", title: "Prev → velha" }, next: { slug: "n", title: "Next" } } },
    );
    assert.match(html, /rel="prev">← Anterior: Prev – velha<\/a>/);
    assert.match(html, /rel="next">Próxima: Next →<\/a>/);
    assert.deepEqual(scanPublishedText("workers/site/public/p/s/index.html", html, []), []);
  });

  for (const f of ["scripts/lib/site-archive-pages.ts", "scripts/lib/site-archive-index.ts"]) {
    it(`${f}: nenhum literal com seta (a seta vem de navPrevLinkText/navNextLinkText)`, () => {
      assert.deepEqual(scanGeneratorSource(f, readFileSync(join(ROOT, f), "utf8")), []);
    });
  }
});

describe("#9743 refreshArchiveNeighborNav (páginas já gravadas)", () => {
  it("formato #9723 (sem seta) ganha a seta de direção e a 2ª passada é no-op, inclusive com título terminando em quebra de linha", () => {
    const old =
      '<body><nav class="archive-nav" aria-label="x" style="y">' +
      '<a href="https://diar.ia.br/p/a" rel="prev">Anterior: Título A\n</a>' +
      '<a href="https://diar.ia.br/p/b" rel="next">Próxima: Título B\n</a></nav><p>corpo</p></body>';
    const r = refreshArchiveNeighborNav(old);
    assert.ok(r.changed);
    assert.match(r.html, /rel="prev">← Anterior: Título A\n<\/a>/);
    assert.match(r.html, /rel="next">Próxima: Título B\n →<\/a>/);
    assert.deepEqual(scanPublishedText(PAGE, r.html, []), []);
    assert.equal(refreshArchiveNeighborNav(r.html).changed, false);
  });
});
