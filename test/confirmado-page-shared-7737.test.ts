/**
 * test/confirmado-page-shared-7737.test.ts (#7737, rota renomeada no #8539)
 *
 * Regressão (#633) pra `scripts/lib/shared/confirmado-page.ts` — o render
 * puro da página de confirmação do double opt-in, extraído de
 * `workers/poll/src/confirmado.ts` quando a página passou a ser servida no
 * apex (`diar.ia.br/confirmada`, Worker `site`) em vez de
 * `eia.diar.ia.br/confirmado` (Worker `poll`, que agora só faz 301).
 *
 * Substitui a cobertura de conteúdo que antes vivia em
 * `test/poll-confirmado-5167.test.ts` (esse arquivo agora cobre só o
 * redirect do Worker `poll` — ver `test/site-worker-confirmado-7737.test.ts`
 * pro wiring do Worker `site`, incluindo o novo 301 de `/confirmado` →
 * `/confirmada`).
 *
 * #8539: a rota virou `/confirmada` (era `/confirmado`) — o botão de
 * confirmação do e-mail Pending da Brevo (`workers/reativar/src/index.ts`)
 * passou a REDIRECIONAR pra cá em vez de renderizar sua própria tela de
 * sucesso, então esta página agora atende os dois caminhos (Kit DOI direto e
 * Brevo/reativar). Testes do widget Kit Creator Network (`embedUrl`) movidos
 * de `test/reativar-kit-recommendations-widget-7524.test.ts` (que testava
 * `renderSuccessPage`, removida) — ver descrição no final deste arquivo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderConfirmadaPage, handleConfirmadaPage, PAGE_URL } from "../scripts/lib/shared/confirmado-page.ts";
import { GTM_CONTAINER_ID } from "../scripts/lib/shared/seo-meta.ts";

describe("renderConfirmadaPage (#7737, #8539) — unit", () => {
  it("PAGE_URL é diar.ia.br/confirmada (renomeada no #8539 — antes /confirmado, e antes disso eia.diar.ia.br)", () => {
    assert.equal(PAGE_URL, "https://diar.ia.br/confirmada");
  });

  it("confirma o cadastro com copy neutra — não promete 'primeira edição' (#8539: página atende cadastro novo E reativação)", () => {
    const html = renderConfirmadaPage();
    assert.match(html, /Assinatura confirmada/);
    assert.match(html, /próximas edições chegam/);
    assert.doesNotMatch(html, /primeira edição/, "copy não pode presumir cadastro novo — a mesma página atende reativação via /reativar");
  });

  it("linka as 4 portas — cursos, livros, jogo, arquivo", () => {
    const html = renderConfirmadaPage();
    assert.match(html, /<a href="https:\/\/cursos\.diar\.ia\.br\/">/);
    assert.match(html, /<a href="https:\/\/livros\.diar\.ia\.br\/">/);
    assert.match(html, /<a href="https:\/\/eia\.diar\.ia\.br\/jogar">/);
    assert.match(html, /<a href="https:\/\/arquivo\.diar\.ia\.br\/">/);
  });

  it("porta de cursos (#5518 B4) cumpre a promessa do e-mail de confirmação", () => {
    const html = renderConfirmadaPage();
    assert.match(html, /Cursos gratuitos de IA/);
  });

  it("(#7855) sem o CTA do formulário de interesses — removido a pedido do editor", () => {
    const html = renderConfirmadaPage();
    assert.doesNotMatch(html, /confirmado-survey/);
    assert.doesNotMatch(html, /f7528798-f8d5-4fcd-98c2-dc113e8c268b/);
    assert.doesNotMatch(html, /Responder o formulário de interesses/);
  });

  it("<title> e canonical batem com PAGE_URL (apex, /confirmada desde #8539)", () => {
    const html = renderConfirmadaPage();
    assert.match(html, /<title>Assinatura confirmada — diar\.ia\.br<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/confirmada">/);
  });
});

describe("renderConfirmadaPage (#5499 item 5) — instrumentação GTM/GA4/pixel", () => {
  it("carrega o container GTM canônico no <head> (GA4/Meta Pixel vivem dentro do container, não hardcoded aqui)", () => {
    const html = renderConfirmadaPage();
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    assert.ok(headMatch, "sem <head>...</head> pra inspecionar");
    const head = headMatch![1];
    assert.match(head, /googletagmanager\.com\/gtm\.js/, "script do GTM ausente do <head>");
    assert.match(head, new RegExp(`['"]${GTM_CONTAINER_ID}['"]`), `container ID (${GTM_CONTAINER_ID}) ausente do <head>`);
  });

  it("não referencia gclid/fbclid/msclkid/li_fat_id (#5499 item 7 — não se aplica a /confirmada, ver docstring do módulo)", () => {
    const html = renderConfirmadaPage();
    assert.doesNotMatch(html, /gclid|fbclid|msclkid|li_fat_id/i);
  });
});

describe("handleConfirmadaPage (#7737, #8539) — Response", () => {
  it("200, HTML, cacheável", async () => {
    const res = handleConfirmadaPage();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html;charset=utf-8");
    assert.ok(res.headers.get("Cache-Control")?.includes("public"));
    const body = await res.text();
    assert.match(body, /Assinatura confirmada/);
  });
});

/**
 * #8539 — widget Kit Creator Network (lado OUTGOING, #7524), movido de
 * `workers/reativar/src/index.ts` (`renderSuccessPage`, removida) pra cá:
 * os dois caminhos de confirmação convergem nesta página desde o #8539, e o
 * widget só precisa existir aqui agora. Testes portados de
 * `test/reativar-kit-recommendations-widget-7524.test.ts`.
 */
describe("renderConfirmadaPage/handleConfirmadaPage — widget Kit Creator Network opcional (#7524, movido no #8539)", () => {
  const KIT_EMBED_URL = "https://diariabr.kit.com/profile/recommendations";

  it("sem embedUrl (default): sem iframe, comportamento de hoje", () => {
    const html = renderConfirmadaPage();
    assert.ok(!html.includes("<iframe"), "não deveria ter iframe sem embedUrl");
  });

  it("com embedUrl: embute o iframe do widget apontando pra URL configurada", () => {
    const html = renderConfirmadaPage(KIT_EMBED_URL);
    assert.ok(html.includes("<iframe"), "deveria ter iframe com embedUrl");
    assert.ok(html.includes(KIT_EMBED_URL), "iframe deveria apontar pra URL configurada");
    assert.match(html, /Assinatura confirmada/, "copy de sucesso preservada");
  });

  it("handleConfirmadaPage repassa embedUrl pro render", async () => {
    const res = handleConfirmadaPage(KIT_EMBED_URL);
    const body = await res.text();
    assert.ok(body.includes("<iframe"));
    assert.ok(body.includes(KIT_EMBED_URL));
  });
});
