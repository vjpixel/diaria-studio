/**
 * test/artigos-cross-refs-5924.test.ts (#5924)
 *
 * Guards de COERÊNCIA INTERNA das páginas de `workers/artigos/public/`.
 * Complementa `artigos-sitemap-5126.test.ts`, que garante que todo artigo
 * EXISTE no sitemap/índice — aqui garantimos que os valores duplicados
 * entre arquivos (e dentro do mesmo arquivo) não divergem em silêncio.
 *
 * Motivação concreta (#5924): a revisão do artigo `engenharia-de-ilusao`
 * bumpou o `dateModified` do JSON-LD para 2026-08-22 e deixou o
 * `<lastmod>` do sitemap em 2026-08-18. Os 17 testes existentes passavam,
 * porque só checam FORMATO de data (`\d{4}-\d{2}-\d{2}`), nunca o VALOR de
 * um contra o outro. A divergência foi pega à mão na revisão do PR; sem
 * este guard, volta no próximo artigo editado. Mesmo padrão de cross-check
 * que `arquivo-render.test.ts` já aplica em `workers/arquivo`.
 *
 * Estas páginas são mantidas à mão (não há build script para este Worker —
 * ver workers/artigos/README.md), então nada além de teste impede a
 * divergência.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "workers", "artigos", "public");

type Article = { year: string; slug: string; path: string; html: string };

/** Mesma descoberta de `artigos-sitemap-5126.test.ts`: `public/{ano}/{slug}/index.html`. */
function discoverArticles(): Article[] {
  const out: Article[] = [];
  for (const yearEntry of readdirSync(PUBLIC_DIR)) {
    const yearPath = join(PUBLIC_DIR, yearEntry);
    if (!/^\d{4}$/.test(yearEntry) || !statSync(yearPath).isDirectory()) continue;
    for (const slugEntry of readdirSync(yearPath)) {
      const slugPath = join(yearPath, slugEntry);
      if (!statSync(slugPath).isDirectory()) continue;
      const indexPath = join(slugPath, "index.html");
      if (!existsSync(indexPath)) continue;
      out.push({
        year: yearEntry,
        slug: slugEntry,
        path: indexPath,
        html: readFileSync(indexPath, "utf8"),
      });
    }
  }
  return out;
}

/** Extrai um campo escalar do JSON-LD embutido (ex.: `dateModified`). */
function jsonLdField(html: string, field: string): string | null {
  const m = html.match(new RegExp(`"${field}":"([^"]*)"`));
  return m ? m[1] : null;
}

describe("workers/artigos/public — coerência interna das páginas (#5924)", () => {
  const articles = discoverArticles();
  const sitemap = readFileSync(join(PUBLIC_DIR, "sitemap.xml"), "utf8");

  it("pelo menos 1 artigo é descoberto (guard não fica vazio silenciosamente)", () => {
    assert.ok(articles.length > 0, "nenhum artigo descoberto em workers/artigos/public/{ano}/{slug}/");
  });

  it("<lastmod> do sitemap bate com o dateModified do JSON-LD de cada artigo", () => {
    for (const a of articles) {
      const dateModified = jsonLdField(a.html, "dateModified");
      assert.ok(dateModified, `${a.year}/${a.slug}: JSON-LD sem dateModified`);

      const loc = `https://especial.diar.ia.br/${a.year}/${a.slug}/`;
      const bloco = sitemap.match(
        new RegExp(`<loc>${loc.replace(/[/.]/g, "\\$&")}</loc>\\s*<lastmod>([^<]*)</lastmod>`),
      );
      assert.ok(bloco, `${a.year}/${a.slug}: sem <loc>+<lastmod> no sitemap.xml`);
      assert.equal(
        bloco[1],
        dateModified,
        `${a.year}/${a.slug}: sitemap diz lastmod=${bloco[1]} mas o artigo diz dateModified=${dateModified}. ` +
          `Editou o artigo? Atualize o <lastmod> em workers/artigos/public/sitemap.xml.`,
      );
    }
  });

  it("dateModified nunca é anterior a datePublished", () => {
    for (const a of articles) {
      const pub = jsonLdField(a.html, "datePublished");
      const mod = jsonLdField(a.html, "dateModified");
      assert.ok(pub && mod, `${a.year}/${a.slug}: JSON-LD sem datePublished/dateModified`);
      assert.ok(
        mod >= pub,
        `${a.year}/${a.slug}: dateModified (${mod}) é anterior a datePublished (${pub})`,
      );
    }
  });

  it("toda âncora do índice aponta para um id que existe na página", () => {
    for (const a of articles) {
      // Artigo Especial GATEADO (#7030): `public/{ano}/{slug}/index.html` é o
      // TEASER estático (`scripts/build-artigo-especial-teaser.ts`), cortado
      // no marcador `ESPECIAL:GATE_CUT` — antes da 1ª seção nomeada (s02+).
      // O índice/TOC lista TODAS as seções do artigo completo de propósito
      // (mostra ao visitante o que tem atrás do gate), mas só a seção s01
      // efetivamente existe na página estática — o resto vive em
      // `src/{slug}-full.generated.ts`, servido pelo worker só pós-gate. O
      // marcador `especial-gate-cta` (`artigo-especial-gate-cta.ts`) sinaliza
      // essa truncagem intencional; sem ele, a página é íntegra e o guard
      // original (#5924) vale sem exceção.
      const isGatedTeaser = a.html.includes('class="especial-gate-cta"');
      const ancoras = [...a.html.matchAll(/<a href="#(s\d+)"/g)].map((m) => m[1]);
      if (ancoras.length === 0) continue; // artigo sem índice: nada a checar
      for (const id of ancoras) {
        const existe = a.html.includes(`id="${id}"`);
        if (isGatedTeaser && !existe) continue; // âncora aponta pro conteúdo gateado — esperado
        assert.ok(
          existe,
          `${a.year}/${a.slug}: índice aponta para #${id}, que não existe na página`,
        );
      }
    }
  });

  it("as duas cópias de cada infográfico (inline/mobile e aside/desktop) contam a mesma coisa", () => {
    // O mesmo infográfico aparece 2x no HTML: `.ig-inline` (visível <900px) e
    // dentro de `<aside class="ig-aside">` (visível >=900px). São mantidas à
    // mão, lado a lado — editar só uma faz mobile e desktop mostrarem fatos
    // diferentes, sem erro visível. As DESCRIÇÕES divergem de propósito (a do
    // aside é abreviada); data e rótulo, não.
    const pares = (trecho: string) =>
      [...trecho.matchAll(/<span class="ig-date">([^<]*)<\/span>\s*<span class="ig-label">([^<]*)</g)].map(
        (m) => `${m[1]} | ${m[2]}`,
      );

    for (const a of articles) {
      const iAside = a.html.indexOf('<aside class="ig-aside">');
      if (iAside === -1) continue; // artigo sem infográfico lateral

      const inline = pares(a.html.slice(0, iAside));
      const aside = pares(a.html.slice(iAside));
      if (inline.length === 0 && aside.length === 0) continue;

      assert.deepEqual(
        aside,
        inline,
        `${a.year}/${a.slug}: as cópias inline e aside dos infográficos divergem em data/rótulo. ` +
          `Editou uma? Aplique a mesma mudança na outra.`,
      );
    }
  });
});
