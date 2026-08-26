/**
 * test/newsletter-read-source.test.ts (#6184, #6362)
 *
 * Sem rede real: `globalThis.fetch` é monkeypatchado (mesmo padrão de
 * `test/refresh-dedup.test.ts`/`test/kit-client.test.ts`). Cobre:
 *
 *   - `resolveNewsletterBackend` — default "beehiiv", flag ausente/inválida
 *     não muda o default (fail-safe); chave `publishing.newsletter.read_backend`
 *     (item 1, #6362 — separada da chave de ENVIO).
 *   - `resolveNewsletterReadConfig` — delega pra `resolveBeehiivConfig`/
 *     `resolveKitConfig` conforme o backend; propaga `platform.config.json`
 *     corrompido como erro em vez de mascarar como default (item 6, #6362).
 *   - `listRecentNewsletterPosts`/`listNewsletterPostsInWindow`/
 *     `fetchNewsletterPostContent` para os dois backends.
 *   - **O teste que a issue #6184 exige como "pronto quando":** montagem de
 *     link (`webUrl`) quando `public_url` do Kit vem ausente — nunca lança,
 *     nunca vira string vazia, sempre `null` explícito.
 *   - **Os 3 testes que o bloqueio de merge da PR #6362 exigiu antes de
 *     mergear:** fixture realista (probe + test-send + 1 edição real, só a
 *     real entra — item 2); ordenação não-monotônica do Kit não perde o
 *     item mais novo publicado depois na resposta (item 3); default/parse
 *     tolerante/log de `read_backend` (item 4).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveNewsletterBackend,
  resolveNewsletterReadConfig,
  listRecentNewsletterPosts,
  listNewsletterPostsInWindow,
  fetchNewsletterPostContent,
} from "../scripts/lib/shared/newsletter-read-source.ts";

async function withMockFetch<T>(handler: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

/** Captura `console.error` durante `fn`, sempre restaurando depois (mesmo
 *  padrão de `test/apoia-se-probe.test.ts`). */
async function withCapturedConsoleError<T>(fn: () => Promise<T> | T): Promise<{ result: T; errors: string[] }> {
  const orig = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, errors };
  } finally {
    console.error = orig;
  }
}

function kitBroadcastsResponse(broadcasts: unknown[]) {
  return new Response(
    JSON.stringify({
      broadcasts,
      pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 50 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("resolveNewsletterBackend (#6184, #6362 item 1/4)", () => {
  it('default "beehiiv" quando platform.config.json não existe', () => {
    assert.equal(resolveNewsletterBackend(join(tmpdir(), "nao-existe-6184.json")), "beehiiv");
  });

  it('lê publishing.newsletter.read_backend === "kit" (chave PRÓPRIA de leitura, não "backend")', () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-backend-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({ publishing: { newsletter: { backend: "kit", read_backend: "kit" } } }),
      );
      assert.equal(resolveNewsletterBackend(path), "kit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('"backend" (ENVIO) = "kit" sem "read_backend" NÃO afeta a leitura — continua "beehiiv" (item 1, no-op de merge)', () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-backend-envio-only-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(path, JSON.stringify({ publishing: { newsletter: { backend: "kit" } } }));
      assert.equal(resolveNewsletterBackend(path), "beehiiv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parser tolerante: "Kit" (maiúscula) e "kit " (espaço) resolvem pra "kit" (item 4, precedente #6291)', () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-backend-tolerant-"));
    try {
      const p1 = join(dir, "a.json");
      writeFileSync(p1, JSON.stringify({ publishing: { newsletter: { read_backend: "Kit" } } }));
      assert.equal(resolveNewsletterBackend(p1), "kit");

      const p2 = join(dir, "b.json");
      writeFileSync(p2, JSON.stringify({ publishing: { newsletter: { read_backend: "kit " } } }));
      assert.equal(resolveNewsletterBackend(p2), "kit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('valor desconhecido/typo cai no default "beehiiv" e LOGA o valor bruto (item 4, precedente #6291)', async () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-backend-typo-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(path, JSON.stringify({ publishing: { newsletter: { read_backend: "beehiv" } } }));
      const { result, errors } = await withCapturedConsoleError(() => resolveNewsletterBackend(path));
      assert.equal(result, "beehiiv");
      assert.ok(
        errors.some((e) => e.includes("read_backend desconhecido") && e.includes("beehiv")),
        `esperava log do valor bruto desconhecido, recebi: ${JSON.stringify(errors)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON inválido cai no default sem lançar (resolveNewsletterBackend, versão não-checada)", () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-backend-badjson-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(path, "{ not json");
      assert.equal(resolveNewsletterBackend(path), "beehiiv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveNewsletterReadConfig (#6184, #6362 item 6)", () => {
  it("platform.config.json PRESENTE mas JSON inválido propaga ok:false (nunca mascara como beehiiv default)", () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-read-config-badjson-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(path, "{ not json");
      const result = resolveNewsletterReadConfig({ configPath: path });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /platform\.config\.json inválido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("platform.config.json AUSENTE segue default beehiiv normalmente (distinção do caso acima)", () => {
    const result = resolveNewsletterReadConfig({
      configPath: join(tmpdir(), "nao-existe-6362.json"),
      env: { BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "pub_1" },
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.config.backend, "beehiiv");
  });

  it("backend beehiiv sem BEEHIIV_API_KEY falha com reason explícito", () => {
    const result = resolveNewsletterReadConfig({ backend: "beehiiv", env: {} });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /BEEHIIV_API_KEY/);
  });

  it("backend kit sem KIT_API_KEY falha com reason explícito", () => {
    const result = resolveNewsletterReadConfig({ backend: "kit", env: {} });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /KIT_API_KEY/);
  });

  it("backend beehiiv com credenciais resolve config discriminada", () => {
    const result = resolveNewsletterReadConfig({
      backend: "beehiiv",
      env: { BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "pub_1" },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.backend, "beehiiv");
      assert.deepEqual(result.config.config, { apiKey: "k", publicationId: "pub_1" });
    }
  });

  it("backend kit com credenciais resolve config discriminada", () => {
    const result = resolveNewsletterReadConfig({ backend: "kit", env: { KIT_API_KEY: "kit_k" } });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.backend, "kit");
      assert.deepEqual(result.config.config, { apiKey: "kit_k" });
    }
  });
});

describe("listRecentNewsletterPosts — backend beehiiv (#6184)", () => {
  it("lista posts recentes via REST Beehiiv", async () => {
    await withMockFetch(
      (async (input: RequestInfo | URL) => {
        const u = new URL(typeof input === "string" ? input : input.toString());
        assert.ok(/\/posts$/.test(u.pathname));
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "post_1",
                status: "confirmed",
                publish_date: Math.floor(new Date("2026-08-01T10:00:00Z").getTime() / 1000),
                subject: "Edição 1",
                web_url: "https://diaria.beehiiv.com/p/edicao-1",
              },
            ],
            page: 1,
            total_pages: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
      async () => {
        const posts = await listRecentNewsletterPosts(
          { backend: "beehiiv", config: { apiKey: "k", publicationId: "pub_1" } },
          { limit: 5 },
        );
        assert.equal(posts.length, 1);
        assert.equal(posts[0].id, "post_1");
        assert.equal(posts[0].title, "Edição 1");
        assert.equal(posts[0].webUrl, "https://diaria.beehiiv.com/p/edicao-1");
        assert.equal(posts[0].publishedAtIso, "2026-08-01T10:00:00.000Z");
      },
    );
  });
});

describe("listRecentNewsletterPosts — backend kit (#6184)", () => {
  it("lista broadcasts recentes via REST Kit, status=completed", async () => {
    const seenParams: URLSearchParams[] = [];
    await withMockFetch(
      (async (input: RequestInfo | URL) => {
        const u = new URL(typeof input === "string" ? input : input.toString());
        assert.ok(/\/broadcasts$/.test(u.pathname));
        seenParams.push(u.searchParams);
        return new Response(
          JSON.stringify({
            broadcasts: [
              {
                id: 999,
                subject: "Broadcast Kit 1",
                send_at: null,
                status: "completed",
                public: true,
                published_at: "2026-08-02T09:00:00Z",
                created_at: "2026-08-02T08:00:00Z",
              },
            ],
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 50 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
      async () => {
        const posts = await listRecentNewsletterPosts(
          { backend: "kit", config: { apiKey: "kit_k" } },
          { limit: 5 },
        );
        assert.equal(posts.length, 1);
        assert.equal(posts[0].id, "999");
        assert.equal(posts[0].title, "Broadcast Kit 1");
        assert.equal(posts[0].publishedAtIso, "2026-08-02T09:00:00.000Z");
        // listBroadcasts (resumo) nunca traz public_url — webUrl da LISTAGEM
        // é sempre null, mesmo com o broadcast marcado `public: true` (#6184).
        assert.equal(posts[0].webUrl, null);
        assert.equal(seenParams[0]?.get("status"), "completed");
      },
    );
  });

  it("respeita stopBeforeMs (incremental) parando no cutoff", async () => {
    await withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            broadcasts: [
              { id: 2, subject: "Novo", send_at: null, status: "completed", public: true, published_at: "2026-08-10T09:00:00Z", created_at: "x" },
              { id: 1, subject: "Antigo", send_at: null, status: "completed", public: true, published_at: "2026-08-01T09:00:00Z", created_at: "x" },
            ],
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 50 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      async () => {
        const cutoffMs = new Date("2026-08-05T00:00:00Z").getTime();
        const posts = await listRecentNewsletterPosts(
          { backend: "kit", config: { apiKey: "kit_k" } },
          { limit: 10, stopBeforeMs: cutoffMs },
        );
        assert.equal(posts.length, 1, "só o post mais novo que o cutoff");
        assert.equal(posts[0].id, "2");
      },
    );
  });

  /**
   * **Fixture realista exigida pelo bloqueio de merge (item 2, #6362).**
   * Reproduz a conta Kit real medida ao vivo em 26/08/2026: 1 probe/teste
   * (`[probe-rodape]`), 1 test-send da edição do dia seguinte carregando o
   * HTML real dela, e 1 edição real (`public: true`). Sem o filtro
   * `public !== true`, o probe e o test-send entrariam em
   * `data/past-editions.md` e a edição seguinte veria os próprios links
   * como já publicados (dedup mutila a edição em silêncio).
   */
  it("filtra probe/test-send (public:false) — só a edição real (public:true) entra (item 2, bloqueio de merge)", async () => {
    await withMockFetch(
      (async () =>
        kitBroadcastsResponse([
          {
            id: 3,
            subject: "[probe-rodape] centralizar footer do Kit",
            send_at: null,
            status: "completed",
            public: false,
            published_at: "2026-08-25T23:19:13Z",
            created_at: "x",
          },
          {
            id: 2,
            subject: "[teste] Seu chatbot pode ter lido propaganda israelense",
            send_at: null,
            status: "completed",
            public: false,
            published_at: "2026-08-26T19:03:22Z",
            created_at: "x",
          },
          {
            id: 1,
            subject: "Empresas recontratam quem demitiu por IA",
            send_at: null,
            status: "completed",
            public: true,
            published_at: "2026-08-26T09:02:40Z",
            created_at: "x",
          },
        ])) as typeof fetch,
      async () => {
        const posts = await listRecentNewsletterPosts({ backend: "kit", config: { apiKey: "kit_k" } }, { limit: 10 });
        assert.equal(posts.length, 1, "só a edição real (public:true) deveria entrar");
        assert.equal(posts[0].id, "1");
        assert.equal(posts[0].title, "Empresas recontratam quem demitiu por IA");
      },
    );
  });

  /**
   * **Ordenação não-monotônica exigida pelo bloqueio de merge (item 3,
   * #6362).** Reproduz exatamente o caso medido ao vivo: `GET
   * /v4/broadcasts` devolve o item mais antigo por `published_at` (id
   * 25609361, publicado 25/08 23:08) ANTES do item mais novo (id 25609304,
   * o piloto Patronos: criado 23:00 do dia anterior, agendado, publicado só
   * 26/08 09:02) — ordem de criação/id decrescente, não de `published_at`.
   * Um early-stop que confiasse na ordem do servidor pararia de paginar ao
   * ver o 1º item e NUNCA veria o 2º, mais novo — perdendo uma edição
   * agendada (o caminho normal de toda edição diária). Este teste prova que
   * o item mais novo não se perde mesmo vindo depois na resposta.
   */
  it("não perde o item mais novo quando ele vem DEPOIS na resposta (item 3, ordenação não-monotônica)", async () => {
    await withMockFetch(
      (async () =>
        kitBroadcastsResponse([
          {
            id: 25609361,
            subject: "[TESTE] Empresas recontratam quem demitiu por IA",
            send_at: null,
            status: "completed",
            public: true,
            published_at: "2026-08-25T23:08:02Z", // mais antigo por published_at
            created_at: "2026-08-25T23:06:18Z",
          },
          {
            id: 25609304,
            subject: "Empresas recontratam quem demitiu por IA - patronos",
            send_at: "2026-08-26T09:00:00Z",
            status: "completed",
            public: true,
            published_at: "2026-08-26T09:02:40Z", // MAIS NOVO, mas vem DEPOIS na resposta
            created_at: "2026-08-25T23:00:01Z",
          },
        ])) as typeof fetch,
      async () => {
        // stopBeforeMs = logo antes do mais antigo dos dois — um early-stop
        // por ordem do servidor pararia ao ver o 1º item (mais antigo,
        // ainda > cutoff) sem nunca alcançar o 2º, mais novo.
        const cutoffMs = new Date("2026-08-24T00:00:00Z").getTime();
        const posts = await listRecentNewsletterPosts(
          { backend: "kit", config: { apiKey: "kit_k" } },
          { limit: 10, stopBeforeMs: cutoffMs },
        );
        assert.equal(posts.length, 2, "os 2 itens deveriam entrar, nenhum perdido");
        // Ordenado desc por publishedAtIso no cliente — o mais novo (piloto,
        // 09:02 do dia seguinte) vem PRIMEIRO, mesmo tendo vindo em 2º na resposta.
        assert.equal(posts[0].id, "25609304");
        assert.equal(posts[1].id, "25609361");
      },
    );
  });

  /**
   * Item 7 (#6362): validação Zod na fronteira Kit. Sem ela, um campo
   * crítico renomeado/omitido pelo Kit (`published_at`, `pagination.
   * has_next_page`/`end_cursor`) vira `undefined`, `extractPublishedDate`
   * devolve `null`, e o broadcast é descartado em SILÊNCIO — indistinguível
   * de "não há edições novas" (mesma família do #326 que motivou
   * `beehiiv.ts`). Com a validação, o shape errado lança LOUD em vez disso.
   */
  it("resposta Kit sem `pagination` lança (Zod), não normaliza silenciosamente pra lista vazia (item 7)", async () => {
    await withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            broadcasts: [
              { id: 1, subject: "X", send_at: null, status: "completed", public: true, published_at: "2026-08-01T00:00:00Z" },
            ],
            // `pagination` inteiro ausente — simula renomeação/remoção do campo pelo Kit.
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      async () => {
        await assert.rejects(
          () => listRecentNewsletterPosts({ backend: "kit", config: { apiKey: "kit_k" } }, { limit: 10 }),
          /pagination/i,
        );
      },
    );
  });
});

describe("listNewsletterPostsInWindow — janela de datas (#6184)", () => {
  it("beehiiv: filtra pela janela [start, end)", async () => {
    await withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "post_in", status: "confirmed", publish_date: Math.floor(new Date("2026-06-15T00:00:00Z").getTime() / 1000), subject: "Dentro" },
              { id: "post_out", status: "confirmed", publish_date: Math.floor(new Date("2026-05-15T00:00:00Z").getTime() / 1000), subject: "Fora" },
            ],
            page: 1,
            total_pages: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      async () => {
        const posts = await listNewsletterPostsInWindow(
          { backend: "beehiiv", config: { apiKey: "k", publicationId: "pub_1" } },
          { startMs: new Date("2026-06-01T00:00:00Z").getTime(), endMs: new Date("2026-07-01T00:00:00Z").getTime() },
        );
        assert.equal(posts.length, 1);
        assert.equal(posts[0].id, "post_in");
      },
    );
  });

  it("kit: filtra pela janela [start, end)", async () => {
    await withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            broadcasts: [
              { id: 10, subject: "Dentro", send_at: null, status: "completed", public: true, published_at: "2026-06-15T00:00:00Z", created_at: "x" },
              { id: 11, subject: "Fora", send_at: null, status: "completed", public: true, published_at: "2026-05-15T00:00:00Z", created_at: "x" },
            ],
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 50 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      async () => {
        const posts = await listNewsletterPostsInWindow(
          { backend: "kit", config: { apiKey: "kit_k" } },
          { startMs: new Date("2026-06-01T00:00:00Z").getTime(), endMs: new Date("2026-07-01T00:00:00Z").getTime() },
        );
        assert.equal(posts.length, 1);
        assert.equal(posts[0].id, "10");
      },
    );
  });
});

describe("fetchNewsletterPostContent (#6184)", () => {
  it("beehiiv: extrai html + webUrl do detalhe do post", async () => {
    await withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({ data: { id: "post_1", status: "confirmed", html: "<p>oi</p>", web_url: "https://diaria.beehiiv.com/p/x" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      async () => {
        const content = await fetchNewsletterPostContent(
          { backend: "beehiiv", config: { apiKey: "k", publicationId: "pub_1" } },
          "post_1",
        );
        assert.equal(content.html, "<p>oi</p>");
        assert.equal(content.webUrl, "https://diaria.beehiiv.com/p/x");
      },
    );
  });

  /**
   * **O teste que a issue #6184 exige como "pronto quando".**
   * `KitBroadcastDetail.public_url` é `string | undefined` (#6096) — nunca
   * confirmado que o Kit sempre popula. Aqui simulamos exatamente essa
   * ausência (campo OMITIDO do JSON da resposta, não uma string vazia) e
   * garantimos que `fetchNewsletterPostContent` NUNCA lança, NUNCA produz
   * `undefined`/string vazia — sempre `webUrl: null` explícito.
   */
  it("kit: public_url AUSENTE no broadcast → webUrl é null, nunca lança nem vira string vazia", async () => {
    await withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            broadcast: {
              id: 42,
              subject: "Sem página pública",
              send_at: null,
              status: "completed",
              public: false,
              published_at: "2026-08-20T09:00:00Z",
              created_at: "x",
              content: "<p>conteúdo do broadcast</p>",
              email_address: "oi@diar.ia.br",
              email_template: { id: 1, name: "default" },
              // public_url OMITIDO de propósito — o cenário real medido no #6096.
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      async () => {
        const content = await fetchNewsletterPostContent({ backend: "kit", config: { apiKey: "kit_k" } }, "42");
        assert.equal(content.html, "<p>conteúdo do broadcast</p>");
        assert.equal(content.webUrl, null, "público ausente vira null explícito, nunca undefined/''");
        assert.notEqual(content.webUrl, "", "nunca degrada pra string vazia silenciosa");
        assert.notEqual(content.webUrl, undefined, "sempre null explícito, nunca undefined solto");
      },
    );
  });

  it("kit: conteúdo AUSENTE (content: null) também vira null explícito", async () => {
    await withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            broadcast: {
              id: 43,
              subject: "Rascunho",
              send_at: null,
              status: "draft",
              public: false,
              published_at: null,
              created_at: "x",
              content: null,
              email_address: "oi@diar.ia.br",
              email_template: { id: 1, name: "default" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      async () => {
        const content = await fetchNewsletterPostContent({ backend: "kit", config: { apiKey: "kit_k" } }, "43");
        assert.equal(content.html, null);
        assert.equal(content.webUrl, null);
      },
    );
  });
});
