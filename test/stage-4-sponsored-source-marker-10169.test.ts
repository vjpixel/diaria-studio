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
