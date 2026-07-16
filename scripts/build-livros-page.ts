/**
 * build-livros-page.ts (#1744)
 *
 * Gera a página "Livros sobre IA" da Diar.ia a partir de
 * `seed/books/livros-ia.json` (curadoria do editor, espelhada da página Beehiiv
 * livros.diaria.workers.dev). Emite um HTML self-contained (dados +
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

import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { slugify } from "./lib/slug.ts"; // #3118 item 6: alinha data-themes/option value ao padrão de build-cursos-page.ts
import { escHtml as esc } from "./lib/html-escape.ts"; // #3118 item 13: era uma 3ª cópia idêntica local
import { renderSeoMeta } from "./lib/shared/seo-meta.ts"; // #3106: meta description/OG/Twitter/canonical/favicon
import {
  renderCuradoriaRootStyles,
  renderCuradoriaHeaderStyles,
  renderCuradoriaFiltersBaseStyles,
  renderCuradoriaGridCardStyles,
  renderCuradoriaFooterStyles,
  renderCuradoriaFooter,
} from "./lib/shared/curadoria-page.ts"; // #3113: CSS/footer comuns com build-cursos-page.ts
import {
  isSafeUrl,
  availableThemes,
  distinctThemes,
  loadSeedItems,
  type ValidationResult,
} from "./lib/shared/curadoria-data.ts"; // #3118 item 13: layer de dados comum com build-cursos-page.ts
export { esc, isSafeUrl, availableThemes, distinctThemes, type ValidationResult };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_PATH = resolve(ROOT, "seed/books/livros-ia.json");
const DEFAULT_OUT = resolve(ROOT, "data/livros/index.html");
// #3106: URL pública canônica — Worker de assets estáticos em livros.diaria.workers.dev.
// Exportado (não só usado localmente) pra permitir o teste de acoplamento
// contra CURADORIA_NAV_LINKS em scripts/lib/shared/curadoria-page.ts (#3113)
// — sem isso, mudar este domínio no futuro e esquecer o footer causaria
// exatamente o tipo de drift silencioso que essa issue existe pra eliminar.
export const PAGE_URL = "https://livros.diaria.workers.dev/";
const PAGE_TITLE = "Livros sobre IA · Diar.ia";
const PAGE_DESCRIPTION =
  "Livros sobre inteligência artificial recomendados pela Diar.ia — filtre por idioma, nível e tema, com links diretos para a Amazon.";

// #1936/#1935: DS canônico (lib/shared/design-tokens.ts) — era ad-hoc (Newsreader +
// #F5F1E8/#FFFDF8/#1A1A1A). Agora os mesmos tokens da diária/mensal/É IA?/cursos.
// #3113: a maior parte do CSS (root/header/filtros-base/grid/card/footer) foi
// extraída pra scripts/lib/shared/curadoria-page.ts, compartilhada com
// build-cursos-page.ts — só `.highlight` (citação do livro) continua inline
// aqui por ser específico de livros.

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

/** Nota Amazon → "4,7" (decimal com vírgula PT). Pure. */
export function fmtRating(r: number | undefined): string | null {
  if (r == null || !Number.isFinite(r)) return null;
  return r.toFixed(1).replace(".", ",");
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

/** Lê e valida o seed. Lança em JSON inválido / erros de schema. */
export function loadBooks(seedPath = SEED_PATH): Book[] {
  return loadSeedItems<Book>(seedPath, "books", validateBooks);
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
  // #3118 (item 6): temas SLUGIFICADOS antes do space-join — antes usava o nome
  // cru, que quebra silenciosamente com tema multi-palavra (ex: ["Machine
  // Learning", "Ética"] vira o mesmo data-themes ambíguo de ["Machine",
  // "Learning Ética"], já que espaço é ao mesmo tempo separador de tema E parte
  // do nome). Slugify (kebab-case, sem espaço) elimina a ambiguidade — mesmo
  // padrão já usado em build-cursos-page.ts. O SEED de hoje não tem tema
  // multi-palavra, mas quebraria sem erro nenhum no dia que tivesse.
  return `      <article class="card" data-lang="${esc(b.language)}" data-level="${esc(b.level)}" data-themes="${esc(b.themes.map(slugify).join(" "))}">
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
  // #3118 (item 6): option value SLUGIFICADO (casa com data-themes de renderCard,
  // agora também slugificado) — label continua o nome legível original.
  const themeOpts = distinctThemes(books).map((t) => ({ value: slugify(t), label: t }));
  const themeOptions = themeOpts
    .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
    .join("");
  // Mapa COMPLETO slug→label embutido no script — mesmo padrão de
  // build-cursos-page.ts (#1891 fix): rebuildThemes() (abaixo) precisa exibir o
  // label legível pros slugs que sobrevivem ao recorte de idioma/nível, sem
  // depender das <option> ATUAIS (que encolhem a cada rebuild).
  const themeLabelJson = JSON.stringify(Object.fromEntries(themeOpts.map((o) => [o.value, o.label]))).replaceAll(
    "<",
    "\\u003c",
  ); // </script>-safe embed
  return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PAGE_TITLE}</title>
${renderSeoMeta({ title: PAGE_TITLE, description: PAGE_DESCRIPTION, url: PAGE_URL })}
<style>
${renderCuradoriaRootStyles()}

${renderCuradoriaHeaderStyles()}

${renderCuradoriaFiltersBaseStyles()}
  .filters .wrap { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 22px; padding-top: 16px; padding-bottom: 16px; }

${renderCuradoriaGridCardStyles()}
  .highlight { font-size: 15px; font-style: italic; color: var(--ink); margin: 16px 0 0; }

${renderCuradoriaFooterStyles()}
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">Diar.ia · Curadoria</p>
      <hr class="rule">
      <h1>Livros sobre IA<span class="dot" aria-hidden="true">.</span></h1>
      <p class="tagline">5 minutos diários pra se manter atualizado e usar melhor a IA</p>
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
  ${renderCuradoriaFooter("diar.ia.br — curadoria de livros sobre IA")}
<script>
  (function () {
    // #3118 item 6: mapa slug→label completo — data-themes/option value agora
    // são slugs (kebab-case); THEME_LABELS resolve o label legível pro rebuild
    // (mesmo padrão de build-cursos-page.ts, #1891).
    var THEME_LABELS = ${themeLabelJson};
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
      // value→label vem do mapa COMPLETO embutido (THEME_LABELS), não das options
      // atuais — senão um rebuild anterior que encolheu as options apagaria o label.
      var themes = Object.keys(set).sort(function (a, b) { return (THEME_LABELS[a] || a).localeCompare(THEME_LABELS[b] || b, 'pt-BR'); });
      var cur = fTheme.value;
      var keep = themes.indexOf(cur) >= 0 ? cur : '';
      fTheme.innerHTML = '<option value="">Todos</option>' + themes.map(function (t) { return '<option value="' + esc(t) + '">' + esc(THEME_LABELS[t] || t) + '</option>'; }).join('');
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

if (isMainModule(import.meta.url)) {
  main();
}
