/**
 * scripts/lib/shared/site-nav.ts (#8497)
 *
 * Menu global do site — extraído do markup inline que só existia em
 * `site-home-page.ts:1256-1305` (a home era a ÚNICA superfície com nav; toda
 * página `/p/{slug}` — a maioria do tráfego de descoberta — era um beco sem
 * saída, sem caminho pro resto do produto nem pro CTA `Assinar`).
 *
 * `renderSiteNav` é self-contained (markup + `<style>` embutido, classes
 * prefixadas `dnav-` pra nunca colidir com o CSS próprio de cada página) —
 * decisão deliberada: as superfícies que consomem este módulo têm sistemas
 * de CSS heterogêneos (a home tem um stylesheet grande com tokens `var(--…)`
 * próprios; `/assinar`, `/clarice`, `/archive`, `/confirmada` têm
 * cada uma o seu `<style>` menor; as páginas `/p/{slug}` são HTML bruto
 * derivado do e-mail, sem folha de estilo compartilhada nenhuma). Um
 * componente com estilo embutido funciona identicamente em qualquer uma sem
 * depender de custom properties que só a home declara.
 *
 * Cores hardcoded a partir de `design-tokens.ts` (`COLORS`) em vez de
 * `var(--…)` pelo mesmo motivo — nem toda página que consome isto declara os
 * tokens como custom properties CSS.
 *
 * Fica em `lib/shared/` (não em `lib/diaria/`) — consumido pela home, pelo
 * acervo `/p/{slug}`, pelo índice `/archive`, por `/assinar`,
 * `/clarice`, todos gerados por scripts que também vivem fora de
 * `lib/diaria/` (ver `test/lib-boundary.test.ts`).
 */
import { escHtml } from "../html-escape.ts";
import { COLORS, FONTS } from "./design-tokens.ts";
import { DIARIA_ESPECIAL_URL, DIARIA_LIVROS_URL, DIARIA_CURSOS_URL, DIARIA_EIA_URL } from "../canonical-urls.ts";

/**
 * Marcador HTML — presente em toda página que já passou por
 * `renderSiteNav`. Usado como guard mecânico (regressão: gerador novo sem
 * nav) e como chave de idempotência do backfill nas 270 páginas `/p/{slug}`
 * já publicadas (mesma família do `ARCHIVE_NAV_MARKER` de
 * `site-archive-page-backfill.ts`).
 */
export const SITE_NAV_MARKER = 'data-site-nav="global"';

/** Vocabulário fechado de itens do menu — a MESMA lista alimenta o menu e
 *  (quando `renderSiteFooterLinks` for consumido, #8497 item 8, ainda não
 *  aplicado a nenhum rodapé nesta PR) o rodapé, pra nunca divergir. */
export type SiteNavKey =
  | "edicoes"
  | "especiais"
  | "livros"
  | "cursos"
  | "eia"
  | "apoiar"
  | "assinar";

interface SiteNavItemDef {
  key: SiteNavKey;
  label: string;
  href: string;
  /** true = outro host (`*.diar.ia.br`) — ganha UTM de navegação interna
   *  (#8497 item 9), senão a navegação entre hosts entra como tráfego
   *  direto na atribuição. Links no MESMO host (apex) não precisam — não
   *  cruzam propriedade nenhuma. */
  crossHost: boolean;
}

/** UTM fixa de toda travessia cross-host feita a partir do menu global —
 *  registrada como emissor em `utm-registry.ts` (`UTM_EMITTERS`, id
 *  `site-nav`). */
const NAV_UTM_QUERY = "utm_source=diaria-nav&utm_medium=nav&utm_campaign=global-nav";

function crossHostUrl(base: string, path = ""): string {
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${path}${sep}${NAV_UTM_QUERY}`;
}

/**
 * Itens do menu principal, na ordem em que aparecem.
 *
 * #8497 item 4 ("Retrospectivas") FICOU DE FORA desta PR — residue
 * documentado no corpo do PR. `retrospectiva.diar.ia.br/` (sem path) devolve
 * `400 (path obrigatório)` (`workers/retrospectiva/src/index.ts`, tabela de
 * rotas): não existe página-índice pública pra apontar um item de nav
 * genérico, e cada edição (`/AAMM` mensal, `/AAAA` anual,
 * `/aniversarioAAAA`) tem seu PRÓPRIO gate (cadastro grátis ou apoio
 * Mantenedor R$25+ conforme o formato do path) — nunca um destino único e
 * sempre-acessível. Um nav item pra conteúdo às vezes gateado também
 * teria de passar por decisão editorial sobre o gate (a página `/apoiar`,
 * removida no #8498, evitava linkar pra `retrospectiva.diar.ia.br` pelo mesmo motivo).
 * Implementar o item corretamente exige uma página-índice pública nova em
 * `retrospectiva.diar.ia.br` (ou decisão editorial equivalente) — fora do
 * escopo mecânico desta PR.
 */
const NAV_ITEM_DEFS: readonly SiteNavItemDef[] = [
  // RELATIVOS (`/archive`, `/apoiar/ir`) — todo consumidor desta nav é servido
  // pelo MESMO apex (`diar.ia.br`), preservando o contrato que
  // `test/site-home-apoiar-link-7915.test.ts` já trava (`<a href="/apoiar/ir">`
  // literal, nav + rodapé). `/apoiar/ir` (#8498) é o redirect instrumentado do
  // Worker → apoia.se/diaria (contador de clique + UTM); a página `/apoiar` não existe mais. Só os itens CROSS-HOST abaixo precisam de URL
  // absoluta (#8497 item 9).
  { key: "edicoes", label: "Edições", href: "/archive", crossHost: false },
  { key: "especiais", label: "Especiais", href: crossHostUrl(DIARIA_ESPECIAL_URL), crossHost: true },
  { key: "livros", label: "Livros", href: crossHostUrl(DIARIA_LIVROS_URL), crossHost: true },
  { key: "cursos", label: "Cursos", href: crossHostUrl(DIARIA_CURSOS_URL), crossHost: true },
  { key: "eia", label: "É IA?", href: crossHostUrl(DIARIA_EIA_URL, "/leaderboard"), crossHost: true },
  { key: "apoiar", label: "Apoiar", href: "/apoiar/ir", crossHost: false },
];

/** URL do CTA `Assinar` — único botão/CTA primário da nav (#7915), mantido
 *  por decisão do editor (19/09/2026, #8497) mesmo após o pedido inicial de
 *  removê-lo. RELATIVA (`/assinar`), não absoluta: a home tem um mecanismo
 *  próprio (`#6427`, `document.querySelectorAll('a[href="/assinar"]')`) que
 *  repassa `location.search` cru pro `href` deste link antes do 1º clique —
 *  um href absoluto quebraria esse seletor em silêncio (regressão coberta
 *  por `test/site-home-nav-cta-utm-propagation-7360.test.ts`). Todo consumidor
 *  desta nav é servido pelo MESMO apex (`diar.ia.br`), então relativo já
 *  resolve certo em toda superfície tocada nesta PR — só um host IRMÃO
 *  embutindo esta nav precisaria de uma URL absoluta (fora do escopo desta
 *  PR, ver residue no corpo do PR #8497). */
export const NAV_ASSINAR_URL = "/assinar";

export interface RenderSiteNavOptions {
  /** Item correspondente à página atual — ganha `aria-current="page"` +
   *  destaque visual (#8497 item 5). `"assinar"` é um valor especial: não há
   *  item de menu "Assinar" (só o CTA) — nesse caso o PRÓPRIO CTA vira texto
   *  não-clicável com `aria-current="page"` (item 3: "em página que já é o
   *  destino, o CTA não se auto-linka"). */
  active?: SiteNavKey;
  /** `aria-label` do `<nav>` — default distingue esta nav de qualquer outra
   *  nav secundária que a página já tenha (#8497 item 6 — ex: `/p/{slug}`
   *  já tem `aria-label="Navegação entre edições"` na nav prev/next; as duas
   *  precisam de rótulo distinto pra não serem ambíguas num leitor de tela). */
  ariaLabel?: string;
  /** `true`: a página hospedeira já declara `--teal`/`--ink`/`--paper`/
   *  `--rule` no PRÓPRIO `:root` (home, `/assinar`, `/clarice`,
   *  `/archive`, `/confirmada` — todas convergem nesses 4 nomes) — a nav usa
   *  `var(--x)` puro, sem literal hex, pra não duplicar o token (guard
   *  `test/site-home-design-tokens-6986.test.ts`: nenhum hex canônico fora
   *  de `:root`). `false` (default): a página não declara esses tokens (as
   *  270 páginas `/p/{slug}`, HTML bruto derivado do e-mail, sem `:root`
   *  próprio) — a nav embute o hex canônico direto, sem depender de nada que
   *  a página hospedeira não tenha. */
  inheritHostTokens?: boolean;
}

function renderNavLink(item: SiteNavItemDef, active: SiteNavKey | undefined): string {
  const isActive = item.key === active;
  const ariaCurrent = isActive ? ' aria-current="page"' : "";
  const cls = isActive ? ' class="dnav-active"' : "";
  return `<a href="${escHtml(item.href)}"${cls}${ariaCurrent}>${escHtml(item.label)}</a>`;
}

/**
 * CSS embutido — escopado por `.dnav-*`/`.nav-cta`. Mobile (#8497 item 7):
 * abaixo de 560px os itens viram uma faixa com scroll horizontal em vez de
 * quebrar linha — decisão registrada aqui (não um hambúrguer com JS): zero
 * dependência de script, sempre navegável, reversível se o editor preferir
 * outro tratamento depois.
 *
 * Cor: `inheritHostTokens` escolhe entre `var(--x)` puro (página já declara
 * os 4 tokens no próprio `:root`) e hex canônico embutido (página sem
 * `:root` de marca nenhum) — ver `RenderSiteNavOptions.inheritHostTokens`.
 */
function buildSiteNavStyle(inheritHostTokens: boolean): string {
  const teal = inheritHostTokens ? "var(--teal)" : COLORS.brand;
  const ink = inheritHostTokens ? "var(--ink)" : COLORS.ink;
  const paper = inheritHostTokens ? "var(--paper)" : COLORS.paper;
  const rule = inheritHostTokens ? "var(--rule)" : COLORS.rule;
  return `<style>
.dnav { font-family: ${FONTS.sans}; border-bottom: 1px solid ${rule}; background: ${paper}; }
.dnav-wrap { max-width: 1100px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.dnav-links { display: flex; gap: 18px; flex-wrap: wrap; font-size: 13px; color: ${ink}; }
.dnav-links a { color: ${ink}; text-decoration: none; }
.dnav-links a:hover { color: ${teal}; text-decoration: underline; text-underline-offset: 3px; }
.dnav-links a.dnav-active { color: ${teal}; font-weight: 600; }
.nav-cta a, .nav-cta span { display: inline-block; padding: 8px 16px; border-radius: 999px; font-size: 13px; font-weight: 500; }
.nav-cta a { background: ${ink}; color: ${paper}; text-decoration: none; }
.nav-cta a:hover { background: ${teal}; }
.nav-cta span[aria-current] { background: ${rule}; color: ${ink}; }
@media (max-width: 560px) {
  .dnav-wrap { flex-wrap: nowrap; }
  .dnav-links { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
  .dnav-links a { white-space: nowrap; }
}
</style>`;
}

/**
 * Renderiza o menu global — markup + `<style>` embutido, pronto pra ser
 * inserido logo após `<body ...>` de qualquer página do apex. Idempotente do
 * ponto de vista do CALLER: rodar 2x produz o mesmo HTML (nenhum estado
 * externo), mas o CALLER é responsável por não injetar 2x na mesma página —
 * ver `SITE_NAV_MARKER` pra checagem de presença antes de injetar (usado
 * pelo backfill das páginas `/p/{slug}` já publicadas).
 */
export function renderSiteNav(opts: RenderSiteNavOptions = {}): string {
  const { active, ariaLabel = "Navegação principal", inheritHostTokens = false } = opts;
  const links = NAV_ITEM_DEFS.map((item) => renderNavLink(item, active)).join("\n        ");
  const cta =
    active === "assinar"
      ? `<span aria-current="page">Assinar</span>`
      : `<a href="${escHtml(NAV_ASSINAR_URL)}">Assinar</a>`;
  return `${buildSiteNavStyle(inheritHostTokens)}
<nav class="dnav" id="nav" ${SITE_NAV_MARKER} aria-label="${escHtml(ariaLabel)}">
  <div class="dnav-wrap">
    <div class="dnav-links">
      ${links}
    </div>
    <div class="nav-cta">
      <!-- #8497 (extraído do nav da home, decisão original #6978 itens 2/3):
           sem "Entrar" — projeto não tem login/conta própria, área de
           assinante é sempre um magic link por e-mail, não um destino
           genérico clicável aqui. Sem busca — redundante com "Edições"
           (índice /archive) e o acervo por tema em arquivo.diar.ia.br. -->
      ${cta}
    </div>
  </div>
</nav>`;
}

/** Injeta o menu global logo após a tag de abertura `<body ...>` de `html`.
 *  No-op (retorna `html` sem tocar) se a página já carrega o marcador —
 *  chamado tanto pelos geradores quanto pelo backfill idempotente das
 *  páginas `/p/{slug}` já publicadas. */
export function injectSiteNavAfterBodyOpen(html: string, opts: RenderSiteNavOptions = {}): string {
  if (html.includes(SITE_NAV_MARKER)) return html;
  const nav = renderSiteNav(opts);
  return html.replace(/<body[^>]*>/i, (full) => `${full}\n${nav}`);
}
