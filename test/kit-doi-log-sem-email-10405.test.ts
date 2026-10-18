/**
 * test/kit-doi-log-sem-email-10405.test.ts (#10405)
 *
 * `mensagemSubscriberIdAusente` (scripts/lib/shared/kit-doi.ts) gravava o
 * e-mail do assinante em claro no log do Worker quando o Kit respondia 2xx
 * sem `subscriber.id`. Os três workers que criam assinante (poll, cursos,
 * reativar — este nos dois ramos, DOI e token) passam por ela. Cada ponto de
 * uso é exercitado aqui pelo código real do worker, capturando todo o console.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extrairSubscriberId, mensagemSubscriberIdAusente } from "../scripts/lib/shared/kit-doi.ts";
import { redactLogValues } from "../scripts/lib/shared/meta-capi.ts";
import { subscribeViaConfiguredBackend as cursosSubscribe } from "../workers/cursos/src/subscribe.ts";
import { subscribeViaConfiguredBackend as pollSubscribe } from "../workers/poll/src/subscribe.ts";
import { activateSubscriptionKit } from "../workers/reativar/src/index.ts";

const FORM = "9897918";
const EMAIL = "pessoa.real@exemplo.com.br";
/** Como chega do formulário do cursos (só `trim()`, sem `toLowerCase()`). #10416 */
const EMAIL_MISTO = "Pessoa.Real@Exemplo.com.br";

/**
 * #10416: Response 2xx cujo `.json()` lança com o corpo INTEIRO na mensagem.
 * O V8 corta o trecho do corpo em 10 chars (então um `new Response("... e-mail")`
 * nunca põe o e-mail inteiro no erro e o teste não discriminava); outro runtime
 * pode não cortar. Isto força o pior caso.
 */
function naoJsonQueEcoa(corpo: string, status = 200): Response {
  const erro = new SyntaxError(`Unexpected token, "${corpo}" is not valid JSON`);
  const fake = { ok: true, status, json: async () => { throw erro; }, text: async () => corpo };
  return { ...fake, clone: () => fake } as unknown as Response;
}

/** Todas as caixas do e-mail que podem aparecer no log. */
function semNenhumaCaixa(linhas: string[], email: string): string[] {
  const e = email.toLowerCase();
  return linhas.filter((l) => l.toLowerCase().includes(e));
}

/** Resposta 2xx sem `subscriber.id`; `extra` permite simular o Kit ecoando o e-mail. */
function semId(status = 200, corpo: unknown = { ok: true }): Response {
  return new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function capturarConsole(fn: () => Promise<unknown>): Promise<string[]> {
  const linhas: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  const push = (...a: unknown[]) => { linhas.push(a.map(String).join(" ")); };
  console.error = push;
  console.warn = push;
  console.log = push;
  console.info = push;
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return linhas;
}

describe("#10405 mensagemSubscriberIdAusente — nunca carrega o e-mail", () => {
  it("campo-ausente: sem e-mail, mas com status e causa", () => {
    const m = mensagemSubscriberIdAusente({ ok: false, motivo: "campo-ausente" }, EMAIL, 200);
    assert.equal(m.includes(EMAIL), false);
    assert.match(m, /sem subscriber\.id/);
    assert.match(m, /status 200/);
  });

  it("parse-falhou / tipo-inesperado: e-mail ecoado pelo Kit no detalhe é redigido (inclusive escapado em JSON)", () => {
    const p = mensagemSubscriberIdAusente(
      { ok: false, motivo: "parse-falhou", detalhe: `SyntaxError: "<p>${EMAIL}</p>" is not valid JSON` },
      EMAIL,
      200,
    );
    assert.equal(p.includes(EMAIL), false, p);
    assert.match(p, /\[redacted\]/);
    const t = mensagemSubscriberIdAusente({ ok: false, motivo: "tipo-inesperado", bruto: EMAIL }, EMAIL, 201);
    assert.equal(t.includes(EMAIL), false, t);
  });
});

describe("#10405 pontos de uso nos workers — log da falha sem o e-mail", () => {
  it("poll: 2xx sem subscriber.id com DOI configurado", async () => {
    const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4", KIT_DOI_FORM_ID: FORM } as never;
    const linhas = await capturarConsole(() => pollSubscribe(env, { name: "", email: EMAIL }, (async () => semId()) as typeof fetch));
    assert.ok(linhas.some((l) => l.includes("sem subscriber.id")), "a falha precisa continuar logada");
    assert.deepEqual(linhas.filter((l) => l.includes(EMAIL)), [], "e-mail em claro no log do poll");
  });

  it("cursos: resposta não-JSON cujo erro de parse traz o e-mail inteiro (#10416)", async () => {
    const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4", KIT_DOI_FORM_ID: FORM } as never;
    const linhas = await capturarConsole(() =>
      cursosSubscribe(env, { name: "N", email: EMAIL }, (async () => naoJsonQueEcoa(`ok ${EMAIL}`)) as typeof fetch),
    );
    assert.ok(linhas.some((l) => l.includes("[kit-doi]") && l.includes("não parseou")), "a falha precisa continuar logada");
    assert.deepEqual(semNenhumaCaixa(linhas, EMAIL), [], "e-mail em claro no log do cursos");
  });

  it("cursos: e-mail com maiúsculas no form, Kit ecoa em minúsculas no subscriber.id (#10416)", async () => {
    const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4", KIT_DOI_FORM_ID: FORM } as never;
    const linhas = await capturarConsole(() =>
      cursosSubscribe(env, { name: "N", email: EMAIL_MISTO }, (async () => semId(200, { subscriber: { id: EMAIL } })) as typeof fetch),
    );
    assert.ok(linhas.some((l) => l.includes("[kit-doi]") && l.includes("não number")), "a falha precisa continuar logada");
    assert.deepEqual(semNenhumaCaixa(linhas, EMAIL), [], "e-mail (em qualquer caixa) em claro no log do cursos");
  });

  it("cursos: erro não-2xx com e-mail ecoado em outra caixa (#10416)", async () => {
    const env = { SUBSCRIBE_BACKEND: "kit", KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4", KIT_DOI_FORM_ID: FORM } as never;
    const linhas = await capturarConsole(() =>
      cursosSubscribe(env, { name: "N", email: EMAIL_MISTO }, (async () =>
        new Response(JSON.stringify({ errors: [`${EMAIL} inválido`] }), { status: 400 })) as typeof fetch),
    );
    assert.ok(linhas.some((l) => l.includes("Kit respondeu 400")), "a falha precisa continuar logada");
    assert.deepEqual(semNenhumaCaixa(linhas, EMAIL), [], "e-mail (em qualquer caixa) em claro no log do cursos");
  });

  it("reativar (ramo DOI): evento reativar_kit_doi_sem_subscriber_id sem campo email", async () => {
    const env = { KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4", KIT_DOI_FORM_ID: FORM } as never;
    const fetchImpl = async (u: URL | RequestInfo) =>
      String(u).includes("?email_address=") ? semId(200, { subscribers: [] }) : semId(201);
    const linhas = await capturarConsole(() => activateSubscriptionKit(env, EMAIL, fetchImpl as typeof fetch));
    const evento = linhas.find((l) => l.includes("reativar_kit_doi_sem_subscriber_id"));
    assert.ok(evento, "evento de falha precisa existir");
    assert.equal("email" in JSON.parse(evento!), false);
    assert.deepEqual(linhas.filter((l) => l.includes(EMAIL)), [], "e-mail em claro no log do reativar (DOI)");
  });

  it("reativar (ramo token): evento reativar_kit_token_sem_subscriber_id sem o e-mail", async () => {
    const env = { KIT_API_KEY: "k", KIT_API_URL: "https://kit.test/v4", KIT_DOI_FORM_ID: FORM } as never;
    const fetchImpl = async (u: URL | RequestInfo) =>
      String(u).includes("?email_address=") ? semId(200, { subscribers: [] }) : semId(201);
    const linhas = await capturarConsole(() => activateSubscriptionKit(env, EMAIL, fetchImpl as typeof fetch, true));
    assert.ok(linhas.some((l) => l.includes("reativar_kit_token_sem_subscriber_id")), "evento de falha precisa existir");
    assert.deepEqual(linhas.filter((l) => l.includes(EMAIL)), [], "e-mail em claro no log do reativar (token)");
  });
});

describe("#10416 redação case-insensitive e detalhe de parse só com o nome do erro", () => {
  it("redactLogValues redige o valor em qualquer caixa, nos dois sentidos", () => {
    assert.equal(redactLogValues(`x ${EMAIL} y`, [EMAIL_MISTO]), "x [redacted] y");
    assert.equal(redactLogValues(`x ${EMAIL_MISTO} y`, [EMAIL]), "x [redacted] y");
    assert.equal(redactLogValues(`x ${EMAIL.toUpperCase()} y`, [EMAIL_MISTO]), "x [redacted] y");
  });

  it("redactLogValues trata metacaractere de regex como literal", () => {
    assert.equal(redactLogValues("a.b+c@x.com e aXb+c@x.com", ["a.b+c@x.com"]), "[redacted] e aXb+c@x.com");
    assert.equal(redactLogValues("ua (Mozilla) [5]", ["(Mozilla) [5]"]), "ua [redacted]");
  });

  it("mensagemSubscriberIdAusente: e-mail em outra caixa no bruto é redigido", () => {
    const m = mensagemSubscriberIdAusente({ ok: false, motivo: "tipo-inesperado", bruto: EMAIL }, EMAIL_MISTO, 201);
    assert.deepEqual(semNenhumaCaixa([m], EMAIL), [], m);
  });

  it("extrairSubscriberId: parse-falhou carrega só o nome do erro, nunca o trecho do corpo", async () => {
    const r = await extrairSubscriberId(naoJsonQueEcoa(`ok ${EMAIL}`));
    assert.deepEqual(r, { ok: false, motivo: "parse-falhou", detalhe: "SyntaxError" });
    // Response real (V8): o trecho de 10 chars do corpo seria um PREFIXO do e-mail.
    const real = await extrairSubscriberId(new Response(EMAIL, { status: 200 }));
    assert.deepEqual(real, { ok: false, motivo: "parse-falhou", detalhe: "SyntaxError" });
  });
});
