/**
 * test/poll-subscribe-arquivo-hub-5167.test.ts (#5167 itens 1/2)
 *
 * `arquivo.diar.ia.br` (workers/arquivo — página de arquivo E hubs
 * temáticos, mesmo host) passou a chamar `POST /jogar/subscribe`
 * (workers/poll) CROSS-ORIGIN, mesmo mecanismo que `livros.diar.ia.br` já
 * usa desde o #4051 (ver test/poll-subscribe-livros-4051.test.ts) — só o
 * host novo na allowlist e os 2 `source` novos (`arquivo`, `hub`).
 *
 * Cobre:
 *   - CORS: `https://arquivo.diar.ia.br` está na allowlist (wrangler.toml
 *     `ALLOWED_ORIGINS`) e o preflight OPTIONS ecoa essa origem.
 *   - `resolveSubscribeUtm`: `arquivo` → utm_source=arquivo/medium=inline,
 *     `hub` → utm_source=arquivo-hub/medium=inline (fonte própria — os hubs
 *     são o tráfego frio de SEO/GEO que motivou a issue).
 *   - `handleJogarSubscribe` fim-a-fim: `source` no corpo do POST chega até
 *     o payload da Beehiiv com `double_opt_override: "off"` (isento, #5095).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleJogarSubscribe, resolveSubscribeUtm } from "../workers/poll/src/subscribe.ts";
import worker, { corsHeaders, type Env } from "../workers/poll/src/index.ts";

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

const beehiivEnv = (): Env => ({
  POLL: makeMapKV() as unknown as Env["POLL"],
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "https://diar.ia.br,https://diaria.beehiiv.com,https://livros.diar.ia.br,https://arquivo.diar.ia.br",
  BEEHIIV_API_KEY: "test-key",
  BEEHIIV_PUBLICATION_ID: "pub_test",
  BEEHIIV_API_URL: "https://beehiiv.test/v2",
});

function subReq(body: unknown, opts: { origin?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.origin) headers["Origin"] = opts.origin;
  return new Request("https://poll.test/jogar/subscribe", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("CORS — arquivo.diar.ia.br na allowlist (#5167 itens 1/2)", () => {
  it("corsHeaders ecoa https://arquivo.diar.ia.br quando presente na allowlist configurada", () => {
    const env = beehiivEnv();
    env._requestOrigin = "https://arquivo.diar.ia.br";
    const headers = corsHeaders(env);
    assert.equal(headers["Access-Control-Allow-Origin"], "https://arquivo.diar.ia.br");
    assert.equal(headers["Vary"], "Origin");
  });

  it("preflight OPTIONS de arquivo.diar.ia.br contra /jogar/subscribe é aceito", async () => {
    const req = new Request("https://poll.test/jogar/subscribe", {
      method: "OPTIONS",
      headers: { Origin: "https://arquivo.diar.ia.br" },
    });
    const res = await worker.fetch(req, beehiivEnv());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://arquivo.diar.ia.br");
  });
});

describe("resolveSubscribeUtm — arquivo/hub (#5167 itens 1/2)", () => {
  it("'arquivo' → utm_source=arquivo, utm_medium=inline", () => {
    const utm = resolveSubscribeUtm("arquivo");
    assert.equal(utm.source, "arquivo");
    assert.equal(utm.medium, "inline");
    assert.equal(utm.referringSite, "arquivo-inline");
  });

  it("'hub' → utm_source=arquivo-hub (distinto de 'arquivo'), utm_medium=inline", () => {
    const utm = resolveSubscribeUtm("hub");
    assert.equal(utm.source, "arquivo-hub");
    assert.equal(utm.medium, "inline");
    assert.equal(utm.referringSite, "hub-inline");
    assert.notEqual(utm.source, resolveSubscribeUtm("arquivo").source);
  });
});

describe("handleJogarSubscribe — source=arquivo/hub chega isento de double opt-in na Beehiiv (#5167)", () => {
  it("source=arquivo → utm_source=arquivo no payload da Beehiiv, double_opt_override=off", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "leitor@example.com", optin: true, source: "arquivo" }, { origin: "https://arquivo.diar.ia.br" }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    assert.equal(fetchMock.calls.length, 1);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.utm_source, "arquivo");
    assert.equal(body.utm_medium, "inline");
    assert.equal(body.double_opt_override, "off");
  });

  it("source=hub → utm_source=arquivo-hub no payload da Beehiiv", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "leitor@example.com", optin: true, source: "hub" }, { origin: "https://arquivo.diar.ia.br" }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.utm_source, "arquivo-hub");
  });
});
