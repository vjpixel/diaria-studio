/**
 * test/brevo-template-lint-14357.test.ts (#14357)
 *
 * Regressão da campanha Clarice #438 (27/11/2026): `{{ contact.NOME | lower |
 * capitalize }}` foi aceito no PUT, ficou `queued` e a Brevo suspendeu a
 * campanha no disparo. O guard recusa esse HTML ANTES da escrita na API
 * (`brevoPost`/`brevoPut`), e deixa passar o HTML corrigido que saiu.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  lintBrevoTemplate,
  lintBrevoCampaignPayload,
  isBrevoTemplatedWritePath,
  assertBrevoCampaignPayloadTemplateValid,
  BrevoTemplateLintError,
} from "../scripts/lib/brevo-template-lint.ts";
import { brevoPost, brevoPut } from "../scripts/lib/brevo-client.ts";
import { runLint } from "../scripts/brevo-template-lint.ts";
import { acquireRateStateTestLock, releaseRateStateTestLock } from "./_helpers/with-rate-state-lock.ts";

const BROKEN_438 = `<!doctype html><html><head><style>@media (max-width:600px){.a{width:100%!important}}</style></head>
<body><p>Olá, {{ contact.NOME | lower | capitalize }}!</p><a href="{{ unsubscribe }}">sair</a></body></html>`;

const FIXED_438 = `<!doctype html><html><head><style>@media (max-width:600px){.a{width:100%!important}}</style></head>
<body><p>{% if contact.NOME %}Olá, {{ contact.NOME }}!{% else %}Olá!{% endif %}</p><a href="{{ unsubscribe }}">sair</a></body></html>`;

describe("lintBrevoTemplate (#14357)", () => {
  it("recusa o HTML da campanha #438 (capitalize não existe na BTL)", () => {
    const issues = lintBrevoTemplate(BROKEN_438, "htmlContent");
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /"capitalize" não existe/);
    assert.match(issues[0].message, /capfirst/);
  });

  it("aceita o HTML corrigido que saiu (if/else sem filtro)", () => {
    assert.deepEqual(lintBrevoTemplate(FIXED_438, "htmlContent"), []);
  });

  it("aceita filtros documentados, com argumento em dois-pontos e pipe dentro de aspas", () => {
    const ok = [
      `{{ contact.FIRSTNAME | default:"there" | capfirst }}`,
      `{{ params.name | lower | capfirst }}`,
      `{% if params.d %}{{ params.d | time_parse:"2006-01-02" | date_i18n:"pt,2 January 2006" }}{% endif %}`,
      `{{ contact.X | default:"a | b" }}`,
      `{% for item in params.items limit:5 %}{{ item.name }}{% empty %}nada{% endfor %}`,
      `{% set total = params.total %}{{ total }}`,
      `{% if contact.COUNTRY == "FR" %}Bonjour{% elif contact.COUNTRY == "DE" %}Hallo{% else %}Oi{% endif %}`,
    ];
    for (const t of ok) assert.deepEqual(lintBrevoTemplate(t), [], t);
  });

  it("recusa forma com parênteses, filtro desconhecido, raw e number_format", () => {
    for (const t of [
      `{{ contact.X | default("y") }}`,
      `{{ contact.X | downcase }}`,
      `{{ params.html | raw }}`,
      `{{ params.v | number_format }}`,
      `{{ contact.X | }}`,
    ]) {
      assert.ok(lintBrevoTemplate(t).length > 0, t);
    }
  });

  it("recusa estrutura quebrada: else em for, if sem endif, tag desconhecida, {#, aspas curvas, tag aberta", () => {
    for (const t of [
      `{% for i in params.items %}x{% else %}y{% endfor %}`,
      `{% if contact.X %}sem fim`,
      `{% endif %}`,
      `{% unless contact.X %}x{% endunless %}`,
      `<p>{# comentário</p>`,
      `{{ contact.X | default:“oi” }}`,
      `{{ contact.X `,
      `{{ contact.<b>X</b> }}`,
    ]) {
      assert.ok(lintBrevoTemplate(t).length > 0, t);
    }
  });

  it("ignora o `}}` do CSS minificado dentro de <style>", () => {
    assert.deepEqual(lintBrevoTemplate(`<style>@media(x){.a{b:c}}</style><p>oi</p>`), []);
  });

  it("checa subject e previewText do payload, não outros campos", () => {
    const issues = lintBrevoCampaignPayload({
      subject: "{{ contact.NOME | capitalize }}, oferta",
      previewText: "ok",
      name: "{{ contact.NOME | capitalize }}",
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].field, "subject");
  });

  it("só vale para escrita de campanha/template", () => {
    assert.equal(isBrevoTemplatedWritePath("/emailCampaigns"), true);
    assert.equal(isBrevoTemplatedWritePath("/emailCampaigns/438"), true);
    assert.equal(isBrevoTemplatedWritePath("/smtp/templates/12"), true);
    assert.equal(isBrevoTemplatedWritePath("/emailCampaigns/438/sendNow"), false);
    assert.equal(isBrevoTemplatedWritePath("/contacts/import"), false);
    assert.doesNotThrow(() => assertBrevoCampaignPayloadTemplateValid("/contacts/import", { htmlContent: BROKEN_438 }));
    assert.throws(() => assertBrevoCampaignPayloadTemplateValid("/emailCampaigns/438", { htmlContent: BROKEN_438 }), BrevoTemplateLintError);
  });
});

describe("guard ligado em brevoPost/brevoPut antes de agendar (#14357)", () => {
  before(acquireRateStateTestLock);
  after(releaseRateStateTestLock);

  function withFetchSpy<T>(fn: (calls: string[]) => Promise<T>): Promise<T> {
    const orig = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 999 }),
        json: async () => ({ id: 999 }),
        headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return fn(calls).finally(() => {
      globalThis.fetch = orig;
    });
  }

  it("POST /emailCampaigns com filtro inválido é recusado sem chamar a API", async () => {
    await withFetchSpy(async (calls) => {
      await assert.rejects(
        () => brevoPost("fake-key", "/emailCampaigns", { name: "x", subject: "Oi", htmlContent: BROKEN_438, scheduledAt: "2026-11-28T09:00:00-03:00" }),
        BrevoTemplateLintError,
      );
      assert.equal(calls.length, 0);
    });
  });

  it("PUT /emailCampaigns/{id} com filtro inválido no htmlContent é recusado sem chamar a API", async () => {
    await withFetchSpy(async (calls) => {
      await assert.rejects(() => brevoPut("fake-key", "/emailCampaigns/438", { htmlContent: BROKEN_438 }), /#14357/);
      assert.equal(calls.length, 0);
    });
  });

  it("HTML válido passa e chega à API", async () => {
    await withFetchSpy(async (calls) => {
      const resp = await brevoPost("fake-key", "/emailCampaigns", { name: "x", subject: "Oi", htmlContent: FIXED_438 });
      assert.deepEqual(resp, { id: 999 });
      assert.equal(calls.length, 1);
    });
  });
});

describe("CLI brevo-template-lint (#14357)", () => {
  it("exit 1 com filtro inválido, 0 com válido, 2 sem entrada", () => {
    assert.equal(runLint({ text: "{{ contact.NOME | lower | capitalize }}" }).code, 1);
    assert.equal(runLint({ text: "{{ contact.NOME | default:\"leitor\" }}" }).code, 0);
    assert.equal(runLint({}).code, 2);
    assert.equal(runLint({ html: "/nao/existe.html" }).code, 2);
  });
});

describe("filtro em tag de bloco seguido de operador (#14380)", () => {
  it("aceita filtro válido seguido de operador dentro de {% if %}/{% elif %}", () => {
    for (const t of [
      `{% if params.items|length > 0 %}x{% endif %}`,
      `{% if contact.X|lower == "sim" %}x{% endif %}`,
      `{% if contact.X | lower != "não" and contact.Y %}x{% endif %}`,
      `{% if contact.X|length>=3 or contact.Z|upper == "A" %}x{% endif %}`,
      `{% if (contact.X|lower == "a") %}x{% endif %}`,
      `{% if contact.X|lower in "abc" %}x{% endif %}`,
      `{% if contact.A %}a{% elif contact.X|lower == "b" %}b{% endif %}`,
      `{% if contact.X|default:"a" == "b" %}x{% endif %}`,
    ]) {
      assert.deepEqual(lintBrevoTemplate(t), [], t);
    }
  });

  it("segue recusando filtro inexistente, com parênteses ou sobra sem operador no bloco", () => {
    assert.match(lintBrevoTemplate(`{% if contact.X|capitalize == "Sim" %}x{% endif %}`)[0].message, /"capitalize" não existe/);
    assert.match(lintBrevoTemplate(`{% if contact.X|lower() == "a" %}x{% endif %}`)[0].message, /parênteses/);
    assert.match(lintBrevoTemplate(`{% if contact.X|lower lixo %}x{% endif %}`)[0].message, /sobra inesperada/);
  });

  it("em {{ }} a sobra continua estrita", () => {
    assert.match(lintBrevoTemplate(`{{ contact.X|lower == "sim" }}`)[0].message, /sobra inesperada/);
  });
});
