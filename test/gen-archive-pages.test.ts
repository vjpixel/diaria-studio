/**
 * test/gen-archive-pages.test.ts (#467, regressão #633)
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
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  UnresolvedMergeTagError,
} from "../scripts/lib/site-archive-pages.ts";
import { generateArchivePages, loadPosts } from "../scripts/gen-archive-pages.ts";

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

describe("derivePageTitle / deriveMetaDescription (#5101 item 2)", () => {
  it("usa meta_default_title quando presente", () => {
    assert.equal(derivePageTitle(makePost({ meta_default_title: "Título SEO" })), "Título SEO");
  });

  it("cai pro title do post quando meta_default_title é null", () => {
    assert.equal(derivePageTitle(makePost()), "Exemplo de edição");
  });

  it("usa meta_default_description quando presente", () => {
    assert.equal(
      deriveMetaDescription(makePost({ meta_default_description: "Description SEO" })),
      "Description SEO",
    );
  });

  it("cai pra subtitle quando meta_default_description é null", () => {
    assert.equal(deriveMetaDescription(makePost()), "Subtítulo da edição");
  });

  it("cai pra preview_text quando subtitle e meta_default_description faltam", () => {
    assert.equal(
      deriveMetaDescription(makePost({ subtitle: null })),
      "Preview text da edição",
    );
  });

  it("nunca fica vazio — cai pro título e depois pro fallback genérico", () => {
    const desc = deriveMetaDescription(
      makePost({ subtitle: null, preview_text: null, title: "" }),
    );
    assert.ok(desc.length > 0);
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

  it("injeta title, meta description e canonical no <head>", () => {
    const html = buildArchivePageHtml(makePost());
    assert.match(html, /<title>Exemplo de edição<\/title>/);
    assert.match(html, /<meta name="description" content="Subtítulo da edição">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/p\/exemplo-de-edicao">/);
  });

  it("escapa HTML na description pra não quebrar o atributo (aspas/&)", () => {
    const post = makePost({ subtitle: 'Preço "especial" & imposto' });
    const html = buildArchivePageHtml(post);
    assert.match(html, /content="Preço &quot;especial&quot; &amp; imposto"/);
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
