/**
 * build-livros-page.ts (#1744)
 *
 * Gera a página piloto "Livros sobre IA" da Diar.ia a partir de
 * `seed/books/livros-ia.json` (curadoria do editor, versionado). Emite um
 * único HTML self-contained (dados + filtros client-side inline) — abrível
 * direto no browser (file://) e arch-neutro: pode ser servido por qualquer
 * host estático ou embrulhado num Worker quando a arquitetura for decidida
 * (decisão 2026-06-03: piloto primeiro, arquitetura depois).
 *
 * Filtros client-side: idioma (PT/EN, confirmado), nível e tema. 10 itens
 * cabem inteiros no payload — sem backend de busca.
 *
 * Uso:
 *   npx tsx scripts/build-livros-page.ts                 # → data/livros/index.html
 *   npx tsx scripts/build-livros-page.ts --out caminho.html
 *   npx tsx scripts/build-livros-page.ts --check         # só valida, não escreve
 *
 * Saída: warnings (stderr) listando livros sem `link`/`cover_url` (curadoria
 * pendente). Exit 0 sempre que o JSON é válido (warnings não bloqueiam o
 * piloto); exit 2 se o JSON é inválido/ausente.
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_PATH = resolve(ROOT, "seed/books/livros-ia.json");
const DEFAULT_OUT = resolve(ROOT, "data/livros/index.html");

// #1744: design editorial Diar.ia — masthead serifado Newsreader, accent teal,
// fundo creme/jornal, kickers em maiúsculas espaçadas. Espelha as "Layout
// Proposals" do projeto de design (claude.ai/design) e o logo (Newsreader 700).
const TEAL = "#00A0A0";
const INK = "#1A1A1A";
const PAPER = "#F5F1E8"; // creme/jornal
const CARD_BG = "#FFFDF8";
const SERIF = "'Newsreader', Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

export type Language = "pt-br" | "en";
export type Level = "iniciante" | "intermediario" | "avancado";

export interface Book {
  id: string;
  title: string;
  author: string;
  year: number;
  language: Language;
  level: Level;
  themes: string[];
  cover_url?: string;
  summary: string;
  link?: string;
}

const LEVEL_LABEL: Record<Level, string> = {
  iniciante: "Iniciante",
  intermediario: "Intermediário",
  avancado: "Avançado",
};

const THEME_LABEL: Record<string, string> = {
  llms: "LLMs / IA generativa",
  "ml-aplicado": "ML aplicado",
  fundamentos: "Fundamentos",
  "etica-sociedade": "Ética & sociedade",
  "negocios-produto": "Negócios & produto",
  historia: "História",
};

const LANG_LABEL: Record<Language, string> = { "pt-br": "Português", en: "Inglês" };

/**
 * URL só é aceita se http(s) — defense-in-depth contra `javascript:`/`data:`
 * num link curado errado. Pure. Vazio → false (curadoria pendente).
 */
export function isSafeUrl(u: string | undefined): boolean {
  return !!u && /^https?:\/\//i.test(u);
}

/** Escapa HTML em texto interpolado. */
export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Valida a lista de livros. Pure — testável sem IO.
 *
 * Erros (bloqueiam): campos obrigatórios ausentes, id duplicado, language/level
 * fora do enum. Warnings (não bloqueiam o piloto): `link` ou `cover_url` vazios
 * (curadoria pendente) e temas desconhecidos.
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
    if (!b.author) errors.push(`${where}: author ausente`);
    if (!b.summary) errors.push(`${where}: summary ausente`);
    if (b.language !== "pt-br" && b.language !== "en") errors.push(`${where}: language inválida (${b.language})`);
    if (!(b.level in LEVEL_LABEL)) errors.push(`${where}: level inválido (${b.level})`);
    if (!Array.isArray(b.themes) || b.themes.length === 0) errors.push(`${where}: themes vazio`);
    else for (const t of b.themes) if (!(t in THEME_LABEL)) warnings.push(`${where}: tema desconhecido "${t}"`);
    if (!b.link) warnings.push(`${where}: link pendente (curadoria)`);
    else if (!isSafeUrl(b.link)) warnings.push(`${where}: link com esquema inválido (só http/https): ${b.link}`);
    if (!b.cover_url) warnings.push(`${where}: cover_url pendente (curadoria)`);
    else if (!isSafeUrl(b.cover_url)) warnings.push(`${where}: cover_url com esquema inválido (só http/https): ${b.cover_url}`);
  }
  return { ok: errors.length === 0, errors, warnings };
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
  const themes = b.themes.map((t) => THEME_LABEL[t] ?? t);
  const cover = isSafeUrl(b.cover_url)
    ? `<img class="cover" src="${esc(b.cover_url!)}" alt="Capa de ${esc(b.title)}" loading="lazy">`
    : `<div class="cover cover--ph" aria-hidden="true">d.</div>`;
  const cta = isSafeUrl(b.link)
    ? `<a class="cta" href="${esc(b.link!)}" target="_blank" rel="noopener noreferrer">Ver livro <span aria-hidden="true">→</span></a>`
    : `<span class="cta cta--off" aria-disabled="true">Link em breve</span>`;
  // data-* alimentam os filtros client-side.
  return `      <article class="card" data-lang="${esc(b.language)}" data-level="${esc(b.level)}" data-themes="${esc(b.themes.join(" "))}">
        <div class="cover-wrap">${cover}</div>
        <div class="body">
          <p class="kicker">${esc(LEVEL_LABEL[b.level])} · ${esc(LANG_LABEL[b.language])}</p>
          <h2>${esc(b.title)}</h2>
          <p class="meta">${esc(b.author)} · ${b.year}</p>
          <p class="summary">${esc(b.summary)}</p>
          <p class="tags">${themes.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</p>
          ${cta}
        </div>
      </article>`;
}

/**
 * Renderiza a página completa no design editorial Diar.ia. Pure — recebe os
 * livros, devolve HTML self-contained (sem fetch de dados; só a fonte Newsreader
 * vem do Google Fonts).
 */
export function renderLivrosPage(books: Book[]): string {
  const cards = books.map(renderCard).join("\n");
  const themeOptions = Object.entries(THEME_LABEL)
    .map(([v, l]) => `<option value="${v}">${esc(l)}</option>`)
    .join("");
  return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Livros sobre IA · Diar.ia</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600;6..72,700&display=swap">
<style>
  :root { --teal: ${TEAL}; --ink: ${INK}; --paper: ${PAPER}; --card: ${CARD_BG}; }
  * { box-sizing: border-box; }
  body { font-family: ${SERIF}; margin: 0; background: var(--paper); color: var(--ink); line-height: 1.55;
    -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 28px; }

  /* Masthead editorial */
  header { padding: 56px 0 0; }
  .eyebrow { font-family: ${SANS}; font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
    color: var(--teal); font-weight: 600; margin: 0 0 18px; }
  .rule { height: 2px; background: var(--teal); border: 0; margin: 0 0 22px; }
  h1 { font-family: ${SERIF}; font-weight: 700; font-size: clamp(40px, 7vw, 72px); line-height: 0.98;
    letter-spacing: -0.02em; margin: 0; }
  h1 .dot { color: var(--teal); }
  .tagline { font-family: ${SANS}; font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase;
    color: #6b6256; margin: 18px 0 0; }
  .lede { font-size: 19px; line-height: 1.5; color: #4a443b; max-width: 60ch; margin: 14px 0 0; }

  /* Filtros */
  .filters { position: sticky; top: 0; z-index: 5; background: var(--paper);
    border-bottom: 1px solid #ddd6c6; margin-top: 40px; }
  .filters .wrap { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 22px; padding-top: 16px; padding-bottom: 16px; }
  .filters label { font-family: ${SANS}; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
    color: #8a8170; display: flex; flex-direction: column; gap: 6px; font-weight: 600; }
  .filters select { font-family: ${SERIF}; font-size: 16px; color: var(--ink); padding: 7px 28px 7px 2px;
    border: 0; border-bottom: 1px solid #c9c1ae; background: transparent; min-width: 150px; cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2300A0A0' fill='none' stroke-width='1.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 4px center; }
  .filters select:focus { outline: none; border-bottom-color: var(--teal); }
  .count { margin-left: auto; font-family: ${SANS}; font-size: 11px; letter-spacing: 0.16em;
    text-transform: uppercase; color: #8a8170; align-self: flex-end; }

  /* Grade de livros */
  main { padding: 40px 0 64px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1px;
    background: #e3ddcd; border: 1px solid #e3ddcd; }
  .card { background: var(--card); display: flex; flex-direction: column; padding: 26px; }
  .cover-wrap { margin: 0 0 20px; }
  .cover { width: 92px; height: 138px; object-fit: cover; box-shadow: 0 6px 18px rgba(20,16,8,0.16); background: #ece6d6; }
  .cover--ph { width: 92px; height: 138px; display: flex; align-items: center; justify-content: center;
    font-family: ${SERIF}; font-weight: 700; font-size: 40px; color: var(--teal); background: #ece6d6;
    box-shadow: 0 6px 18px rgba(20,16,8,0.16); }
  .body { display: flex; flex-direction: column; gap: 0; flex: 1; }
  .kicker { font-family: ${SANS}; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--teal); font-weight: 600; margin: 0 0 8px; }
  .body h2 { font-family: ${SERIF}; font-size: 23px; font-weight: 600; line-height: 1.12;
    letter-spacing: -0.01em; margin: 0 0 6px; }
  .meta { font-family: ${SANS}; font-size: 13px; color: #8a8170; margin: 0 0 12px; }
  .summary { font-size: 16px; line-height: 1.5; color: #3f3a32; margin: 0 0 16px; flex: 1; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 18px; }
  .tag { font-family: ${SANS}; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
    color: #6b6256; border: 1px solid #d8d1c0; padding: 4px 9px; border-radius: 2px; }
  .cta { font-family: ${SANS}; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;
    font-weight: 700; color: var(--teal); text-decoration: none; align-self: flex-start;
    border-bottom: 1px solid transparent; padding-bottom: 2px; }
  .cta:hover { border-bottom-color: var(--teal); }
  .cta--off { color: #b3ab98; font-weight: 600; }
  .empty { grid-column: 1 / -1; text-align: center; color: #8a8170; padding: 64px 20px;
    font-size: 18px; background: var(--card); }
  footer { border-top: 1px solid #ddd6c6; }
  footer .wrap { padding: 24px 28px; font-family: ${SANS}; font-size: 11px; letter-spacing: 0.1em;
    text-transform: uppercase; color: #9a9180; }
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">Diar.ia · Curadoria</p>
      <hr class="rule">
      <h1>Livros sobre IA<span class="dot" aria-hidden="true">.</span></h1>
      <p class="tagline">Seu filtro no caos</p>
      <p class="lede">Uma lista curada pra quem trabalha com tecnologia, finanças e consultoria no Brasil — dos fundamentos ao debate sobre o futuro.</p>
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
  <footer><div class="wrap">Diar.ia · diar.ia.br — lista em curadoria</div></footer>
<script>
  (function () {
    var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
    var fLang = document.getElementById('f-lang');
    var fLevel = document.getElementById('f-level');
    var fTheme = document.getElementById('f-theme');
    var countEl = document.getElementById('count');
    var emptyEl = document.getElementById('empty');
    function apply() {
      var lang = fLang.value, level = fLevel.value, theme = fTheme.value, visible = 0;
      cards.forEach(function (c) {
        var ok = (!lang || c.dataset.lang === lang)
          && (!level || c.dataset.level === level)
          && (!theme || (' ' + c.dataset.themes + ' ').indexOf(' ' + theme + ' ') !== -1);
        // #1744: usar style.display (nao o atributo hidden) — .card{display:flex}
        // sobrepunha [hidden] (mesma especificidade, autor vence UA) e o filtro nao
        // escondia nada. Inline style ganha de qualquer regra de classe.
        c.style.display = ok ? '' : 'none';
        if (ok) visible++;
      });
      countEl.textContent = visible + (visible === 1 ? ' livro' : ' livros');
      emptyEl.style.display = visible === 0 ? '' : 'none';
    }
    [fLang, fLevel, fTheme].forEach(function (el) { el.addEventListener('change', apply); });
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
  const pending = v.warnings.filter((w) => w.includes("pendente")).length;
  process.stderr.write(`[build-livros] ${books.length} livros; ${pending} campo(s) de curadoria pendentes.\n`);

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
