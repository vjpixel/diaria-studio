/**
 * test/poll-jogar-inline-signup-kit-6048.test.ts (#6048)
 *
 * Equivalente Kit de `test/poll-jogar-inline-signup-3580.test.ts` — cobre
 * `subscribeToKit` (novo) e a seleção de backend (`env.SUBSCRIBE_BACKEND`)
 * em `handleJogarSubscribe`. Mesmo padrão de mock de fetch (sem rede real).
 *
 * #6340 (26/08/2026): o caso "POSTa pra /subscribers..." abaixo esperava
 * `state:"active"` — comportamento correto ANTES da decisão do editor de
 * double opt-in. Com `DOUBLE_OPT_IN_FLAG.enabledForWorkers` incluindo
 * `"poll"` (`optin-flag-6340.ts`), este mesmo funil ("jogar") passa a criar
 * `state:"inactive"` — não há exceção documentada em #6340 (nem nos
 * comentários) pro funil "jogar" especificamente; a flag é por WORKER, não
 * por source. Assertion atualizada; ver docstring do teste pro raciocínio
 * completo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleJogarSubscribe, subscribeViaConfiguredBackend } from "../workers/poll/src/subscribe.ts";
import type { Env } from "../workers/poll/src/index.ts";

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
  };
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

const baseEnv = (over: Partial<Env> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } =>
  ({
    POLL: makeMapKV(),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
    ...over,
  }) as Env & { POLL: ReturnType<typeof makeMapKV> };

const kitEnv = (poll = makeMapKV()): Env & { POLL: ReturnType<typeof makeMapKV> } =>
  ({
    POLL: poll,
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "test-kit-key",
    KIT_API_URL: "https://kit.test/v4",
  }) as Env & { POLL: ReturnType<typeof makeMapKV> };

function subReq(body: unknown, opts: { ip?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  return new Request("https://poll.test/jogar/subscribe", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("subscribeToKit (#6048)", () => {
  it("KIT_API_KEY ausente → not_configured (503), sem tocar a rede", async () => {
    const fetchMock = makeFetchMock();
    const r = await subscribeViaConfiguredBackend(baseEnv(), { name: "Ana", email: "a@b.com" }, fetchMock);
    assert.deepEqual(r, { ok: false, status: 503, reason: "not_configured" });
    assert.equal(fetchMock.calls.length, 0);
  });

  it("POSTa pra /subscribers com X-Kit-Api-Key + email_address + state:inactive (#6340)", async () => {
    // #6340 (26/08/2026, decisão do editor): "cadastro novo pelos funis passa
    // a ter double opt-in no Kit" — sem carve-out por source. O funil "jogar"
    // bate no MESMO endpoint (`/jogar/subscribe` → `subscribeToKit`) que
    // arquivo/hub/livros/etc, todos com o MESMO mecanismo de consentimento
    // (checkbox on-page, #5095) — não há base textual na issue #6340 (nem
    // nos comentários) pra tratar "jogar" como exceção. A flag
    // (`DOUBLE_OPT_IN_FLAG.enabledForWorkers`, `optin-flag-6340.ts`) é
    // deliberadamente por WORKER, não por source — este teste cobria
    // `state:active`, o comportamento ANTERIOR à decisão do editor; agora
    // cobre o novo default esperado pra todo cadastro via `poll`.
    const fetchMock = makeFetchMock(201);
    const r = await subscribeViaConfiguredBackend(kitEnv(), { name: "", email: "ana@example.com" }, fetchMock);
    assert.equal(r.ok, true);
    assert.equal(fetchMock.calls.length, 1);
    const call = fetchMock.calls[0];
    assert.equal(call.url, "https://kit.test/v4/subscribers");
    assert.equal(call.init?.method, "POST");
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers["X-Kit-Api-Key"], "test-kit-key");
    const body = JSON.parse(String(call.init?.body));
    assert.equal(body.email_address, "ana@example.com");
    assert.equal(body.state, "inactive", "#6340: double opt-in ativo pro worker poll — state:inactive até confirmação, Brevo entrega enquanto isso (ver PR do #6340)");
  });

  it("200 (upsert de e-mail já existente) também é sucesso — Kit é idempotente por e-mail (achado ao vivo #6048)", async () => {
    const fetchMock = makeFetchMock(200);
    const r = await subscribeViaConfiguredBackend(kitEnv(), { name: "", email: "a@b.com" }, fetchMock);
    assert.deepEqual(r, { ok: true, status: 200 });
  });

  it("sem nenhum KIT_*_FIELD configurado: body não tem fields (degrada com graça)", async () => {
    const fetchMock = makeFetchMock(201);
    await subscribeViaConfiguredBackend(kitEnv(), { name: "Ana", email: "a@b.com" }, fetchMock);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal("fields" in body, false);
  });

  it("nome só vai em fields quando KIT_NAME_FIELD está configurado", async () => {
    const fetchMock = makeFetchMock(201);
    const env = kitEnv();
    env.KIT_NAME_FIELD = "nome";
    await subscribeViaConfiguredBackend(env, { name: "Ana", email: "a@b.com" }, fetchMock);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.fields, { nome: "Ana" });
  });

  it("UTM/referring-site só vão em fields quando os respectivos KIT_*_FIELD estão configurados (achado ao vivo #6048: Kit não tem atribuição nativa)", async () => {
    const fetchMock = makeFetchMock(201);
    const env = kitEnv();
    env.KIT_UTM_SOURCE_FIELD = "utm_source";
    env.KIT_UTM_MEDIUM_FIELD = "utm_medium";
    env.KIT_UTM_CAMPAIGN_FIELD = "utm_campaign";
    env.KIT_REFERRING_SITE_FIELD = "referring_site";
    await subscribeViaConfiguredBackend(
      env,
      { name: "", email: "a@b.com" },
      fetchMock,
      { source: "eia-standalone", medium: "jogar-inline", campaign: "jogar-eia-inline", referringSite: "eia-jogar-inline" },
    );
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.fields, {
      utm_source: "eia-standalone",
      utm_medium: "jogar-inline",
      utm_campaign: "jogar-eia-inline",
      referring_site: "eia-jogar-inline",
    });
  });

  it("marcador de origem só vai em fields quando KIT_ORIGEM_CADASTRO_FIELD está configurado (#6048)", async () => {
    const fetchMock = makeFetchMock(201);
    const env = kitEnv();
    env.KIT_ORIGEM_CADASTRO_FIELD = "origem_cadastro";
    await subscribeViaConfiguredBackend(env, { name: "", email: "a@b.com" }, fetchMock);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.fields, { origem_cadastro: "kit-nativo" });
  });

  it("Kit responde erro → subscribe_error com o status (SubscribeResult compartilhado, sem reason dedicado)", async () => {
    const fetchMock = makeFetchMock(422);
    const r = await subscribeViaConfiguredBackend(kitEnv(), { name: "", email: "a@b.com" }, fetchMock);
    assert.deepEqual(r, { ok: false, status: 422, reason: "subscribe_error" });
  });

  it("Kit responde erro → loga status + corpo (achado ao vivo 25/08/2026: catch mudo escondeu KIT_API_KEY inválido)", async () => {
    const errorBody = JSON.stringify({ errors: ["The API key is invalid"] });
    const fetchMock = (async () => new Response(errorBody, { status: 401 })) as typeof fetch;
    const logged: string[] = [];
    const original = console.error;
    console.error = (msg: string) => logged.push(msg);
    try {
      await subscribeViaConfiguredBackend(kitEnv(), { name: "", email: "a@b.com" }, fetchMock);
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    assert.match(logged[0], /\[subscribeToKit\] Kit respondeu 401/);
    assert.match(logged[0], /API key is invalid/);
  });

  it("fetch lança exceção → loga a exceção (nunca fica silencioso)", async () => {
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const logged: string[] = [];
    const original = console.error;
    console.error = (msg: string) => logged.push(msg);
    try {
      const r = await subscribeViaConfiguredBackend(kitEnv(), { name: "", email: "a@b.com" }, throwingFetch);
      assert.deepEqual(r, { ok: false, status: 502, reason: "subscribe_error" });
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    assert.match(logged[0], /\[subscribeToKit\] fetch exception: Error: network down/);
  });

  it("passa um AbortSignal de timeout pro fetch — mesma defesa contra hang de subscribeToBeehiiv", async () => {
    const fetchMock = makeFetchMock(201);
    await subscribeViaConfiguredBackend(kitEnv(), { name: "", email: "a@b.com" }, fetchMock);
    const signal = fetchMock.calls[0].init?.signal;
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal!.aborted, false);
  });

  it("fetch que trava até o signal abortar → subscribe_error, nunca fica pendurado", async () => {
    const hangingFetch = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        (signal as AbortSignal).dispatchEvent(new Event("abort"));
      });
    }) as typeof fetch;
    const r = await subscribeViaConfiguredBackend(kitEnv(), { name: "", email: "a@b.com" }, hangingFetch);
    assert.deepEqual(r, { ok: false, status: 502, reason: "subscribe_error" });
  });
});

describe("handleJogarSubscribe — seleção de backend via env.SUBSCRIBE_BACKEND (#6048)", () => {
  it("SUBSCRIBE_BACKEND ausente: usa Beehiiv (default, regressão)", async () => {
    const fetchMock = makeFetchMock(201);
    const env = baseEnv({ BEEHIIV_API_KEY: "bk", BEEHIIV_PUBLICATION_ID: "pub" } as Partial<Env>);
    const res = await handleJogarSubscribe(subReq({ email: "a@b.com", optin: true, source: "jogar" }), env, { fetchImpl: fetchMock });
    assert.equal(res.status, 200);
    assert.match(fetchMock.calls[0].url, /beehiiv\.com/);
  });

  it('SUBSCRIBE_BACKEND: "kit" → chama o Kit, não a Beehiiv', async () => {
    const fetchMock = makeFetchMock(201);
    const env = kitEnv();
    const res = await handleJogarSubscribe(subReq({ email: "a@b.com", optin: true, source: "jogar" }), env, { fetchImpl: fetchMock });
    assert.equal(res.status, 200);
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, "https://kit.test/v4/subscribers");
  });

  it('SUBSCRIBE_BACKEND: "kit" sem KIT_API_KEY → 503 amigável (not_configured), igual ao caminho Beehiiv', async () => {
    const fetchMock = makeFetchMock(201);
    const env = baseEnv({ SUBSCRIBE_BACKEND: "kit" } as Partial<Env>);
    const res = await handleJogarSubscribe(subReq({ email: "a@b.com", optin: true, source: "jogar" }), env, { fetchImpl: fetchMock });
    assert.equal(res.status, 503);
    assert.equal(fetchMock.calls.length, 0);
  });
});
