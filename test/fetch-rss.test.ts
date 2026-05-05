import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, filterByWindow, filterByTopic, fetchRss, type Article } from "../scripts/fetch-rss.ts";

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

describe("fetchRss — URL scheme validation (security)", () => {
  it("rejeita file:// scheme", async () => {
    const { fetchRss } = await import("../scripts/fetch-rss.ts");
    const result = await fetchRss({
      url: "file:///etc/passwd",
      sourceName: "attacker",
    });
    assert.equal(result.articles.length, 0);
    assert.ok(result.error?.includes("Unsupported URL scheme"));
  });

  it("rejeita data:// scheme", async () => {
    const { fetchRss } = await import("../scripts/fetch-rss.ts");
    const result = await fetchRss({
      url: "data:text/plain,rss-poison",
      sourceName: "attacker",
    });
    assert.equal(result.articles.length, 0);
    assert.ok(result.error?.includes("Unsupported URL scheme"));
  });

  it("rejeita URL malformada", async () => {
    const { fetchRss } = await import("../scripts/fetch-rss.ts");
    const result = await fetchRss({
      url: "not-a-url",
      sourceName: "attacker",
    });
    assert.equal(result.articles.length, 0);
    assert.ok(result.error?.includes("Invalid URL"));
  });

  it("aceita http:// e https://", async () => {
    // Essas URLs não resolvem (sandbox sem internet externa), mas o scheme
    // check deve passar — validação acontece ANTES do fetch.
    const { fetchRss } = await import("../scripts/fetch-rss.ts");
    const httpResult = await fetchRss({
      url: "http://example.invalid/feed",
      sourceName: "test",
      timeoutMs: 500,
    });
    // Scheme válido — fetch vai falhar com network error, mas não com "Unsupported scheme"
    assert.ok(!httpResult.error?.includes("Unsupported URL scheme"));

    const httpsResult = await fetchRss({
      url: "https://example.invalid/feed",
      sourceName: "test",
      timeoutMs: 500,
    });
    assert.ok(!httpsResult.error?.includes("Unsupported URL scheme"));
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

  it("#673: artigo sem data é mantido para filter-date-window downstream", () => {
    const onlySemData: Article[] = [
      { url: "https://a.com/4", title: "Sem data", published_at: null, summary: "" },
    ];
    const filtered = filterByWindow(onlySemData, 3, now);
    assert.equal(filtered.length, 1, "artigo sem data deve ser mantido");
  });

  it("#685: filterByWindow não emite console.error (função pura sem side effects)", () => {
    // Verificar que filterByWindow não tem log — log foi movido para fetchRss caller
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));
    try {
      const undated: Article[] = [
        { url: "https://a.com/x", title: "Sem data", published_at: null, summary: "" },
      ];
      filterByWindow(undated, 3, now);
      assert.equal(errors.length, 0, "filterByWindow não deve emitir console.error");
    } finally {
      console.error = origError;
    }
  });
});

describe("fetchRss filtered_by_topic (#678)", () => {
  it("retorna filtered_by_topic=0 quando não há topicFilter", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://x.com</link>
      <item><title>AI</title><link>https://x.com/1</link><pubDate>Mon, 25 Apr 2026 10:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => xml } as unknown as Response);
    try {
      const r = await fetchRss({ url: "https://x.com/rss", sourceName: "Test", days: 30 });
      assert.equal(r.filtered_by_topic, undefined, "sem topicFilter não deve emitir o campo");
    } finally { globalThis.fetch = origFetch; }
  });

  it("#678: retorna filtered_by_topic=N quando topicFilter elimina artigos", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>https://x.com</link>
      <item><title>Artigo sobre futebol</title><link>https://x.com/1</link><pubDate>Mon, 25 Apr 2026 10:00:00 GMT</pubDate></item>
      <item><title>Artigo sobre IA</title><link>https://x.com/2</link><pubDate>Mon, 25 Apr 2026 10:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => xml } as unknown as Response);
    try {
      const r = await fetchRss({ url: "https://x.com/rss", sourceName: "Test", days: 30, topicFilter: ["IA", "AI"] });
      assert.equal(r.articles.length, 1, "só o artigo de IA deve passar");
      assert.equal(r.filtered_by_topic, 1, "1 artigo filtrado pelo topicFilter");
    } finally { globalThis.fetch = origFetch; }
  });
});

describe("filterByTopic (#347)", () => {
  const makeArticle = (title: string, summary = ""): Article => ({
    url: `https://example.com/${title.replace(/\s+/g, "-").toLowerCase()}`,
    title,
    published_at: "2026-04-24T10:00:00.000Z",
    summary,
  });

  it("sem termos: retorna todos os artigos sem filtro", () => {
    const articles = [makeArticle("LLM Benchmark"), makeArticle("Weather Forecast")];
    assert.deepEqual(filterByTopic(articles, []), articles);
    assert.deepEqual(filterByTopic(articles, undefined as unknown as string[]), articles);
  });

  it("filtra artigos que não contêm nenhum dos termos", () => {
    const articles = [
      makeArticle("New LLM Released", "A large language model was released."),
      makeArticle("Weather Forecast", "Sunny skies expected."),
      makeArticle("GPT-5 Announced", "OpenAI reveals GPT-5."),
    ];
    const filtered = filterByTopic(articles, ["LLM", "GPT"]);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].title, "New LLM Released");
    assert.equal(filtered[1].title, "GPT-5 Announced");
  });

  it("match case-insensitive (LLM, llm, Llm)", () => {
    const articles = [
      makeArticle("Small model trained", "Using llm techniques."),
      makeArticle("Unrelated article", "Nothing relevant here."),
    ];
    const filtered = filterByTopic(articles, ["LLM"]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, "Small model trained");
  });

  it("match no summary quando title não contém o termo", () => {
    const articles = [
      makeArticle("Research Paper", "Explores transformer architecture alignment."),
      makeArticle("Sports News", "Football match results."),
    ];
    const filtered = filterByTopic(articles, ["alignment"]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, "Research Paper");
  });

  it("ao menos 1 termo suficiente para manter o artigo (OR semântico)", () => {
    const articles = [
      makeArticle("Neural network training", ""),
      makeArticle("Reinforcement learning", ""),
      makeArticle("Cat video compilation", ""),
    ];
    const filtered = filterByTopic(articles, ["neural network", "reinforcement"]);
    assert.equal(filtered.length, 2);
  });

  it("retorna vazio quando nenhum artigo bate", () => {
    const articles = [makeArticle("Cooking recipes"), makeArticle("Gardening tips")];
    const filtered = filterByTopic(articles, ["artificial intelligence", "LLM"]);
    assert.equal(filtered.length, 0);
  });

  it("termos parciais também batem (substring match)", () => {
    // "large language" deve bater em "large language model"
    const articles = [makeArticle("Large language model capabilities")];
    const filtered = filterByTopic(articles, ["large language"]);
    assert.equal(filtered.length, 1);
  });
});
