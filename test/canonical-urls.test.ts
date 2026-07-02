import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getCanonicalUrls,
  lookupCanonicalUrl,
  extractUrlsFromMd,
  findMismatchedUrls,
  FOOTER_DOMAINS,
  DIARIA_FACEBOOK_PAGE_SLUG,
  DIARIA_FACEBOOK_PAGE_URL,
  DIARIA_LINKEDIN_PAGE_SLUG,
  DIARIA_LINKEDIN_PAGE_URL,
  DIARIA_INSTAGRAM_SLUG,
  DIARIA_INSTAGRAM_URL,
  DIARIA_THREADS_SLUG,
  DIARIA_THREADS_URL,
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
      radar: [
        { title: "Pesq", url: "https://p.com/x" },
        { title: "Not", url: "https://n.com/x" }
      ],
    });
    assert.equal(lookupCanonicalUrl(map, "Runner"), "https://r.com/x");
    assert.equal(lookupCanonicalUrl(map, "Lanca"), "https://l.com/x");
    assert.equal(lookupCanonicalUrl(map, "Pesq"), "https://p.com/x");
    assert.equal(lookupCanonicalUrl(map, "Not"), "https://n.com/x");
  });

  it("normalizeTitle: aceita variações de case/acentos no lookup", () => {
    const map = getCanonicalUrls({
      radar: [{ title: "SoberanIA: plataforma nacional", url: "https://br247.com/x" }],
    });
    // Lookup com case diferente ainda casa via normalizeTitle
    assert.equal(
      lookupCanonicalUrl(map, "SOBERANIA: PLATAFORMA NACIONAL"),
      "https://br247.com/x",
    );
  });

  it("retorna undefined pra título não encontrado", () => {
    const map = getCanonicalUrls({
      radar: [{ title: "Real Title", url: "https://x.com/y" }],
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

  // #1456 review fix
  it("ignora frontmatter com CRLF (Windows OneDrive)", () => {
    const md = "---\r\nintentional_error:\r\n  url: \"https://yaml.com/x\"\r\n---\r\n\r\n[**Real**](https://body.com/y)\r\n";
    assert.deepEqual(extractUrlsFromMd(md), ["https://body.com/y"]);
  });
});

describe("findMismatchedUrls (#1456)", () => {
  it("retorna URLs do MD que não estão no approved JSON", () => {
    const approved = {
      highlights: [{ article: { title: "T1", url: "https://example.com/d1" } }],
      radar: [{ title: "N1", url: "https://example.com/n1" }],
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
    const approved = { radar: [{ title: "N", url: "https://example.com/n" }] };
    const md = `
[**N**](https://example.com/n)
[Cursos](https://diaria.beehiiv.com/cursos-gratuitos-de-ia)
[Wispr](https://wisprflow.ai/r?x=y)
[Wiki](https://pt.wikipedia.org/wiki/X)
`;
    assert.deepEqual(findMismatchedUrls(md, approved), []);
  });

  it("ignora links das páginas sociais oficiais (LinkedIn + Facebook) (#2675)", () => {
    // #2675: o rodapé linka as páginas sociais com os handles canônicos diar.ia.br.
    // findMismatchedUrls não pode marcá-los como edição manual fora do approved JSON.
    const approved = { radar: [{ title: "N", url: "https://example.com/n" }] };
    const md = `
[**N**](https://example.com/n)
[LinkedIn](https://www.linkedin.com/company/diar.ia.br/)
[Facebook](https://www.facebook.com/diar.ia.br)
`;
    assert.deepEqual(findMismatchedUrls(md, approved), []);
  });

  // #2695: FOOTER_DOMAINS foi consolidado — antes canonical-urls.ts só reconhecia
  // pt.wikipedia.org/commons.wikimedia.org (aqui) enquanto check-stage2-invariants.ts
  // já usava as variantes amplas (wikipedia.org/wikimedia.org, "todas as variantes")
  // + wikidata.org + os Workers de template. Trava o comportamento consolidado —
  // sem este teste, um futuro rename da constante poderia estreitar a lista de volta
  // sem que nada acusasse.
  it("ignora variantes amplas de wikipedia/wikimedia + wikidata + Workers de template (#2695)", () => {
    const approved = { radar: [{ title: "N", url: "https://example.com/n" }] };
    const md = `
[**N**](https://example.com/n)
[Wiki EN](https://en.wikipedia.org/wiki/X)
[Wikimedia upload](https://upload.wikimedia.org/wikipedia/commons/x.jpg)
[Wikidata](https://www.wikidata.org/wiki/Q1)
[Cursos](https://cursos.diaria.workers.dev)
[Livros](https://livros.diaria.workers.dev)
[Poll](https://poll.diaria.workers.dev/vote)
`;
    assert.deepEqual(findMismatchedUrls(md, approved), []);
  });

  it("DIARIA_FACEBOOK_PAGE_SLUG/URL têm o handle canônico e FOOTER_DOMAINS deriva dele (#2695)", () => {
    assert.equal(DIARIA_FACEBOOK_PAGE_SLUG, "facebook.com/diar.ia.br");
    assert.equal(DIARIA_FACEBOOK_PAGE_URL, "https://www.facebook.com/diar.ia.br");
    assert.ok(FOOTER_DOMAINS.includes(DIARIA_FACEBOOK_PAGE_SLUG));
  });

  it("retorna vazio quando MD não introduziu URLs novas", () => {
    const approved = {
      highlights: [{ article: { url: "https://a.com/x" } }],
      radar: [{ url: "https://b.com/y" }],
    };
    const md = `
[T1](https://a.com/x)
[T2](https://b.com/y)
`;
    assert.deepEqual(findMismatchedUrls(md, approved), []);
  });
});

describe("URLs canônicas LinkedIn/Instagram/Threads (#2790)", () => {
  it("DIARIA_LINKEDIN_PAGE_SLUG/URL têm o handle canônico", () => {
    assert.equal(DIARIA_LINKEDIN_PAGE_SLUG, "linkedin.com/company/diar.ia.br");
    assert.equal(DIARIA_LINKEDIN_PAGE_URL, "https://www.linkedin.com/company/diar.ia.br/");
  });

  it("DIARIA_INSTAGRAM_SLUG/URL têm o handle canônico", () => {
    assert.equal(DIARIA_INSTAGRAM_SLUG, "instagram.com/diaria");
    assert.equal(DIARIA_INSTAGRAM_URL, "https://www.instagram.com/diaria");
  });

  it("DIARIA_THREADS_SLUG/URL têm o handle canônico", () => {
    assert.equal(DIARIA_THREADS_SLUG, "threads.net/@diar.ia.br");
    assert.equal(DIARIA_THREADS_URL, "https://www.threads.net/@diar.ia.br");
  });

  it("platform.config.json espelha DIARIA_LINKEDIN_PAGE_URL EXATAMENTE (não só o slug — reforça o drift-guard de lint-social-md.test.ts)", () => {
    const cfg = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "platform.config.json"), "utf8"),
    );
    assert.equal(cfg.publishing.social.linkedin.diaria_linkedin_page_url, DIARIA_LINKEDIN_PAGE_URL);
  });

  // #2790: antes desta issue, LinkedIn tinha ≥5 cópias hardcoded independentes
  // (monthly-render SOCIAL_LINKS, lint-social-md DIARIA_LINKEDIN_PAGE_SLUG,
  // build-link-ctr ownChannels, stitch-newsletter PARA ENCERRAR,
  // platform.config.json) — Instagram/Threads tinham 1-2. Agora os 4 arquivos
  // de código importam de canonical-urls.ts; scan estático do source garante
  // que ninguém reintroduz um literal duplicado no lugar do import.
  it("consumidores importam de canonical-urls.ts em vez de hardcodar os literais de novo", () => {
    const root = join(import.meta.dirname, "..");
    const consumers = [
      "scripts/lib/mensal/monthly-render.ts",
      // #2833: DIARIA_LINKEDIN_PAGE_SLUG import moved from lint-social-md.ts
      // to lib/social-lint-rules.ts (pure extraction) — check the new home.
      "scripts/lib/social-lint-rules.ts",
      "scripts/build-link-ctr.ts",
      "scripts/stitch-newsletter.ts",
    ];
    const bannedLiterals = [
      "https://www.linkedin.com/company/diar.ia.br",
      "https://www.instagram.com/diaria",
      "https://www.threads.net/@diar.ia.br",
    ];
    for (const file of consumers) {
      const src = readFileSync(join(root, file), "utf8");
      assert.ok(
        src.includes("canonical-urls.ts"),
        `${file} deve importar de canonical-urls.ts`,
      );
      for (const literal of bannedLiterals) {
        assert.ok(
          !src.includes(literal),
          `${file} não deve hardcodar "${literal}" de novo — usar a constante importada`,
        );
      }
    }
  });
});
