/**
 * test/reativar-worker-4476.test.ts (#4476 item 3)
 *
 * Worker `reativar` — link de confirmação personalizado (merge tag
 * `?email={{ contact.EMAIL }}`, sem assinatura HMAC — mesmo padrão do link
 * de voto pós-#1186). Cobre: parse/validação do `?email=`, a chamada de
 * ativação (GET by_email → DELETE + CREATE, sem `reactivate_existing` —
 * mecânica corrigida no #4488, 260802) com fetch mockado, e o handler
 * fim-a-fim.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEmailParam,
  activateSubscription,
  handleConfirm,
  checkNativeUnsubscribePending,
  renderSuccessPage,
  renderMissingEmailPage,
  renderInvalidEmailPage,
  renderErrorPage,
  renderNotConfirmedPage,
  renderNativeUnsubscribePage,
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

/** Mock roteado por método — GET (by_email) / DELETE / POST (create). */
function routedFetch(handlers: {
  get?: () => Response | Promise<Response>;
  del?: () => Response | Promise<Response>;
  post?: (body: unknown) => Response | Promise<Response>;
}): { fetchImpl: typeof fetch; calls: { method: string; url: string }[] } {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(url) });
    if (method === "DELETE") return handlers.del ? handlers.del() : new Response(null, { status: 204 });
    if (method === "POST") return handlers.post ? handlers.post(init?.body ? JSON.parse(init.body as string) : undefined) : jsonRes(200, {});
    return handlers.get ? handlers.get() : jsonRes(404, {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("activateSubscription — DELETE + CREATE, não mais reactivate_existing (#4476, mecânica corrigida 260802)", () => {
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

  it("contato pending existente → GET acha, DELETE remove, POST cria sem reactivate_existing, retorna active", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { data: { id: "sub_old", status: "pending" } }),
      post: (body) => {
        assert.deepEqual(body, { email: "a@b.com", send_welcome_email: false });
        return jsonRes(201, { data: { id: "sub_new", status: "active" } });
      },
    });
    const env: Env = { BEEHIIV_API_KEY: "key123", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 201, beehiivStatus: "active" });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET", "DELETE", "POST"],
    );
    assert.equal(calls[1].url, "https://api.beehiiv.com/v2/publications/pub_1/subscriptions/sub_old");
  });

  it("já active (idempotência — clique 2x, ou via de score já promoveu) → retorna active sem DELETE/POST", async () => {
    const { fetchImpl, calls } = routedFetch({ get: () => jsonRes(200, { data: { id: "sub_1", status: "active" } }) });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 200, beehiivStatus: "active" });
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  });

  it("GET 404 (nunca existiu) → pula DELETE, cria direto", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => new Response(null, { status: 404 }),
      post: () => jsonRes(201, { data: { status: "active" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 201, beehiivStatus: "active" });
    assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
  });

  it("DELETE 404 (sumiu entre GET e DELETE) → não é erro, segue pro CREATE", async () => {
    const { fetchImpl } = routedFetch({
      get: () => jsonRes(200, { data: { id: "sub_old", status: "pending" } }),
      del: () => new Response(null, { status: 404 }),
      post: () => jsonRes(201, { data: { status: "active" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 201, beehiivStatus: "active" });
  });

  it('#4476 achado do teste ao vivo: POST 2xx mas status:"invalid" → ok:true (HTTP), beehiivStatus:"invalid" (NÃO confirmado, sem retry — status terminal)', async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { data: { id: "sub_old", status: "pending" } }),
      post: () => jsonRes(201, { data: { id: "sub_new", status: "invalid" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 201, beehiivStatus: "invalid" });
    assert.deepEqual(calls.map((c) => c.method), ["GET", "DELETE", "POST"], "nunca faz releitura extra pra status terminal");
  });

  it('POST responde status:"validating" (transitório, achado ao vivo 260802) → 1 retry após espera, releitura "active" → beehiivStatus:"active"', async () => {
    let getCalls = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return jsonRes(201, { data: { id: "sub_new", status: "validating" } });
      if (method === "DELETE") return new Response(null, { status: 204 });
      getCalls++;
      // 1ª GET (antes do DELETE/CREATE): "pending". 2ª GET (releitura pós-retry): "active".
      return jsonRes(200, { data: { id: "sub_old", status: getCalls === 1 ? "pending" : "active" } });
    }) as typeof fetch;
    let sleptMs = -1;
    const sleepImpl = async (ms: number) => {
      sleptMs = ms;
    };
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl, sleepImpl);
    assert.deepEqual(result, { ok: true, status: 201, beehiivStatus: "active" });
    assert.equal(sleptMs, 2000);
    assert.equal(getCalls, 2);
  });

  it('POST responde status:"validating", releitura AINDA vem "validating" → beehiivStatus fica "validating" (nunca 2º retry, #4488 review pr-test-analyzer)', async () => {
    let getCalls = 0;
    const { fetchImpl } = routedFetch({
      get: () => {
        getCalls++;
        // 1ª GET (existência, antes do DELETE/CREATE): "pending". 2ª GET
        // (releitura pós-retry): AINDA "validating" — não confirmou de vez.
        return jsonRes(200, { data: { id: "sub_old", status: getCalls === 1 ? "pending" : "validating" } });
      },
      post: () => jsonRes(201, { data: { id: "sub_new", status: "validating" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl, async () => {});
    assert.deepEqual(result, { ok: true, status: 201, beehiivStatus: "validating" });
    assert.equal(getCalls, 2, "GET inicial + 1 releitura, nunca mais que isso");
  });

  it('POST responde status:"validating", releitura da retry falha (rede) → beehiivStatus fica "validating" (fail-safe, achado silent-failure-hunter)', async () => {
    let getCalls = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return jsonRes(201, { data: { id: "sub_new", status: "validating" } });
      if (method === "DELETE") return new Response(null, { status: 204 });
      getCalls++;
      if (getCalls === 1) return jsonRes(200, { data: { id: "sub_old", status: "pending" } });
      throw new Error("network down on recheck");
    }) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl, async () => {});
    assert.deepEqual(result, { ok: true, status: 201, beehiivStatus: "validating" });
  });

  it('POST responde status:"validating", releitura da retry vem NÃO-2xx (sem lançar) → beehiivStatus fica "validating" (achado silent-failure-hunter, branch antes descoberta sem log)', async () => {
    let getCalls = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return jsonRes(201, { data: { id: "sub_new", status: "validating" } });
      if (method === "DELETE") return new Response(null, { status: 204 });
      getCalls++;
      if (getCalls === 1) return jsonRes(200, { data: { id: "sub_old", status: "pending" } });
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl, async () => {});
    assert.deepEqual(result, { ok: true, status: 201, beehiivStatus: "validating" });
  });

  it("GET by_email com corpo 2xx não-parseável → ok:false, beehiivStatus ausente (nunca trata como 'não existe' em silêncio, #4488 review silent-failure-hunter)", async () => {
    const { fetchImpl, calls } = routedFetch({ get: () => new Response("<html>gateway error</html>", { status: 200 }) });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: false, status: 502, reason: "beehiiv_error" });
    assert.deepEqual(calls.map((c) => c.method), ["GET"], "nunca chega no DELETE/POST com estado desconhecido");
  });

  it('handleConfirm fim-a-fim: status:"validating" → retry → "active" → página de sucesso', async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return jsonRes(201, { data: { status: "validating" } });
      return jsonRes(200, { data: { status: "active" } });
    }) as typeof fetch;
    const url = new URL("https://reativar.diaria.workers.dev/?email=a@b.com");
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const res = await handleConfirm(url, env, fetchImpl, async () => {});
    assert.equal(res.status, 200);
    assert.equal(await res.text(), renderSuccessPage());
  });

  it("corpo do CREATE sem data.status (ou não-JSON) → ok:true, beehiivStatus:null (nunca lança)", async () => {
    const { fetchImpl } = routedFetch({
      get: () => new Response(null, { status: 404 }),
      post: () => new Response("", { status: 200 }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 200, beehiivStatus: null });
  });

  it("BEEHIIV_API_URL override (teste) → usa a base customizada em todas as chamadas", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => new Response(null, { status: 404 }),
      post: () => jsonRes(200, { data: { status: "active" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1", BEEHIIV_API_URL: "https://mock.local/v2" };
    await activateSubscription(env, "a@b.com", fetchImpl);
    assert.ok(calls.every((c) => c.url.startsWith("https://mock.local/v2")));
  });

  it("Beehiiv responde erro no GET (4xx/5xx) → beehiiv_error, status propagado, nunca chega no DELETE/POST", async () => {
    const { fetchImpl, calls } = routedFetch({ get: () => new Response("boom", { status: 500 }) });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: false, status: 500, reason: "beehiiv_error" });
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  });

  it("Beehiiv responde erro no DELETE (não-404) → beehiiv_error, nunca chega no POST", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { data: { id: "sub_old", status: "pending" } }),
      del: () => new Response("locked", { status: 423 }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: false, status: 423, reason: "beehiiv_error" });
    assert.deepEqual(calls.map((c) => c.method), ["GET", "DELETE"]);
  });

  it("Beehiiv responde erro no POST (4xx/5xx) → beehiiv_error, status propagado", async () => {
    const { fetchImpl } = routedFetch({
      get: () => new Response(null, { status: 404 }),
      post: () => new Response("conflict", { status: 409 }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: false, status: 409, reason: "beehiiv_error" });
  });

  it("fetch lança (timeout/rede) em qualquer passo → beehiiv_error, 502 (nunca propaga a exceção)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: false, status: 502, reason: "beehiiv_error" });
  });
});

describe("checkNativeUnsubscribePending — guard de descadastro nativo (#4538 item B)", () => {
  it("BREVO_DIARIA_API_KEY ausente → unknown/no_api_key, sem chamar fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonRes(200, { emailBlacklisted: true });
    }) as typeof fetch;
    const result = await checkNativeUnsubscribePending({}, "a@b.com", fetchImpl);
    assert.deepEqual(result, { status: "unknown", reason: "no_api_key" });
    assert.equal(called, false, "sem a key, o guard nem tenta chamar a Brevo — fail-open");
  });

  it("emailBlacklisted:true → confirmed_pending (descadastro nativo pendente)", async () => {
    const fetchImpl = (async () => jsonRes(200, { emailBlacklisted: true })) as typeof fetch;
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key" };
    assert.deepEqual(await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl), { status: "confirmed_pending" });
  });

  it("emailBlacklisted:false → confirmed_not_pending (nada pendente)", async () => {
    const fetchImpl = (async () => jsonRes(200, { emailBlacklisted: false })) as typeof fetch;
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key" };
    assert.deepEqual(await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl), { status: "confirmed_not_pending" });
  });

  it("404 (contato nunca existiu na Brevo) → confirmed_not_pending", async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key" };
    assert.deepEqual(await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl), { status: "confirmed_not_pending" });
  });

  it("erro HTTP (5xx) → fail-open, unknown/http_error (nunca lança, nunca bloqueia o fluxo inteiro por um hiccup)", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key" };
    assert.deepEqual(await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl), { status: "unknown", reason: "http_error" });
  });

  it("401 (credencial inválida/revogada) → fail-open, unknown/http_error — mesmo bucket de erro HTTP, log distinto (#4545 review)", async () => {
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key_revogada" };
    assert.deepEqual(await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl), { status: "unknown", reason: "http_error" });
  });

  it("403 (credencial sem permissão) → fail-open, unknown/http_error", async () => {
    const fetchImpl = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key" };
    assert.deepEqual(await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl), { status: "unknown", reason: "http_error" });
  });

  it("fetch lança (timeout/rede) → fail-open, unknown/network_error (nunca propaga a exceção)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key" };
    assert.deepEqual(await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl), { status: "unknown", reason: "network_error" });
  });

  it("BREVO_API_URL override (teste) → usa a base customizada", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url);
      return jsonRes(200, { emailBlacklisted: false });
    }) as typeof fetch;
    const env: Env = { BREVO_DIARIA_API_KEY: "brevo_key", BREVO_API_URL: "https://mock.local/v3" };
    await checkNativeUnsubscribePending(env, "a@b.com", fetchImpl);
    assert.ok(capturedUrl.startsWith("https://mock.local/v3"));
  });
});

describe("activateSubscription — guard de descadastro nativo pendente (#4538 item B, teste de regressão obrigatório caso c)", () => {
  it("contato blacklisted na Brevo → NUNCA chama DELETE/CREATE na Beehiiv, retorna reason native_unsubscribe_pending", async () => {
    const beehiivCalls: { method: string; url: string }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("api.brevo.com")) {
        return jsonRes(200, { emailBlacklisted: true });
      }
      beehiivCalls.push({ method, url: u });
      if (method === "DELETE") throw new Error("DELETE NUNCA deveria ser chamado — contato pediu pra sair");
      if (method === "POST") throw new Error("POST (CREATE) NUNCA deveria ser chamado — contato pediu pra sair");
      // GET inicial (existência) — registro Pending travado, não-active.
      return jsonRes(200, { data: { id: "sub_old", status: "pending" } });
    }) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1", BREVO_DIARIA_API_KEY: "brevo_key" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 200, reason: "native_unsubscribe_pending" });
    assert.deepEqual(beehiivCalls.map((c) => c.method), ["GET"], "só o GET de existência — nunca DELETE nem POST");
  });

  it("contato JÁ active na Beehiiv (idempotência) tem prioridade sobre o guard — nunca chama a Brevo", async () => {
    let brevoCalled = false;
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.brevo.com")) {
        brevoCalled = true;
        return jsonRes(200, { emailBlacklisted: true });
      }
      return jsonRes(200, { data: { id: "sub_1", status: "active" } });
    }) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1", BREVO_DIARIA_API_KEY: "brevo_key" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 200, beehiivStatus: "active" });
    assert.equal(brevoCalled, false, "já active — nem precisa checar o guard");
  });

  it("contato NÃO blacklisted → guard não bloqueia, DELETE+CREATE prosseguem normalmente", async () => {
    const { fetchImpl: routedBeehiiv, calls } = routedFetch({
      get: () => jsonRes(200, { data: { id: "sub_old", status: "pending" } }),
      post: () => jsonRes(201, { data: { id: "sub_new", status: "active" } }),
    });
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.brevo.com")) return jsonRes(200, { emailBlacklisted: false });
      return routedBeehiiv(url, init);
    }) as typeof fetch;
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1", BREVO_DIARIA_API_KEY: "brevo_key" };
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 201, beehiivStatus: "active" });
    assert.deepEqual(calls.map((c) => c.method), ["GET", "DELETE", "POST"]);
  });

  it("BREVO_DIARIA_API_KEY ausente (fail-open) → guard pulado, DELETE+CREATE prosseguem normalmente (nunca pior que o comportamento pré-#4538)", async () => {
    const { fetchImpl, calls } = routedFetch({
      get: () => jsonRes(200, { data: { id: "sub_old", status: "pending" } }),
      post: () => jsonRes(201, { data: { id: "sub_new", status: "active" } }),
    });
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" }; // sem BREVO_DIARIA_API_KEY
    const result = await activateSubscription(env, "a@b.com", fetchImpl);
    assert.deepEqual(result, { ok: true, status: 201, beehiivStatus: "active" });
    assert.deepEqual(calls.map((c) => c.method), ["GET", "DELETE", "POST"]);
  });
});

describe("handleConfirm — guard de descadastro nativo pendente (#4538 item B)", () => {
  it("contato blacklisted → 200, página própria de 'você pediu pra sair' (nunca a de sucesso nem a genérica)", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api.brevo.com")) return jsonRes(200, { emailBlacklisted: true });
      return jsonRes(200, { data: { id: "sub_old", status: "pending" } });
    }) as typeof fetch;
    const url = new URL("https://reativar.diaria.workers.dev/?email=a@b.com");
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1", BREVO_DIARIA_API_KEY: "brevo_key" };
    const res = await handleConfirm(url, env, fetchImpl);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), renderNativeUnsubscribePage());
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

  it("ativação bem-sucedida (GET 404 → cria → beehiivStatus:active) → 200, página de sucesso", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes(200, { data: { status: "active" } });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const url = new URL("https://reativar.diaria.workers.dev/?email=a@b.com");
    const env: Env = { BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub_1" };
    const res = await handleConfirm(url, env, fetchImpl);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), renderSuccessPage());
  });

  it('#4476 achado do teste ao vivo: POST 2xx mas status:"invalid" → 200 com página "ainda não confirmado" (NUNCA a página de sucesso)', async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonRes(201, { data: { status: "invalid" } });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
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

  it("Beehiiv falha (GET) → 502, página de erro genérica", async () => {
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
