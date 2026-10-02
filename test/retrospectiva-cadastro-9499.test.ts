/**
 * test/retrospectiva-cadastro-9499.test.ts (#9499)
 *
 * O #9497 passou a renderizar o trecho público da Retrospectiva do Mês pelo
 * mesmo filtro do e-mail dos apoiadores, e com isso o "se cadastre
 * gratuitamente" (que morava na abertura Clarice-only) saiu da página. Decisão
 * do editor: o ponto de conversão de quem não apoia passa a ser o CTA de
 * cadastro gratuito na diária, no bloco de conversão que o Worker injeta no
 * trecho — sem tirar o CTA de apoio.
 *
 * Trava:
 *   1. o bloco tem os DOIS CTAs: apoio (apoia.se) e cadastro (diar.ia.br/assinar);
 *   2. o cadastro carrega o triplo do registry + `utm_content=cadastro-diaria`,
 *      por PATH — nunca o literal solto antigo (`artigo-mensal`/`artigo-web`);
 *   3. o apoio segue sem `utm_content` e vem antes do cadastro (hierarquia);
 *   4. o convite é explícito ("gratuitamente") e o CSS de celular do #9492
 *      continua no bloco.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RETROSPECTIVA_MENSAL_UTM_SOURCE,
  RETROSPECTIVA_MENSAL_UTM_MEDIUM,
  RETROSPECTIVA_MENSAL_CADASTRO_UTM_CONTENT,
  buildRetrospectivaMensalCampaign,
} from "../scripts/lib/shared/utm-registry.ts";
import { renderTeaserWithPaywall, teaserBlockMobileCss } from "../workers/retrospectiva/src/render-mensal.ts";

const TEASER = "<html><head></head><body><p>começo do artigo</p></body></html>";

function hrefDe(html: string, re: RegExp): URL {
  const m = re.exec(html);
  assert.ok(m, `link não encontrado: ${re}`);
  return new URL(m![1].replace(/&amp;/g, "&"));
}

const RE_CADASTRO = /href="(https:\/\/diar\.ia\.br\/assinar[^"]*)"/;
const RE_APOIO = /href="(https:\/\/apoia\.se\/diaria[^"]*)"/;

describe("#9499 — CTA de cadastro gratuito na diária no trecho da Retrospectiva", () => {
  it("o bloco tem o CTA de cadastro E o de apoio", () => {
    const out = renderTeaserWithPaywall(TEASER, "2609");
    assert.match(out, RE_CADASTRO, "CTA de cadastro na diária");
    assert.match(out, RE_APOIO, "CTA de apoio continua");
    assert.match(out, /Cadastre-se gratuitamente na newsletter diária/);
  });

  it("cadastro: triplo do registry, campaign por path e utm_content próprio", () => {
    const url = hrefDe(renderTeaserWithPaywall(TEASER, "2609"), RE_CADASTRO);
    assert.equal(url.pathname, "/assinar");
    assert.equal(url.searchParams.get("utm_source"), RETROSPECTIVA_MENSAL_UTM_SOURCE);
    assert.equal(url.searchParams.get("utm_medium"), RETROSPECTIVA_MENSAL_UTM_MEDIUM);
    assert.equal(url.searchParams.get("utm_campaign"), buildRetrospectivaMensalCampaign("2609"));
    assert.equal(url.searchParams.get("utm_content"), RETROSPECTIVA_MENSAL_CADASTRO_UTM_CONTENT);
    assert.equal(RETROSPECTIVA_MENSAL_CADASTRO_UTM_CONTENT, "cadastro-diaria");
  });

  it("REGRESSÃO: o literal solto antigo não volta", () => {
    const out = renderTeaserWithPaywall(TEASER, "2609");
    assert.ok(!out.includes("utm_source=artigo-mensal"));
    assert.ok(!out.includes("utm_campaign=trecho-paywall"));
  });

  it("edições distintas geram utm_campaign distinto no cadastro", () => {
    const a = hrefDe(renderTeaserWithPaywall(TEASER, "2608"), RE_CADASTRO).searchParams.get("utm_campaign");
    const b = hrefDe(renderTeaserWithPaywall(TEASER, "2609"), RE_CADASTRO).searchParams.get("utm_campaign");
    assert.notEqual(a, b);
  });

  it("apoio segue sem utm_content e vem antes do cadastro", () => {
    const out = renderTeaserWithPaywall(TEASER, "2609");
    assert.equal(hrefDe(out, RE_APOIO).searchParams.get("utm_content"), null);
    assert.ok(out.search(RE_APOIO) < out.search(RE_CADASTRO), "o apoio vem primeiro");
  });

  it("CSS de celular do #9492 continua no bloco", () => {
    const out = renderTeaserWithPaywall(TEASER, "2609");
    assert.ok(out.includes(teaserBlockMobileCss("retrospectiva-paywall")));
  });
});
