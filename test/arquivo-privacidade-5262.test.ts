/**
 * test/arquivo-privacidade-5262.test.ts (#5262)
 *
 * Trava a rota `GET /privacidade` do Worker `arquivo`.
 *
 * Por que existe: a URL é declarada na tela de consentimento OAuth do projeto
 * Google Cloud `diaria-google-ads` como o link de Política de Privacidade, e o
 * Google REVALIDA essa URL enquanto a marca estiver verificada. Se a rota
 * voltar a 404 (refactor de roteamento, import removido), a verificação de
 * marca cai e, com ela, o caminho de Basic Access da Google Ads API — uma
 * quebra silenciosa que só apareceria semanas depois, num e-mail do Google.
 *
 * Nenhum teste toca a rede: a rota é servida antes de qualquer fetch de
 * sitemap, então não precisa de mock de `globalThis.fetch`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker from "../workers/arquivo/src/index.ts";
import { renderPrivacyPage } from "../workers/arquivo/src/render-privacy.ts";

describe("#5262 — GET /privacidade no Worker arquivo", () => {
  it("responde 200 em HTML, sem depender do sitemap", async () => {
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/privacidade"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/html/);
  });

  it("aceita também a forma com barra final", async () => {
    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/privacidade/"));
    assert.equal(res.status, 200);
  });

  it("declara lang pt-BR e um <title> próprio", () => {
    const html = renderPrivacyPage();
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<title>Política de Privacidade — diar\.ia\.br<\/title>/);
  });

  it("é indexável — a verificação do Google não pode bater numa página noindex", () => {
    assert.doesNotMatch(renderPrivacyPage(), /name="robots"[^>]*noindex/);
  });

  it("expõe um canal de contato para pedidos de LGPD", () => {
    assert.match(renderPrivacyPage(), /mailto:[^"]+@/);
  });

  it("nomeia os terceiros que de fato processam dado de leitor", () => {
    const html = renderPrivacyPage();
    // #7361: Kit é o processador real de 100% dos cadastros novos hoje, e
    // Meta/Microsoft são plataformas de anúncio que recebem confirmação de
    // cadastro (evento de conversão) — nenhum dos 3 era citado.
    for (const vendor of ["Beehiiv", "Kit", "Brevo", "MillionVerifier", "Cloudflare", "Google", "Meta", "Microsoft"]) {
      assert.match(html, new RegExp(`\\b${vendor}\\b`), `política não cita ${vendor}`);
    }
  });
});
