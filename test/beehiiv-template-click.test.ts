/**
 * test/beehiiv-template-click.test.ts (#1587)
 *
 * Cobre helpers de `lib/beehiiv-template-click.ts`:
 *   - `buildHtmlTemplateClickJs()` — string JS válida pra dispatch
 *   - `validateTemplateClickUrl()` — distingue post real vs template rogue
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildHtmlTemplateClickJs,
  validateTemplateClickUrl,
} from "../scripts/lib/beehiiv-template-click.ts";

describe("buildHtmlTemplateClickJs (#1587)", () => {
  it("retorna string JS não-vazia", () => {
    const js = buildHtmlTemplateClickJs();
    assert.equal(typeof js, "string");
    assert.ok(js.length > 100);
  });

  it("query inicial é em <h3> (não h1/h2)", () => {
    const js = buildHtmlTemplateClickJs();
    assert.match(js, /querySelectorAll\('h3'\)/);
  });

  it("compara textContent === 'HTML' exato (não substring)", () => {
    const js = buildHtmlTemplateClickJs();
    // String 'HTML' aparece duas vezes (find + return). Match com === 'HTML'
    // (não 'New template' ou 'Custom HTML' inteiro).
    assert.match(js, /=== 'HTML'/);
  });

  it("retorna shape { ok: true/false, error?, ... } estruturado", () => {
    const js = buildHtmlTemplateClickJs();
    assert.match(js, /\{ ok: true/);
    assert.match(js, /\{ ok: false/);
  });

  it("dispara click() no fim", () => {
    const js = buildHtmlTemplateClickJs();
    assert.match(js, /\.click\(\)/);
  });
});

describe("validateTemplateClickUrl (#1587)", () => {
  it("URL /posts/{uuid}/edit → ok: true com postId", () => {
    const result = validateTemplateClickUrl(
      "https://app.beehiiv.com/posts/abc-def-123/edit",
    );
    assert.equal(result.ok, true);
    assert.equal((result as { postId: string }).postId, "abc-def-123");
  });

  it("URL /templates/posts/{uuid}/edit → ok: false, kind: template_rogue", () => {
    const result = validateTemplateClickUrl(
      "https://app.beehiiv.com/templates/posts/279a534d-93ef-4317-8406-7d40f4af49ce/edit",
    );
    assert.equal(result.ok, false);
    assert.equal((result as { kind: string }).kind, "template_rogue");
    assert.equal(
      (result as { templateId: string }).templateId,
      "279a534d-93ef-4317-8406-7d40f4af49ce",
    );
  });

  it("URL desconhecida → ok: false, kind: unknown", () => {
    const result = validateTemplateClickUrl(
      "https://app.beehiiv.com/dashboard",
    );
    assert.equal(result.ok, false);
    assert.equal((result as { kind: string }).kind, "unknown");
  });

  it("URL pode ter query string e fragment — postId ainda extraído", () => {
    const result = validateTemplateClickUrl(
      "https://app.beehiiv.com/posts/abc-def-123/edit?step=1#section",
    );
    assert.equal(result.ok, true);
    assert.equal((result as { postId: string }).postId, "abc-def-123");
  });

  it("template_rogue ainda detectado quando prefix path antes de /templates", () => {
    const result = validateTemplateClickUrl(
      "https://app.beehiiv.com/workspace/templates/posts/279a534d-93ef-4317-8406-7d40f4af49ce/edit",
    );
    assert.equal(result.ok, false);
    assert.equal((result as { kind: string }).kind, "template_rogue");
  });
});
