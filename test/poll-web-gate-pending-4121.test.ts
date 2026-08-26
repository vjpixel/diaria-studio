/**
 * test/poll-web-gate-pending-4121.test.ts (#4121)
 *
 * `handleJogarGateSubscribe` (web-gate.ts) emitia o cookie de sessão assinado
 * assim que a Beehiiv retornava 2xx — mas `subscribeToBeehiiv` só confirma
 * sucesso HTTP da CRIAÇÃO da assinatura; o double opt-in continua pendente
 * (ninguém provou posse do e-mail ainda). Esse cookie era tratado por
 * `handleVote` (vote.ts) como identidade REAL, sobrepondo o e-mail em todo o
 * resto do voto — permitindo que qualquer um se cadastrasse com o e-mail de
 * outra pessoa e votasse/pontuasse sob a identidade dela sem nunca confirmar
 * o e-mail.
 *
 * Fix: `issueWebSessionCookie` ganha um marcador de estado ("pending" |
 * "confirmed") embutido no payload assinado (prefixo "pending:", nunca
 * colide com e-mail real — ":" é rejeitado por isValidVoteEmailFormat).
 * `handleJogarGateSubscribe` emite "pending" (a confirmação da Beehiiv segue
 * em paralelo). `handleVote` só aplica o override de identidade quando a
 * sessão é "confirmed". O gate por rodada (`handleJogarPage`) aceita
 * QUALQUER sessão (pending ou confirmed) — seu único objetivo é liberar o
 * jogo, não decidir identidade de escrita.
 *
 * #6293 (correção subsequente, ver `test/poll-web-gate-possession-6293.test.ts`):
 * `handleJogarGateVerify` promovia a "confirmed" qualquer e-mail que
 * `checkWebSubscriber` visse como "active" — o que deixou de provar posse
 * desde o #5095 (`double_opt_override: "off"`). Hoje `handleJogarGateVerify`
 * só emite "confirmed" quando o e-mail já provou posse via magic link
 * (`hasProvenEmailPossession`, magic-link.ts); sem o marcador, emite
 * "pending" — o teste correspondente aqui foi atualizado (era o que
 * documentava, com "comportamento inalterado", o comportamento que o #6293
 * corrigiu).
 *
 * Também cobre o achado relacionado (mesma issue, comentário do editor
 * 260727): `handleJogarGateSubscribe`/`handleJogarGateVerify` não bloqueavam
 * o domínio reservado da identidade anônima do brand `web`
 * (`@web.eia.diaria.local`) — `isValidEmailFormat` só valida a FORMA
 * genérica, não `isAnonymousWebIdentity`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { type Env } from "../workers/poll/src/index.ts";
import {
  issueWebSessionCookie,
  readWebSession,
  readWebSessionEmail,
  WEB_SESSION_COOKIE,
  ROUNDS_PLAYED_COOKIE,
} from "../workers/poll/src/web-gate.ts";
import { signSessionCookie } from "../workers/poll/src/session-cookie.ts";

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

describe("#4121: readWebSession — marcador pending/confirmed embutido no payload assinado", () => {
  it('issueWebSessionCookie com state="pending" → pending:true, email correto (sem o prefixo)', async () => {
    const setCookie = await issueWebSessionCookie("s", "a@b.com", "pending");
    const raw = setCookie.split(";")[0].split("=")[1];
    const session = await readWebSession("s", `${WEB_SESSION_COOKIE}=${raw}`);
    assert.deepEqual(session, { email: "a@b.com", pending: true });
  });

  it('issueWebSessionCookie com state="confirmed" explícito → pending:false', async () => {
    const setCookie = await issueWebSessionCookie("s", "a@b.com", "confirmed");
    const raw = setCookie.split(";")[0].split("=")[1];
    const session = await readWebSession("s", `${WEB_SESSION_COOKIE}=${raw}`);
    assert.deepEqual(session, { email: "a@b.com", pending: false });
  });

  it("cookie LEGADO (emitido antes do #4121, sem o prefixo pending:) → tratado como confirmed", async () => {
    // Simula um cookie assinado pré-#4121: signSessionCookie direto com o
    // e-mail cru, sem passar por issueWebSessionCookie/o prefixo novo.
    const legacyValue = await signSessionCookie("s", "legado@example.com", 3600);
    const session = await readWebSession("s", `${WEB_SESSION_COOKIE}=${encodeURIComponent(legacyValue)}`);
    assert.deepEqual(session, { email: "legado@example.com", pending: false }, "ausência do marcador deve ser tratada como confirmed (decisão do editor #4121)");
  });

  it("readWebSessionEmail (retrocompat) retorna o e-mail independente do estado", async () => {
    const pendingCookie = await issueWebSessionCookie("s", "pend@b.com", "pending");
    const rawPending = pendingCookie.split(";")[0].split("=")[1];
    assert.equal(await readWebSessionEmail("s", `${WEB_SESSION_COOKIE}=${rawPending}`), "pend@b.com");

    const confirmedCookie = await issueWebSessionCookie("s", "conf@b.com", "confirmed");
    const rawConfirmed = confirmedCookie.split(";")[0].split("=")[1];
    assert.equal(await readWebSessionEmail("s", `${WEB_SESSION_COOKIE}=${rawConfirmed}`), "conf@b.com");
  });
});

describe("#4121: handleJogarGateSubscribe emite cookie PENDING (não confirmed)", () => {
  it("cadastro bem-sucedido → cookie de sessão é PENDING (readWebSession confirma pending:true)", async () => {
    const env = makeEnv({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: "pub_test" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { id: "sub_1" } }), { status: 201 })) as typeof fetch;
    try {
      const res = await worker.fetch(
        new Request("https://poll.test/jogar/gate/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "novo@example.com", optin: true }),
        }),
        env,
      );
      assert.equal(res.status, 200);
      const setCookie = getCookieHeader(res);
      assert.ok(setCookie, "deve emitir cookie de sessão");
      const raw = setCookie!.split(";")[0].split("=")[1];
      const session = await readWebSession("cookie-secret", `${WEB_SESSION_COOKIE}=${raw}`);
      assert.deepEqual(session, { email: "novo@example.com", pending: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("#6293: handleJogarGateVerify — 'active' sozinho NÃO promove mais a CONFIRMED", () => {
  it("assinante ativo SEM posse provada → cookie de sessão é PENDING (correção do #6293)", async () => {
    const { subscriberKvKey } = await import("../workers/poll/src/subscriber-verify.ts");
    const email = "ativo@example.com";
    const key = await subscriberKvKey(email);
    const env = makeEnv({ SUBSCRIBERS_KV: makeMapKV({ [key]: "1" }) as unknown as KVNamespace });
    const res = await worker.fetch(
      new Request("https://poll.test/jogar/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const setCookie = getCookieHeader(res);
    const raw = setCookie!.split(";")[0].split("=")[1];
    const session = await readWebSession("cookie-secret", `${WEB_SESSION_COOKIE}=${raw}`);
    assert.deepEqual(session, { email, pending: true }, "active na Beehiiv/KV não é mais prova de posse — só o marcador de magic link é");
  });
});

describe("#4121: GET /vote?brand=web — override de identidade só com sessão CONFIRMED", () => {
  it("sessão PENDING → NÃO sobrepõe identidade, voto continua sob o token anônimo", async () => {
    const env = makeEnv();
    const pendingCookie = (await issueWebSessionCookie("cookie-secret", "vitima@example.com", "pending")).split(";")[0];
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(VALID_EMAIL)}&edition=260701&choice=A&brand=web`, {
        headers: { Cookie: pendingCookie },
      }),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(env.POLL._map.has(`web:vote:260701:${VALID_EMAIL}`), "voto deve continuar sob o token — sessão pending não prova posse do e-mail");
    assert.ok(!env.POLL._map.has("web:vote:260701:vitima@example.com"), "NUNCA deve gravar sob o e-mail da sessão pending");
  });

  it("sessão CONFIRMED → sobrepõe identidade normalmente (comportamento pré-#4121 preservado)", async () => {
    const env = makeEnv();
    const confirmedCookie = (await issueWebSessionCookie("cookie-secret", "real@example.com", "confirmed")).split(";")[0];
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(VALID_EMAIL)}&edition=260701&choice=A&brand=web`, {
        headers: { Cookie: confirmedCookie },
      }),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(env.POLL._map.has("web:vote:260701:real@example.com"));
    assert.ok(!env.POLL._map.has(`web:vote:260701:${VALID_EMAIL}`));
  });

  it("cookie LEGADO (sem marcador, pré-#4121) → continua sobrepondo (tratado como confirmed)", async () => {
    const env = makeEnv();
    const legacyValue = await signSessionCookie("cookie-secret", "legado@example.com", 3600);
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(VALID_EMAIL)}&edition=260701&choice=A&brand=web`, {
        headers: { Cookie: `${WEB_SESSION_COOKIE}=${encodeURIComponent(legacyValue)}` },
      }),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(env.POLL._map.has("web:vote:260701:legado@example.com"), "cookie legado sem marcador deve continuar sobrepondo (retrocompat)");
  });
});

describe("#4121: gate por rodada (handleJogarPage) — sessão PENDING ainda libera o jogo", () => {
  it("cookie de rodada livre usada + sessão PENDING → jogo normal, SEM gate (pending já libera continuar jogando)", async () => {
    const env = makeEnv();
    const pendingCookie = (await issueWebSessionCookie("cookie-secret", "leitor@example.com", "pending")).split(";")[0];
    const res = await worker.fetch(
      new Request("https://poll.test/jogar", {
        headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5; ${pendingCookie}` },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /Quer disputar o ranking\?/, "sessão pending deve liberar o gate, mesmo sem confirmação da Beehiiv");
  });
});

describe("#4121 (achado relacionado): domínio reservado da identidade anônima é rejeitado no gate", () => {
  it("handleJogarGateSubscribe rejeita e-mail sob @web.eia.diaria.local", async () => {
    const env = makeEnv({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: "pub_test" });
    const res = await worker.fetch(
      new Request("https://poll.test/jogar/gate/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: VALID_EMAIL, optin: true }),
      }),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal(getCookieHeader(res), null);
  });

  it("handleJogarGateVerify rejeita e-mail sob @web.eia.diaria.local mesmo se 'ativo' no KV", async () => {
    const { subscriberKvKey } = await import("../workers/poll/src/subscriber-verify.ts");
    const key = await subscriberKvKey(VALID_EMAIL);
    const env = makeEnv({ SUBSCRIBERS_KV: makeMapKV({ [key]: "1" }) as unknown as KVNamespace });
    const res = await worker.fetch(
      new Request("https://poll.test/jogar/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: VALID_EMAIL }),
      }),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal(getCookieHeader(res), null);
  });
});
