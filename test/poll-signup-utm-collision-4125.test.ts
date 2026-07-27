/**
 * test/poll-signup-utm-collision-4125.test.ts (#4125 item 4)
 *
 * Três funis de assinatura colapsavam no mesmo UTM: `identify.ts` (opt-in do
 * form de IDENTIDADE, #3975, usado em `/jogar` + sequência) chamava
 * `subscribeToBeehiiv` sem o 4º argumento (`utm`), e `jogar.ts` chamava
 * `inlineSignupScript()` sem `source` na página do quiz — ambos caíam no
 * default `SUBSCRIBE_UTM_BY_SOURCE.jogar` (medium "jogar-inline", campaign
 * "eia-jogar-inline-signup" — nome do form standalone #3580, que desde o
 * #3975 só sobrevive em `/jogar/quiz`). Resultado: a conversão do form de
 * IDENTIDADE (`/jogar`, sequência) e a do form do QUIZ ficavam
 * indistinguíveis na atribuição.
 *
 * FIX: novo UTM `JOGAR_IDENTIFY_INLINE_UTM` (source `jogar-identify`,
 * registrado em utm-registry.ts) — `identify.ts` passa
 * `resolveSubscribeUtm("jogar-identify")` explicitamente pro 4º argumento de
 * `subscribeToBeehiiv`. `jogar.ts` (quiz) passa `inlineSignupScript("jogar")`
 * explicitamente — MESMO valor que o default (`""`) já resolvia, só que
 * agora explícito (sem depender do fallthrough), preservando a atribuição
 * "jogar-inline" que já era correta pro form standalone do #3580.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSubscribeUtm } from "../workers/poll/src/subscribe.ts";
import { handleJogarIdentify } from "../workers/poll/src/identify.ts";
import { inlineSignupScript } from "../workers/poll/src/jogar.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import type { Env } from "../workers/poll/src/index.ts";

const ANON_A = "22222222-2222-4222-8222-222222222222@web.eia.diaria.local";

describe("resolveSubscribeUtm — jogar-identify não colide mais com jogar (#4125 item 4)", () => {
  it("jogar-identify: source eia-standalone, medium/campaign PRÓPRIOS", () => {
    const utm = resolveSubscribeUtm("jogar-identify");
    assert.equal(utm.source, "eia-standalone");
    assert.equal(utm.medium, "jogar-identify");
    assert.equal(utm.campaign, "eia-jogar-identify-signup");
  });

  it("jogar-identify é DISTINTO de jogar (o form standalone do #3580, hoje só no quiz)", () => {
    const identify = resolveSubscribeUtm("jogar-identify");
    const jogar = resolveSubscribeUtm("jogar");
    assert.notEqual(identify.medium, jogar.medium, "medium não pode colidir — é exatamente o bug do #4125 item 4");
    assert.notEqual(identify.campaign, jogar.campaign);
    assert.equal(jogar.medium, "jogar-inline", "regressão: o form do quiz continua emitindo o valor pré-existente");
    assert.equal(jogar.campaign, "eia-jogar-inline-signup");
  });

  it("source ausente/desconhecido continua caindo no default jogar (comportamento pré-existente preservado)", () => {
    assert.deepEqual(resolveSubscribeUtm(undefined), resolveSubscribeUtm("jogar"));
    assert.deepEqual(resolveSubscribeUtm("algo-desconhecido"), resolveSubscribeUtm("jogar"));
  });
});

describe("inlineSignupScript(\"jogar\") — quiz explícito, mesmo valor de antes (#4125 item 4)", () => {
  it("payload do form embutido no script manda source=jogar", () => {
    const script = inlineSignupScript("jogar");
    assert.match(script, /source:\s*"jogar"/, "quiz deve mandar source explícito, não depender do default vazio");
  });
});

describe("handleJogarIdentify — opt-in usa UTM jogar-identify, não jogar-inline (#4125 item 4)", () => {
  function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
    return {
      POLL: makeTrackedKv(seed),
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
      BEEHIIV_API_KEY: "test-key",
      BEEHIIV_PUBLICATION_ID: "pub_test",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
    } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
  }

  function identifyRequest(body: unknown): Request {
    return new Request("https://poll.test/jogar/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("POST /jogar/identify com optin:true chama a Beehiiv com utm_medium=jogar-identify (não jogar-inline)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock: typeof fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: "sub_1" }), { status: 201 });
    }) as typeof fetch;

    const env = makeEnv();
    const res = await handleJogarIdentify(
      identifyRequest({ name: "Ana", email: "ana@x.com", anonEmail: ANON_A, optin: true, edition: "" }),
      env,
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; subscribed: boolean };
    assert.equal(body.subscribed, true, "sanity: assinatura deve ter sido bem-sucedida (mock 201)");

    assert.equal(calls.length, 1, "subscribeToBeehiiv deve ter feito exatamente 1 chamada");
    const sentBody = calls[0].body;
    assert.equal(sentBody.utm_source, "eia-standalone");
    assert.equal(sentBody.utm_medium, "jogar-identify", "REGRESSÃO #4125 item 4: antes disso, saía 'jogar-inline' — colidindo com o form do quiz");
    assert.equal(sentBody.utm_campaign, "eia-jogar-identify-signup");
  });

  it("optin:false continua sem chamar a Beehiiv (comportamento pré-existente preservado)", async () => {
    let called = false;
    const fetchMock: typeof fetch = (async () => {
      called = true;
      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    const env = makeEnv();
    await handleJogarIdentify(
      identifyRequest({ name: "Ana", email: "ana2@x.com", anonEmail: ANON_A, optin: false, edition: "" }),
      env,
      { fetchImpl: fetchMock },
    );
    assert.equal(called, false);
  });
});
