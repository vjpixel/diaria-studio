/**
 * url-utils.test.ts
 *
 * Tests for scripts/lib/url-utils.ts (#523)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, extractHost, urlsMatch } from "../scripts/lib/url-utils.ts";

describe("canonicalize", () => {
  it("remove utm_* tracking params", () => {
    assert.equal(
      canonicalize("https://example.com/article?utm_source=twitter&utm_medium=social&id=42"),
      "https://example.com/article?id=42",
    );
  });

  it("remove ref e ref_src tracking params", () => {
    assert.equal(
      canonicalize("https://example.com/article?ref=newsletter&ref_src=twsrc"),
      "https://example.com/article",
    );
  });

  it("#4148: remove _bhlid (link-id que o Beehiiv injeta em todo link publicado)", () => {
    assert.equal(
      canonicalize("https://example.com/article?_bhlid=abc123"),
      "https://example.com/article",
    );
  });

  it("#4148 CASO REAL: URL publicada (utm_*+_bhlid) casa com a mesma URL fresh (sem query)", () => {
    // Forma exata da linha em past-editions.md (260715) pro incidente 260727:
    // eugeneyan.com/writing/cybersecurity-evals repetiu 12 dias depois porque
    // canonicalize() não removia "_bhlid" — a forma publicada (com o link-id do
    // Beehiiv) e a forma re-descoberta (sem query) canonicalizavam para strings
    // diferentes, e o dedup evergreen (URL exata) não reconhecia como o mesmo artigo.
    const published =
      "https://eugeneyan.com/writing/cybersecurity-evals/?utm_source=diar.ia.br&utm_medium=newsletter&utm_campaign=terroristas-driblam-chatbots-para-montar-armas&_bhlid=2e762fad5e97619481495067bd9ebf5c013711a0";
    const rediscovered = "https://eugeneyan.com//writing/cybersecurity-evals/";

    assert.equal(canonicalize(published), canonicalize(rediscovered));
  });

  it("preserva outros query params", () => {
    assert.equal(
      canonicalize("https://example.com/article?id=1&tag=ai"),
      "https://example.com/article?id=1&tag=ai",
    );
  });

  it("remove hash fragment", () => {
    assert.equal(
      canonicalize("https://example.com/article#section-1"),
      "https://example.com/article",
    );
  });

  it("remove hash e tracking params juntos", () => {
    assert.equal(
      canonicalize("https://example.com/article?utm_campaign=x#top"),
      "https://example.com/article",
    );
  });

  it("remove trailing slash no pathname (nao root)", () => {
    assert.equal(
      canonicalize("https://example.com/article/"),
      "https://example.com/article",
    );
  });

  it("preserva trailing slash em root", () => {
    assert.equal(
      canonicalize("https://example.com/"),
      "https://example.com/",
    );
  });

  it("normaliza arxiv /pdf/ para /abs/", () => {
    assert.equal(
      canonicalize("https://arxiv.org/pdf/2401.12345.pdf"),
      "https://arxiv.org/abs/2401.12345",
    );
  });

  it("lowercasa scheme e hostname", () => {
    assert.equal(
      canonicalize("HTTPS://EXAMPLE.COM/Article"),
      "https://example.com/Article",
    );
  });

  it("retorna URL original se invalida (sem lancar excecao)", () => {
    assert.equal(canonicalize("not a url"), "not a url");
    assert.equal(canonicalize(""), "");
  });

  // #2581: colapso de double-slash no pathname
  it("#2581: colapsа double-slash no pathname para igualdade de canonicalize", () => {
    // Caso real: eugeneyan.com//writing/working-with-ai/ (// no path)
    // aparecia em past-editions.md mas era re-descoberto com / simples.
    // Sem o fix, canonicalize produzia strings diferentes → dedup evergreen falhava.
    assert.equal(
      canonicalize("https://eugeneyan.com//writing/working-with-ai/"),
      canonicalize("https://eugeneyan.com/writing/working-with-ai/"),
      "// no path deve ser colapsado para / — mesma canonical que URL com / simples",
    );
  });

  it("#2581: dedup evergreen casa URL com double-slash vs URL com slash simples", () => {
    // Confirma que o fix resolve o cenário end-to-end do dedup evergreen.
    const withDoubleSlash = canonicalize("https://eugeneyan.com//writing/working-with-ai/");
    const withSingleSlash = canonicalize("https://eugeneyan.com/writing/working-with-ai/");
    assert.equal(withDoubleSlash, withSingleSlash);
    // Também confirma que o scheme https:// NÃO é afetado (só pathname).
    assert.ok(withSingleSlash.startsWith("https://"), "scheme https:// deve ser preservado");
  });

  it("#2581: triple-slash no pathname também é colapsado", () => {
    assert.equal(
      canonicalize("https://example.com///deep///path/"),
      "https://example.com/deep/path",
    );
  });

  it("#2581: URL sem double-slash no pathname fica inalterada", () => {
    // Garantir que o fix é aditivo e não regride URLs normais.
    assert.equal(
      canonicalize("https://example.com/normal/path"),
      "https://example.com/normal/path",
    );
  });
});

describe("extractHost", () => {
  it("retorna hostname sem www", () => {
    assert.equal(extractHost("https://www.example.com/path"), "example.com");
  });

  it("retorna hostname sem www para subdomain diferente", () => {
    assert.equal(extractHost("https://blog.example.com/post"), "blog.example.com");
  });

  it("retorna hostname simples sem www", () => {
    assert.equal(extractHost("https://example.com/path"), "example.com");
  });

  it("retorna null para URL invalida", () => {
    assert.equal(extractHost("not a url"), null);
    assert.equal(extractHost(""), null);
  });
});

describe("urlsMatch", () => {
  it("URLs identicas fazem match", () => {
    assert.ok(urlsMatch("https://example.com/article", "https://example.com/article"));
  });

  it("URLs com tracking params diferentes fazem match", () => {
    assert.ok(urlsMatch(
      "https://example.com/article?utm_source=twitter",
      "https://example.com/article?utm_medium=social",
    ));
  });

  it("URL com tracking vs sem tracking fazem match", () => {
    assert.ok(urlsMatch(
      "https://example.com/article?utm_source=newsletter&ref=abc",
      "https://example.com/article",
    ));
  });

  it("URL com trailing slash faz match com sem trailing slash", () => {
    assert.ok(urlsMatch(
      "https://example.com/article/",
      "https://example.com/article",
    ));
  });

  it("URLs com hash diferente fazem match", () => {
    assert.ok(urlsMatch(
      "https://example.com/article#intro",
      "https://example.com/article#conclusion",
    ));
  });

  it("URLs de dominios diferentes nao fazem match", () => {
    assert.ok(!urlsMatch("https://example.com/article", "https://other.com/article"));
  });

  it("URLs com paths diferentes nao fazem match", () => {
    assert.ok(!urlsMatch("https://example.com/a", "https://example.com/b"));
  });
});

import { stripUrlTrailingPunct, extractUrls as extractUrlsFromText, URL_REGEX_RAW, sanitizeUrlsDeep } from "../scripts/lib/url-utils.ts";

describe("sanitizeUrlsDeep (#1863)", () => {
  it("limpa sufixo ')=' em highlights + runners_up + buckets consistentemente", () => {
    const approved = {
      highlights: [
        { rank: 1, bucket: "lancamento", article: { url: "https://x.com/meta-business-agent/)=", title: "Meta" } },
        { rank: 2, bucket: "radar", url: "https://x.com/top-level)=" },
      ],
      runners_up: [{ article: { url: "https://x.com/runner)=", title: "R" } }],
      lancamento: [{ url: "https://x.com/lanc)=", title: "L" }],
      radar: [{ url: "https://x.com/ok", title: "OK" }],
    };
    sanitizeUrlsDeep(approved);
    assert.equal(approved.highlights[0].article!.url, "https://x.com/meta-business-agent/");
    assert.equal(approved.highlights[1].url, "https://x.com/top-level");
    assert.equal(approved.runners_up[0].article!.url, "https://x.com/runner");
    assert.equal(approved.lancamento[0].url, "https://x.com/lanc");
    assert.equal(approved.radar[0].url, "https://x.com/ok"); // já limpa
  });

  it("não toca campos que não são 'url' (ex: title com ')=')", () => {
    const node = { url: "https://x.com/a)=", title: "Foo )= bar" };
    sanitizeUrlsDeep(node);
    assert.equal(node.url, "https://x.com/a");
    assert.equal(node.title, "Foo )= bar");
  });

  it("idempotente + tolera null/undefined/array/não-string", () => {
    sanitizeUrlsDeep(null);
    sanitizeUrlsDeep(undefined);
    sanitizeUrlsDeep([]);
    sanitizeUrlsDeep({ url: 42 }); // url não-string ignorada (guard)
    const n = { url: "https://x.com/clean" };
    sanitizeUrlsDeep(n);
    sanitizeUrlsDeep(n);
    assert.equal(n.url, "https://x.com/clean");
  });
});

describe("stripUrlTrailingPunct (#626)", () => {
  it("preserva ')' em URL Wikipedia balanceada", () => {
    assert.equal(
      stripUrlTrailingPunct("https://en.wikipedia.org/wiki/Foo_(bar)"),
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
  });

  it("preserva multiple parens balanceados", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/a(b)c(d)"),
      "https://x.com/a(b)c(d)",
    );
  });

  it("strip ')' não-balanceado vindo de prose", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/y)"),
      "https://x.com/y",
    );
  });

  it("#1863: strip sufixo ')=' (artefato de markdown — caso Meta 260605)", () => {
    // O `/)=` é `/` (path real, fim do link markdown) + `)` (fecha o `](…)`) +
    // `=` (artefato). Strip do `)=` e do `)` desbalanceado deixa a barra real;
    // canonicalize remove a trailing slash depois.
    assert.equal(
      stripUrlTrailingPunct("https://developers.facebook.com/products/meta-business-agent/)="),
      "https://developers.facebook.com/products/meta-business-agent/",
    );
  });

  it("#1863: strip ')=' sem barra → URL limpa", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/meta-business-agent)="),
      "https://x.com/meta-business-agent",
    );
  });

  it("#1863: idempotente também via canonicalize (slug final sem '/')", () => {
    const cleaned = stripUrlTrailingPunct("https://x.com/agent/)=");
    assert.equal(cleaned, "https://x.com/agent/");
  });

  it("#1863: strip sufixo ']=' (markdown link malformado)", () => {
    assert.equal(stripUrlTrailingPunct("https://x.com/path]="), "https://x.com/path");
  });

  it("#1863: NÃO toca query string válida terminando em '=' (?q=)", () => {
    assert.equal(stripUrlTrailingPunct("https://x.com/search?q="), "https://x.com/search?q=");
    assert.equal(stripUrlTrailingPunct("https://x.com/a?b=c&d="), "https://x.com/a?b=c&d=");
  });

  it("#1863 review: NÃO corrompe query params PHP-style terminando em ']=' / ')='", () => {
    // FP que o code-review pegou: gate em '?' ausente preserva esses.
    assert.equal(
      stripUrlTrailingPunct("https://api.example.com/data?filter[status]="),
      "https://api.example.com/data?filter[status]=",
    );
    assert.equal(stripUrlTrailingPunct("https://api.x.com/q?arr[]="), "https://api.x.com/q?arr[]=");
    assert.equal(
      stripUrlTrailingPunct("https://x.com/oauth/cb?redirect=(step1)="),
      "https://x.com/oauth/cb?redirect=(step1)=",
    );
  });

  it("#1863 review: NÃO mexe em ']' de query param (gate em '?')", () => {
    assert.equal(stripUrlTrailingPunct("https://x.com/q?ids[]=1&ids["), "https://x.com/q?ids[]=1&ids[");
  });

  it("#1863: preserva ')' balanceado mesmo com '=' que não é artefato", () => {
    // `(bar)` balanceado seguido de `?x=` — não strippar.
    assert.equal(
      stripUrlTrailingPunct("https://x.com/Foo_(bar)?x="),
      "https://x.com/Foo_(bar)?x=",
    );
  });

  it("#1863: idempotente em URL já limpa", () => {
    const u = "https://developers.facebook.com/products/meta-business-agent";
    assert.equal(stripUrlTrailingPunct(stripUrlTrailingPunct(u)), u);
  });

  it("strip ponto final sentence", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/y."),
      "https://x.com/y",
    );
  });

  it("strip vírgula + ponto", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/y,."),
      "https://x.com/y",
    );
  });

  it("preserva ')' balanceado mesmo com prose punctuation atrás", () => {
    assert.equal(
      stripUrlTrailingPunct("https://en.wikipedia.org/wiki/H%C3%A4feli_DH-5_(military),"),
      "https://en.wikipedia.org/wiki/H%C3%A4feli_DH-5_(military)",
    );
  });

  it("URL sem pontuação fica inalterada", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/y"),
      "https://x.com/y",
    );
  });

  it("#4280: strip sufixo ')_==_' colado após query string real (caso real capture-newsletter-urls)", () => {
    assert.equal(
      stripUrlTrailingPunct(
        "https://platform.claude.com/prompting-claude-opus-5?utm_source=x&_bhlid=abc123)_==_",
      ),
      "https://platform.claude.com/prompting-claude-opus-5?utm_source=x&_bhlid=abc123",
    );
  });

  it("#4280: strip sufixo '_==_' sem parêntese de fechamento junto", () => {
    assert.equal(
      stripUrlTrailingPunct("https://x.com/a?b=c_==_"),
      "https://x.com/a?b=c",
    );
  });

  it("#4280: NÃO mexe em query string terminando só em '=' (sem o artefato completo)", () => {
    assert.equal(stripUrlTrailingPunct("https://x.com/a?b="), "https://x.com/a?b=");
    assert.equal(stripUrlTrailingPunct("https://x.com/a?b=="), "https://x.com/a?b==");
  });

  it("#4280 (self-review): artefato '_==_' logo após ')' balanceado de Wikipedia NÃO consome o ')' real", () => {
    // Achado do self-review: uma versão anterior do fix usava `\)?_==_$`, que
    // consumia o `)` de fechamento junto — corrompendo `Foo_(bar)` pra
    // `Foo_(bar` se o artefato aparecesse logo depois. O fix final só remove
    // `_==_` e deixa o check de parênteses desbalanceados (já existente)
    // decidir se o `)` exposto deve ou não ser removido.
    assert.equal(
      stripUrlTrailingPunct("https://en.wikipedia.org/wiki/Foo_(bar)_==_"),
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
  });
});

describe("extractUrls (#626)", () => {
  it("extrai múltiplas URLs preservando parens balanceados", () => {
    const text = "Veja https://en.wikipedia.org/wiki/Foo_(bar) e https://x.com/y.";
    assert.deepEqual(
      extractUrlsFromText(text),
      ["https://en.wikipedia.org/wiki/Foo_(bar)", "https://x.com/y"],
    );
  });

  it("descarta URLs muito curtas (< 11 chars)", () => {
    assert.deepEqual(
      extractUrlsFromText("http://x"),
      [],
    );
  });
});

import { cleanUrlTail, cutAtUnbalancedClose } from "../scripts/lib/url-utils.ts";

// #9645: URLs REAIS de data/editions/2610/261005/_internal/captured-newsletter-articles.json
// (cauda de markdown em negrito `)**` + variantes) e o caso de parênteses balanceados.
describe("cleanUrlTail (#9645)", () => {
  const REAL_261005: Array<[string, string]> = [
    ["https://runway.com/news/research/introducing-solaris)**", "https://runway.com/news/research/introducing-solaris"],
    [
      "https://www.meta.com/muse-charm?srsltid=AU7gw4VPPUk5MNqM3QXE3lXz8za9BZtY4m1WZxKmCaPrSA7iYHUgr7xi)**",
      "https://www.meta.com/muse-charm?srsltid=AU7gw4VPPUk5MNqM3QXE3lXz8za9BZtY4m1WZxKmCaPrSA7iYHUgr7xi",
    ],
    ["https://sudo.music/)**", "https://sudo.music/"],
    [
      "https://www.scientificamerican.com/article/the-secret-cold-war-history-of-tetris/)**",
      "https://www.scientificamerican.com/article/the-secret-cold-war-history-of-tetris/",
    ],
    [
      "https://www.planet.com/pulse/celebrating-one-year-of-tanager-1/)**[__1__",
      "https://www.planet.com/pulse/celebrating-one-year-of-tanager-1/",
    ],
    [
      "https://www.planet.com/pulse/celebrating-one-year-of-tanager-1/)**_,%E2%80%9D_",
      "https://www.planet.com/pulse/celebrating-one-year-of-tanager-1/",
    ],
    [
      "https://science.nasa.gov/earth/explore/earth-indicators/methane/)**[__x__",
      "https://science.nasa.gov/earth/explore/earth-indicators/methane/",
    ],
  ];
  for (const [dirty, clean] of REAL_261005) {
    it(`limpa ${dirty}`, () => {
      assert.equal(cleanUrlTail(dirty), clean);
      // idempotente
      assert.equal(cleanUrlTail(clean), clean);
    });
  }

  it("outras caudas medidas em 260915→261005", () => {
    assert.equal(cleanUrlTail("https://github.com/google-research/rrsi)****"), "https://github.com/google-research/rrsi");
    assert.equal(cleanUrlTail("https://pxllnk.co/mndv9i)**:"), "https://pxllnk.co/mndv9i");
    assert.equal(cleanUrlTail("https://pxllnk.co/cu1ghtj)Approved"), "https://pxllnk.co/cu1ghtj");
    assert.equal(cleanUrlTail("https://www.meco.app/get/4i7l)(free"), "https://www.meco.app/get/4i7l");
    assert.equal(
      cleanUrlTail("https://store.google.com/us/product/google_home_speaker)_**:**=="),
      "https://store.google.com/us/product/google_home_speaker",
    );
    assert.equal(cleanUrlTail("https://www.passionfroot.me/heyronir)|"), "https://www.passionfroot.me/heyronir");
    assert.equal(cleanUrlTail("https://x.com/a?utm_term=book-2027-planning)=="), "https://x.com/a?utm_term=book-2027-planning");
    assert.equal(cleanUrlTail("https://en.wikipedia.org/wiki/Diatom)_”_"), "https://en.wikipedia.org/wiki/Diatom");
    assert.equal(cleanUrlTail("https://x.com/a**"), "https://x.com/a");
  });

  it("preserva parênteses BALANCEADOS (Wikipedia) — com e sem lixo depois", () => {
    assert.equal(cleanUrlTail("https://en.wikipedia.org/wiki/Foo_(film)"), "https://en.wikipedia.org/wiki/Foo_(film)");
    assert.equal(cleanUrlTail("https://en.wikipedia.org/wiki/Foo_(film))**"), "https://en.wikipedia.org/wiki/Foo_(film)");
    assert.equal(cleanUrlTail("https://x.com/q?n=Key%20number(s)%3A)**"), "https://x.com/q?n=Key%20number(s)%3A");
  });

  it("preserva colchetes balanceados em query (PHP-style)", () => {
    assert.equal(
      cleanUrlTail("https://api.example.com/data?filter[status]=open"),
      "https://api.example.com/data?filter[status]=open",
    );
    assert.equal(cutAtUnbalancedClose("https://api.x.com/q?arr[]="), "https://api.x.com/q?arr[]=");
  });

  it("preserva `_` final legítimo em IDs/handles (review #9651)", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXc_",
      "https://youtu.be/dQw4w9WgXc_",
      "https://x.com/some_user_",
      "https://www.instagram.com/reel/C8abc_",
    ]) {
      assert.equal(cleanUrlTail(u), u);
      assert.deepEqual(extractUrlsFromText(`veja ${u} hoje`), [u]);
    }
    // forma markdown em negrito: corta no `)` e mantém o `_` do ID
    assert.equal(cleanUrlTail("https://youtu.be/dQw4w9WgXc_)**"), "https://youtu.be/dQw4w9WgXc_");
    assert.deepEqual(extractUrlsFromText("[v](https://youtu.be/dQw4w9WgXc_)**"), ["https://youtu.be/dQw4w9WgXc_"]);
    // ênfase colada a URL que termina em `_`: sai a ênfase, fica o `_`
    assert.equal(cleanUrlTail("https://x.com/some_user_**"), "https://x.com/some_user_");
    // `_` DEPOIS de marcador removido continua saindo
    assert.equal(cleanUrlTail("https://x.com/a\u201D_"), "https://x.com/a");
  });

  it("preserva aspa simples ASCII no fim (review #9651)", () => {
    assert.equal(cleanUrlTail("https://en.wikipedia.org/wiki/O'"), "https://en.wikipedia.org/wiki/O'");
  });

  it("URL limpa não muda", () => {
    for (const u of ["https://x.com/", "https://x.com/a?b=c", "https://x.com/a?b=", "https://x.com/path_(x)/y"]) {
      assert.equal(cleanUrlTail(u), u);
    }
  });

  it("extractUrls aplica a limpeza em texto markdown real", () => {
    const md =
      "**[Solaris](https://runway.com/news/research/introducing-solaris)**, e [Tetris](https://www.scientificamerican.com/article/the-secret-cold-war-history-of-tetris/)**.";
    assert.deepEqual(extractUrlsFromText(md), [
      "https://runway.com/news/research/introducing-solaris",
      "https://www.scientificamerican.com/article/the-secret-cold-war-history-of-tetris/",
    ]);
  });
});
