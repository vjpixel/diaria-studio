import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderIntroCallout } from "../scripts/lib/newsletter-render-html.ts";

// #8575 regressão: box de livro vindo de 02-reviewed.md após stitch,
// sem frontmatter do snippet (titulo:false não chega). Antes, quando
// detectBookRecommendation = true e !explicitTitleLine, o else if
// sintetizava BOOK_RECOMMENDATION_TITLE, duplicando o kicker "Recomendação
// de Leitura" já renderizado pelo dispatcher (categoria do snippet).
describe("#8575 livro sem linha de título explícita (caminho 02-reviewed.md)", () => {
  it("não duplica o rótulo quando o parágrafo do livro é o 1º", () => {
    const text = `[**Inteligência Artificial — do Zero a Superpoderes**](https://amazon.com.br/dp/B0DB9VVG22?tag=diaria-20), de Martha Gabriel\n\n(GEN Atlas, 2ª edição, 168 páginas, 4,7★/73 avaliações). Link de associado — ASIN B0DB9VVG22.`;
    const html = renderIntroCallout(text, "serif", false, true, false);
    // Com correção, title = paras[0] (nome do livro), não "Recomendação..."
    assert.ok(html.includes("Inteligência Artificial — do Zero a Superpoderes"));
    assert.strictEqual(html.includes("Recomendação de Leitura"), false);
  });
});
