/**
 * curadoria-page.ts (#3113)
 *
 * CSS/template comum entre as páginas de curadoria estática Cursos e Livros
 * (`build-cursos-page.ts` #1745, `build-livros-page.ts` #1744). A issue #3113
 * (lote de cleanup P3 pós-revisão de UI Fable) identificou ~120 linhas de CSS
 * duplicadas entre os dois builders com micro-drift já instalado:
 *
 *   - `.title-row h2` (título do card): 22px/line-height 1.14 em cursos vs
 *     23px/1.12 em livros.
 *   - `.filters select` (dropdown de filtro): min-width 130px em cursos vs
 *     140px em livros.
 *   - `.summary` (texto do card): margin-top 14px em cursos vs 12px em livros.
 *
 * Valores canônicos escolhidos nesta extração (decisão registrada aqui, sem
 * trade-off de UX real — nenhuma das duas páginas tinha um valor "correto"
 * documentado antes):
 *   - h2: 22px/1.14 (valor de cursos — página revisada mais recentemente,
 *     #3107/#1891, mesmo design system).
 *   - select min-width: 140px (o maior dos dois — evita corte de texto em
 *     opções longas como "Intermediário"/"Assinatura"; cursos tem 8 dropdowns
 *     e nunca teve reclamação de corte com 130px, então 140px é estritamente
 *     mais seguro em ambas).
 *   - .summary margin-top: 14px (valor de cursos).
 *
 * Cada página mantém INLINE (não extraído) o que é estruturalmente distinto
 * entre as duas: o bloco de filtros mobile (cursos colapsa em `<details>`
 * desde #3107; livros não — não expandido aqui, fora do escopo de #3113) e
 * elementos de card específicos de cada domínio (`.platform`/`.badge--cert`
 * em cursos; `.highlight` em livros).
 */
import { COLORS, FONTS } from "./design-tokens.ts";
import { escHtml } from "../html-escape.ts"; // reusa o escaper canônico (também cobre apóstrofo)

const TEAL = COLORS.brand;
const INK = COLORS.ink;
const PAPER = COLORS.paper;
const RULE = COLORS.rule;
const SERIF = FONTS.serif;
const SANS = FONTS.sans;

/** Custom properties + reset — primeiro bloco de qualquer página de curadoria. */
export function renderCuradoriaRootStyles(): string {
  return `  :root { --teal: ${TEAL}; --ink: ${INK}; --paper: ${PAPER}; --card: ${PAPER}; --rule: ${RULE}; }
  * { box-sizing: border-box; }
  body { font-family: ${SANS}; margin: 0; background: var(--paper); color: var(--ink); line-height: 1.55;
    -webkit-font-smoothing: antialiased; }
  a { color: inherit; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 28px; }`;
}

/** Header editorial (eyebrow + régua + h1 + tagline + lede) — idêntico nas 2 páginas. */
export function renderCuradoriaHeaderStyles(): string {
  return `  header { padding: 56px 0 0; }
  .eyebrow { font-family: ${SANS}; font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
    color: var(--teal); font-weight: 600; margin: 0 0 18px; }
  .rule { height: 2px; background: var(--teal); border: 0; margin: 0 0 22px; }
  h1 { font-family: ${SERIF}; font-weight: 700; font-size: clamp(40px, 7vw, 72px); line-height: 0.98;
    letter-spacing: -0.02em; margin: 0; }
  h1 .dot { color: var(--teal); }
  .tagline { font-family: ${SANS}; font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase;
    color: var(--ink); margin: 18px 0 0; }
  .lede { font-size: 19px; line-height: 1.5; color: var(--ink); margin: 16px 0 0; }
  .lede + .lede { margin-top: 10px; font-size: 16px; color: var(--ink); }`;
}

/**
 * Base do sticky filter bar comum (posicionamento, label, select, contador).
 * A estrutura INTERNA do container (`.filters .wrap` flat em livros vs
 * `<details>`/`.filters-body` colapsável em cursos, #3107) fica com o caller —
 * diverge por design, não é drift acidental.
 */
export function renderCuradoriaFiltersBaseStyles(): string {
  return `  .filters { position: sticky; top: 0; z-index: 5; background: var(--paper);
    border-bottom: 1px solid var(--rule); margin-top: 40px; }
  .filters label { font-family: ${SANS}; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--ink); display: flex; flex-direction: column; gap: 6px; font-weight: 600; }
  .filters select { font-family: ${SANS}; font-size: 16px; color: var(--ink); padding: 7px 28px 7px 2px;
    border: 0; border-bottom: 1px solid var(--rule); background: transparent; min-width: 140px; cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2300A0A0' fill='none' stroke-width='1.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 4px center; }
  .filters select:focus { outline: none; border-bottom-color: var(--teal); }
  .count { margin-left: auto; font-family: ${SANS}; font-size: 11px; letter-spacing: 0.16em;
    text-transform: uppercase; color: var(--ink); align-self: flex-end; }`;
}

/** Grid + card comuns (título, nota, badges, summary, cta, empty state). */
export function renderCuradoriaGridCardStyles(): string {
  return `  main { padding: 40px 0 64px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 1px;
    background: var(--rule); border: 1px solid var(--rule); }
  .card { background: var(--card); display: flex; flex-direction: column; padding: 26px 28px; }
  .title-row { display: flex; gap: 14px; align-items: baseline; justify-content: space-between; }
  .title-row h2 { font-family: ${SERIF}; font-size: 22px; font-weight: 600; line-height: 1.14;
    letter-spacing: -0.01em; margin: 0; }
  .title-row h2 a { text-decoration: none; }
  .title-row h2 a:hover { color: var(--teal); }
  .note { font-family: ${SANS}; font-size: 13px; font-weight: 700; color: var(--teal); white-space: nowrap; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 0; }
  .badge { font-family: ${SANS}; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--ink); border: 1px solid var(--rule); padding: 4px 9px; border-radius: 2px; }
  .summary { font-size: 16px; line-height: 1.5; color: var(--ink); margin: 14px 0 18px; flex: 1; }
  .cta { font-family: ${SANS}; font-size: 16px;
    font-weight: 700; color: var(--teal); text-decoration: none; align-self: flex-start;
    border-bottom: 1px solid transparent; padding-bottom: 2px; }
  .cta:hover { border-bottom-color: var(--teal); }
  .cta--off { color: var(--ink); font-weight: 600; }
  .empty { grid-column: 1 / -1; text-align: center; color: var(--ink); padding: 64px 20px;
    font-size: 18px; background: var(--card); }`;
}

/** Container do rodapé comum (borda + tipografia base + links de navegação). */
export function renderCuradoriaFooterStyles(): string {
  return `  footer { border-top: 1px solid var(--rule); }
  footer .wrap { padding: 24px 28px; font-family: ${SANS}; font-size: 11px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--ink); }
  footer .foot-nav a { color: var(--teal); text-decoration: none; }
  footer .foot-nav a:hover { text-decoration: underline; }
  footer .foot-nav a + a { margin-left: 10px; }
  footer .foot-credit { margin: 6px 0 0; }`;
}

export interface CuradoriaNavLink {
  label: string;
  url: string;
}

/**
 * Navegação cruzada entre as 3 superfícies públicas da Diar.ia (#3113 —
 * "nenhuma linka as outras hoje, nem Cursos/Livros linkam de volta pro
 * diar.ia.br"). É IA? aponta pro leaderboard público (`poll` worker) — não há
 * uma homepage estática dedicada à feature, o leaderboard é a superfície
 * pública mais representativa dela.
 */
export const CURADORIA_NAV_LINKS: CuradoriaNavLink[] = [
  { label: "Diar.ia", url: "https://diar.ia.br" },
  { label: "Cursos", url: "https://cursos.diaria.workers.dev/" },
  { label: "Livros", url: "https://livros.diaria.workers.dev/" },
  { label: "É IA?", url: "https://poll.diaria.workers.dev/leaderboard" },
];

/**
 * Rodapé comum: nav cruzada (Diar.ia · Cursos · Livros · É IA?) + linha de
 * crédito específica da página (ex: "diar.ia.br — curadoria de cursos sobre IA").
 */
export function renderCuradoriaFooter(creditText: string): string {
  const nav = CURADORIA_NAV_LINKS.map((l) => `<a href="${escHtml(l.url)}">${escHtml(l.label)}</a>`).join(" · ");
  return `<footer><div class="wrap"><p class="foot-nav">${nav}</p><p class="foot-credit">${escHtml(creditText)}</p></div></footer>`;
}
