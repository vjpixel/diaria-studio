/**
 * test/artigo-especial-gate.test.ts (#7030)
 *
 * Cobre `workers/artigos/src/index.ts` fim-a-fim (fetch handler completo) +
 * `apoio-gate.ts` + `cookie.ts` — REGRESSÃO DE REGRA CENTRAL da issue #7030:
 * visitante SEM apoio (ou abaixo do limiar) sempre recebe o teaser;
 * visitante com apoio ≥ limiar e cookie de sessão válido recebe o conteúdo
 * completo. Mesmo padrão de `test/cursos-gate.test.ts` (#4052).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { type Env } from "../workers/artigos/src/index.ts";
import { apoioLevelKvKey } from "../scripts/lib/shared/apoio-level-verify.ts";
import { ARTIGOS_SESSION_COOKIE, issueSessionCookie } from "../workers/artigos/src/cookie.ts";
import { ARTIGOS_ESPECIAIS_APOIO_THRESHOLD } from "../workers/artigos/src/apoio-gate-config.ts";
import { ENGENHARIA_DE_ILUSAO_FULL_HTML } from "../workers/artigos/src/engenharia-de-ilusao-full.generated.ts";

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

const TEASER_HTML = "<html><body>teaser estático</body></html>";
function makeAssets(): Fetcher {
  return {
    fetch: async () => new Response(TEASER_HTML, { headers: { "Content-Type": "text/html" } }),
  } as unknown as Fetcher;
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: makeAssets(),
    ARTIGOS_APOIO_NIVEL: makeMapKV(),
    COOKIE_HMAC_SECRET: "cookie-secret",
    ...overrides,
  };
}

function getCookieHeader(res: Response): string | null {
  return res.headers.get("Set-Cookie");
}

const ARTICLE_URL = "https://especial.diar.ia.br/2026/engenharia-de-ilusao/";

describe("workers/artigos gate (#7030)", () => {
  it("REGRESSÃO CENTRAL — visitante SEM apoio recebe o teaser (nunca o conteúdo completo)", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request(ARTICLE_URL), env);
    const body = await res.text();
    assert.equal(body, TEASER_HTML);
  });

  it("REGRESSÃO CENTRAL — visitante com apoio ABAIXO do limiar (amigo) recebe o teaser", async () => {
    const kv = makeMapKV();
    const key = await apoioLevelKvKey("amigo@example.com");
    await kv.put(key, "amigo");
    const secret = "s3cr3t";
    const cookieHeader = await issueSessionCookie(secret, "amigo@example.com");
    const rawValue = cookieHeader.split(";")[0].split("=").slice(1).join("=");
    const env = baseEnv({ ARTIGOS_APOIO_NIVEL: kv, COOKIE_HMAC_SECRET: secret });
    const req = new Request(ARTICLE_URL, { headers: { Cookie: `${ARTIGOS_SESSION_COOKIE}=${rawValue}` } });
    const res = await worker.fetch(req, env);
    const body = await res.text();
    assert.equal(body, TEASER_HTML);
  });

  it("REGRESSÃO CENTRAL — visitante com apoio NO limiar (piso do threshold configurado) recebe o conteúdo completo", async () => {
    const nivelNoLimiar = ARTIGOS_ESPECIAIS_APOIO_THRESHOLD[0]; // qualquer valor válido do limiar atual
    const kv = makeMapKV();
    const key = await apoioLevelKvKey("apoiador@example.com");
    await kv.put(key, nivelNoLimiar);
    const secret = "s3cr3t";
    const cookieHeader = await issueSessionCookie(secret, "apoiador@example.com");
    const rawValue = cookieHeader.split(";")[0].split("=").slice(1).join("=");
    const env = baseEnv({ ARTIGOS_APOIO_NIVEL: kv, COOKIE_HMAC_SECRET: secret });
    const req = new Request(ARTICLE_URL, { headers: { Cookie: `${ARTIGOS_SESSION_COOKIE}=${rawValue}` } });
    const res = await worker.fetch(req, env);
    const body = await res.text();
    assert.equal(body, ENGENHARIA_DE_ILUSAO_FULL_HTML);
  });

  it("sem COOKIE_HMAC_SECRET, degrada pro teaser (fail-soft, #4305)", async () => {
    const env = baseEnv({ COOKIE_HMAC_SECRET: "" });
    const res = await worker.fetch(new Request(ARTICLE_URL), env);
    const body = await res.text();
    assert.equal(body, TEASER_HTML);
  });

  it("página de entidade (fora do gate) cai direto no ASSETS, sem checar sessão", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://especial.diar.ia.br/entidades/perplexity/"), env);
    const body = await res.text();
    assert.equal(body, TEASER_HTML); // ASSETS mock devolve sempre o mesmo body — o que importa é que NÃO tentou ler cookie/KV
  });

  describe("POST /gate/verify", () => {
    it("apoiador ≥ limiar → ok:true + Set-Cookie", async () => {
      const nivelNoLimiar = ARTIGOS_ESPECIAIS_APOIO_THRESHOLD[0];
      const kv = makeMapKV();
      const key = await apoioLevelKvKey("verify-ok@example.com");
      await kv.put(key, nivelNoLimiar);
      const env = baseEnv({ ARTIGOS_APOIO_NIVEL: kv });
      const req = new Request("https://especial.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
        body: JSON.stringify({ email: "verify-ok@example.com" }),
      });
      const res = await worker.fetch(req, env);
      const data = (await res.json()) as { ok: boolean };
      assert.equal(data.ok, true);
      assert.ok(getCookieHeader(res));
    });

    it("visitante sem apoio → ok:false, error not_eligible (anti-probing: MESMO shape de resposta que 'confirmado negativo')", async () => {
      const env = baseEnv();
      const req = new Request("https://especial.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.5" },
        body: JSON.stringify({ email: "sem-apoio@example.com" }),
      });
      const res = await worker.fetch(req, env);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.equal(data.ok, false);
      assert.equal(data.error, "not_eligible");
      assert.equal(res.status, 200);
    });

    it("e-mail inválido → 400 invalid_email", async () => {
      const env = baseEnv();
      const req = new Request("https://especial.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.6" },
        body: JSON.stringify({ email: "não-é-email" }),
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 400);
    });

    it("rate limit: 9ª tentativa do mesmo IP na janela é recusada (429)", async () => {
      const env = baseEnv();
      const ip = "9.9.9.9";
      let lastRes: Response | null = null;
      for (let i = 0; i < 9; i++) {
        const req = new Request("https://especial.diar.ia.br/gate/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
          body: JSON.stringify({ email: `tentativa${i}@example.com` }),
        });
        lastRes = await worker.fetch(req, env);
      }
      assert.equal(lastRes!.status, 429);
    });
  });

  it("GET /gate renderiza a tela de confirmação de e-mail", async () => {
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://especial.diar.ia.br/gate?article=engenharia-de-ilusao"),
      env,
    );
    const body = await res.text();
    assert.match(body, /Já apoia a diar\.ia\.br\?/);
  });
});
