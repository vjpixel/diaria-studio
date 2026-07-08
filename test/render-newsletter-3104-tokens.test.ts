/**
 * test/render-newsletter-3104-tokens.test.ts
 *
 * #3104 — micro-drifts de token no e-mail diário, sem motivo funcional:
 *   (a) padding do box "contorno" (papel + borda bege): 23px 27px em
 *       renderWhyBoxInner ("Por que isso importa") vs 24px 28px em
 *       renderErroIntencionalReveal (reveal do Sorteio) — 1px de drift.
 *   (b) letter-spacing de labels uppercase: 1px (legenda de hero,
 *       prevResultLine) / 1.5px (whyBox, "Acesse nossas curadorias:") / 2px
 *       (kicker de seção) — 3 valores sem motivo funcional.
 *   (c) line-height do título do É IA? ("Clique na imagem...") era 1.15,
 *       diferente das outras manchetes 26px serif (headline, introCallout,
 *       boxDivulgacao — todas 1.2).
 *
 * Fix: extrai PAD_BOX_OUTLINE ("24px 28px") e LS_LABEL ("2px") como
 * constantes compartilhadas; unifica a1 e a2 pros valores já dominantes no
 * arquivo; iguala o line-height do É IA? a 1.2.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderWhyBoxInner,
  renderErroIntencionalReveal,
  renderKicker,
  renderHeroImageInner,
  renderEIA,
} from "../scripts/lib/newsletter-render-html.ts";
import type { EIA } from "../scripts/lib/newsletter-parse.ts";

describe("#3104 — padding do box contorno unificado (24px 28px)", () => {
  it("renderWhyBoxInner usa padding:24px 28px (era 23px 27px)", () => {
    const html = renderWhyBoxInner("Razão do destaque.");
    assert.match(html, /padding:24px 28px;/, "whyBox deve usar 24px 28px");
    assert.doesNotMatch(html, /padding:23px 27px;/, "whyBox não deve mais usar 23px 27px");
  });

  it("renderErroIntencionalReveal usa padding:24px 28px (inalterado, agora via constante compartilhada)", () => {
    const html = renderErroIntencionalReveal(
      "Nessa edição, escondemos um erro.\n\nNa última edição, o correto era X.",
    );
    assert.match(html, /padding:24px 28px;/);
  });
});

describe("#3104 — letter-spacing de labels uppercase unificado (2px)", () => {
  it("renderKicker mantém letter-spacing:2px (valor âncora — build-link-ctr.ts depende dele)", () => {
    const html = renderKicker("USE MELHOR");
    assert.match(html, /letter-spacing:2px;/);
  });

  it("renderHeroImageInner (legenda) sobe pra letter-spacing:2px (era 1px)", () => {
    const html = renderHeroImageInner("04-d1-2x1.jpg", "Título", "Criada com Gemini");
    assert.match(html, /letter-spacing:2px;/);
    assert.doesNotMatch(html, /letter-spacing:1px;/);
  });

  it("renderWhyBoxInner (label) sobe pra letter-spacing:2px (era 1.5px)", () => {
    const html = renderWhyBoxInner("Razão.");
    assert.match(html, /letter-spacing:2px;/);
    assert.doesNotMatch(html, /letter-spacing:1\.5px;/);
  });

  it("prevResultLine (É IA?) sobe pra letter-spacing:2px (era 1px)", () => {
    const eia: EIA = {
      credit: "Foto: x.",
      imageA: "01-eia-A.jpg",
      imageB: "01-eia-B.jpg",
      edition: "260999",
      prevResultLine: "Resultado da última edição: 67% acertaram.",
    };
    const html = renderEIA(eia);
    const match = html.match(/<p style="([^"]+)">(?:<span[^>]*>&#9679;<\/span>&nbsp;)?Resultado da última edição[^<]*<\/p>/);
    assert.ok(match, `prevResultLine <p> não encontrado: ${html}`);
    assert.match(match![1], /letter-spacing:2px/);
    assert.doesNotMatch(match![1], /letter-spacing:1px/);
  });
});

describe("#3104 — line-height do título do É IA? igual às outras manchetes 26px (1.2, era 1.15)", () => {
  it("'Clique na imagem que foi gerada por IA.' usa line-height:1.2", () => {
    const eia: EIA = {
      credit: "Foto: x.",
      imageA: "01-eia-A.jpg",
      imageB: "01-eia-B.jpg",
      edition: "260999",
    };
    const html = renderEIA(eia);
    const match = html.match(/<p style="([^"]+)">Clique na imagem que foi gerada por IA\.<\/p>/);
    assert.ok(match, `título do É IA? não encontrado: ${html}`);
    assert.match(match![1], /line-height:1\.2;/);
    assert.doesNotMatch(match![1], /line-height:1\.15;/);
  });
});
