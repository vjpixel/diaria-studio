import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, filterByWindow, type Article } from "../scripts/fetch-rss.ts";

describe("parseFeed — RSS 2.0", () => {
  const rssSample = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Canaltech</title>
    <link>https://canaltech.com.br/</link>
    <item>
      <title>OpenAI lança novo modelo</title>
      <link>https://canaltech.com.br/ia/openai-gpt.html</link>
      <description>Resumo do lançamento com &lt;b&gt;HTML&lt;/b&gt; embutido.</description>
      <pubDate>Thu, 24 Apr 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Google anuncia Gemini 3</title>
      <link>https://canaltech.com.br/ia/gemini-3.html</link>
      <pubDate>Wed, 23 Apr 2026 14:30:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

  it("extrai items com title, url, data e summary limpo", () => {
    const { articles, kind } = parseFeed(rssSample);
    assert.equal(kind, "rss");
    assert.equal(articles.length, 2);
    assert.equal(articles[0].title, "OpenAI lança novo modelo");
    assert.equal(articles[0].url, "https://canaltech.com.br/ia/openai-gpt.html");
    assert.equal(articles[0].published_at, "2026-04-24T10:00:00.000Z");
    assert.equal(articles[0].summary, "Resumo do lançamento com HTML embutido.");
  });

  it("aceita item único (não array)", () => {
    const single = `<?xml version="1.0"?><rss><channel><item><title>Solo</title><link>https://a.com/x</link></item></channel></rss>`;
    const { articles } = parseFeed(single);
    assert.equal(articles.length, 1);
    assert.equal(articles[0].title, "Solo");
  });

  it("descarta items sem title ou URL válida", () => {
    const broken = `<?xml version="1.0"?>
<rss><channel>
  <item><title>Sem link</title></item>
  <item><link>https://a.com/x</link></item>
  <item><title>OK</title><link>https://a.com/ok</link></item>
  <item><title>Relativa</title><link>/relativa</link></item>
</channel></rss>`;
    const { articles } = parseFeed(broken);
    assert.equal(articles.length, 1);
    assert.equal(articles[0].title, "OK");
  });

  it("usa guid como fallback quando link ausente", () => {
    const withGuid = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>Com GUID</title>
    <guid>https://a.com/via-guid</guid>
    <pubDate>Thu, 24 Apr 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;
    const { articles } = parseFeed(withGuid);
    assert.equal(articles.length, 1);
    assert.equal(articles[0].url, "https://a.com/via-guid");
  });

  it("trunca summary em 500 caracteres", () => {
    const long = "x".repeat(800);
    const xml = `<?xml version="1.0"?><rss><channel><item><title>T</title><link>https://a.com/x</link><description>${long}</description></item></channel></rss>`;
    const { articles } = parseFeed(xml);
    assert.equal(articles[0].summary.length, 500);
  });
});

describe("parseFeed — Atom", () => {
  const atomSample = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>AWS ML Blog</title>
  <entry>
    <title>New endpoint for Bedrock</title>
    <link href="https://aws.amazon.com/blogs/ml/bedrock.html" rel="alternate"/>
    <published>2026-04-24T10:00:00Z</published>
    <summary>Short summary</summary>
  </entry>
  <entry>
    <title>Fallback para updated</title>
    <link href="https://aws.amazon.com/blogs/ml/update.html"/>
    <updated>2026-04-23T09:00:00Z</updated>
  </entry>
</feed>`;

  it("extrai entries com published como fallback pra updated", () => {
    const { articles, kind } = parseFeed(atomSample);
    assert.equal(kind, "atom");
    assert.equal(articles.length, 2);
    assert.equal(articles[0].title, "New endpoint for Bedrock");
    assert.equal(articles[0].url, "https://aws.amazon.com/blogs/ml/bedrock.html");
    assert.equal(articles[0].published_at, "2026-04-24T10:00:00.000Z");
    assert.equal(articles[1].published_at, "2026-04-23T09:00:00.000Z");
  });

  it("escolhe link rel=alternate entre múltiplos", () => {
    const multiLink = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>T</title>
    <link href="https://a.com/feed" rel="self"/>
    <link href="https://a.com/alt" rel="alternate"/>
    <published>2026-04-24T10:00:00Z</published>
  </entry>
</feed>`;
    const { articles } = parseFeed(multiLink);
    assert.equal(articles[0].url, "https://a.com/alt");
  });
});

describe("parseFeed — erros", () => {
  it("lança erro em XML não reconhecido", () => {
    const garbage = `<?xml version="1.0"?><unknown><thing/></unknown>`;
    assert.throws(() => parseFeed(garbage), /não reconhecido/);
  });
});

describe("filterByWindow", () => {
  const now = new Date("2026-04-24T12:00:00Z");

  const articles: Article[] = [
    { url: "https://a.com/1", title: "Hoje", published_at: "2026-04-24T10:00:00Z", summary: "" },
    { url: "https://a.com/2", title: "Ontem", published_at: "2026-04-23T10:00:00Z", summary: "" },
    { url: "https://a.com/3", title: "Semana passada", published_at: "2026-04-15T10:00:00Z", summary: "" },
    { url: "https://a.com/4", title: "Sem data", published_at: null, summary: "" },
  ];

  it("mantém artigos na janela de 3 dias + os sem data", () => {
    const filtered = filterByWindow(articles, 3, now);
    assert.equal(filtered.length, 3);
    assert.deepEqual(
      filtered.map((a) => a.title).sort(),
      ["Hoje", "Ontem", "Sem data"],
    );
  });

  it("janela larga inclui todos", () => {
    const filtered = filterByWindow(articles, 30, now);
    assert.equal(filtered.length, 4);
  });

  it("janela zero mantém apenas artigos sem data (cutoff = now)", () => {
    const filtered = filterByWindow(articles, 0, now);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, "Sem data");
  });
});
