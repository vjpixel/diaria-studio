/**
 * test/poll-subscribe-livros-4051.test.ts (#4051)
 *
 * `livros.diar.ia.br` (workers/livros, sem endpoint próprio de assinatura)
 * passou a chamar `POST /jogar/subscribe` (workers/poll) CROSS-ORIGIN, em 2
 * posições (hero + fim da lista de cards) — cada uma com seu próprio
 * `utm_medium` pra medir conversão separada via
 * `scripts/count-subscriptions-by-utm.ts`.
 *
 * Cobre:
 *   - CORS: `https://livros.diar.ia.br` está na allowlist (wrangler.toml
 *     `ALLOWED_ORIGINS`) e o preflight OPTIONS ecoa essa origem.
 *   - `resolveSubscribeUtm`: mapeia `source` (mandado pelo cliente) pro
 *     triplo UTM correto — `livros-hero` → utm_source=livros/medium=inline-hero,
 *     `livros-footer` → utm_source=livros/medium=inline-footer, valor
 *     ausente/desconhecido cai no default `jogar` (back-compat #3580).
 *   - `subscribeToBeehiiv` honra o triplo UTM passado (não mais hardcoded).
 *   - `handleJogarSubscribe` fim-a-fim: `source` no corpo do POST chega até
 *     o payload da Beehiiv.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  handleJogarSubscribe,
  resolveSubscribeUtm,
  subscribeToBeehiiv,
} from "../workers/poll/src/subscribe.ts";
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
  ALLOWED_ORIGINS: "https://diar.ia.br,https://diaria.beehiiv.com,https://livros.diar.ia.br",
  BEEHIIV_API_KEY: "test-key",
  BEEHIIV_PUBLICATION_ID: "pub_test",
  BEEHIIV_API_URL: "https://beehiiv.test/v2",
});

function subReq(body: unknown, opts: { ip?: string; origin?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  if (opts.origin) headers["Origin"] = opts.origin;
  return new Request("https://poll.test/jogar/subscribe", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ── CORS: livros.diar.ia.br na allowlist ────────────────────────────────────

describe("CORS — livros.diar.ia.br na allowlist (#4051)", () => {
  it("corsHeaders ecoa https://livros.diar.ia.br quando presente na allowlist configurada", () => {
    const env = beehiivEnv();
    env._requestOrigin = "https://livros.diar.ia.br";
    const headers = corsHeaders(env);
    assert.equal(headers["Access-Control-Allow-Origin"], "https://livros.diar.ia.br");
    assert.equal(headers["Vary"], "Origin");
  });

  it("preflight OPTIONS de livros.diar.ia.br contra /jogar/subscribe é aceito", async () => {
    const req = new Request("https://poll.test/jogar/subscribe", {
      method: "OPTIONS",
      headers: { Origin: "https://livros.diar.ia.br" },
    });
    const res = await worker.fetch(req, beehiivEnv());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://livros.diar.ia.br");
  });

  it("origem não-listada continua bloqueada (allowlist explícita, nunca wildcard)", () => {
    const env = beehiivEnv();
    env._requestOrigin = "https://evil.example.com";
    const headers = corsHeaders(env);
    assert.equal(headers["Access-Control-Allow-Origin"], undefined);
  });
});

// ── resolveSubscribeUtm ──────────────────────────────────────────────────────

describe("resolveSubscribeUtm (#4051)", () => {
  it("'livros-hero' → utm_source=livros, utm_medium=inline-hero", () => {
    const utm = resolveSubscribeUtm("livros-hero");
    assert.equal(utm.source, "livros");
    assert.equal(utm.medium, "inline-hero");
  });

  it("'livros-footer' → utm_source=livros, utm_medium=inline-footer (distinto do hero)", () => {
    const utm = resolveSubscribeUtm("livros-footer");
    assert.equal(utm.source, "livros");
    assert.equal(utm.medium, "inline-footer");
    assert.notEqual(utm.medium, resolveSubscribeUtm("livros-hero").medium);
  });

  it("source ausente/desconhecido → default 'jogar' (back-compat #3580)", () => {
    const empty = resolveSubscribeUtm(undefined);
    const unknown = resolveSubscribeUtm("nao-existe");
    const jogar = resolveSubscribeUtm("jogar");
    assert.deepEqual(empty, jogar);
    assert.deepEqual(unknown, jogar);
    assert.equal(jogar.source, "eia-standalone");
  });
});

// ── subscribeToBeehiiv honra o triplo UTM passado ───────────────────────────

describe("subscribeToBeehiiv — UTM parametrizado (#4051)", () => {
  it("manda o triplo UTM resolvido pro payload da Beehiiv, não mais hardcoded", async () => {
    const fetchMock = makeFetchMock(201);
    await subscribeToBeehiiv(
      beehiivEnv(),
      { name: "", email: "ana@example.com" },
      fetchMock,
      resolveSubscribeUtm("livros-hero"),
    );
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.utm_source, "livros");
    assert.equal(body.utm_medium, "inline-hero");
  });
});

// ── handleJogarSubscribe fim-a-fim: source no corpo chega no payload ───────

describe("handleJogarSubscribe — source do cliente resolve o UTM correto (#4051)", () => {
  it("source=livros-hero → Beehiiv recebe utm_medium=inline-hero", async () => {
    const fetchMock = makeFetchMock(201);
    const res = await handleJogarSubscribe(
      subReq({ email: "leitor@example.com", optin: true, source: "livros-hero" }, { ip: "1.1.1.1" }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.utm_source, "livros");
    assert.equal(body.utm_medium, "inline-hero");
  });

  it("source=livros-footer → Beehiiv recebe utm_medium=inline-footer", async () => {
    const fetchMock = makeFetchMock(201);
    await handleJogarSubscribe(
      subReq({ email: "leitor2@example.com", optin: true, source: "livros-footer" }, { ip: "2.2.2.2" }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.utm_medium, "inline-footer");
  });

  it("cliente NÃO pode injetar utm_source arbitrário — só a chave 'source' é aceita, resolvida server-side", async () => {
    const fetchMock = makeFetchMock(201);
    await handleJogarSubscribe(
      subReq(
        { email: "spoof@example.com", optin: true, source: "livros-hero", utm_source: "hacked" },
        { ip: "3.3.3.3" },
      ),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.utm_source, "livros");
    assert.notEqual(body.utm_source, "hacked");
  });

  it("sem 'source' (form de /jogar, pré-#4051) → continua eia-standalone/jogar-inline", async () => {
    const fetchMock = makeFetchMock(201);
    await handleJogarSubscribe(
      subReq({ email: "legado@example.com", optin: true }, { ip: "4.4.4.4" }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.utm_source, "eia-standalone");
    assert.equal(body.utm_medium, "jogar-inline");
  });
});
