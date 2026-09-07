/**
 * test/site-sitemap-orphans-7578.test.ts (#7578)
 *
 * Regressão do bug que deixou o acervo público parado 12 dias.
 *
 * O sintoma foi "arquivo.diar.ia.br não mostra edições depois de 26/08", mas
 * a causa não estava no Worker `arquivo` — ele deriva o acervo do
 * `sitemap.xml` do apex em request-time e estava correto. O que quebrou foi o
 * elo anterior: **páginas gravadas em `workers/site/public/p/` sem entrada
 * correspondente no sitemap.** Elas respondiam 200 e mesmo assim eram
 * invisíveis no buscador e no arquivo ao mesmo tempo. Medido em 07/09/2026:
 * 259 páginas locais, 254 no sitemap, 5 órfãs — a mais antiga de 28/08.
 *
 * Invariantes travados aqui:
 *
 * 1. **Órfã é detectada.** Página com `index.html` e sem `<loc>` viola.
 * 2. **Slug PREFIXO de outro não vira falso negativo.** É a armadilha do
 *    #7280 (`addSitemapEntry` tinha exatamente este bug com `includes`): se a
 *    detecção casasse por substring, uma órfã cujo slug é prefixo de outra
 *    página já listada passaria despercebida — o mesmo silêncio que este
 *    módulo existe para acabar. Este é o teste que mais importa do arquivo.
 * 3. **Diretório sem `index.html` não conta como página.** Resto de execução
 *    interrompida não serve nada; declará-lo no sitemap criaria um 404
 *    anunciado ao crawler.
 * 4. **A ausência de `data/` não quebra nada.** `buildSlugDateMap` devolve
 *    mapa vazio em CI/clone fresco, e a entrada entra sem `<lastmod>`.
 * 5. **O invariante de Stage 6 BLOQUEIA (`severity: "error"`).** Era
 *    `warning`, e a docstring do próprio check já registrava que o silêncio
 *    tinha custado 4 edições — e voltou a custar 12 dias depois disso.
 *    Decisão do editor em 07/09/2026: travar o gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSlugDateMap,
  findOrphanSlugs,
  listPageSlugs,
  slugsInSitemap,
} from "../scripts/lib/site-sitemap-orphans.ts";
import { STAGE_6_RULES } from "../scripts/lib/invariant-checks/stage-6.ts";

function sitemapWith(slugs: string[]): string {
  const urls = slugs
    .map((s) => `  <url>\n    <loc>https://diar.ia.br/p/${s}</loc>\n    <lastmod>2026-09-01</lastmod>\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function makePagesDir(slugs: string[], opts: { semIndex?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sitemap-orphans-"));
  for (const s of slugs) {
    mkdirSync(join(dir, s), { recursive: true });
    writeFileSync(join(dir, s, "index.html"), "<!doctype html><title>x</title>", "utf8");
  }
  for (const s of opts.semIndex ?? []) mkdirSync(join(dir, s), { recursive: true });
  return dir;
}

describe("#7578 — detecção de página órfã do sitemap", () => {
  it("acusa a página que existe em disco e não está no sitemap", () => {
    const dir = makePagesDir(["edicao-a", "edicao-b", "edicao-orfa"]);
    try {
      const orphans = findOrphanSlugs(listPageSlugs(dir), sitemapWith(["edicao-a", "edicao-b"]));
      assert.deepEqual(orphans, ["edicao-orfa"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não reporta órfã quando o sitemap cobre tudo", () => {
    const dir = makePagesDir(["edicao-a", "edicao-b"]);
    try {
      assert.deepEqual(findOrphanSlugs(listPageSlugs(dir), sitemapWith(["edicao-a", "edicao-b"])), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO #7280: slug que é PREFIXO de outro já listado ainda é órfã", () => {
    // `...-de-ia` é página DIFERENTE de `...-de-ia-ec15971b8c4f589e`. Uma
    // detecção por substring acharia a primeira "já presente" e a deixaria
    // fora do sitemap para sempre, sem erro nem log.
    const curta = "90-das-pessoas-nao-reconhecem-videos-de-ia";
    const longa = `${curta}-ec15971b8c4f589e`;
    const dir = makePagesDir([curta, longa]);
    try {
      const orphans = findOrphanSlugs(listPageSlugs(dir), sitemapWith([longa]));
      assert.deepEqual(orphans, [curta], "a página de slug mais curto precisa ser acusada como órfã");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("casa a URL exata, ignorando barra final e espaço em volta da tag", () => {
    const xml = `<?xml version="1.0"?>\n<urlset>\n  <url>\n    <loc> https://diar.ia.br/p/edicao-a/ </loc>\n  </url>\n</urlset>\n`;
    assert.ok(slugsInSitemap(xml).has("edicao-a"));
  });

  it("diretório sem index.html não conta como página", () => {
    const dir = makePagesDir(["edicao-a"], { semIndex: ["sobra-de-execucao-interrompida"] });
    try {
      assert.deepEqual(listPageSlugs(dir), ["edicao-a"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pagesDir inexistente devolve lista vazia em vez de lançar", () => {
    assert.deepEqual(listPageSlugs(join(tmpdir(), "nao-existe-7578")), []);
  });

  it("buildSlugDateMap devolve mapa vazio quando data/ não existe (CI, clone fresco)", () => {
    const ausente = join(tmpdir(), "nao-existe-7578");
    assert.equal(buildSlugDateMap(ausente, ausente).size, 0);
  });

  it("buildSlugDateMap mapeia a edição publicada pelo Kit via 05-edition-url.txt", () => {
    // Caminho que o cache Beehiiv NÃO cobre desde `backend = "kit"` (#7388) —
    // sem ele, toda edição de 04/09/2026 em diante entraria sem <lastmod>.
    const root = mkdtempSync(join(tmpdir(), "editions-7578-"));
    const internal = join(root, "2609", "260904", "_internal");
    mkdirSync(internal, { recursive: true });
    writeFileSync(join(internal, "05-edition-url.txt"), "https://diar.ia.br/p/nvidia-controla\n", "utf8");
    try {
      const map = buildSlugDateMap(join(tmpdir(), "nao-existe-7578"), root);
      assert.equal(map.get("nvidia-controla"), "2026-09-04");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#7578 — o invariante de Stage 6 bloqueia o gate", () => {
  const editionDir = mkdtempSync(join(tmpdir(), "stage6-7578-"));

  it("site-page-published é error, não warning, quando published != true", () => {
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeFileSync(
      join(editionDir, "_internal", "site-page-published.json"),
      JSON.stringify({ code: 3, slug: "x", published: false, reason: "checkout divergente" }),
      "utf8",
    );
    const rule = STAGE_6_RULES.find((r) => r.id === "site-page-published");
    assert.ok(rule, "regra site-page-published precisa existir");
    const violations = rule.run(editionDir);
    assert.equal(violations.length, 1);
    assert.equal(
      violations[0].severity,
      "error",
      "decisão do editor 07/09/2026 (#7578): falha de publicação do site trava o gate 6",
    );
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("a regra de órfã do sitemap está registrada no Stage 6 e é error", () => {
    const rule = STAGE_6_RULES.find((r) => r.id === "site-sitemap-no-orphans");
    assert.ok(rule, "regra site-sitemap-no-orphans precisa estar em STAGE_6_RULES");
    // O repo real precisa estar limpo; se houver órfã, a violação é error.
    for (const v of rule.run(mkdtempSync(join(tmpdir(), "vazio-7578-")))) {
      assert.equal(v.severity, "error");
    }
  });
});
