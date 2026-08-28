/**
 * test/rv-images-format.test.ts (#6447 Fatia 4, achados 6 + 9)
 *
 * Testa a formatação/decisão PURA (sem DOM) do painel Imagens —
 * `scripts/studio-ui/public/rv-images-format.js` — mesmo padrão de
 * `test/rv-gate-format.test.ts`: importa o módulo client-side direto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatImageExistence,
  isTargetRegenerating,
  anyTargetRegenerating,
  formatRegenerateButtonLabel,
} from "../scripts/studio-ui/public/rv-images-format.js";

describe("formatImageExistence", () => {
  it("exists:true -> 'gerada'", () => {
    assert.match(formatImageExistence({ exists: true }), /gerada/);
  });
  it("exists:false -> menciona Regenerar", () => {
    assert.match(formatImageExistence({ exists: false }), /Regenerar/);
  });
  it("entry nulo -> string vazia, nunca lança", () => {
    assert.equal(formatImageExistence(null), "");
  });
});

const GALLERY = {
  available: true,
  destaques: [
    { n: 1, images: [], regenerating: true },
    { n: 2, images: [], regenerating: false },
  ],
  eia: { images: [], regenerating: false },
};

describe("isTargetRegenerating (#6447 Fatia 4)", () => {
  it("destaque com job running -> true", () => {
    assert.equal(isTargetRegenerating(GALLERY, "d1"), true);
  });
  it("destaque sem job running -> false", () => {
    assert.equal(isTargetRegenerating(GALLERY, "d2"), false);
  });
  it("destaque inexistente na galeria -> false, nunca lança", () => {
    assert.equal(isTargetRegenerating(GALLERY, "d3"), false);
  });
  it("eia -> lê gallery.eia.regenerating", () => {
    assert.equal(isTargetRegenerating(GALLERY, "eia"), false);
    assert.equal(isTargetRegenerating({ ...GALLERY, eia: { images: [], regenerating: true } }, "eia"), true);
  });
  it("galeria indisponível/nula -> false", () => {
    assert.equal(isTargetRegenerating(null, "d1"), false);
    assert.equal(isTargetRegenerating({ available: false }, "d1"), false);
  });
  it("target malformado -> false, nunca lança", () => {
    assert.equal(isTargetRegenerating(GALLERY, "dx"), false);
    assert.equal(isTargetRegenerating(GALLERY, ""), false);
  });
});

describe("anyTargetRegenerating (#6447 Fatia 4 — decide se o polling continua)", () => {
  it("algum destaque running -> true", () => {
    assert.equal(anyTargetRegenerating(GALLERY), true);
  });
  it("nenhum destaque nem eia running -> false", () => {
    const idle = { available: true, destaques: [{ n: 1, images: [], regenerating: false }], eia: { images: [], regenerating: false } };
    assert.equal(anyTargetRegenerating(idle), false);
  });
  it("só eia running -> true", () => {
    const eiaOnly = { available: true, destaques: [{ n: 1, images: [], regenerating: false }], eia: { images: [], regenerating: true } };
    assert.equal(anyTargetRegenerating(eiaOnly), true);
  });
  it("galeria indisponível/nula -> false, nunca lança", () => {
    assert.equal(anyTargetRegenerating(null), false);
    assert.equal(anyTargetRegenerating({ available: false }), false);
  });
});

describe("formatRegenerateButtonLabel", () => {
  it("regenerating:true -> 'Regenerando…'", () => {
    assert.equal(formatRegenerateButtonLabel(true), "Regenerando…");
  });
  it("regenerating:false -> 'Regenerar'", () => {
    assert.equal(formatRegenerateButtonLabel(false), "Regenerar");
  });
});
