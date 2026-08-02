/**
 * test/reativar-worker-4476.test.ts (#4476 item 3)
 *
 * Worker `reativar` — link de confirmação personalizado (merge tag
 * `?email={{ contact.EMAIL }}`, sem assinatura HMAC — mesmo padrão do link
 * de voto pós-#1186). Cobre: parse/validação do `?email=`, a chamada de
 * ativação (`reactivate_existing: true`) com fetch mockado, e o handler
 * fim-a-fim.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEmailParam,
  activateSubscription,
  handleConfirm,
  renderSuccessPage,
  renderMissingEmailPage,
  renderInvalidEmailPage,
  renderErrorPage,
  renderNotConfirmedPage,
  type Env,
} from "../workers/reativar/src/index.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("parseEmailParam — validação pura (#4476 item 3)", () => {
  it("email bem-formado → ok, normalizado (lowercase/trim)", () => {
    const url = new URL("https://reativar.diaria.workers.dev/?email=%20Foo%40Bar.COM%20");
    const parsed = parseEmailParam(url);
    assert.deepEqual(parsed, { ok: true, email: "foo@bar.com" });
  });

  it("param ausente → missing_email", () => {
    const url = new URL("https://reativar.diaria.workers.dev/");
    assert.deepEqual(parseEmailParam(url), { ok: false, error: "missing_email" });
  });

  it("param vazio → missing_email", () => {
    const url = new URL("https://reativar.diaria.workers.dev/?email=");
    assert.deepEqual(parseEmailParam(url), { ok: false, error: "missing_email" });
  });

  it("email malformado (sem @) → invalid_email", () => {
    const url = new URL("https://reativar.diaria.workers.dev/?email=naoehemail");
    assert.deepEqual(parseEmailParam(url), { ok: false, error: "invalid_email" });
  });

  it("email malformado (sem domínio) → invalid_email", () => {
    const url = new URL("https://reativar.diaria.workers.dev/?email=a%40b");
    assert.deepEqual(parseEmailParam(url), { ok: false, error: "invalid_email" });
  });

  it("merge tag NÃO substituída (Brevo falhou ao interpolar, {{ contact.EMAIL }} literal) → invalid_email", () => {
    const url = new URL("https://reativar.diaria.workers.dev/?email=" + encodeURIComponent("{{ contact.EMAIL }}"));
    assert.deepEqual(parseEmailParam(url), { ok: false, error: "invalid_email" });
  });
});

describe("activateSubscription — POST reactivate_existing:true (#4476 item 3)", () => {
  it("BEEHIIV_API_KEY/PUBLICATION_ID ausentes → not_configured, 503, sem chamar fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonRes(200, {});
    }) as typeof fetch;
    const result = await activateSubscription({}, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: false, status: 503, reason: "not_configured" });
    assert.equal(called, false);
  });

  it("sucesso (status active) → POST com o payload exato + beehiivStatus extraído da resposta", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    let capturedAuth = "";
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init!.body as string);
      capturedAuth = (init!.headers as Record<string, string>).Authorization;
      return jsonRes(200, { data: { id: "sub_1", status: "active" } });
    }) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key123", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 200, beehiivStatus: "active" });
    assert.equal(capturedUrl, "https://api.beehiiv.com/v2/publications/pub_1/subscriptions");
    assert.deepEqual(capturedBody, { email: "a@b.com", reactivate_existing: true, send_welcome_email: false });
    assert.equal(capturedAuth, "Bearer key123");
  });

  it('#4476 achado do teste ao vivo: POST 2xx mas status:"invalid" → ok:true (HTTP), beehiivStatus:"invalid" (NÃO confirmado)', async () => {
    const fetchImpl = (async () => jsonRes(201, { data: { id: "sub_1", status: "invalid" } })) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 201, beehiivStatus: "invalid" });
  });

  it("corpo da resposta sem data.status (ou não-JSON) → ok:true, beehiivStatus:null (nunca lança)", async () => {
    const fetchImpl = (async () => new Response("", { status: 200 })) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 200, beehiivStatus: null });
  });

  it("BEEHIIV_API_URL override (teste) → usa a base customizada", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url);
      return jsonRes(200, { data: { status: "active" } });
    }) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1", BEEHIIV_API_URL: "https://mock.local/v2" };
    await activateSubscription(env, "a@b.com", fetchImpl);
    assert.equal(capturedUrl, "https://mock.local/v2/publications/pub_1/subscriptions");
  });

  it("Beehiiv responde erro (4xx/5xx) → beehiiv_error, status propagado", async () => {
    const fetchImpl = (async () => new Response("conflict", { status: 409 })) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: false, status: 409, reason: "beehiiv_error" });
  });

  it("fetch lança (timeout/rede) → beehiiv_error, 502 (nunca propaga a exceção)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: false, status: 502, reason: "beehiiv_error" });
  });
});

describe("handleConfirm — fim-a-fim (#4476 item 3)", () => {
  it("email ausente → 400, página de link inválido (motivo: missing)", async () => {
    const url = new URL("https://reativar.diaria.workers.dev/");
    const res = await handleConfirm(url, {});
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.equal(html, renderMissingEmailPage());
    assert.equal(res.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
  });

  it("email malformado → 400, página de link inválido (motivo: invalid)", async () => {
    const url = new URL("https://reativar.diaria.workers.dev/?email=nao-eh-email");
    const res = await handleConfirm(url, {});
    assert.equal(res.status, 400);
    assert.equal(await res.text(), renderInvalidEmailPage());
  });

  it("ativação bem-sucedida (beehiivStatus:active) → 200, página de sucesso", async () => {
    const fetchImpl = (async () => jsonRes(200, { data: { status: "active" } })) as typeof fetch;
    const url = new URL("https://reativar.diaria.workers.dev/?email=a@b.com");
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const res = await handleConfirm(url, env, fetchImpl);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), renderSuccessPage());
  });

  it('#4476 achado do teste ao vivo: POST 2xx mas status:"invalid" → 200 com página "ainda não confirmado" (NUNCA a página de sucesso)', async () => {
    const fetchImpl = (async () => jsonRes(201, { data: { status: "invalid" } })) as typeof fetch;
    const url = new URL("https://reativar.diaria.workers.dev/?email=a@b.com");
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const res = await handleConfirm(url, env, fetchImpl);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), renderNotConfirmedPage());
  });

  it("secrets ausentes → 503, página de erro genérica (nunca vaza detalhe de config)", async () => {
    const url = new URL("https://reativar.diaria.workers.dev/?email=a@b.com");
    const res = await handleConfirm(url, {});
    assert.equal(res.status, 503);
    assert.equal(await res.text(), renderErrorPage());
  });

  it("Beehiiv falha → 502, página de erro genérica", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const url = new URL("https://reativar.diaria.workers.dev/?email=a@b.com");
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const res = await handleConfirm(url, env, fetchImpl);
    assert.equal(res.status, 502);
    assert.equal(await res.text(), renderErrorPage());
  });
});

describe("páginas HTML — conteúdo mínimo esperado (#4476 item 3)", () => {
  it("renderSuccessPage menciona confirmação", () => {
    assert.ok(renderSuccessPage().includes("confirmado"));
  });

  it("todas as páginas são HTML válido com <title> e charset", () => {
    for (const html of [renderSuccessPage(), renderMissingEmailPage(), renderInvalidEmailPage(), renderErrorPage(), renderNotConfirmedPage()]) {
      assert.ok(html.includes("<!doctype html>"));
      assert.ok(html.includes('charset="utf-8"'));
      assert.ok(html.includes("<title>"));
    }
  });
});
