/**
 * test/poll-jogar-inline-signup-3580.test.ts (#3580)
 *
 * Cadastro INLINE no fim do fluxo do jogo "É IA?" standalone (brand `web`):
 * nome + e-mail + opt-in → assina direto na Beehiiv sem sair da página
 * (`POST /jogar/subscribe`). Cobre os critérios de aceite #633:
 *   - o form aparece no fim do fluxo web (`/jogar` pós-voto + fim do quiz),
 *     hidden por padrão (anti-spoiler)
 *   - submit válido chama o mecanismo de assinatura (Beehiiv, MOCKADO — sem
 *     rede real)
 *   - opt-in NÃO marcado NÃO assina (nem chama a Beehiiv)
 *   - e-mail inválido é rejeitado (server-side)
 *   - honeypot preenchido é descartado (200 fake-success, sem assinar)
 *   - rate-limit por IP bloqueia flood
 *   - respeita double opt-in (não manda `double_opt_override`)
 *   - segredo Beehiiv ausente → 503 amigável (não 500)
 *   - regressão: não quebra o CTA-link #3518 nem o voto/quiz
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkSubscribeRateLimit,
  handleJogarSubscribe,
  parseSubscribeBody,
  SUBSCRIBE_RATE_LIMIT,
  subscribeToBeehiiv,
  validateSubscribeInput,
} from "../workers/poll/src/subscribe.ts";
import {
  inlineSignupScript,
  renderInlineSignupFormBlock,
  renderJogarPageHtml,
  renderJogarQuizPageHtml,
} from "../workers/poll/src/jogar.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

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

type FetchMock = typeof fetch & { calls: Array<{ url: string; init: RequestInit | undefined }> };
function makeFetchMock(status = 201): FetchMock {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: { id: "sub_1" } }), { status });
  }) as FetchMock;
  fn.calls = calls;
  return fn;
}

const baseEnv = (over: Partial<Env> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
  POLL: makeMapKV(),
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
  ...over,
}) as Env & { POLL: ReturnType<typeof makeMapKV> };

const beehiivEnv = (poll = makeMapKV()): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
  POLL: poll,
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
  BEEHIIV_API_KEY: "test-key",
  BEEHIIV_PUBLICATION_ID: "pub_test",
  BEEHIIV_API_URL: "https://beehiiv.test/v2",
}) as Env & { POLL: ReturnType<typeof makeMapKV> };

function subReq(body: unknown, opts: { contentType?: string; ip?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": opts.contentType ?? "application/json" };
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  return new Request("https://poll.test/jogar/subscribe", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ── parseSubscribeBody ──────────────────────────────────────────────────────

describe("parseSubscribeBody (#3580)", () => {
  it("parseia JSON com name/email/optin/honeypot", () => {
    const p = parseSubscribeBody(
      JSON.stringify({ name: "Ana", email: "ana@example.com", optin: true, website: "" }),
      "application/json",
    );
    assert.deepEqual(p, { name: "Ana", email: "ana@example.com", optin: true, honeypot: "" });
  });

  it("aceita optin como string 'on' (form nativo)", () => {
    const p = parseSubscribeBody(JSON.stringify({ email: "x@y.com", optin: "on" }), "application/json");
    assert.equal(p.optin, true);
  });

  it("parseia application/x-www-form-urlencoded (fallback sem JS)", () => {
    const p = parseSubscribeBody("name=Bob&email=bob%40y.com&optin=on&website=", "application/x-www-form-urlencoded");
    assert.equal(p.name, "Bob");
    assert.equal(p.email, "bob@y.com");
    assert.equal(p.optin, true);
  });

  it("JSON malformado → input vazio (nunca lança)", () => {
    const p = parseSubscribeBody("{ not json", "application/json");
    assert.deepEqual(p, { name: "", email: "", optin: false, honeypot: "" });
  });
});

// ── validateSubscribeInput ──────────────────────────────────────────────────

describe("validateSubscribeInput (#3580)", () => {
  it("honeypot preenchido → status 200 error honeypot (descarte silencioso)", () => {
    const v = validateSubscribeInput({ name: "", email: "a@b.com", optin: true, honeypot: "bot" });
    assert.deepEqual(v, { ok: false, status: 200, error: "honeypot" });
  });

  it("opt-in NÃO marcado → 400 optin_required (consentimento LGPD obrigatório)", () => {
    const v = validateSubscribeInput({ name: "Ana", email: "a@b.com", optin: false, honeypot: "" });
    assert.deepEqual(v, { ok: false, status: 400, error: "optin_required" });
  });

  it("e-mail inválido → 400 invalid_email", () => {
    const v = validateSubscribeInput({ name: "Ana", email: "not-an-email", optin: true, honeypot: "" });
    assert.deepEqual(v, { ok: false, status: 400, error: "invalid_email" });
  });

  it("válido → ok com nome trimado e cortado em 100 chars", () => {
    const longName = "x".repeat(200);
    const v = validateSubscribeInput({ name: `  ${longName}  `, email: " a@b.com ", optin: true, honeypot: "" });
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.email, "a@b.com");
      assert.equal(v.name.length, 100);
    }
  });
});

// ── checkSubscribeRateLimit ─────────────────────────────────────────────────

describe("checkSubscribeRateLimit (#3580)", () => {
  it("permite abaixo do limite e incrementa o contador", async () => {
    const kv = makeMapKV();
    const r1 = await checkSubscribeRateLimit(kv as unknown as KVNamespace, "1.2.3.4", 3, 3600);
    assert.deepEqual(r1, { allowed: true, count: 1 });
    const r2 = await checkSubscribeRateLimit(kv as unknown as KVNamespace, "1.2.3.4", 3, 3600);
    assert.equal(r2.count, 2);
  });

  it("bloqueia ao atingir o limite", async () => {
    const kv = makeMapKV();
    for (let i = 0; i < 3; i++) await checkSubscribeRateLimit(kv as unknown as KVNamespace, "1.2.3.4", 3, 3600);
    const blocked = await checkSubscribeRateLimit(kv as unknown as KVNamespace, "1.2.3.4", 3, 3600);
    assert.equal(blocked.allowed, false);
  });

  it("sem IP → permite (as outras barreiras continuam valendo)", async () => {
    const kv = makeMapKV();
    const r = await checkSubscribeRateLimit(kv as unknown as KVNamespace, "", 3, 3600);
    assert.deepEqual(r, { allowed: true, count: 0 });
  });
});

// ── subscribeToBeehiiv ──────────────────────────────────────────────────────

describe("subscribeToBeehiiv (#3580)", () => {
  it("secrets ausentes → not_configured (503), sem tocar a rede", async () => {
    const fetchMock = makeFetchMock();
    const r = await subscribeToBeehiiv(baseEnv(), { name: "Ana", email: "a@b.com" }, fetchMock);
    assert.deepEqual(r, { ok: false, status: 503, reason: "not_configured" });
    assert.equal(fetchMock.calls.length, 0);
  });

  it("POSTa pra /publications/{id}/subscriptions com Bearer + e-mail + UTM do funil", async () => {
    const fetchMock = makeFetchMock(201);
    const r = await subscribeToBeehiiv(beehiivEnv(), { name: "", email: "ana@example.com" }, fetchMock);
    assert.equal(r.ok, true);
    assert.equal(fetchMock.calls.length, 1);
    const call = fetchMock.calls[0];
    assert.equal(call.url, "https://beehiiv.test/v2/publications/pub_test/subscriptions");
    assert.equal(call.init?.method, "POST");
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-key");
    const body = JSON.parse(String(call.init?.body));
    assert.equal(body.email, "ana@example.com");
    assert.equal(body.utm_source, "eia-standalone");
    assert.equal(body.utm_medium, "jogar-inline");
  });

  it("respeita double opt-in — NÃO manda double_opt_override; manda send_welcome_email", async () => {
    const fetchMock = makeFetchMock(201);
    await subscribeToBeehiiv(beehiivEnv(), { name: "", email: "a@b.com" }, fetchMock);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal("double_opt_override" in body, false);
    assert.equal(body.send_welcome_email, true);
  });

  it("nome só vai como custom_field quando BEEHIIV_NAME_FIELD está configurado", async () => {
    const fetchMock = makeFetchMock(201);
    // sem BEEHIIV_NAME_FIELD → nome NÃO vai (degrada com graça)
    await subscribeToBeehiiv(beehiivEnv(), { name: "Ana", email: "a@b.com" }, fetchMock);
    const body1 = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal("custom_fields" in body1, false);

    // com BEEHIIV_NAME_FIELD → nome vai no custom field
    const fetchMock2 = makeFetchMock(201);
    const env2 = beehiivEnv();
    env2.BEEHIIV_NAME_FIELD = "Nome";
    await subscribeToBeehiiv(env2, { name: "Ana", email: "a@b.com" }, fetchMock2);
    const body2 = JSON.parse(String(fetchMock2.calls[0].init?.body));
    assert.deepEqual(body2.custom_fields, [{ name: "Nome", value: "Ana" }]);
  });

  it("Beehiiv responde erro → beehiiv_error com o status", async () => {
    const fetchMock = makeFetchMock(422);
    const r = await subscribeToBeehiiv(beehiivEnv(), { name: "", email: "a@b.com" }, fetchMock);
    assert.deepEqual(r, { ok: false, status: 422, reason: "beehiiv_error" });
  });
});

// ── handleJogarSubscribe (endpoint) ─────────────────────────────────────────

describe("handleJogarSubscribe (#3580) — submit válido chama a assinatura (mock)", () => {
  it("opt-in marcado + e-mail válido → 200 ok e chama a Beehiiv", async () => {
    const fetchMock = makeFetchMock(201);
    const res = await handleJogarSubscribe(
      subReq({ name: "Ana", email: "ana@example.com", optin: true, website: "" }, { ip: "9.9.9.9" }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(fetchMock.calls.length, 1);
  });

  it("opt-in NÃO marcado → 400 optin_required e NÃO chama a Beehiiv", async () => {
    const fetchMock = makeFetchMock(201);
    const res = await handleJogarSubscribe(
      subReq({ name: "Ana", email: "ana@example.com", optin: false }, { ip: "9.9.9.9" }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: "optin_required" });
    assert.equal(fetchMock.calls.length, 0);
  });

  it("e-mail inválido → 400 invalid_email e NÃO chama a Beehiiv", async () => {
    const fetchMock = makeFetchMock(201);
    const res = await handleJogarSubscribe(
      subReq({ email: "nope", optin: true }, { ip: "9.9.9.9" }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 400);
    assert.equal(fetchMock.calls.length, 0);
  });

  it("honeypot preenchido → 200 fake-success e NÃO chama a Beehiiv", async () => {
    const fetchMock = makeFetchMock(201);
    const res = await handleJogarSubscribe(
      subReq({ email: "ana@example.com", optin: true, website: "http://spam" }, { ip: "9.9.9.9" }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(fetchMock.calls.length, 0);
  });

  it("rate-limit por IP bloqueia após o limite (429) sem chamar a Beehiiv a mais", async () => {
    const fetchMock = makeFetchMock(201);
    const env = beehiivEnv();
    let last: Response | null = null;
    for (let i = 0; i < SUBSCRIBE_RATE_LIMIT; i++) {
      last = await handleJogarSubscribe(
        subReq({ email: `u${i}@example.com`, optin: true }, { ip: "5.5.5.5" }),
        env,
        { fetchImpl: fetchMock },
      );
    }
    assert.equal(last?.status, 200);
    const blocked = await handleJogarSubscribe(
      subReq({ email: "over@example.com", optin: true }, { ip: "5.5.5.5" }),
      env,
      { fetchImpl: fetchMock },
    );
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { ok: false, error: "rate_limited" });
    // Beehiiv chamada só nos que passaram o rate-limit, nunca no bloqueado.
    assert.equal(fetchMock.calls.length, SUBSCRIBE_RATE_LIMIT);
  });
});

describe("POST /jogar/subscribe via worker.fetch (#3580) — roteamento + secret ausente", () => {
  it("secret Beehiiv ausente → 503 subscribe_unavailable (não 500)", async () => {
    const res = await worker.fetch(
      subReq({ email: "ana@example.com", optin: true }, { ip: "8.8.8.8" }),
      baseEnv(),
    );
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: "subscribe_unavailable" });
  });

  it("opt-in ausente via worker.fetch → 400 (validação antes de qualquer rede)", async () => {
    const res = await worker.fetch(
      subReq({ email: "ana@example.com", optin: false }, { ip: "8.8.8.8" }),
      baseEnv(),
    );
    assert.equal(res.status, 400);
  });

  it("GET /jogar/subscribe → não roteia (cai no 404, endpoint é POST-only)", async () => {
    const res = await worker.fetch(new Request("https://poll.test/jogar/subscribe"), baseEnv());
    assert.equal(res.status, 404);
  });
});

// ── render: form aparece no fim do fluxo web ────────────────────────────────

describe("renderInlineSignupFormBlock (#3580)", () => {
  it("tem form id, campos nome/e-mail, checkbox opt-in e honeypot, hidden por padrão", () => {
    const html = renderInlineSignupFormBlock();
    assert.match(html, /<form id="jogar-signup-form" class="signup-form" hidden/);
    assert.match(html, /name="name"/);
    assert.match(html, /name="email"/);
    assert.match(html, /type="checkbox" name="optin"/);
    // honeypot (`website`) presente, dentro do container invisível.
    assert.match(html, /class="signup-hp"/);
    assert.match(html, /name="website"/);
  });

  it("copy do opt-in é o consentimento explícito (notícias + tutoriais + par diário)", () => {
    const html = renderInlineSignupFormBlock();
    assert.match(html, /Quero receber a Diar\.ia/i);
  });
});

describe("GET /jogar embute o form inline (#3580)", () => {
  it("form presente, hidden, e o script POSTa pra /jogar/subscribe", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(html, /id="jogar-signup-form"/);
    assert.match(html, /<form id="jogar-signup-form" class="signup-form" hidden/);
    assert.match(html, /fetch\("\/jogar\/subscribe"/);
  });

  it("revela o form no caminho de voto NOVO e no de 'já votou' (mesma disciplina anti-spoiler)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    // já-votou
    assert.match(html, /if \(subscribeCta\) subscribeCta\.hidden = false;\s*\n\s*if \(signupForm\) signupForm\.hidden = false;/);
    // var signupForm declarado uma única vez no script de reveal (reusado nos
    // 2 caminhos). O inlineSignupScript faz sua PRÓPRIA query separada — por
    // isso conta o `var ... =`, não todas as ocorrências de getElementById.
    const occ = html.match(/var signupForm = document\.getElementById\("jogar-signup-form"\)/g) ?? [];
    assert.equal(occ.length, 1);
  });

  it("form vem no HTML mas hidden — nunca visível antes do voto (anti-spoiler)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: true });
    assert.match(html, /<form id="jogar-signup-form" class="signup-form" hidden/);
  });
});

describe("GET /jogar/quiz embute o form inline (#3580)", () => {
  it("quiz não-vazio: form presente (hidden) e revelado no showFinal", () => {
    const html = renderJogarQuizPageHtml(["260101", "260102", "260103"]);
    assert.match(html, /id="jogar-signup-form"/);
    assert.match(html, /if \(signupForm\) signupForm\.hidden = false;/);
    assert.match(html, /fetch\("\/jogar\/subscribe"/);
  });

  it("quiz vazio (sem edições fechadas): não renderiza o form", () => {
    const html = renderJogarQuizPageHtml([]);
    assert.doesNotMatch(html, /id="jogar-signup-form"/);
  });
});

// ── regressão: não quebra o CTA-link #3518 ──────────────────────────────────

describe("regressão #3518/#3516 (#3580) — CTA-link e voto intactos", () => {
  it("CTA-link #jogar-subscribe-cta continua presente (complementa, não remove)", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(html, /id="jogar-subscribe-cta"/);
    assert.match(html, /diaria\.beehiiv\.com/);
  });

  it("form de voto continua apontando pro /vote com brand=web", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(html, /action="\/vote"/);
    assert.match(html, /name="brand"\s+value="web"/);
  });

  it("inlineSignupScript é no-op seguro se o form não existir (guard no topo)", () => {
    const script = inlineSignupScript();
    assert.match(script, /if \(!form\) return;/);
  });
});
