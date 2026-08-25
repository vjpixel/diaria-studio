/**
 * test/cursos-gate-subscribe-kit-6048.test.ts (#6048 Fase 2/2)
 *
 * Equivalente Kit de `subscribeToBeehiiv` no worker `cursos` — mesmo padrão
 * de `test/poll-jogar-inline-signup-kit-6048.test.ts` (Fase 1, #6082): cobre
 * `subscribeToKit` (novo) e a seleção de backend (`env.SUBSCRIBE_BACKEND`) em
 * `handleGateSubscribe`. Mock de fetch, sem rede real (#633).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleGateSubscribe, subscribeToKit } from "../workers/cursos/src/subscribe.ts";
import { CURSOS_GATE_INLINE_UTM } from "../scripts/lib/shared/utm-registry.ts";
import type { Env } from "../workers/cursos/src/index.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
  } as unknown as KVNamespace;
}

type FetchMock = typeof fetch & { calls: Array<{ url: string; init: RequestInit | undefined }> };
function makeFetchMock(status = 201): FetchMock {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ subscriber: { id: 1 } }), { status });
  }) as FetchMock;
  fn.calls = calls;
  return fn;
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
    CURSOS_SUBSCRIBERS: makeMapKV(),
    COOKIE_HMAC_SECRET: "cookie-secret",
    ...overrides,
  };
}

function kitEnv(overrides: Partial<Env> = {}): Env {
  return baseEnv({
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "test-kit-key",
    KIT_API_URL: "https://kit.test/v4",
    ...overrides,
  });
}

function gateReq(body: unknown): Request {
  return new Request("https://cursos.test/gate/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("subscribeToKit (cursos, #6048 Fase 2/2)", () => {
  it("KIT_API_KEY ausente → not_configured (503), sem tocar a rede", async () => {
    const fetchMock = makeFetchMock();
    const r = await subscribeToKit(baseEnv(), { name: "Ana", email: "a@b.com" }, fetchMock);
    assert.deepEqual(r, { ok: false, status: 503, reason: "not_configured" });
    assert.equal(fetchMock.calls.length, 0);
  });

  it("POSTa pra /subscribers com X-Kit-Api-Key + email_address + state:active", async () => {
    const fetchMock = makeFetchMock(201);
    const r = await subscribeToKit(kitEnv(), { name: "", email: "ana@example.com" }, fetchMock);
    assert.equal(r.ok, true);
    assert.equal(r.beehiivStatus, "active");
    assert.equal(fetchMock.calls.length, 1);
    const call = fetchMock.calls[0];
    assert.equal(call.url, "https://kit.test/v4/subscribers");
    assert.equal(call.init?.method, "POST");
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers["X-Kit-Api-Key"], "test-kit-key");
    const body = JSON.parse(String(call.init?.body));
    assert.equal(body.email_address, "ana@example.com");
    assert.equal(body.state, "active");
  });

  it("200 (upsert de e-mail já existente) também é sucesso — Kit é idempotente por e-mail", async () => {
    const fetchMock = makeFetchMock(200);
    const r = await subscribeToKit(kitEnv(), { name: "", email: "a@b.com" }, fetchMock);
    assert.deepEqual(r, { ok: true, status: 200, beehiivStatus: "active" });
  });

  it("sem nenhum KIT_*_FIELD configurado: body não tem fields (degrada com graça)", async () => {
    const fetchMock = makeFetchMock(201);
    await subscribeToKit(kitEnv(), { name: "Ana", email: "a@b.com" }, fetchMock);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal("fields" in body, false);
  });

  it("nome só vai em fields quando KIT_NAME_FIELD está configurado", async () => {
    const fetchMock = makeFetchMock(201);
    const env = kitEnv({ KIT_NAME_FIELD: "nome" });
    await subscribeToKit(env, { name: "Ana", email: "a@b.com" }, fetchMock);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.fields, { nome: "Ana" });
  });

  it("UTM/referring-site (constantes fixas de cursos, sem triplo por source) só vão em fields quando os respectivos KIT_*_FIELD estão configurados", async () => {
    const fetchMock = makeFetchMock(201);
    const env = kitEnv({
      KIT_UTM_SOURCE_FIELD: "utm_source",
      KIT_UTM_MEDIUM_FIELD: "utm_medium",
      KIT_UTM_CAMPAIGN_FIELD: "utm_campaign",
      KIT_REFERRING_SITE_FIELD: "referring_site",
    });
    await subscribeToKit(env, { name: "", email: "a@b.com" }, fetchMock);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.fields, {
      utm_source: CURSOS_GATE_INLINE_UTM.source,
      utm_medium: CURSOS_GATE_INLINE_UTM.medium,
      utm_campaign: CURSOS_GATE_INLINE_UTM.campaign,
      referring_site: "cursos-gate-inline",
    });
  });

  it("marcador de origem só vai em fields quando KIT_ORIGEM_CADASTRO_FIELD está configurado (#6048)", async () => {
    const fetchMock = makeFetchMock(201);
    const env = kitEnv({ KIT_ORIGEM_CADASTRO_FIELD: "origem_cadastro" });
    await subscribeToKit(env, { name: "", email: "a@b.com" }, fetchMock);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.fields, { origem_cadastro: "kit-nativo" });
  });

  it("Kit responde erro → beehiiv_error com o status (SubscribeResult compartilhado, sem reason dedicado)", async () => {
    const fetchMock = makeFetchMock(422);
    const r = await subscribeToKit(kitEnv(), { name: "", email: "a@b.com" }, fetchMock);
    assert.deepEqual(r, { ok: false, status: 422, reason: "beehiiv_error" });
  });

  it("fetch que lança → beehiiv_error, nunca propaga a exceção", async () => {
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const r = await subscribeToKit(kitEnv(), { name: "", email: "a@b.com" }, throwingFetch);
    assert.deepEqual(r, { ok: false, status: 502, reason: "beehiiv_error" });
  });
});

describe("handleGateSubscribe — seleção de backend via env.SUBSCRIBE_BACKEND (#6048 Fase 2/2)", () => {
  it("SUBSCRIBE_BACKEND ausente: usa Beehiiv (default, regressão)", async () => {
    const fetchMock = makeFetchMock(201);
    const env = baseEnv({ BEEHIIV_API_KEY: "bk", BEEHIIV_PUBLICATION_ID: "pub" });
    const res = await handleGateSubscribe(gateReq({ email: "a@b.com", optin: true }), env, { fetchImpl: fetchMock });
    assert.equal(res.status, 200);
    assert.match(fetchMock.calls[0].url, /beehiiv\.com/);
  });

  it('SUBSCRIBE_BACKEND: "kit" → chama o Kit, não a Beehiiv', async () => {
    const fetchMock = makeFetchMock(201);
    const env = kitEnv();
    const res = await handleGateSubscribe(gateReq({ email: "a@b.com", optin: true }), env, { fetchImpl: fetchMock });
    assert.equal(res.status, 200);
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, "https://kit.test/v4/subscribers");
  });

  it('SUBSCRIBE_BACKEND: "kit" sem KIT_API_KEY → 503 amigável (not_configured), igual ao caminho Beehiiv', async () => {
    const fetchMock = makeFetchMock(201);
    const env = baseEnv({ SUBSCRIBE_BACKEND: "kit" });
    const res = await handleGateSubscribe(gateReq({ email: "a@b.com", optin: true }), env, { fetchImpl: fetchMock });
    assert.equal(res.status, 503);
    assert.equal(fetchMock.calls.length, 0);
  });

  it('SUBSCRIBE_BACKEND: "kit" → sessão emitida CONFIRMADA (Kit sempre state:active, sem double opt-in pendente)', async () => {
    const fetchMock = makeFetchMock(201);
    const env = kitEnv();
    const res = await handleGateSubscribe(gateReq({ email: "a@b.com", optin: true }), env, { fetchImpl: fetchMock });
    const setCookie = res.headers.get("Set-Cookie");
    assert.ok(setCookie, "deveria emitir Set-Cookie");
  });
});
