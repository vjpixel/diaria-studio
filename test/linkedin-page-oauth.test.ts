/**
 * #8055 — OAuth do app da PÁGINA no LinkedIn: authorize URL com redirect e
 * escopos próprios, troca exigindo w_organization_social, descoberta da URN
 * por organizationAcls e escolha da página. HTTP sempre injetado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAuthorizeUrl, exchangeCodeForToken, type FetchFn } from "../scripts/lib/linkedin-personal.ts";
import {
  LINKEDIN_ORG_ACLS_URL,
  LINKEDIN_PAGE_REDIRECT_URI,
  LINKEDIN_PAGE_SCOPES,
  fetchAdministeredOrgUrns,
  pickOrgUrn,
} from "../scripts/lib/linkedin-page-oauth.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("sem resposta fake");
    return next();
  };
  return { fetchFn, calls };
}

const ORG = "urn:li:organization:110000001";

describe("OAuth da página (#8055)", () => {
  it("authorize URL usa o redirect 8767 e os escopos da página", () => {
    const u = new URL(buildAuthorizeUrl("cid", "st", { redirectUri: LINKEDIN_PAGE_REDIRECT_URI, scopes: LINKEDIN_PAGE_SCOPES }));
    assert.equal(LINKEDIN_PAGE_REDIRECT_URI, "http://localhost:8767/linkedin/page-callback");
    assert.equal(u.searchParams.get("redirect_uri"), LINKEDIN_PAGE_REDIRECT_URI);
    assert.equal(u.searchParams.get("scope"), "w_organization_social r_organization_social rw_organization_admin");
  });

  it("sem opts, a authorize URL segue sendo a do app pessoal", () => {
    const u = new URL(buildAuthorizeUrl("cid", "st"));
    assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:8766/linkedin/callback");
    assert.equal(u.searchParams.get("scope"), "openid profile w_member_social");
  });

  it("troca de código exige w_organization_social e manda o redirect da página", async () => {
    const ok = fakeFetch([() => json({ access_token: "T", expires_in: 5184000, scope: "r_organization_social,w_organization_social,rw_organization_admin" })]);
    const t = await exchangeCodeForToken(ok.fetchFn, {
      code: "c",
      clientId: "i",
      clientSecret: "s",
      redirectUri: LINKEDIN_PAGE_REDIRECT_URI,
      requiredScope: "w_organization_social",
    });
    assert.equal(t.accessToken, "T");
    assert.match(String(ok.calls[0].init?.body), /redirect_uri=http%3A%2F%2Flocalhost%3A8767%2Flinkedin%2Fpage-callback/);

    const semEscopo = fakeFetch([() => json({ access_token: "T", expires_in: 1, scope: "r_organization_social" })]);
    await assert.rejects(
      exchangeCodeForToken(semEscopo.fetchFn, { code: "c", clientId: "i", clientSecret: "s", requiredScope: "w_organization_social" }),
      /SEM w_organization_social/,
    );
  });

  it("organizationAcls: extrai e deduplica as URNs administradas, com headers REST", async () => {
    const f = fakeFetch([
      () => json({ elements: [{ organization: ORG }, { organization: ORG }, { organization: "lixo" }, { organization: "urn:li:organization:2" }] }),
    ]);
    assert.deepEqual(await fetchAdministeredOrgUrns(f.fetchFn, "T", "202609"), [ORG, "urn:li:organization:2"]);
    assert.deepEqual(await fetchAdministeredOrgUrns(fakeFetch([() => json({})]).fetchFn, "T", "202609"), []);
    assert.equal(f.calls[0].url, LINKEDIN_ORG_ACLS_URL);
    const h = f.calls[0].init?.headers as Record<string, string>;
    assert.equal(h["LinkedIn-Version"], "202609");
    assert.equal(h["X-Restli-Protocol-Version"], "2.0.0");
  });

  it("organizationAcls: HTTP de erro e corpo não-JSON lançam", async () => {
    await assert.rejects(fetchAdministeredOrgUrns(fakeFetch([() => json({}, 403)]).fetchFn, "T", "202609"), /HTTP 403/);
    // 403 com corpo HTML ainda aponta o escopo, não "não-JSON"; e nunca ecoa o token.
    const html403 = fakeFetch([() => new Response("<html>", { status: 403 })]);
    await assert.rejects(fetchAdministeredOrgUrns(html403.fetchFn, "SEGREDO", "202609"), (e: Error) => /rw_organization_admin/.test(e.message) && !e.message.includes("SEGREDO"));
    const html200 = fakeFetch([() => new Response("<html>", { status: 200 })]);
    await assert.rejects(fetchAdministeredOrgUrns(html200.fetchFn, "T", "202609"), /não-JSON/);
  });

  it("pickOrgUrn: única página decide sozinha; 0 ou várias exigem ação; --org é validado", () => {
    assert.deepEqual(pickOrgUrn([ORG], undefined), { ok: true, urn: ORG });
    assert.equal(pickOrgUrn([], undefined).ok, false);
    const varias = pickOrgUrn([ORG, "urn:li:organization:2"], undefined);
    assert.equal(varias.ok, false);
    assert.match((varias as { reason: string }).reason, /--org/);
    assert.deepEqual(pickOrgUrn([ORG, "urn:li:organization:2"], "urn:li:organization:2"), { ok: true, urn: "urn:li:organization:2" });
    assert.equal(pickOrgUrn([ORG], "urn:li:organization:9").ok, false);
    assert.equal(pickOrgUrn([ORG], "123").ok, false);
    // conta sem página: --org não é aceito às cegas
    assert.equal(pickOrgUrn([], ORG).ok, false);
  });

  it("pickOrgUrn: ACL indisponível (null) só segue com --org válido", () => {
    assert.deepEqual(pickOrgUrn(null, ORG), { ok: true, urn: ORG });
    assert.equal(pickOrgUrn(null, undefined).ok, false);
    assert.equal(pickOrgUrn(null, "123").ok, false);
  });
});
