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
  shouldCallAddSite,
  addSite,
  getUserSites,
  submitFeed,
} from "../scripts/bing-add-site.ts";

function fakeFetchJson(body: unknown, ok = true, status = 200): typeof fetch {
  return (async (url: string | URL) => {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body), url: String(url) } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Captura método/headers/body/URL da última chamada — usado pelos testes de
 * `addSite`/`submitFeed` que verificam a mecânica POST (#5621, GET dava 405). */
function fakeFetchCapture(body: unknown = {}, ok = true, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
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

describe("shouldCallAddSite (#5623 — AddSite não é idempotente, nunca chamar em host já verificado)", () => {
  it("host ausente -> true (precisa cadastrar)", () => {
    assert.equal(shouldCallAddSite([], "https://livros.diar.ia.br"), true);
  });

  it("host presente mas não verificado -> true (precisa completar verificação)", () => {
    const sites = [{ url: "https://livros.diar.ia.br/", verified: false }];
    assert.equal(shouldCallAddSite(sites, "https://livros.diar.ia.br"), true);
  });

  it("host presente e verified: null -> true (não inventa 'já verificado' sem confirmação)", () => {
    const sites = [{ url: "https://livros.diar.ia.br/", verified: null }];
    assert.equal(shouldCallAddSite(sites, "https://livros.diar.ia.br"), true);
  });

  it("host presente e verificado -> false (chamar AddSite de novo resetaria a verificação, #5623)", () => {
    const sites = [{ url: "https://livros.diar.ia.br/", verified: true }];
    assert.equal(shouldCallAddSite(sites, "https://livros.diar.ia.br"), false);
  });

  it("tolerante a barra final e case, mesma disciplina de isSiteRegistered", () => {
    const sites = [{ url: "https://LIVROS.diar.ia.br/", verified: true }];
    assert.equal(shouldCallAddSite(sites, "https://livros.diar.ia.br"), false);
  });
});

describe("addSite / getUserSites / submitFeed (#5621) — fetch sempre mockado", () => {
  it("addSite retorna o status HTTP cru (202 não é tratado como sucesso aqui — o CALLER que decide)", async () => {
    const fetchStub = fakeFetchJson({}, true, 202);
    const status = await addSite("https://livros.diar.ia.br", "KEY", fetchStub);
    assert.equal(status, 202);
  });

  it("addSite faz POST com Content-Type: application/json e siteUrl no corpo (#5621 — GET puro dava 405)", async () => {
    const { fetchImpl, calls } = fakeFetchCapture({}, true, 200);
    await addSite("https://livros.diar.ia.br", "KEY", fetchImpl);
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)?.["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(init?.body)), { siteUrl: "https://livros.diar.ia.br" });
    // apikey continua como query param — auth do BWT não muda entre GET/POST.
    assert.match(url, /\/AddSite\?apikey=KEY/);
    // siteUrl NÃO vai mais na query string (foi pro corpo).
    assert.doesNotMatch(url, /siteUrl=/);
  });

  it("getUserSites faz o round-trip parse", async () => {
    const fetchStub = fakeFetchJson({ d: [{ Url: "https://diar.ia.br/", IsVerified: true }] });
    const sites = await getUserSites("KEY", fetchStub);
    assert.deepEqual(sites, [{ url: "https://diar.ia.br/", verified: true }]);
  });

  it("submitFeed faz POST com siteUrl + feedUrl no corpo (não SubmitSitemap, #5621 — GET dava 405)", async () => {
    const { fetchImpl, calls } = fakeFetchCapture({}, true, 200);
    await submitFeed("https://livros.diar.ia.br", "https://livros.diar.ia.br/sitemap.xml", "KEY", fetchImpl);
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.match(url, /\/SubmitFeed\?apikey=KEY/);
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)?.["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      siteUrl: "https://livros.diar.ia.br",
      feedUrl: "https://livros.diar.ia.br/sitemap.xml",
    });
  });

  it("submitFeed lança com o corpo quando a resposta não é ok", async () => {
    const { fetchImpl } = fakeFetchCapture({ error: "quota" }, false, 500);
    await assert.rejects(
      () => submitFeed("https://livros.diar.ia.br", "https://livros.diar.ia.br/sitemap.xml", "KEY", fetchImpl),
      /Bing WMT SubmitFeed 500/,
    );
  });

  it("resposta não-ok lança com o corpo (mesma disciplina de erro do bing-pull.ts irmão)", async () => {
    const fetchStub = fakeFetchJson({ error: "quota" }, false, 500);
    await assert.rejects(() => getUserSites("KEY", fetchStub), /Bing WMT GetUserSites 500/);
  });
});
