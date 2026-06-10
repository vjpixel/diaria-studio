/**
 * test/fix-post-slug.test.ts (#2011)
 *
 * Testa helpers puros + fluxo completo de fix-post-slug.ts com mock de fetch.
 * NUNCA chama a API Beehiiv real.
 *
 * Regressão central: o wizard de Schedule re-deriva o slug e mangla acentos
 * PT-BR (`automação` → `automa-o`). Este script corrige via PATCH.
 * Se a API parar de suportar web_settings.slug, o GET-verify vai detectar
 * e o teste de happy-path vai falhar — catching regression in both directions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateSlug,
  fetchPost,
  patchSlug,
  fixPostSlug,
  type FixSlugResult,
} from "../scripts/fix-post-slug.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_CFG = {
  apiKey: "test_key",
  publicationId: "pub_test",
};

/**
 * Builds a mock fetch function that returns different responses for
 * GET (read) vs PATCH (write) calls. PATCH may optionally "fail to persist"
 * to test the GET-verify guard (#573).
 */
function makeMockFetch(opts: {
  slugBefore: string | null;
  slugAfterPatch?: string | null; // what slug the PATCH response returns
  slugVerified?: string | null;  // what slug the second GET returns (post-patch)
  patchStatus?: number;          // 200 by default
  getStatus?: number;            // 200 by default
  postTitle?: string;
  postStatus?: string;
}): typeof fetch {
  let callCount = 0;

  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = init?.method ?? "GET";

    if (method === "PATCH") {
      // PATCH: update slug
      const status = opts.patchStatus ?? 200;
      if (status !== 200) {
        return new Response("Beehiiv error", { status });
      }
      const slug = opts.slugAfterPatch !== undefined
        ? opts.slugAfterPatch
        : (JSON.parse(init?.body as string) as { web_settings: { slug: string } })
            .web_settings.slug;
      return new Response(
        JSON.stringify({
          data: {
            id: "post_abc",
            title: opts.postTitle ?? "Test Post",
            status: opts.postStatus ?? "confirmed",
            web_settings: { slug },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // GET: may be called twice (before + verify)
    callCount++;
    const status = opts.getStatus ?? 200;
    if (status !== 200) {
      return new Response("Not found", { status });
    }

    // First GET returns slugBefore; second GET (verify) returns slugVerified
    const slugToReturn =
      callCount === 1
        ? opts.slugBefore
        : (opts.slugVerified !== undefined ? opts.slugVerified : opts.slugBefore);

    return new Response(
      JSON.stringify({
        data: {
          id: "post_abc",
          title: opts.postTitle ?? "Test Post",
          status: opts.postStatus ?? "confirmed",
          web_settings: { slug: slugToReturn },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

// ── validateSlug ──────────────────────────────────────────────────────────────

describe("validateSlug (#2011)", () => {
  it("aceita slug válido lowercase kebab", () => {
    assert.equal(validateSlug("anthropic-lanca-fable-5"), null);
    assert.equal(validateSlug("empregos-e-automacao-panico-vs-dados"), null);
    assert.equal(validateSlug("ia-2026"), null);
    assert.equal(validateSlug("abc"), null);
  });

  it("rejeita slug vazio", () => {
    assert.match(validateSlug("") ?? "", /vazio/i);
    assert.match(validateSlug("  ") ?? "", /vazio/i);
  });

  it("rejeita slug com espaços leading/trailing", () => {
    const err = validateSlug(" slug-ok ");
    assert.ok(err !== null);
    assert.match(err!, /leading|trailing/i);
  });

  it("#2011 regressão: detecta acentos manglados (a-o, a-nico)", () => {
    // Beehiiv Schedule re-deriva: 'automação' → 'automa-o', 'pânico' → 'p-nico'
    const err1 = validateSlug("automa-o");
    assert.ok(err1 !== null, "automa-o deve ser rejeitado (acento manglado)");

    const err2 = validateSlug("p-nico");
    assert.ok(err2 !== null, "p-nico deve ser rejeitado (acento manglado)");
  });

  it("rejeita maiúsculas", () => {
    const err = validateSlug("AI-Launch");
    assert.ok(err !== null);
  });

  it("rejeita acentos diretos", () => {
    const err = validateSlug("automação");
    assert.ok(err !== null);
  });

  it("rejeita hífens leading/trailing", () => {
    assert.ok(validateSlug("-slug") !== null);
    assert.ok(validateSlug("slug-") !== null);
  });

  it("rejeita hífens duplos internos", () => {
    assert.ok(validateSlug("slug--double") !== null);
  });
});

// ── fetchPost ─────────────────────────────────────────────────────────────────

describe("fetchPost (#2011)", () => {
  it("retorna post com web_settings.slug", async () => {
    const mockFetch = makeMockFetch({ slugBefore: "meu-slug-correto" });
    const post = await fetchPost(MOCK_CFG, "post_abc", mockFetch);
    assert.equal(post.id, "post_abc");
    assert.equal((post.web_settings as { slug?: string })?.slug, "meu-slug-correto");
  });

  it("lança erro quando API retorna status != 200", async () => {
    const mockFetch = makeMockFetch({ slugBefore: null, getStatus: 404 });
    await assert.rejects(
      () => fetchPost(MOCK_CFG, "post_nao_existe", mockFetch),
      /404/,
    );
  });
});

// ── patchSlug ─────────────────────────────────────────────────────────────────

describe("patchSlug (#2011)", () => {
  it("envia PATCH com web_settings.slug correto", async () => {
    let capturedBody: unknown;
    const mockFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          data: {
            id: "post_abc",
            web_settings: { slug: "novo-slug" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const post = await patchSlug(MOCK_CFG, "post_abc", "novo-slug", mockFetch);
    assert.deepEqual(capturedBody, { web_settings: { slug: "novo-slug" } });
    assert.equal((post.web_settings as { slug?: string })?.slug, "novo-slug");
  });

  it("lança erro quando PATCH retorna status != 200", async () => {
    const mockFetch = makeMockFetch({
      slugBefore: "old",
      slugAfterPatch: null,
      patchStatus: 422,
    });
    await assert.rejects(
      () => patchSlug(MOCK_CFG, "post_abc", "new-slug", mockFetch),
      /422/,
    );
  });
});

// ── fixPostSlug — dry-run ─────────────────────────────────────────────────────

describe("fixPostSlug dry-run (#2011)", () => {
  it("não faz PATCH em dry-run, retorna updated=false, verified=false", async () => {
    let patchCalled = false;
    const mockFetch: typeof fetch = async (_url, init) => {
      if ((init?.method ?? "GET") === "PATCH") {
        patchCalled = true;
        return new Response("{}", { status: 200 });
      }
      return new Response(
        JSON.stringify({ data: { id: "p", web_settings: { slug: "automa-o" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await fixPostSlug({
      postId: "post_abc",
      slug: "automacao-e-futuro",
      execute: false,
      cfg: MOCK_CFG,
      fetchFn: mockFetch,
    });

    assert.equal(patchCalled, false, "PATCH não deve ser chamado em dry-run");
    assert.equal(result.dry_run, true);
    assert.equal(result.updated, false);
    assert.equal(result.verified, false);
    assert.equal(result.slug_before, "automa-o");
    assert.equal(result.slug_target, "automacao-e-futuro");
  });
});

// ── fixPostSlug — happy path ──────────────────────────────────────────────────

describe("fixPostSlug execute (#2011)", () => {
  it("happy path: PATCH + GET-verify OK → verified=true", async () => {
    const targetSlug = "anthropic-lanca-fable-5-com-bloqueios-embutidos";
    const mockFetch = makeMockFetch({
      slugBefore: "anthropic-lanc-a-fable-5-com-bloqueios-embutidos", // mangled
      slugAfterPatch: targetSlug, // PATCH returns corrected slug
      slugVerified: targetSlug,   // GET-verify also returns corrected slug
      postTitle: "Anthropic lança Fable 5",
      postStatus: "confirmed",
    });

    const result = await fixPostSlug({
      postId: "post_abc",
      slug: targetSlug,
      execute: true,
      cfg: MOCK_CFG,
      fetchFn: mockFetch,
    });

    assert.equal(result.updated, true);
    assert.equal(result.verified, true);
    assert.equal(result.dry_run, false);
    assert.equal(result.slug_before, "anthropic-lanc-a-fable-5-com-bloqueios-embutidos");
    assert.equal(result.slug_after, targetSlug);
    assert.equal(result.slug_target, targetSlug);
  });

  it("no-op quando slug já está correto (idempotente)", async () => {
    let patchCalled = false;
    const slug = "slug-ja-correto";
    const mockFetch: typeof fetch = async (_url, init) => {
      if ((init?.method ?? "GET") === "PATCH") patchCalled = true;
      return new Response(
        JSON.stringify({ data: { id: "p", web_settings: { slug } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await fixPostSlug({
      postId: "post_abc",
      slug,
      execute: true,
      cfg: MOCK_CFG,
      fetchFn: mockFetch,
    });

    assert.equal(patchCalled, false, "PATCH não deve ser chamado quando slug já está correto");
    assert.equal(result.updated, false);
    assert.equal(result.verified, true);
    assert.equal(result.slug_after, slug);
  });

  it("#2011 regressão: GET-verify detecta slug que não persistiu e lança erro", async () => {
    const targetSlug = "automacao-e-futuro-do-trabalho";
    const mockFetch = makeMockFetch({
      slugBefore: "automa-o-e-futuro-do-trabalho", // mangled
      slugAfterPatch: targetSlug, // PATCH response says OK...
      slugVerified: "automa-o-e-futuro-do-trabalho", // ...but GET-verify shows old value (not persisted)
    });

    await assert.rejects(
      () =>
        fixPostSlug({
          postId: "post_abc",
          slug: targetSlug,
          execute: true,
          cfg: MOCK_CFG,
          fetchFn: mockFetch,
        }),
      /não persistiu/i,
    );
  });

  it("rejeita slug inválido antes de qualquer chamada de rede", async () => {
    let fetchCalled = false;
    const mockFetch: typeof fetch = async () => {
      fetchCalled = true;
      // Return a valid-looking response — but this should never be called
      return new Response(
        JSON.stringify({ data: { id: "p", web_settings: { slug: "anything" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await assert.rejects(
      () =>
        fixPostSlug({
          postId: "post_abc",
          slug: "automa-o", // mangled slug — caught by validateSlug (single vowel segment)
          execute: true,
          cfg: MOCK_CFG,
          fetchFn: mockFetch,
        }),
      /inválido/i,
    );

    assert.equal(fetchCalled, false, "fetch não deve ser chamado com slug inválido");
  });
});
