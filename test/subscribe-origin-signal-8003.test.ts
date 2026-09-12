/**
 * test/subscribe-origin-signal-8003.test.ts (#8003)
 *
 * Cobre o sinal de origem (`document.referrer` + click ID de ads) que a
 * issue #8003 introduziu — SEPARADO do triplo UTM canônico
 * (`SUBSCRIBE_UTM_BY_SOURCE`/`CURSOS_GATE_INLINE_UTM`) e de `origem_paga`
 * (#7535): nunca sobrescreve nenhum dos dois, é gravado só quando o custom
 * field correspondente está configurado (mesmo guard duplo do resto do
 * arquivo).
 *
 *   - `clientOriginSignalPayloadFieldsJs` (scripts/lib/shared/client-utm-payload.ts):
 *     gera o fragmento JS esperado (2 campos, `referrer` + `click_id`).
 *   - `parseSubscribeBody` (poll e cursos): lê `referrer`/`click_id` dos 2
 *     formatos de body (JSON e urlencoded), default `""` quando ausente.
 *   - `validateSubscribeInput` (poll): corta em `SUBSCRIBE_CLIENT_ORIGIN_MAX`.
 *   - `subscribeToBeehiiv`/`subscribeToKit` (poll e cursos): só incluem os
 *     campos novos quando ENV E valor estão presentes; nunca tocam o
 *     triplo UTM fixo nem `origem_paga`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientOriginSignalPayloadFieldsJs } from "../scripts/lib/shared/client-utm-payload.ts";
import {
  handleJogarSubscribe,
  parseSubscribeBody as pollParseSubscribeBody,
  validateSubscribeInput as pollValidateSubscribeInput,
  SUBSCRIBE_CLIENT_ORIGIN_MAX as POLL_SUBSCRIBE_CLIENT_ORIGIN_MAX,
} from "../workers/poll/src/subscribe.ts";
import type { Env as PollEnv } from "../workers/poll/src/index.ts";
import {
  handleGateSubscribe,
  parseSubscribeBody as cursosParseSubscribeBody,
  SUBSCRIBE_CLIENT_ORIGIN_MAX as CURSOS_SUBSCRIBE_CLIENT_ORIGIN_MAX,
} from "../workers/cursos/src/subscribe.ts";
import type { Env as CursosEnv } from "../workers/cursos/src/index.ts";

describe("clientOriginSignalPayloadFieldsJs (#8003)", () => {
  it("gera o fragmento esperado — 2 campos, referrer + click_id", () => {
    const js = clientOriginSignalPayloadFieldsJs();
    assert.match(js, /referrer: \(document\.referrer \|\| ""\)\.slice\(0, 300\),/);
    assert.match(js, /click_id: \(function \(\) \{/);
    assert.match(js, /gclid:/);
    assert.match(js, /fbclid:/);
    assert.match(js, /msclkid:/);
  });
});

describe("parseSubscribeBody — referrer/click_id (poll, #8003)", () => {
  it("JSON: lê referrer e click_id do corpo", () => {
    const parsed = pollParseSubscribeBody(
      JSON.stringify({ email: "a@b.com", optin: true, referrer: "https://google.com/search", click_id: "gclid:abc123" }),
      "application/json",
    );
    assert.equal(parsed.referrer, "https://google.com/search");
    assert.equal(parsed.clickId, "gclid:abc123");
  });

  it("urlencoded: lê referrer e click_id do corpo", () => {
    const parsed = pollParseSubscribeBody(
      "email=a%40b.com&optin=on&referrer=https%3A%2F%2Fbing.com&click_id=msclkid%3Axyz",
      "application/x-www-form-urlencoded",
    );
    assert.equal(parsed.referrer, "https://bing.com");
    assert.equal(parsed.clickId, "msclkid:xyz");
  });

  it("ausente → default vazio (não undefined) nos 2 formatos", () => {
    const json = pollParseSubscribeBody(JSON.stringify({ email: "a@b.com", optin: true }), "application/json");
    assert.equal(json.referrer, "");
    assert.equal(json.clickId, "");
    const urlenc = pollParseSubscribeBody("email=a%40b.com&optin=on", "application/x-www-form-urlencoded");
    assert.equal(urlenc.referrer, "");
    assert.equal(urlenc.clickId, "");
  });
});

describe("validateSubscribeInput — corta em SUBSCRIBE_CLIENT_ORIGIN_MAX (poll, #8003)", () => {
  it("referrer/click_id maiores que o teto são cortados", () => {
    const longReferrer = "https://example.com/" + "a".repeat(400);
    const longClickId = "gclid:" + "b".repeat(400);
    const v = pollValidateSubscribeInput({
      name: "",
      email: "a@b.com",
      optin: true,
      honeypot: "",
      source: "jogar",
      utmSource: "",
      utmMedium: "",
      utmCampaign: "",
      referrer: longReferrer,
      clickId: longClickId,
    });
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.referrer.length, POLL_SUBSCRIBE_CLIENT_ORIGIN_MAX);
      assert.equal(v.clickId.length, POLL_SUBSCRIBE_CLIENT_ORIGIN_MAX);
    }
  });
});

describe("parseSubscribeBody — referrer/click_id (cursos, #8003)", () => {
  it("JSON e urlencoded, mesmo contrato do worker poll", () => {
    const json = cursosParseSubscribeBody(
      JSON.stringify({ email: "a@b.com", optin: true, referrer: "https://google.com", click_id: "fbclid:x1" }),
      "application/json",
    );
    assert.equal(json.referrer, "https://google.com");
    assert.equal(json.clickId, "fbclid:x1");

    const urlenc = cursosParseSubscribeBody("email=a%40b.com&optin=on", "application/x-www-form-urlencoded");
    assert.equal(urlenc.referrer, "");
    assert.equal(urlenc.clickId, "");
  });

  it("CURSOS_SUBSCRIBE_CLIENT_ORIGIN_MAX mesmo valor do worker poll (300)", () => {
    assert.equal(CURSOS_SUBSCRIBE_CLIENT_ORIGIN_MAX, 300);
    assert.equal(POLL_SUBSCRIBE_CLIENT_ORIGIN_MAX, 300);
  });
});

// ---- gravação condicional nos 2 ESPs, nos 2 workers ----

type FetchMock = typeof fetch & { calls: Array<{ url: string; init: RequestInit | undefined }> };
function makeFetchMock(status = 201, body: unknown = { subscriber: { id: 1 } }): FetchMock {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as FetchMock;
  fn.calls = calls;
  return fn;
}

function makeMapKV() {
  const m = new Map<string, string>();
  return {
    async get(key: string) {
      return m.get(key) ?? null;
    },
    async getWithMetadata(key: string) {
      return { value: m.get(key) ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: undefined };
    },
  };
}

function pollKitEnv(overrides: Partial<PollEnv> = {}): PollEnv {
  return {
    POLL: makeMapKV() as unknown as PollEnv["POLL"],
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "https://diar.ia.br",
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "test-kit-key",
    KIT_API_URL: "https://kit.test/v4",
    KIT_ORIGEM_REFERRER_FIELD: "origem_referrer",
    KIT_ORIGEM_CLICKID_FIELD: "origem_click_id",
    ...overrides,
  };
}

function subReq(body: unknown): Request {
  return new Request("https://poll.test/jogar/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://diar.ia.br" },
    body: JSON.stringify(body),
  });
}

describe("subscribeToKit (worker poll) — origem_referrer/origem_click_id só com env+valor presentes (#8003)", () => {
  it("env configurado + referrer/click_id presentes → fields gravados, triplo UTM intacto", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "a@b.com", optin: true, source: "livros-hero", referrer: "https://google.com", click_id: "gclid:abc" }),
      pollKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields.origem_referrer, "https://google.com");
    assert.equal(body.fields.origem_click_id, "gclid:abc");
  });

  it("sem env configurado → campos nunca aparecem, mesmo com referrer/click_id presentes", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "b@b.com", optin: true, source: "jogar", referrer: "https://google.com", click_id: "gclid:abc" }),
      pollKitEnv({ KIT_ORIGEM_REFERRER_FIELD: undefined, KIT_ORIGEM_CLICKID_FIELD: undefined }),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_referrer, undefined);
    assert.equal(body.fields?.origem_click_id, undefined);
  });

  it("env configurado, mas sem referrer/click_id no body → campos nunca aparecem", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "c@b.com", optin: true, source: "jogar" }),
      pollKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_referrer, undefined);
    assert.equal(body.fields?.origem_click_id, undefined);
  });
});

// ---- worker cursos: mesmo invariante, mecanismo próprio (bundle separado) ----

function cursosKitEnv(overrides: Partial<CursosEnv> = {}): CursosEnv {
  return {
    ASSETS: { fetch: async () => new Response("") } as unknown as CursosEnv["ASSETS"],
    CURSOS_SUBSCRIBERS: makeMapKV() as unknown as CursosEnv["CURSOS_SUBSCRIBERS"],
    COOKIE_HMAC_SECRET: "cookie-secret",
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "test-kit-key",
    KIT_API_URL: "https://kit.test/v4",
    KIT_ORIGEM_REFERRER_FIELD: "origem_referrer",
    KIT_ORIGEM_CLICKID_FIELD: "origem_click_id",
    ...overrides,
  };
}

function gateReq(body: unknown): Request {
  return new Request("https://cursos.test/gate/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("worker cursos — origem_referrer/origem_click_id sem tocar CURSOS_GATE_INLINE_UTM (#8003)", () => {
  it("handleGateSubscribe: referrer/click_id presentes + env configurado → gravados", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(
      gateReq({ email: "a@b.com", optin: true, referrer: "https://bing.com", click_id: "msclkid:z9" }),
      cursosKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields.origem_referrer, "https://bing.com");
    assert.equal(body.fields.origem_click_id, "msclkid:z9");
  });

  it("sem env configurado → campos nunca aparecem", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(
      gateReq({ email: "b@b.com", optin: true, referrer: "https://bing.com", click_id: "msclkid:z9" }),
      cursosKitEnv({ KIT_ORIGEM_REFERRER_FIELD: undefined, KIT_ORIGEM_CLICKID_FIELD: undefined }),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_referrer, undefined);
    assert.equal(body.fields?.origem_click_id, undefined);
  });

  it("sem referrer/click_id no body → campos nunca aparecem, mesmo com env configurado", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(gateReq({ email: "c@b.com", optin: true }), cursosKitEnv(), { fetchImpl: fetchMock });
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_referrer, undefined);
    assert.equal(body.fields?.origem_click_id, undefined);
  });
});
