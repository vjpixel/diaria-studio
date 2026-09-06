/**
 * test/subscribe-origem-paga-7535.test.ts (#7535, Camada 1 + caminho 1)
 *
 * Cobre o invariante central da issue: tráfego pago roteado pra
 * `livros`/`cursos`/`arquivo`/`hub` deixa de perder a atribuição SEM que o
 * triplo UTM fixo por posição (`SUBSCRIBE_UTM_BY_SOURCE`,
 * `CURSOS_GATE_INLINE_UTM`) mude — o valor vai pra um campo NOVO,
 * `origem_paga`.
 *
 *   - `resolveSubscribeUtm` (worker `poll`): pra QUALQUER `SubscribeSource`
 *     != "apex", o triplo fixo permanece IDÊNTICO ao registry mesmo quando
 *     o cliente manda um `utm_source` da allowlist — só `origemPaga` muda.
 *     `utm_source` fora da allowlist (ou ausente) → `origemPaga: ""`.
 *     `"apex"` continua intocado (comportamento pré-#7535, #6427/#6980).
 *   - `subscribeToKit`/`subscribeToBeehiiv` (worker `poll`): só incluem
 *     `origem_paga` no payload quando ENV E valor estão presentes (mesmo
 *     guard duplo dos demais `KIT_*_FIELD`/`BEEHIIV_*_FIELD`).
 *   - Worker `cursos` (bundle separado, sem `resolveSubscribeUtm`): mesmo
 *     invariante, replicado — `subscribeViaConfiguredBackend`/
 *     `handleGateSubscribe` gravam `origem_paga` sem tocar
 *     `CURSOS_GATE_INLINE_UTM`.
 *   - `isAllowedClientUtmSource` (agora em
 *     `scripts/lib/shared/client-utm-allowlist.ts`): a re-exportação de
 *     `workers/poll/src/subscribe.ts` continua funcionando (back-compat de
 *     import) e é literalmente a mesma função usada pelos dois workers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  handleJogarSubscribe,
  resolveSubscribeUtm,
  isAllowedClientUtmSource as pollIsAllowedClientUtmSource,
  type SubscribeSource,
} from "../workers/poll/src/subscribe.ts";
import { isAllowedClientUtmSource } from "../scripts/lib/shared/client-utm-allowlist.ts";
import type { Env as PollEnv } from "../workers/poll/src/index.ts";
import { handleGateSubscribe, subscribeViaConfiguredBackend } from "../workers/cursos/src/subscribe.ts";
import { CURSOS_GATE_INLINE_UTM } from "../scripts/lib/shared/utm-registry.ts";
import type { Env as CursosEnv } from "../workers/cursos/src/index.ts";

// Todo SubscribeSource != "apex" — o triplo fixo tem que sobreviver ao
// clientUtm da allowlist em CADA um deles, não só num representante.
const NON_APEX_SOURCES: SubscribeSource[] = [
  "jogar",
  "livros-hero",
  "livros-footer",
  "vote-clarice",
  "jogar-gate",
  "jogar-identify",
  "jogar-postweb",
  "arquivo",
  "hub",
];

describe("isAllowedClientUtmSource re-exportada de scripts/lib/shared/ (#7535)", () => {
  it("workers/poll/src/subscribe.ts re-exporta a MESMA função do módulo compartilhado", () => {
    assert.equal(pollIsAllowedClientUtmSource, isAllowedClientUtmSource);
  });
});

describe("resolveSubscribeUtm — origemPaga pra QUALQUER source != apex (#7535)", () => {
  it("triplo fixo idêntico ao registry + origemPaga=google-ads, pra cada SubscribeSource não-apex", () => {
    for (const source of NON_APEX_SOURCES) {
      const withoutOverride = resolveSubscribeUtm(source);
      const withOverride = resolveSubscribeUtm(source, { source: "google-ads", medium: "cpc", campaign: "x" });
      assert.equal(withOverride.source, withoutOverride.source, `source mudou pra ${source}`);
      assert.equal(withOverride.medium, withoutOverride.medium, `medium mudou pra ${source}`);
      assert.equal(withOverride.campaign, withoutOverride.campaign, `campaign mudou pra ${source}`);
      assert.equal(withOverride.referringSite, withoutOverride.referringSite, `referringSite mudou pra ${source}`);
      assert.equal(withOverride.origemPaga, "google-ads", `origemPaga não gravado pra ${source}`);
      assert.equal(withoutOverride.origemPaga, "", `origemPaga default != "" pra ${source}`);
    }
  });

  it("utm_source fora da allowlist → origemPaga vazio, triplo fixo intacto", () => {
    const utm = resolveSubscribeUtm("livros-hero", { source: "organic-fake" });
    assert.equal(utm.origemPaga, "");
    assert.equal(utm.source, resolveSubscribeUtm("livros-hero").source);
  });

  it("sem clientUtm nenhum → origemPaga vazio (comportamento pré-#7535 preservado)", () => {
    for (const source of NON_APEX_SOURCES) {
      assert.equal(resolveSubscribeUtm(source).origemPaga, "");
    }
  });

  it("apex intacto: source ainda vem do cliente, mas origemPaga fica vazio (a info já está em `source`)", () => {
    const utm = resolveSubscribeUtm("apex", { source: "google-ads", medium: "cpc", campaign: "y" });
    assert.equal(utm.source, "google-ads");
    assert.equal(utm.origemPaga, "");
  });

  it("apex com utm_source fora da allowlist → triplo default, origemPaga vazio", () => {
    const utm = resolveSubscribeUtm("apex", { source: "organic-fake" });
    assert.equal(utm.source, "diaria-apex");
    assert.equal(utm.origemPaga, "");
  });
});

type FetchMock = typeof fetch & { calls: Array<{ url: string; init: RequestInit | undefined }> };
function makeFetchMock(status = 201, body: unknown = { subscriber: { id: 1 } }): FetchMock {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as FetchMock;
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

function pollKitEnv(overrides: Partial<PollEnv> = {}): PollEnv {
  return {
    POLL: makeMapKV() as unknown as PollEnv["POLL"],
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "https://diar.ia.br",
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "test-kit-key",
    KIT_API_URL: "https://kit.test/v4",
    KIT_UTM_SOURCE_FIELD: "utm_source",
    KIT_UTM_MEDIUM_FIELD: "utm_medium",
    KIT_UTM_CAMPAIGN_FIELD: "utm_campaign",
    KIT_REFERRING_SITE_FIELD: "referring_site",
    KIT_ORIGEM_PAGA_FIELD: "origem_paga",
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

describe("subscribeToKit (worker poll) — grava origem_paga só com env+valor presentes (#7535)", () => {
  it("KIT_ORIGEM_PAGA_FIELD configurado + utm_source válido (via source=livros-hero) → fields.origem_paga presente, triplo fixo intacto", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "a@b.com", optin: true, source: "livros-hero", utm_source: "google-ads", utm_medium: "cpc", utm_campaign: "camp-1" }),
      pollKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    // triplo fixo do registry, NUNCA sobrescrito pelo clientUtm.
    assert.equal(body.fields.utm_source, "livros");
    assert.equal(body.fields.origem_paga, "google-ads");
  });

  it("sem KIT_ORIGEM_PAGA_FIELD configurado → campo nunca aparece, mesmo com utm_source válido", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "c@b.com", optin: true, source: "livros-hero", utm_source: "google-ads" }),
      pollKitEnv({ KIT_ORIGEM_PAGA_FIELD: undefined }),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_paga, undefined);
  });

  it("utm_source fora da allowlist → campo nunca aparece", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "d@b.com", optin: true, source: "arquivo", utm_source: "organic-fake" }),
      pollKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_paga, undefined);
    assert.equal(body.fields.utm_source, "arquivo"); // triplo fixo do source "arquivo" (ARQUIVO_INLINE_UTM)
  });
});

// ---- worker cursos: mesmo invariante, mecanismo próprio (bundle separado) ----

function cursosKitEnv(overrides: Partial<CursosEnv> = {}): CursosEnv {
  return {
    ASSETS: { fetch: async () => new Response("") } as unknown as CursosEnv["ASSETS"],
    CURSOS_SUBSCRIBERS: makeMapKV() as unknown as CursosEnv["CURSOS_SUBSCRIBERS"],
    COOKIE_HMAC_SECRET: "cookie-secret",
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "test-kit-key",
    KIT_API_URL: "https://kit.test/v4",
    KIT_UTM_SOURCE_FIELD: "utm_source",
    KIT_ORIGEM_PAGA_FIELD: "origem_paga",
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

describe("worker cursos — origem_paga sem tocar CURSOS_GATE_INLINE_UTM (#7535)", () => {
  it("handleGateSubscribe: utm_source válido grava origem_paga, triplo fixo intacto", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(
      gateReq({ email: "a@b.com", optin: true, utm_source: "google-ads" }),
      cursosKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields.origem_paga, "google-ads");
    // #4295: o triplo fixo do gate de cursos nunca teve `SubscribeSource` —
    // é sempre CURSOS_GATE_INLINE_UTM.source, independente do clientUtm.
    assert.equal(body.fields.utm_source, CURSOS_GATE_INLINE_UTM.source);
  });

  it("utm_source fora da allowlist → origem_paga nunca aparece", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(
      gateReq({ email: "b@b.com", optin: true, utm_source: "organic-fake" }),
      cursosKitEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_paga, undefined);
  });

  it("sem utm_source nenhum (cadastro direto) → origem_paga nunca aparece", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(gateReq({ email: "e@b.com", optin: true }), cursosKitEnv(), { fetchImpl: fetchMock });
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_paga, undefined);
  });

  it("sem KIT_ORIGEM_PAGA_FIELD configurado → nunca aparece, mesmo com utm_source válido", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleGateSubscribe(
      gateReq({ email: "f@b.com", optin: true, utm_source: "google-ads" }),
      cursosKitEnv({ KIT_ORIGEM_PAGA_FIELD: undefined }),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields?.origem_paga, undefined);
  });

  it("subscribeViaConfiguredBackend direto: 4º parâmetro origemPaga chega em fields.origem_paga", async () => {
    const fetchMock = makeFetchMock();
    const r = await subscribeViaConfiguredBackend(cursosKitEnv(), { name: "", email: "g@b.com" }, fetchMock, "meta-ads");
    assert.equal(r.ok, true);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.fields.origem_paga, "meta-ads");
  });
});
