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
import { buildAssinarHtml } from "../scripts/lib/site-assinar-page.ts";
import { signupFormScript } from "../scripts/lib/site-home-page.ts";
import { renderGatePage } from "../workers/cursos/src/gate-page.ts";
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

// ---- caminho Beehiiv (default de resolveBackend, achado 1 do fleet review
// pré-merge — a suíte acima só exercitava SUBSCRIBE_BACKEND: "kit") ----

function pollBeehiivEnv(overrides: Partial<PollEnv> = {}): PollEnv {
  return {
    POLL: makeMapKV() as unknown as PollEnv["POLL"],
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "https://diar.ia.br",
    // SUBSCRIBE_BACKEND ausente de propósito — resolveBackend cai em
    // "beehiiv" por default, e é esse caminho (maior tráfego em produção)
    // que ficava sem cobertura nenhuma pros campos novos.
    BEEHIIV_API_KEY: "test-beehiiv-key",
    BEEHIIV_PUBLICATION_ID: "pub_test",
    BEEHIIV_API_URL: "https://beehiiv.test/v2",
    BEEHIIV_ORIGEM_REFERRER_FIELD: "origem_referrer",
    BEEHIIV_ORIGEM_CLICKID_FIELD: "origem_click_id",
    ...overrides,
  };
}

function cursosBeehiivEnv(overrides: Partial<CursosEnv> = {}): CursosEnv {
  return {
    ASSETS: { fetch: async () => new Response("") } as unknown as CursosEnv["ASSETS"],
    CURSOS_SUBSCRIBERS: makeMapKV() as unknown as CursosEnv["CURSOS_SUBSCRIBERS"],
    COOKIE_HMAC_SECRET: "cookie-secret",
    // SUBSCRIBE_BACKEND ausente — mesmo default beehiiv de resolveBackend.
    BEEHIIV_API_KEY: "test-beehiiv-key",
    BEEHIIV_PUBLICATION_ID: "pub_test",
    BEEHIIV_API_URL: "https://beehiiv.test/v2",
    BEEHIIV_ORIGEM_REFERRER_FIELD: "origem_referrer",
    BEEHIIV_ORIGEM_CLICKID_FIELD: "origem_click_id",
    ...overrides,
  };
}

describe("subscribeToBeehiiv (worker poll) — origem_referrer/origem_click_id via custom_fields (#8003, achado 1 do fleet review)", () => {
  it("env configurado + referrer/click_id presentes → custom_fields recebe os 2 campos (array-append), triplo UTM intacto", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleJogarSubscribe(
      subReq({ email: "a@b.com", optin: true, source: "livros-hero", referrer: "https://google.com/search", click_id: "gclid:abc123" }),
      pollBeehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.custom_fields, [
      { name: "origem_referrer", value: "https://google.com/search" },
      { name: "origem_click_id", value: "gclid:abc123" },
    ]);
    // triplo UTM/referring_site continuam os do source resolvido — nunca
    // sobrescritos pelos campos novos.
    assert.equal(body.utm_source, "livros");
    assert.equal(body.referring_site, "livros-inline-hero");
  });

  it("sem env configurado → custom_fields nunca aparece, mesmo com referrer/click_id presentes", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleJogarSubscribe(
      subReq({ email: "b@b.com", optin: true, source: "jogar", referrer: "https://google.com", click_id: "gclid:abc" }),
      pollBeehiivEnv({ BEEHIIV_ORIGEM_REFERRER_FIELD: undefined, BEEHIIV_ORIGEM_CLICKID_FIELD: undefined }),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.custom_fields, undefined);
  });

  it("env configurado, mas sem referrer/click_id no body → custom_fields nunca aparece", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleJogarSubscribe(
      subReq({ email: "c@b.com", optin: true, source: "jogar" }),
      pollBeehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.custom_fields, undefined);
  });
});

describe("subscribeToBeehiiv (worker cursos) — mesmo invariante, mecanismo próprio (#8003, achado 1 do fleet review)", () => {
  it("handleGateSubscribe: referrer/click_id presentes + env configurado → custom_fields gravado (array-append)", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleGateSubscribe(
      gateReq({ email: "a@b.com", optin: true, referrer: "https://bing.com", click_id: "msclkid:z9" }),
      cursosBeehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.custom_fields, [
      { name: "origem_referrer", value: "https://bing.com" },
      { name: "origem_click_id", value: "msclkid:z9" },
    ]);
  });

  it("sem env configurado → custom_fields nunca aparece", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleGateSubscribe(
      gateReq({ email: "b@b.com", optin: true, referrer: "https://bing.com", click_id: "msclkid:z9" }),
      cursosBeehiivEnv({ BEEHIIV_ORIGEM_REFERRER_FIELD: undefined, BEEHIIV_ORIGEM_CLICKID_FIELD: undefined }),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.custom_fields, undefined);
  });

  it("sem referrer/click_id no body → custom_fields nunca aparece, mesmo com env configurado", async () => {
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleGateSubscribe(gateReq({ email: "c@b.com", optin: true }), cursosBeehiivEnv(), { fetchImpl: fetchMock });
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.custom_fields, undefined);
  });
});

// ---- truncamento do worker cursos ponta a ponta (#8003, achado 2 do fleet
// review — diferente do poll, que trunca dentro de validateSubscribeInput,
// o cursos trunca manualmente dentro de handleGateSubscribe) ----

describe("handleGateSubscribe (worker cursos) — trunca referrer/click_id em SUBSCRIBE_CLIENT_ORIGIN_MAX (#8003, achado 2 do fleet review)", () => {
  it("referrer/click_id >300 chars chegam truncados em 300 no corpo enviado ao ESP", async () => {
    const longReferrer = "https://example.com/" + "a".repeat(400);
    const longClickId = "gclid:" + "b".repeat(400);
    const fetchMock = makeFetchMock(200, { data: { status: "active" } });
    const res = await handleGateSubscribe(
      gateReq({ email: "trunc@b.com", optin: true, referrer: longReferrer, click_id: longClickId }),
      cursosKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields.origem_referrer.length, CURSOS_SUBSCRIBE_CLIENT_ORIGIN_MAX);
    assert.equal(body.fields.origem_click_id.length, CURSOS_SUBSCRIBE_CLIENT_ORIGIN_MAX);
    assert.equal(body.fields.origem_referrer, longReferrer.slice(0, CURSOS_SUBSCRIBE_CLIENT_ORIGIN_MAX));
    assert.equal(body.fields.origem_click_id, longClickId.slice(0, CURSOS_SUBSCRIBE_CLIENT_ORIGIN_MAX));
  });
});

// ---- drift entre os 4 pontos de emissão de JS do sinal de origem (#8003,
// achado 3 do fleet review — clientOriginSignalPayloadFieldsJs() só é
// reusado por build-livros-page.ts/curadoria-page.ts; site-assinar-page.ts,
// site-home-page.ts e gate-page.ts duplicam a lógica à mão) ----

describe("drift do sinal de origem entre os 4 pontos de emissão de JS (#8003, achado 3 do fleet review)", () => {
  const canonical = clientOriginSignalPayloadFieldsJs();

  it("o fragmento canônico tem o cap 300 e a precedência gclid > fbclid > msclkid — sanity do próprio fixture do teste", () => {
    assert.match(canonical, /\.slice\(0, 300\)/);
    const gclidIdx = canonical.indexOf("gclid");
    const fbclidIdx = canonical.indexOf("fbclid");
    const msclkidIdx = canonical.indexOf("msclkid");
    assert.ok(gclidIdx >= 0 && fbclidIdx > gclidIdx && msclkidIdx > fbclidIdx);
  });

  for (const [label, renderHtml] of [
    ["site-assinar-page.ts (apex, #6427)", () => buildAssinarHtml()],
    ["site-home-page.ts (home inline, #6976)", () => signupFormScript()],
    ["workers/cursos/src/gate-page.ts (#4052)", () => renderGatePage()],
  ] as const) {
    it(`${label}: mesmo cap (300) e mesma precedência gclid > fbclid > msclkid que clientOriginSignalPayloadFieldsJs()`, () => {
      const html = renderHtml();
      // Mesmo cap de tamanho do referrer capturado no cliente — uma cópia
      // que mudasse só este número (ex: 500) divergiria em silêncio da
      // versão canônica sem nenhum teste acusando.
      assert.match(html, /document\.referrer[^)]*\)\.slice\(0, 300\)/, `${label}: cap de referrer divergente de 300`);
      // Mesma precedência de click ID — gclid testado primeiro, depois
      // fbclid, depois msclkid (ordem que decide qual provedor "ganha"
      // quando mais de 1 parâmetro está presente na URL).
      const gclidIdx = html.indexOf("gclid:");
      const fbclidIdx = html.indexOf("fbclid:");
      const msclkidIdx = html.indexOf("msclkid:");
      assert.ok(gclidIdx >= 0, `${label}: gclid ausente`);
      assert.ok(fbclidIdx > gclidIdx, `${label}: fbclid não vem depois de gclid`);
      assert.ok(msclkidIdx > fbclidIdx, `${label}: msclkid não vem depois de fbclid`);
    });
  }
});
