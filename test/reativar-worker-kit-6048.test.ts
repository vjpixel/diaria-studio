/**
 * test/reativar-worker-kit-6048.test.ts (#6048 Fase 2/2)
 *
 * Equivalente Kit de `activateSubscription` no worker `reativar` — mesmo
 * padrão de `test/poll-jogar-inline-signup-kit-6048.test.ts` (Fase 1,
 * #6082). Cobre `activateSubscriptionKit` (novo, upsert direto — sem
 * DELETE+CREATE, ver docstring do módulo) e a seleção de backend
 * (`env.SUBSCRIBE_BACKEND`) em `handleConfirm`. Mock de fetch, sem rede real
 * (#633).
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  activateSubscriptionKit,
  handleConfirm,
  type Env,
} from "../workers/reativar/src/index.ts";
import { BREVO_DIARIA_REATIVAR_CLIQUE_UTM } from "../scripts/lib/shared/utm-registry.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routedFetch(handlers: {
  get?: () => Response | Promise<Response>;
  post?: (body: unknown) => Response | Promise<Response>;
}): { fetchImpl: typeof fetch; calls: { method: string; url: string; body?: unknown }[] } {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url: String(url), body });
    if (method === "POST") return handlers.post ? handlers.post(body) : jsonRes(200, {});
    return handlers.get ? handlers.get() : jsonRes(200, { subscribers: [] });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const kitEnv = (over: Partial<Env> = {}): Env => ({
  SUBSCRIBE_BACKEND: "kit",
  KIT_API_KEY: "test-kit-key",
  KIT_API_URL: "https://kit.test/v4",
  ...over,
});

describe("activateSubscriptionKit (#6048 Fase 2/2)", () => {
  it("KIT_API_KEY ausente → not_configured (503), sem tocar a rede", async () => {
    const { fetchImpl, calls } = routedFetch({});
    const r = await activateSubscriptionKit({}, "a@b.com", fetchImpl);
    assert.deepEqual(r, { ok: false, status: 503, reason: "not_configured" });
    assert.equal(calls.length, 0);
  });

  it("já ativo (GET traz state:active) → idempotente, NUNCA faz POST", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { subscribers: [{ id: 1, state: "active" }] }),
    });
    const r = await activateSubscriptionKit(kitEnv(), "a@b.com", fetchImpl);
    assert.deepEqual(r, { ok: true, status: 200, beehiivStatus: "active" });
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });

  it("já ativo + KIT_ORIGEM_CADASTRO_FIELD configurado → marcador NÃO é escrito (early-return pula o POST), mas emite log estruturado (achado do fleet review #6127)", async () => {
    const { fetchImpl } = routedFetch({
      get: () => jsonRes(200, { subscribers: [{ id: 1, state: "active" }] }),
    });
    const warnMock = mock.method(console, "warn", () => {});
    try {
      const env = kitEnv({ KIT_ORIGEM_CADASTRO_FIELD: "origem_cadastro" });
      const r = await activateSubscriptionKit(env, "a@b.com", fetchImpl);
      assert.deepEqual(r, { ok: true, status: 200, beehiivStatus: "active" });
      assert.equal(warnMock.mock.callCount(), 1);
      const logged = JSON.parse(String(warnMock.mock.calls[0].arguments[0]));
      assert.equal(logged.event, "reativar_kit_marker_not_backfilled");
    } finally {
      warnMock.mock.restore();
    }
  });

  it("já ativo SEM KIT_ORIGEM_CADASTRO_FIELD configurado → não emite o log (ruído evitado quando a var nem existe)", async () => {
    const { fetchImpl } = routedFetch({
      get: () => jsonRes(200, { subscribers: [{ id: 1, state: "active" }] }),
    });
    const warnMock = mock.method(console, "warn", () => {});
    try {
      await activateSubscriptionKit(kitEnv(), "a@b.com", fetchImpl);
      assert.equal(warnMock.mock.callCount(), 0);
    } finally {
      warnMock.mock.restore();
    }
  });

  it("não encontrado (GET: subscribers:[], nunca 404) → segue pro POST de upsert direto, SEM DELETE (achado ao vivo #6048: Kit é idempotente)", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(201, { subscriber: { id: 2, state: "active" } }),
    });
    const r = await activateSubscriptionKit(kitEnv(), "a@b.com", fetchImpl);
    assert.deepEqual(r, { ok: true, status: 201, beehiivStatus: "active" });
    assert.equal(calls.some((c) => c.method === "DELETE"), false, "Kit não precisa de DELETE — idempotente por e-mail");
    const post = calls.find((c) => c.method === "POST");
    assert.ok(post);
    const body = post!.body as Record<string, unknown>;
    assert.equal(body.email_address, "a@b.com");
    assert.equal(body.state, "active");
  });

  it("registro existente não-active (ex: cancelled) → também upsert direto via POST, sem DELETE", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { subscribers: [{ id: 5, state: "cancelled" }] }),
      post: () => jsonRes(200, { subscriber: { id: 5, state: "active" } }),
    });
    const r = await activateSubscriptionKit(kitEnv(), "a@b.com", fetchImpl);
    assert.equal(r.ok, true);
    assert.equal(calls.some((c) => c.method === "DELETE"), false);
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  });

  it("sem nenhum KIT_UTM_*_FIELD configurado: POST não manda fields (preserva atribuição original de graça — ver docstring do módulo)", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(201, { subscriber: { state: "active" } }),
    });
    await activateSubscriptionKit(kitEnv(), "a@b.com", fetchImpl);
    const post = calls.find((c) => c.method === "POST");
    const body = post!.body as Record<string, unknown>;
    assert.equal("fields" in body, false);
  });

  it("com KIT_UTM_*_FIELD configurados: POST manda fields com a UTM constante de reativação", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(201, { subscriber: { state: "active" } }),
    });
    const env = kitEnv({
      KIT_UTM_SOURCE_FIELD: "utm_source",
      KIT_UTM_MEDIUM_FIELD: "utm_medium",
      KIT_UTM_CAMPAIGN_FIELD: "utm_campaign",
      KIT_REFERRING_SITE_FIELD: "referring_site",
    });
    await activateSubscriptionKit(env, "a@b.com", fetchImpl);
    const post = calls.find((c) => c.method === "POST");
    const body = post!.body as Record<string, unknown>;
    assert.deepEqual(body.fields, {
      utm_source: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.source,
      utm_medium: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.medium,
      utm_campaign: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.campaign,
      referring_site: BREVO_DIARIA_REATIVAR_CLIQUE_UTM.referringSite,
    });
  });

  it("marcador de origem só vai em fields quando KIT_ORIGEM_CADASTRO_FIELD está configurado (#6048)", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(201, { subscriber: { state: "active" } }),
    });
    const env = kitEnv({ KIT_ORIGEM_CADASTRO_FIELD: "origem_cadastro" });
    await activateSubscriptionKit(env, "a@b.com", fetchImpl);
    const post = calls.find((c) => c.method === "POST");
    const body = post!.body as Record<string, unknown>;
    assert.deepEqual(body.fields, { origem_cadastro: "kit-nativo" });
  });

  it("guard de descadastro nativo pendente (#4538 item B) bloqueia mesmo no caminho Kit — mesmo guard backend-agnóstico (Brevo)", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
    });
    const env = kitEnv({
      BREVO_DIARIA_API_KEY: "brevo-key",
      BREVO_API_URL: "https://brevo.test/v3",
    });
    // BREVO_API_URL respondendo emailBlacklisted:true via um fetch composto —
    // reusa o mesmo mock roteado; a chamada pro Brevo bate no "get" branch
    // também (GET simples), então simulamos via um fetchImpl dedicado que
    // distingue por host.
    const dualFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("brevo.test")) return jsonRes(200, { emailBlacklisted: true });
      return fetchImpl(url, init);
    }) as typeof fetch;
    const r = await activateSubscriptionKit(env, "a@b.com", dualFetch);
    assert.deepEqual(r, { ok: true, status: 200, reason: "native_unsubscribe_pending" });
    assert.equal(calls.some((c) => c.method === "POST"), false, "não deveria ter chamado o Kit — bloqueado antes do upsert");
  });

  it("Kit responde erro no POST → beehiiv_error com o status", async () => {
    const { fetchImpl } = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(422, {}),
    });
    const r = await activateSubscriptionKit(kitEnv(), "a@b.com", fetchImpl);
    assert.deepEqual(r, { ok: false, status: 422, reason: "beehiiv_error" });
  });

  it("#6129 — Kit responde erro no POST → loga o CORPO da resposta (truncado), não só o status", async () => {
    const { fetchImpl } = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(422, { message: "custom field inválido" }),
    });
    const errorMock = mock.method(console, "error", () => {});
    try {
      const r = await activateSubscriptionKit(kitEnv(), "a@b.com", fetchImpl);
      assert.deepEqual(r, { ok: false, status: 422, reason: "beehiiv_error" });
      const call = errorMock.mock.calls.find((c) => {
        const logged = JSON.parse(String(c.arguments[0]));
        return logged.event === "reativar_kit_non_2xx" && logged.step === "create";
      });
      assert.ok(call, "esperava um log reativar_kit_non_2xx/create");
      const logged = JSON.parse(String(call!.arguments[0]));
      assert.match(logged.body, /custom field inválido/);
    } finally {
      errorMock.mock.restore();
    }
  });

  it("#6129 — Kit responde erro no GET (idempotência) → loga o CORPO da resposta, não só o status", async () => {
    const { fetchImpl } = routedFetch({
      get: () => jsonRes(401, { message: "invalid api key" }),
    });
    const errorMock = mock.method(console, "error", () => {});
    try {
      const r = await activateSubscriptionKit(kitEnv(), "a@b.com", fetchImpl);
      assert.deepEqual(r, { ok: false, status: 401, reason: "beehiiv_error" });
      const call = errorMock.mock.calls.find((c) => {
        const logged = JSON.parse(String(c.arguments[0]));
        return logged.event === "reativar_kit_non_2xx" && logged.step === "get";
      });
      assert.ok(call, "esperava um log reativar_kit_non_2xx/get");
      const logged = JSON.parse(String(call!.arguments[0]));
      assert.match(logged.body, /invalid api key/);
    } finally {
      errorMock.mock.restore();
    }
  });

  it("fetch que lança no GET → beehiiv_error, nunca propaga a exceção", async () => {
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const r = await activateSubscriptionKit(kitEnv(), "a@b.com", throwingFetch);
    assert.deepEqual(r, { ok: false, status: 502, reason: "beehiiv_error" });
  });
});

describe("handleConfirm — seleção de backend via env.SUBSCRIBE_BACKEND (#6048 Fase 2/2)", () => {
  it("SUBSCRIBE_BACKEND ausente: usa Beehiiv (default, regressão)", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(404, {}),
      post: () => jsonRes(201, { data: { status: "active" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "bk", BEEHIIV_PUBLICATION_ID: "pub" };
    const url = new URL("https://reativar.test/?email=a@b.com");
    const res = await handleConfirm(url, env, fetchImpl);
    assert.equal(res.status, 200);
    assert.ok(calls.some((c) => c.url.includes("beehiiv.com") || c.url.includes("api.beehiiv")), "deveria ter tocado a Beehiiv");
  });

  it('SUBSCRIBE_BACKEND: "kit" → chama o Kit, não a Beehiiv, e devolve a página de sucesso', async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { subscribers: [] }),
      post: () => jsonRes(201, { subscriber: { state: "active" } }),
    });
    const env = kitEnv();
    const url = new URL("https://reativar.test/?email=a@b.com");
    const res = await handleConfirm(url, env, fetchImpl);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /[Cc]onfirmad|[Ss]ucesso|ativad/, "deveria renderizar a página de sucesso");
    assert.ok(calls.every((c) => c.url.startsWith("https://kit.test")));
  });

  it('SUBSCRIBE_BACKEND: "kit" sem KIT_API_KEY → 503, igual ao caminho Beehiiv', async () => {
    const { fetchImpl } = routedFetch({});
    const env: Env = { SUBSCRIBE_BACKEND: "kit" };
    const url = new URL("https://reativar.test/?email=a@b.com");
    const res = await handleConfirm(url, env, fetchImpl);
    assert.equal(res.status, 503);
  });
});
