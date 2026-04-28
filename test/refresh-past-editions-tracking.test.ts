import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  extractBeehiivTrackingLinks,
  resolveBeehiivTracking,
  populateLinksFromTracking,
  type Post,
} from "../scripts/refresh-past-editions.ts";

/**
 * Tests da extração de tracking URLs do Beehiiv (#234) e da resolução
 * via HEAD redirect (#248 — coverage das funções async).
 *
 * `resolveBeehiivTracking` e `populateLinksFromTracking` mockam
 * `globalThis.fetch` pra exercitar branches sem network real.
 */

describe("extractBeehiivTrackingLinks (#234)", () => {
  it("extrai URL de tracking diaria.beehiiv.com", () => {
    const html = `
      <a href="https://diaria.beehiiv.com/c/abc123def">link</a>
      <a href="https://www.example.com/article">externa</a>
    `;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 1);
    assert.ok(tracking[0].startsWith("https://diaria.beehiiv.com/c/"));
  });

  it("extrai múltiplos subdomínios beehiiv.com", () => {
    const html = `
      <a href="https://diaria.beehiiv.com/c/aaa">a</a>
      <a href="https://other.beehiiv.com/c/bbb">b</a>
    `;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 2);
  });

  it("ignora URLs externas (não-beehiiv)", () => {
    const html = `
      <a href="https://openai.com/blog/post">openai</a>
      <a href="https://github.com/foo/bar">github</a>
    `;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 0);
  });

  it("dedup URLs idênticas", () => {
    const html = `
      <a href="https://diaria.beehiiv.com/c/abc">1</a>
      <a href="https://diaria.beehiiv.com/c/abc">2 — mesma URL</a>
    `;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 1);
  });

  it("aguenta string vazia sem crash", () => {
    assert.deepEqual(extractBeehiivTrackingLinks(""), []);
  });

  it("ignora URLs malformadas", () => {
    const html = `<a href="https://diaria.beehiiv.com/c/abc">ok</a> https://[broken not a url`;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 1);
  });

  it("limpa pontuação ao final da URL (mesma lógica do extractLinks)", () => {
    const html = `Veja https://diaria.beehiiv.com/c/abc123, e também https://diaria.beehiiv.com/c/def456.`;
    const tracking = extractBeehiivTrackingLinks(html);
    assert.equal(tracking.length, 2);
    assert.ok(tracking.every((u) => !/[.,);]+$/.test(u)));
  });
});

/**
 * Mock minimal do Response que usa `headers.get(name)` — só pra retornar Location.
 */
function mockResponse(headers: Record<string, string | null>): Response {
  return {
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  } as unknown as Response;
}

describe("resolveBeehiivTracking (#234, #248)", () => {
  const TRACKING = "https://diaria.beehiiv.com/c/abc123";
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retorna a URL externa quando Location aponta pra fora do beehiiv", async () => {
    globalThis.fetch = async () =>
      mockResponse({ location: "https://openai.com/blog/post" });
    const out = await resolveBeehiivTracking(TRACKING);
    assert.equal(out, "https://openai.com/blog/post");
  });

  it("retorna null quando não há Location header", async () => {
    globalThis.fetch = async () => mockResponse({ location: null });
    const out = await resolveBeehiivTracking(TRACKING);
    assert.equal(out, null);
  });

  it("rejeita Location apontando de volta pra diaria.beehiiv.com", async () => {
    globalThis.fetch = async () =>
      mockResponse({ location: "https://diaria.beehiiv.com/c/other" });
    const out = await resolveBeehiivTracking(TRACKING);
    assert.equal(out, null);
  });

  it("rejeita Location apontando pra outro subdomínio beehiiv.com", async () => {
    globalThis.fetch = async () =>
      mockResponse({ location: "https://other.beehiiv.com/redirect" });
    const out = await resolveBeehiivTracking(TRACKING);
    assert.equal(out, null);
  });

  it("rejeita Location com scheme javascript: (#249)", async () => {
    globalThis.fetch = async () =>
      mockResponse({ location: "javascript:alert(1)" });
    const out = await resolveBeehiivTracking(TRACKING);
    assert.equal(out, null);
  });

  it("rejeita Location com scheme data: (#249)", async () => {
    globalThis.fetch = async () =>
      mockResponse({
        location: "data:text/html,<script>alert(1)</script>",
      });
    const out = await resolveBeehiivTracking(TRACKING);
    assert.equal(out, null);
  });

  it("rejeita Location com scheme ftp: (#249)", async () => {
    globalThis.fetch = async () =>
      mockResponse({ location: "ftp://ftp.example.com/file" });
    const out = await resolveBeehiivTracking(TRACKING);
    assert.equal(out, null);
  });

  it("aceita Location http (non-https)", async () => {
    globalThis.fetch = async () =>
      mockResponse({ location: "http://legacy.example.com/article" });
    const out = await resolveBeehiivTracking(TRACKING);
    assert.equal(out, "http://legacy.example.com/article");
  });

  it("retorna null quando fetch lança (network error)", async () => {
    globalThis.fetch = async () => {
      throw new Error("ENOTFOUND");
    };
    const out = await resolveBeehiivTracking(TRACKING);
    assert.equal(out, null);
  });

  it("retorna null quando Location é URL malformada", async () => {
    globalThis.fetch = async () =>
      mockResponse({ location: "https://[malformed-no-host" });
    const out = await resolveBeehiivTracking(TRACKING);
    assert.equal(out, null);
  });
});

describe("populateLinksFromTracking (#234, #248)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makePost(overrides: Partial<Post> = {}): Post {
    return {
      id: "p1",
      title: "Edição teste",
      published_at: "2026-04-25T10:00:00Z",
      ...overrides,
    };
  }

  it("idempotente: se post.links já populado, retorna sem chamar fetch", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return mockResponse({ location: "https://will-not-be-called" });
    };
    const post = makePost({
      links: ["https://existing.com/a"],
      html: '<a href="https://diaria.beehiiv.com/c/abc">link</a>',
    });
    const result = await populateLinksFromTracking(post);
    assert.deepEqual(result, { resolved: 0, skipped: 0 });
    assert.equal(fetchCalled, false);
    assert.deepEqual(post.links, ["https://existing.com/a"]);
  });

  it("retorna sem touch quando html e markdown estão ambos vazios", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return mockResponse({});
    };
    const post = makePost(); // sem html nem markdown
    const result = await populateLinksFromTracking(post);
    assert.deepEqual(result, { resolved: 0, skipped: 0 });
    assert.equal(fetchCalled, false);
    assert.equal(post.links, undefined);
  });

  it("content sem tracking URLs cai no extractLinks tradicional (sem fetch)", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return mockResponse({});
    };
    const post = makePost({
      html: '<a href="https://openai.com/blog/post">externa direta</a>',
    });
    const result = await populateLinksFromTracking(post);
    assert.deepEqual(result, { resolved: 0, skipped: 0 });
    assert.equal(fetchCalled, false);
    assert.deepEqual(post.links, ["https://openai.com/blog/post"]);
  });

  it("resolve tracking URLs e popula links[]", async () => {
    const resolutions: Record<string, string> = {
      "https://diaria.beehiiv.com/c/aaa": "https://openai.com/post-a",
      "https://diaria.beehiiv.com/c/bbb": "https://github.com/repo-b",
    };
    globalThis.fetch = async (req) => {
      const url = req as string;
      return mockResponse({ location: resolutions[url] ?? null });
    };
    const post = makePost({
      html: `
        <a href="https://diaria.beehiiv.com/c/aaa">a</a>
        <a href="https://diaria.beehiiv.com/c/bbb">b</a>
      `,
    });
    const result = await populateLinksFromTracking(post);
    assert.equal(result.resolved, 2);
    assert.equal(result.skipped, 0);
    assert.ok(post.links?.includes("https://openai.com/post-a"));
    assert.ok(post.links?.includes("https://github.com/repo-b"));
  });

  it("conta skipped quando resolveBeehiivTracking retorna null", async () => {
    globalThis.fetch = async () => mockResponse({ location: null });
    const post = makePost({
      html: '<a href="https://diaria.beehiiv.com/c/fail">x</a>',
    });
    const result = await populateLinksFromTracking(post);
    assert.equal(result.resolved, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(post.links, []);
  });

  it("muta post.links in-place (contrato documentado)", async () => {
    globalThis.fetch = async () =>
      mockResponse({ location: "https://resolved.com/page" });
    const post = makePost({
      html: '<a href="https://diaria.beehiiv.com/c/x">x</a>',
    });
    const before = post.links;
    await populateLinksFromTracking(post);
    // post mutado; antes não tinha links definido
    assert.equal(before, undefined);
    assert.ok(Array.isArray(post.links));
    assert.equal(post.links?.length, 1);
  });
});
