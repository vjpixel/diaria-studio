import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  needsEnrichment,
  extractMetadata,
  mergeMetadata,
  enrichArticles,
} from "../scripts/enrich-inbox-articles.ts";

describe("needsEnrichment — predicate for inbox unenriched articles (#109)", () => {
  it("identifica artigo com flag editor_submitted e título placeholder '(inbox)'", () => {
    assert.equal(
      needsEnrichment({
        url: "https://x",
        title: "(inbox)",
        flag: "editor_submitted",
      }),
      true,
    );
  });

  it("identifica '[INBOX] BBC — article xyz' como placeholder", () => {
    assert.equal(
      needsEnrichment({
        url: "https://x",
        title: "[INBOX] BBC — article c4gx1n0dl9no",
        source: "inbox",
      }),
      true,
    );
  });

  it("artigo inbox sem summary precisa enrich mesmo com título real", () => {
    assert.equal(
      needsEnrichment({
        url: "https://x",
        title: "Artigo real curado pelo editor",
        summary: null,
        flag: "editor_submitted",
      }),
      true,
    );
  });

  it("artigo inbox com título e summary preenchidos NÃO precisa enrich", () => {
    assert.equal(
      needsEnrichment({
        url: "https://x",
        title: "Título real",
        summary: "Resumo real",
        flag: "editor_submitted",
      }),
      false,
    );
  });

  it("artigo NÃO inbox (sem flag/source) nunca precisa enrich, mesmo placeholder", () => {
    assert.equal(
      needsEnrichment({
        url: "https://x",
        title: "(inbox)",
      }),
      false,
    );
  });

  it("título totalmente vazio em artigo inbox precisa enrich", () => {
    assert.equal(
      needsEnrichment({
        url: "https://x",
        title: "",
        source: "inbox",
      }),
      true,
    );
  });
});

describe("extractMetadata — pulls og:title / og:description / fallbacks", () => {
  it("prefere og:title sobre <title>", () => {
    const html = `
      <html><head>
        <title>Tag title</title>
        <meta property="og:title" content="OG title"/>
      </head></html>
    `;
    assert.equal(extractMetadata(html).title, "OG title");
  });

  it("usa twitter:title quando og:title ausente", () => {
    const html = `
      <html><head>
        <meta name="twitter:title" content="Twitter title"/>
        <title>Tag title</title>
      </head></html>
    `;
    assert.equal(extractMetadata(html).title, "Twitter title");
  });

  it("cai pra <title> quando ambos OG e twitter ausentes", () => {
    const html = `<html><head><title>Just title</title></head></html>`;
    assert.equal(extractMetadata(html).title, "Just title");
  });

  it("prefere og:description sobre meta description", () => {
    const html = `
      <html><head>
        <meta property="og:description" content="OG desc"/>
        <meta name="description" content="Plain desc"/>
      </head></html>
    `;
    assert.equal(extractMetadata(html).summary, "OG desc");
  });

  it("decodifica entidades HTML básicas + numéricas em title e description", () => {
    // Suporta: &amp; &lt; &gt; &quot; &#39; &nbsp; e numéricas decimal/hex.
    // Entidades nomeadas raras (&eacute; etc) ficam como-são — não há crash
    // e o conteúdo continua útil pro writer.
    const html = `
      <html><head>
        <meta property="og:title" content="Brand &amp; co&#39;s"/>
        <meta property="og:description" content="A &quot;test&quot; case &#x2014; with em-dash"/>
      </head></html>
    `;
    const meta = extractMetadata(html);
    assert.equal(meta.title, "Brand & co's");
    assert.equal(meta.summary, 'A "test" case — with em-dash');
  });

  it("retorna null quando nenhuma metadata existe", () => {
    const html = `<html><head></head><body><p>conteúdo</p></body></html>`;
    const meta = extractMetadata(html);
    assert.equal(meta.title, null);
    assert.equal(meta.summary, null);
  });

  it("colapsa whitespace em <title> com newlines", () => {
    const html = `<html><head><title>
      Multi
      Line
      Title
    </title></head></html>`;
    assert.equal(extractMetadata(html).title, "Multi Line Title");
  });

  it("aceita atributos em ordem invertida (content antes de property)", () => {
    const html = `<meta content="reversed" property="og:title"/>`;
    assert.equal(extractMetadata(html).title, "reversed");
  });

  it("descarta título vazio (espaços apenas)", () => {
    const html = `<title>   </title><meta property="og:title" content=""/>`;
    assert.equal(extractMetadata(html).title, null);
  });
});

describe("mergeMetadata — merges without clobbering real titles", () => {
  it("substitui título placeholder por og:title", () => {
    const out = mergeMetadata(
      { url: "https://x", title: "(inbox)", flag: "editor_submitted" },
      { title: "Real title", summary: "Real summary" },
    );
    assert.equal(out.article.title, "Real title");
    assert.equal(out.article.summary, "Real summary");
    assert.equal(out.titleUpdated, true);
    assert.equal(out.summaryUpdated, true);
  });

  it("preserva título real do editor mesmo se metadata extraída diferir", () => {
    const out = mergeMetadata(
      { url: "https://x", title: "Editor's curated title", source: "inbox" },
      { title: "Different OG title", summary: "Some summary" },
    );
    assert.equal(out.article.title, "Editor's curated title");
    assert.equal(out.titleUpdated, false);
  });

  it("preenche summary quando ausente sem mexer no título", () => {
    const out = mergeMetadata(
      { url: "https://x", title: "Real title", source: "inbox" },
      { title: "OG title", summary: "OG description" },
    );
    assert.equal(out.article.title, "Real title");
    assert.equal(out.article.summary, "OG description");
    assert.equal(out.titleUpdated, false);
    assert.equal(out.summaryUpdated, true);
  });

  it("não preenche summary quando já existe", () => {
    const out = mergeMetadata(
      { url: "https://x", title: "Real", summary: "Existing" },
      { title: "OG", summary: "OG desc" },
    );
    assert.equal(out.article.summary, "Existing");
    assert.equal(out.summaryUpdated, false);
  });

  it("não-update quando metadata extraída é null em ambos os campos", () => {
    const out = mergeMetadata(
      { url: "https://x", title: "(inbox)" },
      { title: null, summary: null },
    );
    assert.equal(out.titleUpdated, false);
    assert.equal(out.summaryUpdated, false);
  });
});

describe("enrichArticles — orchestration with mocked fetcher", () => {
  it("processa só itens que precisam enrich, deixa outros intactos", async () => {
    const articles = [
      { url: "https://a.com/inbox", title: "(inbox)", flag: "editor_submitted" },
      { url: "https://b.com/normal", title: "Real BBC story" }, // não precisa
      { url: "https://c.com/curated", title: "Editor curated", source: "inbox" }, // não precisa (sem placeholder + tem título)... wait, sem summary
    ];
    const fetcher = async (url: string): Promise<string | null> => {
      if (url === "https://a.com/inbox") {
        return `<meta property="og:title" content="A's real title"/><meta property="og:description" content="A's summary"/>`;
      }
      if (url === "https://c.com/curated") {
        return `<meta property="og:description" content="C's summary"/>`;
      }
      return null;
    };

    const { articles: out, outcomes } = await enrichArticles(articles, fetcher);

    // a.com: title placeholder substituído + summary preenchido
    assert.equal(out[0].title, "A's real title");
    assert.equal(out[0].summary, "A's summary");
    // b.com: não foi tocado (não é inbox)
    assert.equal(out[1].title, "Real BBC story");
    // c.com: title preservado, summary preenchido
    assert.equal(out[2].title, "Editor curated");
    assert.equal(out[2].summary, "C's summary");

    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every((o) => o.enriched));
  });

  it("registra fetch_failed quando fetcher retorna null", async () => {
    const articles = [
      { url: "https://x", title: "(inbox)", flag: "editor_submitted" },
    ];
    const fetcher = async (): Promise<string | null> => null;
    const { outcomes } = await enrichArticles(articles, fetcher);
    assert.equal(outcomes[0].enriched, false);
    assert.equal(outcomes[0].reason, "fetch_failed");
  });

  it("registra no_metadata_found quando HTML não tem nem title nem desc", async () => {
    const articles = [
      { url: "https://x", title: "(inbox)", flag: "editor_submitted" },
    ];
    const fetcher = async (): Promise<string | null> =>
      "<html><head></head><body>no metadata</body></html>";
    const { outcomes } = await enrichArticles(articles, fetcher);
    assert.equal(outcomes[0].enriched, false);
    assert.equal(outcomes[0].reason, "no_metadata_found");
  });

  it("respeita limite de concorrência (não trava com 1)", async () => {
    const articles = Array.from({ length: 5 }, (_, i) => ({
      url: `https://x.com/${i}`,
      title: "(inbox)",
      flag: "editor_submitted",
    }));
    const fetcher = async (url: string): Promise<string | null> =>
      `<title>${url}</title>`;
    const { outcomes } = await enrichArticles(articles, fetcher, { concurrency: 1 });
    assert.equal(outcomes.length, 5);
    assert.ok(outcomes.every((o) => o.enriched));
  });
});
