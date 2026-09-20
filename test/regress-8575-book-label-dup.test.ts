import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderIntroCallout } from "../scripts/lib/newsletter-render-html.ts";

describe("#8575 livro sem linha de título explícita (caminho 02-reviewed.md)", () => {
  it("não duplica o rótulo nem o parágrafo do livro (contrato real do HTML)", () => {
    const text = `[**Inteligência Artificial — do Zero a Superpoderes**](https://amazon.com.br/dp/B0DB9VVG22?tag=diaria-20), de Martha Gabriel\n\n(GEN Atlas, 2ª edição, 168 páginas, 4,7★/73 avaliações). Link de associado — ASIN B0DB9VVG22.`;
    const html = renderIntroCallout(text, "serif", false, true, false);
    // Título do livro deve aparecer como parte do corpo, não sintetizado como "Recomendação de Leitura"
    assert.ok(html.includes("Inteligência Artificial"), "título do livro presente");
    // Nenhuma duplicação do texto do livro no HTML (não pode aparecer 2x)
    const titleMatches = html.match(/Inteligência Artificial — do Zero a Superpoderes/g) || [];
    assert.strictEqual(titleMatches.length, 1, `título do livro duplicado: ${titleMatches.length}`);
    // O rótulo fixo "Recomendação de Leitura" não deve ser sintetizado como título/corpo
    // (quando não há linha explícita, o 1º parágrafo é o livro; se o kicker externo não
    // passa pelo render, não deve aparecer duplicado no corpo do callout).
    assert.strictEqual(html.includes("Recomendação de Leitura"), false, "rótulo duplicado/sintetizado no corpo");
  });
});
