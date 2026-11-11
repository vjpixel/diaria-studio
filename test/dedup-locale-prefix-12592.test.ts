/**
 * test/dedup-locale-prefix-12592.test.ts (#12592)
 *
 * Regressão: na edição 261109 o pool trouxe
 * `https://openai.com/pt-BR/index/introducing-gpt-6-sol-and-luna/` como link
 * novo, mas `data/past-editions.md` já tinha a mesma página publicada sem o
 * prefixo de idioma (`https://openai.com/index/introducing-gpt-6-sol-and-luna/`).
 * O dedup compara por `canonicalize`, que mantinha o `/pt-BR/`, e a
 * repetição passou até o editor notar no gate 4.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedup } from "../scripts/dedup.ts";
import { canonicalize, dedupUrlKey } from "../scripts/lib/url-utils.ts";

const PUBLISHED = "https://openai.com/index/introducing-gpt-6-sol-and-luna/";
const POOL_PT_BR = "https://openai.com/pt-BR/index/introducing-gpt-6-sol-and-luna/";

describe("dedupUrlKey (#12592)", () => {
  it("o par real da 261109 vira a mesma chave", () => {
    assert.equal(dedupUrlKey(POOL_PT_BR), dedupUrlKey(PUBLISHED));
  });

  it("remove prefixo com região em qualquer domínio, sem diferenciar caixa", () => {
    assert.equal(dedupUrlKey("https://example.com/en-US/blog/x"), "https://example.com/blog/x");
    assert.equal(dedupUrlKey("https://example.com/pt-br/blog/x"), "https://example.com/blog/x");
    assert.equal(dedupUrlKey("https://example.com/zh-Hans/blog/x"), "https://example.com/blog/x");
    assert.equal(dedupUrlKey("https://example.com/pt_BR/blog/x"), "https://example.com/blog/x");
  });

  it("prefixo de 2 letras só sai nos domínios com idioma no caminho", () => {
    assert.equal(dedupUrlKey("https://www.anthropic.com/pt/news/x"), "https://www.anthropic.com/news/x");
    assert.equal(dedupUrlKey("https://blog.google/en/products/x"), "https://blog.google/products/x");
    // Fora da lista, `/it/` ou `/ai/` pode ser seção real: fica.
    assert.equal(dedupUrlKey("https://example.com/it/noticia"), "https://example.com/it/noticia");
    assert.equal(dedupUrlKey("https://example.com/ai/noticia"), "https://example.com/ai/noticia");
  });

  it("só o 1º segmento conta, e a raiz com idioma vira a raiz", () => {
    assert.equal(dedupUrlKey("https://example.com/blog/en-US/x"), "https://example.com/blog/en-US/x");
    assert.equal(dedupUrlKey("https://openai.com/pt-BR/"), "https://openai.com/");
  });

  it("é idempotente e não toca URL sem prefixo nem URL inválida", () => {
    assert.equal(dedupUrlKey(dedupUrlKey(POOL_PT_BR)), dedupUrlKey(POOL_PT_BR));
    assert.equal(dedupUrlKey(PUBLISHED), canonicalize(PUBLISHED));
    assert.equal(dedupUrlKey("not a url"), "not a url");
  });

  it("canonicalize continua preservando o prefixo (o link do leitor não muda)", () => {
    assert.match(canonicalize(POOL_PT_BR), /\/pt-BR\//);
  });
});

// #12800: o formato `xx-yy` casava slug comum em qualquer domínio e fundia
// URLs distintas na mesma chave.
describe("dedupUrlKey não confunde slug com idioma (#12800)", () => {
  const SLUGS = ["ai-news", "my-blog", "ai-labs", "lg-ai", "go-live", "ai_tool", "mo-labs", "it-ai", "de-ai"];
  for (const slug of SLUGS) {
    it(`/${slug}/ fica na chave`, () => {
      const url = `https://example.com/${slug}/x`;
      assert.equal(dedupUrlKey(url), canonicalize(url));
    });
  }

  it("cenário da issue: /ai-news e /my-blog continuam chaves distintas", () => {
    assert.notEqual(dedupUrlKey("https://example.com/ai-news"), dedupUrlKey("https://example.com/my-blog"));
  });

  it("cenário da issue: donos diferentes no GitHub não colapsam", () => {
    assert.notEqual(dedupUrlKey("https://github.com/ai-labs/foo"), dedupUrlKey("https://github.com/mo-labs/foo"));
  });

  it("dedup() não descarta a 2ª URL de slug parecido com idioma (Pass 2a)", () => {
    const result = dedup(
      [
        { url: "https://example.com/ai-news", title: "Notícias de IA desta semana no mercado" },
        { url: "https://example.com/my-blog", title: "Como montei um blog pessoal do zero" },
      ],
      new Set(),
      0.85,
    );
    assert.equal(result.kept.length, 2);
  });

  it("locales reais seguem saindo, em qualquer caixa e separador", () => {
    for (const loc of ["pt-BR", "en-us", "en-GB", "es-MX", "fr-CA", "zh-Hant", "ja-JP", "de_DE"]) {
      assert.equal(dedupUrlKey(`https://example.com/${loc}/blog/x`), "https://example.com/blog/x", loc);
    }
  });

  it("blog.google com idioma no 2º segmento (/intl/pt-br/) vira a mesma chave", () => {
    assert.equal(
      dedupUrlKey("https://blog.google/intl/pt-br/products/x"),
      dedupUrlKey("https://blog.google/products/x"),
    );
    // Fora dos domínios com idioma no caminho, `/intl/` é seção comum.
    assert.equal(dedupUrlKey("https://example.com/intl/pt-br/x"), "https://example.com/intl/pt-br/x");
  });
});

describe("dedup() com prefixo de idioma (#12592)", () => {
  it("bloqueia a variante /pt-BR/ de URL já publicada sem prefixo", () => {
    const pastUrls = new Set([canonicalize(PUBLISHED)]);
    const result = dedup(
      [
        { url: POOL_PT_BR, title: "Introducing GPT-6 Sol and Luna" },
        { url: "https://example.com/outra-noticia", title: "Outra notícia sem relação nenhuma" },
      ],
      pastUrls,
      0.85,
    );
    assert.deepEqual(result.kept.map((a) => a.url), ["https://example.com/outra-noticia"]);
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0].url, POOL_PT_BR);
    assert.match(result.removed[0].dedup_note ?? "", /url-match com edição anterior/);
  });

  it("bloqueia o sentido inverso (publicada com /pt-BR/, pool sem)", () => {
    const result = dedup([{ url: PUBLISHED, title: "Introducing GPT-6 Sol and Luna" }], new Set([canonicalize(POOL_PT_BR)]), 0.85);
    assert.equal(result.kept.length, 0);
  });

  it("funde no Pass 2 as duas variantes de idioma da mesma página no pool", () => {
    const result = dedup(
      [
        { url: PUBLISHED, title: "Introducing GPT-6 Sol and Luna" },
        { url: POOL_PT_BR, title: "Apresentando GPT-6 Sol e Luna" },
      ],
      new Set(),
      0.85,
    );
    assert.equal(result.kept.length, 1);
  });
});
