/**
 * probe-beehiiv-subscribe-widget.test.ts (#5545 item 3)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { probeHtml, formatProbeReport } from "../scripts/probe-beehiiv-subscribe-widget.ts";

describe("probeHtml (#5545)", () => {
  it("detecta script beehiiv, form nativo, e atributos de config", () => {
    const html = `
      <html><body>
        <script src="https://embeds.beehiiv.com/embed.js"></script>
        <div id="subscribe-widget" data-publication-id="pub_123" data-embed-type="hosted"></div>
        <button class="assinar-gratis">Assinar grátis</button>
        <form action="/rodape-form"></form>
      </body></html>
    `;
    const probe = probeHtml(html, "https://diar.ia.br/?utm_source=google-ads");
    assert.equal(probe.beehiiv_scripts.length, 1);
    assert.match(probe.beehiiv_scripts[0], /beehiiv\.com/);
    assert.equal(probe.native_forms, 1);
    assert.ok(probe.subscribe_related_elements >= 1);
    assert.ok(probe.config_attributes_found.some((a) => a.startsWith("publication-id=")));
  });

  it("reporta zero/vazio quando o HTML não tem nada relacionado ao widget", () => {
    const html = `<html><body><p>Nada aqui.</p></body></html>`;
    const probe = probeHtml(html, "https://diar.ia.br/");
    assert.equal(probe.beehiiv_scripts.length, 0);
    assert.equal(probe.native_forms, 0);
    assert.equal(probe.subscribe_related_elements, 0);
    assert.equal(probe.config_attributes_found.length, 0);
  });

  it("html_length bate com o tamanho da string recebida", () => {
    const html = "0123456789";
    const probe = probeHtml(html, "https://diar.ia.br/");
    assert.equal(probe.html_length, 10);
  });
});

describe("formatProbeReport (#5545)", () => {
  it("inclui a nota de que isto é diagnóstico, não aprovação", () => {
    const probe = probeHtml("<html></html>", "https://diar.ia.br/");
    const out = formatProbeReport(probe);
    assert.match(out, /diagnóstico, não aprovação/);
    assert.match(out, /docs\/preflight-utm-cookie-roteiro\.md/);
  });
});
