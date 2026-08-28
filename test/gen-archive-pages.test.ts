/**
 * test/gen-archive-pages.test.ts (#467, regressão #633; #6184 Kit)
 *
 * Cobre o miolo puro (scripts/lib/site-archive-pages.ts) e o gerador
 * (scripts/gen-archive-pages.ts) com fixtures sintéticas — sem depender do
 * cache real de data/beehiiv-cache/posts/ (gitignored, indisponível em CI).
 *
 * Casos cobertos, ambos linkados no #467 como achados que este trabalho
 * resolve "de graça":
 *   - lang="pt-BR" injetado mesmo quando o HTML de origem não tem `lang`
 *     nenhum (#5101 item 1 — a versão SERVIDA pela Beehiiv injeta `en`,
 *     mas content.free.web cru não tem atributo algum).
 *   - meta description cai pra subtitle/preview_text quando
 *     meta_default_description vem null (#5101 item 2).
 *   - draft/slug placeholder ("new-post") nunca gera página.
 *
 * #6184 adiciona: `kitUnifiedPostToArchivePost` (adaptador puro
 * UnifiedCachedPost → ArchivePost) e `loadKitArchivePosts` (gating por
 * `read_backend`, filtro `public===true`, fixture de `data/kit-cache/broadcasts/`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArchivePost,
  isPublishedPost,
  selectPublishedPosts,
  derivePageTitle,
  deriveMetaDescription,
  archiveUrlForSlug,
  buildArchivePageHtml,
  buildSitemapXml,
  sitemapEntriesForPosts,
  kitUnifiedPostToArchivePost,
  UnresolvedMergeTagError,
} from "../scripts/lib/site-archive-pages.ts";
import { generateArchivePages, loadPosts, loadKitArchivePosts } from "../scripts/gen-archive-pages.ts";
import type { UnifiedCachedPost } from "../scripts/lib/shared/edition-cache-reader.ts";

function makePost(overrides: Partial<ArchivePost> = {}): ArchivePost {
  return {
    slug: "exemplo-de-edicao",
    title: "Exemplo de edição",
    subtitle: "Subtítulo da edição",
    preview_text: "Preview text da edição",
    meta_default_title: null,
    meta_default_description: null,
    status: "confirmed",
    web_url: "https://diar.ia.br/p/exemplo-de-edicao",
    publish_date: 1755993600, // 2025-08-24T00:00:00Z
    content: {
      free: {
        web: "<!DOCTYPE html><html><head><style>body{color:#000}</style></head><body><h1>Exemplo</h1></body></html>",
      },
    },
    ...overrides,
  };
}

describe("isPublishedPost / selectPublishedPosts", () => {
  it("aceita status confirmed com slug real", () => {
    assert.equal(isPublishedPost(makePost()), true);
  });

  it("rejeita draft", () => {
    assert.equal(isPublishedPost(makePost({ status: "draft" })), false);
  });

  it("rejeita o slug placeholder 'new-post' mesmo se confirmed", () => {
    assert.equal(isPublishedPost(makePost({ slug: "new-post" })), false);
  });

  it("ordena por publish_date desc", () => {
    const older = makePost({ slug: "mais-velho", publish_date: 1000 });
    const newer = makePost({ slug: "mais-novo", publish_date: 2000 });
    const draft = makePost({ slug: "rascunho", status: "draft" });
    const selected = selectPublishedPosts([older, draft, newer]);
    assert.deepEqual(
      selected.map((p) => p.slug),
      ["mais-novo", "mais-velho"],
    );
  });
});

describe("derivePageTitle / deriveMetaDescription (#5101 item 2, #6281)", () => {
  it("usa meta_default_title quando presente", () => {
    assert.equal(derivePageTitle(makePost({ meta_default_title: "Título SEO" })), "Título SEO");
  });

  it("cai pro title do post quando meta_default_title é null", () => {
    assert.equal(derivePageTitle(makePost()), "Exemplo de edição");
  });

  // #6281: meta_default_description NÃO tem mais prioridade sobre a
  // própria edição — medido ao vivo no cache real, ~42% dos posts têm esse
  // campo POPULADO com o MESMO bug (subtitle disfarçado, descreve só os
  // outros destaques). Só é usado quando `ownEditionDescription` não dá pra
  // montar (title vazio).
  it("ignora meta_default_description quando title (própria edição) está disponível — evita reproduzir o bug do #6281 nesse campo", () => {
    assert.equal(
      deriveMetaDescription(makePost({ meta_default_description: "Description SEO de outro destaque" })),
      "Exemplo de edição. Subtítulo da edição",
    );
  });

  it("cai pra meta_default_description só quando a própria edição não é derivável (title vazio)", () => {
    assert.equal(
      deriveMetaDescription(
        makePost({ title: "", subtitle: null, preview_text: null, meta_default_description: "Description SEO" }),
      ),
      "Description SEO",
    );
  });

  // #6281: subtitle/preview_text NUNCA descrevem a PRÓPRIA página sozinhos —
  // na diária, por construção editorial, são o teaser dos OUTROS destaques
  // (D2/D3) da mesma edição, não da página cujo <title> é o destaque D1
  // (post.title). A description agora começa pelo D1 (bate com <title>) e
  // só complementa com subtitle/preview_text.
  it("combina title (D1, bate com <title> da página) + subtitle (D2/D3), ignorando meta_default_description", () => {
    assert.equal(
      deriveMetaDescription(makePost()),
      "Exemplo de edição. Subtítulo da edição",
    );
  });

  it("cai pra title + preview_text quando só subtitle falta", () => {
    assert.equal(
      deriveMetaDescription(makePost({ subtitle: null })),
      "Exemplo de edição. Preview text da edição",
    );
  });

  it("cai só pro title quando subtitle e preview_text faltam — nunca description de outros destaques sem o próprio", () => {
    assert.equal(deriveMetaDescription(makePost({ subtitle: null, preview_text: null })), "Exemplo de edição");
  });

  it("nunca fica vazio — cai pro fallback genérico quando nem title sobra", () => {
    const desc = deriveMetaDescription(
      makePost({ subtitle: null, preview_text: null, title: "" }),
    );
    assert.ok(desc.length > 0);
  });

  it("trunca em ~155 chars sem cortar no meio de palavra, com reticências", () => {
    const post = makePost({
      title: "Título bem longo da edição que já ocupa boa parte do orçamento de caracteres disponível",
      subtitle:
        "E aqui vem um teaser dos outros destaques que também é bem comprido, o suficiente pra estourar o limite de 155 caracteres da meta description padrão de SEO",
    });
    const desc = deriveMetaDescription(post);
    assert.ok(desc.length <= 156, `esperado <=156 chars, veio ${desc.length}`);
    assert.ok(desc.endsWith("…"));
    assert.ok(!/\s…$/.test(desc), "não deve sobrar espaço colado nas reticências");
  });

  it("não trunca description curta — passa intacta", () => {
    assert.equal(deriveMetaDescription(makePost()), "Exemplo de edição. Subtítulo da edição");
  });
});

describe("buildArchivePageHtml", () => {
  it("injeta lang=\"pt-BR\" quando o HTML de origem não tem lang nenhum", () => {
    const html = buildArchivePageHtml(makePost());
    assert.match(html, /<html lang="pt-BR">/);
  });

  it("substitui lang existente por pt-BR em vez de duplicar o atributo", () => {
    const post = makePost({
      content: {
        free: {
          web: '<!DOCTYPE html><html lang="en"><head></head><body>x</body></html>',
        },
      },
    });
    const html = buildArchivePageHtml(post);
    assert.match(html, /<html lang="pt-BR">/);
    assert.equal((html.match(/lang=/g) ?? []).length, 1);
  });

  it("injeta title, meta description (própria edição, #6281) e canonical no <head>", () => {
    const html = buildArchivePageHtml(makePost());
    assert.match(html, /<title>Exemplo de edição<\/title>/);
    assert.match(html, /<meta name="description" content="Exemplo de edição\. Subtítulo da edição">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/p\/exemplo-de-edicao">/);
  });

  // #6281: escaping deve acontecer EXATAMENTE 1x — content="..." usa &quot;
  // pra representar a aspa literal (correto por spec de HTML: navegador e
  // crawler decodificam de volta pra `"` ao ler o atributo); &amp;quot;
  // (dupla-escapada) seria o bug real, nunca visto no código atual — este
  // teste trava essa distinção pra não regredir.
  it("escapa HTML na description pra não quebrar o atributo (aspas/&), exatamente 1x — não double-escaping", () => {
    const post = makePost({ title: 'Preço "especial"', subtitle: "& imposto" });
    const html = buildArchivePageHtml(post);
    assert.match(html, /content="Preço &quot;especial&quot;\. &amp; imposto"/);
    assert.doesNotMatch(html, /&amp;quot;|&amp;amp;|&amp;#39;/);
  });

  it("escapa HTML no título — dado externo (API Beehiiv), sem isso vira XSS refletido em <title>", () => {
    const post = makePost({ meta_default_title: 'Preço "especial" & <script>alert(1)</script>' });
    const html = buildArchivePageHtml(post);
    assert.match(
      html,
      /<title>Preço &quot;especial&quot; &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/,
    );
    assert.doesNotMatch(html, /<title>[^<]*<script>/);
  });

  it("lança se o post não é publicado (status !== confirmed)", () => {
    const post = makePost({ status: "draft" });
    assert.throws(() => buildArchivePageHtml(post));
  });

  it("lança nomeando o slug se o HTML de origem não tem tag <html>", () => {
    const post = makePost({
      content: { free: { web: "<body><h1>sem html/head nenhum</h1></body>" } },
    });
    assert.throws(() => buildArchivePageHtml(post), /exemplo-de-edicao/);
  });

  it("preserva o resto do documento sem tocar (body intacto)", () => {
    const html = buildArchivePageHtml(makePost());
    assert.match(html, /<h1>Exemplo<\/h1>/);
  });

  it("lança se o post não tem content.free.web", () => {
    const post = makePost({ content: { free: { web: null } } });
    assert.throws(() => buildArchivePageHtml(post));
  });
});

describe("archiveUrlForSlug", () => {
  it("monta a URL /p/{slug} no apex", () => {
    assert.equal(archiveUrlForSlug("minha-edicao"), "https://diar.ia.br/p/minha-edicao");
  });
});

describe("buildSitemapXml / sitemapEntriesForPosts", () => {
  it("gera 1 <url> por post publicado, com lastmod derivado de publish_date", () => {
    const posts = [makePost({ slug: "a", publish_date: 1755993600 }), makePost({ slug: "b", status: "draft" })];
    const entries = sitemapEntriesForPosts(posts);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].loc, "https://diar.ia.br/p/a");
    assert.equal(entries[0].lastmod, "2025-08-24");

    const xml = buildSitemapXml(entries);
    assert.match(xml, /<loc>https:\/\/diar\.ia\.br\/p\/a<\/loc>/);
    assert.match(xml, /<lastmod>2025-08-24<\/lastmod>/);
    assert.doesNotMatch(xml, /\/p\/b</);
  });

  it("aceita publish_date em epoch MILISSEGUNDOS (branch > 1e12), não só segundos", () => {
    const posts = [makePost({ slug: "c", publish_date: 1755993600000 })]; // mesma data, em ms
    const entries = sitemapEntriesForPosts(posts);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].lastmod, "2025-08-24");
  });
});

describe("generateArchivePages (integração, tmpdir)", () => {
  it("escreve 1 index.html por post publicado + sitemap.xml, pulando drafts e posts sem HTML", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-test-"));
    try {
      const outDir = join(tmp, "p");
      const sitemapPath = join(tmp, "sitemap.xml");
      const posts = [
        makePost({ slug: "edicao-1" }),
        makePost({ slug: "edicao-2", publish_date: 999 }),
        makePost({ slug: "rascunho", status: "draft" }),
        makePost({ slug: "sem-html", content: { free: { web: null } } }),
      ];

      const result = generateArchivePages(posts, outDir, sitemapPath);

      assert.equal(result.written, 2);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].slug, "sem-html");
      assert.equal(result.skipped[0].reason, "sem content.free.web");

      const dirs = readdirSync(outDir).sort();
      assert.deepEqual(dirs, ["edicao-1", "edicao-2"]);

      const html1 = readFileSync(join(outDir, "edicao-1", "index.html"), "utf8");
      assert.match(html1, /<html lang="pt-BR">/);

      const sitemap = readFileSync(sitemapPath, "utf8");
      assert.match(sitemap, /\/p\/edicao-1</);
      assert.match(sitemap, /\/p\/edicao-2</);
      assert.doesNotMatch(sitemap, /\/p\/rascunho</);
      assert.doesNotMatch(sitemap, /\/p\/sem-html</);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("é idempotente — rerodar remove órfãos de um slug que saiu do cache", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-test-"));
    try {
      const outDir = join(tmp, "p");
      const sitemapPath = join(tmp, "sitemap.xml");

      generateArchivePages([makePost({ slug: "vai-sumir" }), makePost({ slug: "fica" })], outDir, sitemapPath);
      assert.deepEqual(readdirSync(outDir).sort(), ["fica", "vai-sumir"]);

      generateArchivePages([makePost({ slug: "fica" })], outDir, sitemapPath);
      assert.deepEqual(readdirSync(outDir).sort(), ["fica"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("slug duplicado: pula o 2º post em vez de sobrescrever o 1º silenciosamente", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-test-"));
    try {
      const outDir = join(tmp, "p");
      const sitemapPath = join(tmp, "sitemap.xml");
      const first = makePost({
        slug: "duplicado",
        publish_date: 2000,
        content: { free: { web: "<html><head></head><body><h1>primeiro</h1></body></html>" } },
      });
      const second = makePost({
        slug: "duplicado",
        publish_date: 1000,
        content: { free: { web: "<html><head></head><body><h1>segundo</h1></body></html>" } },
      });

      const result = generateArchivePages([first, second], outDir, sitemapPath);

      // written conta só 1 — a contagem reflete o que de fato existe em disco.
      assert.equal(result.written, 1);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].slug, "duplicado");
      assert.match(result.skipped[0].reason, /slug duplicado/);

      const html = readFileSync(join(outDir, "duplicado", "index.html"), "utf8");
      assert.match(html, /primeiro/); // o 1º processado (mais recente) venceu, nunca sobrescrito

      const sitemap = readFileSync(sitemapPath, "utf8");
      // 1 <loc> só — nunca 2 <url> pro mesmo slug.
      assert.equal((sitemap.match(/<loc>/g) ?? []).length, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // #6256 — regressão: antes desta unidade, UM post com merge tag desconhecida
  // (não coberta pela whitelist de 2 sanitizes) abortava buildArchivePageHtml
  // pro lote INTEIRO — nenhum outro post saía, mesmo íntegro. Este teste prova
  // que um post "envenenado" NO MEIO do lote (não o 1º, não o último) não
  // impede os demais de serem gerados.
  it("post envenenado (merge tag desconhecida) NO MEIO do lote não derruba os demais", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-poisoned-"));
    try {
      const outDir = join(tmp, "p");
      const sitemapPath = join(tmp, "sitemap.xml");
      const posts = [
        makePost({ slug: "antes-1", publish_date: 4000 }),
        makePost({ slug: "antes-2", publish_date: 3000 }),
        makePost({
          slug: "envenenado",
          publish_date: 2000,
          content: {
            free: {
              web: '<!DOCTYPE html><html><head></head><body><p>Olá {{first_name}}</p></body></html>',
            },
          },
        }),
        makePost({ slug: "depois-1", publish_date: 1000 }),
        makePost({ slug: "depois-2", publish_date: 500 }),
      ];

      const result = generateArchivePages(posts, outDir, sitemapPath);

      // Os 4 posts íntegros saem normalmente — o envenenado não derruba o lote.
      assert.equal(result.written, 4);
      assert.deepEqual(readdirSync(outDir).sort(), ["antes-1", "antes-2", "depois-1", "depois-2"]);

      // O relatório nomeia o post E a tag — não é preciso re-rodar pra descobrir qual.
      assert.equal(result.unresolvedMergeTags.length, 1);
      assert.equal(result.unresolvedMergeTags[0].slug, "envenenado");
      assert.deepEqual(result.unresolvedMergeTags[0].tags, ["{{first_name}}"]);

      // skipped genérico também reflete o motivo, pro caller que só olha essa lista.
      const skip = result.skipped.find((s) => s.slug === "envenenado");
      assert.ok(skip, "post envenenado deve aparecer em skipped");
      assert.match(skip!.reason, /merge tag não resolvida.*first_name/);

      // Sitemap segue listando só o que ganhou página — sem o envenenado.
      const sitemap = readFileSync(sitemapPath, "utf8");
      assert.doesNotMatch(sitemap, /\/p\/envenenado</);
      assert.equal((sitemap.match(/<loc>/g) ?? []).length, 4);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("erro DIFERENTE de merge tag (ex: sem <html>) continua abortando o lote inteiro", () => {
    // Distinção deliberada do #6256: só merge tag desconhecida degrada por
    // post. Qualquer outra falha de buildArchivePageHtml é sinal estrutural
    // (mesma classe de decisão do JSON corrompido em loadPosts) e segue
    // abortando — não uniformizar os dois.
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-other-error-"));
    try {
      const outDir = join(tmp, "p");
      const sitemapPath = join(tmp, "sitemap.xml");
      const posts = [
        makePost({ slug: "ok-1" }),
        makePost({ slug: "sem-html-tag", content: { free: { web: "<body>sem html/head nenhum</body>" } } }),
      ];

      assert.throws(() => generateArchivePages(posts, outDir, sitemapPath), /não tem tag <html>/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadPosts (integração, tmpdir)", () => {
  it("carrega só arquivos post_*.json, ignorando outros arquivos no mesmo diretório", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-loadposts-"));
    try {
      writeFileSync(join(tmp, "post_1.json"), JSON.stringify(makePost({ slug: "a" })), "utf8");
      writeFileSync(join(tmp, "post_2.json"), JSON.stringify(makePost({ slug: "b" })), "utf8");
      writeFileSync(join(tmp, "README.md"), "não é um post", "utf8");
      writeFileSync(join(tmp, ".gitkeep"), "", "utf8");

      const posts = loadPosts(tmp);

      assert.equal(posts.length, 2);
      assert.deepEqual(
        posts.map((p) => p.slug).sort(),
        ["a", "b"],
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("post_*.json corrompido → erro nomeia o arquivo (achado do fleet review, #467)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-loadposts-corrupt-"));
    try {
      writeFileSync(join(tmp, "post_good.json"), JSON.stringify(makePost({ slug: "a" })), "utf8");
      writeFileSync(join(tmp, "post_bad.json"), "{ isto não é json válido", "utf8");

      assert.throws(() => loadPosts(tmp), /post_bad\.json tem JSON inválido/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Hotfix da rodada overnight 260826 — achado no review consolidado (alta
// confiança, P1). O guard do #6210 rodava ANTES do sanitize do link de voto,
// então `{{email}}` — que é a merge tag PADRÃO desde o #4581, presente em 91
// dos 259 posts do cache real — fazia buildArchivePageHtml LANÇAR, quebrando
// o acervo público inteiro e o publish-edition-site-page (#6202).
describe("buildArchivePageHtml — link de voto com merge tag padrão (#6210 × #4581)", () => {
  const comVoto = (web: string) => makePost({ content: { free: { web } } });

  it("post com `email={{email}}` NÃO lança — é o caso padrão, não uma anomalia", () => {
    const html = buildArchivePageHtml(
      comVoto('<!DOCTYPE html><html><head></head><body><a href="https://x/v?email={{email}}&e=1">Vote</a></body></html>'),
    );
    assert.ok(html.includes("email=&e=1"), "merge tag do voto deve virar valor vazio");
    assert.ok(!/\{\{email\}\}/.test(html), "não pode sobrar merge tag crua na página publicada");
  });

  it("o guard continua pegando merge tag que o sanitize NÃO cobre", () => {
    // O ponto de inverter a ordem era destravar o caso tratado, não desligar
    // o guard: uma merge tag diferente segue rejeitada.
    assert.throws(
      () =>
        buildArchivePageHtml(
          comVoto('<!DOCTYPE html><html><head></head><body><p>Olá {{first_name}}</p></body></html>'),
        ),
      /merge tag não resolvida/,
    );
  });

  it("`{{email}}` FORA do link de voto continua rejeitado", () => {
    // O sanitize é cirúrgico (`email={{email}}`), não um replace global de
    // `{{email}}` — então a mesma tag solta no corpo segue sendo erro.
    assert.throws(
      () => buildArchivePageHtml(comVoto('<!DOCTYPE html><html><head></head><body><p>seu e-mail: {{email}}</p></body></html>')),
      /merge tag não resolvida/,
    );
  });
});

// Decisão do editor #6210 (26/08/2026): o link de voto real (com edition+
// choice) não pode só zerar `email=` — o endpoint /vote exige identidade e
// o link ficaria quebrado. Precisa apontar pro fluxo /jogar (anônimo).
describe("buildArchivePageHtml — link de voto real vira /jogar (#6210, decisão do editor)", () => {
  const comVoto = (web: string) => makePost({ content: { free: { web } } });

  it("email={{email}}&edition=X&choice=A vira /jogar?edition=X, mesmo domínio", () => {
    const html = buildArchivePageHtml(
      comVoto(
        '<!DOCTYPE html><html><head></head><body>' +
          '<a href="https://poll.diaria.workers.dev/vote?email={{email}}&edition=260812&choice=A&utm_source=diar.ia.br">A</a>' +
          '<a href="https://poll.diaria.workers.dev/vote?email={{email}}&edition=260812&choice=B&utm_source=diar.ia.br">B</a>' +
          '</body></html>',
      ),
    );
    assert.ok(
      html.includes('href="https://poll.diaria.workers.dev/jogar?edition=260812"'),
      "link de voto deve virar /jogar?edition=... no mesmo domínio",
    );
    assert.ok(!/\/vote\?/.test(html), "não pode sobrar link pro /vote quebrado");
    assert.ok(!/\{\{email\}\}/.test(html));
    // As duas escolhas (A e B) da mesma edição colapsam pro MESMO link —
    // /jogar apresenta as duas imagens e captura o clique, não recebe
    // a escolha por query.
    const jogarLinks = html.match(/href="https:\/\/poll\.diaria\.workers\.dev\/jogar\?edition=260812"/g);
    assert.strictEqual(jogarLinks?.length, 2);
  });

  it("preserva o domínio original (eia.diar.ia.br vs poll.diaria.workers.dev vs legado)", () => {
    const html = buildArchivePageHtml(
      comVoto(
        '<!DOCTYPE html><html><head></head><body>' +
          '<a href="https://eia.diar.ia.br/vote?email={{email}}&edition=260515&choice=A&utm_source=x">A</a>' +
          '<a href="https://diar-ia-poll.diaria.workers.dev/vote?email={{email}}&edition=260515&choice=B&sig=&utm_source=x">B</a>' +
          '</body></html>',
      ),
    );
    assert.ok(html.includes('href="https://eia.diar.ia.br/jogar?edition=260515"'));
    assert.ok(html.includes('href="https://diar-ia-poll.diaria.workers.dev/jogar?edition=260515"'));
  });

  it("formato path-based /vote/{edition}/{A|B}?email={{email}} (buildVoteUrl atual, #5675) também vira /jogar", () => {
    // newsletter-render-html.ts (buildVoteUrl) gera este shape, não o
    // query-string legado — é o link que newsletter-final.html carrega
    // quando o #6202 publica uma edição nova como página pública.
    const html = buildArchivePageHtml(
      comVoto(
        '<!DOCTYPE html><html><head></head><body>' +
          '<a href="https://eia.diar.ia.br/vote/260827/A?email={{email}}">A</a>' +
          '<a href="https://eia.diar.ia.br/vote/260827/B?email={{email}}">B</a>' +
          '</body></html>',
      ),
    );
    assert.ok(html.includes('href="https://eia.diar.ia.br/jogar?edition=260827"'));
    assert.ok(!/\/vote\//.test(html), "não pode sobrar link pro /vote/ path-based quebrado");
    assert.ok(!/\{\{email\}\}/.test(html));
  });

  // Achado do fleet review desta PR: no cache real, o shape path-based
  // SEMPRE tem UTM de newsletter grudado depois de {{email}} — sem
  // consumir isso, o UTM sobrevivia colado no /jogar resultante, e um
  // clique da página WEB (sem contexto de e-mail) saía mentindo
  // utm_medium=newsletter. Trava o comportamento correto (descartar,
  // igual ao shape legado) contra o shape REAL, não um fixture idealizado.
  it("descarta o UTM de newsletter grudado no shape path-based (achado do fleet review — vazamento real no cache)", () => {
    const html = buildArchivePageHtml(
      comVoto(
        '<!DOCTYPE html><html><head></head><body>' +
          '<a href="https://eia.diar.ia.br/vote/260826/A?email={{email}}&utm_source=diar.ia.br&utm_medium=newsletter&utm_campaign=empresas-recontratam-quem-demitiu-por-ia">A</a>' +
          '<a href="https://eia.diar.ia.br/vote/260826/B?email={{email}}&utm_source=diar.ia.br&utm_medium=newsletter&utm_campaign=empresas-recontratam-quem-demitiu-por-ia">B</a>' +
          '</body></html>',
      ),
    );
    assert.ok(
      html.includes('href="https://eia.diar.ia.br/jogar?edition=260826"'),
      "link deve virar /jogar?edition=X limpo, sem UTM de newsletter grudado",
    );
    assert.ok(!/utm_medium=newsletter/.test(html), "clique da página WEB não pode sair atribuído a newsletter");
    assert.ok(!/\/vote\//.test(html));
    assert.ok(!/\{\{email\}\}/.test(html));
  });

  // O shape legado (query-string) já descartava trailing content por
  // construção — este teste só documenta que os DOIS shapes agora se
  // comportam igual (achado do fleet review: antes eram assimétricos).
  it("shape legado também descarta o mesmo jeito — os dois shapes agora são simétricos", () => {
    const html = buildArchivePageHtml(
      comVoto(
        '<!DOCTYPE html><html><head></head><body>' +
          '<a href="https://poll.diaria.workers.dev/vote?email={{email}}&edition=260511&choice=A&sig=&utm_source=diar.ia.br&utm_medium=newsletter&utm_campaign=x">A</a>' +
          '</body></html>',
      ),
    );
    assert.ok(html.includes('href="https://poll.diaria.workers.dev/jogar?edition=260511"'));
    assert.ok(!/utm_medium=newsletter/.test(html));
  });
});

// Achado do fleet review desta PR: sem este guard, um shape de link de
// voto que os 2 padrões reconhecidos NÃO cobrem (ordem de query diferente,
// choice fora de A/B, etc.) caía em silêncio no fallback genérico — que
// zera email= e reproduz o bug ORIGINAL do #6210 (link /vote sem
// identidade, quebrado) sem nenhum sinal de erro.
describe("buildArchivePageHtml — guard contra shape de /vote não reconhecido (#6210, achado do fleet review)", () => {
  const comVoto = (web: string) => makePost({ content: { free: { web } } });

  it("choice fora de A/B (shape não reconhecido) lança em vez de degradar pro fallback silencioso", () => {
    assert.throws(
      () =>
        buildArchivePageHtml(
          comVoto(
            '<!DOCTYPE html><html><head></head><body>' +
              '<a href="https://poll.diaria.workers.dev/vote?email={{email}}&edition=260812&choice=C">C</a>' +
              '</body></html>',
          ),
        ),
      /merge tag não resolvida/,
    );
  });

  it("ordem de query invertida (edition antes de email) lança em vez de degradar pro fallback silencioso", () => {
    assert.throws(
      () =>
        buildArchivePageHtml(
          comVoto(
            '<!DOCTYPE html><html><head></head><body>' +
              '<a href="https://poll.diaria.workers.dev/vote?edition=260812&email={{email}}&choice=A">A</a>' +
              '</body></html>',
          ),
        ),
      /merge tag não resolvida/,
    );
  });
});

// #6256 — a whitelist de sanitizes SÓ trata {{email}}/{{email_address_id}};
// qualquer OUTRA merge tag desconhecida precisa lançar um tipo DISTINGUÍVEL
// (não só um Error genérico) pra generateArchivePages poder degradar por
// post em vez de abortar o lote inteiro.
describe("verifyNoUnresolvedMergeTags — tipo do erro (#6256)", () => {
  it("lança UnresolvedMergeTagError (não Error genérico) com slug + tags únicas", () => {
    const post = makePost({
      content: {
        free: {
          web: '<!DOCTYPE html><html><head></head><body><p>Olá {{first_name}}, {{first_name}} de novo, e {{last_name}}</p></body></html>',
        },
      },
    });
    assert.throws(() => buildArchivePageHtml(post), (err: unknown) => {
      assert.ok(err instanceof UnresolvedMergeTagError, "deve ser UnresolvedMergeTagError");
      assert.equal((err as UnresolvedMergeTagError).slug, "exemplo-de-edicao");
      // {{first_name}} repetido, {{last_name}} 1x — tags deduplicadas.
      assert.deepEqual((err as UnresolvedMergeTagError).tags, ["{{first_name}}", "{{last_name}}"]);
      return true;
    });
  });
});

describe("buildArchivePageHtml — {{email_address_id}}, o identificador DOMINANTE", () => {
  const comTag = (web: string) => makePost({ content: { free: { web } } });

  it("some da página — mesma classe de vazamento do #6210", () => {
    // Medido no cache real: 421 ocorrências de {{email_address_id}} contra 186
    // de {{email}}. Aparece embutido em URL de rastreio
    // (`..._SUBSCRIBER_ID_{{email_address_id}}`), não em `chave={{tag}}`.
    const html = buildArchivePageHtml(
      comTag('<!DOCTYPE html><html><head></head><body><a href="https://x/l/abc_SUBSCRIBER_ID_{{email_address_id}}">l</a></body></html>'),
    );
    assert.ok(!/\{\{email_address_id\}\}/.test(html));
    assert.ok(html.includes("abc_SUBSCRIBER_ID_"), "o resto da URL permanece");
  });

  it("as duas tags juntas no mesmo post — o caso real", () => {
    const html = buildArchivePageHtml(
      comTag('<!DOCTYPE html><html><head></head><body><a href="https://x/v?email={{email}}">v</a><a href="https://x/l/z_SUBSCRIBER_ID_{{email_address_id}}">l</a></body></html>'),
    );
    assert.ok(!/\{\{[a-z_]+\}\}/i.test(html), "nenhuma merge tag pode sobrar");
  });
});

function makeUnifiedKitPost(overrides: Partial<UnifiedCachedPost> = {}): UnifiedCachedPost {
  return {
    origin: "kit",
    slug: "edicao-kit",
    title: "Assunto Kit",
    subtitle: "Prévia curta",
    subject: "Assunto Kit",
    web_url: "https://diar.ia.br/kit/edicao-kit",
    publish_date: 1_700_000_000,
    status: "confirmed",
    content: { free: { web: "<!DOCTYPE html><html><head></head><body><h1>Kit</h1></body></html>" } },
    public: true,
    ...overrides,
  };
}

describe("kitUnifiedPostToArchivePost (#6184 — adaptador Kit → ArchivePost)", () => {
  it("mapeia os campos comuns 1:1", () => {
    const got = kitUnifiedPostToArchivePost(makeUnifiedKitPost());
    assert.deepEqual(got, {
      slug: "edicao-kit",
      title: "Assunto Kit",
      subtitle: "Prévia curta",
      preview_text: null,
      meta_default_title: null,
      meta_default_description: null,
      status: "confirmed",
      web_url: "https://diar.ia.br/kit/edicao-kit",
      displayed_date: null,
      publish_date: 1_700_000_000,
      content: { free: { web: "<!DOCTYPE html><html><head></head><body><h1>Kit</h1></body></html>" } },
    });
  });

  it("devolve null quando não há slug resolvível — mesmo critério de um post Beehiiv sem slug", () => {
    assert.equal(kitUnifiedPostToArchivePost(makeUnifiedKitPost({ slug: undefined })), null);
  });

  it("title ausente cai pro slug (nunca undefined — buildArchivePageHtml precisa de string)", () => {
    const got = kitUnifiedPostToArchivePost(makeUnifiedKitPost({ title: undefined }));
    assert.equal(got?.title, "edicao-kit");
  });

  it("o resultado é gerável por buildArchivePageHtml (integração fina com o resto do pipeline)", () => {
    const archivePost = kitUnifiedPostToArchivePost(makeUnifiedKitPost())!;
    assert.equal(isPublishedPost(archivePost), true);
    const html = buildArchivePageHtml(archivePost);
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<title>Assunto Kit<\/title>/);
  });
});

describe("loadKitArchivePosts (#6184 — gating por read_backend + filtro public)", () => {
  function writeConfig(tmp: string, readBackend: string | undefined): string {
    const configPath = join(tmp, "platform.config.json");
    const body =
      readBackend === undefined
        ? {}
        : { publishing: { newsletter: { read_backend: readBackend } } };
    writeFileSync(configPath, JSON.stringify(body), "utf8");
    return configPath;
  }

  function writeKitBroadcast(dir: string, filename: string, overrides: Record<string, unknown> = {}): void {
    writeFileSync(
      join(dir, filename),
      JSON.stringify({
        id: 1,
        subject: "Edição Kit real",
        send_at: null,
        status: "completed",
        public: true,
        published_at: "2026-08-20T09:00:00Z",
        created_at: "2026-08-20T08:00:00Z",
        preview_text: null,
        description: "Prévia",
        thumbnail_alt: null,
        thumbnail_url: null,
        publication_id: 1,
        public_url: "https://diar.ia.br/kit/edicao-real",
        content: "<!DOCTYPE html><html><head></head><body><h1>Real</h1></body></html>",
        ...overrides,
      }),
      "utf8",
    );
  }

  it("read_backend ausente (default beehiiv) devolve [] mesmo com cache Kit populado", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gen-archive-kit-gate-"));
    try {
      const kitDir = join(tmp, "kit-cache");
      mkdirSync(kitDir, { recursive: true });
      writeKitBroadcast(kitDir, "b1.json");
      const configPath = writeConfig(tmp, undefined);
      assert.deepEqual(loadKitArchivePosts({ kitBroadcastsDir: kitDir, configPath }), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("read_backend=beehiiv explícito também devolve []", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gen-archive-kit-gate-"));
    try {
      const kitDir = join(tmp, "kit-cache");
      mkdirSync(kitDir, { recursive: true });
      writeKitBroadcast(kitDir, "b1.json");
      const configPath = writeConfig(tmp, "beehiiv");
      assert.deepEqual(loadKitArchivePosts({ kitBroadcastsDir: kitDir, configPath }), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("read_backend=kit: inclui broadcast public:true, exclui public:false (probe/piloto/test-send)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gen-archive-kit-gate-"));
    try {
      const kitDir = join(tmp, "kit-cache");
      mkdirSync(kitDir, { recursive: true });
      writeKitBroadcast(kitDir, "b1.json", { public: true, public_url: "https://diar.ia.br/kit/real" });
      writeKitBroadcast(kitDir, "b2.json", { public: false, public_url: "https://diar.ia.br/kit/probe" });
      const configPath = writeConfig(tmp, "kit");

      const posts = loadKitArchivePosts({ kitBroadcastsDir: kitDir, configPath });

      assert.equal(posts.length, 1);
      assert.equal(posts[0].slug, "real");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("read_backend=kit sem diretório de cache (nenhum kit-sync.ts rodou ainda) devolve [] sem lançar", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gen-archive-kit-gate-"));
    try {
      const configPath = writeConfig(tmp, "kit");
      assert.deepEqual(
        loadKitArchivePosts({ kitBroadcastsDir: join(tmp, "nao-existe"), configPath }),
        [],
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
