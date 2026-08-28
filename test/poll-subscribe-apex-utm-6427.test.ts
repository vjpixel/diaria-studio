/**
 * test/poll-subscribe-apex-utm-6427.test.ts (#6427)
 *
 * Cadastro vindo do apex (`diar.ia.br/assinar`, workers/site/public/assinar/)
 * ganhou um `SubscribeSource` novo, `"apex"`, que — SÓ ELE, dos ~10 sources
 * já existentes — aceita `utm_source`/`utm_medium`/`utm_campaign` DINÂMICOS
 * vindos do cliente, contra a allowlist de prefixo `isAllowedClientUtmSource`
 * (`clarice`/`ads`). Cobre:
 *
 *   - `isAllowedClientUtmSource`: casos exatos ("clarice", "ads"), com
 *     sufixo ("clarice-260901", "ads-google"), rejeição de string vazia/
 *     ausente e de prefixo parecido mas não igual ("adsense", "clariceless").
 *   - `resolveSubscribeUtm("apex", …)`: aceita o triplo do cliente quando
 *     `utm_source` casa a allowlist; cai no triplo default
 *     `SUBSCRIBE_UTM_BY_SOURCE.apex` quando não casa, ou quando o cliente
 *     não manda nada.
 *   - `resolveSubscribeUtm` pra qualquer OUTRO `source` (ex: "jogar", "hub")
 *     IGNORA um `clientUtm` mesmo que ele seja "válido" pela allowlist — a
 *     exceção é estreita ao source "apex", não um buraco geral no design
 *     "nunca aceita utm_* do cliente" dos demais 9 sources.
 *   - `handleJogarSubscribe` fim-a-fim: POST com `source: "apex"` +
 *     `utm_source: "clarice-260901-d1"` chega no payload da Beehiiv com esse
 *     utm_source cru; POST com `utm_source` fora da allowlist (ex:
 *     "organic-fake", tentativa de forjar atribuição) cai no triplo default,
 *     nunca propaga o valor do cliente — é exatamente o requisito do #6427
 *     ("cair num triplo default fora do allowlist").
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  handleJogarSubscribe,
  isAllowedClientUtmSource,
  resolveSubscribeUtm,
} from "../workers/poll/src/subscribe.ts";
import type { Env } from "../workers/poll/src/index.ts";

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
  ALLOWED_ORIGINS: "https://diar.ia.br,https://diaria.beehiiv.com",
  BEEHIIV_API_KEY: "test-key",
  BEEHIIV_PUBLICATION_ID: "pub_test",
  BEEHIIV_API_URL: "https://beehiiv.test/v2",
});

function subReq(body: unknown): Request {
  return new Request("https://poll.test/jogar/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://diar.ia.br" },
    body: JSON.stringify(body),
  });
}

describe("isAllowedClientUtmSource (#6427)", () => {
  it("aceita o prefixo exato ('clarice', 'ads')", () => {
    assert.equal(isAllowedClientUtmSource("clarice"), true);
    assert.equal(isAllowedClientUtmSource("ads"), true);
  });

  it("aceita prefixo + sufixo com traço ('clarice-260901-d1', 'ads-google')", () => {
    assert.equal(isAllowedClientUtmSource("clarice-260901-d1"), true);
    assert.equal(isAllowedClientUtmSource("ads-google"), true);
  });

  it("é case-insensitive e tolera espaço nas bordas", () => {
    assert.equal(isAllowedClientUtmSource("  Clarice-260901  "), true);
    assert.equal(isAllowedClientUtmSource("ADS-META"), true);
  });

  it("rejeita string vazia, ausente, ou de outro tipo", () => {
    assert.equal(isAllowedClientUtmSource(""), false);
    assert.equal(isAllowedClientUtmSource(undefined), false);
    assert.equal(isAllowedClientUtmSource(null), false);
    assert.equal(isAllowedClientUtmSource(123), false);
  });

  it("rejeita prefixo parecido mas sem fronteira de traço ('adsense', 'clariceless')", () => {
    assert.equal(isAllowedClientUtmSource("adsense"), false);
    assert.equal(isAllowedClientUtmSource("clariceless"), false);
  });

  it("rejeita qualquer string arbitrária fora da allowlist (tentativa de forjar atribuição)", () => {
    assert.equal(isAllowedClientUtmSource("organic-fake"), false);
    assert.equal(isAllowedClientUtmSource("google"), false);
  });
});

describe("resolveSubscribeUtm('apex', clientUtm) — allowlist de prefixo (#6427)", () => {
  it("utm_source com prefixo válido: usa o triplo do CLIENTE", () => {
    const utm = resolveSubscribeUtm("apex", {
      source: "clarice-260901-d1",
      medium: "email",
      campaign: "clarice-260901-d1",
    });
    assert.equal(utm.source, "clarice-260901-d1");
    assert.equal(utm.medium, "email");
    assert.equal(utm.campaign, "clarice-260901-d1");
    // referringSite NUNCA vem do cliente — sempre o fixo do source "apex".
    assert.equal(utm.referringSite, "apex-subscribe-page");
  });

  it("utm_source FORA da allowlist (tentativa de forjar atribuição): cai no triplo DEFAULT, ignora o valor do cliente", () => {
    const utm = resolveSubscribeUtm("apex", {
      source: "organic-fake",
      medium: "fake-medium",
      campaign: "fake-campaign",
    });
    assert.equal(utm.source, "diaria-apex");
    assert.equal(utm.medium, "web");
    assert.equal(utm.campaign, "cadastro-apex");
    assert.notEqual(utm.source, "organic-fake");
  });

  it("sem clientUtm nenhum: cai no triplo default do apex", () => {
    const utm = resolveSubscribeUtm("apex");
    assert.equal(utm.source, "diaria-apex");
    assert.equal(utm.medium, "web");
    assert.equal(utm.campaign, "cadastro-apex");
  });

  it("utm_source válido mas medium/campaign ausentes: usa medium/campaign DEFAULT do apex, source do cliente", () => {
    const utm = resolveSubscribeUtm("apex", { source: "ads-google" });
    assert.equal(utm.source, "ads-google");
    assert.equal(utm.medium, "web");
    assert.equal(utm.campaign, "cadastro-apex");
  });
});

describe("resolveSubscribeUtm — exceção NUNCA vaza pros outros 9 sources (#6427)", () => {
  it("source='jogar' com clientUtm 'válido' (allowlist) é IGNORADO — comportamento idêntico a sem clientUtm", () => {
    const withOverride = resolveSubscribeUtm("jogar", { source: "clarice-260901", medium: "email", campaign: "x" });
    const withoutOverride = resolveSubscribeUtm("jogar");
    assert.deepEqual(withOverride, withoutOverride);
    assert.notEqual(withOverride.source, "clarice-260901");
  });

  it("source='hub' com clientUtm 'válido' também é IGNORADO", () => {
    const withOverride = resolveSubscribeUtm("hub", { source: "ads-google" });
    assert.equal(withOverride.source, "arquivo-hub");
  });
});

describe("handleJogarSubscribe — source=apex fim-a-fim (#6427)", () => {
  it("utm_source com prefixo clarice-* chega cru no payload da Beehiiv", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({
        email: "leitor@example.com",
        optin: true,
        source: "apex",
        utm_source: "clarice-260901-d1",
        utm_medium: "email",
        utm_campaign: "clarice-260901-d1",
      }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    assert.equal(fetchMock.calls.length, 1);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.utm_source, "clarice-260901-d1");
    assert.equal(body.utm_medium, "email");
    assert.equal(body.utm_campaign, "clarice-260901-d1");
    assert.equal(body.double_opt_override, "off");
  });

  it("utm_source fora da allowlist cai no triplo default — nunca propaga o valor do cliente pra Beehiiv", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({
        email: "leitor2@example.com",
        optin: true,
        source: "apex",
        utm_source: "alguma-coisa-nao-permitida",
        utm_medium: "fake",
        utm_campaign: "fake",
      }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.utm_source, "diaria-apex");
    assert.equal(body.utm_medium, "web");
    assert.equal(body.utm_campaign, "cadastro-apex");
    assert.notEqual(body.utm_source, "alguma-coisa-nao-permitida");
  });

  it("sem nenhum utm_* no POST (cadastro direto sem query string) cai no triplo default do apex", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleJogarSubscribe(
      subReq({ email: "leitor3@example.com", optin: true, source: "apex" }),
      beehiivEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(String(fetchMock.calls[0].init?.body));
    assert.equal(body.utm_source, "diaria-apex");
  });
});
