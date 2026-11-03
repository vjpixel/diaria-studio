/**
 * test/retrospectiva-index-12032.test.ts (#12032)
 *
 * 3 de 4 retrospectivas fora do índice do Google, órfãs: só o sitemap as
 * citava. Trava que TODA retrospectiva publicada (a lista que alimenta o
 * sitemap) recebe link de três páginas: o índice `retrospectiva.diar.ia.br/`,
 * a nav "Outras retrospectivas" dos trechos irmãos e a raiz de
 * `arquivo.diar.ia.br` (página já indexada).
 *
 * As asserções iteram sobre `RETROSPECTIVAS_PUBLICADAS` (nunca uma lista
 * copiada aqui): acrescentar uma retrospectiva ao sitemap sem que ela ganhe
 * link é o que este teste reprova.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { PATHS_COM_TRECHO, handleGet, type Env } from "../workers/retrospectiva/src/index.ts";
import { buildArchiveHtml, buildRetrospectivaNav } from "../workers/arquivo/src/render-archive.ts";
import {
  RETROSPECTIVAS_PUBLICADAS,
  RETROSPECTIVA_NAV_MARKER,
  injectOutrasRetrospectivasNav,
  renderOutrasRetrospectivasNav,
  renderRetrospectivaIndexPage,
  retrospectivaLabel,
  retrospectivaLinks,
  retrospectivaUrl,
} from "../scripts/lib/shared/retrospectiva-index.ts";
import { classifyRetrospectivaPath } from "../scripts/lib/shared/retrospectiva-path.ts";

type MockKV = Map<string, string>;

function makeEnv(articles: MockKV): Env {
  return {
    ARTICLES: {
      async get(key: string): Promise<string | null> {
        return articles.get(key) ?? null;
      },
    },
    ALLOWLIST: {
      async get(): Promise<string | null> {
        return null;
      },
    },
  } as unknown as Env;
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

describe("#12032 — fonte única das retrospectivas publicadas", () => {
  it("o Worker usa a MESMA lista (não uma cópia)", () => {
    assert.equal(PATHS_COM_TRECHO, RETROSPECTIVAS_PUBLICADAS);
  });

  it("todo path da lista classifica e tem rótulo", () => {
    assert.ok(RETROSPECTIVAS_PUBLICADAS.length > 0);
    for (const p of RETROSPECTIVAS_PUBLICADAS) {
      assert.ok(classifyRetrospectivaPath(p), `${p} não classifica`);
      assert.ok(retrospectivaLabel(p), `${p} sem rótulo`);
    }
    assert.equal(retrospectivaLinks().length, RETROSPECTIVAS_PUBLICADAS.length);
  });

  it("rótulos dos três formatos", () => {
    assert.equal(retrospectivaLabel("2607"), "Retrospectiva de julho de 2026");
    assert.equal(retrospectivaLabel("2026"), "Retrospectiva de 2026");
    assert.equal(retrospectivaLabel("aniversario2026"), "Retrospectiva de aniversário de 2026");
    assert.equal(retrospectivaLabel("lixo"), null);
  });

  it("path inválido é descartado, nunca vira link com rótulo inventado", () => {
    assert.deepEqual(
      retrospectivaLinks(["2607", "nao-existe"]).map((l) => l.path),
      ["2607"],
    );
  });
});

describe("#12032 — sitemap e índice cobrem as mesmas URLs", () => {
  it("toda URL de edição do sitemap aparece como link no índice `/`", async () => {
    const res = await worker.fetch(new Request("https://retrospectiva.diar.ia.br/sitemap.xml"), makeEnv(new Map()));
    const locs = sitemapLocs(await res.text());
    assert.ok(locs.includes("https://retrospectiva.diar.ia.br/"), "o índice entra no sitemap");
    const edicoes = locs.filter((l) => l !== "https://retrospectiva.diar.ia.br/");
    assert.deepEqual(edicoes, RETROSPECTIVAS_PUBLICADAS.map(retrospectivaUrl));

    const index = await handleGet(new Request("https://retrospectiva.diar.ia.br/"), makeEnv(new Map()));
    assert.equal(index.status, 200);
    const links = hrefs(await index.text());
    for (const loc of edicoes) assert.ok(links.includes(loc), `índice não linka ${loc}`);
  });

  it("o índice é indexável e tem canonical próprio", () => {
    const html = renderRetrospectivaIndexPage();
    assert.match(html, /<link rel="canonical" href="https:\/\/retrospectiva\.diar\.ia\.br\/">/);
    assert.match(html, /<meta name="robots" content="index, follow">/);
    assert.match(html, /<html lang="pt-BR">/);
  });

  it("lista vazia não quebra o índice", () => {
    assert.match(renderRetrospectivaIndexPage([]), /Nenhuma retrospectiva publicada/);
  });
});

describe("#12032 — nav 'Outras retrospectivas' nos trechos", () => {
  it("cada trecho linka todas as OUTRAS publicadas e o índice, nunca a si mesmo", () => {
    for (const atual of RETROSPECTIVAS_PUBLICADAS) {
      const links = hrefs(renderOutrasRetrospectivasNav(atual));
      for (const outra of RETROSPECTIVAS_PUBLICADAS.filter((p) => p !== atual)) {
        assert.ok(links.includes(retrospectivaUrl(outra)), `${atual} não linka ${outra}`);
      }
      assert.ok(!links.includes(retrospectivaUrl(atual)), `${atual} linka a si mesma`);
      assert.ok(links.includes("https://retrospectiva.diar.ia.br/"));
    }
  });

  it("o trecho mensal servido pelo Worker sai com a nav (cenário real: 2608 indexada linka 2605-2607)", async () => {
    const env = makeEnv(new Map([["article:2608:teaser", "<html><head></head><body><p>começo</p></body></html>"]]));
    const res = await handleGet(new Request("https://retrospectiva.diar.ia.br/2608"), env);
    const body = await res.text();
    assert.ok(body.includes(RETROSPECTIVA_NAV_MARKER));
    const links = hrefs(body);
    for (const p of ["2607", "2606", "2605"]) assert.ok(links.includes(retrospectivaUrl(p)), `2608 não linka ${p}`);
    // nav antes do </body>, depois do bloco de conversão
    assert.ok(body.indexOf(RETROSPECTIVA_NAV_MARKER) > body.indexOf('id="retrospectiva-paywall"'));
    assert.ok(body.indexOf(RETROSPECTIVA_NAV_MARKER) < body.lastIndexOf("</body>"));
  });

  it("injeção: último </body>, idempotente, fail-soft sem </body> e sem outras", () => {
    const html = "<html><body><pre>&lt;/body&gt;</pre><code></body></code>fim</body></html>";
    const out = injectOutrasRetrospectivasNav(html, "2608", ["2608", "2607"]);
    assert.ok(out.indexOf(RETROSPECTIVA_NAV_MARKER) > out.indexOf("fim"));
    assert.equal(injectOutrasRetrospectivasNav(out, "2608", ["2608", "2607"]), out);
    assert.equal(injectOutrasRetrospectivasNav("<p>sem body</p>", "2608", ["2608", "2607"]), "<p>sem body</p>");
    assert.equal(injectOutrasRetrospectivasNav(html, "2608", ["2608"]), html);
  });
});

describe("#12032 — raiz do arquivo (página indexada) linka todas as retrospectivas", () => {
  const entry = (loc: string, lastmod: string) => ({ loc, lastmod });

  it("buildArchiveHtml traz link pra cada publicada e pro índice", () => {
    const html = buildArchiveHtml([entry("https://diar.ia.br/p/edicao-a", "2026-07-27")], {});
    const links = hrefs(html);
    for (const p of RETROSPECTIVAS_PUBLICADAS) {
      assert.ok(links.includes(retrospectivaUrl(p)), `arquivo não linka ${p}`);
    }
    assert.ok(links.includes("https://retrospectiva.diar.ia.br/"));
  });

  it("o bloco vem depois das seções de mês e antes do JSON-LD", () => {
    const html = buildArchiveHtml([entry("https://diar.ia.br/p/edicao-a", "2026-07-27")], {});
    const idx = html.indexOf('aria-label="Retrospectivas"');
    assert.ok(idx > html.lastIndexOf("</section>", idx) && html.lastIndexOf("</section>", idx) > -1);
    assert.ok(idx < html.indexOf('<script type="application/ld+json">'));
  });

  it("lista vazia → nada renderizado", () => {
    assert.equal(buildRetrospectivaNav([]), "");
  });
});

describe("#12032 — o bloco do arquivo não cita '{mês} de {ano}'", () => {
  it("rótulo curto, para não inventar um mês sem edição na raiz do arquivo", () => {
    const html = buildArchiveHtml([{ loc: "https://diar.ia.br/p/edicao-a", lastmod: "2026-07-27" }], {});
    assert.doesNotMatch(html, /agosto de 2026/);
    assert.match(html, />agosto\/2026</);
  });
});
