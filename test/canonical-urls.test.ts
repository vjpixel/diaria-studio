import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getCanonicalUrls,
  lookupCanonicalUrl,
  extractUrlsFromMd,
  findMismatchedUrls,
} from "../scripts/lib/canonical-urls.ts";

describe("getCanonicalUrls (#1456)", () => {
  it("mapeia title→url de highlights (article shape)", () => {
    const map = getCanonicalUrls({
      highlights: [
        {
          rank: 1,
          article: { title: "Title 1", url: "https://example.com/d1" },
        },
        {
          rank: 2,
          article: { title: "Title 2", url: "https://example.com/d2" },
        },
      ],
    });
    assert.equal(lookupCanonicalUrl(map, "Title 1"), "https://example.com/d1");
    assert.equal(lookupCanonicalUrl(map, "Title 2"), "https://example.com/d2");
  });

  it("inclui runners_up e buckets secundários", () => {
    const map = getCanonicalUrls({
      runners_up: [{ article: { title: "Runner", url: "https://r.com/x" } }],
      lancamento: [{ title: "Lanca", url: "https://l.com/x" }],
      pesquisa: [{ title: "Pesq", url: "https://p.com/x" }],
      noticias: [{ title: "Not", url: "https://n.com/x" }],
    });
    assert.equal(lookupCanonicalUrl(map, "Runner"), "https://r.com/x");
    assert.equal(lookupCanonicalUrl(map, "Lanca"), "https://l.com/x");
    assert.equal(lookupCanonicalUrl(map, "Pesq"), "https://p.com/x");
    assert.equal(lookupCanonicalUrl(map, "Not"), "https://n.com/x");
  });

  it("normalizeTitle: aceita variações de case/acentos no lookup", () => {
    const map = getCanonicalUrls({
      noticias: [{ title: "SoberanIA: plataforma nacional", url: "https://br247.com/x" }],
    });
    // Lookup com case diferente ainda casa via normalizeTitle
    assert.equal(
      lookupCanonicalUrl(map, "SOBERANIA: PLATAFORMA NACIONAL"),
      "https://br247.com/x",
    );
  });

  it("retorna undefined pra título não encontrado", () => {
    const map = getCanonicalUrls({
      noticias: [{ title: "Real Title", url: "https://x.com/y" }],
    });
    assert.equal(lookupCanonicalUrl(map, "Hallucinated Title"), undefined);
  });
});

describe("extractUrlsFromMd (#1456)", () => {
  it("extrai URLs de inline markdown links", () => {
    const md = `
**DESTAQUE 1**

[**Title**](https://example.com/d1)

body
`;
    assert.deepEqual(extractUrlsFromMd(md), ["https://example.com/d1"]);
  });

  it("ignora URLs em frontmatter YAML", () => {
    const md = `---
intentional_error:
  url: "https://wrong.com/x"
---

[**Real**](https://right.com/y)
`;
    assert.deepEqual(extractUrlsFromMd(md), ["https://right.com/y"]);
  });

  it("ignora URLs em code blocks", () => {
    const md = `
\`\`\`
Some code with https://code.com/x or [fake](https://fake.com/y)
\`\`\`

[**Real**](https://real.com/z)
`;
    assert.deepEqual(extractUrlsFromMd(md), ["https://real.com/z"]);
  });
});

describe("findMismatchedUrls (#1456)", () => {
  it("retorna URLs do MD que não estão no approved JSON", () => {
    const approved = {
      highlights: [{ article: { title: "T1", url: "https://example.com/d1" } }],
      noticias: [{ title: "N1", url: "https://example.com/n1" }],
    };
    const md = `
[**T1**](https://example.com/d1)
[**N1**](https://example.com/n1)
[**Manual edit**](https://hallucinated.com/x)
`;
    assert.deepEqual(findMismatchedUrls(md, approved), [
      "https://hallucinated.com/x",
    ]);
  });

  it("ignora footer/affiliate URLs", () => {
    const approved = { noticias: [{ title: "N", url: "https://example.com/n" }] };
    const md = `
[**N**](https://example.com/n)
[Cursos](https://diaria.beehiiv.com/cursos-gratuitos-de-ia)
[Wispr](https://wisprflow.ai/r?x=y)
[Wiki](https://pt.wikipedia.org/wiki/X)
`;
    assert.deepEqual(findMismatchedUrls(md, approved), []);
  });

  it("retorna vazio quando MD não introduziu URLs novas", () => {
    const approved = {
      highlights: [{ article: { url: "https://a.com/x" } }],
      noticias: [{ url: "https://b.com/y" }],
    };
    const md = `
[T1](https://a.com/x)
[T2](https://b.com/y)
`;
    assert.deepEqual(findMismatchedUrls(md, approved), []);
  });
});
