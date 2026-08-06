/**
 * test/extract-date.test.ts (#1554 P2)
 *
 * Tests for the shared date extraction lib. The logic was originally in
 * verify-dates.ts and now lives in scripts/lib/extract-date.ts so it can
 * be reused by verify-accessibility.ts (eliminating refetch in step 1p1).
 *
 * Coverage of all 7 strategies + normalizeDate edge cases.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractDateFromBody, normalizeDate } from "../scripts/lib/extract-date.ts";

describe("normalizeDate", () => {
  it("normalizes ISO 8601 to YYYY-MM-DD in BR timezone", () => {
    assert.equal(normalizeDate("2026-05-27T15:00:00Z"), "2026-05-27");
  });

  it("handles late-night UTC publishing as previous day in BR", () => {
    // 02:00 UTC = 23:00 BRT do dia anterior
    assert.equal(normalizeDate("2026-05-28T02:00:00Z"), "2026-05-27");
  });

  it("returns null for invalid input", () => {
    assert.equal(normalizeDate("not a date"), null);
    assert.equal(normalizeDate(""), null);
  });

  it("handles date-only format", () => {
    assert.equal(normalizeDate("2026-05-27"), "2026-05-26"); // midnight UTC → previous day in BRT
  });
});

describe("extractDateFromBody — strategy 1: JSON-LD", () => {
  it("extracts datePublished from JSON-LD script", () => {
    const body = `<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-05-27T10:00:00Z"}</script>`;
    const result = extractDateFromBody(body);
    assert.equal(result.date, "2026-05-27");
    assert.equal(result.note, "json-ld:datePublished");
  });

  it("handles JSON-LD @graph structure", () => {
    const body = `<script type="application/ld+json">{"@graph":[{"@type":"Article","datePublished":"2026-05-26T12:00:00Z"}]}</script>`;
    const result = extractDateFromBody(body);
    assert.equal(result.date, "2026-05-26");
  });

  it("skips malformed JSON-LD without throwing", () => {
    const body = `<script type="application/ld+json">{ not valid json </script><meta property="article:published_time" content="2026-05-25T10:00:00Z">`;
    const result = extractDateFromBody(body);
    assert.equal(result.date, "2026-05-25");
    assert.equal(result.note, "og:article:published_time");
  });
});

describe("extractDateFromBody — strategy 2-7: fallbacks", () => {
  it("strategy 2: og:article:published_time", () => {
    const body = `<meta property="article:published_time" content="2026-05-20T15:00:00Z">`;
    assert.equal(extractDateFromBody(body).note, "og:article:published_time");
  });

  it("strategy 3: meta pubdate", () => {
    const body = `<meta name="pubdate" content="2026-05-20T15:00:00Z">`;
    assert.equal(extractDateFromBody(body).note, "meta:pubdate");
  });

  it("strategy 4: citation_date (YYYY/MM/DD format)", () => {
    const body = `<meta name="citation_date" content="2026/05/20">`;
    const result = extractDateFromBody(body);
    assert.ok(result.date);
    assert.equal(result.note, "meta:citation_date");
  });

  it("strategy 5: time itemprop=datePublished", () => {
    const body = `<time itemprop="datePublished" datetime="2026-05-20T15:00:00Z">May 20</time>`;
    assert.equal(extractDateFromBody(body).note, "time[itemprop=datePublished]");
  });

  it("strategy 6a: explicit datePublished in JSON", () => {
    const body = `<script>var data = {"dateModified":"2026-05-22","datePublished":"2026-05-20T10:00:00Z"};</script>`;
    const result = extractDateFromBody(body);
    assert.equal(result.note, "json:datePublished-explicit");
  });

  it("strategy 7: first time datetime as fallback", () => {
    const body = `<time datetime="2026-05-20T15:00:00Z">May 20</time>`;
    assert.equal(extractDateFromBody(body).note, "time:first");
  });

  it("returns no-date-found when nothing matches", () => {
    const body = `<html><body>No dates here</body></html>`;
    const result = extractDateFromBody(body);
    assert.equal(result.date, null);
    assert.equal(result.note, "no-date-found");
  });
});

describe("#4691: <time> aninhado em card de 'artigos relacionados' não deve virar a data do artigo", () => {
  it("CASO REAL 260806 (openai.com/index/third-party-cyber-evaluations-involving-openai-models): único <time> do doc é de um card 'related' -> no-date-found, não a data velha do card", () => {
    // Reprodução mínima da estrutura real: um card de "artigo relacionado"
    // inteiro envolto por <a href="...outra-url...">, contendo <time> com
    // uma data ~2 semanas mais velha que o artigo real (que não tem NENHUM
    // <time> próprio no HTML servido ao crawler, confirmado via curl 260805).
    const body = `
      <html><body>
        <main>
          <h1>Third-party cyber evaluations involving OpenAI models</h1>
          <p>OpenAI worked with third-party evaluators...</p>
          <div class="related-articles">
            <a href="/index/hugging-face-model-evaluation-security-incident/">
              <div class="text-h5">OpenAI and Hugging Face address security incident</div>
              <p><span>Security</span><span><time class="text-nowrap text-primary-60" dateTime="2026-07-21T00:00:00-07:00">Jul 21, 2026</time></span></p>
            </a>
          </div>
        </main>
      </body></html>
    `;
    const result = extractDateFromBody(body);
    assert.equal(result.date, null);
    assert.equal(result.note, "no-date-found");
  });

  it("<time> da própria dateline (fora de <a>) continua extraído normalmente — sem regressão", () => {
    const body = `
      <article>
        <h1>Some real launch</h1>
        <p class="byline">Published <time datetime="2026-05-20T15:00:00Z">May 20</time></p>
      </article>
    `;
    const result = extractDateFromBody(body);
    assert.equal(result.date, "2026-05-20");
    assert.equal(result.note, "time:in-article-context");
  });

  it("primeiro <time> está num card relacionado, mas um segundo <time> fora de <a> é a dateline real -> extrai o segundo", () => {
    const body = `
      <main>
        <div class="related">
          <a href="/index/other-article/">
            <time datetime="2026-07-21T00:00:00-07:00">Jul 21, 2026</time>
          </a>
        </div>
        <article>
          <h1>Real article</h1>
          <time datetime="2026-08-05T12:00:00Z">Aug 5, 2026</time>
        </article>
      </main>
    `;
    const result = extractDateFromBody(body);
    assert.equal(result.date, "2026-08-05");
  });

  it("finding 1: <TIME> maiúsculo dentro de card de link ainda é reconhecido como aninhado (case-insensitive)", () => {
    // Antes do fix, `lastIndexOf("<time")` era case-sensitive enquanto a regex
    // que produz o match é `/i` — um `<TIME>` maiúsculo fazia lastIndexOf
    // retornar -1, o guard nunca aplicava, e a data velha do card vazava.
    const body = `
      <main>
        <div class="related-articles">
          <a href="/index/other-article/">
            <div class="text-h5">Related</div>
            <p><TIME class="text-nowrap" DATETIME="2026-07-21T00:00:00-07:00">Jul 21, 2026</TIME></p>
          </a>
        </div>
      </main>
    `;
    const result = extractDateFromBody(body);
    assert.equal(result.date, null);
    assert.equal(result.note, "no-date-found");
  });

  it("finding 3: <a\\nhref=...> com newline em vez de espaço ainda ativa o guard de anchor-card", () => {
    // `lastIndexOf("<a ")` exigia um espaço literal após `<a` — minificadores
    // e frameworks que quebram linha antes dos atributos (`<a\nhref=...>`)
    // escapavam do guard, mesma classe de falha silenciosa do finding 1.
    const body = `
      <main>
        <div class="related-articles">
          <a
            href="/index/other-article/">
            <time datetime="2026-07-21T00:00:00-07:00">Jul 21, 2026</time>
          </a>
        </div>
      </main>
    `;
    const result = extractDateFromBody(body);
    assert.equal(result.date, null);
    assert.equal(result.note, "no-date-found");
  });

  it("finding 2 (limitação conhecida, NÃO um bug): wrapper de card maior que a janela de 1500 chars escapa do guard e a data do card é aceita", () => {
    // A janela de 1500 chars olhando pra trás é uma heurística barata, calibrada
    // pro único caso confirmado até aqui (#4691). Se o `<a href=...>` do card
    // abre mais de 1500 chars antes do `<time>`, o guard não enxerga a abertura
    // e trata como "não está em card" — a data do card (potencialmente errada)
    // é aceita. Este teste documenta esse limite deliberadamente, para que
    // ele seja visível e não uma surpresa quando reaparecer; não é um convite
    // para ajustar o valor da janela sem dados que justifiquem outro número.
    const padding = "x".repeat(1600);
    const body = `
      <main>
        <div class="related-articles">
          <a href="/index/other-article/">
            <p>${padding}</p>
            <time datetime="2026-07-21T00:00:00-07:00">Jul 21, 2026</time>
          </a>
        </div>
      </main>
    `;
    const result = extractDateFromBody(body);
    // Comportamento conhecido: guard não aplica, data do card "vaza".
    assert.equal(result.date, "2026-07-21");
  });
});
