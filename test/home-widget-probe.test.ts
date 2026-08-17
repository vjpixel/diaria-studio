/**
 * test/home-widget-probe.test.ts (#5545)
 *
 * Regra #633: cobre a sondagem estática pura do HTML da home (item 3 do
 * escopo — diagnóstico, nunca gate).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeHomeWidgetHtml, formatHomeWidgetProbeFinding } from "../scripts/lib/home-widget-probe.ts";

describe("probeHomeWidgetHtml (#5545)", () => {
  it("detecta markup Beehiiv (script src)", () => {
    const html = `<html><head><script src="https://cdn.beehiiv.com/widget.js"></script></head><body></body></html>`;
    const finding = probeHomeWidgetHtml(html, "utm_source=google-ads");
    assert.equal(finding.hasBeehiivMarkup, true);
  });

  it("hasBeehiivMarkup false quando não há menção a beehiiv", () => {
    const html = `<html><body><h1>diar.ia.br</h1></body></html>`;
    const finding = probeHomeWidgetHtml(html, "utm_source=google-ads");
    assert.equal(finding.hasBeehiivMarkup, false);
  });

  it("não encontra âncora de assinatura quando o botão é widget JS sem href (caso real — #5522)", () => {
    const html = `<html><body><button id="subscribe-widget">Assinar grátis</button></body></html>`;
    const finding = probeHomeWidgetHtml(html, "utm_source=google-ads");
    assert.deepEqual(finding.subscribeAnchorHrefs, []);
  });

  it("encontra âncora cujo texto é 'Assinar'", () => {
    const html = `<html><body><a href="/assine">Assinar agora</a></body></html>`;
    const finding = probeHomeWidgetHtml(html, "utm_source=google-ads");
    assert.deepEqual(finding.subscribeAnchorHrefs, ["/assine"]);
  });

  it("encontra âncora cujo href contém 'subscribe' mesmo com texto neutro", () => {
    const html = `<html><body><a href="https://diar.ia.br/subscribe">clique aqui</a></body></html>`;
    const finding = probeHomeWidgetHtml(html, "utm_source=google-ads");
    assert.deepEqual(finding.subscribeAnchorHrefs, ["https://diar.ia.br/subscribe"]);
  });

  it("detecta form nativo associado a texto de assinatura", () => {
    const html = `<html><body><form action="/x"><input/></form><p>Assinar grátis</p></body></html>`;
    const finding = probeHomeWidgetHtml(html, "utm_source=google-ads");
    assert.equal(finding.hasNativeSubscribeForm, true);
  });

  it("hasNativeSubscribeForm false sem <form> no HTML", () => {
    const html = `<html><body><p>Assinar grátis</p></body></html>`;
    const finding = probeHomeWidgetHtml(html, "utm_source=google-ads");
    assert.equal(finding.hasNativeSubscribeForm, false);
  });

  it("queryStringEchoedInHtml true quando a query aparece literalmente no HTML", () => {
    const html = `<html><body><!-- utm_source=google-ads --></body></html>`;
    const finding = probeHomeWidgetHtml(html, "utm_source=google-ads");
    assert.equal(finding.queryStringEchoedInHtml, true);
  });

  it("queryStringEchoedInHtml false no caso comum (widget client-side não ecoa)", () => {
    const html = `<html><body><h1>diar.ia.br</h1></body></html>`;
    const finding = probeHomeWidgetHtml(html, "utm_source=google-ads");
    assert.equal(finding.queryStringEchoedInHtml, false);
  });

  it("normaliza query string com '?' inicial antes de checar eco", () => {
    const html = `<html><body>utm_source=meta-ads</body></html>`;
    const finding = probeHomeWidgetHtml(html, "?utm_source=meta-ads");
    assert.equal(finding.queryStringEchoedInHtml, true);
  });

  it("captura trecho ao redor de 'assinar' quando presente", () => {
    const html = `<html><body><h2>Assinar grátis</h2></body></html>`;
    const finding = probeHomeWidgetHtml(html, "");
    assert.ok(finding.snippetAroundAssinar);
    assert.match(finding.snippetAroundAssinar!, /Assinar/);
  });

  it("snippetAroundAssinar null quando 'assinar' não aparece", () => {
    const html = `<html><body><h1>diar.ia.br</h1></body></html>`;
    const finding = probeHomeWidgetHtml(html, "");
    assert.equal(finding.snippetAroundAssinar, null);
  });
});

describe("formatHomeWidgetProbeFinding (#5545)", () => {
  it("inclui o aviso de que isto é diagnóstico, não gate", () => {
    const finding = probeHomeWidgetHtml("<html></html>", "");
    const out = formatHomeWidgetProbeFinding(finding, "https://diar.ia.br/?utm_source=google-ads");
    assert.match(out, /AVISO: isto é diagnóstico, NÃO é gate\./);
    assert.match(out, /docs\/roteiro-preflight-utm-3-canais\.md/);
  });

  it("lista as âncoras encontradas quando existem", () => {
    const finding = probeHomeWidgetHtml(`<a href="/assine">Assinar</a>`, "");
    const out = formatHomeWidgetProbeFinding(finding, "https://diar.ia.br/");
    assert.match(out, /\/assine/);
  });
});
