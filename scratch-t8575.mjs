import { renderIntroCallout } from "./scripts/lib/newsletter-render-html.ts";
const text = `[**Inteligência Artificial — do Zero a Superpoderes**](https://amazon.com.br/dp/B0DB9VVG22?tag=diaria-20), de Martha Gabriel.\n\n(GEN Atlas, 2ª edição, 168 páginas, 4,7★/73 avaliações). Link de associado — ASIN B0DB9VVG22.`;
const html = renderIntroCallout(text, "serif", false, true, false);
console.log(html);
