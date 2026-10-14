/**
 * test/meta-capi-ids-9265.test.ts (#9265)
 *
 * A remedição de EMQ de 01/10 (#9053) viu o `fbc` sumir do
 * `CompleteRegistration` (37,5% em 29/09 → 0) e o `external_id` sumir do
 * `SubscriptionConfirmed`, e levantou a hipótese de regressão do #8978/#8983.
 *
 * Investigação (14/10): não houve regressão de código.
 * - `fbc`: os braços pagos do teste 2608 foram pausados em 23/09 ~22h45 BRT
 *   (`data/aquisicao/teste-2608/run-state.json`, bloco
 *   `encerramento_antecipado`). A janela de 7 dias medida em 01/10
 *   (24/09–30/09) não tinha tráfego pago da Meta, então nenhum cadastro
 *   chegou com `fbclid`/`_fbc`. Sem clique da Meta não há `fbc` a enviar, e o
 *   código nunca fabrica um.
 * - `external_id` do `SubscriptionConfirmed`: na remedição de 14/10 ele já
 *   aparece nos dois eventos (resolvido pelo `origem_external_id` gravado no
 *   Kit desde o #8983 — coberto em `test/meta-external-id-8978.test.ts`,
 *   `runMetaConfirmationBatch`).
 *
 * O que faltava era um teste de PONTA A PONTA da forma real de produção do
 * `CompleteRegistration`: o form de `diar.ia.br` faz um POST CROSS-ORIGIN para
 * `eia.diar.ia.br`/`cursos.diar.ia.br`, sem header `Cookie` e, no caso comum,
 * sem `click_id` (o visitante chega pelo anúncio numa página e assina em outra,
 * sem `fbclid` na URL). Nesse caminho o `fbc` só existe porque o cliente lê
 * `_fbc` do próprio `document.cookie` e manda no corpo (`fbcBody`). Os testes
 * de wiring existentes (`test/meta-capi-8388.test.ts`) cobriam `fbc` vindo de
 * cookie ou de `click_id`; o de `test/meta-external-id-8978.test.ts` cobria
 * `fbcBody` só na função pura `extractMetaCapiClientSignals`. Se um handler
 * deixasse de repassar `v.fbc` para `fbcBody` (a regressão que o #9265
 * suspeitou), nenhum teste quebraria. Este arquivo fecha esse buraco.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleJogarSubscribe, type SubscribeDeps as PollSubscribeDeps } from "../workers/poll/src/subscribe.ts";
import type { Env as PollEnv } from "../workers/poll/src/index.ts";
import { handleGateSubscribe } from "../workers/cursos/src/subscribe.ts";
import type { Env as CursosEnv } from "../workers/cursos/src/index.ts";

type MetaCall = { url: string; body: Record<string, unknown> };
type CapturedEvent = { event_name: string; user_data: Record<string, unknown> };

const VID = "550e8400-e29b-41d4-a716-446655440000";
const FBC = "fb.1.1759000000000.IwAR2F4-dbP0l7Mn1IawQQ_aem_AbC";
const FBP = "fb.1.1759000000000.1234567890";

/** Graph API só é registrada em memória; nada sai do processo. */
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

function onlyEvent(metaCalls: MetaCall[]): CapturedEvent {
  assert.equal(metaCalls.length, 1, "esperava exatamente 1 chamada ao Graph API");
  return (metaCalls[0].body.data as CapturedEvent[])[0];
}

function kv() {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
  };
}

function pollEnv(): PollEnv {
  return {
    POLL: kv() as unknown as PollEnv["POLL"],
    POLL_SECRET: "s",
    ADMIN_SECRET: "s",
    ALLOWED_ORIGINS: "*",
    BEEHIIV_API_KEY: "k",
    BEEHIIV_PUBLICATION_ID: "pub_1",
    BEEHIIV_API_URL: "https://beehiiv.test/v2",
    META_CAPI_ACCESS_TOKEN: "tok",
  } as PollEnv;
}

function cursosEnv(): CursosEnv {
  return {
    ASSETS: {} as CursosEnv["ASSETS"],
    CURSOS_SUBSCRIBERS: kv() as unknown as CursosEnv["CURSOS_SUBSCRIBERS"],
    COOKIE_HMAC_SECRET: "cookie-secret",
    BEEHIIV_API_KEY: "k",
    BEEHIIV_PUBLICATION_ID: "pub_1",
    BEEHIIV_API_URL: "https://beehiiv.test/v2",
    META_CAPI_ACCESS_TOKEN: "tok",
  } as CursosEnv;
}

/** Forma real do POST cross-origin: sem `Cookie`, sem `click_id`, sem
 * `fbclid` no `Referer` — os 3 sinais só existem no corpo. */
function crossOriginRequest(url: string, extra: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://diar.ia.br",
      Referer: "https://diar.ia.br/assinar/",
    },
    body: JSON.stringify({ name: "Ana", email: "ana@example.com", optin: true, website: "", source: "apex", ...extra }),
  });
}

const handlers = [
  {
    name: "poll (eia.diar.ia.br — form da home e do /assinar)",
    run: (req: Request, fn: typeof fetch) =>
      handleJogarSubscribe(req, pollEnv(), { fetchImpl: fn } as PollSubscribeDeps),
    url: "https://eia.diar.ia.br/jogar/subscribe",
  },
  {
    name: "cursos (cursos.diar.ia.br — gate)",
    run: (req: Request, fn: typeof fetch) => handleGateSubscribe(req, cursosEnv(), { fetchImpl: fn }),
    url: "https://cursos.diar.ia.br/gate/subscribe",
  },
];

for (const h of handlers) {
  describe(`#9265 — CompleteRegistration cross-origin: fbc/fbp/external_id do CORPO chegam à CAPI (${h.name})`, () => {
    it("sem Cookie e sem click_id, fbc/fbp/external_id do corpo entram no user_data", async () => {
      const { fn, metaCalls } = routedFetch();
      const res = await h.run(crossOriginRequest(h.url, { fbc: FBC, fbp: FBP, external_id: VID, click_id: "" }), fn);
      assert.equal(res.status, 200);
      const event = onlyEvent(metaCalls);
      assert.equal(event.event_name, "CompleteRegistration");
      assert.equal(event.user_data.fbc, FBC);
      assert.equal(event.user_data.fbp, FBP);
      assert.deepEqual(event.user_data.external_id, [VID]);
    });

    it("cadastro orgânico (corpo sem fbc, sem click_id): fbc fica FORA do user_data, external_id continua", async () => {
      // É o cenário medido em 01/10 e 14/10: sem tráfego pago da Meta não há
      // `_fbc` no browser. O código não fabrica `fbc`; o `external_id` segue.
      const { fn, metaCalls } = routedFetch();
      const res = await h.run(crossOriginRequest(h.url, { fbc: "", fbp: FBP, external_id: VID, click_id: "" }), fn);
      assert.equal(res.status, 200);
      const event = onlyEvent(metaCalls);
      assert.ok(!("fbc" in event.user_data), "fbc não pode ser fabricado sem clique da Meta");
      assert.deepEqual(event.user_data.external_id, [VID]);
    });
  });
}
