/**
 * site-apoiar-page.ts (#7915)
 *
 * Gera `workers/site/public/apoiar/index.html` — a página que a issue #7915
 * pede: hoje a home só MENCIONA apoio na FAQ ("É realmente gratuita?"), sem
 * nenhum CTA/página que explique o benefício e leve ao pagamento. Mesmo
 * padrão estrutural de `site-assinar-page.ts` (#7015) — conteúdo estático,
 * sem dado de request/edição, um único template literal, gerado por
 * `scripts/gen-apoiar-page.ts`.
 *
 * ## O que esta página NÃO é (escopo explícito da issue)
 *
 * - Não é uma landing page de aquisição paga nova — a decisão do #6150
 *   segue valendo (rotear tráfego pago pra `livros`/`cursos`/home, nunca
 *   criar destino dedicado).
 * - Não inventa níveis nem promessas de recompensa — os 4 níveis e valores
 *   abaixo (`Amigo` R$5, `Apoiador` R$10, `Mantenedor` R$25, `Patrono` R$50)
 *   são os mesmos limiares de `computeRewardGroup`
 *   (`scripts/studio-ui/studio-apoios.ts`, decisão do editor confirmada ao
 *   vivo na campanha real, #3844). Os 2 benefícios citados (Artigo Especial
 *   completo + bastidores no nível Apoiador; Panorama do Mês + votação do
 *   tema no nível Mantenedor) são os mesmos já transcritos ao vivo da
 *   página da campanha real na issue #7658 — não texto novo. `Amigo` e
 *   `Patrono` não têm benefício textual próprio documentado em código; a
 *   página não inventa um — descreve `Amigo` como apoio de entrada e
 *   `Patrono` como o nível mais alto (que inclui os benefícios dos níveis
 *   anteriores, mesma leitura cumulativa que `computeRewardGroup` já
 *   assume: "maior faixa cujo limiar ≤ valor").
 * - A amostra pública é um LINK pro hub de Artigos Especiais
 *   (`especial.diar.ia.br`), não um artigo específico hardcoded — o hub já
 *   é 100% público (teaser cortado + gate, nunca o texto completo pago) e
 *   não precisa de manutenção quando um artigo novo sai ou um antigo é
 *   arquivado. Preserva a separação PÚBLICO/pago já fechada pelo #7658 —
 *   esta página não linka pra NENHUM conteúdo atrás do gate.
 *
 * ## Instrumentação (view + click, separado de pagamento confirmado)
 *
 * O CTA de apoio aponta pra `/apoiar/ir` (rota do `main` deste Worker,
 * `workers/site/src/index.ts`) em vez de direto pra
 * `https://apoia.se/diaria` — esse endpoint incrementa
 * `apoiarClickCounterKey` (`scripts/lib/shared/apoiar-counters.ts`) e faz
 * 302 pro apoia.se, preservando query string (UTM). A VISUALIZAÇÃO da
 * própria página `/apoiar` é contada no mesmo Worker, também via KV,
 * `apoiarViewCounterKey` — nenhum dos dois contadores é pagamento
 * confirmado (isso continua vindo do apoia.se/Stripe, fora deste repo);
 * clique e visualização nunca contam como receita. Atribuição
 * visualização/clique → 1º apoio confirmado por coorte é a issue
 * companheira #7916, fora do escopo desta.
 *
 * Funciona 100% sem JS (o CTA é um `<a href>` normal pro redirect do
 * Worker) e é navegável por teclado (só links/headings semânticos, sem
 * nenhum handler de mouse-only).
 */
import { escHtml } from "./html-escape.ts";
import { WORDMARK_DISPLAY_SEGMENTS } from "./shared/brand-wordmark.ts";
import { renderAnalyticsHead } from "./shared/seo-meta.ts";
import { DIARIA_ESPECIAL_URL } from "./canonical-urls.ts";

/** Mesmo padrão de `renderWordmark()` em `site-home-page.ts`/`site-assinar-page.ts` (#7010). */
function renderWordmark(): string {
  return WORDMARK_DISPLAY_SEGMENTS.map((seg) => {
    const cls = seg.teal ? ' class="dot"' : "";
    const hidden = seg.decorative ? ' aria-hidden="true"' : "";
    return `<span${cls}${hidden}>${escHtml(seg.text)}</span>`;
  }).join("");
}

/**
 * Path do CTA de apoio — rota própria do Worker (`workers/site/src/index.ts`,
 * checada inline via `reqUrl.pathname === APOIAR_CLICK_PATH`, mesmo padrão
 * de `/confirmado`), não a URL direta do apoia.se. Exportado pra o teste do
 * router e este módulo nunca divergirem no valor literal.
 */
export const APOIAR_CLICK_PATH = "/apoiar/ir";

interface ApoiarTier {
  nome: string;
  valor: string;
  beneficio: string;
}

/**
 * Os 4 níveis — valores de `REWARD_TIER_*_MIN` em
 * `scripts/studio-ui/studio-apoios.ts` (#3844). Benefícios de Apoiador
 * (Artigo Especial completo + bastidores) e Mantenedor transcritos ao vivo
 * da campanha real no CORPO da issue #7658, seção "O gate do mensal está
 * errado hoje — R$10+ quando a promessa é R$25+" (não um comentário — achado
 * do comment-analyzer, #8137: citação anterior apontava pra um cabeçalho que
 * na verdade vive na #7916, issue não-relacionada). "Acesso a todo o
 * histórico já publicado" é inferência do MECANISMO do gate (um único
 * cookie de sessão R$10+ desbloqueia todos os artigos gated, não compra por
 * artigo — `workers/artigos/src/index.ts`), não uma frase transcrita
 * literalmente da campanha; mantido porque é factualmente correto, mas
 * distinto do resto do parágrafo, que É transcrição. Amigo/Patrono não têm
 * benefício textual documentado em código — ver docstring do módulo pro
 * porquê da descrição genérica (não é promessa nova, é leitura cumulativa).
 */
const TIERS: ApoiarTier[] = [
  {
    nome: "Amigo",
    valor: "R$5/mês",
    beneficio: "Apoio de entrada — ajuda a manter a curadoria diária gratuita pra todo mundo.",
  },
  {
    nome: "Apoiador",
    valor: "R$10/mês",
    beneficio: "Artigo Especial mensal completo (texto inteiro, mais aprofundado) + acesso a todo o histórico já publicado + bastidores.",
  },
  {
    nome: "Mantenedor",
    valor: "R$25/mês",
    beneficio: "Tudo do Apoiador, mais o Panorama do Mês (recap mensal enviado toda 1ª semana) + voto no tema do próximo Artigo Especial.",
  },
  {
    nome: "Patrono",
    valor: "R$50/mês",
    beneficio: "O nível mais alto de apoio — inclui os benefícios de todos os níveis anteriores.",
  },
];

function renderTierCard(tier: ApoiarTier): string {
  return `<div class="tier">
        <div class="tier-head"><span class="tier-name">${escHtml(tier.nome)}</span><span class="tier-value">${escHtml(tier.valor)}</span></div>
        <p class="tier-benefit">${escHtml(tier.beneficio)}</p>
      </div>`;
}

export function buildApoiarHtml(): string {
  const tierCards = TIERS.map(renderTierCard).join("\n      ");
  return `<!--
  workers/site/public/apoiar/index.html (#7915)

  Página de apresentação da oferta de apoio (apoia.se) — antes deste arquivo
  o site só mencionava apoio na FAQ da home, sem CTA/página própria (ver
  docstring de scripts/lib/site-apoiar-page.ts pro racional completo e o
  que esta página deliberadamente NÃO é).

  Gerada por \`scripts/gen-apoiar-page.ts\` a partir de
  \`scripts/lib/site-apoiar-page.ts\` — não editar direto (o próximo
  \`npx tsx scripts/gen-apoiar-page.ts\` sobrescreve).
-->
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apoiar — diar.ia.br</title>
<meta name="description" content="Apoie a curadoria da diar.ia.br a partir de R$5/mês — a edição diária continua sempre gratuita. Veja os benefícios de cada nível.">
<link rel="canonical" href="https://diar.ia.br/apoiar">
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
h1 { font-family: Georgia, 'Times New Roman', serif; font-size: clamp(30px, 6vw, 42px); letter-spacing: -0.02em; margin: 0 0 12px; }
.dot { color: var(--teal); }
.lede { font-size: 16px; color: var(--ink-soft); margin: 0 0 8px; max-width: 46ch; }
.free-note { font-size: 13px; color: var(--ink-faint); margin: 0 0 40px; }
h2 { font-size: 22px; font-weight: 500; letter-spacing: -0.01em; margin: 0 0 16px; }
.tiers { display: grid; gap: 12px; margin: 0 0 40px; }
.tier { border: 1px solid var(--rule); border-radius: 10px; padding: 16px 18px; background: #fff; }
.tier-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 6px; }
.tier-name { font-weight: 600; font-size: 15px; }
.tier-value { font-family: 'Geist Mono', monospace; font-size: 13px; color: var(--teal-deep); white-space: nowrap; }
.tier-benefit { font-size: 13.5px; line-height: 1.5; color: var(--ink-soft); margin: 0; }
.tiers-note { font-size: 12.5px; color: var(--ink-faint); margin: -24px 0 40px; }
.sample { background: var(--paper-alt); border-radius: 10px; padding: 20px 22px; margin: 0 0 40px; }
.sample p { font-size: 14px; margin: 0 0 12px; }
.sample p:last-child { margin-bottom: 0; }
.cta-row { display: flex; gap: 12px; flex-wrap: wrap; margin: 0 0 40px; }
.btn { display: inline-block; padding: 13px 22px; border-radius: 999px; font-size: 15px; font-weight: 500; text-decoration: none; font-family: inherit; }
.btn-teal { background: var(--teal); color: #fff; }
.btn-teal:hover { background: var(--teal-deep); }
.btn-ghost { border: 1px solid var(--rule); color: var(--ink); }
.back { display: inline-block; font-size: 13px; color: var(--ink-faint); text-decoration: underline; text-underline-offset: 3px; }
</style>
${renderAnalyticsHead()}
</head>
<body>
  <main class="wrap">
    <h1>Apoiar a ${renderWordmark()}</h1>
    <p class="lede">A edição diária é e sempre será gratuita. Quem quiser apoiar a curadoria financia o trabalho e ganha benefícios extras — nunca o contrário.</p>
    <p class="free-note">Apoiar não é assinar: a newsletter diária nunca fica atrás de paywall, com ou sem apoio.</p>

    <h2>Níveis de apoio</h2>
    <div class="tiers">
      ${tierCards}
    </div>
    <p class="tiers-note">Valores e benefícios podem mudar — a campanha oficial no apoia.se é sempre a fonte definitiva e atualizada.</p>

    <div class="sample">
      <p><strong>Antes de apoiar, veja um exemplo real e público</strong> do que os Artigos Especiais entregam — o índice de todos os artigos já publicados, com um trecho aberto de cada um. O texto completo fica só com quem apoia; nada aqui expõe o conteúdo pago.</p>
      <p><a href="${DIARIA_ESPECIAL_URL}">Ver a amostra pública dos Artigos Especiais →</a></p>
    </div>

    <div class="cta-row">
      <a class="btn btn-teal" href="${APOIAR_CLICK_PATH}">Apoiar a partir de R$5/mês</a>
      <a class="btn btn-ghost" href="/">← Voltar pra diar.ia.br</a>
    </div>

    <a class="back" href="https://arquivo.diar.ia.br/privacidade">Privacidade</a>
  </main>
</body>
</html>
`;
}
