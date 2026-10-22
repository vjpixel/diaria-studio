/**
 * #10796: caso real da edição 261022 — "D2 Voxtral 3" (mistral.ai) chegou com
 * title='Document moved' e SEM summary. A URL sem barra final
 * (`/news/voxtral-3`) responde 301 para `/news/voxtral-3/`; o stub do 301 era
 * parseado no lugar da página. O #10843 passou a seguir redirects; este teste
 * trava o cenário exato da issue de ponta a ponta (título E summary vindos do
 * og: da página final) e o caminho em que o enrichment falha: o título de stub
 * nunca chega ao pool — `categorize` descarta o artigo.
 * Servidor HTTP local, sem rede real.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchHtml, enrichArticles } from "../scripts/enrich-inbox-articles.ts";
import {
  categorizeArticles,
  hasUnresolvedRedirectStubTitle,
} from "../scripts/categorize.ts";

const STUB_DOC_MOVED =
  '<html><head><title>Document moved</title></head><body>Object moved to <a href="/news/voxtral-3/">here</a></body></html>';
const VOXTRAL_PAGE =
  '<html><head><title>Voxtral 3 | Mistral AI</title>' +
  '<meta property="og:title" content="Voxtral 3">' +
  '<meta property="og:description" content="A Mistral lançou o Voxtral 3, modelo de voz com transcrição em tempo real.">' +
  "</head><body>ok</body></html>";

let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/news/voxtral-3") {
      // Location relativa com barra final — o formato que o servidor real devolve.
      res.writeHead(301, { location: "/news/voxtral-3/", "content-type": "text/html" });
      res.end(STUB_DOC_MOVED);
    } else if (req.url === "/news/voxtral-3/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(VOXTRAL_PAGE);
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("#10796 — redirect sem barra final (Voxtral 3, 261022)", () => {
  it("artigo com title='Document moved' e sem summary ganha título E summary do og: da página final", async () => {
    const { articles, outcomes } = await enrichArticles(
      [{ url: `${base}/news/voxtral-3`, title: "Document moved", flag: "newsletter_extracted" }],
      (url) => fetchHtml(url, 5000, "test"),
    );
    assert.equal(articles[0].title, "Voxtral 3");
    assert.equal(
      articles[0].summary,
      "A Mistral lançou o Voxtral 3, modelo de voz com transcrição em tempo real.",
    );
    assert.equal(outcomes[0].title_updated, true);
    assert.equal(outcomes[0].summary_updated, true);
  });

  it("enrichment falhou: o título de stub fica no artigo, mas categorize o descarta", async () => {
    const { articles, outcomes } = await enrichArticles(
      [{ url: "https://mistral.ai/news/voxtral-3", title: "Document moved", flag: "newsletter_extracted" }],
      async () => null,
    );
    assert.equal(outcomes[0].reason, "fetch_failed");
    assert.equal(articles[0].title, "Document moved");

    const buckets = categorizeArticles([
      {
        url: articles[0].url,
        title: articles[0].title ?? "",
        flag: articles[0].flag,
        summary: "Resumo longo o bastante para não ser o drop do #722 de inbox.",
      },
      { url: "https://mistral.ai/news/voxtral-2/", title: "Mistral lança o Voxtral 2", summary: "IA de voz." },
    ]);
    const kept = Object.values(buckets).flat().map((a) => a.url);
    assert.ok(!kept.includes("https://mistral.ai/news/voxtral-3"), "stub não pode chegar ao pool");
    assert.ok(kept.includes("https://mistral.ai/news/voxtral-2/"), "artigo normal segue");
  });

  it("hasUnresolvedRedirectStubTitle: só o título inteiro de stub, qualquer flag", () => {
    for (const title of ["Document moved", "301 Moved Permanently", "Redirecting..."]) {
      assert.equal(hasUnresolvedRedirectStubTitle({ url: "https://a.com/x", title }), true, title);
      assert.equal(
        hasUnresolvedRedirectStubTitle({ url: "https://a.com/x", title, flag: "editor_submitted" }),
        true,
        title,
      );
    }
    for (const title of ["Voxtral 3", "Redirecting the AI race to Europe", "", "(inbox)"]) {
      assert.equal(hasUnresolvedRedirectStubTitle({ url: "https://a.com/x", title }), false, title);
    }
  });
});
