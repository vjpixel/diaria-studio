import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  needsEnrichment,
  extractMetadata,
  mergeMetadata,
  enrichArticles,
  titleFromSubmittedSubject,
  NON_INBOX_FALLBACK_FETCH_CAP,
} from "../scripts/enrich-inbox-articles.ts";
import { bodyCacheFilename } from "../scripts/lib/url-body-cache.ts";

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

  it("#1696: artigo NÃO inbox com título REAL mas summary vazio precisa enrich", () => {
    assert.equal(
      needsEnrichment({
        url: "https://blogs.nvidia.com/x",
        title: "How Cosmos 3 Helps Physical AI",
        summary: "",
      }),
      true,
    );
  });

  it("#1696: artigo NÃO inbox com summary preenchido NÃO precisa enrich", () => {
    assert.equal(
      needsEnrichment({
        url: "https://x",
        title: "Título real",
        summary: "Tem resumo",
      }),
      false,
    );
  });

  it("#1696: artigo NÃO inbox com título placeholder NÃO é enriquecido (só summary, não título)", () => {
    // non-inbox não tem título placeholder legítimo; não tocamos o título dele.
    assert.equal(needsEnrichment({ url: "https://x", title: "(inbox)" }), false);
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

  // #2881: og:description truncada pela FONTE (não por nós) não deve vazar
  // reticência pro summary do artigo.
  it("#2881: sanitiza reticência final herdada do og:description antes de gravar o summary", () => {
    const out = mergeMetadata(
      { url: "https://x", title: "Real title", source: "inbox" },
      {
        title: "OG title",
        summary:
          "com ênfase em ética, transparência, não-discriminação, segurança e soberania…",
      },
    );
    assert.equal(
      out.article.summary,
      "com ênfase em ética, transparência, não-discriminação, segurança e soberania",
    );
    assert.equal(out.summaryUpdated, true);
  });

  it("#2881: summary sem reticência final passa intacto", () => {
    const out = mergeMetadata(
      { url: "https://x", title: "Real title", source: "inbox" },
      { title: "OG title", summary: "A empresa vai investir R$ 10 milhões no projeto." },
    );
    assert.equal(out.article.summary, "A empresa vai investir R$ 10 milhões no projeto.");
  });

  // #3196 CASO REAL 260709 (USE MELHOR hashtagtreinamentos): og:description
  // continha boilerplate de navegação ("Leia mais:") concatenado a títulos de
  // posts relacionados, com uma data colada sem espaço ("IA29 de maio de 2026").
  it("#3196: sanitiza boilerplate de navegação ('Leia mais:') herdado do og:description antes de gravar o summary", () => {
    const out = mergeMetadata(
      { url: "https://x", title: "Real title", source: "inbox" },
      {
        title: "OG title",
        summary:
          "Existe uma ótima radiografia de… Leia mais: Transição de carreira em dados no Brasil... " +
          "Claude Code: Guia Completo para Programar com IA29 de maio de 2026",
      },
    );
    assert.equal(out.article.summary, "Existe uma ótima radiografia de");
    assert.ok(!out.article.summary!.includes("Leia mais"), "boilerplate de navegação removido");
    assert.ok(!out.article.summary!.includes("IA29"), "artefato de data colada não sobrevive");
    assert.equal(out.summaryUpdated, true);
  });

  it("#3196: fixa acrônimo colado numa data quando não há boilerplate de navegação antes", () => {
    const out = mergeMetadata(
      { url: "https://x", title: "Real title", source: "inbox" },
      {
        title: "OG title",
        summary: "Guia Completo para Programar com IA29 de maio de 2026",
      },
    );
    assert.equal(out.article.summary, "Guia Completo para Programar com IA 29 de maio de 2026");
  });

  it("#3196: summary que sanitiza pra string vazia (boilerplate puro) NÃO é gravado — deixa summary ausente", () => {
    const out = mergeMetadata(
      { url: "https://x", title: "Real title", source: "inbox" },
      { title: "OG title", summary: "Leia mais: outro artigo qualquer sem relação" },
    );
    assert.equal(out.article.summary, undefined);
    assert.equal(out.summaryUpdated, false);
  });

  // #3276 REGRESSÃO: og:description com reticência ANTES do lead-in de
  // navegação ("… Leia mais: ...") — sanitizeDescriptionBoilerplate corta
  // tudo a partir de "Leia mais:" e sobra só "…". Antes do fix,
  // sanitizeTrailingEllipsis devolvia esse "…" bare como se fosse um
  // summary válido, e `if (sanitized)` (truthy pra string não-vazia)
  // gravava "…" literal como summary do item — violando o invariante do
  // módulo ("nunca publicar descrição terminando em …").
  it("#3276: og:description que sobra só '…' após strip de boilerplate NÃO é gravado — deixa summary ausente", () => {
    const out = mergeMetadata(
      { url: "https://x", title: "Real title", source: "inbox" },
      { title: "OG title", summary: "… Leia mais: 10 dicas com IA" },
    );
    assert.equal(out.article.summary, undefined);
    assert.equal(out.summaryUpdated, false);
  });
});

describe("enrichArticles — orchestration with mocked fetcher", () => {
  it("processa só itens que precisam enrich, deixa outros intactos", async () => {
    const articles = [
      { url: "https://a.com/inbox", title: "(inbox)", flag: "editor_submitted" },
      { url: "https://b.com/normal", title: "Real BBC story", summary: "BBC já tem resumo" }, // não precisa (tem summary; #1696 só pega non-inbox SEM summary)
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

describe("enrichArticles — body cache integration (#717 hyp 7)", () => {
  it("cache hit: usa body cached, não chama o fetcher, marca cache_hit + incrementa stats", async () => {
    const dir = mkdtempSync(join(tmpdir(), "enrich-cache-hit-"));
    try {
      const url = "https://cached.example.com/article";
      writeFileSync(
        join(dir, bodyCacheFilename(url)),
        `<meta property="og:title" content="From cache"/><meta property="og:description" content="Cached desc"/>`,
      );
      const articles = [{ url, title: "(inbox)", flag: "editor_submitted" }];
      let fetcherCalls = 0;
      const fetcher = async (): Promise<string | null> => {
        fetcherCalls++;
        return null;
      };
      const { articles: out, outcomes, stats } = await enrichArticles(
        articles,
        fetcher,
        { bodiesDir: dir },
      );
      assert.equal(fetcherCalls, 0);
      assert.equal(out[0].title, "From cache");
      assert.equal(out[0].summary, "Cached desc");
      assert.equal(outcomes[0].enriched, true);
      assert.equal(outcomes[0].cache_hit, true);
      assert.equal(stats.cache_hits, 1);
      assert.equal(stats.cache_misses, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cache miss: cai pro fetcher e incrementa cache_misses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "enrich-cache-miss-"));
    try {
      const articles = [
        { url: "https://uncached.example.com/x", title: "(inbox)", flag: "editor_submitted" },
      ];
      const fetcher = async (): Promise<string | null> =>
        `<meta property="og:title" content="Fetched title"/>`;
      const { articles: out, outcomes, stats } = await enrichArticles(
        articles,
        fetcher,
        { bodiesDir: dir },
      );
      assert.equal(out[0].title, "Fetched title");
      assert.equal(outcomes[0].enriched, true);
      assert.equal(outcomes[0].cache_hit, undefined);
      assert.equal(stats.cache_hits, 0);
      assert.equal(stats.cache_misses, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bodiesDir omitido (cache desabilitado): comportamento legado, fetcher sempre chamado, stats zeradas", async () => {
    const articles = [
      { url: "https://x", title: "(inbox)", flag: "editor_submitted" },
    ];
    let fetcherCalls = 0;
    const fetcher = async (): Promise<string | null> => {
      fetcherCalls++;
      return `<meta property="og:title" content="From fetcher"/>`;
    };
    const { outcomes, stats } = await enrichArticles(articles, fetcher);
    assert.equal(fetcherCalls, 1);
    assert.equal(outcomes[0].enriched, true);
    assert.equal(outcomes[0].cache_hit, undefined);
    assert.equal(stats.cache_hits, 0);
    assert.equal(stats.cache_misses, 0);
  });

  it("mix de cache hit + miss em um lote: stats refletem cada caso individualmente", async () => {
    const dir = mkdtempSync(join(tmpdir(), "enrich-cache-mix-"));
    try {
      const cachedUrl = "https://c.example.com/hit";
      const missedUrl = "https://m.example.com/miss";
      writeFileSync(
        join(dir, bodyCacheFilename(cachedUrl)),
        `<meta property="og:title" content="Hit title"/>`,
      );
      const articles = [
        { url: cachedUrl, title: "(inbox)", flag: "editor_submitted" },
        { url: missedUrl, title: "(inbox)", flag: "editor_submitted" },
      ];
      const fetched: string[] = [];
      const fetcher = async (url: string): Promise<string | null> => {
        fetched.push(url);
        return `<meta property="og:title" content="Miss title"/>`;
      };
      const { outcomes, stats } = await enrichArticles(articles, fetcher, {
        bodiesDir: dir,
        concurrency: 1,
      });
      assert.deepEqual(fetched, [missedUrl]);
      assert.equal(stats.cache_hits, 1);
      assert.equal(stats.cache_misses, 1);
      const hit = outcomes.find((o) => o.url === cachedUrl)!;
      const miss = outcomes.find((o) => o.url === missedUrl)!;
      assert.equal(hit.cache_hit, true);
      assert.equal(miss.cache_hit, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cache hit com HTML sem metadata: registra no_metadata_found mas ainda marca cache_hit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "enrich-cache-empty-"));
    try {
      const url = "https://nometa.example.com/page";
      writeFileSync(
        join(dir, bodyCacheFilename(url)),
        "<html><head></head><body>nada</body></html>",
      );
      const articles = [{ url, title: "(inbox)", flag: "editor_submitted" }];
      const { outcomes, stats } = await enrichArticles(
        articles,
        async () => null,
        { bodiesDir: dir },
      );
      assert.equal(outcomes[0].enriched, false);
      assert.equal(outcomes[0].reason, "no_metadata_found");
      assert.equal(outcomes[0].cache_hit, true);
      assert.equal(stats.cache_hits, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("titleFromSubmittedSubject — fallback anti-bot (#1641)", () => {
  it("recupera título do submitted_subject quando título é placeholder", () => {
    const t = titleFromSubmittedSubject({
      url: "https://venturebeat.com/x",
      title: "(inbox)",
      flag: "editor_submitted",
      submitted_subject: "DeepSeek lança modelo V4",
    });
    assert.equal(t, "DeepSeek lança modelo V4");
  });

  it("limpa prefixos de forward/reply (Re:/Fwd:/Enc:)", () => {
    assert.equal(
      titleFromSubmittedSubject({ url: "u", title: "(inbox)", flag: "editor_submitted", submitted_subject: "Fwd: Notícia X" }),
      "Notícia X",
    );
    assert.equal(
      titleFromSubmittedSubject({ url: "u", title: "(inbox)", flag: "editor_submitted", submitted_subject: "[INBOX] Re: Tema" }),
      "Tema",
    );
  });

  it("retorna null quando o artigo já tem título bom (não clobbera)", () => {
    assert.equal(
      titleFromSubmittedSubject({ url: "u", title: "Título real do editor", summary: "tem", flag: "editor_submitted", submitted_subject: "outro" }),
      null,
    );
  });

  it("retorna null quando não há submitted_subject aproveitável", () => {
    assert.equal(titleFromSubmittedSubject({ url: "u", title: "(inbox)", flag: "editor_submitted" }), null);
    assert.equal(
      titleFromSubmittedSubject({ url: "u", title: "(inbox)", flag: "editor_submitted", submitted_subject: "   " }),
      null,
    );
  });

  it("retorna null pra artigo não-inbox (sem flag/source), mesmo com subject", () => {
    assert.equal(
      titleFromSubmittedSubject({ url: "u", title: "(inbox)", submitted_subject: "qualquer" }),
      null,
    );
  });
});

describe("enrichArticles — fallback submitted_subject quando fetch falha (#1641)", () => {
  it("fetch_failed + submitted_subject → título recuperado, não dropa", async () => {
    const articles = [
      { url: "https://anti-bot.com/x", title: "(inbox)", flag: "editor_submitted", submitted_subject: "Anúncio importante de IA" },
    ];
    const fetcher = async () => null; // simula anti-bot (fetch falha)
    const { articles: out, outcomes } = await enrichArticles(articles, fetcher);
    assert.equal(out[0].title, "Anúncio importante de IA");
    assert.equal(outcomes[0].reason, "title_from_submitted_subject");
    assert.equal(outcomes[0].title_updated, true);
    assert.equal(outcomes[0].enriched, true);
  });

  it("fetch_failed SEM submitted_subject → reason fetch_failed (comportamento antigo)", async () => {
    const articles = [{ url: "https://anti-bot.com/x", title: "(inbox)", flag: "editor_submitted" }];
    const fetcher = async () => null;
    const { outcomes } = await enrichArticles(articles, fetcher);
    assert.equal(outcomes[0].reason, "fetch_failed");
    assert.equal(outcomes[0].title_updated, false);
  });

  it("página sem metadata + submitted_subject → título recuperado", async () => {
    const articles = [
      { url: "https://x.com/y", title: "(inbox)", flag: "editor_submitted", submitted_subject: "Recuperado do assunto" },
    ];
    const fetcher = async () => "<html><body>sem og nem title</body></html>";
    const { articles: out, outcomes } = await enrichArticles(articles, fetcher);
    assert.equal(out[0].title, "Recuperado do assunto");
    assert.equal(outcomes[0].reason, "title_from_submitted_subject");
  });
});

describe("enrichArticles — #2140 strip publisher suffix gate by origin (C9)", () => {
  it("artigo de imprensa (worker, needsEnrichment=true) com ' | Publisher' → strip dentro do worker (observabilidade)", async () => {
    // Simula artigo de fonte regular (não-inbox) com título RSS contendo sufixo de
    // veículo e sem summary → entra no worker (#1696, cache-only), recebe summary do
    // cache, strip aplicado ao título existente antes de gravar `out`, garantindo que
    // `title_updated` no outcome reflita o estado final correto.
    const dir = mkdtempSync(join(tmpdir(), "enrich-2140-worker-"));
    try {
      const url = "https://g1.com/artigo-worker";
      writeFileSync(
        join(dir, bodyCacheFilename(url)),
        `<meta property="og:description" content="Resumo extraído do cache."/>`,
      );
      const articles = [
        {
          url,
          title: "Especialistas criticam regulamentação da IA no Brasil | G1",
          summary: "", // sem summary → needsEnrichment=true, entra no worker
        },
      ];
      const fetcher = async (): Promise<string | null> => null;
      const { articles: out } = await enrichArticles(articles, fetcher, { bodiesDir: dir });
      assert.equal(
        out[0].title,
        "Especialistas criticam regulamentação da IA no Brasil",
        "sufixo '| G1' deve ser removido de artigo de imprensa dentro do worker",
      );
      assert.equal(out[0].summary, "Resumo extraído do cache.", "summary preenchido do cache");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#3647: título com 2 sufixos de veículo encadeados normaliza por completo numa única chamada (worker) e não duplica outcome no passe final", async () => {
    // Bug: `stripDashSuffix` só remove UMA camada de sufixo por chamada
    // (verifica só a ÚLTIMA ocorrência do separador). `normalizeItemTitle` é
    // chamada 1x dentro do worker (linha ~459, sobre o título de entrada) E
    // de novo no passe final sobre TODO o array `out` (linha ~515, cobrindo
    // itens que o worker não tocou) — inclusive artigos já processados pelo
    // worker. Título com 2 sufixos de veículo conhecidos encadeados
    // ("... - Reuters - CNN Brasil") só ficava totalmente limpo por acidente,
    // porque a 2ª chamada (não-idempotente entre si) removia a 2ª camada —
    // e essa 2ª remoção não gerava entry de outcome (contradizendo o
    // comentário de idempotência do código-fonte, linhas ~504-506 na época).
    // Com `normalizeItemTitle` genuinamente idempotente (loop até estabilizar,
    // #3647), a 1ª chamada dentro do worker já remove as 2 camadas — o passe
    // final vira no-op de fato, e o outcome log reflete exatamente 1 evento
    // (do worker), sem strip silencioso adicional.
    const dir = mkdtempSync(join(tmpdir(), "enrich-3647-chained-suffix-"));
    try {
      const url = "https://example.com/artigo-chained-suffix";
      writeFileSync(
        join(dir, bodyCacheFilename(url)),
        `<meta property="og:description" content="Resumo extraído do cache."/>`,
      );
      const articles = [
        {
          url,
          title: "Empresa anuncia resultado importante - Reuters - CNN Brasil",
          summary: "", // sem summary → needsEnrichment=true, entra no worker
        },
      ];
      const fetcher = async (): Promise<string | null> => null;
      const { articles: out, outcomes } = await enrichArticles(articles, fetcher, {
        bodiesDir: dir,
      });
      assert.equal(
        out[0].title,
        "Empresa anuncia resultado importante",
        "as 2 camadas de sufixo de veículo (Reuters + CNN Brasil) devem ser removidas por completo",
      );
      const urlOutcomes = outcomes.filter((o) => o.url === url);
      assert.equal(
        urlOutcomes.length,
        1,
        "deve haver exatamente 1 outcome para esta URL — sem entry fantasma do passe final " +
          `(outcomes: ${JSON.stringify(urlOutcomes)})`,
      );
      assert.equal(
        urlOutcomes[0].title_updated,
        true,
        "outcome do worker deve refletir que o título foi atualizado",
      );
      assert.notEqual(
        urlOutcomes[0].reason,
        "normalize_item_title",
        "a normalização deve ter acontecido dentro do worker (idempotente), não via " +
          "strip silencioso adicional no passe final (reason: normalize_item_title)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("artigo editorial com ' | ' legítimo no submitted_subject → preservado intacto (C3/C6)", async () => {
    // Editor enviou um link com assunto contendo ' | ' — não é sufixo de veículo.
    // O fetch falha (anti-bot), então o título vem do submitted_subject.
    const articles = [
      {
        url: "https://anti-bot.com/artigo",
        title: "(inbox)",
        flag: "editor_submitted",
        submitted_subject: "Modelos open-source dominam | pesquisa nova",
      },
    ];
    const fetcher = async (): Promise<string | null> => null; // simula anti-bot
    const { articles: out } = await enrichArticles(articles, fetcher);
    assert.equal(
      out[0].title,
      "Modelos open-source dominam | pesquisa nova",
      "título editorial com ' | ' NÃO deve ser strippado (C3/C6)",
    );
  });

  it("artigo inbox curado com título real que contém ' | ' → preservado (C6)", async () => {
    // Inbox article com título curado diretamente (não placeholder).
    // O og:title da página daria summary mas o título editorial é preservado pelo mergeMetadata.
    const articles = [
      {
        url: "https://mistral.ai/blog",
        title: "Mistral 7B | Mistral AI",
        summary: "",
        source: "inbox",
      },
    ];
    const fetcher = async (): Promise<string | null> =>
      `<meta property="og:description" content="Descricão da página."/>`;
    const { articles: out } = await enrichArticles(articles, fetcher);
    assert.equal(
      out[0].title,
      "Mistral 7B | Mistral AI",
      "título curado pelo editor NÃO deve ser strippado (C6 — 'NÃO toca o título')",
    );
  });

  it("#3628: inbox placeholder title, fetch retorna og:title com sufixo de veículo → sufixo removido", async () => {
    // Bug real (edição 260717): editor submeteu link via inbox, título ficou
    // placeholder "(inbox)", o fetch buscou o og:title da própria página do
    // veículo — que já carregava o sufixo de crédito de fonte embutido
    // ("GPT-Red: Unlocking Self-Improvement for Robustness | OpenAI"). Esse
    // texto vem da PÁGINA (não do editor), então deve ser normalizado como
    // qualquer título de imprensa, mesmo sendo um artigo `source`/`flag` inbox.
    const articles = [
      { url: "https://openai.com/index/gpt-red", title: "(inbox)", flag: "editor_submitted" },
    ];
    const fetcher = async (): Promise<string | null> =>
      `<meta property="og:title" content="GPT-Red: Unlocking Self-Improvement for Robustness | OpenAI"/>`;
    const { articles: out } = await enrichArticles(articles, fetcher);
    assert.equal(
      out[0].title,
      "GPT-Red: Unlocking Self-Improvement for Robustness",
      "sufixo ' | OpenAI' deve ser removido mesmo em título de inbox recuperado via fetch",
    );
  });

  it("#3628: idem para sufixo via travessão em veículo conhecido", async () => {
    const articles = [
      { url: "https://canaltech.com.br/x", title: "(inbox)", source: "inbox" },
    ];
    const fetcher = async (): Promise<string | null> =>
      `<meta property="og:title" content="Novidade em IA generativa - Canaltech"/>`;
    const { articles: out } = await enrichArticles(articles, fetcher);
    assert.equal(
      out[0].title,
      "Novidade em IA generativa",
      "sufixo ' - Canaltech' (veículo conhecido) deve ser removido em título de inbox recuperado via fetch",
    );
  });

  it("artigo RSS não-enriquecível (needsEnrichment=false) com sufixo → strippado no pós-loop", async () => {
    // Artigo RSS com título real E summary já preenchido → needsEnrichment=false, não entra no worker.
    // O pós-loop (não-targets) deve strippar o sufixo de imprensa.
    const articles = [
      {
        url: "https://g1.com/outro",
        title: "Gigantes da IA terão IPOs bilionários | CNN Brasil",
        summary: "Resumo já preenchido pelo RSS.",
      },
    ];
    const fetcher = async (): Promise<string | null> => null; // não deve ser chamado
    const { articles: out } = await enrichArticles(articles, fetcher);
    assert.equal(
      out[0].title,
      "Gigantes da IA terão IPOs bilionários",
      "artigo RSS não-enriquecível com sufixo deve ser strippado no pós-loop",
    );
  });
});

describe("enrichArticles — #2664/#2672 normalização cobre fetch-fail / sem-metadata", () => {
  it("CASO REAL: fetch anti-bot FALHA → título cru de imprensa ainda é normalizado (sufixo + ponto)", async () => {
    // Artigo de imprensa (não-inbox), needsEnrichment=true (sem summary). Entra no
    // worker mas o fetch falha (anti-bot, comum em sites tipo Canaltech) → sai por
    // `continue` precoce ANTES da normalização interna. O título cru do RSS ainda
    // carrega o sufixo de veículo ` - Canaltech` + ponto final — a passagem final
    // (#2664/#2672 follow-up) deve limpá-lo mesmo sem enriquecer.
    const articles = [
      {
        url: "https://canaltech.com.br/artigo-anti-bot",
        title: "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo; veja como - Canaltech.",
        summary: "", // needsEnrichment=true → entra no worker
      },
    ];
    const fetcher = async (): Promise<string | null> => null; // simula anti-bot
    const { articles: out, outcomes } = await enrichArticles(articles, fetcher);
    assert.equal(
      out[0].title,
      "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo; veja como",
      "título cru de fetch-fail deve ter sufixo de veículo E ponto final removidos",
    );
    // Não deve inflar a contagem: o artigo já tem o outcome de cache-miss do worker;
    // a normalização do título não empurra um outcome duplicado para o mesmo target.
    assert.equal(outcomes.length, 1, "sem outcome de normalização duplicado para target");
  });

  it("página acessível mas SEM metadata extraível → título cru de imprensa ainda é normalizado", async () => {
    // Fetch sucede mas não há og:title nem og:description nem <title> → sai por
    // `continue` no ramo no_metadata (sem submitted_subject, pois é imprensa).
    // A passagem final deve normalizar o título cru mesmo assim.
    const articles = [
      {
        url: "https://techcrunch.com/no-meta",
        title: "Google anuncia Gemini 2.5 Pro com melhorias significativas — TechCrunch",
        summary: "",
      },
    ];
    const fetcher = async (): Promise<string | null> =>
      "<html><body>sem og nem title</body></html>";
    const { articles: out } = await enrichArticles(articles, fetcher);
    assert.equal(
      out[0].title,
      "Google anuncia Gemini 2.5 Pro com melhorias significativas",
      "sufixo de travessão deve ser removido mesmo no caminho no_metadata",
    );
  });

  it("título editorial (submitted_subject) com fetch-fail NÃO é normalizado (gate de origem)", async () => {
    // Contraprova: artigo editorial cujo fetch falha e o título vem do
    // submitted_subject — NUNCA deve ser normalizado, mesmo com ' - ' + ponto.
    const articles = [
      {
        url: "https://anti-bot.com/editorial",
        title: "(inbox)",
        flag: "editor_submitted",
        submitted_subject: "Lançamento - Acme.",
      },
    ];
    const fetcher = async (): Promise<string | null> => null;
    const { articles: out } = await enrichArticles(articles, fetcher);
    assert.equal(
      out[0].title,
      "Lançamento - Acme.",
      "título editorial recuperado de submitted_subject NÃO deve ser normalizado",
    );
  });
});

describe("enrichArticles — #1696 non-inbox summary fallback (cache-only)", () => {
  it("non-inbox sem summary + body cacheado → preenche summary, NÃO toca título, sem network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "enrich-1696-hit-"));
    try {
      const url = "https://blogs.nvidia.com/cosmos";
      writeFileSync(
        join(dir, bodyCacheFilename(url)),
        `<meta property="og:title" content="Título do site"/><meta property="og:description" content="Descrição extraída da página."/>`,
      );
      // Fonte regular (sem flag/source inbox), título real, summary vazio.
      const articles = [{ url, title: "How Cosmos 3 Helps Physical AI", summary: "" }];
      let fetcherCalls = 0;
      const fetcher = async (): Promise<string | null> => {
        fetcherCalls++;
        return null;
      };
      const { articles: out, outcomes } = await enrichArticles(articles, fetcher, { bodiesDir: dir });
      assert.equal(fetcherCalls, 0, "non-inbox não faz network");
      assert.equal(out[0].summary, "Descrição extraída da página.", "summary preenchido do cache");
      assert.equal(out[0].title, "How Cosmos 3 Helps Physical AI", "título NÃO é tocado (non-inbox)");
      assert.equal(outcomes[0].summary_updated, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2545: non-inbox sem summary + cache MISS → faz network (fallback bounded), summary preenchido", async () => {
    // #2545 inverte o comportamento de #1696 para cache-miss: agora faz 1 GET curto
    // pra preencher og:description em vez de deixar summary vazio (que causa título pelado).
    const dir = mkdtempSync(join(tmpdir(), "enrich-2545-miss-"));
    try {
      const articles = [{ url: "https://huggingface.co/blog/local-models-pr-triage", title: "We got local models to triage the OpenClaw repo for FREE!", summary: "" }];
      let fetcherCalls = 0;
      const fetcher = async (): Promise<string | null> => {
        fetcherCalls++;
        return `<meta property="og:description" content="Triagem automática de PRs com modelos locais."/>`;
      };
      const { articles: out, outcomes } = await enrichArticles(articles, fetcher, { bodiesDir: dir });
      assert.equal(fetcherCalls, 1, "#2545: non-inbox cache-miss AGORA faz 1 network GET (fallback bounded)");
      assert.equal(out[0].summary, "Triagem automática de PRs com modelos locais.", "summary preenchido");
      assert.equal(outcomes[0].summary_updated, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2545: non-inbox cache-miss com cap=0 → NÃO faz network, reason=cache_miss_cap_exhausted_non_inbox", async () => {
    // cap=0 simula cap esgotado: fica comportamento antigo (summary vazio).
    // O lint secondary-items-have-summary detecta no Stage 4.
    const dir = mkdtempSync(join(tmpdir(), "enrich-2545-cap0-"));
    try {
      const articles = [{ url: "https://blogs.nvidia.com/uncached", title: "Título real", summary: "" }];
      let fetcherCalls = 0;
      const fetcher = async (): Promise<string | null> => {
        fetcherCalls++;
        return `<meta property="og:description" content="NÃO deveria ser usado"/>`;
      };
      const { articles: out, outcomes } = await enrichArticles(articles, fetcher, { bodiesDir: dir, nonInboxFallbackFetchCap: 0 });
      assert.equal(fetcherCalls, 0, "cap=0: non-inbox NÃO faz network");
      assert.ok(!out[0].summary, "summary fica vazio quando cap=0");
      assert.equal(outcomes[0].reason, "cache_miss_cap_exhausted_non_inbox");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2545: cap de fallback respeita limite — após N fetches, próximos skippam", async () => {
    // Testa que o cap=2 limita exatamente 2 fetches para non-inbox cache-miss.
    // Usa concurrency=1 para garantir ordem sequencial e comportamento determinístico do cap.
    const dir = mkdtempSync(join(tmpdir(), "enrich-2545-capN-"));
    try {
      const articles = [
        { url: "https://a.com/art", title: "Artigo A", summary: "" },
        { url: "https://b.com/art", title: "Artigo B", summary: "" },
        { url: "https://c.com/art", title: "Artigo C", summary: "" }, // deve ser skippado (cap=2)
      ];
      let fetcherCalls = 0;
      const fetcher = async (url: string): Promise<string | null> => {
        fetcherCalls++;
        return `<meta property="og:description" content="Desc de ${url}"/>`;
      };
      const { articles: out, outcomes } = await enrichArticles(articles, fetcher, {
        bodiesDir: dir,
        nonInboxFallbackFetchCap: 2,
        concurrency: 1, // sequencial para comportamento determinístico do cap
      });
      assert.equal(fetcherCalls, 2, "exatamente 2 fetches (cap=2)");
      assert.ok(out[0].summary, "A: summary preenchido (fetch 1)");
      assert.ok(out[1].summary, "B: summary preenchido (fetch 2)");
      assert.ok(!out[2].summary, "C: summary vazio (cap esgotado)");
      assert.equal(outcomes[2].reason, "cache_miss_cap_exhausted_non_inbox");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#1696: inbox cache-miss AINDA faz network (comportamento original preservado)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "enrich-1696-inbox-"));
    try {
      const articles = [{ url: "https://x/inbox", title: "(inbox)", flag: "editor_submitted" }];
      let fetcherCalls = 0;
      const fetcher = async (): Promise<string | null> => {
        fetcherCalls++;
        return `<meta property="og:title" content="Fetched inbox"/>`;
      };
      const { articles: out } = await enrichArticles(articles, fetcher, { bodiesDir: dir });
      assert.equal(fetcherCalls, 1, "inbox cache-miss faz network (não-bound)");
      assert.equal(out[0].title, "Fetched inbox");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("NON_INBOX_FALLBACK_FETCH_CAP — constante exportada (#2545)", () => {
  it("cap padrão é um valor positivo e razoável (1–20)", () => {
    assert.ok(NON_INBOX_FALLBACK_FETCH_CAP > 0, "cap > 0");
    assert.ok(NON_INBOX_FALLBACK_FETCH_CAP <= 20, "cap <= 20 (conservador)");
  });
});
