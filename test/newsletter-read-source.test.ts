/**
 * test/newsletter-read-source.test.ts (#6184)
 *
 * Sem rede real: `globalThis.fetch` é monkeypatchado (mesmo padrão de
 * `test/refresh-dedup.test.ts`/`test/kit-client.test.ts`). Cobre:
 *
 *   - `resolveNewsletterBackend` — default "beehiiv", flag ausente/inválida
 *     não muda o default (fail-safe).
 *   - `resolveNewsletterReadConfig` — delega pra `resolveBeehiivConfig`/
 *     `resolveKitConfig` conforme o backend.
 *   - `listRecentNewsletterPosts`/`listNewsletterPostsInWindow`/
 *     `fetchNewsletterPostContent` para os dois backends.
 *   - **O teste que a issue #6184 exige como "pronto quando":** montagem de
 *     link (`webUrl`) quando `public_url` do Kit vem ausente — nunca lança,
 *     nunca vira string vazia, sempre `null` explícito.
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

describe("resolveNewsletterBackend (#6184)", () => {
  it('default "beehiiv" quando platform.config.json não existe', () => {
    assert.equal(resolveNewsletterBackend(join(tmpdir(), "nao-existe-6184.json")), "beehiiv");
  });

  it('lê publishing.newsletter.backend === "kit"', () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-backend-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(path, JSON.stringify({ publishing: { newsletter: { backend: "kit" } } }));
      assert.equal(resolveNewsletterBackend(path), "kit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('valor desconhecido/typo cai no default "beehiiv" (fail-safe)', () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-backend-typo-"));
    const path = join(dir, "platform.config.json");
    try {
      writeFileSync(path, JSON.stringify({ publishing: { newsletter: { backend: "kti" } } }));
      assert.equal(resolveNewsletterBackend(path), "beehiiv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON inválido cai no default sem lançar", () => {
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

describe("resolveNewsletterReadConfig (#6184)", () => {
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
