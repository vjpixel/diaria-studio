/**
 * test/monthly-destaque-image.test.ts (#1916)
 *
 * Imagem 2x1 por destaque na edição mensal:
 *  - renderDestaque embute a imagem no topo quando recebe imageUrl (e nada
 *    quando não recebe);
 *  - draftToEmail mapeia DESTAQUE N → destaqueImageUrls[N].
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderDestaque, draftToEmail } from "../scripts/lib/monthly-render.ts";

const CHUNK = [
  "**DESTAQUE 1 | BRASIL**",
  "Brasil entra no mapa global da IA",
  "",
  "Primeiro parágrafo do destaque.",
].join("\n");

describe("renderDestaque imageUrl (#1916)", () => {
  it("embute <img> 2x1 no topo quando recebe imageUrl", () => {
    const html = renderDestaque(CHUNK, undefined, "https://x/img/04-d1-2x1.jpg");
    assert.ok(html.includes('<img src="https://x/img/04-d1-2x1.jpg"'), "deve ter a imagem");
    assert.ok(html.includes("width:100%"), "imagem full-width responsiva");
    // a imagem vem ANTES do título
    assert.ok(
      html.indexOf("04-d1-2x1.jpg") < html.indexOf("Brasil entra no mapa"),
      "imagem deve vir no topo, antes do título",
    );
  });
  it("não embute imagem quando imageUrl é ausente", () => {
    const html = renderDestaque(CHUNK);
    assert.ok(!html.includes("<img"), "sem imagem quando não há URL");
    assert.ok(html.includes("Brasil entra no mapa"), "título ainda renderiza");
  });
});

describe("draftToEmail mapeia DESTAQUE N → imagem (#1916)", () => {
  const draft = [
    "**ASSUNTO**",
    "1. Teste",
    "",
    "**DESTAQUE 1 | BRASIL**",
    "Título D1",
    "",
    "Corpo D1.",
    "",
    "**DESTAQUE 2 | LANÇAMENTO**",
    "Título D2",
    "",
    "Corpo D2.",
  ].join("\n");

  it("usa a URL certa por número de destaque", () => {
    const { html } = draftToEmail(draft, "Teste", "2605", undefined, undefined, undefined, {
      1: "https://x/04-d1-2x1.jpg",
      2: "https://x/04-d2-2x1.jpg",
    });
    assert.ok(html.includes("04-d1-2x1.jpg"), "D1 com sua imagem");
    assert.ok(html.includes("04-d2-2x1.jpg"), "D2 com sua imagem");
    // D1 antes de D2 no documento
    assert.ok(html.indexOf("04-d1-2x1.jpg") < html.indexOf("04-d2-2x1.jpg"));
  });

  it("destaque sem imagem no map não quebra (renderiza sem img)", () => {
    const { html } = draftToEmail(draft, "Teste", "2605", undefined, undefined, undefined, {
      1: "https://x/04-d1-2x1.jpg",
      // D2 sem imagem
    });
    assert.ok(html.includes("04-d1-2x1.jpg"));
    assert.ok(!html.includes("04-d2-2x1.jpg"));
    assert.ok(html.includes("Título D2"), "D2 ainda renderiza sem imagem");
  });
});
