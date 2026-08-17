/**
 * test/meta-capi-wiring-5504.test.ts (#5504, item (a) do escopo)
 *
 * Cobre a integração do `sendCompleteRegistrationEvent` (fail-soft, ver
 * `test/meta-capi-5504.test.ts`) nos 3 pontos de disparo — formulários
 * próprios: `workers/poll/src/subscribe.ts` (`handleJogarSubscribe`),
 * `workers/cursos/src/subscribe.ts` (`handleGateSubscribe`),
 * `workers/reativar/src/index.ts` (`handleConfirm`). Foco em 2 garantias:
 *
 * 1. Sem `META_CAPI_ACCESS_TOKEN`, o cadastro/ativação NUNCA muda de
 *    comportamento — mesma resposta de antes desta issue, nenhuma chamada
 *    de rede extra pra Meta.
 * 2. Com o token configurado, o handler dispara o evento — e um FALHA da
 *    Meta (rede/HTTP) NUNCA muda o status HTTP nem o corpo da resposta que
 *    o usuário recebe (o cadastro em si já tinha sido confirmado ANTES da
 *    chamada CAPI em todo call site).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleJogarSubscribe, type SubscribeDeps as PollSubscribeDeps } from "../workers/poll/src/subscribe.ts";
import type { Env as PollEnv } from "../workers/poll/src/index.ts";
import { handleGateSubscribe } from "../workers/cursos/src/subscribe.ts";
import type { Env as CursosEnv } from "../workers/cursos/src/index.ts";
import { handleConfirm, type Env as ReativarEnv } from "../workers/reativar/src/index.ts";

/** Roteia por URL — Beehiiv (api.beehiiv.com / *.test/v2) responde sucesso
 * fixo; qualquer chamada pro Graph API da Meta (graph.facebook.com) é
 * registrada separadamente, com comportamento configurável. */
function routedFetch(opts: {
  beehiivBody?: unknown;
  beehiivStatus?: number;
  metaBehavior?: "ok" | "http_error" | "network_error";
}) {
  const beehiivCalls: string[] = [];
  const metaCalls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("graph.facebook.com")) {
      metaCalls.push({ url: u, body: init?.body ? JSON.parse(init.body as string) : {} });
      if (opts.metaBehavior === "network_error") throw new Error("meta network down");
      if (opts.metaBehavior === "http_error") return new Response(JSON.stringify({ error: "bad" }), { status: 401 });
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    }
    beehiivCalls.push(u);
    return new Response(
      JSON.stringify(opts.beehiivBody ?? { data: { id: "sub_1", status: "active" } }),
      { status: opts.beehiivStatus ?? 201 },
    );
  }) as typeof fetch;
  return { fn, beehiivCalls, metaCalls };
}

describe("#5504 — wiring: workers/poll/src/subscribe.ts (handleJogarSubscribe)", () => {
  function pollEnv(over: Partial<PollEnv> = {}): PollEnv {
    return {
      POLL: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true, cursor: undefined }) } as unknown as PollEnv["POLL"],
      POLL_SECRET: "s",
      ADMIN_SECRET: "s",
      ALLOWED_ORIGINS: "*",
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
      ...over,
    } as PollEnv;
  }

  function req(): Request {
    return new Request("https://eia.diar.ia.br/jogar/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
      body: JSON.stringify({ name: "Ana", email: "ana@example.com", optin: true, website: "" }),
    });
  }

  it("sem META_CAPI_ACCESS_TOKEN → 200 normal, NENHUMA chamada pro Graph API da Meta", async () => {
    const { fn, metaCalls } = routedFetch({});
    const res = await handleJogarSubscribe(req(), pollEnv(), { fetchImpl: fn } as PollSubscribeDeps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(metaCalls.length, 0);
  });

  it("com META_CAPI_ACCESS_TOKEN → dispara CompleteRegistration com o hash do e-mail (nunca o e-mail em claro)", async () => {
    const { fn, metaCalls } = routedFetch({});
    const res = await handleJogarSubscribe(req(), pollEnv({ META_CAPI_ACCESS_TOKEN: "tok" }), { fetchImpl: fn } as PollSubscribeDeps);
    assert.equal(res.status, 200);
    assert.equal(metaCalls.length, 1);
    const event = metaCalls[0].body.data as Array<{ event_name: string; user_data: { em: string[] } }>;
    assert.equal(event[0].event_name, "CompleteRegistration");
    assert.match(event[0].user_data.em[0], /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(metaCalls[0].body).includes("ana@example.com"));
  });

  it("falha da Meta (401) NUNCA muda a resposta 200 do cadastro (cadastro já confirmado na Beehiiv antes)", async () => {
    const { fn } = routedFetch({ metaBehavior: "http_error" });
    const res = await handleJogarSubscribe(req(), pollEnv({ META_CAPI_ACCESS_TOKEN: "tok" }), { fetchImpl: fn } as PollSubscribeDeps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("rede da Meta caindo (fetch lança) NUNCA propaga — resposta 200 normal", async () => {
    const { fn } = routedFetch({ metaBehavior: "network_error" });
    const res = await handleJogarSubscribe(req(), pollEnv({ META_CAPI_ACCESS_TOKEN: "tok" }), { fetchImpl: fn } as PollSubscribeDeps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("cadastro que FALHA na Beehiiv nunca sequer chega a chamar a Meta", async () => {
    const { fn, metaCalls } = routedFetch({ beehiivStatus: 500 });
    const res = await handleJogarSubscribe(req(), pollEnv({ META_CAPI_ACCESS_TOKEN: "tok" }), { fetchImpl: fn } as PollSubscribeDeps);
    assert.equal(res.status, 502);
    assert.equal(metaCalls.length, 0);
  });
});

describe("#5504 — wiring: workers/cursos/src/subscribe.ts (handleGateSubscribe)", () => {
  function cursosEnv(over: Partial<CursosEnv> = {}): CursosEnv {
    return {
      ASSETS: {} as CursosEnv["ASSETS"],
      CURSOS_SUBSCRIBERS: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true, cursor: undefined }) } as unknown as CursosEnv["CURSOS_SUBSCRIBERS"],
      COOKIE_HMAC_SECRET: "cookie-secret",
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
      ...over,
    } as CursosEnv;
  }

  function req(): Request {
    return new Request("https://cursos.diar.ia.br/gate/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ana", email: "ana@example.com", optin: true, website: "" }),
    });
  }

  it("sem META_CAPI_ACCESS_TOKEN → cadastro normal, NENHUMA chamada pro Graph API da Meta", async () => {
    const { fn, metaCalls } = routedFetch({});
    const res = await handleGateSubscribe(req(), cursosEnv(), { fetchImpl: fn });
    assert.equal(res.status, 200);
    assert.equal(metaCalls.length, 0);
  });

  it("com META_CAPI_ACCESS_TOKEN e beehiivStatus:active → dispara CompleteRegistration", async () => {
    const { fn, metaCalls } = routedFetch({ beehiivBody: { data: { id: "s1", status: "active" } } });
    const res = await handleGateSubscribe(req(), cursosEnv({ META_CAPI_ACCESS_TOKEN: "tok" }), { fetchImpl: fn });
    assert.equal(res.status, 200);
    assert.equal(metaCalls.length, 1);
  });

  it("falha da Meta nunca muda o cookie/status de sucesso do gate", async () => {
    const { fn } = routedFetch({ metaBehavior: "network_error" });
    const res = await handleGateSubscribe(req(), cursosEnv({ META_CAPI_ACCESS_TOKEN: "tok" }), { fetchImpl: fn });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("Set-Cookie"));
  });
});

describe("#5504 — wiring: workers/reativar/src/index.ts (handleConfirm)", () => {
  function reativarEnv(over: Partial<ReativarEnv> = {}): ReativarEnv {
    return {
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
      ...over,
    } as ReativarEnv;
  }

  function url(): URL {
    return new URL("https://reativar.diaria.workers.dev/?email=ana%40example.com");
  }

  /** `activateSubscription` faz GET (404 = nunca existiu) → POST create com
   * `status: "active"` na resposta — mesmo roteiro do "caminho feliz" já
   * testado em `test/reativar-worker-4476.test.ts`. Aqui só a rota
   * Beehiiv precisa distinguir GET de POST; a Meta é roteada por host. */
  function reativarFetch(opts: { metaBehavior?: "ok" | "network_error" }) {
    const metaCalls: string[] = [];
    const fn = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("graph.facebook.com")) {
        metaCalls.push(u);
        if (opts.metaBehavior === "network_error") throw new Error("meta down");
        return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
      }
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(null, { status: 404 });
      if (method === "POST") return new Response(JSON.stringify({ data: { id: "s1", status: "active" } }), { status: 201 });
      return new Response(null, { status: 204 }); // DELETE (não deveria rolar, GET já foi 404)
    }) as typeof fetch;
    return { fn, metaCalls };
  }

  it("sem META_CAPI_ACCESS_TOKEN → ativação normal, NENHUMA chamada pro Graph API da Meta", async () => {
    const { fn, metaCalls } = reativarFetch({});
    const res = await handleConfirm(url(), reativarEnv(), fn);
    assert.equal(res.status, 200);
    assert.equal(metaCalls.length, 0);
  });

  it("com META_CAPI_ACCESS_TOKEN e ativação confirmada (active) → dispara CompleteRegistration", async () => {
    const { fn, metaCalls } = reativarFetch({});
    const res = await handleConfirm(url(), reativarEnv({ META_CAPI_ACCESS_TOKEN: "tok" }), fn);
    assert.equal(res.status, 200);
    assert.equal(metaCalls.length, 1);
  });

  it("falha de rede da Meta nunca muda a página de sucesso servida pro usuário", async () => {
    const { fn } = reativarFetch({ metaBehavior: "network_error" });
    const res = await handleConfirm(url(), reativarEnv({ META_CAPI_ACCESS_TOKEN: "tok" }), fn);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /confirma/i);
  });
});
