/**
 * test/subscribe-click-id-attribution-fallback-8553.test.ts (#8553)
 *
 * Regressão: cadastro com `click_id` (#8003) provando clique de anúncio
 * pago, mas `origemPaga` (derivada só do `utm_source`/`origemPaga` que o
 * CLIENTE mandou, #7535) vazia ou de plataforma diferente — deixava de ser
 * contado como canal pago e caía no orgânico (`diaria-apex`/`livros`/
 * `arquivo`) no relatório de canal. Medição da issue: 9 cadastros com
 * `fbclid` em 7 dias atribuídos incorretamente por essa lacuna.
 *
 * Causa raiz confirmada (ver docstring de
 * `resolveOrigemPagaWithClickIdFallback`, scripts/lib/shared/
 * client-utm-allowlist.ts): o Facebook injeta `fbclid` em QUALQUER link
 * clicado a partir de um anúncio, independente de a URL de destino do
 * anúncio carregar `utm_source=meta-ads` — click_id e UTM são preenchidos
 * por mecanismos independentes. Fix: quando o click_id prova um clique de
 * ads e `origemPaga` não bate com a plataforma que o prefixo indica,
 * `origemPaga` passa a ser DERIVADO do click_id.
 *
 * Cobre:
 *   - `resolveOrigemPagaWithClickIdFallback` isolada (as 3 plataformas,
 *     concordância, divergência, ausência/formato desconhecido).
 *   - `handleJogarSubscribe` (worker poll) fim-a-fim: cadastro em
 *     `source: "apex"` (o cenário real da issue — link do anúncio caindo
 *     direto na página de assinatura, sem utm_source configurado) com
 *     `click_id: "fbclid:..."` grava `origem_paga: "meta-ads"`, não vazio.
 *   - `handleGateSubscribe` (worker cursos) mesmo invariante.
 *   - utm_source já correto (concorda com o click_id) não é alterado —
 *     `origemPaga` custom (`"meta-ads-260901"`) passa intacto.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveOrigemPagaWithClickIdFallback } from "../scripts/lib/shared/client-utm-allowlist.ts";
import { handleJogarSubscribe } from "../workers/poll/src/subscribe.ts";
import type { Env as PollEnv } from "../workers/poll/src/index.ts";
import { handleGateSubscribe } from "../workers/cursos/src/subscribe.ts";
import type { Env as CursosEnv } from "../workers/cursos/src/index.ts";

describe("resolveOrigemPagaWithClickIdFallback (#8553)", () => {
  it("click_id fbclid + origemPaga vazia → deriva meta-ads", () => {
    assert.equal(resolveOrigemPagaWithClickIdFallback("", "fbclid:abc123"), "meta-ads");
  });

  it("click_id gclid + origemPaga vazia → deriva google-ads", () => {
    assert.equal(resolveOrigemPagaWithClickIdFallback("", "gclid:abc123"), "google-ads");
  });

  it("click_id msclkid + origemPaga vazia → deriva microsoft-ads", () => {
    assert.equal(resolveOrigemPagaWithClickIdFallback("", "msclkid:abc123"), "microsoft-ads");
  });

  it("origemPaga JÁ concorda com o click_id → passa intacta (não normaliza sufixo de campanha)", () => {
    assert.equal(resolveOrigemPagaWithClickIdFallback("meta-ads-260901", "fbclid:abc123"), "meta-ads-260901");
    assert.equal(resolveOrigemPagaWithClickIdFallback("meta-ads", "fbclid:abc123"), "meta-ads");
  });

  it("origemPaga de OUTRA plataforma que o click_id → substituída pela do click_id", () => {
    assert.equal(resolveOrigemPagaWithClickIdFallback("google-ads", "fbclid:abc123"), "meta-ads");
  });

  it("click_id ausente/vazio → origemPaga original intacta", () => {
    assert.equal(resolveOrigemPagaWithClickIdFallback("", ""), "");
    assert.equal(resolveOrigemPagaWithClickIdFallback("diaria-apex", ""), "diaria-apex");
  });

  it("click_id com prefixo desconhecido → origemPaga original intacta", () => {
    assert.equal(resolveOrigemPagaWithClickIdFallback("", "ttclid:abc123"), "");
    assert.equal(resolveOrigemPagaWithClickIdFallback("livros", "ttclid:abc123"), "livros");
  });
});

function makeFetchMock(status = 200, body: unknown = { data: { status: "active" } }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function makeMapKV() {
  const m = new Map<string, string>();
  return {
    async get(key: string) {
      return m.get(key) ?? null;
    },
    async getWithMetadata(key: string) {
      return { value: m.get(key) ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: undefined };
    },
  };
}

function pollBeehiivEnv(overrides: Partial<PollEnv> = {}): PollEnv {
  return {
    POLL: makeMapKV() as unknown as PollEnv["POLL"],
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "https://diar.ia.br",
    BEEHIIV_API_KEY: "test-beehiiv-key",
    BEEHIIV_PUBLICATION_ID: "pub_test",
    BEEHIIV_API_URL: "https://beehiiv.test/v2",
    BEEHIIV_ORIGEM_PAGA_FIELD: "origem_paga",
    ...overrides,
  };
}

function subReq(body: unknown): Request {
  return new Request("https://poll.test/jogar/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://diar.ia.br" },
    body: JSON.stringify(body),
  });
}

describe("handleJogarSubscribe (worker poll) — click_id preenche origem_paga quando utm_source não bate (#8553)", () => {
  it("cenário real da issue: source apex, sem utm_source, fbclid presente → origem_paga: meta-ads", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "a@b.com", optin: true, source: "apex", click_id: "fbclid:xyz789" }),
      pollBeehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.custom_fields, [{ name: "origem_paga", value: "meta-ads" }]);
  });

  it("source livros, sem utm_source, gclid presente → origem_paga: google-ads (triplo UTM fixo de livros intacto)", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "b@b.com", optin: true, source: "livros-hero", click_id: "gclid:abc" }),
      pollBeehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.utm_source, "livros");
    assert.deepEqual(body.custom_fields, [{ name: "origem_paga", value: "google-ads" }]);
  });

  it("sem click_id nenhum → origem_paga continua vazia (comportamento pré-#8553 preservado)", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "c@b.com", optin: true, source: "arquivo" }),
      pollBeehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.custom_fields, undefined);
  });
});

function cursosBeehiivEnv(overrides: Partial<CursosEnv> = {}): CursosEnv {
  return {
    ASSETS: { fetch: async () => new Response("") } as unknown as CursosEnv["ASSETS"],
    CURSOS_SUBSCRIBERS: makeMapKV() as unknown as CursosEnv["CURSOS_SUBSCRIBERS"],
    COOKIE_HMAC_SECRET: "cookie-secret",
    BEEHIIV_API_KEY: "test-beehiiv-key",
    BEEHIIV_PUBLICATION_ID: "pub_test",
    BEEHIIV_API_URL: "https://beehiiv.test/v2",
    BEEHIIV_ORIGEM_PAGA_FIELD: "origem_paga",
    ...overrides,
  };
}

function gateReq(body: unknown): Request {
  return new Request("https://cursos.test/gate/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleGateSubscribe (worker cursos) — mesmo invariante do #8553", () => {
  it("sem utm_source, msclkid presente → origem_paga: microsoft-ads", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(gateReq({ email: "a@b.com", optin: true, click_id: "msclkid:z9" }), cursosBeehiivEnv(), {
      fetchImpl: fetchMock,
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.custom_fields, [{ name: "origem_paga", value: "microsoft-ads" }]);
  });

  it("utm_source de outra plataforma + fbclid → click_id vence (mais confiável, ver docstring)", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(
      gateReq({ email: "b@b.com", optin: true, utm_source: "google-ads", click_id: "fbclid:xyz" }),
      cursosBeehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.deepEqual(body.custom_fields, [{ name: "origem_paga", value: "meta-ads" }]);
  });
});
