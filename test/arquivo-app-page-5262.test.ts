/**
 * test/arquivo-app-page-5262.test.ts (#5262)
 *
 * Trava a rota `GET /app` do Worker `arquivo`.
 *
 * Por que existe: a PRIMEIRA tentativa de verificação de marca do projeto
 * Google Cloud `diaria-google-ads` foi REPROVADA com um único motivo — "A
 * página inicial não explica a finalidade do app" — porque o campo "Página
 * inicial do aplicativo" apontava para a home da newsletter. Esta página é a
 * correção, e passa a ser o valor daquele campo. O Google revalida a URL
 * enquanto a marca estiver verificada, então um 404 aqui derruba a
 * verificação em silêncio.
 *
 * As asserções de conteúdo cobrem exatamente o que o revisor procura: a
 * finalidade do app declarada, e as negativas que sustentam o pedido
 * (somente leitura, sem contas de terceiros, uso interno).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker from "../workers/arquivo/src/index.ts";
import { renderAppPage } from "../workers/arquivo/src/render-app.ts";

describe("#5262 — GET /app no Worker arquivo", () => {
  it("responde 200 em HTML, sem depender do sitemap", async () => {
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/app"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/html/);
  });

  it("aceita também a forma com barra final", async () => {
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/app/"));
    assert.equal(res.status, 200);
  });

  it("não colide com /temas/ nem com a raiz", async () => {
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/apple"));
    assert.equal(res.status, 404);
  });

  it("é indexável — a verificação do Google não pode bater numa página noindex", () => {
    assert.doesNotMatch(renderAppPage(), /name="robots"[^>]*noindex/);
  });

  it("declara a finalidade do app, que é o motivo da reprovação anterior", () => {
    const html = renderAppPage();
    assert.match(html, /finalidade do aplicativo/i);
    assert.match(html, /custo/i);
    assert.match(html, /Google Ads/);
  });

  it("declara somente leitura e ausência de contas de terceiros", () => {
    const html = renderAppPage();
    assert.match(html, /somente leitura/i);
    assert.match(html, /nenhuma operação de escrita/i);
    assert.match(html, /236-921-9639/);
  });

  it("aponta para a política de privacidade", () => {
    assert.match(renderAppPage(), /arquivo\.diar\.ia\.br\/privacidade/);
  });
});
