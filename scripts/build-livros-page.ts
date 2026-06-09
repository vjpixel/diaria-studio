/**
 * build-livros-page.ts (#1744)
 *
 * Gera a página "Livros sobre IA" da Diar.ia a partir de
 * `seed/books/livros-ia.json` (curadoria do editor, espelhada da página Beehiiv
 * diaria.beehiiv.com/livros-sobre-ia). Emite um HTML self-contained (dados +
 * filtros client-side inline) servido pelo Worker `livros`.
 *
 * Design editorial Diar.ia (#1936/#1935: DS canônico — Georgia serif, accent
 * teal #00A0A0, papel #FBFAF6, molduras bege #EBE5D0, texto ink),
 * cards text-focused (sem capa): título com link de afiliado amzn.to, nota da
 * Amazon, badges (idioma/nível/tema), selo de destaque e "para quem é".
 *
 * Uso:
 *   npx tsx scripts/build-livros-page.ts --out workers/livros/public/index.html
 *   npx tsx scripts/build-livros-page.ts --check       # só valida
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { COLORS, FONTS } from "./lib/design-tokens.ts"; // #1936/#1935: DS canônico

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_PATH = resolve(ROOT, "seed/books/livros-ia.json");
const DEFAULT_OUT = resolve(ROOT, "data/livros/index.html");

// #1936/#1935: DS canônico (lib/design-tokens.ts) — era ad-hoc (Newsreader +
// #F5F1E8/#FFFDF8/#1A1A1A). Agora os mesmos tokens da diária/mensal/É IA?/cursos.
const TEAL = COLORS.brand; // #00A0A0
const INK = COLORS.ink; // #171411
const PAPER = COLORS.paper; // #FBFAF6
const CARD_BG = COLORS.paper; // card = papel
const RULE = COLORS.rule; // #EBE5D0 — molduras/bordas
const SERIF = FONTS.serif; // Georgia (email-safe + canônico; sem Newsreader externo)
const SANS = FONTS.sans; // Geist → cai pra system sans

export type Language = "pt-br" | "en";
export type Level = "iniciante" | "intermediario" | "avancado";

export interface Book {
  id: string;
  title: string;
  link: string;
  language: Language;
  level: Level;
  themes: string[];
  rating?: number;
  highlight?: string;
  summary: string;
  cover_url?: string;
}

const LEVEL_LABEL: Record<Level, string> = {
  iniciante: "Iniciante",
  intermediario: "Intermediário",
  avancado: "Avançado",
};

const LANG_LABEL: Record<Language, string> = { "pt-br": "Português", en: "Inglês" };

/** Escapa HTML em texto interpolado. */
export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** URL aceita só se http(s) — defense-in-depth (amzn.to é https). Pure. */
export function isSafeUrl(u: string | undefined): boolean {
  return !!u && /^https?:\/\//i.test(u);
}

/** Nota Amazon → "4,7" (decimal com vírgula PT). Pure. */
export function fmtRating(r: number | undefined): string | null {
  if (r == null || !Number.isFinite(r)) return null;
  return r.toFixed(1).replace(".", ",");
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Valida a lista de livros. Pure — testável sem IO.
 * Erros (bloqueiam): campos obrigatórios, id duplicado, language/level fora do
 * enum. Warnings: link com esquema inválido, rating ausente/fora de 0-5.
 */
export function validateBooks(books: Book[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const b of books) {
    const where = b.id || b.title || "(sem id)";
    if (!b.id) errors.push(`livro sem id: "${b.title ?? where}"`);
    else if (seen.has(b.id)) errors.push(`id duplicado: ${b.id}`);
    else seen.add(b.id);
    if (!b.title) errors.push(`${where}: title ausente`);
    if (!b.summary) errors.push(`${where}: summary ausente`);
    if (!b.link) errors.push(`${where}: link ausente`);
    else if (!isSafeUrl(b.link)) warnings.push(`${where}: link com esquema inválido: ${b.link}`);
    if (b.language !== "pt-br" && b.language !== "en") errors.push(`${where}: language inválida (${b.language})`);
    if (!(b.level in LEVEL_LABEL)) errors.push(`${where}: level inválido (${b.level})`);
    if (!Array.isArray(b.themes)) errors.push(`${where}: themes deve ser array`);
    if (b.rating == null || b.rating < 0 || b.rating > 5) warnings.push(`${where}: rating ausente/inválido`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Temas distintos (ordenados) entre os livros que casam com `lang`/`level`
 * (vazios = sem restrição). Pure. Usado pra montar o dropdown de Tema dinâmico
 * — só temas com ≥1 livro no recorte atual, pra nenhuma opção zerar a lista.
 */
export function availableThemes(books: Book[], lang = "", level = ""): string[] {
  const set = new Set<string>();
  for (const b of books) {
    if (lang && b.language !== lang) continue;
    if (level && b.level !== level) continue;
    for (const t of b.themes ?? []) if (t) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

/** Todos os temas distintos da lista (sem recorte). Pure. */
export function distinctThemes(books: Book[]): string[] {
  return availableThemes(books);
}

/** Lê e valida o seed. Lança em JSON inválido / erros de schema. */
export function loadBooks(seedPath = SEED_PATH): Book[] {
  if (!existsSync(seedPath)) throw new Error(`seed não encontrado: ${seedPath}`);
  const parsed = JSON.parse(readFileSync(seedPath, "utf8")) as { books?: Book[] };
  const books = parsed.books ?? [];
  const v = validateBooks(books);
  if (!v.ok) throw new Error(`seed inválido:\n  ${v.errors.join("\n  ")}`);
  return books;
}

function renderCard(b: Book): string {
  const rating = fmtRating(b.rating);
  const note = rating ? `<span class="note">★ ${rating}</span>` : "";
  const cta = isSafeUrl(b.link)
    ? `<a class="cta" href="${esc(b.link)}" target="_blank" rel="noopener noreferrer sponsored">Ver livro <span aria-hidden="true">→</span></a>`
    : `<span class="cta cta--off" aria-disabled="true">Link em breve</span>`;
  const titleInner = isSafeUrl(b.link)
    ? `<a href="${esc(b.link)}" target="_blank" rel="noopener noreferrer sponsored">${esc(b.title)}</a>`
    : esc(b.title);
  const badges = [
    `<span class="badge badge--lang">${esc(LANG_LABEL[b.language])}</span>`,
    `<span class="badge">${esc(LEVEL_LABEL[b.level])}</span>`,
    ...b.themes.map((t) => `<span class="badge">${esc(t)}</span>`),
  ].join("");
  const highlight = b.highlight ? `<p class="highlight">${esc(b.highlight)}</p>` : "";
  // data-* alimentam os filtros client-side (themes single-word → space-join).
  return `      <article class="card" data-lang="${esc(b.language)}" data-level="${esc(b.level)}" data-themes="${esc(b.themes.join(" "))}">
        <div class="title-row">
          <h2>${titleInner}</h2>
          ${note}
        </div>
        <p class="badges">${badges}</p>
        ${highlight}
        <p class="summary">${esc(b.summary)}</p>
        ${cta}
      </article>`;
}

/**
 * Renderiza a página completa no design editorial Diar.ia. Pure — recebe os
 * livros, devolve HTML 100% self-contained (Georgia é system font — sem fonte externa).
 */
export function renderLivrosPage(books: Book[]): string {
  const cards = books.map(renderCard).join("\n");
  const themeOptions = distinctThemes(books)
    .map((t) => `<option value="${esc(t)}">${esc(t)}</option>`)
    .join("");
  return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Livros sobre IA · Diar.ia</title>
<style>
  :root { --teal: ${TEAL}; --ink: ${INK}; --paper: ${PAPER}; --card: ${CARD_BG}; --rule: ${RULE}; }
  * { box-sizing: border-box; }
  body { font-family: ${SANS}; margin: 0; background: var(--paper); color: var(--ink); line-height: 1.55;
    -webkit-font-smoothing: antialiased; }
  a { color: inherit; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 28px; }

  header { padding: 56px 0 0; }
  .eyebrow { font-family: ${SANS}; font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
    color: var(--teal); font-weight: 600; margin: 0 0 18px; }
  .rule { height: 2px; background: var(--teal); border: 0; margin: 0 0 22px; }
  h1 { font-family: ${SERIF}; font-weight: 700; font-size: clamp(40px, 7vw, 72px); line-height: 0.98;
    letter-spacing: -0.02em; margin: 0; }
  h1 .dot { color: var(--teal); }
  .tagline { font-family: ${SANS}; font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase;
    color: var(--ink); margin: 18px 0 0; }
  .lede { font-size: 19px; line-height: 1.5; color: var(--ink); max-width: 64ch; margin: 16px 0 0; }
  .lede + .lede { margin-top: 10px; font-size: 16px; color: var(--ink); }

  .filters { position: sticky; top: 0; z-index: 5; background: var(--paper);
    border-bottom: 1px solid var(--rule); margin-top: 40px; }
  .filters .wrap { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 22px; padding-top: 16px; padding-bottom: 16px; }
  .filters label { font-family: ${SANS}; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--ink); display: flex; flex-direction: column; gap: 6px; font-weight: 600; }
  .filters select { font-family: ${SANS}; font-size: 16px; color: var(--ink); padding: 7px 28px 7px 2px;
    border: 0; border-bottom: 1px solid var(--rule); background: transparent; min-width: 140px; cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2300A0A0' fill='none' stroke-width='1.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 4px center; }
  .filters select:focus { outline: none; border-bottom-color: var(--teal); }
  .count { margin-left: auto; font-family: ${SANS}; font-size: 11px; letter-spacing: 0.16em;
    text-transform: uppercase; color: var(--ink); align-self: flex-end; }

  main { padding: 40px 0 64px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 1px;
    background: var(--rule); border: 1px solid var(--rule); }
  .card { background: var(--card); display: flex; flex-direction: column; padding: 26px 28px; }
  .title-row { display: flex; gap: 14px; align-items: baseline; justify-content: space-between; }
  .title-row h2 { font-family: ${SERIF}; font-size: 23px; font-weight: 600; line-height: 1.12;
    letter-spacing: -0.01em; margin: 0; }
  .title-row h2 a { text-decoration: none; }
  .title-row h2 a:hover { color: var(--teal); }
  .note { font-family: ${SANS}; font-size: 13px; font-weight: 700; color: var(--teal); white-space: nowrap; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 0; }
  .badge { font-family: ${SANS}; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--ink); border: 1px solid var(--rule); padding: 4px 9px; border-radius: 2px; }
  .badge--lang { border-color: var(--teal); color: var(--teal); }
  .highlight { font-size: 15px; font-style: italic; color: var(--ink); margin: 16px 0 0; }
  .summary { font-size: 16px; line-height: 1.5; color: var(--ink); margin: 12px 0 18px; flex: 1; }
  .cta { font-family: ${SANS}; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;
    font-weight: 700; color: var(--teal); text-decoration: none; align-self: flex-start;
    border-bottom: 1px solid transparent; padding-bottom: 2px; }
  .cta:hover { border-bottom-color: var(--teal); }
  .cta--off { color: var(--ink); font-weight: 600; }
  .empty { grid-column: 1 / -1; text-align: center; color: var(--ink); padding: 64px 20px;
    font-size: 18px; background: var(--card); }
  footer { border-top: 1px solid var(--rule); }
  footer .wrap { padding: 24px 28px; font-family: ${SANS}; font-size: 11px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--ink); }
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">Diar.ia · Curadoria</p>
      <hr class="rule">
      <h1>Livros sobre IA<span class="dot" aria-hidden="true">.</span></h1>
      <p class="tagline">Seu filtro no caos</p>
      <p class="lede">Uma seleção dos melhores livros sobre inteligência artificial, reunida a partir de mais de 10 listas e ranqueada por um critério subjetivo (prêmios do livro ou do autor) e um objetivo (nota na Amazon). Quando há edição em português, é ela que aparece.</p>
      <p class="lede">Os links são de afiliado — comprando por eles, você apoia a Diar.ia sem pagar nada a mais.</p>
    </div>
  </header>
  <div class="filters">
    <div class="wrap">
      <label>Idioma
        <select id="f-lang"><option value="">Todos</option><option value="pt-br">Português</option><option value="en">Inglês</option></select>
      </label>
      <label>Nível
        <select id="f-level"><option value="">Todos</option><option value="iniciante">Iniciante</option><option value="intermediario">Intermediário</option><option value="avancado">Avançado</option></select>
      </label>
      <label>Tema
        <select id="f-theme"><option value="">Todos</option>${themeOptions}</select>
      </label>
      <span class="count" id="count"></span>
    </div>
  </div>
  <main>
    <div class="wrap">
      <div class="grid" id="grid">
${cards}
        <p class="empty" id="empty" style="display:none">Nenhum livro com esses filtros.</p>
      </div>
    </div>
  </main>
  <footer><div class="wrap">Diar.ia · diar.ia.br — curadoria de livros sobre IA</div></footer>
<script>
  (function () {
    var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
    var fLang = document.getElementById('f-lang');
    var fLevel = document.getElementById('f-level');
    var fTheme = document.getElementById('f-theme');
    var countEl = document.getElementById('count');
    var emptyEl = document.getElementById('empty');
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
    // #1744: dropdown de Tema dinâmico — só temas com >=1 livro no Idioma/Nível
    // atual, pra nenhuma opção zerar a lista. Preserva a seleção se ainda válida.
    function rebuildThemes() {
      var lang = fLang.value, level = fLevel.value, set = {};
      cards.forEach(function (c) {
        if ((!lang || c.dataset.lang === lang) && (!level || c.dataset.level === level)) {
          (c.dataset.themes || '').split(' ').forEach(function (t) { if (t) set[t] = 1; });
        }
      });
      var themes = Object.keys(set).sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
      var cur = fTheme.value;
      var keep = themes.indexOf(cur) >= 0 ? cur : '';
      fTheme.innerHTML = '<option value="">Todos</option>' + themes.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
      fTheme.value = keep;
    }
    function apply() {
      var lang = fLang.value, level = fLevel.value, theme = fTheme.value, visible = 0;
      cards.forEach(function (c) {
        var ok = (!lang || c.dataset.lang === lang)
          && (!level || c.dataset.level === level)
          && (!theme || (' ' + c.dataset.themes + ' ').indexOf(' ' + theme + ' ') !== -1);
        // #1744: style.display (nao [hidden], que .card{display:flex} sobrepoe).
        c.style.display = ok ? '' : 'none';
        if (ok) visible++;
      });
      countEl.textContent = visible + (visible === 1 ? ' livro' : ' livros');
      emptyEl.style.display = visible === 0 ? '' : 'none';
    }
    fLang.addEventListener('change', function () { rebuildThemes(); apply(); });
    fLevel.addEventListener('change', function () { rebuildThemes(); apply(); });
    fTheme.addEventListener('change', apply);
    apply();
  })();
</script>
</body>
</html>
`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? resolve(argv[outIdx + 1]) : DEFAULT_OUT;

  let books: Book[];
  try {
    books = loadBooks();
  } catch (e) {
    console.error(`[build-livros] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const v = validateBooks(books);
  for (const w of v.warnings) process.stderr.write(`[build-livros] ⚠ ${w}\n`);
  process.stderr.write(`[build-livros] ${books.length} livros; ${distinctThemes(books).length} temas.\n`);

  if (check) {
    process.stderr.write("[build-livros] --check: não escreve.\n");
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileAtomic(outPath, renderLivrosPage(books));
  process.stderr.write(`[build-livros] escrito: ${outPath}\n`);
  console.log(outPath);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  main();
}
