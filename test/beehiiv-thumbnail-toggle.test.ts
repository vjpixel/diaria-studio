import { test } from "node:test";
import * as assert from "node:assert";
import {
  buildThumbnailToggleCheckAndFixJs,
  classifyThumbnailToggleResult,
  formatThumbnailToggleMessage,
} from "../scripts/lib/beehiiv-thumbnail-toggle.ts";

test("buildThumbnailToggleCheckAndFixJs — generated JS is syntactically valid (#7412 regression)", () => {
  const js = buildThumbnailToggleCheckAndFixJs();
  assert.match(js, /async/, "JS deve conter async para permitir await");
  // Validar que o JS pode ser parseado sem erro de sintaxe
  assert.doesNotThrow(
    () => new Function(js),
    "Gerado JS não deve ter SyntaxError (fix para await em non-async)"
  );
});

test("classifyThumbnailToggleResult — toggle not found", () => {
  const result = classifyThumbnailToggleResult({ found: false });
  assert.equal(result.found, false);
  assert.equal(result.enabled, false);
  assert.equal(result.toggled, false);
});

test("classifyThumbnailToggleResult — toggle found and OFF", () => {
  const result = classifyThumbnailToggleResult({
    found: true,
    enabled: false,
    toggled: false,
  });
  assert.equal(result.found, true);
  assert.equal(result.enabled, false);
});

test("classifyThumbnailToggleResult — toggle found, was ON, now OFF", () => {
  const result = classifyThumbnailToggleResult({
    found: true,
    enabled: true,
    toggled: true,
  });
  assert.equal(result.found, true);
  assert.equal(result.enabled, true);
  assert.equal(result.toggled, true);
});

test("classifyThumbnailToggleResult — toggle found, ON but toggle failed", () => {
  const result = classifyThumbnailToggleResult({
    found: true,
    enabled: true,
    toggled: false,
  });
  assert.equal(result.found, true);
  assert.equal(result.enabled, true);
  assert.equal(result.toggled, false);
});

test("formatThumbnailToggleMessage — not found", () => {
  const msg = formatThumbnailToggleMessage({ found: false, enabled: false, toggled: false });
  assert.match(msg, /não localizado/i);
});

test("formatThumbnailToggleMessage — already OFF", () => {
  const msg = formatThumbnailToggleMessage({ found: true, enabled: false, toggled: false });
  assert.match(msg, /já está OFF/i);
});

test("formatThumbnailToggleMessage — was ON, now OFF", () => {
  const msg = formatThumbnailToggleMessage({ found: true, enabled: true, toggled: true });
  assert.match(msg, /estava ON/i);
  assert.match(msg, /automaticamente desligado/i);
});

test("formatThumbnailToggleMessage — ON but toggle failed", () => {
  const msg = formatThumbnailToggleMessage({ found: true, enabled: true, toggled: false });
  assert.match(msg, /está ligado/i);
  assert.match(msg, /NÃO foi possível/i);
});
