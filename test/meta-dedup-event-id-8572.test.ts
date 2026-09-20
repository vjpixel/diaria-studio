/**
 * test/meta-dedup-event-id-8572.test.ts (#8572)
 *
 * Regressão do bug medido em 20/09/2026: a Meta contava **2,4x** os
 * cadastros reais (CPA de R$ 1,55–1,87 no painel contra R$ 3,71–4,53 real).
 * Causa confirmada no container publicado `GTM-TC8C65ZN`: a tag do Meta
 * Pixel (template oficial, `vtp_standardEventName: "CompleteRegistration"`)
 * **não tinha campo Event ID** — o template só passa `{eventID: ...}` pro
 * `fbq` quando esse campo está preenchido, e `pushSignupConversionEventJs`
 * empurrava só `eventProps.email` pro `dataLayer`. Sem chave compartilhada
 * a Meta não tem como deduplicar, e as duas séries do dataset (`WEB_ONLY` e
 * `SERVER_ONLY`) somavam: o MESMO cadastro contado no pixel e na CAPI.
 *
 * O invariante que estes testes travam é um só, e é o que o bug violava:
 *
 *   o `event_id` que volta pro browser tem que ser byte a byte o mesmo que
 *   foi pra CAPI naquele cadastro.
 *
 * Por isso o teste central (describe "wiring") não checa formato nem
 * presença — compara o campo do corpo da resposta com o `event_id` do
 * payload que saiu pro Graph API, na MESMA requisição.
 *
 * O lado do GTM (apontar o campo Event ID da tag pra variável de camada de
 * dados `eventProps.event_id`) é ação de painel e não dá pra travar em
 * teste — está descrito em `docs/gtm-signup-tracking-setup.md`. Enquanto
 * esse passo não acontecer, este código é inerte: manda o id e ninguém lê.
 *
 * Nenhum teste aqui toca a rede: `routedFetch` intercepta o Graph API, mesmo
 * molde de `test/meta-capi-8388.test.ts`. NUNCA disparar evento real pra Meta.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompleteRegistrationEvent,
  computeCompleteRegistrationEventId,
  resolveCompleteRegistrationDedup,
} from "../scripts/lib/shared/meta-capi.ts";
import { pushSignupConversionEventJs, SIGNUP_CONVERSION_EVENT_ID_KEY } from "../scripts/lib/shared/seo-meta.ts";
import { buildAssinarHtml } from "../scripts/lib/site-assinar-page.ts";
import { handleJogarSubscribe, type SubscribeDeps as PollSubscribeDeps } from "../workers/poll/src/subscribe.ts";
import type { Env as PollEnv } from "../workers/poll/src/index.ts";
import { handleGateSubscribe } from "../workers/cursos/src/subscribe.ts";
import type { Env as CursosEnv } from "../workers/cursos/src/index.ts";

const NOW = 1_755_000_000; // fixo, pra determinismo

type MetaCall = { url: string; body: Record<string, unknown> };

function routedFetch() {
  const metaCalls: MetaCall[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("graph.facebook.com")) {
      metaCalls.push({ url: u, body: init?.body ? JSON.parse(init.body as string) : {} });
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { id: "sub_1", status: "active" } }), { status: 201 });
  }) as typeof fetch;
  return { fn, metaCalls };
}

/** `event_id` do único evento que saiu pra Meta naquela requisição. */
function sentEventId(metaCalls: MetaCall[]): string {
  assert.equal(metaCalls.length, 1, "esperava exatamente 1 chamada ao Graph API");
  const data = metaCalls[0].body.data as { event_id: string }[];
  return data[0].event_id;
}

describe("#8572 — resolveCompleteRegistrationDedup", () => {
  it("devolve o MESMO id que o evento da CAPI carrega, pro mesmo (e-mail, event_time)", async () => {
    const dedup = await resolveCompleteRegistrationDedup("leitor@example.com", NOW);
    const event = await buildCompleteRegistrationEvent({
      email: "leitor@example.com",
      eventSourceUrl: "https://diar.ia.br/assinar",
      eventTimeSeconds: dedup.eventTimeSeconds,
    });
    assert.equal(dedup.eventTimeSeconds, NOW);
    assert.equal(dedup.eventId, event.event_id);
    assert.equal(dedup.eventId, await computeCompleteRegistrationEventId("leitor@example.com", NOW));
  });

  it("normaliza o e-mail igual à CAPI — maiúsculas/espaço não produzem id diferente", async () => {
    const a = await resolveCompleteRegistrationDedup("  Leitor@Example.COM ", NOW);
    const b = await resolveCompleteRegistrationDedup("leitor@example.com", NOW);
    assert.equal(a.eventId, b.eventId);
  });

  it("o id MUDA na virada do dia UTC — é por isso que `eventTimeSeconds` precisa ser repassado", async () => {
    // 2 segundos de distância, dias UTC diferentes. Se o handler devolvesse o
    // id resolvido aqui e deixasse o builder chamar o próprio `Date.now()`,
    // todo cadastro feito na virada (21:00 BRT) sairia com ids divergentes e a
    // dedup pararia em silêncio — a mesma classe de bug que a #8572 já pagou.
    const ANTES = 1_755_043_199;
    const DEPOIS = 1_755_043_201;
    assert.notEqual(
      new Date(ANTES * 1000).toISOString().slice(0, 10),
      new Date(DEPOIS * 1000).toISOString().slice(0, 10),
      "os dois timestamps precisam cair em dias UTC diferentes pro teste valer",
    );
    const antes = await resolveCompleteRegistrationDedup("leitor@example.com", ANTES);
    const depois = await resolveCompleteRegistrationDedup("leitor@example.com", DEPOIS);
    assert.notEqual(antes.eventId, depois.eventId);
  });
});

describe("#8572 — o snippet do dataLayer carrega o event_id", () => {
  it("pushSignupConversionEventJs emite email E event_id dentro de eventProps", () => {
    const js = pushSignupConversionEventJs("email", "r.body.event_id");
    assert.match(js, /eventProps:\s*\{\s*email:\s*email,\s*event_id:\s*r\.body\.event_id\s*\}/);
    assert.match(js, /event:\s*"signedUp"/);
    // a chave é o contrato com a variável de camada de dados do GTM
    assert.equal(SIGNUP_CONVERSION_EVENT_ID_KEY, "event_id");
  });

  it("a página real de /assinar sai com o push completo — não só a função isolada", () => {
    const html = buildAssinarHtml();
    assert.match(html, /eventProps:\s*\{\s*email:\s*email,\s*event_id:\s*r\.body\.event_id\s*\}/);
    // e continua saindo SÓ no ramo de sucesso do cadastro, nunca no de erro
    const push = html.indexOf("eventProps");
    const guard = html.lastIndexOf("r.status === 200 && r.body && r.body.ok", push);
    assert.ok(guard !== -1 && guard < push, "o push precisa estar dentro do ramo de sucesso do form");
  });
});

describe("#8572 — wiring: o id que volta pro browser é o id que foi pra Meta", () => {
  function pollEnv(over: Partial<PollEnv> = {}): PollEnv {
    return {
      POLL: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
      } as unknown as PollEnv["POLL"],
      POLL_SECRET: "s",
      ADMIN_SECRET: "s",
      ALLOWED_ORIGINS: "*",
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
      META_CAPI_ACCESS_TOKEN: "tok",
      ...over,
    } as PollEnv;
  }

  function cursosEnv(over: Partial<CursosEnv> = {}): CursosEnv {
    return {
      ASSETS: {} as CursosEnv["ASSETS"],
      CURSOS_SUBSCRIBERS: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
      } as unknown as CursosEnv["CURSOS_SUBSCRIBERS"],
      COOKIE_HMAC_SECRET: "cookie-secret",
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
      META_CAPI_ACCESS_TOKEN: "tok",
      ...over,
    } as CursosEnv;
  }

  const payload = JSON.stringify({ name: "Ana", email: "ana@example.com", optin: true, website: "" });

  function pollReq(): Request {
    return new Request("https://eia.diar.ia.br/jogar/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
  }

  function cursosReq(): Request {
    return new Request("https://cursos.diar.ia.br/gate/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
  }

  it("poll: o event_id do corpo 200 é IDÊNTICO ao event_id do payload da CAPI", async () => {
    const { fn, metaCalls } = routedFetch();
    const res = await handleJogarSubscribe(pollReq(), pollEnv(), { fetchImpl: fn } as PollSubscribeDeps);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; event_id?: string };
    assert.equal(body.ok, true);
    assert.ok(body.event_id, "a resposta precisa trazer o event_id pro browser repassar ao fbq");
    assert.equal(body.event_id, sentEventId(metaCalls));
  });

  it("cursos: idem no gate", async () => {
    const { fn, metaCalls } = routedFetch();
    const res = await handleGateSubscribe(cursosReq(), cursosEnv(), { fetchImpl: fn });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; event_id?: string };
    assert.equal(body.ok, true);
    assert.ok(body.event_id);
    assert.equal(body.event_id, sentEventId(metaCalls));
  });

  it("sem META_CAPI_ACCESS_TOKEN: nenhum evento sai e a resposta NÃO ganha event_id", async () => {
    const { fn, metaCalls } = routedFetch();
    const res = await handleJogarSubscribe(pollReq(), pollEnv({ META_CAPI_ACCESS_TOKEN: undefined }), {
      fetchImpl: fn,
    } as PollSubscribeDeps);
    assert.equal(res.status, 200);
    // o aceite do #5504 ("sem token, nada muda") continua literal: corpo idêntico
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(metaCalls.length, 0);
  });

  it("cursos sem token: mesma degradação limpa, e o cookie de sessão não é afetado", async () => {
    const { fn, metaCalls } = routedFetch();
    const res = await handleGateSubscribe(cursosReq(), cursosEnv({ META_CAPI_ACCESS_TOKEN: undefined }), {
      fetchImpl: fn,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(metaCalls.length, 0);
    assert.ok(res.headers.get("Set-Cookie"), "o Set-Cookie do gate continua saindo");
  });
});
