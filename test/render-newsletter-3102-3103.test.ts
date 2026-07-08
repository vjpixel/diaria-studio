/**
 * test/render-newsletter-3102-3103.test.ts
 *
 * Testes de regressão para o lote overnight/batch-newsletter-render-html-p2:
 *
 *   #3102 — mdInlineToHtml (Sorteio/Encerrar/leaderboard/reveal) tinha seu
 *   PRÓPRIO estilo de link (`text-decoration:none;border-bottom:1px solid teal`),
 *   diferente do resto do e-mail (`text-decoration:underline;text-decoration-color:teal`,
 *   via inlineLinkHtml/processInlineLinks/renderBodyInline desde #2004). No
 *   Outlook os 2 padrões degradam de forma diferente — sem motivo funcional.
 *   Fix: mdInlineToHtml reusa inlineLinkHtml.
 *
 *   #3103 — rodapé do É IA? (crédito, "RESULTADO DA ÚLTIMA EDIÇÃO: X%",
 *   "Veja o ranking → leaderboard") saía todo em 12px, mecânica central de
 *   engajamento recorrente. Fix: resultado + leaderboard sobem pra 14px
 *   (crédito continua 12px); link do leaderboard ganha
 *   display:inline-block;padding:4px 0 pra engordar a área de toque.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mdInlineToHtml,
  renderEIA,
  renderLeaderboardLinkRow,
} from "../scripts/lib/newsletter-render-html.ts";
import type { EIA } from "../scripts/lib/newsletter-parse.ts";

describe("#3102 — mdInlineToHtml usa o mesmo estilo de link inline do resto do e-mail", () => {
  it("link markdown vira underline teal (não border-bottom)", () => {
    const out = mdInlineToHtml("Veja [este link](https://example.com) aqui.");
    assert.match(out, /text-decoration:underline/, `underline ausente: ${out}`);
    assert.match(out, /text-decoration-color:#00A0A0/, `text-decoration-color teal ausente: ${out}`);
    assert.doesNotMatch(out, /border-bottom:1px solid #00A0A0/, `border-bottom teal ainda presente (padrão antigo): ${out}`);
  });

  it("mantém href e label preservados (não regride funcionalidade)", () => {
    const out = mdInlineToHtml("[Clique aqui](https://diaria.beehiiv.com)");
    assert.match(out, /href="https:\/\/diaria\.beehiiv\.com"/, `href ausente: ${out}`);
    assert.match(out, />Clique aqui<\/a>/, `label ausente: ${out}`);
  });

  it("estilo do link é byte-idêntico ao de processInlineLinks (mesma função reusada)", () => {
    const out = mdInlineToHtml("[texto](https://a.example.com)");
    const styleMatch = out.match(/<a href="[^"]*" style="([^"]+)"/);
    assert.ok(styleMatch, `<a> não encontrado: ${out}`);
    assert.equal(
      styleMatch![1],
      `color:#171411;text-decoration:underline;text-decoration-color:#00A0A0;`,
      "estilo do link deve ser idêntico ao inlineLinkHtml (sem divergência silenciosa)",
    );
  });

  it("URL com parênteses continua funcionando (não regrediu o #2001 follow-up)", () => {
    const out = mdInlineToHtml("[GPT-4](https://en.wikipedia.org/wiki/GPT-4_(language_model))");
    assert.match(out, /href="https:\/\/en\.wikipedia\.org\/wiki\/GPT-4_\(language_model\)"/, `href truncado: ${out}`);
  });
});

const baseEia: EIA = {
  credit: "Foto: Author, via Unsplash",
  imageA: "01-eia-A.jpg",
  imageB: "01-eia-B.jpg",
  edition: "260708",
};

describe("#3103 — rodapé do É IA?: resultado + leaderboard em 14px, crédito continua 12px", () => {
  it("credit (crédito da imagem) permanece font-size:12px", () => {
    const html = renderEIA(baseEia);
    const creditMatch = html.match(/<p style="([^"]+)">Foto: Author[^<]*<\/p>/);
    assert.ok(creditMatch, `credit <p> não encontrado: ${html}`);
    assert.match(creditMatch![1], /font-size:12px/, "crédito deve continuar 12px");
  });

  it("prevResultLine ('Resultado da última edição') sobe para font-size:14px", () => {
    const html = renderEIA({ ...baseEia, prevResultLine: "Resultado da última edição: 67% das pessoas acertaram." });
    const match = html.match(/<p style="([^"]+)">Resultado da última edição[^<]*<\/p>/);
    assert.ok(match, `prevResultLine <p> não encontrado: ${html}`);
    assert.match(match![1], /font-size:14px/, "prevResultLine deve subir para 14px");
    assert.doesNotMatch(match![1], /font-size:12px/, "prevResultLine não deve mais ser 12px");
  });

  it("leaderboard 'Vencedores' (pódio) sobe para font-size:14px", () => {
    const html = renderEIA({
      ...baseEia,
      leaderboardPeriod: "Julho",
      leaderboardPodium: [{ nickname: "Fulano", rank: 1 }],
    });
    const match = html.match(/<p style="([^"]+)">🏆[\s\S]*?Vencedores[\s\S]*?<\/p>/);
    assert.ok(match, `linha de vencedores não encontrada: ${html}`);
    assert.match(match![1], /font-size:14px/, "linha de vencedores deve ser 14px");
  });

  it("'Veja o ranking → leaderboard' sobe para font-size:14px", () => {
    const html = renderEIA(baseEia);
    const match = html.match(/<p style="([^"]+)">Veja o ranking[\s\S]*?<\/p>/);
    assert.ok(match, `linha de ranking não encontrada: ${html}`);
    assert.match(match![1], /font-size:14px/, "linha 'Veja o ranking' deve ser 14px");
  });

  it("link do leaderboard ganha display:inline-block;padding:4px 0 (área de toque maior)", () => {
    const out = renderLeaderboardLinkRow("font-size:14px;");
    const linkMatch = out.match(/<a href="[^"]*leaderboard"[^>]*style="([^"]+)"/);
    assert.ok(linkMatch, `link do leaderboard não encontrado: ${out}`);
    assert.match(linkMatch![1], /display:inline-block/, "link deve ter display:inline-block");
    assert.match(linkMatch![1], /padding:4px 0/, "link deve ter padding:4px 0");
  });
});
