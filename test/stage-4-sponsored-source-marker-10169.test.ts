import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSponsoredMarkers } from "../scripts/lib/lint-checks/sponsored-source-markers.ts";
import { checkSponsoredSourceMarkers } from "../scripts/lib/invariant-checks/stage-4.ts";
import { saveCachedBody } from "../scripts/lib/url-body-cache.ts";

describe("detectSponsoredMarkers (#10169)", () => {
  it("detecta path /publicidade/", () => {
    assert.deepEqual(detectSponsoredMarkers("https://exame.com/publicidade/x", null), ["URL contém /publicidade/"]);
  });
  it("detecta conteúdo de marca e patrocinado no texto visível", () => {
    const m = detectSponsoredMarkers("https://a.com/x", "<p>Conteúdo de marca</p><span>Patrocinado</span>");
    assert.ok(m.includes("conteúdo de marca") && m.includes("patrocinado"));
  });
  it("ignora marcador dentro de script/style", () => {
    assert.deepEqual(detectSponsoredMarkers("https://a.com/x", "<script>var patrocinado=1</script><p>ok</p>"), []);
  });
  it("decodifica entidades HTML", () => {
    assert.ok(detectSponsoredMarkers("https://a.com/x", "<p>Conte&uacute;do&nbsp;de marca</p>").includes("conteúdo de marca"));
  });
  it("ignora rodapé fora de <article>", () => {
    assert.deepEqual(detectSponsoredMarkers("https://a.com/x", "<article>texto</article><footer>Patrocinado</footer>"), []);
  });
  it("não duplica 'patrocinado' quando 'conteúdo patrocinado' casou", () => {
    assert.deepEqual(detectSponsoredMarkers("https://a.com/x", "<p>Conteúdo patrocinado</p>"), ["conteúdo patrocinado"]);
  });
  it("URL sem corpo cacheado: só o path vale", () => {
    assert.equal(detectSponsoredMarkers("https://a.com/publicidade/x", null).length, 1);
  });
  it("#10215: card <article> relacionado ANTES do texto principal não esconde o principal", () => {
    const html =
      "<article class='card'><a>Leia também: outra notícia</a></article>" +
      "<div>" + "x".repeat(3000) + "</div>" +
      "<article><h1>Título</h1><p>Conteúdo patrocinado por Fulano</p></article>";
    assert.deepEqual(detectSponsoredMarkers("https://a.com/x", html), ["conteúdo patrocinado"]);
  });
  it("#10215: selo num header logo antes do <article> é visto", () => {
    const html =
      "<nav>" + "menu ".repeat(1000) + "</nav>" +
      "<header><span class='selo'>Publieditorial</span></header>" +
      "<article><h1>Título</h1><p>texto</p></article><footer>Patrocinado</footer>";
    assert.deepEqual(detectSponsoredMarkers("https://a.com/x", html), ["publieditorial"]);
  });
  it("#10215: entidade numérica hex é decodificada", () => {
    assert.ok(detectSponsoredMarkers("https://a.com/x", "<p>Conte&#xFA;do de marca</p>").includes("conteúdo de marca"));
  });
  it("#10215: <article> aninhado não trunca o bloco principal", () => {
    const html = "<article><h1>T</h1><article>citação</article><p>Conteúdo de marca</p></article>";
    assert.ok(detectSponsoredMarkers("https://a.com/x", html).includes("conteúdo de marca"));
  });
  it("página limpa → vazio", () => {
    assert.deepEqual(detectSponsoredMarkers("https://a.com/x", "<p>Notícia normal</p>"), []);
  });
});

describe("checkSponsoredSourceMarkers (#10169)", () => {
  it("warning-only quando o corpo cacheado tem marcador; limpo não acusa", () => {
    const dir = mkdtempSync(join(tmpdir(), "spons-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const bad = "https://exame.com/mba/pre-mba";
    const ok = "https://example.org/noticia";
    writeFileSync(join(dir, "02-reviewed.md"), `- [A](${bad})\n- [B](${ok})\n`);
    const bodies = join(dir, "_internal", "_forensic", "link-verify-bodies");
    saveCachedBody(bodies, bad, "<div>Conteúdo patrocinado — Pré-MBA</div>");
    saveCachedBody(bodies, ok, "<p>texto</p>");
    const v = checkSponsoredSourceMarkers(dir);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
    assert.equal(v[0].rule, "sponsored-source-marker");
    assert.match(v[0].message, /exame\.com/);
  });
  it("sem 02-reviewed.md → []", () => {
    assert.deepEqual(checkSponsoredSourceMarkers(mkdtempSync(join(tmpdir(), "spons-"))), []);
  });
});
