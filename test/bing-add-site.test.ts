/**
 * test/bing-add-site.test.ts (#5621)
 *
 * Cobre `scripts/bing-add-site.ts`: parse/normalização puros + as 3 chamadas
 * de rede (`addSite`/`getUserSites`/`submitFeed`), sempre com `fetch`
 * INJETADO — nenhuma chamada real ao BWT.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHostForAddSite,
  parseBingUserSitesResponse,
  isSiteRegistered,
  addSite,
  getUserSites,
  submitFeed,
} from "../scripts/bing-add-site.ts";

function fakeFetchJson(body: unknown, ok = true, status = 200): typeof fetch {
  return (async (url: string | URL) => {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body), url: String(url) } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("normalizeHostForAddSite (#5621 — armadilha da barra final)", () => {
  it("remove barra final", () => {
    assert.equal(normalizeHostForAddSite("https://livros.diar.ia.br/"), "https://livros.diar.ia.br");
  });

  it("sem barra final, mantém como está", () => {
    assert.equal(normalizeHostForAddSite("https://livros.diar.ia.br"), "https://livros.diar.ia.br");
  });

  it("remove múltiplas barras finais (defensivo)", () => {
    assert.equal(normalizeHostForAddSite("https://livros.diar.ia.br//"), "https://livros.diar.ia.br");
  });
});

describe("parseBingUserSitesResponse (#5621)", () => {
  it("achata {d: [{Url, IsVerified}]}", () => {
    const rows = parseBingUserSitesResponse({
      d: [
        { Url: "https://diar.ia.br/", IsVerified: true },
        { Url: "https://arquivo.diar.ia.br/", IsVerified: true },
      ],
    });
    assert.deepEqual(rows, [
      { url: "https://diar.ia.br/", verified: true },
      { url: "https://arquivo.diar.ia.br/", verified: true },
    ]);
  });

  it("campo IsVerified ausente -> verified null, nunca inventa true/false", () => {
    const rows = parseBingUserSitesResponse({ d: [{ Url: "https://x.com/" }] });
    assert.equal(rows[0].verified, null);
  });

  it("shape inesperado -> [], nunca lança", () => {
    assert.deepEqual(parseBingUserSitesResponse({}), []);
    assert.deepEqual(parseBingUserSitesResponse(null), []);
  });
});

describe("isSiteRegistered (#5621)", () => {
  const sites = [
    { url: "https://diar.ia.br/", verified: true },
    { url: "https://arquivo.diar.ia.br/", verified: true },
  ];

  it("casa host com ou sem barra final (tolerante a ambos os lados)", () => {
    assert.ok(isSiteRegistered(sites, "https://diar.ia.br"));
    assert.ok(isSiteRegistered(sites, "https://diar.ia.br/"));
  });

  it("host ausente -> false", () => {
    assert.equal(isSiteRegistered(sites, "https://livros.diar.ia.br"), false);
  });

  it("case-insensitive", () => {
    assert.ok(isSiteRegistered(sites, "https://DIAR.IA.BR"));
  });
});

describe("addSite / getUserSites / submitFeed (#5621) — fetch sempre mockado", () => {
  it("addSite retorna o status HTTP cru (202 não é tratado como sucesso aqui — o CALLER que decide)", async () => {
    const fetchStub = fakeFetchJson({}, true, 202);
    const status = await addSite("https://livros.diar.ia.br", "KEY", fetchStub);
    assert.equal(status, 202);
  });

  it("getUserSites faz o round-trip parse", async () => {
    const fetchStub = fakeFetchJson({ d: [{ Url: "https://diar.ia.br/", IsVerified: true }] });
    const sites = await getUserSites("KEY", fetchStub);
    assert.deepEqual(sites, [{ url: "https://diar.ia.br/", verified: true }]);
  });

  it("submitFeed monta a URL com siteUrl + feedUrl (não SubmitSitemap)", async () => {
    let capturedUrl = "";
    const fetchStub = (async (url: string | URL) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    await submitFeed("https://livros.diar.ia.br", "https://livros.diar.ia.br/sitemap.xml", "KEY", fetchStub);
    assert.match(capturedUrl, /\/SubmitFeed\?/);
    assert.match(capturedUrl, /siteUrl=https%3A%2F%2Flivros\.diar\.ia\.br/);
    assert.match(capturedUrl, /feedUrl=https%3A%2F%2Flivros\.diar\.ia\.br%2Fsitemap\.xml/);
  });

  it("resposta não-ok lança com o corpo (mesma disciplina de erro do bing-pull.ts irmão)", async () => {
    const fetchStub = fakeFetchJson({ error: "quota" }, false, 500);
    await assert.rejects(() => getUserSites("KEY", fetchStub), /Bing WMT GetUserSites 500/);
  });
});
