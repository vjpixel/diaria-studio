/**
 * test/arquivo-render.test.ts (#4105)
 *
 * Cobre `workers/arquivo/src/render-archive.ts` (buildArchiveHtml — grouping +
 * render puro, testável sem rede) e `workers/arquivo/src/index.ts` (fetch
 * handler completo, incluindo o caminho de falha de fetch/parse do sitemap
 * via mock de `globalThis.fetch`, sem chamada externa real).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildArchiveHtml,
  buildArquivoFaq,
  buildTemaNav,
  displayTextFromLoc,
  esc,
} from "../workers/arquivo/src/render-archive.ts";
import type { TitlesCacheMap } from "../workers/arquivo/src/render-archive.ts";
import type { SitemapEntry } from "../scripts/lib/fetch-sitemap.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";
import { HUB_REGISTRY, HUB_LASTMOD } from "../workers/arquivo/src/hubs/registry.ts";
import worker from "../workers/arquivo/src/index.ts";

function entry(loc: string, lastmod: string | null): SitemapEntry {
  return { loc, lastmod };
}

describe("buildArchiveHtml (#4105)", () => {
  it("gera <a href> real pra cada entrada /p/*", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/anthropic-lanca-claude", "2026-07-27"),
      entry("https://diar.ia.br/p/google-lanca-gemini", "2026-07-20"),
    ]);
    assert.match(
      html,
      /<a href="https:\/\/diar\.ia\.br\/p\/anthropic-lanca-claude">/,
    );
    assert.match(
      html,
      /<a href="https:\/\/diar\.ia\.br\/p\/google-lanca-gemini">/,
    );
  });

  it("exclui entradas que não são /p/* (home, archive, tags, subscribe, authors)", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/", "2026-07-27"),
      entry("https://diar.ia.br/archive", "2026-07-27"),
      entry("https://diar.ia.br/tags", "2026-07-27"),
      entry("https://diar.ia.br/subscribe", "2026-07-27"),
      entry("https://diar.ia.br/authors/alguem", "2026-07-27"),
      entry("https://diar.ia.br/p/edicao-real", "2026-07-27"),
    ]);
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/p\/edicao-real">/);
    assert.doesNotMatch(html, /href="https:\/\/diar\.ia\.br\/"/);
    assert.doesNotMatch(html, /href="https:\/\/diar\.ia\.br\/archive"/);
    assert.doesNotMatch(html, /href="https:\/\/diar\.ia\.br\/tags"/);
    // Nunca como item DA LISTA (`<li><a href=...>`) — o CTA de assinatura
    // fixo no header (#4265 item 4) legitimamente linka pra /subscribe fora
    // da lista, então a assertiva não pode ser "a string nunca aparece na
    // página inteira".
    assert.doesNotMatch(html, /<li><a href="https:\/\/diar\.ia\.br\/subscribe"/);
    assert.doesNotMatch(html, /href="https:\/\/diar\.ia\.br\/authors\/alguem"/);
  });

  it("descarta entradas /p/* sem lastmod (não dá pra agrupar)", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/sem-data", null),
      entry("https://diar.ia.br/p/com-data", "2026-07-27"),
    ]);
    assert.doesNotMatch(html, /sem-data/);
    assert.match(html, /com-data/);
  });

  it("agrupa por ano-mês e ordena meses do mais recente pro mais antigo", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/edicao-maio", "2026-05-10"),
      entry("https://diar.ia.br/p/edicao-julho", "2026-07-15"),
      entry("https://diar.ia.br/p/edicao-junho", "2026-06-01"),
    ]);
    const idxJulho = html.indexOf("julho de 2026");
    const idxJunho = html.indexOf("junho de 2026");
    const idxMaio = html.indexOf("maio de 2026");
    assert.ok(idxJulho > -1 && idxJunho > -1 && idxMaio > -1, "os 3 meses aparecem");
    assert.ok(idxJulho < idxJunho, "julho vem antes de junho");
    assert.ok(idxJunho < idxMaio, "junho vem antes de maio");
  });

  it("dentro de um mês, ordena edições da mais recente pra mais antiga", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/dia-05", "2026-07-05"),
      entry("https://diar.ia.br/p/dia-20", "2026-07-20"),
      entry("https://diar.ia.br/p/dia-10", "2026-07-10"),
    ]);
    const idx20 = html.indexOf("dia-20");
    const idx10 = html.indexOf("dia-10");
    const idx05 = html.indexOf("dia-05");
    assert.ok(idx20 < idx10 && idx10 < idx05, "dia 20 > dia 10 > dia 05");
  });

  it("lista vazia não quebra — retorna HTML válido com mensagem", () => {
    const html = buildArchiveHtml([]);
    assert.match(html, /<html/);
    assert.match(html, /Nenhuma edição encontrada/);
  });

  it("lista só com entradas não-/p/ produz 0 edições sem quebrar", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/archive", "2026-07-27"),
      entry("https://diar.ia.br/tags", "2026-07-27"),
    ]);
    assert.match(html, /0 ediç/);
  });

  it("(#4265) <head> tem viewport, canonical e OG/Twitter — não regride numa refatoração futura", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/edicao-real", "2026-07-27"),
    ]);
    assert.match(
      html,
      /<meta name="viewport" content="width=device-width, initial-scale=1">/,
    );
    assert.match(
      html,
      /<link rel="canonical" href="https:\/\/arquivo\.diar\.ia\.br\/">/,
    );
    assert.match(html, /<meta property="og:title" content="[^"]+">/);
    assert.match(html, /<meta property="og:description" content="[^"]+">/);
    assert.match(html, /<meta property="og:url" content="[^"]+">/);
    assert.match(html, /<meta name="twitter:card" content="summary">/);
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml/);
  });

  it("(#4265) tem CSS do DS canônico (não renderiza mais no default do navegador)", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/edicao-real", "2026-07-27"),
    ]);
    assert.match(html, /<style>/);
    assert.match(html, /#00A0A0/); // teal do DS
    assert.match(html, /Georgia/); // serif do DS
  });

  it("(#4265) os 225 <a href> continuam intactos com o novo layout (objetivo primário do #4105 não regride)", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/edicao-a", "2026-07-27"),
      entry("https://diar.ia.br/p/edicao-b", "2026-06-15"),
    ]);
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/p\/edicao-a">/);
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/p\/edicao-b">/);
  });

  it("aceita lastmod datetime ISO completo (não só YYYY-MM-DD)", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/com-hora", "2026-07-27T14:30:00Z"),
    ]);
    assert.match(html, /julho de 2026/);
    assert.match(html, /com-hora/);
  });

  it("(#4312) o UTM do link de rodapé pra diar.ia.br está catalogado em UTM_EMITTERS", async () => {
    // Regressão: #4299 introduziu o literal solto `utm_source=arquivo&...`
    // direto no call site (violando a regra do próprio utm-registry.ts) e
    // nenhum teste pegou, porque `knownUtmSources()` DERIVA de
    // `UTM_EMITTERS` — sem a entrada, o "furo" era invisível pros testes
    // existentes (`test/utm-registry-4041.test.ts`/`test/studio-utms-4041.test.ts`).
    // Este teste lê o `utm_source`/`utm_medium` de fato emitidos pelo render
    // e confere contra o registry — falha SEM a entrada `arquivo-footer-nav`.
    const { knownUtmSources, ARQUIVO_FOOTER_NAV_UTM } = await import(
      "../scripts/lib/shared/utm-registry.ts"
    );
    const html = buildArchiveHtml([entry("https://diar.ia.br/p/edicao-a", "2026-07-27")]);
    const m = /href="https:\/\/diar\.ia\.br\/?\?(utm_source=[^"]+)"/.exec(html);
    assert.ok(m, "link 'diar.ia.br' do rodapé não tem UTM na URL");
    // `escHtml` (aplicado no `href`) escreve `&` como `&amp;` — desfaz antes
    // de parsear a query string.
    const params = new URLSearchParams(m[1].replace(/&amp;/g, "&"));
    const utmSource = params.get("utm_source");
    const utmMedium = params.get("utm_medium");
    assert.equal(utmSource, ARQUIVO_FOOTER_NAV_UTM.source);
    assert.equal(utmMedium, ARQUIVO_FOOTER_NAV_UTM.medium);
    assert.ok(
      knownUtmSources().includes((utmSource ?? "").toLowerCase()),
      `utm_source="${utmSource}" emitido pelo render mas ausente de UTM_EMITTERS`,
    );
  });

  describe("(#4265 item 1) título real do titles-cache.json", () => {
    it("slug com acento removido renderiza o TÍTULO REAL do cache, não o texto derivado do slug", () => {
      const cache: TitlesCacheMap = {
        "anthropic-lan-a-o-claude-opus-5": {
          title: "Anthropic lança o Claude Opus 5",
          publishDate: "2026-07-28",
        },
      };
      const html = buildArchiveHtml(
        [entry("https://diar.ia.br/p/anthropic-lan-a-o-claude-opus-5", "2026-07-28")],
        cache,
      );
      assert.match(html, /Anthropic lança o Claude Opus 5/);
      // O texto derivado-do-slug quebrado NÃO deve aparecer mais.
      assert.doesNotMatch(html, /Anthropic lan a o claude opus 5/);
    });

    it("slug AUSENTE do cache cai no displayTextFromLoc atual e continua na lista (nunca some um <a href>)", () => {
      const cache: TitlesCacheMap = {
        "outro-slug-qualquer": { title: "Outro título", publishDate: "2026-07-01" },
      };
      const html = buildArchiveHtml(
        [entry("https://diar.ia.br/p/slug-sem-cache", "2026-07-15")],
        cache,
      );
      // continua tendo o <a href> real (nunca dropa o link por falta de título)
      assert.match(html, /<a href="https:\/\/diar\.ia\.br\/p\/slug-sem-cache">/);
      // e o texto é o fallback derivado do slug (mesmo comportamento pré-#4265)
      assert.match(html, />Slug sem cache</);
    });
  });

  describe("(#4265 item 2) agrupamento usa publish_date do cache, lastmod como fallback", () => {
    it("usa publishDate do cache pra decidir o MÊS, mesmo com lastmod de outro mês (edição editada depois)", () => {
      // Edição publicada em julho mas EDITADA em agosto (lastmod pula pro mês
      // errado) — #4265 item 2. Sem o cache, cairia em "agosto de 2026".
      const cache: TitlesCacheMap = {
        "edicao-julho-editada-em-agosto": {
          title: "Edição de julho, editada depois",
          publishDate: "2026-07-15",
        },
      };
      const html = buildArchiveHtml(
        [entry("https://diar.ia.br/p/edicao-julho-editada-em-agosto", "2026-08-02")],
        cache,
      );
      assert.match(html, /julho de 2026/);
      assert.doesNotMatch(html, /agosto de 2026/);
    });

    it("slug ausente do cache usa lastmod (fallback) pra agrupar, como antes do #4265", () => {
      const html = buildArchiveHtml(
        [entry("https://diar.ia.br/p/sem-cache-nenhum", "2026-05-10")],
        {},
      );
      assert.match(html, /maio de 2026/);
    });
  });

  describe("(#4265 item 3) data por edição exibida na lista", () => {
    it("mostra o dia (DD/MM) da publishDate do cache junto do título", () => {
      const cache: TitlesCacheMap = {
        "com-data-no-cache": { title: "Edição com data", publishDate: "2026-07-28" },
      };
      const html = buildArchiveHtml(
        [entry("https://diar.ia.br/p/com-data-no-cache", "2026-07-20")],
        cache,
      );
      // dia vem do CACHE (28/07), não do lastmod (que seria 20/07)
      assert.match(html, /28\/07/);
      assert.doesNotMatch(html, /20\/07/);
    });

    it("sem cache, mostra o dia derivado do lastmod (fallback)", () => {
      const html = buildArchiveHtml(
        [entry("https://diar.ia.br/p/sem-cache-data", "2026-06-05")],
        {},
      );
      assert.match(html, /05\/06/);
    });
  });

  describe("(#4265 item 5) índice de âncoras por mês", () => {
    it("emite <nav> com <a href='#YYYY-MM'> por mês, e as <section> ganham id correspondente", () => {
      const html = buildArchiveHtml([
        entry("https://diar.ia.br/p/edicao-julho", "2026-07-15"),
        entry("https://diar.ia.br/p/edicao-maio", "2026-05-10"),
      ]);
      assert.match(html, /<nav class="month-index"/);
      assert.match(html, /<a href="#2026-07">julho de 2026<\/a>/);
      assert.match(html, /<a href="#2026-05">maio de 2026<\/a>/);
      assert.match(html, /<section id="2026-07">/);
      assert.match(html, /<section id="2026-05">/);
    });
  });

  describe("(#4265 item 4) CTA de assinatura + caminho de volta pro site", () => {
    it("tem um link de assinatura (CTA) fora da lista de edições", () => {
      const html = buildArchiveHtml([entry("https://diar.ia.br/p/edicao-x", "2026-07-15")]);
      assert.match(html, /<p class="subscribe-cta"><a href="https:\/\/diar\.ia\.br\/subscribe">/);
    });

    it("o rodapé continua linkando de volta pra diar.ia.br (nav cruzada já existente)", () => {
      const html = buildArchiveHtml([entry("https://diar.ia.br/p/edicao-x", "2026-07-15")]);
      assert.match(html, /<footer>/);
      assert.match(html, /href="https:\/\/diar\.ia\.br\?utm_source=/);
    });
  });
});

describe("estrutura GEO (#4558 Parte B)", () => {
  it("H2 em formato de pergunta + FAQ (6-10 perguntas) + byline aparecem no HTML", () => {
    const html = buildArchiveHtml([entry("https://diar.ia.br/p/edicao-a", "2026-07-27")]);
    assert.match(html, /<h2 class="geo-h2">Quais são todas as edições já publicadas da diar\.ia\.br\?<\/h2>/);
    assert.match(html, /<section class="geo-faq"/);
    const faqQuestions = [...html.matchAll(/<div class="geo-faq-item">\s*<h2>/g)];
    assert.ok(faqQuestions.length >= 6 && faqQuestions.length <= 10, `FAQ deve ter 6-10 perguntas, achou ${faqQuestions.length}`);
    assert.match(html, /Por <a href="https:\/\/www\.linkedin\.com\/in\/vjpixel\/" rel="author">Pixel<\/a>/);
  });

  it("JSON-LD (FAQPage + Article) presente, válido, e no FIM do body (não antes das seções)", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/edicao-julho", "2026-07-15"),
      entry("https://diar.ia.br/p/edicao-maio", "2026-05-10"),
    ]);
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, "deve ter 1 <script type=application/ld+json>");
    const jsonLd = JSON.parse(m![1]);
    const types = jsonLd["@graph"].map((n: { "@type": string }) => n["@type"]);
    assert.deepEqual(types.sort(), ["Article", "FAQPage"]);

    // O JSON-LD deve vir DEPOIS de todas as <section> — regressão do bug
    // achado em 260804: colocá-lo no <head> quebrava a ordem cronológica
    // que outro teste afirma sobre a 1ª ocorrência de cada label de mês.
    const idxJsonLd = html.indexOf('<script type="application/ld+json">');
    const idxLastSection = html.lastIndexOf("</section>");
    assert.ok(idxJsonLd > idxLastSection, "JSON-LD deve vir depois de todas as <section>");
  });

  it("meses citados no header (geo-intro) não quebram a ordem cronológica das seções (regressão 260804)", () => {
    // #4558: geo-intro NÃO deve citar mês/ano específico (só o FAQ, que vem
    // depois das seções, pode) — senão a 1ª ocorrência de "{mês} de {ano}"
    // aparece no header (antes das seções) em vez de na seção certa.
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/edicao-julho", "2026-07-15"),
      entry("https://diar.ia.br/p/edicao-junho", "2026-06-01"),
      entry("https://diar.ia.br/p/edicao-maio", "2026-05-10"),
    ]);
    const idxJulho = html.indexOf("julho de 2026");
    const idxJunho = html.indexOf("junho de 2026");
    const idxMaio = html.indexOf("maio de 2026");
    assert.ok(idxJulho < idxJunho && idxJunho < idxMaio, "ordem cronológica das seções deve continuar intacta");
  });

  it("Article JSON-LD traz autor (Pixel) nomeado e verificável", () => {
    const html = buildArchiveHtml([entry("https://diar.ia.br/p/edicao-a", "2026-07-27")]);
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
    const article = jsonLd["@graph"].find((n: { "@type": string }) => n["@type"] === "Article");
    assert.equal(article.author.name, "Pixel");
    assert.equal(article.author.url, "https://www.linkedin.com/in/vjpixel/");
  });

  it("Article dateModified reflete a edição mais recente (dinâmico, mas determinístico — não Date.now())", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/edicao-recente", "2026-07-27"),
      entry("https://diar.ia.br/p/edicao-antiga", "2026-01-05"),
    ]);
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
    const article = jsonLd["@graph"].find((n: { "@type": string }) => n["@type"] === "Article");
    assert.equal(article.dateModified, "2026-07-27");
  });
});

describe("buildArquivoFaq (#4558 Parte B)", () => {
  it("é pure e usa os números recebidos, nunca inventa dado", () => {
    const faq = buildArquivoFaq(42, 3, "maio de 2026", "julho de 2026");
    const joined = faq.map((f) => `${f.question} ${f.answer}`).join(" ");
    assert.match(joined, /42/);
    assert.match(joined, /maio de 2026/);
    assert.match(joined, /julho de 2026/);
  });

  it("sem edições (count=0), não afirma um intervalo de datas inexistente", () => {
    const faq = buildArquivoFaq(0, 0, null, null);
    const joined = faq.map((f) => f.answer).join(" ");
    assert.doesNotMatch(joined, /undefined|null/);
  });

  it("retorna entre 6 e 10 perguntas", () => {
    const faq = buildArquivoFaq(10, 2, "junho de 2026", "julho de 2026");
    assert.ok(faq.length >= 6 && faq.length <= 10);
  });
});

describe("displayTextFromLoc (#4105)", () => {
  it("troca hífen por espaço e capitaliza a 1ª letra", () => {
    assert.equal(
      displayTextFromLoc("https://diar.ia.br/p/anthropic-lanca-claude-opus-5"),
      "Anthropic lanca claude opus 5",
    );
  });

  it("não faz fetch nenhum — é puro, deriva só da URL", () => {
    // Se isso lançasse ou dependesse de rede, o teste falharia por timeout;
    // passar rápido comprova que é 100% derivado do slug.
    const text = displayTextFromLoc("https://diar.ia.br/p/slug-qualquer");
    assert.equal(text, "Slug qualquer");
  });
});

describe("esc (#4105)", () => {
  it("escapa <, >, &, aspas", () => {
    assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("workers/arquivo GET / — fetch handler (#4105)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sitemap ok → 200 com <a href> reais + Cache-Control de 1h", async () => {
    const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://diar.ia.br/</loc><lastmod>2026-07-27</lastmod></url>
  <url><loc>https://diar.ia.br/p/edicao-de-teste</loc><lastmod>2026-07-27</lastmod></url>
</urlset>`;
    globalThis.fetch = (async () =>
      new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
    const body = await res.text();
    assert.match(body, /<a href="https:\/\/diar\.ia\.br\/p\/edicao-de-teste">/);
  });

  it("HTTP não-200 do sitemap → página de erro (502), nunca lança sem tratamento", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"));
    assert.equal(res.status, 502);
    assert.match(await res.text(), /indisponível/);
  });

  it("erro de rede (fetch rejeita) → página de erro (502), nunca lança sem tratamento", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"));
    assert.equal(res.status, 502);
    assert.match(await res.text(), /indisponível/);
  });

  it("sitemap XML malformado → página de erro (502), nunca lança sem tratamento", async () => {
    globalThis.fetch = (async () =>
      new Response("<not-xml>>", { status: 200 })) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"));
    assert.equal(res.status, 502);
  });

  it("path != / (e != /sitemap.xml) → 404", async () => {
    globalThis.fetch = (async () => {
      throw new Error("não deveria fazer fetch nenhum pra path != /");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/outra-coisa"));
    assert.equal(res.status, 404);
  });

  it("GET /sitemap.xml → 200 XML com a própria PAGE_URL, sem fetch externo (#4546)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("/sitemap.xml não deveria depender do sitemap remoto");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/sitemap.xml"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /xml/);
    const body = await res.text();
    assert.match(body, /<urlset/);
    assert.match(body, /<loc>https:\/\/arquivo\.diar\.ia\.br\/<\/loc>/);
  });

  it("Referer de assistente de IA conhecido → loga ai_referrer_hit E a página continua respondendo normalmente (#4558 Parte C)", async () => {
    const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://diar.ia.br/p/edicao-de-teste</loc><lastmod>2026-07-27</lastmod></url>
</urlset>`;
    globalThis.fetch = (async () => new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      const req = new Request("https://arquivo.diar.ia.br/", { headers: { Referer: "https://gemini.google.com/app" } });
      const res = await worker.fetch(req);
      assert.equal(res.status, 200);
      const hit = logs
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .find((p) => p?.event === "ai_referrer_hit");
      assert.ok(hit, "deve ter logado 1 ai_referrer_hit");
      assert.equal(hit.worker, "arquivo");
      assert.equal(hit.host, "gemini.google.com");
      assert.equal(hit.path, "/");
    } finally {
      console.log = originalLog;
    }
  });

  it("sem Referer de IA → não loga nada (#4558 Parte C)", async () => {
    const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    globalThis.fetch = (async () => new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      await worker.fetch(new Request("https://arquivo.diar.ia.br/"));
      const hit = logs
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .find((p) => p?.event === "ai_referrer_hit");
      assert.equal(hit, undefined);
    } finally {
      console.log = originalLog;
    }
  });

  function makeFakeKv() {
    const m = new Map<string, string>();
    return {
      async get(key: string) {
        return m.get(key) ?? null;
      },
      async put(key: string, value: string) {
        m.set(key, value);
      },
      async delete(key: string) {
        m.delete(key);
      },
      _map: m,
    } as unknown as KVNamespace & { _map: Map<string, string> };
  }

  it("User-Agent de bot nomeado → incrementa o contador ai-fetch no KV (#4902)", async () => {
    const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    globalThis.fetch = (async () => new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;
    const kv = makeFakeKv();
    const req = new Request("https://arquivo.diar.ia.br/", { headers: { "User-Agent": "OAI-SearchBot/1.0; +https://openai.com/searchbot" } });
    const res = await worker.fetch(req, { CURSOS_SUBSCRIBERS: kv });
    assert.equal(res.status, 200);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(kv._map.get(`counter:ai-fetch:bot:OAI-SearchBot:${day}`), "1");
  });

  it("User-Agent de bot de TREINO (GPTBot) → NÃO incrementa o contador ai-fetch (só recuperação, não treino)", async () => {
    const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    globalThis.fetch = (async () => new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;
    const kv = makeFakeKv();
    const req = new Request("https://arquivo.diar.ia.br/", { headers: { "User-Agent": "GPTBot/1.1" } });
    await worker.fetch(req, { CURSOS_SUBSCRIBERS: kv });
    // #5134 item 3: a raiz agora grava seu próprio cache de fallback no KV
    // (`cache:arquivo-root:*`) em todo sucesso — não é mais "mapa vazio" o
    // sinal de "nenhum contador ai-fetch incrementado", e sim "nenhuma
    // chave com o prefixo `counter:ai-fetch:`".
    const aiFetchKeys = [...kv._map.keys()].filter((k) => k.startsWith("counter:ai-fetch:"));
    assert.deepEqual(aiFetchKeys, []);
  });

  it("Referer de assistente de IA → também incrementa o contador ai-fetch:referrer no KV (#4902 item 2)", async () => {
    const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    globalThis.fetch = (async () => new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;
    const kv = makeFakeKv();
    const req = new Request("https://arquivo.diar.ia.br/", { headers: { Referer: "https://claude.ai/chat/abc" } });
    await worker.fetch(req, { CURSOS_SUBSCRIBERS: kv });
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(kv._map.get(`counter:ai-fetch:referrer:claude.ai:${day}`), "1");
  });

  it("sem binding CURSOS_SUBSCRIBERS (env vazio) → não lança, página responde normalmente (fail-soft)", async () => {
    const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    globalThis.fetch = (async () => new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;
    const req = new Request("https://arquivo.diar.ia.br/", { headers: { "User-Agent": "Googlebot/2.1" } });
    const res = await worker.fetch(req, {});
    assert.equal(res.status, 200);
  });

  it("GET /{INDEXNOW_KEY}.txt → 200 texto puro com a própria chave, quando a var está configurada (#4909 item 2)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("arquivo de chave do IndexNow não deveria depender de rede");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(
      new Request("https://arquivo.diar.ia.br/minha-chave-opaca.txt"),
      { INDEXNOW_KEY: "minha-chave-opaca" },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/plain/);
    assert.equal(await res.text(), "minha-chave-opaca");
  });

  it("GET /{INDEXNOW_KEY}.txt com chave errada → 404 (não vaza aceitando qualquer .txt)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("não deveria fazer fetch nenhum");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(
      new Request("https://arquivo.diar.ia.br/chave-errada.txt"),
      { INDEXNOW_KEY: "minha-chave-opaca" },
    );
    assert.equal(res.status, 404);
  });

  it("sem INDEXNOW_KEY configurada, qualquer /*.txt cai no 404 normal (comportamento idêntico a antes)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("não deveria fazer fetch nenhum");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/qualquer-coisa.txt"), {});
    assert.equal(res.status, 404);
  });

  it("GET /robots.txt → 200 texto com Allow: /, Sitemap: própria e sem fetch externo (#4546)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("/robots.txt não deveria depender de rede nenhuma");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/robots.txt"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/plain/);
    const body = await res.text();
    assert.match(body, /Allow: \//);
    assert.match(body, /Sitemap: https:\/\/arquivo\.diar\.ia\.br\/sitemap\.xml/);
    // liberação seletiva (#4546, decisão do editor): só Amazonbot e
    // CloudflareBrowserRenderingCrawler continuam bloqueados — os 7
    // crawlers de assistente/treino (GPTBot, ClaudeBot, CCBot,
    // Google-Extended, Bytespider, meta-externalagent, Applebot-Extended)
    // NÃO aparecem como Disallow.
    assert.match(body, /User-agent: Amazonbot\nDisallow: \//);
    assert.match(body, /User-agent: CloudflareBrowserRenderingCrawler\nDisallow: \//);
    for (const bot of [
      "GPTBot",
      "ClaudeBot",
      "CCBot",
      "Google-Extended",
      "Bytespider",
      "meta-externalagent",
      "Applebot-Extended",
    ]) {
      assert.doesNotMatch(body, new RegExp(`User-agent: ${bot}\\b`));
    }
  });

  it("GET /temas/anthropic-claude → 200 com o hub, sem fetch externo (#4558 Parte A)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("/temas/{slug} não deveria depender de rede — HTML já gerado e commitado");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/temas/anthropic-claude"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
    const body = await res.text();
    assert.match(body, /<h1>Anthropic e Claude/);
  });

  it("GET /temas/{slug} → Last-Modified (do updatedDate do hub) e ETag (#4909)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("/temas/{slug} não deveria depender de rede");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/temas/anthropic-claude"));
    assert.equal(res.status, 200);
    const lastMod = res.headers.get("Last-Modified");
    assert.ok(lastMod, "esperava header Last-Modified");
    // Deriva do MESMO updatedDate exposto em HUB_LASTMOD — nunca um valor
    // divergente/inventado à parte.
    assert.equal(new Date(lastMod!).toISOString().slice(0, 10), HUB_LASTMOD["anthropic-claude"]);
    const etag = res.headers.get("ETag");
    assert.ok(etag, "esperava header ETag");
    // #5134: ETag FRACO (`W/"..."`, não `"..."` forte) — CDNs/proxies
    // reversos (Cloudflare incluso) descartam um ETag forte ao comprimir a
    // resposta em trânsito; um fraco sobrevive. Ver docstring de
    // `weakEtag` em workers/arquivo/src/index.ts.
    assert.match(etag!, /^W\/"[0-9a-f]{8}"$/);
  });

  describe("requisição condicional em /temas/{slug} → 304 (#5134 itens 1-2)", () => {
    it("If-None-Match casando com o ETag atual → 304, corpo vazio", async () => {
      globalThis.fetch = (async () => {
        throw new Error("não deveria fazer fetch nenhum");
      }) as unknown as typeof fetch;

      const first = await worker.fetch(new Request("https://arquivo.diar.ia.br/temas/anthropic-claude"));
      const etag = first.headers.get("ETag")!;

      const res = await worker.fetch(
        new Request("https://arquivo.diar.ia.br/temas/anthropic-claude", {
          headers: { "If-None-Match": etag },
        }),
      );
      assert.equal(res.status, 304);
      assert.equal(await res.text(), "");
      assert.equal(res.headers.get("ETag"), etag);
    });

    it("If-None-Match com ETag DIFERENTE (conteúdo mudou) → 200 normal, não 304", async () => {
      const res = await worker.fetch(
        new Request("https://arquivo.diar.ia.br/temas/anthropic-claude", {
          headers: { "If-None-Match": '"etag-antigo-que-nao-bate"' },
        }),
      );
      assert.equal(res.status, 200);
    });

    it("If-None-Match: * → 304 sempre (representação já existe)", async () => {
      const res = await worker.fetch(
        new Request("https://arquivo.diar.ia.br/temas/anthropic-claude", {
          headers: { "If-None-Match": "*" },
        }),
      );
      assert.equal(res.status, 304);
    });

    it("If-Modified-Since NO PASSADO (antes do Last-Modified real) → 200 normal", async () => {
      const res = await worker.fetch(
        new Request("https://arquivo.diar.ia.br/temas/anthropic-claude", {
          headers: { "If-Modified-Since": "Mon, 01 Jan 2001 00:00:00 GMT" },
        }),
      );
      assert.equal(res.status, 200);
    });

    it("If-Modified-Since NO FUTURO (depois do Last-Modified real) → 304", async () => {
      const res = await worker.fetch(
        new Request("https://arquivo.diar.ia.br/temas/anthropic-claude", {
          headers: { "If-Modified-Since": "Sat, 01 Jan 2028 00:00:00 GMT" },
        }),
      );
      assert.equal(res.status, 304);
      assert.equal(await res.text(), "");
    });

    it("If-None-Match presente E não casa → ignora If-Modified-Since (RFC 7232 §3.3), continua 200", async () => {
      const res = await worker.fetch(
        new Request("https://arquivo.diar.ia.br/temas/anthropic-claude", {
          headers: {
            "If-None-Match": '"nao-bate"',
            // Sozinho, este header daria 304 (ver teste acima) — mas
            // If-None-Match tem precedência e não bateu, então o resultado
            // tem que ser 200, nunca 304 por causa do If-Modified-Since.
            "If-Modified-Since": "Sat, 01 Jan 2028 00:00:00 GMT",
          },
        }),
      );
      assert.equal(res.status, 200);
    });

    it("requisição SEM header condicional nenhum → 200 normal (comportamento pré-#5134)", async () => {
      const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/temas/anthropic-claude"));
      assert.equal(res.status, 200);
    });
  });

  it("GET /temas/{slug} desconhecido (404) não emite Last-Modified/ETag", async () => {
    globalThis.fetch = (async () => {
      throw new Error("não deveria fazer fetch nenhum");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/temas/tema-que-nao-existe"));
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Last-Modified"), null);
    assert.equal(res.headers.get("ETag"), null);
  });

  it("GET /temas/{slug-desconhecido} → 404 (#4558 Parte A)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("não deveria fazer fetch nenhum");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/temas/tema-que-nao-existe"));
    assert.equal(res.status, 404);
  });

  it("GET /temas/constructor (ou outra propriedade herdada de Object.prototype) → 404, não 200 com lixo (regressão do fleet review)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("não deveria fazer fetch nenhum");
    }) as unknown as typeof fetch;

    for (const slug of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const res = await worker.fetch(new Request(`https://arquivo.diar.ia.br/temas/${slug}`));
      assert.equal(res.status, 404, `slug "${slug}" deveria 404, não vazar propriedade de Object.prototype`);
    }
  });

  it("GET /sitemap.xml inclui um <url> por hub publicado (#4558 Parte A)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("/sitemap.xml não deveria depender do sitemap remoto");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/sitemap.xml"));
    const body = await res.text();
    assert.match(body, /<loc>https:\/\/arquivo\.diar\.ia\.br\/temas\/anthropic-claude<\/loc>/);
  });

  it("GET /sitemap.xml — cada <url> de hub traz <lastmod> com o updatedDate do hub (#4909)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("/sitemap.xml não deveria depender do sitemap remoto");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/sitemap.xml"));
    const body = await res.text();
    for (const slug of Object.keys(HUB_REGISTRY)) {
      const lastmod = HUB_LASTMOD[slug];
      assert.ok(lastmod, `HUB_LASTMOD sem entrada para "${slug}"`);
      assert.match(
        body,
        new RegExp(
          `<loc>https://arquivo\\.diar\\.ia\\.br/temas/${slug}</loc>\\s*<lastmod>${lastmod}</lastmod>`,
        ),
        `hub "${slug}" sem <lastmod>${lastmod}</lastmod> logo após seu <loc>`,
      );
    }
  });

  it("GET /sitemap.xml — a raiz traz <lastmod> = a data mais recente entre os hubs (#4909)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("/sitemap.xml não deveria depender do sitemap remoto");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/sitemap.xml"));
    const body = await res.text();
    const expectedRootLastmod = Object.values(HUB_LASTMOD).reduce((max, d) => (d > max ? d : max));
    assert.match(
      body,
      new RegExp(`<loc>https://arquivo\\.diar\\.ia\\.br/</loc>\\s*<lastmod>${expectedRootLastmod}</lastmod>`),
    );
  });

  describe("fallback de KV da raiz quando o upstream falha (#5134 item 3)", () => {
    it("fetch OK → grava o HTML no KV (cache:arquivo-root:html-v1)", async () => {
      const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://diar.ia.br/p/edicao-cache</loc><lastmod>2026-08-01</lastmod></url>
</urlset>`;
      globalThis.fetch = (async () => new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;
      const kv = makeFakeKv();
      const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"), { CURSOS_SUBSCRIBERS: kv });
      assert.equal(res.status, 200);
      const raw = kv._map.get("cache:arquivo-root:html-v1");
      assert.ok(raw, "esperava o KV populado após um fetch bem-sucedido");
      const parsed = JSON.parse(raw!);
      assert.match(parsed.html, /edicao-cache/);
      assert.ok(parsed.generatedAt, "esperava generatedAt no cache");
    });

    it("HTTP não-200 do sitemap + KV com fallback bom → 200 com o HTML cacheado, NUNCA 502", async () => {
      const kv = makeFakeKv();
      await kv.put(
        "cache:arquivo-root:html-v1",
        JSON.stringify({ html: "<html><body>fallback bom</body></html>", generatedAt: "2026-08-10T00:00:00.000Z" }),
      );
      globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

      const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"), { CURSOS_SUBSCRIBERS: kv });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /fallback bom/);
      // Cache-Control mais curto que o normal (5min, não 1h) — ver
      // ROOT_FALLBACK_CACHE_CONTROL: não quer travar a edge da Cloudflare
      // servindo uma cópia degradada por 1h depois do upstream já ter
      // voltado.
      assert.equal(res.headers.get("Cache-Control"), "public, max-age=300");
    });

    it("erro de rede + KV com fallback bom → 200 com o HTML cacheado, NUNCA 502", async () => {
      const kv = makeFakeKv();
      await kv.put(
        "cache:arquivo-root:html-v1",
        JSON.stringify({ html: "<html><body>fallback de rede</body></html>", generatedAt: "2026-08-10T00:00:00.000Z" }),
      );
      globalThis.fetch = (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;

      const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"), { CURSOS_SUBSCRIBERS: kv });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /fallback de rede/);
    });

    it("sitemap malformado + KV com fallback bom → 200 com o HTML cacheado, NUNCA 502", async () => {
      const kv = makeFakeKv();
      await kv.put(
        "cache:arquivo-root:html-v1",
        JSON.stringify({ html: "<html><body>fallback de parse</body></html>", generatedAt: "2026-08-10T00:00:00.000Z" }),
      );
      globalThis.fetch = (async () => new Response("<not-xml>>", { status: 200 })) as unknown as typeof fetch;

      const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"), { CURSOS_SUBSCRIBERS: kv });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /fallback de parse/);
    });

    it("upstream falha E KV sem cache nenhum (1º request de todos) → 502 de sempre (comportamento pré-#5134)", async () => {
      const kv = makeFakeKv();
      globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

      const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"), { CURSOS_SUBSCRIBERS: kv });
      assert.equal(res.status, 502);
    });

    it("upstream falha SEM binding CURSOS_SUBSCRIBERS (env vazio) → 502, nunca lança (fail-soft)", async () => {
      globalThis.fetch = (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;

      const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"), {});
      assert.equal(res.status, 502);
    });

    it("falha na ESCRITA do KV (put rejeita) não derruba a resposta 200 do sucesso atual (fail-soft)", async () => {
      const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
      globalThis.fetch = (async () => new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;
      const kv = makeFakeKv();
      kv.put = (async () => {
        throw new Error("KV put falhou");
      }) as unknown as KVNamespace["put"];

      const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"), { CURSOS_SUBSCRIBERS: kv });
      assert.equal(res.status, 200);
    });

    it("falha na LEITURA do KV (get rejeita) durante uma falha do upstream → 502 (nunca lança)", async () => {
      const kv = makeFakeKv();
      kv.get = (async () => {
        throw new Error("KV get falhou");
      }) as unknown as KVNamespace["get"];
      globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

      const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"), { CURSOS_SUBSCRIBERS: kv });
      assert.equal(res.status, 502);
    });
  });
});

/**
 * Regressão do hub órfão (#4558 Parte A).
 *
 * O primeiro hub (`/temas/anthropic-claude`) subiu ao ar em 04/ago/2026 (PRs
 * #4627/#4635/#4642, o último às 21:51 BRT — em UTC cai no dia 5, mas todo o
 * resto deste repo raciocina em BRT) alcançável SÓ pelo sitemap: nenhuma
 * página do site linkava pra ele. Como a tese da issue é ser citado por
 * assistente — e crawler chega por link, não só por sitemap —, um hub sem link
 * interno contradiz o próprio motivo de existir. Estes casos falham se a
 * navegação "Por tema" sumir da página de arquivo.
 */
describe("navegação Por tema no arquivo (#4558 Parte A)", () => {
  const ENTRIES = [
    { loc: "https://diar.ia.br/p/edicao-teste", lastmod: "2026-08-01" },
  ];

  it("renderiza um <a href> para cada hub de HUB_META", () => {
    const html = buildArchiveHtml(ENTRIES);
    for (const hub of HUB_META) {
      assert.ok(
        html.includes(`href="/temas/${hub.slug}"`),
        `arquivo não linka o hub "${hub.slug}" — ele fica alcançável só pelo sitemap`,
      );
      assert.ok(html.includes(hub.label), `rótulo "${hub.label}" ausente da navegação`);
    }
  });

  it("renderiza a navegação mesmo sem nenhuma edição no sitemap", () => {
    // Os hubs existem independentemente de haver edição listada: se o sitemap
    // remoto vier vazio, o link do hub não pode sumir junto.
    const html = buildArchiveHtml([]);
    assert.ok(html.includes('class="tema-index"'));
    assert.ok(html.includes(`href="/temas/${HUB_META[0]?.slug}"`));
  });

  // NÃO existe teste de ordem (tema antes do índice por mês). Foi escrito e
  // removido no fleet review da PR #4749: ordem entre as duas navegações é
  // preferência de layout, não comportamento. O crawler acha o `<a href>`
  // esteja ele acima ou abaixo — mesma resposta HTML, sem paginação nem
  // lazy-load — então um redesenho legítimo da página quebraria o teste sem
  // nada de errado ter acontecido. O que precisa ser garantido é que o link
  // EXISTA, e disso cuidam os casos acima.

  // `HUB_META` de produção tem 1 entrada só, então nenhum teste que importe o
  // array real exercita o separador. `buildTemaNav` é exportada exatamente pra
  // fechar essa lacuna: com 2+ hubs, um `.join` quebrado (links colados, espaço
  // faltando) falha aqui em vez de aparecer no ar quando o 2º tema entrar.
  describe("buildTemaNav com múltiplos hubs", () => {
    const DOIS = [
      { slug: "openai-chatgpt", label: "OpenAI e ChatGPT" },
      { slug: "brasil-regulacao", label: "Brasil e regulação" },
    ] as const;

    it("separa os links com ' · ' e não cola um no outro", () => {
      const nav = buildTemaNav(DOIS);
      assert.ok(
        nav.includes('<a href="/temas/openai-chatgpt">OpenAI e ChatGPT</a> · <a href="/temas/brasil-regulacao">'),
        `separador ausente ou malformado entre os links: ${nav}`,
      );
    });

    it("preserva a ordem do array (é curadoria editorial, não alfabética)", () => {
      const nav = buildTemaNav(DOIS);
      assert.ok(
        nav.indexOf("openai-chatgpt") < nav.indexOf("brasil-regulacao"),
        "a ordem de HUB_META é a ordem de exibição — ver docstring de meta.ts",
      );
    });

    it("escapa slug e rótulo", () => {
      const nav = buildTemaNav([{ slug: "a&b", label: 'Aspas " e <tag>' }]);
      assert.ok(!nav.includes("<tag>"), "rótulo não escapado vira markup");
      assert.ok(nav.includes("&amp;"), "slug não escapado");
    });

    it("lista vazia não produz <nav> órfão", () => {
      assert.equal(buildTemaNav([]), "");
    });
  });
});
