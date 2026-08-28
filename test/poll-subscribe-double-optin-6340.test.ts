/**
 * test/poll-subscribe-double-optin-6340.test.ts (#6340)
 *
 * Cobre a fatia implementada nesta unidade: `workers/poll/src/subscribe.ts`
 * (`subscribeViaConfiguredBackend` → `subscribeToKit`) passa a criar
 * subscriber com `state: "inactive"` quando `DOUBLE_OPT_IN_FLAG` está ativo
 * pra este worker (`optin-flag-6340.ts`, `enabledForWorkers: ["poll"]`), e
 * dispara o vínculo de form (`vincularKitDoiForm`) que carrega o e-mail de
 * confirmação, sem tocar o backend Beehiiv nem qualquer subscriber já
 * existente na base.
 *
 * O que este teste NÃO cobre (fora de escopo desta unidade, ver PR body):
 * a promoção pending→active-no-Kit (item 4 da issue) e a alimentação do
 * canal Brevo a partir do cohort `inactive` do Kit (item 3) — ambos exigem
 * tocar `scripts/evaluate-brevo-diaria.ts`, deliberadamente fora desta PR
 * por risco de regressão num script de produção sensível sem teste ao vivo
 * disponível nesta sessão.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

type FetchMock = typeof fetch & { calls: Array<{ url: string; init: RequestInit | undefined }> };

function makeFetchMock(
  responses: Array<{ status: number; body: unknown }> = [{ status: 201, body: { subscriber: { id: 42 } } }],
): FetchMock {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as FetchMock;
  fn.calls = calls;
  return fn;
}

function bodyOf(call: { init: RequestInit | undefined }): Record<string, unknown> {
  return JSON.parse(String(call.init?.body ?? "{}"));
}

describe("subscribeToKit — double opt-in (#6340)", () => {
  it("worker poll (na allowlist do flag) cria subscriber com state: inactive", async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/poll/src/subscribe.ts");
    const fetchMock = makeFetchMock();
    const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "kk" } as any;
    await subscribeViaConfiguredBackend(env, { name: "", email: "novo@example.com" }, fetchMock);
    assert.equal(fetchMock.calls[0].url, "https://api.kit.com/v4/subscribers");
    assert.equal(bodyOf(fetchMock.calls[0]).state, "inactive");
  });

  it("vincula ao KIT_DOI_FORM_ID (dispara e-mail de confirmação) quando configurado", async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/poll/src/subscribe.ts");
    const fetchMock = makeFetchMock([{ status: 201, body: { subscriber: { id: 42 } } }]);
    const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "kk", KIT_DOI_FORM_ID: "999" } as any;
    await subscribeViaConfiguredBackend(env, { name: "", email: "novo@example.com" }, fetchMock);
    assert.equal(fetchMock.calls.length, 2);
    assert.equal(fetchMock.calls[1].url, "https://api.kit.com/v4/forms/999/subscribers/42");
    const formBody = bodyOf(fetchMock.calls[1]);
    assert.match(String(formBody.referrer), /utm_source=/);
  });

  it("sem KIT_DOI_FORM_ID configurado, NÃO tenta vincular a nenhum form (fail-soft documentado)", async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/poll/src/subscribe.ts");
    const fetchMock = makeFetchMock([{ status: 201, body: { subscriber: { id: 42 } } }]);
    const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "kk" } as any;
    const result = await subscribeViaConfiguredBackend(env, { name: "", email: "novo@example.com" }, fetchMock);
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(result.ok, true);
  });

  it("falha ao vincular o form NÃO reverte o sucesso da assinatura (best-effort)", async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/poll/src/subscribe.ts");
    const fetchMock = makeFetchMock([
      { status: 201, body: { subscriber: { id: 42 } } },
      { status: 500, body: { error: "kit down" } },
    ]);
    const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "kk", KIT_DOI_FORM_ID: "999" } as any;
    const result = await subscribeViaConfiguredBackend(env, { name: "", email: "novo@example.com" }, fetchMock);
    assert.equal(result.ok, true);
    assert.equal(result.status, 201);
  });

  it("worker cursos (FORA da allowlist do flag) continua criando active — base existente e outros workers não regridem", async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/cursos/src/subscribe.ts");
    const fetchMock = makeFetchMock();
    const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "kk" } as any;
    await subscribeViaConfiguredBackend(env, { name: "", email: "novo@example.com" }, fetchMock);
    assert.equal(bodyOf(fetchMock.calls[0]).state, "active");
  });

  it("backend Beehiiv não é afetado pelo flag do Kit (double_opt_override continua off)", async () => {
    const { subscribeViaConfiguredBackend } = await import("../workers/poll/src/subscribe.ts");
    const fetchMock = makeFetchMock([{ status: 201, body: {} }]);
    const env = { BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "p" } as any;
    await subscribeViaConfiguredBackend(env, { name: "", email: "novo@example.com" }, fetchMock);
    assert.equal(bodyOf(fetchMock.calls[0]).double_opt_override, "off");
    assert.equal(bodyOf(fetchMock.calls[0]).state, undefined);
  });
});

describe("optin-flag-6340.ts — flag de rollout (#6340)", () => {
  it("enabledForWorkers só lista 'poll' — cursos/outros workers ficam fora até o próximo passo do rollout", async () => {
    const { DOUBLE_OPT_IN_FLAG } = await import("../workers/poll/src/optin-flag-6340.ts");
    assert.deepEqual(DOUBLE_OPT_IN_FLAG.enabledForWorkers, ["poll"]);
    assert.equal(DOUBLE_OPT_IN_FLAG.createState, "inactive");
    assert.equal(DOUBLE_OPT_IN_FLAG.scopeExcludesLegacyBase, true);
  });
});
