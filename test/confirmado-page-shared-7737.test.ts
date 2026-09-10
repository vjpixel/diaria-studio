/**
 * test/confirmado-page-shared-7737.test.ts (#7737)
 *
 * Regressão (#633) pra `scripts/lib/shared/confirmado-page.ts` — o render
 * puro da página de confirmação do double opt-in, extraído de
 * `workers/poll/src/confirmado.ts` quando a página passou a ser servida no
 * apex (`diar.ia.br/confirmado`, Worker `site`) em vez de
 * `eia.diar.ia.br/confirmado` (Worker `poll`, que agora só faz 301).
 *
 * Substitui a cobertura de conteúdo que antes vivia em
 * `test/poll-confirmado-5167.test.ts` (esse arquivo agora cobre só o
 * redirect do Worker `poll` — ver `test/site-worker-confirmado-7737.test.ts`
 * pro wiring do Worker `site`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderConfirmadoPage, handleConfirmadoPage, PAGE_URL } from "../scripts/lib/shared/confirmado-page.ts";
import { GTM_CONTAINER_ID } from "../scripts/lib/shared/seo-meta.ts";

describe("renderConfirmadoPage (#7737) — unit", () => {
  it("PAGE_URL é diar.ia.br/confirmado (apex — antes era eia.diar.ia.br)", () => {
    assert.equal(PAGE_URL, "https://diar.ia.br/confirmado");
  });

  it("confirma o cadastro e diz quando a 1ª edição chega", () => {
    const html = renderConfirmadoPage();
    assert.match(html, /Assinatura confirmada/);
    assert.match(html, /primeira edição chega/);
  });

  it("linka as 4 portas — cursos, livros, jogo, arquivo", () => {
    const html = renderConfirmadoPage();
    assert.match(html, /<a href="https:\/\/cursos\.diar\.ia\.br\/">/);
    assert.match(html, /<a href="https:\/\/livros\.diar\.ia\.br\/">/);
    assert.match(html, /<a href="https:\/\/eia\.diar\.ia\.br\/jogar">/);
    assert.match(html, /<a href="https:\/\/arquivo\.diar\.ia\.br\/">/);
  });

  it("porta de cursos (#5518 B4) cumpre a promessa do e-mail de confirmação", () => {
    const html = renderConfirmadoPage();
    assert.match(html, /Cursos gratuitos de IA/);
  });

  it("(#7855) sem o CTA do formulário de interesses — removido a pedido do editor", () => {
    const html = renderConfirmadoPage();
    assert.doesNotMatch(html, /confirmado-survey/);
    assert.doesNotMatch(html, /f7528798-f8d5-4fcd-98c2-dc113e8c268b/);
    assert.doesNotMatch(html, /Responder o formulário de interesses/);
  });

  it("<title> e canonical batem com PAGE_URL (apex)", () => {
    const html = renderConfirmadoPage();
    assert.match(html, /<title>Assinatura confirmada — diar\.ia\.br<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/confirmado">/);
  });
});

describe("renderConfirmadoPage (#5499 item 5) — instrumentação GTM/GA4/pixel", () => {
  it("carrega o container GTM canônico no <head> (GA4/Meta Pixel vivem dentro do container, não hardcoded aqui)", () => {
    const html = renderConfirmadoPage();
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    assert.ok(headMatch, "sem <head>...</head> pra inspecionar");
    const head = headMatch![1];
    assert.match(head, /googletagmanager\.com\/gtm\.js/, "script do GTM ausente do <head>");
    assert.match(head, new RegExp(`['"]${GTM_CONTAINER_ID}['"]`), `container ID (${GTM_CONTAINER_ID}) ausente do <head>`);
  });

  it("não referencia gclid/fbclid/msclkid/li_fat_id (#5499 item 7 — não se aplica a /confirmado, ver docstring do módulo)", () => {
    const html = renderConfirmadoPage();
    assert.doesNotMatch(html, /gclid|fbclid|msclkid|li_fat_id/i);
  });
});

describe("handleConfirmadoPage (#7737) — Response", () => {
  it("200, HTML, cacheável", async () => {
    const res = handleConfirmadoPage();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html;charset=utf-8");
    assert.ok(res.headers.get("Cache-Control")?.includes("public"));
    const body = await res.text();
    assert.match(body, /Assinatura confirmada/);
  });
});
