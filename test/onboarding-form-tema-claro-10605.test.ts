/**
 * #10605 (decisão do editor de 09/11/2026): o formulário abre sempre claro,
 * inclusive com o aparelho no modo escuro. Antes, uma regra
 * `@media (prefers-color-scheme: dark)` trocava o fundo para preto e a letra
 * para branco. O teste trava as duas pontas: nenhuma regra de modo escuro e
 * `color-scheme: light` (meta + CSS), que mantém claros os campos nativos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderPage,
  renderFormHtml,
  renderThanksHtml,
  renderInvalidLinkHtml,
  renderErrorHtml,
} from "../workers/onboarding-form/src/render.ts";

const pages: [string, string][] = [
  ["renderPage", renderPage("<p>x</p>")],
  ["formulário", renderFormHtml("leitor@example.com", "sig")],
  ["obrigado", renderThanksHtml()],
  ["link inválido", renderInvalidLinkHtml()],
  ["erro", renderErrorHtml("falhou")],
];

describe("formulário sempre claro (#10605)", () => {
  for (const [name, html] of pages) {
    it(`${name}: sem regra de modo escuro e com color-scheme light`, () => {
      assert.doesNotMatch(html, /prefers-color-scheme/);
      assert.match(html, /<meta name="color-scheme" content="light">/);
      assert.match(html, /:root\{color-scheme:light\}/);
      assert.match(html, /--bg:#fff/);
    });
  }
});
