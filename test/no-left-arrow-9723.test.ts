/**
 * test/no-left-arrow-9723.test.ts (#9723, regressão #633)
 *
 * Decisão do editor (05/10/2026): a regra do #9721 ("nunca a seta em botão,
 * link, CTA ou copy que chega ao leitor") vale também para a seta `←` dos
 * links de volta/anterior do site. Este arquivo trava:
 *
 *  1. o check de CI (`findArrowGlyphs`/`scanPublishedText`/`scanGeneratorSource`)
 *     reprova `←` e as formas escapadas;
 *  2. a nav entre edições é simétrica e sem seta (`Anterior: ` / `Próxima: `),
 *     e a paginação do acervo idem (`anterior` / `próxima`);
 *  3. os geradores do site, das páginas de confirmação e dos Workers que
 *     tinham `←` não o têm mais; o repo real passa no check;
 *  4. a página `/p/` gerada (e o backstop `normalizeArrowsForSite`) não deixa
 *     `←` passar;
 *  5. `refreshArchiveNeighborNav` (a limpeza das ~280 páginas já gravadas)
 *     muda só a marcação da nav e é idempotente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEFT_ARROW_GLYPH,
  findArrowGlyphs,
  hasArrowForm,
  normalizeArrowsForSite,
  stripCtaArrows,
  stripUnambiguousCtaArrows,
} from "../scripts/lib/shared/arrow-glyph.ts";
import { scanGeneratorSource, scanPublishedText, scanRepo } from "../scripts/lib/no-arrow-glyph-scan.ts";
import { formatReport } from "../scripts/check-no-arrow-glyph.ts";
import {
  ARCHIVE_NAV_NEXT_LABEL,
  ARCHIVE_NAV_PREV_LABEL,
  buildArchiveNeighborNavHtml,
  buildArchivePageHtml,
} from "../scripts/lib/site-archive-pages.ts";
import { archiveIndexPageEntries, buildArchiveIndexHtml } from "../scripts/lib/site-archive-index.ts";
import { refreshArchiveNeighborNav } from "../scripts/lib/site-archive-page-backfill.ts";
import { runRefreshNav } from "../scripts/backfill-archive-page-links-seo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("#9723 check de CI reprova a seta ←", () => {
  it("findArrowGlyphs pega ← literal e as formas escapadas", () => {
    for (const s of ["← Voltar", "&larr; Voltar", "&#8592; x", "&#x2190; x", "&LARR; x", "\\u2190 x", "\\u{2190} x"]) {
      assert.equal(findArrowGlyphs(s).length, 1, s);
      assert.ok(hasArrowForm(s), s);
    }
  });

  it("REGRESSÃO: reintroduzir ← num HTML publicado ou num literal de gerador falha", () => {
    const page = '<p class="top"><a href="/">← diar.ia.br</a></p>';
    assert.equal(scanPublishedText("workers/site/public/x/index.html", page, []).length, 1);
    const gen = 'export const back = `<a class="back" href="/">← Voltar pra diar.ia.br</a>`;';
    assert.equal(scanGeneratorSource("scripts/lib/site-x.ts", gen).length, 1);
    const genEsc = 'export const back = "<a href=\\"/\\">&larr; anterior</a>";';
    assert.equal(scanGeneratorSource("scripts/lib/site-x.ts", genEsc).length, 1);
    // comentário de código não conta (mesmo critério da →)
    assert.deepEqual(scanGeneratorSource("scripts/lib/site-x.ts", "// ← nota interna\nexport const a = 1;"), []);
  });

  it("o repo real passa no check (nenhuma ← publicada nem em gerador)", () => {
    const { ok, text } = formatReport(scanRepo(ROOT));
    assert.ok(ok, text);
  });
});

describe("#9723 nav simétrica, sem seta", () => {
  it("nav entre edições: 'Anterior: ' / 'Próxima: ' com o título clicável", () => {
    const html = buildArchiveNeighborNavHtml({ slug: "velha", title: "Edição velha" }, { slug: "nova", title: "Edição nova" });
    assert.ok(!html.includes(LEFT_ARROW_GLYPH), html);
    assert.ok(!hasArrowForm(html), html);
    assert.match(html, /rel="prev">Anterior: Edição velha<\/a>/);
    assert.match(html, /rel="next">Próxima: Edição nova<\/a>/);
    assert.equal(ARCHIVE_NAV_PREV_LABEL, "Anterior: ");
    assert.equal(ARCHIVE_NAV_NEXT_LABEL, "Próxima: ");
  });

  it("título de vizinho com seta sai normalizado", () => {
    const html = buildArchiveNeighborNavHtml({ slug: "a", title: "A ← B" });
    assert.ok(!hasArrowForm(html), html);
  });

  it("paginação do acervo: 'anterior' / 'próxima', sem seta", () => {
    const html = buildArchiveIndexHtml({ entries: archiveIndexPageEntries([], 2, 30), page: 2, totalPages: 3, totalEditions: 65 });
    assert.ok(!hasArrowForm(html), "índice do acervo ainda tem seta");
    assert.match(html, /rel="prev" href="\/archive">anterior<\/a>/);
    assert.match(html, /rel="next" href="\/archive\/3">próxima<\/a>/);
  });
});

describe("#9723 geradores que tinham ← não o têm mais", () => {
  const FILES = [
    "scripts/lib/site-archive-pages.ts",
    "scripts/lib/site-archive-index.ts",
    "scripts/lib/site-assinar-page.ts",
    "scripts/lib/site-clarice-coupon-page.ts",
    "workers/poll/src/jogar.ts",
    "workers/poll/src/index.ts",
    "workers/poll/src/leaderboard-routes.ts",
    "workers/arquivo/src/render-app.ts",
    "workers/arquivo/src/render-privacy.ts",
  ];
  for (const f of FILES) {
    it(`${f}: nenhum literal com seta`, () => {
      assert.deepEqual(scanGeneratorSource(f, readFileSync(join(ROOT, f), "utf8")), []);
    });
  }
});

describe("#9723 página /p/ e backstop do site", () => {
  it("normalizeArrowsForSite: ← no início do link some; ← editorial vira meia-risca", () => {
    assert.equal(normalizeArrowsForSite('<a href="/">← Voltar</a>'), '<a href="/">Voltar</a>');
    assert.equal(normalizeArrowsForSite('<a href="/">&larr; Voltar</a>'), '<a href="/">Voltar</a>');
    assert.equal(normalizeArrowsForSite("custo ← demanda"), "custo – demanda");
    assert.equal(normalizeArrowsForSite("A←B"), "A–B");
    const once = normalizeArrowsForSite("x ← y <a>← z</a>");
    assert.equal(normalizeArrowsForSite(once), once);
  });

  it("stripCtaArrows/stripUnambiguousCtaArrows tiram ← do início do rótulo (caixas e newsletter)", () => {
    assert.equal(stripCtaArrows("[← Voltar](https://diar.ia.br)"), "[Voltar](https://diar.ia.br)");
    assert.equal(stripUnambiguousCtaArrows('<button class="b">← Voltar</button>'), '<button class="b">Voltar</button>');
    assert.equal(stripUnambiguousCtaArrows("← Voltar ao início"), "Voltar ao início");
  });

  it("buildArchivePageHtml não deixa ← passar (título e corpo)", () => {
    const html = buildArchivePageHtml(
      {
        slug: "s",
        title: "A ← B",
        subtitle: null,
        status: "confirmed",
        web_url: "https://diar.ia.br/p/s",
        publish_date: 1791190800,
        content: { free: { web: '<!doctype html><html><head></head><body><p>x ← y</p><a href="/">← Voltar</a></body></html>' } },
      },
      { neighbors: { prev: { slug: "p", title: "Prev" }, next: { slug: "n", title: "Next" } } },
    );
    assert.deepEqual(scanPublishedText("workers/site/public/p/s/index.html", html, []), []);
  });
});

describe("#9723 refreshArchiveNeighborNav (limpeza das páginas já gravadas)", () => {
  const OLD =
    '<body><nav class="archive-nav" aria-label="Navegação entre edições" style="x">' +
    '<a href="https://diar.ia.br/p/velha" rel="prev">← Título &quot;velho&quot; &amp; cia</a>' +
    '<a href="https://diar.ia.br/p/nova" rel="next">Título novo</a></nav><p>corpo</p></body>';

  it("troca a seta pelos rótulos, preserva vizinhos e escape, e é idempotente", () => {
    const r = refreshArchiveNeighborNav(OLD);
    assert.ok(r.changed);
    assert.ok(!hasArrowForm(r.html), r.html);
    assert.match(r.html, /href="https:\/\/diar\.ia\.br\/p\/velha" rel="prev">Anterior: Título &quot;velho&quot; &amp; cia<\/a>/);
    assert.match(r.html, /href="https:\/\/diar\.ia\.br\/p\/nova" rel="next">Próxima: Título novo<\/a>/);
    assert.match(r.html, /<\/nav><p>corpo<\/p>/);
    const again = refreshArchiveNeighborNav(r.html);
    assert.equal(again.changed, false);
    assert.equal(again.html, r.html);
  });

  it("fail-closed: sem nav ou com href fora do acervo, não mexe", () => {
    assert.equal(refreshArchiveNeighborNav("<body><p>x</p></body>").changed, false);
    const foreign = OLD.replace("https://diar.ia.br/p/velha", "https://outro.site/p/velha");
    assert.equal(refreshArchiveNeighborNav(foreign).changed, false);
  });

  it("runRefreshNav reescreve só as páginas que mudam; dry-run não escreve", () => {
    const pages: Record<string, string> = { a: OLD, b: "<body>sem nav</body>" };
    const writes: string[] = [];
    const deps = {
      listSlugs: () => Object.keys(pages),
      readPage: (p: string) => pages[p.split(/[\\/]/).at(-2)!],
      writePage: (p: string) => void writes.push(p),
    };
    assert.deepEqual(runRefreshNav("/x", { ...deps, dryRun: true }), { scanned: 2, changed: 1 });
    assert.equal(writes.length, 0);
    assert.deepEqual(runRefreshNav("/x", deps), { scanned: 2, changed: 1 });
    assert.equal(writes.length, 1);
  });
});
