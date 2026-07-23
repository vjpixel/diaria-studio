/**
 * test/worker-artigo-mensal-gate-3940.test.ts (#3940)
 *
 * Teste de regressão do gate do artigo mensal (`workers/artigo-mensal/`):
 *   - `src/gate.ts` — lógica pura de decisão (normalize/parse/isAllowed/decide)
 *   - `src/index.ts` — `handleGet` fiado com um KV mock (Map em memória),
 *     mesmo padrão de `test/worker-draft.test.ts` (sem wrangler/unstable_dev).
 *
 * Casos centrais exigidos pelo dispatch (#3940):
 *   1. apoiador R$10+ (mockado): e-mail na allowlist + artigo no KV → artigo completo.
 *   2. R$5 (mockado fora da allowlist, "amigo" não qualifica) → paywall.
 *   3. não-apoiador (mockado fora da allowlist) → paywall.
 *   4. e-mail ausente/inválido → fail-closed (form de e-mail, NUNCA o artigo).
 *   5. allowlist KV corrompida/indisponível → fail-closed (paywall), mesmo
 *      que o e-mail "pareça" válido.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEmail,
  parseAllowlist,
  isEmailAllowed,
  decideGate,
} from "../workers/artigo-mensal/src/gate.ts";
import { handleGet, extractCycle, type Env } from "../workers/artigo-mensal/src/index.ts";

// ── gate.ts — funções puras ─────────────────────────────────────────────────

describe("normalizeEmail (#3940)", () => {
  it("trim + lowercase", () => {
    assert.equal(normalizeEmail("  Foo@Bar.COM  "), "foo@bar.com");
  });
  it("null/undefined → string vazia", () => {
    assert.equal(normalizeEmail(null), "");
    assert.equal(normalizeEmail(undefined), "");
  });
  it("string vazia → string vazia", () => {
    assert.equal(normalizeEmail(""), "");
  });
});

describe("parseAllowlist (#3940) — fail-closed em qualquer ambiguidade", () => {
  it("JSON válido de array de strings → array normalizado", () => {
    assert.deepEqual(parseAllowlist('["Foo@Bar.com", "baz@qux.com"]'), [
      "foo@bar.com",
      "baz@qux.com",
    ]);
  });
  it("null/undefined/string vazia → null (fail-closed)", () => {
    assert.equal(parseAllowlist(null), null);
    assert.equal(parseAllowlist(undefined), null);
    assert.equal(parseAllowlist(""), null);
  });
  it("JSON inválido → null (fail-closed)", () => {
    assert.equal(parseAllowlist("{not valid json"), null);
  });
  it("JSON válido mas não-array (objeto) → null (fail-closed)", () => {
    assert.equal(parseAllowlist('{"foo":"bar"}'), null);
  });
  it("array com elemento não-string → null (fail-closed, nunca allowlist parcial)", () => {
    assert.equal(parseAllowlist('["foo@bar.com", 123]'), null);
  });
  it("array vazio → [] (válido, mas ninguém qualifica)", () => {
    assert.deepEqual(parseAllowlist("[]"), []);
  });
});

describe("isEmailAllowed (#3940)", () => {
  it("e-mail presente na allowlist → true", () => {
    assert.equal(isEmailAllowed("foo@bar.com", ["foo@bar.com"]), true);
  });
  it("comparação é case/whitespace-insensitive (normaliza os dois lados)", () => {
    assert.equal(isEmailAllowed("  FOO@Bar.com  ", ["foo@bar.com"]), true);
  });
  it("e-mail ausente da allowlist → false", () => {
    assert.equal(isEmailAllowed("naoapoia@bar.com", ["foo@bar.com"]), false);
  });
  it("allowlist null (KV indisponível/corrompida) → SEMPRE false, fail-closed", () => {
    assert.equal(isEmailAllowed("foo@bar.com", null), false);
  });
  it("e-mail vazio/null → false mesmo com allowlist válida", () => {
    assert.equal(isEmailAllowed("", ["foo@bar.com"]), false);
    assert.equal(isEmailAllowed(null, ["foo@bar.com"]), false);
    assert.equal(isEmailAllowed(undefined, ["foo@bar.com"]), false);
  });
  it("allowlist vazia ([]) → false pra qualquer e-mail", () => {
    assert.equal(isEmailAllowed("foo@bar.com", []), false);
  });
});

describe("decideGate (#3940)", () => {
  it("e-mail ausente → no_email", () => {
    assert.deepEqual(decideGate(null, ["foo@bar.com"]), { state: "no_email" });
    assert.deepEqual(decideGate("", ["foo@bar.com"]), { state: "no_email" });
  });
  it("e-mail presente mas fora da allowlist → not_backer", () => {
    assert.deepEqual(decideGate("naoapoia@bar.com", ["foo@bar.com"]), { state: "not_backer" });
  });
  it("e-mail presente e na allowlist → allowed", () => {
    assert.deepEqual(decideGate("foo@bar.com", ["foo@bar.com"]), { state: "allowed" });
  });
  it("e-mail presente mas allowlist null (fail-closed) → not_backer, NUNCA allowed", () => {
    assert.deepEqual(decideGate("foo@bar.com", null), { state: "not_backer" });
  });
});

// ── extractCycle ─────────────────────────────────────────────────────────────

describe("extractCycle (#3940)", () => {
  it("path /2607-08 → \"2607-08\"", () => {
    assert.equal(extractCycle("/2607-08"), "2607-08");
  });
  it("path / (raiz) → string vazia", () => {
    assert.equal(extractCycle("/"), "");
  });
  it("trailing slash é removido", () => {
    assert.equal(extractCycle("/2607-08/"), "2607-08");
  });
});

// ── handleGet — fiado com KV mock (Map em memória) ──────────────────────────

type MockKV = Map<string, string>;

function makeEnv(articles: MockKV, allowlistRaw: string | null): Env {
  return {
    ARTICLES: {
      async get(key: string): Promise<string | null> {
        return articles.get(key) ?? null;
      },
    },
    ALLOWLIST: {
      async get(_key: string): Promise<string | null> {
        return allowlistRaw;
      },
    },
  } as unknown as Env;
}

const ARTICLE_HTML = "<html><body>Artigo completo de julho</body></html>";
const CYCLE = "2607-08";

describe("handleGet — cenário 1: apoiador R$10+ passa (#3940)", () => {
  it("e-mail na allowlist + artigo no KV → 200 com o artigo completo", async () => {
    const articles: MockKV = new Map([[`article:${CYCLE}`, ARTICLE_HTML]]);
    const env = makeEnv(articles, JSON.stringify(["apoiador10@x.com"]));
    const res = await handleGet(new URL(`https://artigo.diar.ia.br/${CYCLE}?email=apoiador10@x.com`), env);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, ARTICLE_HTML);
  });

  it("comparação de e-mail é case-insensitive", async () => {
    const articles: MockKV = new Map([[`article:${CYCLE}`, ARTICLE_HTML]]);
    const env = makeEnv(articles, JSON.stringify(["apoiador10@x.com"]));
    const res = await handleGet(
      new URL(`https://artigo.diar.ia.br/${CYCLE}?email=APOIADOR10@X.COM`),
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), ARTICLE_HTML);
  });
});

describe("handleGet — cenário 2: R$5 (\"amigo\", abaixo do gate) bate no paywall (#3940)", () => {
  it("e-mail de apoiador R$5 NÃO está na allowlist (build-apoiador-allowlist já filtrou) → paywall", async () => {
    // Simula o resultado de computeApoiadorAllowlist: um apoiador de R$5
    // ("amigo") nunca entra na allowlist — só chega até aqui quem já
    // qualificou no build. O worker não conhece valores, só a allowlist final.
    const articles: MockKV = new Map([[`article:${CYCLE}`, ARTICLE_HTML]]);
    const env = makeEnv(articles, JSON.stringify(["apoiador10@x.com"])); // amigo5@x.com de fora
    const res = await handleGet(new URL(`https://artigo.diar.ia.br/${CYCLE}?email=amigo5@x.com`), env);
    assert.equal(res.status, 200); // paywall é 200 (página normal, não erro)
    const body = await res.text();
    assert.match(body, /exclusivo para apoiadores/i);
    assert.doesNotMatch(body, /Artigo completo de julho/);
  });
});

describe("handleGet — cenário 3: não-apoiador bate no paywall (#3940)", () => {
  it("e-mail nunca apoiou → paywall, nunca o artigo", async () => {
    const articles: MockKV = new Map([[`article:${CYCLE}`, ARTICLE_HTML]]);
    const env = makeEnv(articles, JSON.stringify(["apoiador10@x.com"]));
    const res = await handleGet(
      new URL(`https://artigo.diar.ia.br/${CYCLE}?email=naoapoia@x.com`),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /exclusivo para apoiadores/i);
    assert.match(body, /apoia\.se\/diaria/);
  });
});

describe("handleGet — cenário 4: e-mail ausente/inválido → fail-closed (#3940)", () => {
  it("sem ?email= → form de e-mail, NUNCA o artigo", async () => {
    const articles: MockKV = new Map([[`article:${CYCLE}`, ARTICLE_HTML]]);
    const env = makeEnv(articles, JSON.stringify(["apoiador10@x.com"]));
    const res = await handleGet(new URL(`https://artigo.diar.ia.br/${CYCLE}`), env);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Digite o e-mail/i);
    assert.doesNotMatch(body, /Artigo completo de julho/);
  });

  it("?email= vazio → tratado como ausente (form de e-mail)", async () => {
    const articles: MockKV = new Map([[`article:${CYCLE}`, ARTICLE_HTML]]);
    const env = makeEnv(articles, JSON.stringify(["apoiador10@x.com"]));
    const res = await handleGet(new URL(`https://artigo.diar.ia.br/${CYCLE}?email=`), env);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Digite o e-mail/i);
  });

  it("path sem ciclo (/) → 400, mesmo com e-mail válido", async () => {
    const articles: MockKV = new Map([[`article:${CYCLE}`, ARTICLE_HTML]]);
    const env = makeEnv(articles, JSON.stringify(["apoiador10@x.com"]));
    const res = await handleGet(new URL(`https://artigo.diar.ia.br/?email=apoiador10@x.com`), env);
    assert.equal(res.status, 400);
  });
});

describe("handleGet — cenário 5: allowlist KV corrompida/indisponível → fail-closed (#3940)", () => {
  it("KV ALLOWLIST retorna JSON corrompido → paywall, mesmo pro e-mail certo", async () => {
    const articles: MockKV = new Map([[`article:${CYCLE}`, ARTICLE_HTML]]);
    const env = makeEnv(articles, "{not valid json");
    const res = await handleGet(
      new URL(`https://artigo.diar.ia.br/${CYCLE}?email=apoiador10@x.com`),
      env,
    );
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /exclusivo para apoiadores/i);
    assert.doesNotMatch(body, /Artigo completo de julho/);
  });

  it("KV ALLOWLIST ausente (get retorna null) → paywall, nunca o artigo", async () => {
    const articles: MockKV = new Map([[`article:${CYCLE}`, ARTICLE_HTML]]);
    const env = makeEnv(articles, null);
    const res = await handleGet(
      new URL(`https://artigo.diar.ia.br/${CYCLE}?email=apoiador10@x.com`),
      env,
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /exclusivo para apoiadores/i);
  });

  it("KV ALLOWLIST.get lança exceção → paywall (nunca propaga erro/vaza conteúdo)", async () => {
    const articles: MockKV = new Map([[`article:${CYCLE}`, ARTICLE_HTML]]);
    const env: Env = {
      ARTICLES: {
        async get(key: string): Promise<string | null> {
          return articles.get(key) ?? null;
        },
      } as never,
      ALLOWLIST: {
        async get(): Promise<string | null> {
          throw new Error("KV indisponível (simulado)");
        },
      } as never,
    };
    const res = await handleGet(
      new URL(`https://artigo.diar.ia.br/${CYCLE}?email=apoiador10@x.com`),
      env,
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /exclusivo para apoiadores/i);
  });
});

describe("handleGet — allowed mas artigo ausente do KV → 404 dedicado, não paywall (#3940)", () => {
  it("e-mail na allowlist, mas ciclo sem artigo publicado → 404", async () => {
    const articles: MockKV = new Map(); // KV ARTICLES vazio
    const env = makeEnv(articles, JSON.stringify(["apoiador10@x.com"]));
    const res = await handleGet(
      new URL(`https://artigo.diar.ia.br/${CYCLE}?email=apoiador10@x.com`),
      env,
    );
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.match(body, /não encontrado/i);
    assert.doesNotMatch(body, /exclusivo para apoiadores/i); // não é o mesmo copy do paywall
  });

  it("KV ARTICLES.get lança exceção → também 404 (fail-soft, não crasheia)", async () => {
    const env: Env = {
      ARTICLES: {
        async get(): Promise<string | null> {
          throw new Error("KV indisponível (simulado)");
        },
      } as never,
      ALLOWLIST: {
        async get(): Promise<string | null> {
          return JSON.stringify(["apoiador10@x.com"]);
        },
      } as never,
    };
    const res = await handleGet(
      new URL(`https://artigo.diar.ia.br/${CYCLE}?email=apoiador10@x.com`),
      env,
    );
    assert.equal(res.status, 404);
  });
});

describe("fetch handler — método != GET → 405 (#3940)", () => {
  it("POST → 405", async () => {
    const worker = (await import("../workers/artigo-mensal/src/index.ts")).default;
    const articles: MockKV = new Map([[`article:${CYCLE}`, ARTICLE_HTML]]);
    const env = makeEnv(articles, JSON.stringify(["apoiador10@x.com"]));
    const res = await worker.fetch(
      new Request(`https://artigo.diar.ia.br/${CYCLE}`, { method: "POST" }),
      env,
    );
    assert.equal(res.status, 405);
  });
});
