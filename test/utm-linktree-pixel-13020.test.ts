/**
 * test/utm-linktree-pixel-13020.test.ts (#13020)
 *
 * O Linktree pessoal do editor (linktr.ee/vjpixel) ganhou em 13/11/2026 dois
 * botões pra `diar.ia.br` com UTM montado à mão, mas a superfície não existia
 * em `EXTERNAL_UTM_SURFACES` — o `/utms` e `knownUtmSources()` não conheciam
 * `utm_source=linktree`. Este teste trava (1) a entrada no inventário e
 * (2) que `buildExternalSurfaceUrl` gera EXATAMENTE as 2 URLs vivas no painel.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_SURFACE_MEDIUM,
  LINKTREE_PIXEL_URL_BASES,
  buildExternalSurfaceUrl,
  findExternalUtmSurface,
  knownUtmSources,
} from "../scripts/lib/shared/utm-registry.ts";

describe("#13020 — perfil-linktree-pixel", () => {
  const surface = findExternalUtmSurface("perfil-linktree-pixel");

  it("está registrada com source linktree, medium bio e variante pixel", () => {
    assert.ok(surface, "perfil-linktree-pixel ausente de EXTERNAL_UTM_SURFACES");
    assert.equal(surface.source, "linktree");
    assert.equal(surface.medium, EXTERNAL_SURFACE_MEDIUM);
    assert.equal(surface.medium, "bio");
    assert.equal(surface.campaign, "perfil-linktree-pixel");
    assert.equal(surface.status, "ativo");
    assert.equal(surface.appliedAt, "2026-11-13");
  });

  it("gera exatamente as 2 URLs que estão vivas no Linktree", () => {
    assert.ok(surface);
    assert.equal(
      buildExternalSurfaceUrl(surface, LINKTREE_PIXEL_URL_BASES.newsletter),
      "https://diar.ia.br/assinar?utm_source=linktree&utm_medium=bio&utm_campaign=perfil-linktree-pixel",
    );
    assert.equal(
      buildExternalSurfaceUrl(surface, LINKTREE_PIXEL_URL_BASES.conteudoAutentico),
      "https://diar.ia.br/produto/conteudo-autentico?utm_source=linktree&utm_medium=bio&utm_campaign=perfil-linktree-pixel",
    );
  });

  it("utm_source=linktree passa a ser origem catalogada", () => {
    assert.ok(knownUtmSources().includes("linktree"));
  });
});
