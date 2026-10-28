/**
 * test/site-sitemap-landings-10509.test.ts (#10509)
 *
 * Regressão: o invariante do #7578 (`reconcile-site-sitemap.ts`) só olhava
 * `workers/site/public/p/`, e toda página pública fora dali nascia órfã de
 * sitemap. Medido em 19/10/2026: a home `/`, `/produto/conteudo-autentico`,
 * `/guia/agente-ia` e `/evento/agente-ia` fora do `sitemap.xml`;
 * `/produto/conteudo-autentico` com zero visita de crawler verificado nas
 * primeiras ~40 h no ar.
 *
 * Travado aqui:
 *
 * 1. Landing nova fora de `/p/` sem `<loc>` faz `--check` sair 2 (o cenário
 *    da issue), e o modo escrita a acrescenta.
 * 2. A home `/` conta como página.
 * 3. Exclusões: `noindex` na página e `SITEMAP_EXCLUDED_PATHS` (variantes de
 *    anúncio de `/evento/agente-ia/{a..f}`) ficam fora.
 * 4. `--sitemap` de fixture sem `--public-dir` não varre as landings de
 *    produção.
 * 5. O repo REAL está reconciliado: `--check` sai 0 e as 4 URLs da issue
 *    estão no sitemap — é este teste que faz o CI acusar uma landing nova
 *    que entre sem sitemap.
 * 6. Toda landing declarada está em `KNOWN_STATIC_SITEMAP_PATHS`, senão a
 *    geração da home passa a emitir `console.warn` por ela.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PUBLIC_DIR,
  DEFAULT_SITEMAP,
  SITEMAP_EXCLUDED_PATHS,
  findLandingOrphanPaths,
  isExcludedFromSitemap,
  isNoindexHtml,
  listPublicPagePaths,
  locForPublicPath,
  pathsInSitemap,
} from "../scripts/lib/site-sitemap-orphans.ts";
import { isKnownStaticSitemapPath } from "../scripts/lib/site-home-page.ts";
import { main as cliMain } from "../scripts/reconcile-site-sitemap.ts";

function sitemap(locs: string[]): string {
  const urls = locs.map((l) => `  <url>\n    <loc>${l}</loc>\n    <lastmod>2026-09-01</lastmod>\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** `public/` de fixture: `pages` são paths relativos (`""` = raiz) com o HTML de cada `index.html`. */
function makePublic(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sitemap-landings-10509-"));
  for (const [rel, html] of Object.entries(pages)) {
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, "index.html"), html, "utf8");
  }
  return dir;
}

const HTML = "<!doctype html><title>x</title>";
const NOINDEX = '<!doctype html><head><meta name="robots" content="noindex"></head>';

describe("#10509 — landings fora de /p/ entram no invariante do sitemap", () => {
  it("landing nova fora de /p/ sem entrada no sitemap faz --check sair 2; escrita acrescenta", () => {
    const pub = makePublic({ "": HTML, "p/a": HTML, "produto/novo": HTML });
    const sm = join(pub, "sitemap.xml");
    writeFileSync(sm, sitemap(["https://diar.ia.br/", "https://diar.ia.br/p/a"]), "utf8");
    const args = ["--pages-dir", join(pub, "p"), "--sitemap", sm, "--public-dir", pub];
    try {
      assert.equal(cliMain(["--check", ...args]), 2, "landing órfã precisa reprovar o --check");
      assert.equal(cliMain(args), 0);
      const depois = readFileSync(sm, "utf8");
      assert.ok(depois.includes("<loc>https://diar.ia.br/produto/novo</loc>"));
      assert.equal(cliMain(["--check", ...args]), 0);
      // Idempotente: não duplica.
      assert.equal(cliMain(args), 0);
      assert.equal(readFileSync(sm, "utf8").split("/produto/novo<").length - 1, 1);
    } finally {
      rmSync(pub, { recursive: true, force: true });
    }
  });

  it("só landings órfãs: a home NÃO é regenerada", () => {
    const pub = makePublic({ "": "HOME-ORIGINAL", "p/a": HTML, "guia/x": HTML });
    const sm = join(pub, "sitemap.xml");
    writeFileSync(sm, sitemap(["https://diar.ia.br/", "https://diar.ia.br/p/a"]), "utf8");
    try {
      assert.equal(cliMain(["--pages-dir", join(pub, "p"), "--sitemap", sm, "--public-dir", pub]), 0);
      assert.equal(readFileSync(join(pub, "index.html"), "utf8"), "HOME-ORIGINAL");
    } finally {
      rmSync(pub, { recursive: true, force: true });
    }
  });

  it("a home / é página; a árvore p/ fica de fora da varredura de landings", () => {
    const pub = makePublic({ "": HTML, "p/a": HTML, "p/b": HTML, "clarice": HTML });
    try {
      assert.deepEqual(listPublicPagePaths(pub), ["/", "/clarice"]);
      assert.deepEqual(findLandingOrphanPaths(pub, sitemap(["https://diar.ia.br/clarice"])), ["/"]);
    } finally {
      rmSync(pub, { recursive: true, force: true });
    }
  });

  it("noindex e SITEMAP_EXCLUDED_PATHS ficam fora; diretório sem index.html não é página", () => {
    const pub = makePublic({
      "assinar": HTML, // listada explicitamente
      "interna": NOINDEX, // noindex sem estar listada
      "evento/agente-ia": HTML,
      "evento/agente-ia/a": HTML,
      "evento/agente-ia/f": HTML,
    });
    mkdirSync(join(pub, "evento", "agente-ia", "assets"), { recursive: true });
    try {
      assert.deepEqual(findLandingOrphanPaths(pub, sitemap([])), ["/evento/agente-ia"]);
    } finally {
      rmSync(pub, { recursive: true, force: true });
    }
  });

  it("isNoindexHtml aceita ordem de atributos e googlebot; não confunde com index,follow", () => {
    assert.equal(isNoindexHtml('<meta content="noindex, nofollow" name="robots">'), true);
    assert.equal(isNoindexHtml("<meta name='googlebot' content='noindex'>"), true);
    assert.equal(isNoindexHtml('<meta name="robots" content="index, follow">'), false);
    assert.equal(isNoindexHtml('<meta name="description" content="noindex aqui é texto">'), false);
  });

  it("<loc> com barra final casa o path sem barra; / vira https://diar.ia.br/", () => {
    assert.ok(pathsInSitemap(sitemap(["https://diar.ia.br/guia/x/"])).has("/guia/x"));
    assert.equal(locForPublicPath("/"), "https://diar.ia.br/");
    assert.equal(locForPublicPath("/guia/x/"), "https://diar.ia.br/guia/x");
  });

  it("--sitemap de fixture sem --public-dir não compara com as landings de produção", () => {
    const pub = makePublic({ "p/a": HTML });
    const sm = join(pub, "sitemap.xml");
    writeFileSync(sm, sitemap(["https://diar.ia.br/p/a"]), "utf8");
    try {
      assert.equal(cliMain(["--check", "--pages-dir", join(pub, "p"), "--sitemap", sm]), 0);
    } finally {
      rmSync(pub, { recursive: true, force: true });
    }
  });

  it("cada exclusão carrega motivo", () => {
    for (const e of SITEMAP_EXCLUDED_PATHS) assert.ok(e.reason.trim().length > 10, String(e.path));
    assert.equal(isExcludedFromSitemap("/evento/agente-ia/c/"), true);
    assert.equal(isExcludedFromSitemap("/evento/agente-ia"), false);
  });
});

describe("#10509 — repo real", () => {
  it("--check no sitemap real sai 0 (nenhuma página pública órfã)", () => {
    assert.ok(existsSync(DEFAULT_SITEMAP));
    assert.equal(cliMain(["--check"]), 0);
  });

  it("as 4 URLs da issue estão no sitemap publicado", () => {
    const declared = pathsInSitemap(readFileSync(DEFAULT_SITEMAP, "utf8"));
    for (const p of ["/", "/produto/conteudo-autentico/b", "/guia/agente-ia", "/evento/agente-ia"]) {
      assert.ok(declared.has(p), `${p} ausente de ${DEFAULT_SITEMAP}`);
    }
  });

  it("toda landing declarada no sitemap está em KNOWN_STATIC_SITEMAP_PATHS (home não emite warn)", () => {
    const declared = pathsInSitemap(readFileSync(DEFAULT_SITEMAP, "utf8"));
    const landings = listPublicPagePaths(DEFAULT_PUBLIC_DIR).filter((p) => declared.has(p));
    assert.ok(landings.length >= 4);
    const fora = landings.filter((p) => !isKnownStaticSitemapPath(locForPublicPath(p)));
    assert.deepEqual(fora, [], "acrescentar a landing em KNOWN_STATIC_SITEMAP_PATHS (scripts/lib/site-home-page.ts)");
  });
});
