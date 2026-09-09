/**
 * test/kit-doi-integracao-workers-7723.test.ts (#7723)
 *
 * Testes de INTEGRAÇÃO do double opt-in em `cursos` e `reativar` — com
 * `KIT_DOI_FORM_ID` de fato configurado no env, exercitando o código real do
 * worker, não a lib isolada.
 *
 * Por que este arquivo existe: a 1ª versão da PR testava exaustivamente
 * `scripts/lib/shared/kit-doi.ts` em isolamento e ZERO integração. O review
 * apontou o buraco e ele não era teórico — escondia um P1 real: com DOI, o
 * `reativar` passa a devolver `beehiivStatus: "inactive"`, e o `handleConfirm`
 * só tratava `"active"` como sucesso. Todo clique legítimo no link de
 * reativação cairia na página "não conseguimos confirmar", mandando a pessoa
 * se recadastrar em outro lugar. Nenhum teste pegava, porque nenhum teste
 * configurava o form.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { subscribeViaConfiguredBackend } from "../workers/cursos/src/subscribe.ts";
import { activateSubscriptionKit, handleConfirm } from "../workers/reativar/src/index.ts";

const FORM = "9897918";

function respostaKit(id: number | null, status = 201): Response {
  const corpo = id === null ? {} : { subscriber: { id, email_address: "x@y.com", state: "inactive" } };
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
}

// ─── cursos ──────────────────────────────────────────────────────────────────

test("cursos: com DOI configurado, cria inactive E vincula ao form", async () => {
  const chamadas: { url: string; body: unknown }[] = [];
  const fetchImpl = async (u: URL | RequestInfo, init?: RequestInit) => {
    chamadas.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : null });
    return respostaKit(555);
  };
  const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4", KIT_DOI_FORM_ID: FORM } as never;

  const r = await subscribeViaConfiguredBackend(env, { name: "N", email: "a@b.com" }, fetchImpl as typeof fetch);

  assert.equal(r.ok, true);
  assert.equal(r.beehiivStatus, "inactive", "o retorno tem que refletir que ainda falta confirmar");

  const criacao = chamadas.find((c) => c.url.endsWith("/subscribers"));
  assert.ok(criacao, "criou o assinante");
  assert.equal((criacao!.body as { state?: string }).state, "inactive");

  const vinculo = chamadas.find((c) => c.url.includes(`/forms/${FORM}/subscribers/`));
  assert.ok(vinculo, "PRECISA vincular ao form — é o vínculo que dispara o e-mail de confirmação");
  assert.match(vinculo!.url, /\/subscribers\/555$/, "id do assinante vai no PATH, não no corpo");
});

test("cursos: SEM KIT_DOI_FORM_ID, volta ao comportamento antigo (active, sem vínculo)", async () => {
  const chamadas: string[] = [];
  const fetchImpl = async (u: URL | RequestInfo) => { chamadas.push(String(u)); return respostaKit(555); };
  const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4" } as never;

  const r = await subscribeViaConfiguredBackend(env, { name: "N", email: "a@b.com" }, fetchImpl as typeof fetch);
  assert.equal(r.beehiivStatus, "active");
  assert.equal(chamadas.some((u) => u.includes("/forms/")), false);
});

test("cursos: form de SISTEMA não prende ninguém em inactive", async () => {
  const chamadas: { url: string; body: unknown }[] = [];
  const fetchImpl = async (u: URL | RequestInfo, init?: RequestInit) => {
    chamadas.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : null });
    return respostaKit(555);
  };
  const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4", KIT_DOI_FORM_ID: "9839463" } as never;

  const r = await subscribeViaConfiguredBackend(env, { name: "N", email: "a@b.com" }, fetchImpl as typeof fetch);
  assert.equal(r.beehiivStatus, "active", "id inútil ⇒ nasce active, nunca inactive órfão (#6565)");
  assert.equal(chamadas.some((c) => c.url.includes("/forms/")), false);
});

test("cursos: vínculo falhando NÃO desfaz a assinatura (best-effort)", async () => {
  const fetchImpl = async (u: URL | RequestInfo) =>
    String(u).includes("/forms/") ? new Response("erro", { status: 500 }) : respostaKit(555);
  const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4", KIT_DOI_FORM_ID: FORM } as never;

  const r = await subscribeViaConfiguredBackend(env, { name: "N", email: "a@b.com" }, fetchImpl as typeof fetch);
  assert.equal(r.ok, true, "falha do e-mail não pode desfazer o cadastro");
  assert.equal(r.beehiivStatus, "inactive");
});

test("cursos: resposta 2xx sem subscriber.id não vincula, mas o log carrega o e-mail", async () => {
  const erros: string[] = [];
  const orig = console.error;
  console.error = (m?: unknown) => { erros.push(String(m)); };
  try {
    const fetchImpl = async () => respostaKit(null, 200);
    const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4", KIT_DOI_FORM_ID: FORM } as never;
    await subscribeViaConfiguredBackend(env, { name: "N", email: "perdido@b.com" }, fetchImpl as typeof fetch);
  } finally {
    console.error = orig;
  }
  const log = erros.find((e) => e.includes("perdido@b.com"));
  assert.ok(log, "sem o e-mail no log, esse assinante fica inactive e NINGUÉM consegue achá-lo depois");
});

// ─── reativar ────────────────────────────────────────────────────────────────

test("reativar: com DOI, activateSubscriptionKit devolve inactive e vincula", async () => {
  const chamadas: string[] = [];
  const fetchImpl = async (u: URL | RequestInfo) => {
    const url = String(u);
    chamadas.push(url);
    if (url.includes("?email_address=")) return new Response(JSON.stringify({ subscribers: [] }), { status: 200 });
    return respostaKit(777);
  };
  const env = { KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4", KIT_DOI_FORM_ID: FORM } as never;

  const r = await activateSubscriptionKit(env, "volta@b.com", fetchImpl as typeof fetch);
  assert.equal(r.ok, true);
  assert.equal(r.beehiivStatus, "inactive");
  assert.ok(chamadas.some((u) => u.includes(`/forms/${FORM}/subscribers/777`)), "vinculou ao form");
});

test("reativar: handleConfirm mostra 'falta 1 passo', NUNCA a página de falha (#7723 P1)", async () => {
  const fetchImpl = async (u: URL | RequestInfo) => {
    const url = String(u);
    if (url.includes("?email_address=")) return new Response(JSON.stringify({ subscribers: [] }), { status: 200 });
    if (url.includes("api.brevo.com")) return new Response(JSON.stringify({ emailBlacklisted: false }), { status: 200 });
    return respostaKit(777);
  };
  const env = {
    SUBSCRIBE_BACKEND: "kit",
    KIT_API_KEY: "k",
    KIT_API_URL: "https://kit.test/v4",
    KIT_DOI_FORM_ID: FORM,
  } as never;

  const res = await handleConfirm(
    new URL("https://reativar.diar.ia.br/?email=volta%40b.com"),
    env,
    fetchImpl as typeof fetch,
  );
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(html, /Falta 1 passo/, "o desfecho normal do clique com DOI é 'confirme no e-mail'");
  assert.doesNotMatch(
    html,
    /Ainda não confirmado/,
    "regressão do #7723: mandar a pessoa se recadastrar em outro lugar geraria um SEGUNDO DOI pendente",
  );
});
