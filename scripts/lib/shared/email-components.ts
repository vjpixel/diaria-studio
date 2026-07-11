/**
 * email-components.ts (#3269)
 *
 * Primeiro componente de HTML genuinamente compartilhado entre os 2 renderers
 * de email da Diar.ia — diário (../newsletter-render-html.ts, Beehiiv) e
 * mensal (../mensal/monthly-render.ts, Brevo/Clarice).
 *
 * Antes deste arquivo, `tealDot()` vivia em newsletter-render-html.ts e o
 * renderer mensal importava DIRETO de lá (`import { tealDot } from
 * "../newsletter-render-html.ts"`) — um import cruzado ad-hoc que só era
 * possível porque newsletter-render-html.ts mora na raiz legada de
 * scripts/lib/ (fora da fronteira shared/diaria/mensal enforced por
 * test/lib-boundary.test.ts, #2747). Extraído aqui como o passo de menor
 * risco recomendado por docs/render-unification-analysis-3269.md — os
 * candidatos maiores (applyBrandWordmark, boxes contorno/painel, bloco É IA?)
 * ficam para PRs de follow-up dedicados (ver o documento pra escopo e riscos).
 */
import { COLORS } from "./design-tokens.ts";

/**
 * Marcador ● teal reutilizável — a "assinatura de cor" do DS pros labels
 * uppercase deste padrão (kicker de seção, "Por que isso importa" / "O fio
 * condutor", resultado do É IA?). Isolado em helper porque teal 12/16px bold
 * mede ~3.2:1 de contraste sobre papel/branco — abaixo de AA (4.5:1) pra
 * texto normal (16px bold não qualifica como "large text" do WCAG, que exige
 * ≥18.66px bold). Fix sem mexer na paleta: o PONTO continua teal (identidade
 * visual preservada), o TEXTO do label vira ink (contraste ~14:1) em cada
 * caller — este helper só emite o ponto. (#3104 diária; #3181 mensal.)
 */
export function tealDot(): string {
  return `<span style="color:${COLORS.brand};">&#9679;</span>`;
}
