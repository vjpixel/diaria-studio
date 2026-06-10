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

  it("#2011 regressão: detecta acentos manglados (a-o, p-nico)", () => {
    // Beehiiv Schedule re-deriva: 'automação' → 'automa-o', 'pânico' → 'p-nico'
    const err1 = validateSlug("automa-o");
    assert.ok(err1 !== null, "automa-o deve ser rejeitado (acento manglado)");

    const err2 = validateSlug("p-nico");
    assert.ok(err2 !== null, "p-nico deve ser rejeitado (acento manglado)");
  });

  it("warning check 1 (consoante-única): falsos-positivos legítimos passam com force=true", () => {
    // x-ray, b-side, n-gram, f-score são slugs intencionais — não mangling PT-BR
    assert.equal(validateSlug("x-ray", true), null, "x-ray deve passar com force");
    assert.equal(validateSlug("b-side", true), null, "b-side deve passar com force");
    assert.equal(validateSlug("n-gram", true), null, "n-gram deve passar com force");
    assert.equal(validateSlug("f-score", true), null, "f-score deve passar com force");
  });

  it("warning check 1 (consoante-única): sem force ainda rejeita os mesmos slugs", () => {
    assert.ok(validateSlug("x-ray") !== null, "x-ray sem force deve ser rejeitado (heurística PT-BR)");
    assert.ok(validateSlug("b-side") !== null, "b-side sem force deve ser rejeitado");
  });

  it("warning check 2 (vogal-final): falsos-positivos legítimos passam com force=true", () => {
    // versao-a, parte-i, opcao-b são slugs A/B intencionais — não mangling PT-BR
    assert.equal(validateSlug("versao-a", true), null, "versao-a deve passar com force");
    assert.equal(validateSlug("parte-i", true), null, "parte-i deve passar com force");
    assert.equal(validateSlug("opcao-b", true), null, "opcao-b deve passar com force");
  });

  it("warning check 2 (vogal-final): sem force ainda rejeita os mesmos slugs", () => {
    assert.ok(validateSlug("versao-a") !== null, "versao-a sem force deve ser rejeitado (heurística PT-BR)");
    assert.ok(validateSlug("parte-i") !== null, "parte-i sem force deve ser rejeitado");
  });

  it("force=true não bypassa erros estruturais (vazio, maiúsculas, acentos)", () => {
    // Hard errors are never bypassed by force
    assert.ok(validateSlug("", true) !== null, "vazio ainda é erro com force");
    assert.ok(validateSlug("AI-Launch", true) !== null, "maiúsculas ainda é erro com force");
    assert.ok(validateSlug("automação", true) !== null, "acentos ainda são erro com force");
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

// ── validateSlug com title (#2048 item 5 — seoSlug comparison) ───────────────

describe("validateSlug com title — seoSlug comparison (#2048 item 5)", () => {
  it("aceita slug == seoSlug(title) — slug correto derivado do título", () => {
    // seoSlug("Automação e futuro") → "automacao-e-futuro"
    assert.equal(validateSlug("automacao-e-futuro", false, "Automação e futuro"), null);
    // seoSlug("Pânico no mercado") → "panico-no-mercado"
    assert.equal(validateSlug("panico-no-mercado", false, "Pânico no mercado"), null);
  });

  it("rejeita slug manglado (automa-o vs title 'Automação...')", () => {
    const err = validateSlug("automa-o", false, "Automação e futuro");
    assert.ok(err !== null, "automa-o vs título deve ser rejeitado");
    assert.match(err!, /canônico/i);
  });

  it("rejeita p-nico vs title 'Pânico'", () => {
    const err = validateSlug("p-nico", false, "Pânico no mercado");
    assert.ok(err !== null, "p-nico vs título deve ser rejeitado");
  });

  it("force=true bypassa o check de título (slug intencional diferente do canônico)", () => {
    // Editor quer usar slug mais curto que seoSlug gera — --force override
    assert.equal(validateSlug("automacao", true, "Automação e futuro do trabalho"), null);
  });

  it("force=true não bypassa erros estruturais com título", () => {
    // Acento no slug → erro estrutural independente de force ou título
    assert.ok(validateSlug("automação", true, "Automação") !== null);
    assert.ok(validateSlug("", true, "Algum título") !== null);
  });

  it("sem title: fallback para heurísticas de consoante/vogal (compat pré-GET)", () => {
    // automa-o sem título ainda é rejeitado pelo check de vogal-final
    assert.ok(validateSlug("automa-o") !== null);
    // p-nico sem título rejeitado pelo check de consoante-única
    assert.ok(validateSlug("p-nico") !== null);
    // Slug válido sem título: não rejeita
    assert.equal(validateSlug("automacao-e-futuro"), null);
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

  // Regressão #633: crashava com TypeError em vez de erro descritivo
  it("lança erro descritivo quando GET retorna 200 mas data é null", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ data: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await assert.rejects(
      () => fetchPost(MOCK_CFG, "post_abc", mockFetch),
      /sem objeto data/i,
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

  // Regressão #633: crashava com TypeError e deixava updated=true em estado inconsistente
  it("lança erro descritivo quando PATCH retorna 200 mas data é null", async () => {
    const mockFetch: typeof fetch = async (_url, init) => {
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        return new Response(JSON.stringify({ data: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // GET fallback (shouldn't be reached in this test)
      return new Response(
        JSON.stringify({ data: { id: "post_abc", web_settings: { slug: "old" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    await assert.rejects(
      () => patchSlug(MOCK_CFG, "post_abc", "new-slug", mockFetch),
      /sem objeto data/i,
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
      postTitle: "Anthropic lança Fable 5 com bloqueios embutidos",
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
      postTitle: "Automação e futuro do trabalho", // title so seoSlug(title) = targetSlug → passes 2b
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

  // #2048 item 5: fixPostSlug revalida com seoSlug(title) após GET.
  // Se o slug passado pelo caller não coincide com seoSlug(title), lança erro
  // ANTES do PATCH — previne mandar slug incorreto pro Beehiiv.
  it("#2048 regressão: fixPostSlug rejeita slug que diverge de seoSlug(title) após GET", async () => {
    // GET retorna title "Automação e futuro" — seoSlug = "automacao-e-futuro"
    // Caller passa "automacao-e-futuro-extra" (estruturalmente válido + passa heurísticas)
    // mas diverge de seoSlug(title) → rejeitado após GET.
    const mockFetch = makeMockFetch({
      slugBefore: "automacao-e-futuro-extra",
      postTitle: "Automação e futuro",
    });

    await assert.rejects(
      () =>
        fixPostSlug({
          postId: "post_abc",
          slug: "automacao-e-futuro-extra", // passa pré-validação, falha vs seoSlug(title)
          execute: true,
          cfg: MOCK_CFG,
          fetchFn: mockFetch,
        }),
      /inválido.*título|vs título/i,
    );
  });

  it("#2048 force bypassa a validação de seoSlug(title)", async () => {
    // Caller quer usar slug diferente do canônico (ex: slug mais curto) — --force
    const targetSlug = "automacao";
    const mockFetch = makeMockFetch({
      slugBefore: "automa-o",
      postTitle: "Automação e futuro do trabalho",
      slugAfterPatch: targetSlug,
      slugVerified: targetSlug,
    });

    const result = await fixPostSlug({
      postId: "post_abc",
      slug: targetSlug,
      execute: true,
      force: true, // bypassa seoSlug check
      cfg: MOCK_CFG,
      fetchFn: mockFetch,
    });

    assert.equal(result.updated, true);
    assert.equal(result.verified, true);
    assert.equal(result.slug_after, targetSlug);
  });
});
