/**
 * test/poll-web-gate-4054.test.ts (#4054)
 *
 * Cobre o gate por rodada do caminho de fora do "É IA?" (`/jogar`, brand
 * `web`): `web-gate.ts` (verify/subscribe/cookie de sessão) + a identidade
 * pós-gate em `GET /vote` (vote.ts) + o guard #3976/#4011 preservado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { type Env } from "../workers/poll/src/index.ts";
import { subscriberKvKey } from "../workers/poll/src/subscriber-verify.ts";
import {
  issueWebSessionCookie,
  WEB_SESSION_COOKIE,
  FREE_ROUND_COOKIE,
  renderJogarGatePage,
} from "../workers/poll/src/web-gate.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _map: m,
  };
}

const makeEnv = (overrides: Partial<Env> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
  POLL: makeMapKV(),
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
  COOKIE_HMAC_SECRET: "cookie-secret",
  ...overrides,
});

function getCookieHeader(res: Response): string | null {
  return res.headers.get("Set-Cookie");
}

const VALID_TOKEN = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const VALID_EMAIL = `${VALID_TOKEN}@web.eia.diaria.local`;

// ── POST /jogar/gate/verify — verificação de assinante ──────────────────────

describe("POST /jogar/gate/verify (#4054)", () => {
  function req(body: unknown, extraHeaders: Record<string, string> = {}) {
    return new Request("https://poll.test/jogar/gate/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    });
  }

  it("assinante ativo (via KV) → ok:true + cookie de sessão", async () => {
    const email = "ativo@example.com";
    const key = await subscriberKvKey(email);
    const env = makeEnv({ SUBSCRIBERS_KV: makeMapKV({ [key]: "1" }) as unknown as KVNamespace });
    const res = await worker.fetch(req({ email }), env);
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, true);
    assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
    assert.match(getCookieHeader(res) ?? "", new RegExp(WEB_SESSION_COOKIE));
  });

  it("não-assinante (KV ausente) → ok:false, error not_active, SEM cookie", async () => {
    const env = makeEnv();
    const res = await worker.fetch(req({ email: "ninguem@example.com" }), env);
    const data = (await res.json()) as { ok: boolean; error: string };
    assert.equal(data.ok, false);
    assert.equal(data.error, "not_active");
    assert.equal(getCookieHeader(res), null);
  });

  it("Beehiiv API indisponível/erro (fallback secundário) → not_active, nunca lança", async () => {
    const env = makeEnv({ BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    try {
      const res = await worker.fetch(req({ email: "quemsabe@example.com" }), env);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.equal(data.ok, false);
      assert.equal(data.error, "not_active");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Beehiiv fallback ativo confirma assinante quando o KV não tem a chave", async () => {
    const env = makeEnv({ BEEHIIV_API_KEY: "key", BEEHIIV_PUBLICATION_ID: "pub" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { status: "active" } }), { status: 200 })) as typeof fetch;
    try {
      const res = await worker.fetch(req({ email: "viaapi@example.com" }), env);
      const data = (await res.json()) as { ok: boolean };
      assert.equal(data.ok, true);
      assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("e-mail inválido → 400", async () => {
    const env = makeEnv();
    const res = await worker.fetch(req({ email: "não-é-email" }), env);
    assert.equal(res.status, 400);
  });

  it("honeypot preenchido → fake-fail 200, sem revelar ao bot", async () => {
    const email = "ativo@example.com";
    const key = await subscriberKvKey(email);
    const env = makeEnv({ SUBSCRIBERS_KV: makeMapKV({ [key]: "1" }) as unknown as KVNamespace });
    const res = await worker.fetch(req({ email, website: "http://spam.example.com" }), env);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, false);
  });

  it("sem COOKIE_HMAC_SECRET → assinante confirmado mas gate_unavailable (nunca emite cookie sem segredo)", async () => {
    const email = "ativo@example.com";
    const key = await subscriberKvKey(email);
    const env = makeEnv({ SUBSCRIBERS_KV: makeMapKV({ [key]: "1" }) as unknown as KVNamespace, COOKIE_HMAC_SECRET: undefined });
    const res = await worker.fetch(req({ email }), env);
    assert.equal(res.status, 503);
    assert.equal(getCookieHeader(res), null);
  });

  it("rate-limit: 9ª tentativa do mesmo IP em 1h é bloqueada (limite 8)", async () => {
    const env = makeEnv();
    const mkReq = () => req({ email: "x@example.com" }, { "CF-Connecting-IP": "9.9.9.9" });
    let last: Response | null = null;
    for (let i = 0; i < 9; i++) last = await worker.fetch(mkReq(), env);
    assert.equal(last!.status, 429);
  });
});

// ── POST /jogar/gate/subscribe — cadastro inline com cookie imediato ────────

describe("POST /jogar/gate/subscribe (#4054)", () => {
  function subReq(body: unknown) {
    return new Request("https://poll.test/jogar/gate/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("sem opt-in → 400 optin_required", async () => {
    const env = makeEnv();
    const res = await worker.fetch(subReq({ email: "x@example.com", optin: false }), env);
    assert.equal(res.status, 400);
  });

  it("Beehiiv não configurado → 503 subscribe_unavailable", async () => {
    const env = makeEnv();
    const res = await worker.fetch(subReq({ email: "x@example.com", optin: true }), env);
    assert.equal(res.status, 503);
    const data = (await res.json()) as { error: string };
    assert.equal(data.error, "subscribe_unavailable");
  });

  it("sucesso → 200 + cookie de sessão IMEDIATO, sem esperar confirmação da Beehiiv", async () => {
    const env = makeEnv({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: "pub_test" });
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
    const env = makeEnv({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: "pub_test" });
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

describe("renderJogarGatePage — cópia e UX (#4054 follow-up)", () => {
  const html = renderJogarGatePage(null);

  it("opt-in explica o que é a Diar.ia (não pressupõe que o leitor já conhece)", () => {
    assert.match(html, /newsletter di.ria e gratuita/);
    assert.match(html, /not.cias e tutoriais de IA/);
    // copy antiga (bare, sem explicar o produto) não pode sobreviver
    assert.doesNotMatch(html, /Quero receber a newsletter di.ria da Diar\.ia<\/label>/);
  });

  it("aviso de erro (checkbox desmarcada) usa a classe .err (banner destacado, não texto de 0.9rem solto)", () => {
    assert.match(html, /#gate-msg\.err\s*\{[^}]*font-weight:\s*700/);
    assert.match(html, /setMsg\("Marque a caixinha pra assinar e continuar\.", "err"\)/);
  });

  it("REGRESSÃO: sessionUnavailable (cadastro OK mas sem COOKIE_HMAC_SECRET) NÃO redireciona cegamente pro jogo", () => {
    // Bug real (260727): subscribe podia responder {ok:true, sessionUnavailable:true}
    // (sem secret configurado no worker) e o client redirecionava mesmo assim —
    // /jogar então rejeitava por falta de sessão de verdade e mostrava o gate
    // de novo, vazio, parecendo que "o conteúdo sumiu". O guard abaixo trava
    // esse caminho: só redireciona quando a sessão foi de fato emitida.
    assert.match(html, /data2\.ok\s*&&\s*!data2\.sessionUnavailable/);
    assert.match(html, /data2\.ok\s*&&\s*data2\.sessionUnavailable/);
  });
});

describe("POST /jogar/gate/logout (#4054)", () => {
  it("limpa o cookie de sessão do caminho de fora", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar/gate/logout", { method: "POST" }), env);
    assert.match(getCookieHeader(res) ?? "", /Max-Age=0/);
    assert.match(getCookieHeader(res) ?? "", new RegExp(WEB_SESSION_COOKIE));
  });
});

// ── GET /jogar — gate por rodada (cookie "rodada livre usada") ──────────────

describe("GET /jogar — gate por rodada (#4054)", () => {
  it("sem cookie de rodada livre usada → jogo normal, mesmo sem sessão", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /Você já jogou sua rodada livre/);
  });

  it("cookie de rodada livre usada, SEM sessão → serve a tela de gate", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/jogar", { headers: { Cookie: `${FREE_ROUND_COOKIE}=1` } }),
      env,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Você já jogou sua rodada livre/);
  });

  it("cookie de rodada livre usada + sessão válida → jogo normal, sem gate", async () => {
    const env = makeEnv();
    const sessionCookie = (await issueWebSessionCookie("cookie-secret", "leitor@example.com")).split(";")[0];
    const res = await worker.fetch(
      new Request("https://poll.test/jogar", {
        headers: { Cookie: `${FREE_ROUND_COOKIE}=1; ${sessionCookie}` },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /Você já jogou sua rodada livre/);
  });

  it("sessão com secret ERRADO (forjada) → gate continua ativo (cookie inválido = sem sessão)", async () => {
    const env = makeEnv();
    const forged = (await issueWebSessionCookie("secret-errado", "leitor@example.com")).split(";")[0];
    const res = await worker.fetch(
      new Request("https://poll.test/jogar", {
        headers: { Cookie: `${FREE_ROUND_COOKIE}=1; ${forged}` },
      }),
      env,
    );
    const html = await res.text();
    assert.match(html, /Você já jogou sua rodada livre/);
  });

  it("sessão EXPIRADA → gate continua ativo", async () => {
    const env = makeEnv();
    const expired = (
      await import("../workers/poll/src/session-cookie.ts")
    ).signSessionCookie;
    const expiredCookieValue = await expired("cookie-secret", "leitor@example.com", -10);
    const res = await worker.fetch(
      new Request("https://poll.test/jogar", {
        headers: { Cookie: `${FREE_ROUND_COOKIE}=1; ${WEB_SESSION_COOKIE}=${encodeURIComponent(expiredCookieValue)}` },
      }),
      env,
    );
    const html = await res.text();
    assert.match(html, /Você já jogou sua rodada livre/);
  });

  it("#4109: link de skip existe na tela de gate", () => {
    const html = renderJogarGatePage(null);
    assert.match(html, /Agora não, continuar jogando/);
    assert.match(html, /skip_gate=1/);
  });

  it("#4109: cookie de rodada livre usada, SEM sessão, mas com ?skip_gate=1 → jogo normal (bypass de 1 navegação)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/jogar?skip_gate=1", { headers: { Cookie: `${FREE_ROUND_COOKIE}=1` } }),
      env,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /Você já jogou sua rodada livre/);
  });

  it("#4109: skip_gate=1 é não-persistente — próxima requisição sem o param volta a gatear", async () => {
    const env = makeEnv();
    const skipped = await worker.fetch(
      new Request("https://poll.test/jogar?skip_gate=1", { headers: { Cookie: `${FREE_ROUND_COOKIE}=1` } }),
      env,
    );
    assert.doesNotMatch(await skipped.text(), /Você já jogou sua rodada livre/);

    const again = await worker.fetch(
      new Request("https://poll.test/jogar", { headers: { Cookie: `${FREE_ROUND_COOKIE}=1` } }),
      env,
    );
    assert.match(await again.text(), /Você já jogou sua rodada livre/);
  });

  it("#4109 (self-review): skip_gate=1 com ?edition= explícito NUNCA é public — CDN não pode cachear o bypass pra outros visitantes", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/jogar?edition=260701&skip_gate=1", {
        headers: { Cookie: `${FREE_ROUND_COOKIE}=1` },
      }),
      env,
    );
    assert.equal(res.status, 200);
    assert.doesNotMatch(await res.text(), /Você já jogou sua rodada livre/);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });
});

// ── GET /vote?brand=web — identidade pós-gate via cookie (paralela ao token) ─

describe("GET /vote?brand=web — identidade pós-gate (#4054)", () => {
  it("cookie de sessão válido → voto é gravado sob o E-MAIL REAL, não o token anônimo", async () => {
    const env = makeEnv();
    const sessionCookie = (await issueWebSessionCookie("cookie-secret", "real@example.com")).split(";")[0];
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(VALID_EMAIL)}&edition=260701&choice=A&brand=web`, {
        headers: { Cookie: sessionCookie },
      }),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(env.POLL._map.has("web:vote:260701:real@example.com"), "voto deveria estar sob o e-mail real");
    assert.ok(!env.POLL._map.has(`web:vote:260701:${VALID_EMAIL}`), "não deveria gravar sob o token anônimo quando há sessão");
  });

  it("sem cookie de sessão → comportamento pré-#4054 intocado (voto sob o token anônimo)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(VALID_EMAIL)}&edition=260701&choice=A&brand=web`),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(env.POLL._map.has(`web:vote:260701:${VALID_EMAIL}`));
  });

  it("REGRESSÃO #3976/#4011: cookie de sessão válido NÃO abre uma exceção ao guard — token continua obrigatório no parâmetro", async () => {
    const env = makeEnv();
    const sessionCookie = (await issueWebSessionCookie("cookie-secret", "real@example.com")).split(";")[0];
    const bogusEmail = "verify1840428@web.eia.diaria.local";
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(bogusEmail)}&edition=260701&choice=A&brand=web`, {
        headers: { Cookie: sessionCookie },
      }),
      env,
    );
    assert.equal(res.status, 400, "o guard do token deve rodar e rejeitar ANTES de qualquer override de cookie");
    assert.equal(env.POLL._map.size, 0);
  });

  it("REGRESSÃO #3976/#4011: ?email= cru no brand=web continua rejeitado mesmo com cookie válido presente", async () => {
    const env = makeEnv();
    const sessionCookie = (await issueWebSessionCookie("cookie-secret", "real@example.com")).split(";")[0];
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent("qualquer@example.com")}&edition=260701&choice=A&brand=web`, {
        headers: { Cookie: sessionCookie },
      }),
      env,
    );
    assert.equal(res.status, 400);
  });

  it("REGRESSÃO: brand=diaria (newsletter, Path A) é 100% intocado pela identidade pós-gate", async () => {
    const env = makeEnv();
    const sessionCookie = (await issueWebSessionCookie("cookie-secret", "outro@example.com")).split(";")[0];
    const res = await worker.fetch(
      new Request("https://poll.test/vote?email=leitor@example.com&edition=260701&choice=A", {
        headers: { Cookie: sessionCookie },
      }),
      env,
    );
    assert.equal(res.status, 200);
    // grava sob o e-mail do PARÂMETRO (leitor@), nunca sob o e-mail do cookie
    // (outro@) — o override só se aplica quando brand === "web".
    assert.ok(env.POLL._map.has("vote:260701:leitor@example.com"));
    assert.ok(!env.POLL._map.has("vote:260701:outro@example.com"));
  });

  it("cookie FORJADO (secret errado) → nenhum override, cai no comportamento pré-#4054 (token válido continua votando normalmente)", async () => {
    const env = makeEnv();
    const forged = (await issueWebSessionCookie("secret-errado", "impostor@example.com")).split(";")[0];
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(VALID_EMAIL)}&edition=260701&choice=A&brand=web`, {
        headers: { Cookie: forged },
      }),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(env.POLL._map.has(`web:vote:260701:${VALID_EMAIL}`), "sem sessão válida, deve gravar sob o token, não sob o e-mail forjado");
    assert.ok(!env.POLL._map.has("web:vote:260701:impostor@example.com"));
  });
});
