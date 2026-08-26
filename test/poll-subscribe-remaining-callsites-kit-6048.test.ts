/**
 * test/poll-subscribe-remaining-callsites-kit-6048.test.ts (#6048 rollout —
 * 4 call sites restantes)
 *
 * O rollout original do #6048 (`subscribe.ts:585-591`, `handleJogarSubscribe`)
 * ramificou por `env.SUBSCRIBE_BACKEND === "kit"` em SÓ 1 dos 5 pontos de
 * cadastro do worker `poll` — os outros 4 continuavam chamando
 * `subscribeToBeehiiv` incondicionalmente, mesmo com `SUBSCRIBE_BACKEND: "kit"`
 * configurado. Confirmado AO VIVO em 26/08/2026: `POST /jogar/gate/subscribe`
 * em `eia.diar.ia.br` respondeu `{"ok":true}` mas o contato foi criado na
 * Beehiiv, não no Kit (Kit consultado com `status=all` → `n=0`).
 *
 * Esta suíte cobre os 4 call sites que faltavam, mesmo padrão de mock de
 * fetch (sem rede real, #633) das suítes já mergeadas
 * (`poll-jogar-inline-signup-kit-6048.test.ts`):
 *
 *   1. `handleJogarGateSubscribe` (web-gate.ts) — `POST /jogar/gate/subscribe`
 *   2. `handleJogarIdentify` (identify.ts) — opt-in do form de identidade
 *   3. `handleSetName` (index.ts) — caixa clarice do `/set-name`
 *   4. `handleConfirmMerge` (magic-link.ts) — opt-in confirmado por link de
 *      e-mail
 *
 * Cada um: com `SUBSCRIBE_BACKEND: "kit"` o cadastro vai pro Kit; ausente ou
 * `"beehiiv"` mantém o caminho pré-existente (regressão).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleJogarGateSubscribe } from "../workers/poll/src/web-gate.ts";
import { handleJogarIdentify } from "../workers/poll/src/identify.ts";
import { handleConfirmMerge, createPendingMerge } from "../workers/poll/src/magic-link.ts";
import worker, { hmacSign, handleSetName, type Env } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

const ANON_A = "33333333-3333-4333-8333-333333333333@web.eia.diaria.local";

/** Fake fetch — NUNCA rede real (#633). Registra chamadas por URL. */
function makeFakeFetch(status = 201) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "sub_1", subscriber: { id: 1 } }), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function baseEnv(seed: Record<string, string> = {}, extra: Partial<Env> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return {
    POLL: makeTrackedKv(seed),
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
    COOKIE_HMAC_SECRET: "cookie-secret",
    ...extra,
  } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
}

function beehiivEnv(seed: Record<string, string> = {}, extra: Partial<Env> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return baseEnv(seed, {
    BEEHIIV_API_KEY: "test-key",
    BEEHIIV_PUBLICATION_ID: "pub_test",
    BEEHIIV_API_URL: "https://beehiiv.test/v2",
    ...extra,
  });
}

function kitEnv(seed: Record<string, string> = {}, extra: Partial<Env> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return baseEnv(seed, {
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "test-kit-key",
    KIT_API_URL: "https://kit.test/v4",
    ...extra,
  });
}

// ── 1. handleJogarGateSubscribe (web-gate.ts) ───────────────────────────────

function gateSubscribeReq(body: unknown): Request {
  return new Request("https://poll.test/jogar/gate/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleJogarGateSubscribe — seleção de backend via env.SUBSCRIBE_BACKEND (#6048)", () => {
  it("SUBSCRIBE_BACKEND ausente: usa Beehiiv (default, regressão)", async () => {
    const { fn, calls } = makeFakeFetch(201);
    const env = beehiivEnv();
    const res = await handleJogarGateSubscribe(gateSubscribeReq({ email: "a@b.com", optin: true }), env, { fetchImpl: fn });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /beehiiv\.test/);
  });

  it('SUBSCRIBE_BACKEND: "kit" → chama o Kit, não a Beehiiv', async () => {
    const { fn, calls } = makeFakeFetch(201);
    const env = kitEnv();
    const res = await handleJogarGateSubscribe(gateSubscribeReq({ email: "a@b.com", optin: true }), env, { fetchImpl: fn });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://kit.test/v4/subscribers");
  });

  it('SUBSCRIBE_BACKEND: "kit" sem KIT_API_KEY → 503 amigável (not_configured), igual ao caminho Beehiiv', async () => {
    const { fn, calls } = makeFakeFetch(201);
    const env = baseEnv({}, { SUBSCRIBE_BACKEND: "kit" });
    const res = await handleJogarGateSubscribe(gateSubscribeReq({ email: "a@b.com", optin: true }), env, { fetchImpl: fn });
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0);
  });

  it('SUBSCRIBE_BACKEND: "kit" e o Kit responde erro real (422) → 502 (subscribe_failed), único branch real de handleJogarGateSubscribe além de not_configured/ok', async () => {
    const { fn, calls } = makeFakeFetch(422);
    const env = kitEnv();
    const res = await handleJogarGateSubscribe(gateSubscribeReq({ email: "a@b.com", optin: true }), env, { fetchImpl: fn });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "subscribe_failed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://kit.test/v4/subscribers", "sanity: a chamada foi de fato pro Kit, não pra Beehiiv");
  });

  it('SUBSCRIBE_BACKEND: "kit" e o fetch pro Kit lança exceção (rede fora do ar) → 502, mesmo tratamento do erro HTTP', async () => {
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const env = kitEnv();
    const res = await handleJogarGateSubscribe(gateSubscribeReq({ email: "a@b.com", optin: true }), env, { fetchImpl: throwingFetch });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.error, "subscribe_failed");
  });
});

// ── 2. handleJogarIdentify (identify.ts) ────────────────────────────────────

function identifyReq(body: unknown): Request {
  return new Request("https://poll.test/jogar/identify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleJogarIdentify — seleção de backend via bEnv.SUBSCRIBE_BACKEND (#6048)", () => {
  it("SUBSCRIBE_BACKEND ausente: opt-in vai pra Beehiiv (default, regressão)", async () => {
    const { fn, calls } = makeFakeFetch(201);
    const env = beehiivEnv();
    const res = await handleJogarIdentify(
      identifyReq({ name: "Ana", email: "ana@x.com", anonEmail: ANON_A, optin: true, edition: "" }),
      env,
      { fetchImpl: fn },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; subscribed: boolean };
    assert.equal(body.subscribed, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /beehiiv\.test/);
  });

  it('SUBSCRIBE_BACKEND: "kit" → opt-in chama o Kit, não a Beehiiv', async () => {
    const { fn, calls } = makeFakeFetch(201);
    const env = kitEnv();
    const res = await handleJogarIdentify(
      identifyReq({ name: "Ana", email: "ana@x.com", anonEmail: ANON_A, optin: true, edition: "" }),
      env,
      { fetchImpl: fn },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; subscribed: boolean };
    assert.equal(body.subscribed, true, "REGRESSÃO #6048: Kit também deve reportar subscribed:true no sucesso");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://kit.test/v4/subscribers");
  });

  it('SUBSCRIBE_BACKEND: "kit" sem KIT_API_KEY → subscribed:false, loga identify_optin_not_subscribed (mesmo fail-soft do caminho Beehiiv)', async () => {
    const { fn, calls } = makeFakeFetch(201);
    const env = baseEnv({}, { SUBSCRIBE_BACKEND: "kit" });
    const logged: string[] = [];
    const original = console.error;
    console.error = (msg: string) => logged.push(msg);
    let res: Response;
    try {
      res = await handleJogarIdentify(
        identifyReq({ name: "Ana", email: "ana@x.com", anonEmail: ANON_A, optin: true, edition: "" }),
        env,
        { fetchImpl: fn },
      );
    } finally {
      console.error = original;
    }
    assert.equal(res.status, 200, "identificação/merge de score não pode falhar por causa do opt-in best-effort");
    const body = (await res.json()) as { ok: boolean; subscribed: boolean };
    assert.equal(body.subscribed, false);
    assert.equal(calls.length, 0);
    assert.ok(logged.some((l) => l.includes("identify_optin_not_subscribed")));
  });
});

// ── 3. handleSetName (index.ts) — caixa clarice do /set-name ───────────────

describe("handleSetName — seleção de backend via env.SUBSCRIBE_BACKEND (#6048, caixa clarice)", () => {
  const SECRET = "setname-secret";

  async function setNameUrl(email: string, name: string, optin: boolean): Promise<URL> {
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", email);
    url.searchParams.set("name", name);
    url.searchParams.set("sig", sig);
    url.searchParams.set("brand", "clarice");
    if (optin) url.searchParams.set("optin", "on");
    return url;
  }

  function makeSetNameEnv(email: string, extra: Partial<Env> = {}): Env {
    return {
      POLL: makeTrackedKv({ [`score:${email}`]: JSON.stringify({ total: 1, nickname: null }) }) as unknown as KVNamespace,
      POLL_SECRET: SECRET,
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
      ...extra,
    };
  }

  it("SUBSCRIBE_BACKEND ausente: opt-in vai pra Beehiiv (default, regressão)", async () => {
    const email = "clarice-beehiiv@example.com";
    const env = makeSetNameEnv(email, {
      BEEHIIV_API_KEY: "test-key",
      BEEHIIV_PUBLICATION_ID: "pub_test",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
    });
    const originalFetch = globalThis.fetch;
    const { fn, calls } = makeFakeFetch(201);
    globalThis.fetch = fn;
    try {
      const res = await handleSetName(await setNameUrl(email, "Ana", true), env, "clarice");
      assert.equal(res.status, 302, "sucesso redireciona pro leaderboard (§2c/§3, #4418)");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /beehiiv\.test/);
  });

  it('SUBSCRIBE_BACKEND: "kit" → opt-in chama o Kit, não a Beehiiv', async () => {
    const email = "clarice-kit@example.com";
    const env = makeSetNameEnv(email, {
      SUBSCRIBE_BACKEND: "kit",
      KIT_API_KEY: "test-kit-key",
      KIT_API_URL: "https://kit.test/v4",
    });
    const originalFetch = globalThis.fetch;
    const { fn, calls } = makeFakeFetch(201);
    globalThis.fetch = fn;
    try {
      const res = await handleSetName(await setNameUrl(email, "Ana", true), env, "clarice");
      assert.equal(res.status, 302);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://kit.test/v4/subscribers");
  });

  it('SUBSCRIBE_BACKEND: "kit" sem KIT_API_KEY → apelido salvo mesmo assim (fail-soft, #4438 preservado)', async () => {
    const email = "clarice-kit-sem-key@example.com";
    const env = makeSetNameEnv(email, { SUBSCRIBE_BACKEND: "kit" });
    const originalFetch = globalThis.fetch;
    const { fn, calls } = makeFakeFetch(201);
    globalThis.fetch = fn;
    let res: Response;
    try {
      res = await handleSetName(await setNameUrl(email, "Ana", true), env, "clarice");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(res.status, 302, "apelido salvo mesmo com not_configured — cadastro é best-effort");
    assert.equal(calls.length, 0);
    const score = JSON.parse((await (env.POLL as unknown as ReturnType<typeof makeTrackedKv>).get(`score:${email}`))!);
    assert.equal(score.nickname, "Ana");
  });
});

// ── 4. handleConfirmMerge (magic-link.ts) ───────────────────────────────────

describe("handleConfirmMerge — seleção de backend via bEnv.SUBSCRIBE_BACKEND (#6048)", () => {
  it("SUBSCRIBE_BACKEND ausente: opt-in confirmado por link vai pra Beehiiv (default, regressão)", async () => {
    const env = beehiivEnv({
      "score:bia@x.com": JSON.stringify({ total: 5, correct: 4, streak: 1, last_edition: "260601", nickname: "Bia" }),
    });
    const token = await createPendingMerge(env, { email: "bia@x.com", anonEmail: ANON_A, name: "Bia", edition: "", optin: true });
    const { fn, calls } = makeFakeFetch(201);
    const res = await handleConfirmMerge(new URL(`https://eia.diar.ia.br/confirm-merge?token=${token}&brand=web`), env, { fetchImpl: fn });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /beehiiv\.test/);
  });

  it('SUBSCRIBE_BACKEND: "kit" → opt-in confirmado por link chama o Kit, não a Beehiiv', async () => {
    const env = kitEnv({
      "score:cid@x.com": JSON.stringify({ total: 5, correct: 4, streak: 1, last_edition: "260601", nickname: "Cid" }),
    });
    const token = await createPendingMerge(env, { email: "cid@x.com", anonEmail: ANON_A, name: "Cid", edition: "", optin: true });
    const { fn, calls } = makeFakeFetch(201);
    const res = await handleConfirmMerge(new URL(`https://eia.diar.ia.br/confirm-merge?token=${token}&brand=web`), env, { fetchImpl: fn });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://kit.test/v4/subscribers");
  });

  it('SUBSCRIBE_BACKEND: "kit" sem KIT_API_KEY → merge de score não é afetado (best-effort, sem chamada de rede)', async () => {
    const env = baseEnv(
      { "score:dan@x.com": JSON.stringify({ total: 2, correct: 1, streak: 1, last_edition: "260601", nickname: "Dan" }) },
      { SUBSCRIBE_BACKEND: "kit" },
    );
    const token = await createPendingMerge(env, { email: "dan@x.com", anonEmail: ANON_A, name: "Dan", edition: "", optin: true });
    const { fn, calls } = makeFakeFetch(201);
    const res = await handleConfirmMerge(new URL(`https://eia.diar.ia.br/confirm-merge?token=${token}&brand=web`), env, { fetchImpl: fn });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0);
    const merged = JSON.parse((await env.POLL.get("score:dan@x.com"))!);
    assert.equal(merged.total, 2, "merge de score aconteceu independente do resultado do opt-in");
  });
});

// ── sanity: worker.fetch fim-a-fim continua roteando pro handler certo ─────

describe("#6048 sanity: fiação de produção do gate continua intacta", () => {
  it("worker.fetch POST /jogar/gate/subscribe com SUBSCRIBE_BACKEND=kit chega no Kit via o dispatch real", async () => {
    const env = kitEnv();
    const originalFetch = globalThis.fetch;
    const { fn, calls } = makeFakeFetch(201);
    globalThis.fetch = fn;
    try {
      const res = await worker.fetch(gateSubscribeReq({ email: "producao@example.com", optin: true }), env);
      assert.equal(res.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://kit.test/v4/subscribers");
  });
});
