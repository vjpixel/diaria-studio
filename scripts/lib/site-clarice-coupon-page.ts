/**
 * site-clarice-coupon-page.ts (#8338)
 *
 * Gera `workers/site/public/clarice/index.html` — página estática dedicada
 * ao cupom de desconto da parceria com a Clarice (assistente de revisão de
 * texto em português). Mesmo padrão estrutural do antigo `site-apoiar-page.ts` (removido no #8498)
 * (#7915) / `site-assinar-page.ts` (#7015): conteúdo estático, sem dado de
 * request/edição, um único template literal, gerado por
 * `scripts/gen-clarice-coupon-page.ts`.
 *
 * ## Por que esta página existe (origem da #8338)
 *
 * Análise de resgates de cupom mostrou que ~42% (5 de 12) vêm de gente que
 * NUNCA recebeu e-mail da diar.ia.br antes de resgatar — comportamento de
 * quem busca "cupom Clarice" no Google e encontra o cupom já publicado, sem
 * login, no HTML de cada edição em `diar.ia.br/p/...` (65 de 266 edições em
 * cache carregam o cupom, via o bloco `para_encerrar_tools` de
 * `scripts/stitch-newsletter.ts`). Essas pessoas hoje caem no cupom mais
 * visível dessas páginas — NEWS25 (mensal, 25% off recorrente por 3 meses,
 * comissão menor) — quando o cupom que sai por e-mail é o NEWS50 (anual,
 * 50% off, comissão maior). Esta página inverte essa visibilidade de forma
 * deliberada (requisito 2 da issue, decisão do editor já registrada nela):
 * NEWS50 em primeiro lugar/mais destacado, NEWS25 secundário.
 *
 * ## O que esta página NÃO é
 *
 * - Não substitui o box de patrocínio na newsletter (`para_encerrar_tools`)
 *   nem o guard `SPONSORED_LITERALS` de `scripts/verify-clarice-coupons.ts`
 *   — aquele cobre o literal que sai por e-mail; esta é uma superfície nova,
 *   só de busca orgânica.
 * - Não inventa valor/condição de cupom — os 2 cupons e seus termos
 *   (percentual, duração, plano a que se aplicam) são os mesmos já ativos na
 *   Stripe, cobertos por `test/stripe-coupon-usage.test.ts`
 *   (`NEWS50`: 50% once no plano anual; `NEWS25`: 25% repeating 3 meses no
 *   plano mensal). Preço em R$ NÃO é citado aqui de propósito — muda com
 *   mais frequência que este arquivo é revisado, e uma cifra desatualizada
 *   na página é pior que nenhuma cifra (o link de CTA sempre mostra o preço
 *   vigente).
 *
 * ## Link de afiliado + instrumentação (requisitos 3 e 5 da issue)
 *
 * TODOS os CTAs desta página que apontam pra Clarice usam
 * `CLARICE_COUPON_PAGE_CTA_URL` — `DIARIA_CLARICE_PRECOS_URL`
 * (`./canonical-urls.ts`, já carrega `?via=diaria`, tracking de afiliado
 * Rewardful) com uma UTM própria acrescentada
 * (`utm_source=diaria&utm_medium=web&utm_campaign=clarice-coupon-page`) —
 * mesma convenção de nomear campanha por página/canal já usada em
 * `scripts/lib/mensal/monthly-apoiadores-kit-render.ts`
 * (`mensal-apoiadores-kit`) e no `?via=diaria` do link do rodapé mensal.
 * Não há contador de clique próprio (ao contrário de `/apoiar/ir`) — fora de
 * escopo desta issue; a UTM já permite atribuição via Google Analytics/GSC
 * sem infra nova, e o `?via=diaria` já é o mecanismo de atribuição de
 * receita real (Rewardful), que é o que importa pra decidir se a página
 * compensa.
 */
import { escHtml } from "./html-escape.ts";
import { renderAnalyticsHead } from "./shared/seo-meta.ts";
import { DIARIA_CLARICE_PRECOS_URL } from "./canonical-urls.ts";
import { renderSiteNav } from "./shared/site-nav.ts"; // #8497: menu global

/**
 * URL de destino de TODO CTA desta página que aponta pra Clarice —
 * `DIARIA_CLARICE_PRECOS_URL` (já com `?via=diaria`) + UTM própria da
 * página. Query string montada com `URLSearchParams` sobre a URL existente
 * (nunca concatenação de string) pra nunca duplicar `?`/`&` se
 * `DIARIA_CLARICE_PRECOS_URL` ganhar outro param no futuro.
 */
export function buildClariceCouponPageCtaUrl(): string {
  const u = new URL(DIARIA_CLARICE_PRECOS_URL);
  u.searchParams.set("utm_source", "diaria");
  u.searchParams.set("utm_medium", "web");
  u.searchParams.set("utm_campaign", "clarice-coupon-page");
  return u.toString();
}

export const CLARICE_COUPON_PAGE_CTA_URL = buildClariceCouponPageCtaUrl();

export const CLARICE_PAGE_URL = "https://diar.ia.br/clarice";

interface CouponCard {
  code: string;
  headline: string;
  detail: string;
  featured: boolean;
}

/**
 * Ordem = ordem de exibição (requisito 2 da issue: NEWS50 PRIMEIRO/mais
 * destacado, NEWS25 secundário). `featured` controla o estilo (`.coupon-lead`
 * vs `.coupon-secondary`), não só a posição — um reorder futuro que
 * esqueça de também trocar `featured` seria pego pelo teste (checa o par
 * ordem+classe, não só presença solta).
 */
const COUPONS: CouponCard[] = [
  {
    code: "NEWS50",
    headline: "50% de desconto no plano anual da Clarice",
    detail: "Desconto único (aplicado na 1ª cobrança) no plano anual — o cupom com o maior desconto disponível pra quem já decidiu assinar por um ano.",
    featured: true,
  },
  {
    code: "NEWS25",
    headline: "25% de desconto nos 3 primeiros meses do plano mensal",
    detail: "Pra quem prefere começar mensal: 25% de desconto recorrente nas 3 primeiras cobranças do plano mensal.",
    featured: false,
  },
];

function renderCouponCard(coupon: CouponCard): string {
  const cls = coupon.featured ? "coupon-card coupon-lead" : "coupon-card coupon-secondary";
  const badge = coupon.featured ? '<span class="coupon-badge">Recomendado</span>' : "";
  return `<div class="${cls}">
        <div class="coupon-head">
          <span class="coupon-code">${escHtml(coupon.code)}</span>
          ${badge}
        </div>
        <p class="coupon-headline">${escHtml(coupon.headline)}</p>
        <p class="coupon-detail">${escHtml(coupon.detail)}</p>
        <a class="btn ${coupon.featured ? "btn-teal" : "btn-ghost"}" href="${escHtml(CLARICE_COUPON_PAGE_CTA_URL)}">Usar o cupom ${escHtml(coupon.code)}</a>
      </div>`;
}

export function buildClariceCouponHtml(): string {
  const couponCards = COUPONS.map(renderCouponCard).join("\n      ");
  const ctaUrl = escHtml(CLARICE_COUPON_PAGE_CTA_URL);
  return `<!--
  workers/site/public/clarice/index.html (#8338)

  Página dedicada ao cupom de desconto da parceria com a Clarice, otimizada
  pra busca orgânica ("cupom Clarice", "desconto Clarice", "código
  promocional Clarice") — ver docstring de
  scripts/lib/site-clarice-coupon-page.ts pro racional completo.

  Gerada por \`scripts/gen-clarice-coupon-page.ts\` a partir de
  \`scripts/lib/site-clarice-coupon-page.ts\` — não editar direto (o próximo
  \`npx tsx scripts/gen-clarice-coupon-page.ts\` sobrescreve).
-->
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cupom Clarice: 50% de desconto — diar.ia.br</title>
<meta name="description" content="Cupons de desconto oficiais da Clarice, assistente de revisão de texto em português: NEWS50 (50% no plano anual) e NEWS25 (25% nos 3 primeiros meses do mensal). Parceria diar.ia.br.">
<link rel="canonical" href="${CLARICE_PAGE_URL}">
<style>
:root {
  --teal: #00A0A0;
  --teal-deep: #007a7a;
  --ink: #171411;
  --ink-soft: rgba(23,17,15,0.72);
  --ink-faint: rgba(23,17,15,0.5);
  --paper: #FBFAF6;
  --paper-alt: #F3EFE2;
  --rule: rgba(23,20,17,0.18);
}
* { box-sizing: border-box; }
body {
  font-family: 'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  margin: 0; background: var(--paper); color: var(--ink); line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--teal-deep); }
.wrap { max-width: 640px; margin: 0 auto; padding: 56px 24px 72px; }
h1 { font-family: Georgia, 'Times New Roman', serif; font-size: clamp(28px, 6vw, 40px); letter-spacing: -0.02em; margin: 0 0 12px; }
.dot { color: var(--teal); }
.lede { font-size: 16px; color: var(--ink-soft); margin: 0 0 32px; max-width: 52ch; }
h2 { font-size: 21px; font-weight: 500; letter-spacing: -0.01em; margin: 40px 0 16px; }
.coupons { display: grid; gap: 14px; margin: 0 0 8px; }
.coupon-card { border: 1px solid var(--rule); border-radius: 12px; padding: 20px 22px; background: #fff; }
.coupon-lead { border: 2px solid var(--teal); background: var(--paper-alt); }
.coupon-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.coupon-code { font-family: 'Geist Mono', monospace; font-size: 18px; font-weight: 700; letter-spacing: 0.02em; color: var(--teal-deep); }
.coupon-badge { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; background: var(--teal); color: #fff; border-radius: 999px; padding: 3px 10px; }
.coupon-headline { font-size: 16px; font-weight: 600; margin: 0 0 6px; }
.coupon-detail { font-size: 13.5px; line-height: 1.5; color: var(--ink-soft); margin: 0 0 16px; }
.coupons-note { font-size: 12.5px; color: var(--ink-faint); margin: 12px 0 0; }
.about p { font-size: 14.5px; line-height: 1.6; color: var(--ink-soft); margin: 0 0 14px; }
.about p:last-child { margin-bottom: 0; }
.btn { display: inline-block; padding: 12px 20px; border-radius: 999px; font-size: 14.5px; font-weight: 500; text-decoration: none; font-family: inherit; }
.btn-teal { background: var(--teal); color: #fff; }
.btn-teal:hover { background: var(--teal-deep); }
.btn-ghost { border: 1px solid var(--rule); color: var(--ink); }
.back-row { display: flex; gap: 16px; flex-wrap: wrap; margin: 40px 0 0; align-items: center; }
.back { font-size: 13px; color: var(--ink-faint); text-decoration: underline; text-underline-offset: 3px; }
</style>
${renderAnalyticsHead()}
</head>
<body>
  ${renderSiteNav({ inheritHostTokens: true })}
  <main class="wrap">
    <h1>Cupom Clarice: até 50% de desconto</h1>
    <p class="lede">A diar.ia.br é parceira da <a href="${ctaUrl}">Clarice</a>, um assistente de escrita em português que revisa, corrige e aprimora textos com IA. Abaixo, os 2 cupons oficiais de desconto pra quem assina pela nossa indicação.</p>

    <h2>Cupons de desconto</h2>
    <div class="coupons">
      ${couponCards}
    </div>
    <p class="coupons-note">Os códigos promocionais acima são aplicados automaticamente pelo link — não precisa digitar nada no checkout. Condições podem mudar; o checkout da Clarice sempre mostra o valor final vigente antes da confirmação.</p>

    <h2>O que é a Clarice</h2>
    <div class="about">
      <p>A Clarice é um assistente de escrita com IA focado em português — revisa gramática, ortografia e estilo, e ajuda a deixar qualquer texto mais claro. É a mesma ferramenta que a equipe da diar.ia.br usa pra revisar esta newsletter antes de publicar.</p>
      <p>Serve pra quem escreve em português com regularidade — de e-mails de trabalho a textos mais longos — e quer um segundo par de olhos automático antes de publicar.</p>
    </div>

    <div class="back-row">
      <a class="btn btn-teal" href="${ctaUrl}">Assinar a Clarice com desconto</a>
      <a class="back" href="/">← Voltar pra diar.ia.br</a>
    </div>

    <a class="back" href="https://arquivo.diar.ia.br/privacidade" style="display:block;margin-top:24px;">Privacidade</a>
  </main>
</body>
</html>
`;
}
