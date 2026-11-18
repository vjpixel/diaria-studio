/**
 * scripts/lib/shared/site-social.ts (#13321)
 *
 * Rodapé social global do site: os ícones de todas as redes da diar.ia.br
 * (YouTube, Instagram, LinkedIn, TikTok, Threads, X, Facebook; #13557), na MESMA
 * ordem e com as MESMAS URLs do convite "Siga a diar.ia.br:" da edição — as
 * duas superfícies leem `DIARIA_SOCIAL_NETWORKS` (`social-networks.ts`).
 *
 * SVG inline (nítido, sem request extra), pintado com `currentColor`: o
 * ícone herda a cor do texto do bloco onde entra (tinta clara no rodapé
 * escuro da home, tinta escura nas páginas claras). Sem teal: no design
 * system o teal fica só na `.rule`.
 *
 * Dois usos:
 *   - `renderSiteSocialIcons()` — só a fileira, para quem já tem rodapé
 *     próprio (a home põe dentro do `<footer>` dela).
 *   - `injectSiteSocialFooter(html)` — rodapé autônomo inserido antes do
 *     `</body>`; chamado por `injectSiteNavAfterBodyOpen` (`site-nav.ts`), o
 *     mesmo caminho do menu global, então toda página que ganha o menu ganha
 *     também o rodapé (geradores e backfill das `/p/` já publicadas).
 *
 * Idempotência: `SITE_SOCIAL_MARKER` na fileira; injetar numa página que já
 * o carrega é no-op.
 *
 * Fica em `lib/shared/` e importa só módulos sem `node:fs`: também roda no
 * Worker do arquivo (`workers/arquivo/src/render-archive.ts`).
 */
import { escHtml } from "../html-escape.ts";
import { COLORS, FONTS } from "./design-tokens.ts";
import { DIARIA_SOCIAL_NETWORKS } from "./social-networks.ts";
import { SOCIAL_ICON_SVG_PATHS, SOCIAL_ICON_VIEWBOX } from "./social-icon-paths.ts";
import { SITE_SOCIAL_UTM } from "./utm-registry.ts";

/** Presente em toda página que já tem a fileira de ícones (guard de
 *  idempotência do backfill e da injeção). */
export const SITE_SOCIAL_MARKER = 'data-site-social="global"';

/** Tamanho exibido do ícone (px). */
export const SITE_SOCIAL_ICON_PX = 22;

const UTM_QUERY = `utm_source=${SITE_SOCIAL_UTM.source}&utm_medium=${SITE_SOCIAL_UTM.medium}&utm_campaign=${SITE_SOCIAL_UTM.campaign}`;

/** URL da rede com a UTM do rodapé. O link do YouTube já traz
 *  `?sub_confirmation=1` (#12069), então a UTM entra com `&`. */
export function siteSocialHref(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${UTM_QUERY}`;
}

const ICONS_STYLE = `<style>
.dsoc-icons { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 18px; margin: 0; padding: 0; }
.dsoc-icons a { display: inline-flex; color: inherit; opacity: 0.85; text-decoration: none; }
.dsoc-icons a:hover, .dsoc-icons a:focus-visible { opacity: 1; }
.dsoc-icons svg { width: ${SITE_SOCIAL_ICON_PX}px; height: ${SITE_SOCIAL_ICON_PX}px; display: block; fill: currentColor; }
</style>`;

/**
 * A fileira de ícones (com o `<style>` dela). Cada link tem `aria-label`
 * com o nome da rede e o SVG fica `aria-hidden`: o leitor de tela anuncia
 * "diar.ia.br no YouTube", não o desenho.
 */
export function renderSiteSocialIcons(): string {
  const links = DIARIA_SOCIAL_NETWORKS.map(({ key, label, url }) => {
    const svg = `<svg viewBox="${SOCIAL_ICON_VIEWBOX}" aria-hidden="true" focusable="false"><path d="${SOCIAL_ICON_SVG_PATHS[key]}"/></svg>`;
    return `<a href="${escHtml(siteSocialHref(url))}" target="_blank" rel="noopener" aria-label="${escHtml(`diar.ia.br no ${label}`)}" title="${escHtml(label)}">${svg}</a>`;
  }).join("");
  return `${ICONS_STYLE}<div class="dsoc-icons" ${SITE_SOCIAL_MARKER}>${links}</div>`;
}

export interface RenderSiteSocialFooterOptions {
  /** Mesmo papel que em `renderSiteNav`: `true` quando a página já declara
   *  `--ink`/`--paper`/`--rule` no próprio `:root`; `false` (default) embute
   *  o hex canônico (as `/p/`, HTML derivado do e-mail, não declaram). */
  inheritHostTokens?: boolean;
}

/** Rodapé autônomo (para páginas sem rodapé próprio): rótulo curto + fileira. */
export function renderSiteSocialFooter(opts: RenderSiteSocialFooterOptions = {}): string {
  const { inheritHostTokens = false } = opts;
  const ink = inheritHostTokens ? "var(--ink)" : COLORS.ink;
  const paper = inheritHostTokens ? "var(--paper)" : COLORS.paper;
  const rule = inheritHostTokens ? "var(--rule)" : COLORS.rule;
  return `<style>
.dsoc { font-family: ${FONTS.sans}; border-top: 1px solid ${rule}; background: ${paper}; color: ${ink}; padding: 24px 20px 28px; text-align: center; }
.dsoc-label { margin: 0 0 12px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; }
</style>
<footer class="dsoc" aria-label="Redes sociais da diar.ia.br">
  <p class="dsoc-label">Siga a diar.ia.br</p>
  ${renderSiteSocialIcons()}
</footer>`;
}

/** Insere o rodapé social antes do ÚLTIMO `</body>` de `html`. No-op se a
 *  página já tem a fileira (`SITE_SOCIAL_MARKER`) ou não tem `</body>`. */
export function injectSiteSocialFooter(html: string, opts: RenderSiteSocialFooterOptions = {}): string {
  if (html.includes(SITE_SOCIAL_MARKER)) return html;
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return html;
  return `${html.slice(0, idx)}${renderSiteSocialFooter(opts)}\n${html.slice(idx)}`;
}
