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

const TEAL = "#00A0A0";
const FONT = "'Inter', -apple-system, BlinkMacSystemFont, Roboto, sans-serif";

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
    : `<div class="cover cover--ph" aria-hidden="true">📘</div>`;
  const cta = isSafeUrl(b.link)
    ? `<a class="cta" href="${esc(b.link!)}" target="_blank" rel="noopener noreferrer">Ver livro →</a>`
    : `<span class="cta cta--off" aria-disabled="true">Link em breve</span>`;
  // data-* alimentam os filtros client-side.
  return `      <article class="card" data-lang="${esc(b.language)}" data-level="${esc(b.level)}" data-themes="${esc(b.themes.join(" "))}">
        ${cover}
        <div class="body">
          <h2>${esc(b.title)}</h2>
          <p class="meta">${esc(b.author)} · ${b.year} · ${esc(LANG_LABEL[b.language])}</p>
          <p class="summary">${esc(b.summary)}</p>
          <p class="tags"><span class="tag tag--level">${esc(LEVEL_LABEL[b.level])}</span>${themes
            .map((t) => `<span class="tag">${esc(t)}</span>`)
            .join("")}</p>
          ${cta}
        </div>
      </article>`;
}

/**
 * Renderiza a página completa. Pure — recebe os livros, devolve HTML
 * self-contained (sem fetch externo; dados e JS inline).
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
<style>
  :root { --teal: ${TEAL}; }
  * { box-sizing: border-box; }
  body { font-family: ${FONT}; margin: 0; background: #FAFAFA; color: #1A1A1A; line-height: 1.5; }
  header { padding: 32px 20px 8px; max-width: 1100px; margin: 0 auto; }
  h1 { font-weight: 400; font-size: 28px; letter-spacing: -0.5px; margin: 0 0 6px; border-bottom: 2px solid var(--teal); padding-bottom: 12px; }
  .sub { color: #666; font-size: 15px; margin: 8px 0 0; }
  .filters { position: sticky; top: 0; background: #FAFAFA; z-index: 2; padding: 16px 20px; max-width: 1100px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid #E5E5E5; }
  .filters label { font-size: 13px; color: #444; display: flex; flex-direction: column; gap: 4px; }
  .filters select { font-family: ${FONT}; font-size: 14px; padding: 8px 10px; border: 1px solid #CCC; border-radius: 8px; background: #FFF; min-width: 150px; }
  .count { align-self: flex-end; margin-left: auto; font-size: 13px; color: #666; }
  main { max-width: 1100px; margin: 0 auto; padding: 20px; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
  .card { background: #FFF; border: 1px solid #E5E5E5; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
  .cover { width: 100%; height: 180px; object-fit: cover; background: #F0FAFA; }
  .cover--ph { display: flex; align-items: center; justify-content: center; font-size: 48px; }
  .body { padding: 16px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
  .body h2 { font-size: 18px; font-weight: 600; margin: 0; line-height: 1.25; }
  .meta { font-size: 13px; color: #666; margin: 0; }
  .summary { font-size: 14px; margin: 0; flex: 1; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 0; }
  .tag { font-size: 11px; background: #F0FAFA; color: #0F766E; padding: 3px 8px; border-radius: 999px; }
  .tag--level { background: var(--teal); color: #FFF; }
  .cta { margin-top: 8px; font-size: 14px; font-weight: 600; color: var(--teal); text-decoration: none; }
  .cta--off { color: #AAA; font-weight: 400; }
  .empty { grid-column: 1 / -1; text-align: center; color: #666; padding: 40px; }
  footer { max-width: 1100px; margin: 0 auto; padding: 20px; color: #999; font-size: 12px; }
</style>
</head>
<body>
  <header>
    <h1>Livros sobre IA</h1>
    <p class="sub">Curadoria da Diar.ia para profissionais brasileiros de tecnologia, finanças e consultoria.</p>
  </header>
  <div class="filters">
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
  <main id="grid">
${cards}
    <p class="empty" id="empty" hidden>Nenhum livro com esses filtros.</p>
  </main>
  <footer>Diar.ia · diar.ia.br — lista em curadoria (#1744)</footer>
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
        c.hidden = !ok;
        if (ok) visible++;
      });
      countEl.textContent = visible + (visible === 1 ? ' livro' : ' livros');
      emptyEl.hidden = visible !== 0;
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
