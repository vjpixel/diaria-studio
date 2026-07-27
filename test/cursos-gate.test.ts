/**
 * cursos-gate.test.ts (#4052)
 *
 * Cobre `workers/cursos/src/index.ts` fim-a-fim (fetch handler completo) +
 * `gate.ts` + `cookie.ts` + `subscribe.ts`: os dois caminhos de entrada
 * (?email= da newsletter e cookie de sessão), a tela de gate, verificação,
 * cadastro inline, e rate-limit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { type Env } from "../workers/cursos/src/index.ts";
import { subscriberKvKey } from "../scripts/lib/shared/subscriber-verify.ts";
import { issueSessionCookie } from "../workers/cursos/src/cookie.ts";
import { CURSOS_FULL_HTML } from "../workers/cursos/src/courses-full.generated.ts";

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

const TEASER_HTML = "<html><body>teaser fallback</body></html>";
function makeAssets(): Fetcher {
  return {
    fetch: async () => new Response(TEASER_HTML, { headers: { "Content-Type": "text/html" } }),
  } as unknown as Fetcher;
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: makeAssets(),
    CURSOS_SUBSCRIBERS: makeMapKV(),
    COOKIE_HMAC_SECRET: "cookie-secret",
    ...overrides,
  };
}

function getCookieHeader(res: Response): string | null {
  return res.headers.get("Set-Cookie");
}

describe("workers/cursos GET / (#4052)", () => {
  it("sem ?email= e sem cookie → serve o teaser (ASSETS.fetch)", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://cursos.diar.ia.br/"), env);
    assert.equal(await res.text(), TEASER_HTML);
  });

  it("?email= de assinante ativo → serve o HTML completo E seta cookie", async () => {
    const email = "assinante@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request(`https://cursos.diar.ia.br/?email=${encodeURIComponent(email)}`),
      env,
    );
    assert.equal(await res.text(), CURSOS_FULL_HTML);
    assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
  });

  it("?email= de e-mail NÃO assinante → cai pro teaser, sem vazar o sinal negativo", async () => {
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/?email=ninguem@example.com"),
      env,
    );
    assert.equal(await res.text(), TEASER_HTML);
    assert.equal(getCookieHeader(res), null);
  });

  it("cookie de sessão válido → serve o HTML completo sem precisar de ?email=", async () => {
    const cookieValue = await issueSessionCookie("cookie-secret", "leitor@example.com");
    const cookiePair = cookieValue.split(";")[0];
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } }),
      env,
    );
    assert.equal(await res.text(), CURSOS_FULL_HTML);
  });

  it("cookie inválido (secret errado) → cai pro teaser", async () => {
    const cookieValue = await issueSessionCookie("outro-secret", "leitor@example.com");
    const cookiePair = cookieValue.split(";")[0];
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } }),
      env,
    );
    assert.equal(await res.text(), TEASER_HTML);
  });
});

describe("workers/cursos GET /gate (#4052)", () => {
  it("responde HTML com o form de gate", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://cursos.diar.ia.br/gate"), env);
    const body = await res.text();
    assert.match(body, /gate-form/);
    assert.equal(res.headers.get("Content-Type"), "text/html;charset=utf-8");
  });
});

describe("workers/cursos POST /gate/verify (#4052)", () => {
  it("assinante ativo → ok:true + cookie", async () => {
    const email = "ativo@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      env,
    );
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, true);
    assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
  });

  it("não-assinante → ok:false, error not_active, SEM cookie", async () => {
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ninguem@example.com" }),
      }),
      env,
    );
    const data = (await res.json()) as { ok: boolean; error: string };
    assert.equal(data.ok, false);
    assert.equal(data.error, "not_active");
    assert.equal(getCookieHeader(res), null);
  });

  it("e-mail inválido → 400", async () => {
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "não-é-email" }),
      }),
      env,
    );
    assert.equal(res.status, 400);
  });

  it("honeypot preenchido → resposta fake-fail 200, sem revelar ao bot", async () => {
    const email = "ativo@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website: "http://spam.example.com" }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, false);
  });

  it("rate-limit: 9ª tentativa do mesmo IP em 1h é bloqueada (limite 8)", async () => {
    const env = baseEnv();
    const mkReq = () =>
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
        body: JSON.stringify({ email: "x@example.com" }),
      });
    let last: Response | null = null;
    for (let i = 0; i < 9; i++) last = await worker.fetch(mkReq(), env);
    assert.equal(last!.status, 429);
  });
});

describe("workers/cursos POST /gate/subscribe (#4052)", () => {
  function subReq(body: unknown) {
    return new Request("https://cursos.diar.ia.br/gate/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("sem opt-in → 400 optin_required", async () => {
    const env = baseEnv();
    const res = await worker.fetch(subReq({ email: "x@example.com", optin: false }), env);
    assert.equal(res.status, 400);
  });

  it("Beehiiv não configurado (secrets ausentes) → 503 subscribe_unavailable", async () => {
    const env = baseEnv();
    const res = await worker.fetch(subReq({ email: "x@example.com", optin: true }), env);
    assert.equal(res.status, 503);
    const data = (await res.json()) as { error: string };
    assert.equal(data.error, "subscribe_unavailable");
  });

  it("sucesso (secrets configurados) → 200 + cookie de sessão", async () => {
    const env = baseEnv({
      BEEHIIV_API_KEY: "test-key",
      BEEHIIV_PUBLICATION_ID: "pub_test",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { id: "sub_1" } }), { status: 201 })) as typeof fetch;
    try {
      const res = await worker.fetch(subReq({ email: "novo@example.com", optin: true }), env);
      assert.equal(res.status, 200);
      assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("honeypot preenchido → 200 fake-success, nenhuma chamada à Beehiiv", async () => {
    const env = baseEnv({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: "pub_test" });
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("não deveria ser chamado");
    }) as typeof fetch;
    try {
      const res = await worker.fetch(
        subReq({ email: "x@example.com", optin: true, website: "http://spam.example.com" }),
        env,
      );
      assert.equal(res.status, 200);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("workers/cursos POST /gate/logout (#4052)", () => {
  it("limpa o cookie de sessão", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://cursos.diar.ia.br/gate/logout", { method: "POST" }), env);
    assert.match(getCookieHeader(res) ?? "", /Max-Age=0/);
  });
});
