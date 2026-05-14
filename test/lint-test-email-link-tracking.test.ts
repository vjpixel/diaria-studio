import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEmailUrls,
  decodeRedirectWrapper,
  categorizeUrl,
  checkLinkTracking,
} from "../scripts/lint-test-email-link-tracking.ts";

describe("extractEmailUrls (#1248)", () => {
  it("extrai hrefs de HTML", () => {
    const html = '<a href="https://a.com">x</a><a href="https://b.com/p">y</a>';
    assert.deepEqual(extractEmailUrls(html).sort(), ["https://a.com", "https://b.com/p"]);
  });

  it("extrai URLs nuas de plain text", () => {
    const text = "Veja https://example.com/foo e https://other.com/bar";
    const r = extractEmailUrls(text);
    assert.equal(r.length, 2);
  });

  it("dedupe URLs duplicadas", () => {
    const html = '<a href="https://a.com">x</a> <a href="https://a.com">y</a>';
    assert.equal(extractEmailUrls(html).length, 1);
  });
});

describe("decodeRedirectWrapper (#1248)", () => {
  it("decoda Gmail Image Proxy", () => {
    const wrapped = "https://www.google.com/url?q=https%3A%2F%2Freal.com%2Fpath&sa=U";
    assert.equal(decodeRedirectWrapper(wrapped), "https://real.com/path");
  });

  it("retorna URL original se não é wrapper conhecido", () => {
    const url = "https://example.com/page";
    assert.equal(decodeRedirectWrapper(url), url);
  });

  it("não decoda Beehiiv tracking (URL opaca)", () => {
    const url = "https://link.diaria.beehiiv.com/abc123";
    assert.equal(decodeRedirectWrapper(url), url);
  });
});

describe("categorizeUrl (#1248)", () => {
  it("non_http: mailto", () => {
    assert.equal(categorizeUrl("mailto:x@y.com"), "non_http");
  });
  it("non_http: tel", () => {
    assert.equal(categorizeUrl("tel:+5511999999"), "non_http");
  });
  it("non_http: javascript", () => {
    assert.equal(categorizeUrl("javascript:void(0)"), "non_http");
  });
  it("non_http: URL inválida", () => {
    assert.equal(categorizeUrl("not-a-url"), "non_http");
  });
  it("auth_required: linkedin.com", () => {
    assert.equal(categorizeUrl("https://www.linkedin.com/in/x"), "auth_required");
    assert.equal(categorizeUrl("https://linkedin.com/company/y"), "auth_required");
  });
  it("auth_required: facebook.com", () => {
    assert.equal(categorizeUrl("https://www.facebook.com/page"), "auth_required");
  });
  it("null: URL pública normal", () => {
    assert.equal(categorizeUrl("https://example.com/article"), null);
  });
});

describe("checkLinkTracking — integração mock (#1248)", () => {
  it("dedupe URLs antes de fetch", async () => {
    const html = '<a href="https://a.com">x</a><a href="https://a.com">y</a>';
    let fetchCount = 0;
    const fetchStub = (): Promise<Response> => {
      fetchCount++;
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    await checkLinkTracking(html, fetchStub as never);
    assert.equal(fetchCount, 1, "URL duplicada fetched 1×");
  });

  it("skip auth_required + non_http", async () => {
    const html = `
      <a href="https://www.linkedin.com/in/x">li</a>
      <a href="mailto:x@y.com">mail</a>
      <a href="https://example.com/article">real</a>
    `;
    let urlsFetched: string[] = [];
    const fetchStub = (url: string | URL): Promise<Response> => {
      urlsFetched.push(String(url));
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(urlsFetched.length, 1);
    assert.equal(urlsFetched[0], "https://example.com/article");
    assert.equal(r.skipped.length, 2);
  });

  it("link_dead quando HEAD retorna 4xx", async () => {
    const html = '<a href="https://dead.example.com">x</a>';
    const fetchStub = (): Promise<Response> =>
      Promise.resolve(new Response(null, { status: 404 }));
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].type, "link_dead");
    assert.equal(r.issues[0].status, 404);
  });

  it("segue redirects até 200", async () => {
    const html = '<a href="https://start.com">x</a>';
    const responses = [
      new Response(null, { status: 301, headers: { Location: "https://end.com" } }),
      new Response(null, { status: 200 }),
    ];
    let i = 0;
    const fetchStub = (): Promise<Response> => Promise.resolve(responses[i++]);
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 0);
    assert.equal(r.passed, 1);
  });

  it("passed conta URLs OK", async () => {
    const html = '<a href="https://a.com">x</a><a href="https://b.com">y</a>';
    const fetchStub = (): Promise<Response> =>
      Promise.resolve(new Response(null, { status: 200 }));
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.passed, 2);
    assert.equal(r.issues.length, 0);
  });
});
