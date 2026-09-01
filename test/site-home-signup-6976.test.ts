/**
 * test/site-home-signup-6976.test.ts (#6976)
 *
 * Regressão do bug descrito na issue: o "form" de inscrição do hero da home
 * (`workers/site/public/index.html`) era um `<a href="/assinar">` estilizado
 * como campo + botão (`<span aria-hidden="true">seu@email.com</span>`) — o
 * visitante clicava, ia pra `/assinar` e digitava o e-mail de novo.
 * `<form>` = 0, `<input>` = 0 na home; 2 ocorrências (masthead + rodapé).
 *
 * Este teste trava o invariante inverso: a home tem 2 `<form>` reais com
 * `<input type="email">`, `<a class="signup">` deixou de existir, e o
 * mecanismo de submit (POST inline, UTM passthrough, `id`s sem colisão,
 * `/assinar` intocada) continua no lugar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndexHtml } from "../scripts/lib/site-home-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "workers", "site", "public");
const INDEX_PATH = resolve(PUBLIC_DIR, "index.html");
const ASSINAR_PATH = resolve(PUBLIC_DIR, "assinar", "index.html");

describe("workers/site/public/index.html — form de inscrição inline (#6976)", () => {
  const html = readFileSync(INDEX_PATH, "utf8");

  it("tem exatamente 2 <form>, cada um com <input type=\"email\"> real", () => {
    // `<form class="` (não só `<form\b`) pra não casar a referência textual
    // "<form>" dentro do comentário do <script> de wire-up mais abaixo.
    const forms = html.match(/<form class="/g) ?? [];
    assert.equal(forms.length, 2, `esperava 2 <form> na home, achou ${forms.length}`);
    const emailInputs = html.match(/<input[^>]*type="email"[^>]*>/g) ?? [];
    assert.equal(emailInputs.length, 2, `esperava 2 <input type="email">, achou ${emailInputs.length}`);
  });

  it("não existe mais <a class=\"signup\"> (o link disfarçado de campo)", () => {
    assert.ok(!/<a\s+class="signup/.test(html), "ainda existe um <a class=\"signup...\"> — regressão do bug original");
  });

  it("não existe mais o span decorativo aria-hidden fingindo ser input", () => {
    assert.ok(
      !/<span class="signup-input" aria-hidden="true">/.test(html),
      "o span falso-input ainda está presente",
    );
  });

  it("os 2 forms têm id distinto (masthead-form / footer-form) — sem colisão", () => {
    assert.match(html, /<form[^>]*id="masthead-form"/);
    assert.match(html, /<form[^>]*id="footer-form"/);
    // IDs dos <input> de e-mail também são únicos por form (evita colisão de label/for)
    assert.match(html, /id="masthead-form-email"/);
    assert.match(html, /id="footer-form-email"/);
  });

  it("os 2 forms POSTam pra https://eia.diar.ia.br/jogar/subscribe, mesma lógica de /assinar", () => {
    const actions = html.match(/<form[^>]*action="([^"]+)"/g) ?? [];
    assert.equal(actions.length, 2);
    for (const a of actions) {
      assert.match(a, /action="https:\/\/eia\.diar\.ia\.br\/jogar\/subscribe"/);
    }
  });

  it("os 2 forms carregam os 3 campos ocultos de UTM (source/medium/campaign)", () => {
    for (const name of ["utm_source", "utm_medium", "utm_campaign"]) {
      const matches = html.match(new RegExp(`<input type="hidden" name="${name}"`, "g")) ?? [];
      assert.equal(matches.length, 2, `esperava 2 campos ocultos "${name}", achou ${matches.length}`);
    }
  });

  it("cada form tem checkbox de opt-in obrigatória (LGPD — mesma exigência do servidor de /assinar)", () => {
    const optins = html.match(/<input type="checkbox" name="optin" value="on" required>/g) ?? [];
    assert.equal(optins.length, 2, `esperava 2 checkboxes de opt-in, achou ${optins.length}`);
  });

  it("script wire-up usa querySelectorAll (\"form.signup\"), nunca getElementById fixo", () => {
    assert.match(html, /document\.querySelectorAll\(["']form\.signup["']\)/);
    assert.ok(!/getElementById\(["'](masthead|footer)-form["']\)/.test(html), "script ainda usa getElementById fixo — reintroduziria colisão de id");
  });

  it("cada form tem label associado ao input de e-mail (acessibilidade)", () => {
    assert.match(html, /<label class="signup-label" for="masthead-form-email">/);
    assert.match(html, /<label class="signup-label" for="footer-form-email">/);
  });
});

describe("workers/site/public/assinar/index.html — segue existindo e intocada (#6976)", () => {
  it("o arquivo continua existindo como página autônoma", () => {
    assert.ok(existsSync(ASSINAR_PATH), "/assinar foi removida — a issue #6976 pede que ela continue funcionando");
  });

  it("continua com seu próprio form independente, POST pro mesmo endpoint", () => {
    const html = readFileSync(ASSINAR_PATH, "utf8");
    assert.match(html, /<form id="assinar-form" method="POST" action="https:\/\/eia\.diar\.ia\.br\/jogar\/subscribe"/);
  });
});

describe("renderSignupForm / buildIndexHtml — miolo puro (#6976)", () => {
  const html = buildIndexHtml({ feature: null, archive: [] });

  it("gera 2 <form class=\"signup\"...> com ids distintos passados pelo caller", () => {
    assert.match(html, /<form class="signup" id="masthead-form"/);
    assert.match(html, /<form class="signup signup--dark" id="footer-form"/);
  });

  it("o input de e-mail tem placeholder (não mais texto decorativo em span)", () => {
    assert.match(html, /<input type="email" class="signup-input" id="masthead-form-email" name="email" placeholder="seu@email\.com" required/);
  });
});
