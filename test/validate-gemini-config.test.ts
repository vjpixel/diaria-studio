/**
 * test/validate-gemini-config.test.ts (#1396)
 *
 * Cobre `checkModelInCatalog` — função pure que decide se um model
 * configurado em platform.config.json resolve no catálogo /v1beta/models
 * da Gemini API. O regressor concreto que motivou (#1396): Bundle 6
 * (PR #1391) mudou `gemini.model` pra `gemini-2.5-flash-image-preview`,
 * que retornou 404 — só `gemini-2.5-flash-image` sem `-preview` existe.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkModelInCatalog } from "../scripts/validate-gemini-config.ts";

describe("checkModelInCatalog (#1396)", () => {
  const realCatalog = [
    "models/gemini-2.5-flash-image",
    "models/gemini-2.5-flash",
    "models/gemini-flash-latest",
    "models/gemini-pro-latest",
    "models/imagen-3.0-generate-002",
  ];

  it("ok=true quando configured está no catálogo (sem prefix)", () => {
    const r = checkModelInCatalog("gemini-2.5-flash-image", realCatalog);
    assert.equal(r.ok, true);
  });

  it("ok=true quando configured tem prefix models/ e bate", () => {
    const r = checkModelInCatalog("models/gemini-2.5-flash-image", realCatalog);
    assert.equal(r.ok, true);
  });

  it("ok=true matching case-insensitive", () => {
    const r = checkModelInCatalog("Gemini-2.5-Flash-Image", realCatalog);
    assert.equal(r.ok, true);
  });

  it("ok=false + suggestion quando model não existe (regressor #1395)", () => {
    // Esse foi o bug real: -preview suffix não existe no catálogo
    const r = checkModelInCatalog("gemini-2.5-flash-image-preview", realCatalog);
    assert.equal(r.ok, false);
    assert.ok(r.suggestion, "Esperava sugestão de model próximo");
    // A sugestão deve ser o model real (sem -preview)
    assert.match(r.suggestion!, /gemini-2.5-flash-image/);
  });

  it("ok=false sem suggestion quando nada parecido no catálogo", () => {
    const r = checkModelInCatalog("totally-different-model-xyz", realCatalog);
    assert.equal(r.ok, false);
  });

  it("ok=false quando catálogo vazio", () => {
    const r = checkModelInCatalog("gemini-2.5-flash-image", []);
    assert.equal(r.ok, false);
  });

  it("sugere mesmo prefixo de família quando model não encontrado", () => {
    // Catalog tem gemini-2.5-flash; configured pede gemini-2.5-flash-pro
    // (não existe). Sugestão deve cair em gemini-2.5-flash (mesma família).
    const r = checkModelInCatalog("gemini-2.5-flash-pro", [
      "models/gemini-2.5-flash",
      "models/gemini-pro-latest",
    ]);
    assert.equal(r.ok, false);
    // Aceita qualquer sugestão da mesma família major.minor
    assert.ok(r.suggestion);
    assert.match(r.suggestion!, /^gemini-2\.5/);
  });
});
