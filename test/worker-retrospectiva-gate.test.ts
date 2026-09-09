/**
 * test/worker-retrospectiva-gate.test.ts (#7581)
 *
 * Teste de regressão do gate de CADASTRO da retrospectiva anual
 * (`workers/anual/`):
 *   - `src/gate.ts` — lógica pura de decisão (normalize/decideCadastroGate)
 *   - `src/index.ts` — `handleGet` fiado com um KV mock (Map em memória) e um
 *     `fetchImpl` injetado no lugar da chamada real à API Kit, mesmo padrão
 *     de `test/worker-artigo-mensal-gate-3940.test.ts` (#3940).
 *
 * Casos centrais exigidos pelo dispatch (#633 — regressão fail-closed nas
 * DUAS direções):
 *   1. Anônimo (sem `?email=`) NUNCA recebe o completo — sempre trecho+cadastro.
 *   2. E-mail cadastrado ATIVO no Kit → completo.
 *   3. E-mail NÃO encontrado no Kit → MESMA resposta do anônimo (anti-probing).
 *   4. Falha de VERIFICAÇÃO (Kit fora do ar, 500/timeout) → MESMA resposta
 *      do "não encontrado" — nunca "completo" por omissão, nunca uma 3ª
 *      resposta que distinga o caso pro leitor (anti-probing).
 *   5. Ausência de trecho no KV NUNCA cai no completo — vira paywall seco
 *      dedicado, nunca o artigo.
 *   6. `?entrar=1` sem e-mail mostra o form de login, não o trecho — mas só
 *      quando pedido explicitamente (sem o param, cai no trecho de novo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail, decideCadastroGate } from "../workers/retrospectiva/src/gate-cadastro.ts";
import { handleGet, type Env } from "../workers/retrospectiva/src/index.ts";

// ── gate.ts — funções puras ─────────────────────────────────────────────────

describe("normalizeEmail (#7581)", () => {
  it("trim + lowercase", () => {
    assert.equal(normalizeEmail("  Foo@Bar.COM  "), "foo@bar.com");
  });
  it("null/undefined/vazio → string vazia", () => {
    assert.equal(normalizeEmail(null), "");
    assert.equal(normalizeEmail(undefined), "");
    assert.equal(normalizeEmail(""), "");
  });
});

describe("decideCadastroGate (#7581) — fail-closed + anti-probing", () => {
  it("sem e-mail → no_email", () => {
    assert.deepEqual(decideCadastroGate(null, null), { state: "no_email" });
    assert.deepEqual(decideCadastroGate("", "active"), { state: "no_email" });
  });
  it("kitState 'active' → allowed (único caminho de acesso)", () => {
    assert.deepEqual(decideCadastroGate("foo@bar.com", "active"), { state: "allowed" });
  });
  it("kitState 'inactive'/'unknown'/'verification_failed'/null → SEMPRE not_registered, nunca allowed", () => {
    for (const s of ["inactive", "unknown", "verification_failed", null] as const) {
      assert.deepEqual(decideCadastroGate("foo@bar.com", s), { state: "not_registered" });
    }
  });
  it("anti-probing: 'unknown' (não encontrado) e 'verification_failed' (API fora do ar) são INDISTINGUÍVEIS na decisão", () => {
    assert.deepEqual(decideCadastroGate("x@y.com", "unknown"), decideCadastroGate("x@y.com", "verification_failed"));
  });
});

// `extractSlug` saiu no #7658: a resolução do path virou
// `classifyRetrospectivaPath` (`scripts/lib/shared/retrospectiva-path.ts`),
// compartilhada com os publishers e testada em
// `test/retrospectiva-path-7658.test.ts` — inclusive a colisão /AAMM × /AAAA,
// que é o caso que este teste local nunca cobriu.

// ── handleGet — fiado com KV mock + fetchImpl injetado ──────────────────────

const SLUG = "aniversario2026"; // #7658: path novo, não mais o slug do repo
const FULL_HTML = "<html><body><h1>completo</h1></body></html>";
const TEASER_HTML = "<html><body><h1>trecho</h1></body></html>";

type MockKV = Map<string, string>;

function makeEnv(articles: MockKV, opts: { kitApiKey?: string; rateLimit?: MockKV } = {}): Env {
  return {
    ARTICLES: {
      get: async (key: string) => articles.get(key) ?? null,
    },
    RATE_LIMIT: opts.rateLimit
      ? {
          get: async (key: string) => opts.rateLimit!.get(key) ?? null,
          put: async (key: string, value: string) => {
            opts.rateLimit!.set(key, value);
          },
        }
      : undefined,
    KIT_API_KEY: opts.kitApiKey,
  } as unknown as Env;
}

/** `fetchImpl` que simula a resposta do Kit (`GET /v4/subscribers?email_address=`)
 * — mesmo shape confirmado ao vivo em `subscriber-verify.ts` (200 com array
 * vazio = não encontrado, NUNCA 404). */
function kitFetch(active: string[]): typeof fetch {
  return (async (url: string | URL) => {
    const u = new URL(String(url));
    const email = (u.searchParams.get("email_address") ?? "").toLowerCase();
    const found = active.includes(email);
    return new Response(
      JSON.stringify({ subscribers: found ? [{ state: "active" }] : [] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

function kitFetchDown(): typeof fetch {
  return (async () => new Response("upstream error", { status: 500 })) as unknown as typeof fetch;
}

function req(url: string): Request {
  return new Request(url);
}

describe("handleGet — cenário 1: anônimo (sem ?email=) NUNCA recebe o completo (#7581, #633)", () => {
  it("sem ?email= → trecho + cadastro, nunca o HTML completo", async () => {
    const articles: MockKV = new Map([
      [`article:${SLUG}`, FULL_HTML],
      [`article:${SLUG}:teaser`, TEASER_HTML],
    ]);
    const env = makeEnv(articles, { kitApiKey: "k" });
    const res = await handleGet(req(`https://retrospectiva.diar.ia.br/${SLUG}`), env, kitFetch([]));
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(body.includes("trecho"));
    assert.ok(!body.includes("<h1>completo</h1>"));
  });
});

describe("handleGet — cenário 2: e-mail ATIVO no Kit → completo (#7581)", () => {
  it("?email= cadastrado e ativo → HTML completo do KV", async () => {
    const articles: MockKV = new Map([[`article:${SLUG}`, FULL_HTML]]);
    const env = makeEnv(articles, { kitApiKey: "k" });
    const res = await handleGet(
      req(`https://retrospectiva.diar.ia.br/${SLUG}?email=ativo@x.com`),
      env,
      kitFetch(["ativo@x.com"]),
    );
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(body, FULL_HTML);
  });
});

describe("handleGet — cenário 3: e-mail NÃO encontrado no Kit → MESMA resposta do anônimo (#7581, #633 anti-probing)", () => {
  it("?email= não cadastrado → trecho + cadastro, idêntico ao caminho sem e-mail", async () => {
    const articles: MockKV = new Map([
      [`article:${SLUG}`, FULL_HTML],
      [`article:${SLUG}:teaser`, TEASER_HTML],
    ]);
    const env = makeEnv(articles, { kitApiKey: "k" });
    const semEmail = await handleGet(req(`https://retrospectiva.diar.ia.br/${SLUG}`), env, kitFetch([]));
    const naoCadastrado = await handleGet(
      req(`https://retrospectiva.diar.ia.br/${SLUG}?email=naocadastrado@x.com`),
      env,
      kitFetch([]),
    );
    assert.equal(await semEmail.text(), await naoCadastrado.text());
    assert.equal(naoCadastrado.status, 200);
  });
});

describe("handleGet — cenário 4: falha de verificação (Kit fora do ar) → fail-closed, MESMA resposta de 'não cadastrado' (#7581, #633)", () => {
  it("Kit retornando 500 → trecho + cadastro (NUNCA o completo por omissão)", async () => {
    const articles: MockKV = new Map([
      [`article:${SLUG}`, FULL_HTML],
      [`article:${SLUG}:teaser`, TEASER_HTML],
    ]);
    const env = makeEnv(articles, { kitApiKey: "k" });
    const res = await handleGet(
      req(`https://retrospectiva.diar.ia.br/${SLUG}?email=alguem@x.com`),
      env,
      kitFetchDown(),
    );
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(body.includes("trecho"));
    assert.ok(!body.includes("<h1>completo</h1>"));
  });

  it("KIT_API_KEY ausente → mesma degradação fail-closed (nunca completo)", async () => {
    const articles: MockKV = new Map([
      [`article:${SLUG}`, FULL_HTML],
      [`article:${SLUG}:teaser`, TEASER_HTML],
    ]);
    const env = makeEnv(articles, {}); // sem kitApiKey
    const res = await handleGet(req(`https://retrospectiva.diar.ia.br/${SLUG}?email=alguem@x.com`), env, kitFetch([]));
    const body = await res.text();
    assert.ok(body.includes("trecho"));
    assert.ok(!body.includes("<h1>completo</h1>"));
  });
});

describe("handleGet — cenário 5: ausência de trecho no KV NUNCA cai no completo (#7581, #633)", () => {
  it("sem article:{slug}:teaser no KV → paywall seco dedicado, nunca o HTML completo", async () => {
    const articles: MockKV = new Map([[`article:${SLUG}`, FULL_HTML]]); // SEM :teaser
    const env = makeEnv(articles, { kitApiKey: "k" });
    const res = await handleGet(req(`https://retrospectiva.diar.ia.br/${SLUG}`), env, kitFetch([]));
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!body.includes("<h1>completo</h1>"));
    assert.ok(body.includes("Cadastrar") || body.includes("cadastr"));
  });

  it("e-mail ativo mas artigo AUSENTE do KV → 404 dedicado, não paywall", async () => {
    const articles: MockKV = new Map(); // KV ARTICLES vazio
    const env = makeEnv(articles, { kitApiKey: "k" });
    const res = await handleGet(
      req(`https://retrospectiva.diar.ia.br/${SLUG}?email=ativo@x.com`),
      env,
      kitFetch(["ativo@x.com"]),
    );
    assert.equal(res.status, 404);
  });
});

describe("handleGet — cenário 6: ?entrar=1 mostra form de login, sem ele cai no trecho de novo (#7581)", () => {
  it("sem ?email= e sem ?entrar= → trecho", async () => {
    const articles: MockKV = new Map([[`article:${SLUG}:teaser`, TEASER_HTML]]);
    const env = makeEnv(articles, { kitApiKey: "k" });
    const res = await handleGet(req(`https://retrospectiva.diar.ia.br/${SLUG}`), env, kitFetch([]));
    const body = await res.text();
    assert.ok(body.includes("trecho"));
  });

  it("?entrar=1 → form de e-mail (login), não o trecho", async () => {
    const articles: MockKV = new Map([[`article:${SLUG}:teaser`, TEASER_HTML]]);
    const env = makeEnv(articles, { kitApiKey: "k" });
    const res = await handleGet(req(`https://retrospectiva.diar.ia.br/${SLUG}?entrar=1`), env, kitFetch([]));
    const body = await res.text();
    assert.ok(!body.includes("<h1>trecho</h1>"));
    assert.ok(body.toLowerCase().includes("já é assinante") || body.toLowerCase().includes("entre com seu"));
  });
});

describe("handleGet — sem slug (GET /) → 400 (#7581)", () => {
  it("path raiz → 400, slug obrigatório", async () => {
    const env = makeEnv(new Map(), { kitApiKey: "k" });
    const res = await handleGet(req("https://retrospectiva.diar.ia.br/"), env, kitFetch([]));
    assert.equal(res.status, 400);
  });
});

describe("handleGet — rate limit do gate por IP (#7581)", () => {
  it("excedido → 429, mesmo com Kit funcionando", async () => {
    const articles: MockKV = new Map([
      [`article:${SLUG}`, FULL_HTML],
      [`article:${SLUG}:teaser`, TEASER_HTML],
    ]);
    const rateLimit: MockKV = new Map([["rl:retrospectiva-gate:1.2.3.4", "999"]]);
    const env = makeEnv(articles, { kitApiKey: "k", rateLimit });
    const request = new Request(`https://retrospectiva.diar.ia.br/${SLUG}?email=x@y.com`, {
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });
    const res = await handleGet(request, env, kitFetch(["x@y.com"]));
    assert.equal(res.status, 429);
  });

  it("sem RATE_LIMIT configurado → nunca bloqueia (fail-open no mecanismo, não no conteúdo)", async () => {
    const articles: MockKV = new Map([[`article:${SLUG}`, FULL_HTML]]);
    const env = makeEnv(articles, { kitApiKey: "k" }); // sem rateLimit
    const res = await handleGet(
      req(`https://retrospectiva.diar.ia.br/${SLUG}?email=ativo@x.com`),
      env,
      kitFetch(["ativo@x.com"]),
    );
    assert.equal(res.status, 200);
  });
});
